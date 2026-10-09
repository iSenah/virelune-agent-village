// Paid API safeguards: per-resident "Allow paid use", off by default, enforced on the server, recorded in the log.
import assert from 'node:assert/strict';
import type http from 'node:http';
import { test } from 'node:test';
import { createServer } from '../server/lib/api.ts';
import type { Village } from '../server/lib/app.ts';
import type { AdapterContext, AgentAdapter } from '../server/lib/chat.ts';
import { makeVillage } from './helpers.ts';

const ALL = ['git', 'node', 'codex', 'openai-api', 'anthropic-api', 'claude-agent-sdk', 'openai-agents', 'ollama', 'blender', 'unreal', 'aura'];
const allReady = () => ALL.map((id) => ({ id, name: id, status: 'connected' as const, ready: true, version: null, summary: 'ok', checks: [], costs: '' }));

/** TEST-ONLY stand-in for a paid runtime. Counts calls so tests can prove no request was made. */
class PaidFixture implements AgentAdapter {
  runtimeKind: string;
  calls: AdapterContext[] = [];
  mode: 'ok' | 'hang' | 'check-twice' = 'ok';
  constructor(kind: string) {
    this.runtimeKind = kind;
  }
  async reply(ctx: AdapterContext) {
    this.calls.push(ctx);
    ctx.assertPaidAllowed(); // what real paid adapters do right before calling the provider
    if (this.mode === 'hang') {
      ctx.onDelta('partial');
      await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
    }
    if (this.mode === 'check-twice') {
      await new Promise((r) => setTimeout(r, 40));
      ctx.assertPaidAllowed(); // e.g. a second provider call in a tool loop
    }
    return { text: `paid fixture reply to ${ctx.message}` };
  }
}

function paidVillage(o: { dataDir?: string; env?: Record<string, string> } = {}) {
  const claude = new PaidFixture('anthropic-messages');
  const echo = new PaidFixture('openai-responses');
  const made = makeVillage({ adapters: [claude, echo], dataDir: o.dataDir, env: o.env });
  made.village.setDoctorResultsForTest(allReady());
  return { ...made, claude, echo };
}

async function settle(v: Village, id: string) {
  for (let i = 0; i < 300 && v.chat.isBusy(id); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 5));
}

test('paid use is off by default for every paid resident; plan-based and local residents need no switch', () => {
  const { village } = paidVillage();
  try {
    for (const id of ['claude', 'echo', 'claude-blender', 'claude-unreal']) {
      // claude-blender and claude-unreal are Claude's execution profiles: same Anthropic bill, Claude's switch.
      const b = village.billing.info(id);
      assert.equal(b.paid, true, id);
      assert.equal(b.kind, 'paid-api', id);
      assert.equal(b.allowed, false, `${id} must start with paid use off`);
      assert.match(b.charges, /nothing is sent until you allow paid use/);
    }
    for (const [id, kind] of [['codex', 'subscription'], ['codex-blender', 'subscription'], ['codex-unreal', 'subscription'], ['aura', 'subscription'], ['scribe', 'free-local'], ['gemini', 'none'], ['copilot', 'none'], ['deepseek', 'none']]) {
      const b = village.billing.info(id);
      assert.equal(b.paid, false, id);
      assert.equal(b.kind, kind, id);
      assert.equal(village.billing.blocker(id), null);
    }
    assert.match(village.billing.info('codex').charges, /ChatGPT plan/);
    assert.match(village.billing.info('scribe').charges, /free/);
    assert.throws(() => village.billing.set('codex', true, true), /not billed per use/, 'Codex stays ChatGPT-plan only: no paid switch');
  } finally {
    village.close();
  }
});

test('a connected paid resident with paid use off gets no request at all, and the refusal is logged', async () => {
  const { village, claude } = paidVillage();
  try {
    assert.match(village.chat.deliveryBlocker('claude')!, /Paid use is off for Claude/);
    const m = village.chat.send('claude', 'Hello Claude');
    await settle(village, 'claude');
    assert.equal(m.status, 'undelivered');
    assert.match(m.reason!, /Paid use is off for Claude.*Anthropic API.*Allow paid use/);
    assert.equal(claude.calls.length, 0, 'the provider adapter was never called');
    assert.equal(village.chat.list('claude').length, 1, 'no reply of any kind');
    const denied = village.events.list().filter((e) => e.type === 'billing.request_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].payload.resident, 'claude');
    assert.equal(denied[0].payload.purpose, 'chat reply');
    assert.equal(denied[0].payload.messageId, m.id);
    assert.ok(!village.events.list().some((e) => e.type === 'run.started'));
  } finally {
    village.close();
  }
});

test('allowing paid use needs an explicit acknowledgement, is logged, and only then are requests made', async () => {
  const { village, claude } = paidVillage();
  try {
    assert.throws(() => village.billing.set('claude', true, undefined), /acknowledge/);
    assert.throws(() => village.billing.set('claude', 'yes' as any, true), /true or false/);
    assert.equal(village.billing.info('claude').allowed, false);
    const b = village.billing.set('claude', true, true, 'human');
    assert.equal(b.allowed, true);
    assert.equal(b.changedBy, 'human');
    assert.match(b.charges, /Each reply is billed to your Anthropic API account/);
    const changed = village.events.list().filter((e) => e.type === 'billing.paid_use_changed');
    assert.deepEqual(changed.map((e) => [e.payload.resident, e.payload.allowed, e.actor]), [['claude', true, 'human']]);
    village.chat.send('claude', 'Now you may answer');
    await settle(village, 'claude');
    assert.equal(claude.calls.length, 1);
    assert.equal(village.chat.list('claude')[1].body, 'paid fixture reply to Now you may answer');
    village.billing.set('claude', true, true);
    assert.equal(village.events.list().filter((e) => e.type === 'billing.paid_use_changed').length, 1, 'no event when nothing changes');
  } finally {
    village.close();
  }
});

test('each resident has its own switch: allowing Claude allows only Claude (and his own Blender/Unreal profiles)', async () => {
  const { village, echo } = paidVillage();
  try {
    assert.throws(() => village.billing.set('claude-blender', true, true), /follows Claude's paid-use switch/, 'profiles have no switch of their own');
    village.billing.set('claude', true, true);
    for (const id of ['claude-blender', 'claude-unreal']) assert.equal(village.billing.info(id).allowed, true, `${id} follows Claude`);
    assert.equal(village.billing.info('echo').allowed, false);
    village.billing.set('claude', false, false);
    for (const id of ['claude-blender', 'claude-unreal']) assert.equal(village.billing.info(id).allowed, false, `${id} is off with Claude`);
    assert.match(village.billing.blocker('claude-blender')!, /Paid use is off for Claude\. Claude · Blender uses the Anthropic API/);
    village.billing.set('claude', true, true);
    const m = village.chat.send('echo', 'Hello Echo');
    await settle(village, 'echo');
    assert.equal(m.status, 'undelivered');
    assert.match(m.reason!, /Paid use is off for Echo.*OpenAI API/);
    assert.equal(echo.calls.length, 0);
  } finally {
    village.close();
  }
});

test('the switch survives a restart, in both directions, and nothing turns it on by itself', () => {
  const first = paidVillage({ env: { PATH: process.env.PATH ?? '', VILLAGE_ALLOW_PAID_USE: 'true', ALLOW_PAID_USE: '1' } });
  assert.equal(first.village.billing.info('claude').allowed, false, 'environment variables cannot enable paid use');
  first.village.billing.set('claude', true, true);
  first.village.billing.set('echo', true, true);
  first.village.billing.set('echo', false, false);
  first.village.close();
  const second = paidVillage({ dataDir: first.dataDir });
  try {
    assert.equal(second.village.billing.info('claude').allowed, true, 'allowed stays allowed after a restart');
    assert.equal(second.village.billing.info('echo').allowed, false, 'switched off stays off after a restart');
    // A damaged setting fails safe.
    second.village.db.prepare("UPDATE settings SET value_json = '{not json' WHERE key = 'paid_use.claude'").run();
    assert.equal(second.village.billing.info('claude').allowed, false);
  } finally {
    second.village.close();
  }
});

test('switching paid use off stops a paid reply in progress immediately', async () => {
  const { village, claude } = paidVillage();
  try {
    village.billing.set('claude', true, true);
    claude.mode = 'hang';
    village.chat.send('claude', 'Take your time');
    for (let i = 0; i < 100 && village.chat.partial('claude')?.text !== 'partial'; i++) await new Promise((r) => setTimeout(r, 10));
    village.billing.set('claude', false, false);
    await settle(village, 'claude');
    const reply = village.chat.list('claude')[1];
    assert.equal(reply.status, 'stopped');
    assert.match(reply.reason!, /switching paid use off/);
    assert.ok(village.events.list().some((e) => e.type === 'run.interrupted'));
  } finally {
    village.close();
  }
});

test('adapters re-check before each provider call: a switch-off between calls blocks the next one', async () => {
  const { village, claude } = paidVillage();
  try {
    village.billing.set('claude', true, true);
    claude.mode = 'check-twice';
    village.chat.send('claude', 'Two calls');
    await new Promise((r) => setTimeout(r, 10));
    // Revoke behind the chat service's back (as if from another tab) without stopping the reply first.
    village.billing.onRevoked = () => {};
    village.billing.set('claude', false, false);
    await settle(village, 'claude');
    const reply = village.chat.list('claude')[1];
    assert.equal(reply.status, 'failed');
    assert.match(reply.reason!, /Paid use is off for Claude/);
    assert.ok(village.events.list().some((e) => e.type === 'billing.request_denied' && e.payload.runId));
  } finally {
    village.close();
  }
});

test('emergency stop: switch paid use off for everyone at once', () => {
  const { village } = paidVillage();
  try {
    village.billing.set('claude', true, true);
    village.billing.set('echo', true, true);
    assert.deepEqual(village.billing.disableAll().sort(), ['claude', 'echo']);
    for (const id of ['claude', 'echo']) assert.equal(village.billing.info(id).allowed, false);
    assert.deepEqual(village.billing.disableAll(), []);
  } finally {
    village.close();
  }
});

test('paid-use API: same-origin only, acknowledgement required, and keys never reach the browser', async () => {
  // Built at runtime so the repository's own secret scanner does not flag this test file.
  const SECRET_A = ['sk', 'ant', 'api03', 'TESTSECRETVALUE', 'a'.repeat(24)].join('-');
  const SECRET_O = ['sk', 'proj', 'TESTSECRETVALUE', 'b'.repeat(24)].join('-');
  const { village } = paidVillage({ env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: SECRET_A, OPENAI_API_KEY: SECRET_O } });
  const server: http.Server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const H = { 'content-type': 'application/json', 'x-village-client': '1' };
  const put = (id: string, body: unknown, headers: Record<string, string> = H) => fetch(`${base}/api/residents/${id}/paid-use`, { method: 'PUT', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await put('claude', { allowed: true, acknowledge: true }, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await put('claude', { allowed: true, acknowledge: true }, { ...H, origin: 'https://evil.example' })).status, 403);
    assert.equal((await put('claude', { allowed: true })).status, 400, 'no acknowledgement, no paid use');
    assert.equal((await put('codex', { allowed: true, acknowledge: true })).status, 400, 'Codex has no paid switch');
    assert.equal((await put('nobody', { allowed: true, acknowledge: true })).status, 404);
    const on = await put('claude', { allowed: true, acknowledge: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).billing.allowed, true);
    const detail = await (await fetch(`${base}/api/residents/claude`)).json();
    assert.equal(detail.billing.allowed, true);
    assert.equal(detail.billing.providerName, 'Anthropic API');
    assert.equal(detail.resident.billing.allowed, true);
    const off = await fetch(`${base}/api/paid-use/disable-all`, { method: 'POST', headers: H });
    assert.deepEqual((await off.json()).disabled, ['claude']);
    // Credentials stay on the server.
    for (const url of ['/api/state', '/api/residents/claude', '/api/residents/echo', '/api/events?after=0&limit=5000', '/api/doctor', '/api/layout', '/', '/src/main.ts']) {
      const text = await (await fetch(base + url)).text();
      assert.ok(!text.includes('TESTSECRETVALUE'), `${url} leaked an API key`);
    }
    for (const url of ['/.env', '/../.env', '/%2e%2e/.env', '/data/village.db']) assert.notEqual((await fetch(base + url)).status, 200, `${url} must not be served`);
  } finally {
    server.close();
    village.close();
  }
});
