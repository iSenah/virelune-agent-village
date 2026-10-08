import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { openDb } from '../server/lib/db.ts';
import { EventLog } from '../server/lib/events.ts';
import { TaskEngine } from '../server/lib/tasks.ts';
import { makeVillage, tmpDir } from './helpers.ts';

test('event log: ordered, validated, persistent, and notifies subscribers', async () => {
  const file = path.join(tmpDir(), 'v.db');
  const db = openDb(file);
  const log = new EventLog(db);
  const seen: number[] = [];
  log.subscribe((e) => seen.push(e.seq));
  const a = log.append({ type: 'test.one', actor: 'system', payload: { n: 1 } });
  const b = log.append({ type: 'test.two', actor: 'system' });
  assert.ok(b.seq > a.seq);
  assert.throws(() => log.append({ type: 'Bad Type', actor: 'x' }));
  assert.throws(() => log.append({ type: 'test.three', actor: '' }));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [a.seq, b.seq]);
  assert.deepEqual(log.list(a.seq).map((e) => e.type), ['test.two']);
  assert.deepEqual(log.list(0, 10, ['test.one']).map((e) => e.payload.n), [1]);
  db.close();
  const reopened = new EventLog(openDb(file));
  assert.equal(reopened.lastSeq(), b.seq);
  assert.equal(reopened.list(0).length, 2);
});

test('event log has no update or delete path', () => {
  const methods = Object.getOwnPropertyNames(EventLog.prototype);
  assert.ok(!methods.some((m) => /update|delete|remove|edit/i.test(m)), `unexpected mutators: ${methods.join(', ')}`);
});

test('tasks: validation, dependencies and honest waiting reasons', () => {
  const { village } = makeVillage();
  const t = village.tasks;
  assert.throws(() => t.create({ title: '' }), /title is required/);
  assert.throws(() => t.create({ title: 'x', assignee: 'nobody' }), /unknown resident/);
  assert.throws(() => t.create({ title: 'x', dependsOn: ['t_missing'] }), /does not exist/);
  const design = t.create({ title: 'Design mdlinks', assignee: 'claude' });
  // No doctor results on this test machine: the task waits and says why. It never starts.
  assert.equal(design.status, 'ready');
  assert.match(design.waitingReason!, /Claude is not checked yet/);
  const build = t.create({ title: 'Implement mdlinks', assignee: 'codex', dependsOn: [design.id] });
  assert.equal(build.status, 'blocked');
  assert.match(build.waitingReason!, /Waiting for 1 dependency/);
  const draft = t.create({ title: 'Unassigned idea' });
  assert.equal(draft.status, 'draft');
  t.cancel(design.id);
  assert.equal(t.get(build.id)!.status, 'blocked');
  assert.match(t.get(build.id)!.waitingReason!, /is cancelled/);
  assert.throws(() => t.transition(design.id, 'running', 'human'), /cannot move task from cancelled/);
  const types = village.events.list(0).map((e) => e.type);
  assert.ok(types.includes('task.created') && types.includes('task.status_changed'));
  assert.ok(!t.list().some((x) => x.status === 'running'), 'no adapter is enabled, so nothing may run');
  village.close();
});

test('tasks: work interrupted by a restart is marked interrupted, not resumed', () => {
  const { village } = makeVillage();
  const t = village.tasks.create({ title: 'Long job', assignee: 'codex' });
  village.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id); // simulate a crash mid-run
  assert.equal(village.tasks.recoverAfterRestart(), 1);
  assert.equal(village.tasks.get(t.id)!.status, 'interrupted');
  village.close();
});

test('tasks: cycle detection', () => {
  assert.equal(TaskEngine.hasCycle(new Map([['a', ['b']], ['b', ['c']], ['c', []]])), false);
  assert.equal(TaskEngine.hasCycle(new Map([['a', ['b']], ['b', ['a']]])), true);
});

test('residents: status comes only from checks; non-focus residents stay disconnected', () => {
  const { village } = makeVillage();
  assert.ok(village.residents().every((r) => r.status === 'untested'));
  const all = ['node', 'git', 'codex', 'claude-agent-sdk', 'anthropic-api', 'openai-agents', 'openai-api', 'ollama', 'blender', 'unreal', 'aura'];
  village.setDoctorResultsForTest(all.map((id) => ({ id, name: id, status: 'connected', ready: true, version: null, summary: 'ok', checks: [], costs: '' })));
  const byId = new Map(village.residents().map((r) => [r.id, r]));
  for (const id of ['echo', 'codex', 'claude']) assert.equal(byId.get(id)!.status, 'connected', id);
  for (const id of ['aura', 'codex-blender', 'claude-blender', 'codex-unreal', 'claude-unreal', 'scribe']) {
    assert.equal(byId.get(id)!.status, 'disconnected', id);
    assert.match(byId.get(id)!.reasons[0], /individual verification/);
  }
  village.setDoctorResultsForTest(all.map((id) => ({ id, name: id, status: id === 'codex' ? 'installed' : 'connected', ready: id !== 'codex', version: null, summary: id === 'codex' ? 'not logged in' : 'ok', checks: [], costs: '' })));
  assert.equal(village.residents().find((r) => r.id === 'codex')!.status, 'disconnected');
  village.close();
});

test('Echo autonomy: only Supervised can be selected', () => {
  const { village } = makeVillage();
  assert.equal(village.settings.echoAutonomy(), 'supervised');
  assert.throws(() => village.settings.setEchoAutonomy('assisted'), /not available yet/);
  assert.throws(() => village.settings.setEchoAutonomy('autonomous'), /not available yet/);
  assert.throws(() => village.settings.setEchoAutonomy('godmode'), /unknown autonomy level/);
  assert.equal(village.settings.setEchoAutonomy('supervised'), 'supervised');
  // A stored unavailable level (e.g. from a future version) is ignored.
  village.db.prepare("INSERT INTO settings (key, value_json) VALUES ('echo.autonomy', '\"autonomous\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run();
  assert.equal(village.settings.echoAutonomy(), 'supervised');
  village.close();
});

test('approvals fail safe: timeout expires the request', async () => {
  const { village } = makeVillage();
  const a = village.approvals.request({ kind: 'test', summary: 'x', risk: 'exec' });
  const decided = await village.approvals.wait(a.id, 30);
  assert.equal(decided.status, 'expired');
  assert.throws(() => village.approvals.decide(a.id, 'approve', 'human'), /already expired/);
  village.close();
});
