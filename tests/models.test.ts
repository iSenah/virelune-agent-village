// Custom 3D models: manifest consistency, browser-friendly files, and correct serving.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from '../server/lib/api.ts';
import type { Village } from '../server/lib/app.ts';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { loadRegistries } from '../server/lib/registry.ts';
import { makeVillage } from './helpers.ts';

const MODELS = path.join(PROJECT_ROOT, 'web', 'assets', 'models');
const manifest = JSON.parse(fs.readFileSync(path.join(MODELS, 'manifest.json'), 'utf8'));

function readGlb(file: string) {
  const b = fs.readFileSync(file);
  assert.equal(b.readUInt32LE(0), 0x46546c67, `${file} is not a GLB`);
  assert.equal(b.readUInt32LE(4), 2, `${file} is not glTF 2.0`);
  assert.equal(b.readUInt32LE(8), b.length, `${file} has a wrong length header`);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  return { b, json, binStart };
}

/** Width/height of an embedded JPEG or PNG without decoding it. */
function imageSize(buf: Buffer): { w: number; h: number } {
  if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('unknown image format');
}

test('every building and resident lineage in the manifest is used by the registries', () => {
  const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
  const buildings = new Set([...reg.residents.values()].map((r) => r.building));
  const lineages = new Set([...reg.residents.values()].map((r) => r.appearance.lineage));
  for (const id of Object.keys(manifest.characters)) assert.ok(lineages.has(id), `manifest character "${id}" matches no resident lineage`);
  // Every home or workplace either has a custom model, or is a layout slot waiting for its model (with a note
  // describing it); the development placeholder shows there until the model arrives.
  const world = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'layout', 'world.json'), 'utf8'));
  const slot = (id: string) => world.buildings.find((b: any) => b.id === id && b.modelNote);
  for (const id of [...buildings, ...[...reg.profiles.values()].map((p) => p.workplace)]) assert.ok(manifest.buildings[id] || slot(id), `building "${id}" has neither a custom model nor a layout slot`);
  for (const id of Object.keys(manifest.buildings)) assert.ok(world.buildings.some((b: any) => b.id === id), `model for "${id}" has no place in the layout`);
});

test('each model file is a valid GLB with browser-sized textures', () => {
  let total = 0;
  for (const [group, entries] of Object.entries(manifest) as [string, any][]) {
    if (group !== 'buildings' && group !== 'characters' && group !== 'props') continue;
    for (const [key, entry] of Object.entries(entries) as [string, any][]) {
      const file = path.join(MODELS, entry.file);
      if (entry.lod) total += fs.statSync(path.join(MODELS, entry.lod)).size;
      assert.ok(fs.existsSync(file), `${key}: ${entry.file} is missing`);
      assert.ok(entry.width || entry.height, `${key}: needs a target width or height`);
      const { b, json, binStart } = readGlb(file);
      total += b.length;
      assert.ok(json.meshes?.length > 0, `${key}: no meshes`);
      for (const img of json.images ?? []) {
        const view = json.bufferViews[img.bufferView];
        const data = b.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength);
        const { w, h } = imageSize(data);
        assert.ok(w <= 1024 && h <= 1024, `${key}: texture ${w}x${h} is larger than 1024 px`);
      }
      const tris = json.meshes.flatMap((m: any) => m.primitives).reduce((n: number, p: any) => n + json.accessors[p.indices].count / 3, 0);
      assert.ok(tris <= 100_000, `${key}: ${tris} triangles exceeds the per-model budget`);
    }
  }
  // The street lamp is repeated around the village (one instanced mesh), so it must stay light.
  const lamp = readGlb(path.join(MODELS, manifest.props['street-lamp'].file)).json;
  const lampTris = lamp.meshes.flatMap((m: any) => m.primitives).reduce((n: number, p: any) => n + lamp.accessors[p.indices].count / 3, 0);
  assert.ok(lampTris <= 15_000, `street lamp has ${lampTris} triangles; keep it under 15k`);
  assert.ok(total < 80 * 1024 * 1024, `models total ${(total / 1048576).toFixed(1)} MB exceeds the 80 MB budget`);
});

let village: Village;
let server: http.Server;
let base: string;
before(async () => {
  ({ village } = makeVillage());
  server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  server.close();
  village.close();
});

test('distance versions: every building and character has a lighter copy with the same UV layout and tiny textures', () => {
  for (const group of ['buildings', 'characters']) {
    for (const [key, entry] of Object.entries(manifest[group]) as [string, any][]) {
      assert.ok(entry.lod, `${key}: lod file listed`);
      assert.ok(entry.lodDistance > 0, `${key}: switch distance`);
      const full = readGlb(path.join(MODELS, entry.file)).json;
      const { b, json, binStart } = readGlb(path.join(MODELS, entry.lod));
      const tris = (j: any) => j.meshes.flatMap((m: any) => m.primitives).reduce((n: number, p: any) => n + j.accessors[p.indices].count / 3, 0);
      assert.ok(tris(json) <= 25_000, `${key}: lod has ${tris(json)} triangles`);
      assert.ok(tris(json) < tris(full) / 3, `${key}: lod is much lighter than the full model`);
      const attrs = (j: any) => Object.keys(j.meshes[0].primitives[0].attributes).sort();
      assert.ok(attrs(json).includes('TEXCOORD_0'), `${key}: lod keeps UVs so the full model's textures fit`);
      for (const img of json.images ?? []) {
        const view = json.bufferViews[img.bufferView];
        const { w, h } = imageSize(b.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength));
        assert.ok(w <= 64 && h <= 64, `${key}: lod textures are placeholders (${w}x${h}); the full textures are reused`);
      }
    }
  }
});

test('models are served with the right type and can be revalidated without re-downloading', async () => {
  const url = `${base}/assets/models/${manifest.characters.codex.file}`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'model/gltf-binary');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.arrayBuffer();
  const again = await fetch(url, { headers: { 'if-none-match': etag! } });
  assert.equal(again.status, 304);
  const manifestRes = await fetch(`${base}/assets/models/manifest.json`);
  assert.equal(manifestRes.status, 200);
  assert.equal((await fetch(`${base}/assets/models/buildings/does-not-exist.glb`)).status, 404);
});

test('the page allows blob: URLs that the GLB loader uses for embedded textures', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? '';
  assert.match(csp, /img-src[^;]*blob:/);
  assert.match(csp, /connect-src[^;]*blob:/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
});

test('every browser TypeScript file compiles to JavaScript (what the server serves)', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const dir = path.join(PROJECT_ROOT, 'web', 'src');
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 5);
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'virelune-websrc-'));
  for (const f of files) {
    let js = '';
    assert.doesNotThrow(() => (js = stripTypeScriptTypes(fs.readFileSync(path.join(dir, f), 'utf8'), { mode: 'strip' })), `web/src/${f} has invalid syntax`);
    // Also catch JavaScript early errors the type stripper does not (e.g. a variable declared twice).
    const out = path.join(tmp, f.replace(/[\\/]/g, '_') + '.mjs');
    fs.writeFileSync(out, js);
    const check = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
    assert.equal(check.status, 0, `web/src/${f}: ${check.stderr.split('\n').filter((l) => /Error/.test(l)).join(' ')}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
