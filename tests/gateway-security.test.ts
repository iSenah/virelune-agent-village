// Security boundary tests for the Tool Gateway. Uses a test-only fixture MCP server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { StdioRpcClient } from '../integrations/jsonrpc-stdio.ts';
import { CODEX_DISABLED_FEATURES, prepareCodexLaunch, GATEWAY_TOKEN_ENV } from '../integrations/runtime-config.ts';
import { which } from '../integrations/util.ts';
import { createServer } from '../server/lib/api.ts';
import type { Village } from '../server/lib/app.ts';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { GATEWAY_ERRORS } from '../server/lib/gateway.ts';
import { loadRegistries, parseResident, parseToolServer, type Registries } from '../server/lib/registry.ts';
import { FIXTURE_SERVER, makeVillage } from './helpers.ts';

function testRegistries(): Registries {
  const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
  const fixture = parseToolServer({ id: 'fixture', displayName: 'Fixture tools', kind: 'mcp', transport: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', FIXTURE_SERVER], exclusive: true, leaseSeconds: 60, risk: { read_note: 'read', write_note: 'write', run_code: 'exec', call_log: 'read' } });
  assert.ok(fixture.value, fixture.errors.join());
  reg.tools.set('fixture', fixture.value!);
  const mk = (id: string, tools: any[]) => {
    const r = parseResident({ id, displayName: id, role: 'test', capabilities: ['t'], runtime: 'codex-app-server', provider: 'chatgpt-plan', building: 'engineering-forge', appearance: { lineage: 'codex', color: '#e8890c' }, requires: [], permissions: 'restricted', tools });
    assert.ok(r.value, r.errors.join());
    reg.residents.set(id, r.value!);
  };
  mk('alpha', [{ server: 'fixture', allow: ['risk:read'], ask: ['risk:write', 'risk:exec'] }]);
  mk('beta', [{ server: 'fixture', allow: ['risk:read'], ask: [] }]);
  mk('gamma', []);
  mk('sleeper', [{ server: 'fixture', allow: ['risk:read'], ask: [] }]);
  return reg;
}

let village: Village;
let server: http.Server;
let base: string;
const tokens: Record<string, string> = {};

before(async () => {
  ({ village } = makeVillage({ registries: testRegistries(), isResidentActive: (id) => id !== 'sleeper', approvalTimeoutMs: 1500, env: { PATH: process.env.PATH } }));
  server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const id of ['alpha', 'beta', 'gamma', 'sleeper']) tokens[id] = village.gateway.issueToken(id);
});

after(() => {
  server.close();
  village.close();
});

let rpcId = 1;
async function mcp(resident: string, method: string, params: any = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp/${resident}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[resident] ?? 'none'}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function callLog(): Promise<string[]> {
  // The audit call takes the exclusive lease like any other call, so hand it back afterwards.
  const holder = village.db.prepare("SELECT resident FROM leases WHERE tool_server = 'fixture'").get() as any;
  if (holder) village.gateway.releaseLeases(holder.resident);
  const r = await mcp('beta', 'tools/call', { name: 'fixture__call_log', arguments: {} });
  village.gateway.releaseLeases('beta');
  if (holder) village.gateway.acquireLease(village.registries.tools.get('fixture')!, holder.resident);
  return JSON.parse(r.body.result.content[0].text);
}

test('no token, a wrong token, or another resident\'s token is rejected', async () => {
  const noAuth = await fetch(`${base}/mcp/alpha`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(noAuth.status, 401);
  assert.equal((await mcp('alpha', 'tools/list', {}, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await mcp('beta', 'tools/list', {}, { authorization: `Bearer ${tokens.alpha}` })).status, 401);
  assert.equal((await mcp('nobody', 'tools/list')).status, 401);
  assert.ok(village.events.list(0).some((e) => e.type === 'tool.auth_failed'));
});

test('inactive (disconnected) residents cannot use the gateway even with a valid token', async () => {
  assert.equal((await mcp('sleeper', 'tools/list')).status, 403);
});

test('browser requests (with an Origin header) are refused', async () => {
  assert.equal((await mcp('alpha', 'tools/list', {}, { origin: 'http://127.0.0.1:4317' })).status, 403);
  assert.equal((await mcp('alpha', 'tools/list', {}, { origin: 'https://evil.example' })).status, 403);
});

test('a revoked token stops working', async () => {
  const t = village.gateway.issueToken('gamma');
  village.gateway.revokeToken('gamma');
  const r = await mcp('gamma', 'tools/list', {}, { authorization: `Bearer ${t}` });
  assert.equal(r.status, 401);
  tokens.gamma = village.gateway.issueToken('gamma');
});

test('tools/list shows only granted tools; unclassified tools are never listed', async () => {
  const names = async (id: string) => (await mcp(id, 'tools/list')).body.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(await names('alpha'), ['fixture__call_log', 'fixture__read_note', 'fixture__run_code', 'fixture__write_note']);
  assert.deepEqual(await names('beta'), ['fixture__call_log', 'fixture__read_note']);
  assert.deepEqual(await names('gamma'), []);
  const alphaTools = (await mcp('alpha', 'tools/list')).body.result.tools;
  assert.match(alphaTools.find((t: any) => t.name === 'fixture__run_code').description, /Needs your approval/);
});

test('calling an unclassified or ungranted tool is denied and never reaches the tool server', async () => {
  const secret = await mcp('alpha', 'tools/call', { name: 'fixture__secret_tool', arguments: {} });
  assert.equal(secret.body.error.code, GATEWAY_ERRORS.DENIED);
  const write = await mcp('beta', 'tools/call', { name: 'fixture__write_note', arguments: { name: 'x', text: 'y' } });
  assert.equal(write.body.error.code, GATEWAY_ERRORS.DENIED);
  const gamma = await mcp('gamma', 'tools/call', { name: 'fixture__read_note', arguments: { name: 'welcome' } });
  assert.equal(gamma.body.error.code, GATEWAY_ERRORS.DENIED);
  const other = await mcp('alpha', 'tools/call', { name: 'blender-lab__execute_code', arguments: {} });
  assert.equal(other.body.error.code, GATEWAY_ERRORS.DENIED);
  const log = await callLog();
  assert.ok(!log.includes('secret_tool') && !log.includes('write_note'), `fixture executed: ${log.join(',')}`);
  assert.ok(village.events.list(0).filter((e) => e.type === 'tool.call_denied').length >= 4);
});

test('read tools run immediately when granted', async () => {
  const r = await mcp('alpha', 'tools/call', { name: 'fixture__read_note', arguments: { name: 'welcome' } });
  assert.equal(r.body.result.content[0].text, 'hello from the fixture');
});

test('exec tools wait for approval: deny blocks, approve runs, silence expires', async () => {
  const pending = mcp('alpha', 'tools/call', { name: 'fixture__run_code', arguments: { code: 'print(1)' } });
  const a = await waitForApproval();
  village.approvals.decide(a.id, 'deny', 'human', 'test');
  assert.equal((await pending).body.error.code, GATEWAY_ERRORS.APPROVAL_DENIED);
  assert.ok(!(await callLog()).includes('run_code'));

  const pending2 = mcp('alpha', 'tools/call', { name: 'fixture__run_code', arguments: { code: 'print(2)' } });
  const b = await waitForApproval();
  assert.deepEqual(b.detail.arguments, { code: 'print(2)' }, 'the approval shows the exact arguments');
  village.approvals.decide(b.id, 'approve', 'human');
  assert.match((await pending2).body.result.content[0].text, /would run/);

  const pending3 = await mcp('alpha', 'tools/call', { name: 'fixture__run_code', arguments: { code: 'print(3)' } }); // nobody answers
  assert.equal(pending3.body.error.code, GATEWAY_ERRORS.APPROVAL_DENIED);
  assert.match(pending3.body.error.message, /expired/);
});

async function waitForApproval() {
  for (let i = 0; i < 100; i++) {
    const p = village.approvals.list('pending');
    if (p.length) return p[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no approval appeared');
}

test('exclusive tool servers need a lease: one resident at a time', async () => {
  // alpha used the fixture last and holds its lease; beta is refused until it is released.
  const busy = await mcp('beta', 'tools/call', { name: 'fixture__read_note', arguments: { name: 'welcome' } });
  assert.equal(busy.body.error.code, GATEWAY_ERRORS.BUSY);
  village.gateway.releaseLeases('alpha');
  const ok = await mcp('beta', 'tools/call', { name: 'fixture__read_note', arguments: { name: 'welcome' } });
  assert.ok(ok.body.result);
  village.gateway.releaseLeases('beta');
  const types = village.events.list(0).map((e) => e.type);
  assert.ok(types.includes('lease.acquired') && types.includes('lease.released'));
});

test('everything except tools is refused: resources, prompts, sampling, batches, bad names, huge arguments', async () => {
  for (const m of ['resources/list', 'resources/read', 'prompts/list', 'sampling/createMessage', 'tools/register']) assert.equal((await mcp('alpha', m)).body.error.code, GATEWAY_ERRORS.NO_METHOD, m);
  assert.equal((await mcp('alpha', 'tools/call', { name: '../fixture/read_note', arguments: {} })).body.error.code, GATEWAY_ERRORS.BAD_PARAMS);
  assert.equal((await mcp('alpha', 'tools/call', { name: 'fixture__read_note', arguments: 'rm -rf /' })).body.error.code, GATEWAY_ERRORS.BAD_PARAMS);
  assert.equal((await mcp('alpha', 'tools/call', { name: 'fixture__read_note', arguments: { name: 'x'.repeat(300_000) } })).body.error.code, GATEWAY_ERRORS.BAD_PARAMS);
  const batch = await fetch(`${base}/mcp/alpha`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.alpha}` }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]) });
  assert.equal(batch.status, 400);
});

test('the gateway refuses to be reached through a non-loopback Host header', async () => {
  // fetch() cannot override Host, so use a raw request (this is what a DNS-rebinding page would send).
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp/alpha`, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', authorization: `Bearer ${tokens.alpha}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
  assert.equal(status, 403);
});

test('Codex launch config: only the gateway, no API keys, token only in the environment', () => {
  const dataDir = fs.mkdtempSync(path.join(PROJECT_ROOT, '..', 'virelune-cfg-'));
  try {
    const launch = prepareCodexLaunch({ dataDir, residentId: 'codex', gatewayUrl: 'http://127.0.0.1:4317', token: 'tok123', baseEnv: { PATH: 'x', OPENAI_API_KEY: 'sk-should-not-pass', ANTHROPIC_API_KEY: 'nope' } });
    assert.equal(launch.env.OPENAI_API_KEY, undefined);
    assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(launch.env[GATEWAY_TOKEN_ENV], 'tok123');
    const toml = fs.readFileSync(path.join(launch.codexHome, 'config.toml'), 'utf8');
    assert.equal((toml.match(/\[mcp_servers\./g) ?? []).length, 1);
    assert.ok(!toml.includes('tok123'), 'the token must not be written to disk');
    assert.deepEqual(launch.args.slice(0, 3), ['app-server', '-c', 'mcp_servers.village.url="http://127.0.0.1:4317/mcp/codex"']);
    for (const f of CODEX_DISABLED_FEATURES) assert.ok(launch.args.includes(`features.${f}=false`), `${f} switched off`);
    assert.ok(!launch.args.join(' ').includes('tok123'), 'the token must not be on the command line');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Real Codex: launched exactly as the village will launch it, Codex must see ONLY the gateway,
// and through it only the tools its resident is granted. Skipped (not passed) when Codex is absent.
test('real Codex app-server sees only the village gateway and only granted tools', { skip: which('codex') ? false : 'Codex CLI not installed on this machine', timeout: 120_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(PROJECT_ROOT, '..', 'virelune-codex-'));
  const fakeUserHome = fs.mkdtempSync(path.join(PROJECT_ROOT, '..', 'virelune-userhome-'));
  // A "personal" Codex config with a rogue MCP server, as a user might have. It must NOT be loaded.
  fs.writeFileSync(path.join(fakeUserHome, 'config.toml'), `[mcp_servers.rogue]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["--disable-warning=ExperimentalWarning", ${JSON.stringify(FIXTURE_SERVER)}]\n`);
  const launch = prepareCodexLaunch({ dataDir, residentId: 'beta', gatewayUrl: base, token: tokens.beta, baseEnv: { ...process.env, CODEX_HOME: fakeUserHome } });
  const rpc = new StdioRpcClient(which('codex')!, launch.args, { env: launch.env });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'virelune-agent-village', title: null, version: '0.1.0' }, capabilities: null }, 30_000);
    rpc.notify('initialized');
    const status = await rpc.request('mcpServerStatus/list', {}, 90_000);
    const servers = status.data.map((s: any) => s.name);
    assert.deepEqual(servers, ['village'], `Codex loaded: ${servers.join(', ')}`);
    const tools = Object.keys(status.data[0].tools ?? {}).sort();
    assert.ok(tools.length > 0, `Codex got no tools from the gateway: ${JSON.stringify(status.data[0]).slice(0, 300)}`);
    assert.ok(tools.every((t) => /read_note|call_log/.test(t)), `unexpected tools visible to Codex: ${tools.join(', ')}`);
  } finally {
    rpc.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeUserHome, { recursive: true, force: true });
  }
});
