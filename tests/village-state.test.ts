// The village may only show work that real events describe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveVisuals, type EventLike, type ResidentLike } from '../web/src/village/state.ts';

const R = (id: string, building: string, status: ResidentLike['status']): ResidentLike => ({ id, displayName: id, building, status, reasons: [], appearance: { lineage: id, color: '#888888' } });
let seq = 0;
const E = (type: string, actor: string, extra: Partial<EventLike> = {}): EventLike => ({ seq: ++seq, type, actor, taskId: null, runId: null, payload: {}, ...extra });

test('with no events, nobody works and nothing is busy', () => {
  const v = deriveVisuals([R('codex', 'forge', 'connected'), R('claude', 'library', 'disconnected')], []);
  assert.ok(v.residents.every((r) => r.pose === 'home'));
  assert.ok(v.buildings.every((b) => !b.busy));
});

test('a real run shows work only for a connected resident', () => {
  const events = [E('run.started', 'codex', { runId: 'r1' }), E('run.started', 'claude', { runId: 'r2' })];
  const v = deriveVisuals([R('codex', 'forge', 'connected'), R('claude', 'library', 'disconnected')], events);
  assert.equal(v.residents.find((r) => r.id === 'codex')!.pose, 'working');
  assert.equal(v.residents.find((r) => r.id === 'claude')!.pose, 'home', 'a disconnected resident is never shown working');
  assert.equal(v.buildings.find((b) => b.id === 'forge')!.busy, true);
  assert.equal(v.buildings.find((b) => b.id === 'library')!.busy, false);
});

test('finishing a run, or a restart, ends the work animation', () => {
  const finished = deriveVisuals([R('codex', 'forge', 'connected')], [E('run.started', 'codex', { runId: 'r1' }), E('run.finished', 'codex', { runId: 'r1' })]);
  assert.equal(finished.residents[0].pose, 'home');
  const restarted = deriveVisuals([R('codex', 'forge', 'connected')], [E('run.started', 'codex', { runId: 'r1' }), E('village.started', 'system')]);
  assert.equal(restarted.residents[0].pose, 'home');
});

test('a pending approval sends the resident to the plaza; a decision sends it back', () => {
  const req = E('approval.requested', 'codex', { payload: { approvalId: 'a1' } });
  assert.equal(deriveVisuals([R('codex', 'forge', 'connected')], [req]).residents[0].pose, 'waiting');
  assert.equal(deriveVisuals([R('codex', 'forge', 'connected')], [req, E('approval.decided', 'human', { payload: { approvalId: 'a1' } })]).residents[0].pose, 'home');
});

test('windows are lit only when a resident there is connected', () => {
  const v = deriveVisuals([R('a', 'h1', 'connected'), R('b', 'h1', 'disconnected'), R('c', 'h2', 'disconnected'), R('d', 'h3', 'untested')], []);
  assert.equal(v.buildings.find((b) => b.id === 'h1')!.lit, 'lit');
  assert.equal(v.buildings.find((b) => b.id === 'h2')!.lit, 'dark');
  assert.equal(v.buildings.find((b) => b.id === 'h3')!.lit, 'unknown');
});

test('the village code has no randomness in its activity mapping', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../web/src/village/state.ts', import.meta.url), 'utf8');
  assert.ok(!/Math\.random|Date\.now|setInterval|setTimeout/.test(src), 'state.ts must be a pure function of real state');
});
