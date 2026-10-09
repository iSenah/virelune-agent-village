// Claude (Anthropic Messages API) and Echo (OpenAI Responses API) adapters.
// MOCK-BASED: these run against a local fake HTTP server that speaks the documented streaming formats.
// They prove the adapters' handling (streaming, saving, errors, stop, paid-use gating, key handling).
// They do NOT prove a live provider connection; that needs a real key and your permission to spend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AnthropicAdapter } from '../integrations/adapters/anthropic.ts';
import { OpenAIAdapter } from '../integrations/adapters/openai.ts';
import { createServer } from '../server/lib/api.ts';
import type { Village } from '../server/lib/app.ts';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { makeVillage } from './helpers.ts';

const ALL = ['git', 'node', 'codex', 'openai-api', 'anthropic-api', 'claude-agent-sdk', 'openai-agents', 'ollama', 'blender', 'unreal', 'aura'];
const allReady = () => ALL.map((id) => ({ id, name: id, status: 'connected' as const, ready: true, version: null, summary: 'ok', checks: [], costs: '' }));
// Built at runtime so the repository's secret scanner does not flag the test file.
const A_KEY = ['sk', 'ant', 'api03', 'FAKEKEYFORTESTS', 'x'.repeat(20)].join('-');
const O_KEY = ['sk', 'proj', 'FAKEKEYFORTESTS', 'y'.repeat(20)].join('-');

// ---------- fake provider ----------
type Req = { path: string; headers: http.IncomingHttpHeaders; body: any };
let requests: Req[] = [];
let scenario = 'ok';
let closedEarly = 0;
let base = '';
let fake: http.Server;

const sse = (res: http.ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

before(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    requests.push({ path: req.url ?? '', headers: req.headers, body });
    res.on('close', () => {
      if (!res.writableEnded) closedEarly++;
    });
    const anthropic = req.url === '/v1/messages';
    if (scenario === '401') return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify(anthropic ? { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } : { error: { message: 'Incorrect API key provided' } }));
    if (scenario === '429') return res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'rate limited' } }));
    if (scenario === '529') return res.writeHead(529, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Overloaded' } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const last = [...(anthropic ? body.messages : body.input)].pop()?.content ?? '';
    const words = ['Hello', ' from', ' the', ' fake', ' provider:', ` ${last}`];
    if (anthropic) {
      sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'ping', { type: 'ping' });
      for (const w of words) {
        await new Promise((r) => setTimeout(r, 3));
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } });
        if (scenario === 'stream-error' && w === ' the') {
          sse(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
          return res.end();
        }
        if (scenario === 'truncated' && w === ' fake') return res.end();
        if (scenario === 'hang' && w === ' from') return; // keep the connection open
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: scenario === 'max-tokens' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
      sse(res, 'message_stop', { type: 'message_stop' });
      return res.end();
    }
    sse(res, 'response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
    for (const w of words) {
      await new Promise((r) => setTimeout(r, 3));
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: w });
      if (scenario === 'failed' && w === ' the') {
        sse(res, 'response.failed', { type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'The model crashed' } } });
        return res.end();
      }
      if (scenario === 'hang' && w === ' from') return;
    }
    if (scenario === 'incomplete') sse(res, 'response.incomplete', { type: 'response.incomplete', response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
    else sse(res, 'response.completed', { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 12 } } });
    res.end();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as any).port}`;
});
after(() => fake.close());

function paidVillage(o: { anthropicKey?: string | null; openaiKey?: string | null; allow?: string[]; chatReplyTimeoutMs?: number } = {}) {
  requests = [];
  scenario = 'ok';
  closedEarly = 0;
  const env = { ANTHROPIC_API_KEY: o.anthropicKey === null ? undefined : (o.anthropicKey ?? A_KEY), OPENAI_API_KEY: o.openaiKey === null ? undefined : (o.openaiKey ?? O_KEY) };
  const made = makeVillage({ adapters: [new AnthropicAdapter({ env, baseUrl: base }), new OpenAIAdapter({ env, baseUrl: base })], chatReplyTimeoutMs: o.chatReplyTimeoutMs, env: { PATH: process.env.PATH, ...env } as any });
  made.village.setDoctorResultsForTest(allReady());
  for (const id of o.allow ?? ['claude', 'echo']) made.village.billing.set(id, true, true);
  return made;
}

async function settle(v: Village, id: string, ms = 10_000) {
  const t0 = Date.now();
  while (v.chat.isBusy(id) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 5));
}

test('Claude: streams a reply through the Messages API, saves it, and sends history, identity and the key correctly', async () => {
  const { village } = paidVillage();
  const deltas: string[] = [];
  village.events.subscribeEphemeral((n, d) => n === 'chat.delta' && d.resident === 'claude' && deltas.push(String(d.text)));
  try {
    village.chat.send('claude', 'Design a lantern');
    await settle(village, 'claude');
    const msgs = village.chat.list('claude');
    assert.deepEqual(msgs.map((m) => [m.role, m.status]), [['human', 'answered'], ['resident', 'complete']]);
    assert.equal(msgs[1].body, 'Hello from the fake provider: Design a lantern');
    assert.equal(deltas.join(''), msgs[1].body, 'streamed live');
    const r = requests[0];
    assert.equal(r.path, '/v1/messages');
    assert.equal(r.headers['x-api-key'], A_KEY);
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
    assert.equal(r.body.model, 'claude-sonnet-5-5');
    assert.equal(r.body.stream, true);
    assert.match(r.body.system, /You are Claude, a resident of Virelune Agent Village/);
    assert.match(r.body.system, /separate API instance/);
    assert.match(r.body.system, /no tools/);
    assert.equal(r.body.tools, undefined, 'no tools are offered in chat');
    village.chat.send('claude', 'Make it blue');
    await settle(village, 'claude');
    assert.deepEqual(requests[1].body.messages, [
      { role: 'user', content: 'Design a lantern' },
      { role: 'assistant', content: 'Hello from the fake provider: Design a lantern' },
      { role: 'user', content: 'Make it blue' },
    ]);
    assert.deepEqual(village.events.list().filter((e) => e.runId === msgs[1].runId).map((e) => e.type), ['run.started', 'chat.reply_completed', 'run.finished']);
  } finally {
    village.close();
  }
});

test('Echo: streams a reply through the Responses API with store: false and the separate-instance disclosure', async () => {
  const { village } = paidVillage();
  try {
    village.chat.send('echo', 'Plan the week');
    await settle(village, 'echo');
    const msgs = village.chat.list('echo');
    assert.equal(msgs[1].status, 'complete');
    assert.equal(msgs[1].body, 'Hello from the fake provider: Plan the week');
    const r = requests[0];
    assert.equal(r.path, '/v1/responses');
    assert.equal(r.headers.authorization, `Bearer ${O_KEY}`);
    assert.equal(r.body.model, 'gpt-5.6-terra');
    assert.equal(r.body.stream, true);
    assert.equal(r.body.store, false);
    assert.match(r.body.instructions, /You are Echo/);
    assert.match(r.body.instructions, /not the owner's ChatGPT/);
    assert.deepEqual(r.body.input, [{ role: 'user', content: 'Plan the week' }]);
  } finally {
    village.close();
  }
});

test('paid use off, or a missing key: no HTTP request is made at all', async () => {
  {
    const { village } = paidVillage({ allow: [] });
    try {
      village.chat.send('claude', 'Hi');
      village.chat.send('echo', 'Hi');
      await settle(village, 'claude');
      assert.equal(requests.length, 0);
      assert.equal(village.chat.list('claude')[0].status, 'undelivered');
      assert.equal(village.events.list().filter((e) => e.type === 'billing.request_denied').length, 2);
    } finally {
      village.close();
    }
  }
  {
    const { village } = paidVillage({ anthropicKey: null, openaiKey: null });
    try {
      village.chat.send('claude', 'Hi');
      await settle(village, 'claude');
      village.chat.send('echo', 'Hi');
      await settle(village, 'echo');
      assert.equal(requests.length, 0);
      assert.match(village.chat.list('claude')[1].reason!, /ANTHROPIC_API_KEY is not set/);
      assert.match(village.chat.list('echo')[1].reason!, /OPENAI_API_KEY is not set/);
    } finally {
      village.close();
    }
  }
});

test('provider errors are failures with a clear reason: bad key, rate limit, overload', async () => {
  for (const [sc, re] of [['401', /Anthropic rejected the API key \(HTTP 401\)/], ['429', /rate limit or spending limit/], ['529', /overloaded/]] as const) {
    const { village } = paidVillage();
    scenario = sc;
    try {
      village.chat.send('claude', 'Hi');
      await settle(village, 'claude');
      const m = village.chat.list('claude')[1];
      assert.equal(m.status, 'failed', sc);
      assert.match(m.reason!, re);
      assert.ok(!m.reason!.includes(A_KEY), 'the key never appears in an error');
    } finally {
      village.close();
    }
  }
  const { village } = paidVillage();
  scenario = '401';
  try {
    village.chat.send('echo', 'Hi');
    await settle(village, 'echo');
    assert.match(village.chat.list('echo')[1].reason!, /OpenAI rejected the API key/);
  } finally {
    village.close();
  }
});

test('mid-stream errors, truncated streams and failed responses are failures that keep the partial text', async () => {
  for (const [resident, sc, re, partial] of [
    ['claude', 'stream-error', /Anthropic stopped the reply: Overloaded/, 'Hello from the'],
    ['claude', 'truncated', /ended before the reply was complete/, 'Hello from the fake'],
    ['echo', 'failed', /The model crashed/, 'Hello from the'],
  ] as const) {
    const { village } = paidVillage();
    scenario = sc;
    try {
      village.chat.send(resident, 'Hi');
      await settle(village, resident);
      const m = village.chat.list(resident)[1];
      assert.equal(m.status, 'failed', sc);
      assert.match(m.reason!, re);
      assert.equal(m.body, partial);
    } finally {
      village.close();
    }
  }
});

test('length limits are marked in the saved reply', async () => {
  const { village } = paidVillage();
  try {
    scenario = 'max-tokens';
    village.chat.send('claude', 'Long please');
    await settle(village, 'claude');
    assert.match(village.chat.list('claude')[1].body, /\[Reply cut off at the length limit\.\]$/);
    scenario = 'incomplete';
    village.chat.send('echo', 'Long please');
    await settle(village, 'echo');
    assert.match(village.chat.list('echo')[1].body, /\[Reply incomplete: max_output_tokens\.\]$/);
  } finally {
    village.close();
  }
});

test('stop, switching paid use off, and timeouts close the provider connection', async () => {
  for (const how of ['stop', 'paid-off', 'timeout'] as const) {
    const { village } = paidVillage({ chatReplyTimeoutMs: how === 'timeout' ? 300 : undefined });
    scenario = 'hang';
    try {
      village.chat.send('claude', 'Take your time');
      for (let i = 0; i < 200 && village.chat.partial('claude')?.text !== 'Hello from'; i++) await new Promise((r) => setTimeout(r, 10));
      if (how === 'stop') village.chat.stop('claude');
      if (how === 'paid-off') village.billing.set('claude', false, false);
      await settle(village, 'claude');
      const m = village.chat.list('claude')[1];
      assert.equal(m.status, how === 'timeout' ? 'failed' : 'stopped', how);
      if (how === 'paid-off') assert.match(m.reason!, /switching paid use off/);
      if (how === 'timeout') assert.match(m.reason!, /No reply within/);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(closedEarly, 1, `${how}: the HTTP stream to the provider was closed`);
    } finally {
      village.close();
    }
  }
});

test('API keys never reach the browser, the event log or saved messages', async () => {
  const { village } = paidVillage();
  const server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    village.chat.send('claude', 'Hi');
    await settle(village, 'claude');
    scenario = '401';
    village.chat.send('echo', 'Hi');
    await settle(village, 'echo');
    for (const p of ['/api/state', '/api/residents/claude', '/api/residents/echo', '/api/events?after=0&limit=5000']) {
      const text = await (await fetch(url + p)).text();
      assert.ok(!text.includes('FAKEKEYFORTESTS'), `${p} leaked a key`);
    }
    const rows = JSON.stringify(village.db.prepare('SELECT * FROM chat_messages').all()) + JSON.stringify(village.db.prepare('SELECT * FROM events').all());
    assert.ok(!rows.includes('FAKEKEYFORTESTS'), 'no key in the database');
  } finally {
    server.close();
    village.close();
  }
});

test('the adapters cannot be pointed elsewhere from .env, and only the main residents use them', () => {
  for (const f of ['anthropic.ts', 'openai.ts']) {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'integrations', 'adapters', f), 'utf8');
    assert.doesNotMatch(src, /env\.[A-Z_]*BASE_URL|env\.[A-Z_]*API_BASE|env\.[A-Z_]*HOST/, `${f} must not read a base URL from the environment`);
  }
  const { village } = paidVillage();
  try {
    const rt = (id: string) => village.registries.runtimes.get(village.registries.residents.get(id)!.runtime)!.kind;
    assert.equal(rt('claude'), 'anthropic-messages');
    assert.equal(rt('echo'), 'openai-responses');
    assert.equal(rt('claude-blender'), 'claude-agent-sdk', 'variants keep the Agent SDK runtime (needs tools) and stay locked');
    assert.equal(rt('claude-unreal'), 'claude-agent-sdk');
    assert.equal(rt('scribe'), 'openai-agents');
    assert.match(village.chat.deliveryBlocker('claude-blender')!, /individual verification/);
  } finally {
    village.close();
  }
});
