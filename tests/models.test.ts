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
  for (const id of Object.keys(manifest.buildings)) assert.ok(buildings.has(id), `manifest building "${id}" has no resident`);
  for (const id of Object.keys(manifest.characters)) assert.ok(lineages.has(id), `manifest character "${id}" matches no resident lineage`);
  for (const id of buildings) assert.ok(manifest.buildings[id], `building "${id}" has no custom model`);
});

test('each model file is a valid GLB with browser-sized textures', () => {
  let total = 0;
  for (const [group, entries] of Object.entries(manifest) as [string, any][]) {
    if (group !== 'buildings' && group !== 'characters') continue;
    for (const [key, entry] of Object.entries(entries) as [string, any][]) {
      const file = path.join(MODELS, entry.file);
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
