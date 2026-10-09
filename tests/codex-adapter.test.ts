// Codex adapter against a protocol-faithful fake app-server (tests/fixtures/fake-codex-app-server.ts).
// These prove the adapter's handling; a real Codex conversation is verified separately on a signed-in machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../integrations/adapters/codex.ts';
import { CODEX_DISABLED_FEATURES, codexLaunchArgs } from '../integrations/runtime-config.ts';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import type { Village } from '../server/lib/app.ts';
import { loadRegistries, parseResident } from '../server/lib/registry.ts';
import { which } from '../integrations/util.ts';
import { makeVillage, tmpDir } from './helpers.ts';

const FAKE = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-codex-app-server.ts');
const ALL = ['git', 'node', 'codex', 'openai-api', 'anthropic-api', 'claude-agent-sdk', 'openai-agents', 'ollama', 'blender', 'unreal', 'aura'];
const allReady = () => ALL.map((id) => ({ id, name: id, status: 'connected' as const, ready: true, version: null, summary: 'ok', checks: [], costs: '' }));

function codexVillage(mode: string, o: { approvalTimeoutMs?: number; chatReplyTimeoutMs?: number; registries?: any; platform?: NodeJS.Platform; winSandbox?: string } = {}) {
  const logDir = tmpDir('virelune-fakecodex-');
  const log = path.join(logDir, 'log.jsonl');
  const made = makeVillage({
    registries: o.registries,
    chatReplyTimeoutMs: o.chatReplyTimeoutMs,
    adapters: (v: Village) => [
      new CodexAdapter({
        dataDir: v.config.dataDir,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log, FAKE_WIN_SANDBOX: o.winSandbox, OPENAI_API_KEY: 'sk-test-must-not-reach-codex', ANTHROPIC_API_KEY: 'sk-ant-test', CODEX_API_KEY: 'also-not' },
        events: v.events,
        approvals: v.approvals,
        issueToken: (id) => v.gateway.issueToken(id),
        revokeToken: (id) => v.gateway.revokeToken(id),
        gatewayUrl: () => 'http://127.0.0.1:4317',
        workspaceFor: (id) => v.workspaceFor(id),
        command: process.execPath,
        commandArgs: ['--disable-warning=ExperimentalWarning', FAKE],
        approvalTimeoutMs: o.approvalTimeoutMs,
        platform: o.platform,
      }),
    ],
  });
  made.village.setDoctorResultsForTest(allReady());
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...made, entries };
}

async function settle(village: Village, resident = 'codex', ms = 15_000) {
  const t0 = Date.now();
  while (village.chat.isBusy(resident) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 15));
  await new Promise((r) => setTimeout(r, 10));
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('Codex replies stream into the chat, are saved, and the thread is resumed for the next message', async () => {
  const { village, entries } = codexVillage('ok');
  const deltas: string[] = [];
  village.events.subscribeEphemeral((name, d) => name === 'chat.delta' && deltas.push(String(d.text)));
  try {
    village.chat.send('codex', 'Hi Codex');
    await settle(village);
    let msgs = village.chat.list('codex');
    assert.deepEqual(msgs.map((m) => [m.role, m.status]), [['human', 'answered'], ['resident', 'complete']]);
    assert.equal(msgs[1].body, 'Hello from the fake Codex: Hi Codex');
    assert.equal(deltas.join(''), 'Hello from the fake Codex: Hi Codex', 'text streamed live as it arrived');
    const types = village.events.list().filter((e) => e.runId === msgs[1].runId).map((e) => e.type);
    assert.deepEqual(types, ['run.started', 'chat.reply_completed', 'run.finished']);
    village.chat.send('codex', 'Second message');
    await settle(village);
    msgs = village.chat.list('codex');
    assert.equal(msgs[3].body, 'Hello from the fake Codex: Second message');
    const reqs = entries().filter((e) => e.type === 'request').map((e) => e.method);
    assert.deepEqual(reqs, ['initialize', 'initialized', 'mcpServerStatus/list', 'experimentalFeature/list', 'account/read', 'thread/start', 'turn/start', 'account/read', 'thread/resume', 'turn/start']);
    const resume = entries().find((e) => e.method === 'thread/resume');
    assert.equal(resume.params.threadId, 'thr_1', 'the same Codex thread continues the conversation');
    assert.equal(entries().filter((e) => e.type === 'start').length, 1, 'one long-lived app-server per resident');
  } finally {
    village.close();
  }
});

test('Codex runs isolated: village Codex home, no API keys, gateway token only in its environment, sandboxed thread', async () => {
  const { village, entries } = codexVillage('ok');
  try {
    village.chat.send('codex', 'Where are you?');
    await settle(village);
    const start = entries().find((e) => e.type === 'start');
    assert.equal(start.env.CODEX_HOME, path.join(village.config.dataDir, 'runtime', 'codex-home'));
    assert.equal(start.env.OPENAI_API_KEY, false, 'OpenAI key removed');
    assert.equal(start.env.ANTHROPIC_API_KEY, false, 'Anthropic key removed');
    assert.equal(start.env.CODEX_API_KEY, false, 'Codex API key removed');
    assert.equal(start.env.token, true, 'gateway token passed in the environment');
    assert.deepEqual(start.argv.slice(start.argv.indexOf('app-server')), codexLaunchArgs('http://127.0.0.1:4317/mcp/codex'));
    for (const f of CODEX_DISABLED_FEATURES) assert.ok(start.argv.includes(`features.${f}=false`), `feature ${f} switched off on the command line`);
    assert.ok(!start.argv.some((a: string) => /sk-|token/i.test(a.replace('mcp_servers', ''))), 'no secrets on the command line');
    const thread = entries().find((e) => e.method === 'thread/start').params;
    assert.equal(thread.sandbox, 'workspace-write');
    assert.equal(thread.approvalPolicy, 'untrusted');
    assert.equal(thread.cwd, village.workspaceFor('codex'));
    assert.match(thread.developerInstructions, /You are Codex, a resident of Virelune Agent Village/);
    assert.ok(village.workspaceFor('codex').startsWith(village.config.dataDir), 'tests never touch a real sandbox clone');
    const toml = fs.readFileSync(path.join(village.config.dataDir, 'runtime', 'codex-home', 'config.toml'), 'utf8');
    assert.equal((toml.match(/\[mcp_servers\./g) ?? []).length, 1, 'the only MCP server is the village gateway');
  } finally {
    village.close();
  }
});

test('failed sign-in: no login, or an API-key login (paid per token), is refused before any turn starts', async () => {
  for (const [mode, pattern] of [['nologin', /not signed in for the village.*npm run codex:login/], ['apikey', /API key \(billed per token\).*will not start paid usage/]] as const) {
    const { village, entries } = codexVillage(mode);
    try {
      village.chat.send('codex', 'Hello?');
      await settle(village);
      const msgs = village.chat.list('codex');
      assert.equal(msgs[1].status, 'failed');
      assert.match(msgs[1].reason!, pattern);
      assert.equal(entries().filter((e) => e.method === 'turn/start').length, 0, `${mode}: no model request was made`);
      assert.ok(village.events.list().some((e) => e.type === 'run.failed'));
    } finally {
      village.close();
    }
  }
});

test('Codex turn failures and crashes are failures, and the next message starts a fresh app-server', async () => {
  {
    const { village } = codexVillage('fail');
    try {
      village.chat.send('codex', 'Do it');
      await settle(village);
      const m = village.chat.list('codex')[1];
      assert.equal(m.status, 'failed');
      assert.match(m.reason!, /401 Unauthorized/);
    } finally {
      village.close();
    }
  }
  {
    const { village, entries } = codexVillage('crash');
    try {
      village.chat.send('codex', 'Crash please');
      await settle(village);
      const m = village.chat.list('codex')[1];
      assert.equal(m.status, 'failed');
      assert.match(m.reason!, /Codex stopped unexpectedly/);
      assert.equal(m.body, 'Starting', 'partial text kept, marked failed');
      village.chat.send('codex', 'Again');
      await settle(village);
      assert.equal(entries().filter((e) => e.type === 'start').length, 2, 'a new app-server was started');
    } finally {
      village.close();
    }
  }
  {
    const { village } = codexVillage('startup-crash');
    try {
      village.chat.send('codex', 'Hi');
      await settle(village);
      const m = village.chat.list('codex')[1];
      assert.equal(m.status, 'failed');
      assert.match(m.reason!, /did not start.*could not load the village Codex home/);
    } finally {
      village.close();
    }
  }
});

test('on Windows, Codex only works once its sandbox is set up', async () => {
  for (const [state, ok] of [['notConfigured', false], ['ready', true]] as const) {
    const { village, entries } = codexVillage('ok', { platform: 'win32', winSandbox: state });
    try {
      village.chat.send('codex', 'Hi from Windows');
      await settle(village);
      const m = village.chat.list('codex')[1];
      assert.equal(m.status, ok ? 'complete' : 'failed', state);
      if (!ok) {
        assert.match(m.reason!, /Windows sandbox is not set up.*npm run codex:sandbox-setup/);
        assert.equal(entries().filter((e) => e.method === 'turn/start').length, 0);
      }
    } finally {
      village.close();
    }
  }
});

test('Codex CLI missing: a clear failure, never a fallback', async () => {
  const { village } = makeVillage({
    adapters: (v) => [new CodexAdapter({ dataDir: v.config.dataDir, env: { PATH: tmpDir() }, events: v.events, approvals: v.approvals, issueToken: (id) => v.gateway.issueToken(id), revokeToken: (id) => v.gateway.revokeToken(id), gatewayUrl: () => 'http://127.0.0.1:1', workspaceFor: (id) => v.workspaceFor(id) })],
  });
  village.setDoctorResultsForTest(allReady());
  try {
    village.chat.send('codex', 'Hi');
    await settle(village);
    const m = village.chat.list('codex')[1];
    assert.equal(m.status, 'failed');
    assert.match(m.reason!, /Codex CLI not found/);
  } finally {
    village.close();
  }
});

test('stopping a reply interrupts the Codex turn; a stuck reply times out', async () => {
  {
    const { village, entries } = codexVillage('hang');
    try {
      village.chat.send('codex', 'Think forever');
      await waitFor(() => village.chat.partial('codex')?.text === 'Thinking');
      village.chat.stop('codex');
      await settle(village);
      const m = village.chat.list('codex')[1];
      assert.equal(m.status, 'stopped');
      assert.equal(m.body, 'Thinking');
      assert.ok(entries().some((e) => e.method === 'turn/interrupt'), 'Codex was told to interrupt the turn');
      assert.ok(village.events.list().some((e) => e.type === 'run.interrupted'));
    } finally {
      village.close();
    }
  }
  {
    const { village } = codexVillage('hang', { chatReplyTimeoutMs: 400 });
    try {
      village.chat.send('codex', 'Think forever');
      await settle(village);
      const m = village.chat.list('codex')[1];
      assert.equal(m.status, 'failed');
      assert.match(m.reason!, /No reply within/);
    } finally {
      village.close();
    }
  }
});

test('file changes need your approval: approved writes land in the workspace, declined ones do not', async () => {
  for (const decision of ['approve', 'deny'] as const) {
    const { village, entries } = codexVillage('approval-file');
    try {
      village.chat.send('codex', 'Create hello.txt');
      const a = await waitFor(() => village.approvals.list('pending')[0]);
      assert.equal(a.kind, 'codex_file_change');
      assert.equal(a.risk, 'write');
      assert.equal(a.resident, 'codex');
      assert.match(a.summary, /wants to change 1 file: add hello\.txt/);
      assert.equal((a.detail as any).changes[0].diff, '+Hello from the village sandbox\n');
      village.approvals.decide(a.id, decision, 'human');
      await settle(village);
      const file = path.join(village.workspaceFor('codex'), 'hello.txt');
      assert.equal(fs.existsSync(file), decision === 'approve');
      assert.equal(entries().find((e) => e.type === 'decision').decision, decision === 'approve' ? 'accept' : 'decline');
      assert.equal(village.chat.list('codex')[1].status, 'complete');
      if (decision === 'approve') assert.ok(village.events.list().some((e) => e.type === 'runtime.files_changed'));
    } finally {
      village.close();
    }
  }
});

test('unanswered approvals expire as declined', async () => {
  const { village, entries } = codexVillage('approval-command', { approvalTimeoutMs: 150 });
  try {
    village.chat.send('codex', 'Run the tests');
    await settle(village);
    assert.equal(entries().find((e) => e.type === 'decision').decision, 'decline');
    assert.equal(village.approvals.list()[0].status, 'expired');
  } finally {
    village.close();
  }
});

test('workspace boundary: commands and file changes outside the workspace are declined without asking', async () => {
  for (const mode of ['approval-command-outside', 'approval-file-outside']) {
    const { village, entries } = codexVillage(mode);
    try {
      village.chat.send('codex', 'Escape the sandbox');
      await settle(village);
      assert.equal(entries().find((e) => e.type === 'decision').decision, 'decline', mode);
      assert.equal(village.approvals.list().length, 0, 'not even offered to the human');
      assert.ok(village.events.list().some((e) => e.type === 'runtime.request_declined'));
      assert.equal(fs.existsSync(path.resolve(village.workspaceFor('codex'), '..', 'escape.txt')), false);
    } finally {
      village.close();
    }
  }
});

test('extra sandbox permissions are never granted', async () => {
  const { village, entries } = codexVillage('permissions');
  try {
    village.chat.send('codex', 'Need network');
    await settle(village);
    assert.deepEqual(entries().find((e) => e.type === 'decision').response, { permissions: {}, scope: 'turn' });
  } finally {
    village.close();
  }
});

test('several residents talk to Codex at once, each with its own process, token, thread and history', async () => {
  const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
  // A second Codex-runtime resident, for this test only (the real village has one Codex).
  const twin = parseResident({ id: 'codex-twin', displayName: 'Codex Twin', role: 'test', capabilities: ['t'], runtime: 'codex-app-server', provider: 'chatgpt-plan', building: 'engineering-forge', appearance: { lineage: 'codex', color: '#e8890c' }, requires: ['codex'], focus: true, permissions: 'restricted' });
  reg.residents.set('codex-twin', twin.value!);
  const { village, entries } = codexVillage('ok', { registries: reg });
  try {
    village.chat.send('codex', 'Message for Codex');
    village.chat.send('codex-twin', 'Message for the twin');
    await settle(village, 'codex');
    await settle(village, 'codex-twin');
    assert.equal(village.chat.list('codex')[1].body, 'Hello from the fake Codex: Message for Codex');
    assert.equal(village.chat.list('codex-twin')[1].body, 'Hello from the fake Codex: Message for the twin');
    const starts = entries().filter((e) => e.type === 'start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((s) => s.argv.find((a: string) => a.startsWith('mcp_servers.village.url='))).sort(), ['mcp_servers.village.url="http://127.0.0.1:4317/mcp/codex"', 'mcp_servers.village.url="http://127.0.0.1:4317/mcp/codex-twin"']);
  } finally {
    village.close();
  }
});

test('the real server registers the Codex adapter, and it needs a passing doctor check like everyone else', () => {
  const { village } = makeVillage({ adapters: (v) => [new CodexAdapter({ dataDir: v.config.dataDir, env: {}, events: v.events, approvals: v.approvals, issueToken: () => 'x', revokeToken: () => {}, gatewayUrl: () => 'http://127.0.0.1:1', workspaceFor: (id) => v.workspaceFor(id) })] });
  try {
    assert.match(village.chat.deliveryBlocker('codex')!, /not checked yet/, 'no doctor run: not deliverable');
    village.setDoctorResultsForTest(allReady().map((r) => (r.id === 'codex' ? { ...r, status: 'installed' as const, ready: false, summary: 'Codex is installed but not signed in.' } : r)));
    assert.match(village.chat.deliveryBlocker('codex')!, /not signed in/);
    village.setDoctorResultsForTest(allReady());
    assert.equal(village.chat.deliveryBlocker('codex'), null);
    const codexUnreal = village.residents().find((r) => r.id === 'codex')!.profiles.find((p) => p.id === 'codex-unreal')!;
    assert.equal(codexUnreal.status, 'disconnected', 'Codex in Unreal is not unlocked by connecting Codex');
    assert.match(codexUnreal.reasons[0], /individual verification/);
  } finally {
    village.close();
  }
});

// Real Codex CLI (skipped when it is not installed): with an empty village Codex home it must refuse before
// any model request. This never uses your sign-in or your plan.
test('real Codex CLI: an unsigned village Codex home is refused before any turn', { skip: which('codex') ? false : 'Codex CLI not installed on this machine', timeout: 120_000 }, async () => {
  const { village } = makeVillage({
    adapters: (v) => [new CodexAdapter({ dataDir: v.config.dataDir, env: { ...process.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined }, events: v.events, approvals: v.approvals, issueToken: (id) => v.gateway.issueToken(id), revokeToken: (id) => v.gateway.revokeToken(id), gatewayUrl: () => 'http://127.0.0.1:1', workspaceFor: (id) => v.workspaceFor(id) })],
  });
  village.setDoctorResultsForTest(allReady());
  try {
    village.chat.send('codex', 'Hello real Codex');
    await settle(village, 'codex', 60_000);
    const m = village.chat.list('codex')[1];
    assert.equal(m.status, 'failed');
    assert.match(m.reason!, /not signed in for the village/);
  } finally {
    village.close();
  }
});
