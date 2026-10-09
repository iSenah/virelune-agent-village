// Resident conversations: honest delivery, persistence, real-adapter replies, failures, stop, and API guards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from '../server/lib/api.ts';
import type { AdapterContext, AgentAdapter } from '../server/lib/chat.ts';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { makeVillage } from './helpers.ts';

const ALL = ['git', 'node', 'codex', 'openai-api', 'anthropic-api', 'claude-agent-sdk', 'openai-agents', 'ollama', 'blender', 'unreal', 'aura'];
const allReady = () => ALL.map((id) => ({ id, name: id, status: 'connected' as const, ready: true, version: null, summary: 'ok', checks: [], costs: '' }));

/** TEST-ONLY adapter standing in for a real runtime. Never registered by the server (see the last test). */
class FixtureAdapter implements AgentAdapter {
  runtimeKind = 'codex-app-server';
  calls: AdapterContext[] = [];
  mode: 'ok' | 'fail' | 'hang' | 'empty' = 'ok';
  async reply(ctx: AdapterContext) {
    this.calls.push(ctx);
    if (this.mode === 'fail') throw new Error('runtime crashed');
    if (this.mode === 'empty') return { text: '   ' };
    if (this.mode === 'hang') {
      ctx.onDelta('partial ');
      await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
    }
    ctx.onDelta('fixture ');
    return { text: `fixture reply to: ${ctx.message}`, threadState: `thread-${this.calls.length}` };
  }
}

const settle = async (village: any, resident: string) => {
  for (let i = 0; i < 100 && village.chat.isBusy(resident); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 5));
};

test('a message to an unchecked resident is stored as undelivered and nothing replies', () => {
  const { village } = makeVillage({ adapters: [new FixtureAdapter()] });
  const m = village.chat.send('codex', 'Hello Codex');
  assert.equal(m.status, 'undelivered');
  assert.match(m.reason!, /Codex is not checked yet/);
  const msgs = village.chat.list('codex');
  assert.equal(msgs.length, 1, 'no reply message of any kind');
  assert.equal(msgs[0].role, 'human');
  const types = village.events.list().map((e) => e.type);
  assert.ok(types.includes('chat.message_sent') && types.includes('chat.message_undelivered'));
  assert.ok(!types.includes('run.started'), 'no run starts for an undelivered message');
  village.close();
});

test('a connected resident with no enabled adapter cannot answer either', () => {
  const { village } = makeVillage(); // no adapters at all, like the real server in this milestone
  village.setDoctorResultsForTest(allReady());
  assert.equal(village.residents().find((r) => r.id === 'codex')!.status, 'connected');
  const m = village.chat.send('codex', 'Anyone there?');
  assert.equal(m.status, 'undelivered');
  assert.match(m.reason!, /adapter is not enabled yet/);
  assert.equal(village.chat.list('codex').length, 1);
  village.close();
});

test('non-focus residents stay undelivered even when their tools pass checks', () => {
  const adapter = new FixtureAdapter();
  const { village } = makeVillage({ adapters: [adapter] });
  village.setDoctorResultsForTest(allReady());
  const m = village.chat.send('codex-blender', 'Model a chair');
  assert.equal(m.status, 'undelivered');
  assert.match(m.reason!, /individual verification/);
  assert.equal(adapter.calls.length, 0);
  village.close();
});

test('a real adapter reply is stored with run events, and history and thread state are passed on', async () => {
  const adapter = new FixtureAdapter();
  const { village } = makeVillage({ adapters: [adapter] });
  village.setDoctorResultsForTest(allReady());
  const m1 = village.chat.send('codex', 'First question');
  assert.equal(m1.status, 'delivered');
  assert.equal(village.chat.isBusy('codex'), true);
  await settle(village, 'codex');
  const msgs = village.chat.list('codex');
  assert.deepEqual(msgs.map((m) => [m.role, m.status]), [['human', 'answered'], ['resident', 'complete']]);
  assert.equal(msgs[1].body, 'fixture reply to: First question');
  assert.equal(msgs[1].replyTo, m1.id);
  const evs = village.events.list().filter((e) => e.runId === msgs[1].runId).map((e) => e.type);
  assert.deepEqual(evs, ['run.started', 'chat.reply_completed', 'run.finished']);
  village.chat.send('codex', 'Second question');
  await settle(village, 'codex');
  const second = adapter.calls[1];
  assert.deepEqual(second.history, [{ role: 'human', body: 'First question' }, { role: 'resident', body: 'fixture reply to: First question' }]);
  assert.equal(second.threadState, 'thread-1');
  assert.equal(second.resident.id, 'codex');
  village.close();
});

test('runtime failures and empty replies are recorded as failures, never as answers', async () => {
  const adapter = new FixtureAdapter();
  const { village } = makeVillage({ adapters: [adapter] });
  village.setDoctorResultsForTest(allReady());
  adapter.mode = 'fail';
  village.chat.send('codex', 'Break please');
  await settle(village, 'codex');
  adapter.mode = 'empty';
  village.chat.send('codex', 'Say nothing');
  await settle(village, 'codex');
  const msgs = village.chat.list('codex');
  assert.deepEqual(msgs.map((m) => [m.role, m.status]), [['human', 'failed'], ['resident', 'failed'], ['human', 'failed'], ['resident', 'failed']]);
  assert.match(msgs[1].reason!, /runtime crashed/);
  assert.match(msgs[3].reason!, /empty reply/);
  assert.equal(village.events.list().filter((e) => e.type === 'run.failed').length, 2);
  village.close();
});

test('one reply at a time per resident; a reply in progress can be stopped and keeps its partial text', async () => {
  const adapter = new FixtureAdapter();
  const { village } = makeVillage({ adapters: [adapter] });
  village.setDoctorResultsForTest(allReady());
  adapter.mode = 'hang';
  village.chat.send('codex', 'Take your time');
  await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => village.chat.send('codex', 'Another'), /still answering/);
  assert.equal(village.chat.partial('codex')?.text, 'partial ');
  assert.equal(village.chat.stop('codex'), true);
  await settle(village, 'codex');
  const msgs = village.chat.list('codex');
  assert.deepEqual(msgs.map((m) => [m.role, m.status]), [['human', 'stopped'], ['resident', 'stopped']]);
  assert.equal(msgs[1].body, 'partial ');
  assert.ok(village.events.list().some((e) => e.type === 'run.interrupted'));
  assert.equal(village.chat.stop('codex'), false);
  village.close();
});

test('conversations persist across restarts; replies cut off by a restart are marked interrupted', async () => {
  const adapter = new FixtureAdapter();
  const first = makeVillage({ adapters: [adapter] });
  first.village.setDoctorResultsForTest(allReady());
  first.village.chat.send('echo', 'Saved for later?');
  // simulate a crash mid-reply: a streaming row left behind
  first.village.db.prepare("INSERT INTO chat_messages (id, resident, thread, role, body, status, reason, run_id, reply_to, created_at, updated_at) VALUES ('m_crash', 'codex', 'main', 'resident', 'half', 'streaming', NULL, 'r_x', 'm_x', 'now', 'now')").run();
  first.village.close();
  const second = makeVillage({ dataDir: first.dataDir });
  const echo = second.village.chat.list('echo');
  assert.equal(echo.length, 1);
  assert.equal(echo[0].body, 'Saved for later?');
  assert.equal(second.village.chat.get('m_crash')!.status, 'interrupted');
  second.village.close();
});

test('input is validated', () => {
  const { village } = makeVillage();
  assert.throws(() => village.chat.send('nobody', 'hi'), /not found/);
  assert.throws(() => village.chat.send('codex', '   '), /empty/);
  assert.throws(() => village.chat.send('codex', 'x'.repeat(8001)), /8000/);
  assert.throws(() => village.chat.send('codex', { text: 'hi' } as any), /empty/);
  village.close();
});

test('chat API: resident detail, sending needs the village header, and reasons are shown', async () => {
  const { village } = makeVillage();
  const server: http.Server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const H = { 'content-type': 'application/json', 'x-village-client': '1' };
    const detail = await (await fetch(`${base}/api/residents/claude-unreal`)).json();
    assert.equal(detail.resident.building, 'unreal-studio');
    assert.equal(detail.profile.runtime.adapterEnabled, false);
    assert.equal(detail.profile.provider.billing, 'paid-api');
    assert.deepEqual(detail.profile.tools.map((t: any) => t.server), ['unreal-58']);
    assert.match(detail.chat.blocker, /not checked yet/);
    assert.equal((await fetch(`${base}/api/residents/nobody`)).status, 404);
    assert.equal((await fetch(`${base}/api/residents/codex/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) })).status, 403);
    assert.equal((await fetch(`${base}/api/residents/codex/chat`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: JSON.stringify({ body: 'hi' }) })).status, 403);
    const sent = await fetch(`${base}/api/residents/codex/chat`, { method: 'POST', headers: H, body: JSON.stringify({ body: 'hi' }) });
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).message.status, 'undelivered');
    assert.equal((await fetch(`${base}/api/residents/codex/chat`, { method: 'POST', headers: H, body: JSON.stringify({ body: '' }) })).status, 400);
    const after = await (await fetch(`${base}/api/residents/codex`)).json();
    assert.equal(after.chat.messages.length, 1);
  } finally {
    server.close();
    village.close();
  }
});

test('the server never registers test adapters or canned replies', () => {
  const files = ['server', 'integrations', 'web/src'].flatMap((d) => fs.readdirSync(path.join(PROJECT_ROOT, d), { recursive: true }).map((f) => path.join(PROJECT_ROOT, d, String(f)))).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /FixtureAdapter|from ['"][^'"]*tests\//, `${path.relative(PROJECT_ROOT, f)} must not use test fixtures`);
  }
  const main = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'main.ts'), 'utf8');
  assert.match(main, /createRuntimeAdapters\(/, 'the server builds its adapters with the shared factory');
  const factory = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'lib', 'runtimes.ts'), 'utf8');
  const registered = [...factory.matchAll(/new (\w+Adapter)\(/g)].map((m) => m[1]);
  assert.deepEqual(registered, ['CodexAdapter', 'AnthropicAdapter', 'OpenAIAdapter'], 'only real runtime adapters are registered');
});
