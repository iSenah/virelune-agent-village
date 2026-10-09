// Resident life: one character per resident, real-state-driven destinations, walking on roads only,
// and recovery (reloads, work ending or failing on the way, several tasks at once).
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { loadRegistries } from '../server/lib/registry.ts';
import { loadWorld } from '../server/lib/world.ts';
import { buildingIndicators, desiredFor, LIFE_CONFIG, LifeDirector, pathBetween, ResidentLife, type ResidentActivityLike } from '../web/src/village/life.ts';
import { footprintRadius, riverRadius, RIVER_W, walkGraph, type World } from '../web/src/village/worldModel.ts';

const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
const world = loadWorld(path.join(PROJECT_ROOT, 'config'), reg).world as World;
const graph = walkGraph(world);

const run = (runId: string, workplace: string, seq: number, extra: object = {}) => ({ runId, workplace, seq, ...extra });
const act = (o: Partial<ResidentActivityLike> = {}): ResidentActivityLike => ({ runs: [], approvals: [], lastOutcome: null, ...o });
const stepFor = (life: ResidentLife, seconds: number, onStep?: () => void) => {
  for (let t = 0; t < seconds; t += 0.05) {
    life.step(0.05);
    onStep?.();
  }
};
const walkUntil = (life: ResidentLife, state: string, max = 120) => {
  const seen = new Set<string>();
  for (let t = 0; t < max && life.view().state !== state; t += 0.05) {
    life.step(0.05);
    seen.add(life.view().state);
  }
  assert.equal(life.view().state, state, `reached ${state} (went through ${[...seen].join(', ')})`);
  return seen;
};

test('destination rule: oldest approval, else earliest run (ties by run id), else home; queued tasks never count', () => {
  assert.deepEqual(desiredFor(undefined), { mode: 'home' });
  assert.deepEqual(desiredFor(act()), { mode: 'home' });
  assert.deepEqual(desiredFor(act({ runs: [run('r2', 'unreal-studio', 9), run('r1', 'engineering-forge', 4)] })), { mode: 'work', workplace: 'engineering-forge', ref: 'r1' });
  assert.deepEqual(desiredFor(act({ runs: [run('rb', 'unreal-studio', 4), run('ra', 'blender-house', 4)] })), { mode: 'work', workplace: 'blender-house', ref: 'ra' });
  assert.deepEqual(desiredFor(act({ runs: [run('r1', 'engineering-forge', 1)], approvals: [{ approvalId: 'a2', workplace: 'unreal-studio', seq: 12 }, { approvalId: 'a1', workplace: 'blender-house', seq: 8 }] })), { mode: 'approval', workplace: 'blender-house', ref: 'a1' });
});

test('walking routes follow roads: bridges over the river, stairs up the Heights, never through buildings', () => {
  const routes: [string, string][] = [['library', 'blender-house'], ['engineering-forge', 'unreal-studio'], ['library', 'gemini-observatory'], ['engineering-forge', 'tripo-stable'], ['town-hall', 'deepseek-cottage']];
  for (const [from, to] of routes) {
    const p = pathBetween(world, graph, `b:${from}`, `b:${to}`)!;
    assert.ok(p, `${from} -> ${to}`);
    const total = p.cum[p.cum.length - 1];
    let maxY = 0;
    for (let d = 0; d <= total; d += 0.5) {
      // sample the path finely
      let i = 1;
      while (i < p.cum.length - 1 && p.cum[i] < d) i++;
      const t = (d - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1] || 1);
      const a = p.points[i - 1];
      const b = p.points[i];
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      maxY = Math.max(maxY, y);
      const th = Math.atan2(z, x);
      if (Math.abs(Math.hypot(x, z) - riverRadius(th)) < RIVER_W / 2) {
        const onBridge = world.crossings.some((c) => Math.abs(Math.atan2(Math.sin(th - (c.angle * Math.PI) / 180), Math.cos(th - (c.angle * Math.PI) / 180))) < 0.08);
        assert.ok(onBridge, `${from} -> ${to}: in the river at ${x.toFixed(1)}, ${z.toFixed(1)} away from a bridge`);
        assert.ok(y > 0.5, 'on the arched deck, above the water');
      }
      for (const bld of world.buildings) {
        if (bld.id === from || bld.id === to) continue;
        assert.ok(Math.hypot(x - bld.x, z - bld.z) > footprintRadius(bld) - 0.5, `${from} -> ${to}: walks through ${bld.id}`);
      }
    }
    if (to === 'gemini-observatory') assert.ok(maxY > 8, 'climbs to the Heights');
    else assert.ok(maxY < 2, `${from} -> ${to} stays on the valley floor`);
  }
});

test('a Blender task: wake, walk to Blender House, work inside, show the real completion, walk home, rest', () => {
  const life = new ResidentLife(world, 'claude', 'library', graph);
  life.settle({ mode: 'home' });
  assert.equal(life.view().state, 'idle_home');
  life.update({ mode: 'work', workplace: 'blender-house', ref: 'r1' });
  assert.equal(life.view().state, 'waking');
  stepFor(life, LIFE_CONFIG.wakeSeconds + 0.1);
  assert.equal(life.view().state, 'traveling_to_work');
  assert.ok(life.view().visible && life.view().walking);
  walkUntil(life, 'working');
  assert.equal(life.view().visible, false, 'inside the building while working');
  assert.equal(life.view().place, 'blender-house');
  life.update({ mode: 'home' }, 'completed');
  assert.equal(life.view().state, 'task_completed');
  assert.ok(life.view().visible, 'comes out to the door');
  stepFor(life, LIFE_CONFIG.outcomeSeconds + 0.1);
  assert.equal(life.view().state, 'returning_home');
  walkUntil(life, 'idle_home');
  assert.equal(life.view().place, 'library');
});

test('chat replies and general work happen at home: no trip', () => {
  const life = new ResidentLife(world, 'claude', 'library', graph);
  life.settle({ mode: 'home' });
  life.update({ mode: 'work', workplace: 'library', ref: 'r1' });
  const seen = walkUntil(life, 'working', 5);
  assert.ok(!seen.has('traveling_to_work'));
  life.update({ mode: 'home' }, null); // stopped: no outcome shown
  assert.equal(life.view().state, 'idle_home');
});

test('work that ends or fails on the way: the outcome shows where it stands, then it turns back along the roads', () => {
  for (const result of ['completed', 'failed'] as const) {
    const life = new ResidentLife(world, 'codex', 'engineering-forge', graph);
    life.settle({ mode: 'home' });
    life.update({ mode: 'work', workplace: 'unreal-studio', ref: 'r1' });
    stepFor(life, LIFE_CONFIG.wakeSeconds + 6);
    assert.equal(life.view().state, 'traveling_to_work');
    const where = life.view().position;
    life.update({ mode: 'home' }, result);
    assert.equal(life.view().state, result === 'completed' ? 'task_completed' : 'task_failed');
    stepFor(life, 1);
    assert.deepEqual(life.view().position, where, 'pauses on the spot to show it');
    stepFor(life, LIFE_CONFIG.outcomeSeconds);
    assert.equal(life.view().state, 'returning_home');
    walkUntil(life, 'idle_home');
    assert.equal(life.view().place, 'engineering-forge');
  }
});

test('approvals: steps out to the workplace door, goes back in when work resumes', () => {
  const life = new ResidentLife(world, 'codex', 'engineering-forge', graph);
  life.settle({ mode: 'work', workplace: 'unreal-studio', ref: 'r1' });
  assert.equal(life.view().state, 'working');
  life.update({ mode: 'approval', workplace: 'unreal-studio', ref: 'a1' });
  assert.equal(life.view().state, 'awaiting_approval');
  assert.ok(life.view().visible);
  life.update({ mode: 'work', workplace: 'unreal-studio', ref: 'r1' });
  assert.equal(life.view().state, 'working');
  assert.equal(life.view().visible, false);
});

test('a new destination while walking reroutes along the roads instead of cutting across', () => {
  const life = new ResidentLife(world, 'claude', 'library', graph);
  life.settle({ mode: 'home' });
  life.update({ mode: 'work', workplace: 'blender-house', ref: 'r1' });
  stepFor(life, LIFE_CONFIG.wakeSeconds + 4);
  life.update({ mode: 'work', workplace: 'gemini-observatory', ref: 'r2' });
  assert.equal(life.view().state, 'traveling_to_work');
  let maxY = 0;
  for (let t = 0; t < 120 && life.view().state !== 'working'; t += 0.05) {
    life.step(0.05);
    maxY = Math.max(maxY, life.view().position[1]);
  }
  assert.equal(life.view().state, 'working');
  assert.equal(life.view().place, 'gemini-observatory');
  assert.ok(maxY > 8, 'went up the stairs to the Heights');
});

test('reload: the director places everyone where real activity says, without replaying walks or old outcomes', () => {
  const dir = new LifeDirector(world);
  const residents = [{ id: 'claude', home: 'library' }, { id: 'codex', home: 'engineering-forge' }, { id: 'echo', home: 'town-hall' }];
  dir.sync(residents, {
    claude: act({ runs: [run('r1', 'blender-house', 10)] }),
    codex: act({ lastOutcome: { result: 'completed', workplace: 'unreal-studio', seq: 7, at: new Date().toISOString() } }),
  });
  assert.equal(dir.lives.size, 3, 'one character per resident');
  assert.equal(dir.lives.get('claude')!.view().state, 'working');
  assert.equal(dir.lives.get('claude')!.view().place, 'blender-house');
  assert.equal(dir.lives.get('codex')!.view().state, 'idle_home', 'an outcome from before the reload is not acted out again');
  assert.equal(dir.lives.get('echo')!.view().state, 'idle_home');
  // a second Blender task for Claude does not create a second Claude
  dir.sync(residents, { claude: act({ runs: [run('r1', 'blender-house', 10), run('r2', 'unreal-studio', 12)] }) });
  assert.equal([...dir.lives.keys()].filter((k) => k === 'claude').length, 1);
  assert.equal(dir.lives.get('claude')!.view().place, 'blender-house', 'stays with the earliest real run');
  // the first run finishes live: its outcome shows once, then Claude heads to the remaining run
  dir.sync(residents, { claude: act({ runs: [run('r2', 'unreal-studio', 12)], lastOutcome: { result: 'completed', workplace: 'blender-house', seq: 13, at: new Date().toISOString() } }) });
  assert.equal(dir.lives.get('claude')!.view().state, 'traveling_to_work');
  assert.equal(dir.lives.get('claude')!.view().place, 'unreal-studio');
});

test('building indicators come only from real runs, approvals and recent outcomes', () => {
  const now = '2026-10-09T12:00:00.000Z';
  const ind = buildingIndicators(
    {
      codex: act({ runs: [run('r1', 'unreal-studio', 3, { taskId: 't1', progress: { done: 2, total: 5, label: null } })], approvals: [{ approvalId: 'a1', workplace: 'blender-house', seq: 5, taskId: 't2' }] }),
      claude: act({ runs: [run('r2', 'blender-house', 4)], lastOutcome: { result: 'failed', workplace: 'library', seq: 2, at: '2026-10-09T11:59:00.000Z', runId: 'r0' } }),
      echo: act({ lastOutcome: { result: 'completed', workplace: 'town-hall', seq: 1, at: '2026-10-09T11:30:00.000Z' } }),
      aura: act({ lastOutcome: { result: 'stopped', workplace: 'unreal-workshop', seq: 1, at: now } }),
    },
    now,
  );
  assert.equal(ind.get('unreal-studio')!.color, 'blue');
  assert.deepEqual(ind.get('unreal-studio')!.progress, { done: 2, total: 5, label: null }, 'real progress is passed through');
  assert.deepEqual(ind.get('unreal-studio')!.taskIds, ['t1']);
  assert.equal(ind.get('blender-house')!.color, 'amber', 'waiting for approval outranks active work');
  assert.equal(ind.get('blender-house')!.progress, null);
  assert.equal(ind.get('library')!.color, 'red');
  assert.equal(ind.has('town-hall'), false, 'a completion from 30 minutes ago has faded');
  assert.equal(ind.has('unreal-workshop'), false, 'stopping is not failing');
  const two = buildingIndicators({ codex: act({ runs: [run('a', 'engineering-forge', 1, { progress: { done: 1, total: 2, label: null } }), run('b', 'engineering-forge', 2)] }) }, now);
  assert.equal(two.get('engineering-forge')!.progress, null, 'several runs: indeterminate, no invented combined percentage');
  assert.equal(buildingIndicators({}, now).size, 0, 'nothing happening, nothing shown');
});

test('simulation mode stays in the browser: it cannot reach Village Hall or the activity feed', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'web/src/simulation.ts'), 'utf8');
  assert.ok(!/from '\.\/store\.ts'|\bapi\(|fetch\(|\/api\/|EventSource/.test(src), 'no requests, no store, no event stream');
  assert.match(src, /SIMULATION · not real activity/, 'the banner says so');
  const main = fs.readFileSync(path.join(PROJECT_ROOT, 'web/src/main.ts'), 'utf8');
  assert.match(main, /has\('simulate'\)/, 'only with ?simulate');
  assert.match(main, /simulation \? simulation\.snapshot\(\) : \(s\.activity \?\? null\)/, 'simulated activity only replaces what the 3D village shows');
});
