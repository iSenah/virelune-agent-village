// Who is doing what, and where: one resident per character, profiles resolve to their workplace, and a restart
// never replays old work as if it were happening now.
import assert from 'node:assert/strict';
import type http from 'node:http';
import { test } from 'node:test';
import { placeOf } from '../server/lib/activity.ts';
import { createServer } from '../server/lib/api.ts';
import { makeVillage } from './helpers.ts';

test('profiles resolve to their one resident and their workplace; plain residents work at home', () => {
  const { village } = makeVillage();
  try {
    const reg = village.registries;
    assert.deepEqual(placeOf(reg, 'codex-unreal'), { resident: 'codex', profile: 'codex-unreal', workplace: 'unreal-studio' });
    assert.deepEqual(placeOf(reg, 'claude-blender'), { resident: 'claude', profile: 'claude-blender', workplace: 'blender-house' });
    assert.deepEqual(placeOf(reg, 'claude'), { resident: 'claude', profile: null, workplace: 'library' });
    assert.deepEqual(placeOf(reg, 'codex'), { resident: 'codex', profile: null, workplace: 'engineering-forge' });
    assert.deepEqual(placeOf(reg, 'codex', { profile: 'codex-blender' }), { resident: 'codex', profile: 'codex-blender', workplace: 'blender-house' }, 'a run may name its profile');
    assert.equal(placeOf(reg, 'nobody'), null);
    assert.equal(placeOf(reg, 'system'), null);
  } finally {
    village.close();
  }
});

test('runs, progress, approvals and outcomes are tracked per resident, never per profile', () => {
  const { village } = makeVillage();
  try {
    const ev = village.events;
    ev.append({ type: 'run.started', actor: 'codex-unreal', runId: 'r1', taskId: 't1', payload: { kind: 'task' } });
    ev.append({ type: 'run.started', actor: 'codex', runId: 'r2', payload: { kind: 'chat' } });
    let s = village.activity.snapshot();
    assert.deepEqual(Object.keys(s.residents), ['codex'], 'one resident, however many profiles are busy');
    assert.deepEqual(s.residents.codex.runs.map((r) => [r.runId, r.workplace, r.profile]), [['r1', 'unreal-studio', 'codex-unreal'], ['r2', 'engineering-forge', null]], 'both real runs kept, oldest first');
    // progress only when it is meaningful
    ev.append({ type: 'run.progress', actor: 'codex-unreal', runId: 'r1', payload: { done: 5, total: 0 } });
    assert.equal(village.activity.snapshot().residents.codex.runs[0].progress, null);
    ev.append({ type: 'run.progress', actor: 'codex-unreal', runId: 'r1', payload: { done: 2, total: 5, label: 'levels' } });
    assert.deepEqual(village.activity.snapshot().residents.codex.runs[0].progress, { done: 2, total: 5, label: 'levels' });
    // an approval belongs to the run that asked for it, and to that run's workplace
    village.approvals.request({ kind: 'codex_command', resident: 'codex', summary: 'run a build', risk: 'medium', detail: { runId: 'r1' } });
    s = village.activity.snapshot();
    assert.equal(s.residents.codex.approvals.length, 1);
    assert.equal(s.residents.codex.approvals[0].workplace, 'unreal-studio');
    const approvalId = s.residents.codex.approvals[0].approvalId;
    village.approvals.decide(approvalId, 'approve', 'human');
    assert.equal(village.activity.snapshot().residents.codex.approvals.length, 0);
    ev.append({ type: 'run.failed', actor: 'codex-unreal', runId: 'r1', payload: { error: 'build broke' } });
    s = village.activity.snapshot();
    assert.deepEqual(s.residents.codex.runs.map((r) => r.runId), ['r2']);
    assert.equal(s.residents.codex.lastOutcome?.result, 'failed');
    assert.equal(s.residents.codex.lastOutcome?.workplace, 'unreal-studio');
    ev.append({ type: 'run.finished', actor: 'codex', runId: 'r2', payload: { kind: 'chat' } });
    s = village.activity.snapshot();
    assert.deepEqual(s.residents.codex.runs, []);
    assert.equal(s.residents.codex.lastOutcome?.result, 'completed');
    // stopping is not failing
    ev.append({ type: 'run.started', actor: 'claude', runId: 'r3', payload: { kind: 'chat' } });
    ev.append({ type: 'run.interrupted', actor: 'claude', runId: 'r3', payload: { reason: 'you stopped it' } });
    assert.equal(village.activity.snapshot().residents.claude.lastOutcome?.result, 'stopped');
    // ends of runs nobody started, and unknown actors, change nothing
    ev.append({ type: 'run.finished', actor: 'claude', runId: 'nope', payload: {} });
    ev.append({ type: 'run.started', actor: 'stranger', runId: 'r4', payload: {} });
    assert.equal(village.activity.snapshot().residents.stranger, undefined);
  } finally {
    village.close();
  }
});

test('ending a run clears its unanswered approvals', () => {
  const { village } = makeVillage();
  try {
    village.events.append({ type: 'run.started', actor: 'codex', runId: 'r1', payload: { kind: 'chat' } });
    village.approvals.request({ kind: 'codex_command', resident: 'codex', summary: 'x', risk: 'low', detail: { runId: 'r1' } });
    village.events.append({ type: 'run.interrupted', actor: 'codex', runId: 'r1', payload: {} });
    assert.deepEqual(village.activity.snapshot().residents.codex.approvals, []);
  } finally {
    village.close();
  }
});

test('after a restart nothing old is shown as happening now', () => {
  const first = makeVillage();
  first.village.events.append({ type: 'run.started', actor: 'codex-blender', runId: 'r1', payload: { kind: 'task' } });
  first.village.approvals.request({ kind: 'codex_command', resident: 'codex', summary: 'x', risk: 'low', detail: { runId: 'r1' } });
  assert.equal(first.village.activity.snapshot().residents.codex.runs.length, 1);
  first.village.close();
  const second = makeVillage({ dataDir: first.dataDir });
  try {
    assert.deepEqual(second.village.activity.snapshot().residents, {}, 'no runs, approvals or outcomes carried over');
    assert.ok(second.village.events.list(0, 5000).some((e) => e.runId === 'r1'), 'the history itself is kept');
  } finally {
    second.village.close();
  }
});

test('tasks can be assigned to a profile; the state API says whose task it is and where it happens', async () => {
  const { village } = makeVillage();
  const server: http.Server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const t = village.tasks.create({ title: 'Light the new level', assignee: 'codex-unreal' });
    assert.equal(t.assignee, 'codex-unreal');
    assert.notEqual(t.status, 'running', 'creating a task never starts it');
    village.events.append({ type: 'run.started', actor: 'claude', runId: 'r9', payload: { kind: 'chat' } });
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.tasks.find((x: any) => x.id === t.id).place, { resident: 'codex', profile: 'codex-unreal', workplace: 'unreal-studio' });
    assert.equal(state.activity.residents.claude.runs[0].workplace, 'library');
    assert.ok(state.activity.seq >= 1 && typeof state.activity.now === 'string');
    assert.equal(state.activity.residents.codex, undefined, 'a queued task is not activity');
  } finally {
    server.close();
    village.close();
  }
});
