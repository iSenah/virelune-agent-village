// TEST-ONLY stand-in for `codex app-server`, speaking the same JSON-RPC messages as codex-cli 0.161.0.
// Used to test the Codex adapter's handling of streaming, approvals, failures and isolation without a real
// Codex sign-in. It is never used by the village server (tests/chat.test.ts checks that).
// Behaviour is chosen with FAKE_CODEX_MODE; everything it receives is appended to FAKE_CODEX_LOG.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
const logFile = process.env.FAKE_CODEX_LOG;
const record = (o: unknown) => logFile && fs.appendFileSync(logFile, JSON.stringify(o) + '\n');

record({
  type: 'start',
  argv: process.argv.slice(2),
  pid: process.pid,
  cwd: process.cwd(),
  env: { CODEX_HOME: process.env.CODEX_HOME ?? null, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY, CODEX_API_KEY: !!process.env.CODEX_API_KEY, token: !!process.env.VILLAGE_GATEWAY_TOKEN },
});

// The plain CLI subcommands the doctor runs.
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  process.stdout.write(mode === 'nologin' ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
  process.exit(mode === 'nologin' ? 1 : 0);
}

// Like Codex 0.16x: built-in features are ON unless switched off with `-c features.<name>=false`, and with a
// ChatGPT sign-in the "apps" feature adds the built-in codex_apps MCP server.
const BUILTIN_FEATURES = ['apps', 'enable_mcp_apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'skill_mcp_dependency_install', 'shell_tool'];
const forcedOn = (process.env.FAKE_FEATURES_FORCED_ON ?? '').split(',').filter(Boolean);
const featureOn = (f: string) => forcedOn.includes(f) || !argv.includes(`features.${f}=false`);
const configToml = () => {
  try {
    return fs.readFileSync(path.join(process.env.CODEX_HOME ?? '', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
};

if (mode === 'startup-crash') {
  process.stderr.write('fatal: could not load the village Codex home\n');
  process.exit(3);
}

const send = (m: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...(m as object) }) + '\n');
const notify = (method: string, params: unknown) => send({ method, params });
const pending = new Map<number, (r: any) => void>();
let serverReqId = 1000;
const ask = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = serverReqId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const threads = new Map<string, { cwd: string }>();
const interrupted = new Set<string>();
let threadCount = 0;
let turnCount = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTurn(threadId: string, turnId: string, text: string) {
  const cwd = threads.get(threadId)?.cwd ?? process.cwd();
  const done = (status: string, error: string | null = null) => notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error: error ? { message: error } : null } });
  const say = async (itemId: string, parts: string[]) => {
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } });
    for (const p of parts) {
      await sleep(5);
      notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: p });
    }
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: parts.join('') }, completedAtMs: Date.now() });
  };
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  if (mode === 'ok') {
    await say('msg1', ['Hello ', 'from the fake Codex: ', text]);
    return done('completed');
  }
  if (mode === 'fail') {
    notify('error', { threadId, turnId, willRetry: false, error: { message: 'unexpected status 401 Unauthorized' } });
    return done('failed', 'unexpected status 401 Unauthorized');
  }
  if (mode === 'crash') {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm', delta: 'Starting' });
    await sleep(20);
    process.exit(1);
  }
  if (mode === 'hang') {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm', delta: 'Thinking' });
    while (!interrupted.has(turnId)) await sleep(10);
    return done('interrupted');
  }
  if (mode === 'approval-file') {
    const change = { path: path.join(cwd, 'hello.txt'), kind: { type: 'add' }, diff: '+Hello from the village sandbox\n' };
    notify('item/started', { threadId, turnId, item: { type: 'fileChange', id: 'fc1', changes: [change], status: 'inProgress' } });
    const r = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: 'fc1', startedAtMs: Date.now(), reason: 'create hello.txt' });
    record({ type: 'decision', what: 'fileChange', decision: r?.decision });
    if (r?.decision === 'accept') fs.writeFileSync(change.path, 'Hello from the village sandbox\n');
    notify('item/completed', { threadId, turnId, item: { type: 'fileChange', id: 'fc1', changes: [change], status: r?.decision === 'accept' ? 'completed' : 'declined' }, completedAtMs: Date.now() });
    await say('msg2', [r?.decision === 'accept' ? 'Created hello.txt.' : 'The change was declined.']);
    return done('completed');
  }
  if (mode === 'approval-file-outside') {
    const outside = path.resolve(cwd, '..', 'escape.txt');
    notify('item/started', { threadId, turnId, item: { type: 'fileChange', id: 'fc2', changes: [{ path: outside, kind: { type: 'add' }, diff: '+x' }], status: 'inProgress' } });
    const r = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: 'fc2', startedAtMs: Date.now() });
    record({ type: 'decision', what: 'fileChange', decision: r?.decision });
    if (r?.decision === 'accept') fs.writeFileSync(outside, 'escaped');
    await say('msg3', ['Done.']);
    return done('completed');
  }
  if (mode === 'approval-command' || mode === 'approval-command-outside') {
    const params = mode === 'approval-command' ? { command: 'npm test', cwd } : { command: 'rm -rf /', cwd: path.parse(cwd).root };
    const r = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'c1', startedAtMs: Date.now(), kind: 'command', environmentId: null, ...params });
    record({ type: 'decision', what: 'command', decision: r?.decision });
    if (r?.decision === 'accept') notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: params.command, cwd: params.cwd, status: 'completed', exitCode: 0 }, completedAtMs: Date.now() });
    await say('msg4', [r?.decision === 'accept' ? 'Ran it.' : 'Not run.']);
    return done('completed');
  }
  if (mode === 'permissions') {
    const r = await ask('item/permissions/requestApproval', { threadId, turnId, itemId: 'p1', environmentId: null, startedAtMs: Date.now(), cwd, reason: 'need network', permissions: { network: { enabled: true } } });
    record({ type: 'decision', what: 'permissions', response: r });
    await say('msg5', ['ok']);
    return done('completed');
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    pending.get(m.id)?.(m.result);
    pending.delete(m.id);
    return;
  }
  record({ type: 'request', method: m.method, params: m.params });
  const reply = (result: unknown) => send({ id: m.id, result });
  const fail = (message: string) => send({ id: m.id, error: { code: -32600, message } });
  switch (m.method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex/0.161.0', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' });
    case 'initialized':
      return;
    case 'account/read':
      if (mode === 'nologin') return reply({ account: null, requiresOpenaiAuth: true });
      if (mode === 'apikey') return reply({ account: { type: 'apiKey' }, requiresOpenaiAuth: true });
      return reply({ account: { type: 'chatgpt', email: 'resident@example.com', planType: 'plus' }, requiresOpenaiAuth: true });
    case 'thread/start': {
      const id = `thr_${++threadCount}`;
      threads.set(id, { cwd: m.params?.cwd ?? process.cwd() });
      reply({ thread: { id }, model: 'fake', cwd: m.params?.cwd });
      return notify('thread/started', { thread: { id } });
    }
    case 'thread/resume':
      if (m.params?.threadId === 'thr_gone') return fail('thread not found');
      threads.set(m.params.threadId, { cwd: m.params?.cwd ?? process.cwd() });
      return reply({ thread: { id: m.params.threadId } });
    case 'turn/start': {
      const turnId = `turn_${++turnCount}`;
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      const text = (m.params?.input ?? []).map((i: any) => i.text ?? '').join(' ');
      runTurn(m.params.threadId, turnId, text);
      return;
    }
    case 'windowsSandbox/readiness': {
      // "from-config": ready only while the [windows] section written by the sandbox setup is in config.toml.
      const w = process.env.FAKE_WIN_SANDBOX ?? 'ready';
      return reply({ status: w === 'from-config' ? (/^\[windows\]/m.test(configToml()) ? 'ready' : 'notConfigured') : w });
    }
    case 'mcpServerStatus/list': {
      const signedInChatgpt = mode !== 'nologin' && mode !== 'apikey';
      const names = ['village', ...(featureOn('apps') && signedInChatgpt ? ['codex_apps'] : []), ...(process.env.FAKE_EXTRA_MCP ?? '').split(',').filter(Boolean)];
      return reply({ data: names.map((name) => ({ name, tools: {} })), nextCursor: null });
    }
    case 'experimentalFeature/list':
      return reply({ data: BUILTIN_FEATURES.map((name) => ({ name, stage: 'stable', enabled: featureOn(name), defaultEnabled: true })) });
    case 'getAuthStatus':
      return reply(mode === 'nologin' ? { authMethod: null } : { authMethod: mode === 'apikey' ? 'apikey' : 'chatgpt' });
    case 'turn/interrupt':
      interrupted.add(m.params?.turnId);
      return reply({});
    default:
      return fail(`unsupported in fake: ${m.method}`);
  }
});
