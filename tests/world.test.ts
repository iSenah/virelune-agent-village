// The village layout (config/layout/world.json): districts, building slots, entrances, roads and routes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from '../server/lib/api.ts';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { loadRegistries } from '../server/lib/registry.ts';
import { loadWorld } from '../server/lib/world.ts';
import { allNodes, allRoads, buildingRotY, edgeDistance, entrance, footprintRadius, heightAt, riverRadius, route, validateWorld, type World } from '../web/src/village/worldModel.ts';
import { makeVillage } from './helpers.ts';

const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
const loaded = loadWorld(path.join(PROJECT_ROOT, 'config'), reg);
const world = loaded.world!;
const b = (id: string) => world.buildings.find((x) => x.id === id)!;

test('the shipped layout is valid: no overlaps, every home and workplace placed, everything reachable on foot', () => {
  assert.deepEqual(loaded.errors, []);
  assert.equal(world.buildings.length, 12);
});

test('districts hold the right buildings', () => {
  const inDistrict = (d: string) => world.buildings.filter((x) => x.district === d).map((x) => x.id).sort();
  assert.deepEqual(inDistrict('founders'), ['engineering-forge', 'library', 'post-office', 'town-hall', 'unreal-workshop']);
  assert.deepEqual(inDistrict('creative'), ['blender-house', 'unreal-studio']);
  assert.deepEqual(inDistrict('artisan'), ['runway-cinema', 'tripo-stable']);
  assert.deepEqual(inDistrict('heights'), ['copilot-commandery', 'gemini-observatory']);
  assert.deepEqual(inDistrict('woods'), ['deepseek-cottage']);
  assert.equal(b('blender-house').kind, 'workplace');
  assert.equal(b('unreal-studio').kind, 'workplace');
  assert.equal(b('tripo-stable').kind, 'service');
  assert.equal(b('runway-cinema').kind, 'service');
  for (const id of ['gemini-observatory', 'copilot-commandery']) assert.equal(entrance(world, b(id))[1], 8, `${id} stands on the Heights`);
  for (const id of ['tripo-stable', 'runway-cinema', 'gemini-observatory', 'copilot-commandery', 'deepseek-cottage']) assert.ok(b(id).modelNote, `${id} describes its future model`);
});

test('the original square is preserved where it was', () => {
  const expected: Record<string, [number, number]> = { 'town-hall': [0, -18], library: [-20, -10], 'unreal-workshop': [20, -10], 'engineering-forge': [-19, 13.5], 'post-office': [0, 23.5] };
  for (const [id, [x, z]] of Object.entries(expected)) assert.deepEqual([b(id).x, b(id).z], [x, z], id);
  for (const id of Object.keys(expected)) assert.ok(world.roads.some((r) => r.from === 'plaza' && r.to === `b:${id}`), `${id} keeps its road from the fountain`);
});

test('every entrance faces where its building faces', () => {
  for (const x of world.buildings) {
    const e = entrance(world, x);
    const [fx, fz] = x.face ?? [0, 0];
    assert.ok(Math.hypot(e[0] - fx, e[2] - fz) < Math.hypot(x.x - fx, x.z - fz), `${x.id}: the entrance is on the side facing ${x.face ?? 'the fountain'}`);
    assert.ok(Number.isFinite(buildingRotY(x)));
  }
});

test('Claude and Codex can walk from home to both shared workplaces and back', () => {
  for (const who of ['library', 'engineering-forge']) {
    for (const work of ['blender-house', 'unreal-studio']) {
      const there = route(world, `b:${who}`, `b:${work}`);
      const back = route(world, `b:${work}`, `b:${who}`);
      assert.ok(there && back, `${who} <-> ${work}`);
      assert.ok(Math.abs(there!.length - back!.length) < 1e-6);
      assert.ok(there!.via.includes('x:east:out'), 'crosses the east bridge to the Creative Workshops');
    }
  }
});

test('the Forgotten Woods are reached by a dirt road, and the Heights by stairs', () => {
  const kinds = (from: string, to: string) => {
    const r = route(world, from, to)!;
    return r.via.slice(1).map((n, i) => allRoads(world).find((x) => (x.from === r.via[i] && x.to === n) || (x.to === r.via[i] && x.from === n))!.kind);
  };
  const woods = kinds('plaza', 'b:deepseek-cottage');
  assert.equal(woods.at(-1), 'dirt');
  assert.ok(woods.includes('dirt') && !woods.slice(woods.indexOf('dirt')).includes('cobble'), 'once on the dirt road, it stays dirt');
  assert.ok(kinds('plaza', 'b:gemini-observatory').includes('stairs'));
  assert.ok(kinds('plaza', 'b:copilot-commandery').includes('stairs'));
  assert.ok(kinds('plaza', 'b:tripo-stable').includes('bridge'));
});

test('Scholars\' Heights: raised ground, stairs that meet its edge, waterfalls clear of the stairs', () => {
  const heights = world.plateaus.find((p) => p.id === 'heights')!;
  assert.equal(heightAt(world, 0, 0), 0, 'the fountain is on the valley floor');
  assert.equal(heightAt(world, 0, -64), 8, "the scholars' court is up on the Heights");
  const nodes = allNodes(world);
  const stairs = allRoads(world).filter((r) => r.kind === 'stairs');
  assert.equal(stairs.length, 2);
  for (const s of stairs) {
    const [bottom, top] = [nodes.get(s.from)!, nodes.get(s.to)!].sort((a, b) => a[1] - b[1]);
    assert.equal(heightAt(world, bottom[0], bottom[2]), 0, `${s.from}: the stairs start on the valley floor`);
    assert.equal(heightAt(world, top[0], top[2]), 8, `${s.to}: and end on the Heights`);
    const edge = edgeDistance(heights.outline, Math.atan2(top[2], top[0]))!;
    assert.ok(Math.abs(Math.hypot(top[0], top[2]) - edge) < 1.5, 'the top step meets the cliff edge, not inside the plateau');
    assert.ok(Math.hypot(bottom[0], bottom[2]) > riverRadius(Math.atan2(bottom[2], bottom[0])) + 4, 'the stairs start across the river');
  }
  assert.ok((heights.waterfalls ?? []).length >= 1);
  for (const deg of heights.waterfalls ?? []) {
    const a = (deg * Math.PI) / 180;
    assert.ok(edgeDistance(heights.outline, a), `waterfall at ${deg}° falls from the edge`);
    for (const s of stairs) {
      const top = nodes.get(s.to)!;
      const sa = Math.atan2(top[2], top[0]);
      assert.ok(Math.abs(Math.atan2(Math.sin(a - sa), Math.cos(a - sa))) > 0.15, `waterfall at ${deg}° is clear of the stairs`);
    }
  }
});

test('district squares sit on known points and clear of the buildings', () => {
  const nodes = allNodes(world);
  assert.deepEqual((world.squares ?? []).map((s) => s.node).sort(), ['n:artisan', 'n:creative', 'n:heights']);
  for (const sq of world.squares ?? []) {
    const p = nodes.get(sq.node)!;
    for (const x of world.buildings) assert.ok(Math.hypot(p[0] - x.x, p[2] - x.z) > sq.radius + footprintRadius(x), `${sq.node} overlaps ${x.id}`);
  }
  const w = structuredClone(world) as World;
  w.squares!.push({ node: 'n:missing', radius: 4 });
  assert.ok(validateWorld(w).some((e) => /square at unknown point "n:missing"/.test(e)));
});

test('the validator catches broken layouts', () => {
  const clone = () => structuredClone(world) as World;
  let w = clone();
  w.buildings.find((x) => x.id === 'tripo-stable')!.x = -62;
  w.buildings.find((x) => x.id === 'tripo-stable')!.z = 14;
  assert.ok(validateWorld(w).some((e) => /overlap/.test(e)), 'overlap');
  w = clone();
  w.buildings.find((x) => x.id === 'gemini-observatory')!.z = -40;
  assert.ok(validateWorld(w).some((e) => /plateau|river/.test(e)), 'off the Heights');
  w = clone();
  w.roads = w.roads.filter((r) => r.to !== 'b:deepseek-cottage');
  assert.ok(validateWorld(w).some((e) => /deepseek-cottage" cannot be reached/.test(e)), 'unreachable');
  w = clone();
  w.roads.push({ from: 'n:nowhere', to: 'plaza', kind: 'cobble' });
  assert.ok(validateWorld(w).some((e) => /unknown point "n:nowhere"/.test(e)));
  w = clone();
  w.roads.push({ from: 'plaza', to: 'b:copilot-commandery', kind: 'cobble' });
  assert.ok(validateWorld(w).some((e) => /runs through "town-hall"/.test(e)), 'a road straight through Town Hall');
  assert.ok(validateWorld(world, ['no-such-building']).some((e) => /not in the layout/.test(e)));
});

test('a broken layout file is reported in the activity log, not hidden', () => {
  const dir = fs.mkdtempSync(path.join(PROJECT_ROOT, '..', 'virelune-world-'));
  try {
    fs.cpSync(path.join(PROJECT_ROOT, 'config'), dir, { recursive: true });
    const bad = JSON.parse(fs.readFileSync(path.join(dir, 'layout', 'world.json'), 'utf8'));
    bad.buildings = bad.buildings.filter((x: any) => x.id !== 'library');
    fs.writeFileSync(path.join(dir, 'layout', 'world.json'), JSON.stringify(bad));
    const r = loadRegistries(dir);
    const lw = loadWorld(dir, r);
    assert.ok(lw.errors.some((e) => /"library", which is not in the layout/.test(e)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/world: entrances, indicator anchors, homes and workplaces from the registry, no invented status', async () => {
  const { village } = makeVillage();
  const server: http.Server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { world: w, errors } = await (await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/world`)).json();
    assert.deepEqual(errors, []);
    const blender = w.buildings.find((x: any) => x.id === 'blender-house');
    assert.deepEqual(blender.residents, [], 'nobody lives at a workplace');
    assert.deepEqual(blender.workers.map((x: any) => x.resident).sort(), ['claude', 'codex']);
    assert.equal(blender.entrance.length, 3);
    assert.ok(blender.indicatorAnchor[1] > 10, 'room above the building for a progress indicator');
    assert.deepEqual(w.homes.claude, { home: 'library', workplaces: ['blender-house', 'unreal-studio'], planned: false });
    assert.deepEqual(w.homes.gemini, { home: 'gemini-observatory', workplaces: [], planned: true });
    assert.ok(w.walkEdges.length > 20);
    assert.ok(!JSON.stringify(w).includes('"connected"'), 'the layout never carries connection status');
  } finally {
    server.close();
    village.close();
  }
});
