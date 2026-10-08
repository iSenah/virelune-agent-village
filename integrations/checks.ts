// Real integration checks for `village doctor`. Each check is independent, has timeouts, and never throws.
// Checks never print or store credential values; they only report whether a credential is present and verified.
import fs from 'node:fs';
import path from 'node:path';
import { StdioRpcClient } from './jsonrpc-stdio.ts';
import type { Check, DoctorContext, IntegrationResult, IntegrationStatus } from './types.ts';
import { findPackage, firstLine, httpJson, run, which } from './util.ts';

function result(id: string, name: string, costs: string, checks: Check[], status: IntegrationStatus, ready: boolean, version: string | null, summary: string): IntegrationResult {
  return { id, name, status, ready, version, summary, checks, costs };
}

/** Codex keeps its own home for the village, so the user's personal Codex MCP servers never load (verified). */
export function villageCodexHome(ctx: DoctorContext): string {
  return path.join(ctx.dataDir, 'runtime', 'codex-home');
}

export async function checkNode(): Promise<IntegrationResult> {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 18);
  const checks: Check[] = [{ name: 'Node.js version >= 22.18', result: ok ? 'pass' : 'fail', detail: `running ${process.versions.node}` }];
  return result('node', 'Node.js', 'Free', checks, ok ? 'installed' : 'unavailable', ok, process.versions.node, ok ? 'Node.js is new enough to run Virelune.' : 'Install Node.js 22.18 or newer (24 LTS recommended).');
}

export async function checkGit(ctx: DoctorContext): Promise<IntegrationResult> {
  const bin = which('git', ctx.env);
  if (!bin) return result('git', 'Git', 'Free', [{ name: 'git on PATH', result: 'fail', detail: 'not found' }], 'unavailable', false, null, 'Install Git. Residents work in git worktrees of registered projects.');
  const r = await run(bin, ['--version'], { env: ctx.env, timeoutMs: 8000 });
  const ok = r.code === 0;
  return result('git', 'Git', 'Free', [{ name: 'git --version', result: ok ? 'pass' : 'fail', detail: firstLine(r.stdout || r.stderr || r.error || '') }], ok ? 'installed' : 'untested', ok, ok ? firstLine(r.stdout).replace('git version ', '') : null, ok ? 'Git is available for worktrees.' : 'Git was found but did not run.');
}

export async function checkCodex(ctx: DoctorContext): Promise<IntegrationResult> {
  const name = 'Codex (app-server)';
  const costs = 'Included in a ChatGPT plan (limited per 5-hour window), or billed per token with an OpenAI API key.';
  const checks: Check[] = [];
  const bin = ctx.env.CODEX_PATH ? which(ctx.env.CODEX_PATH, ctx.env) : which('codex', ctx.env);
  if (!bin) {
    checks.push({ name: 'codex executable', result: 'fail', detail: ctx.env.CODEX_PATH ? `CODEX_PATH not found: ${ctx.env.CODEX_PATH}` : 'not on PATH' });
    return result('codex', name, costs, checks, 'unavailable', false, null, 'Codex CLI not found. Install it (npm install -g @openai/codex) or set CODEX_PATH.');
  }
  const home = villageCodexHome(ctx);
  fs.mkdirSync(home, { recursive: true });
  const env = { ...ctx.env, CODEX_HOME: home };
  const v = await run(bin, ['--version'], { env, timeoutMs: 15_000 });
  const version = v.code === 0 ? firstLine(v.stdout).replace(/^codex-cli\s*/, '') : null;
  checks.push({ name: 'codex --version', result: version ? 'pass' : 'fail', detail: version ?? firstLine(v.stderr || v.error || '') });
  if (!version) return result('codex', name, costs, checks, 'untested', false, null, 'Codex was found but did not run.');

  const login = await run(bin, ['login', 'status'], { env, timeoutMs: 15_000 });
  const authed = login.code === 0;
  checks.push({ name: 'codex login status (village Codex home)', result: authed ? 'pass' : 'fail', detail: firstLine(login.stdout || login.stderr) || `exit ${login.code}` });

  // Live handshake with the real app-server.
  let handshake = false;
  const rpc = new StdioRpcClient(bin, ['app-server'], { env });
  rpc.onRequest = () => {
    throw new Error('doctor does not accept server requests');
  };
  try {
    const init = await rpc.request('initialize', { clientInfo: { name: 'virelune-agent-village', title: 'Virelune Agent Village', version: '0.1.0' }, capabilities: null }, 20_000);
    rpc.notify('initialized');
    handshake = Boolean(init?.userAgent);
    checks.push({ name: 'app-server initialize', result: handshake ? 'pass' : 'fail', detail: handshake ? `platform ${init.platformOs ?? '?'}` : 'unexpected response' });
    const auth = await rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }, 15_000);
    checks.push({ name: 'app-server getAuthStatus', result: auth?.authMethod ? 'pass' : 'fail', detail: auth?.authMethod ? `auth method: ${auth.authMethod}` : 'not logged in' });
    const mcp = await rpc.request('mcpServerStatus/list', {}, 30_000);
    const names = (mcp?.data ?? []).map((s: any) => s.name);
    const onlyGateway = names.every((n: string) => n === 'village');
    checks.push({ name: 'MCP isolation (village Codex home)', result: onlyGateway ? 'pass' : 'fail', detail: names.length ? `MCP servers visible to Codex: ${names.join(', ')}` : 'no MCP servers inherited' });
    if (process.platform === 'win32') {
      const sb = await rpc.request('windowsSandbox/readiness', {}, 15_000).catch((e: Error) => ({ error: e.message }));
      checks.push({ name: 'Windows sandbox readiness', result: sb?.error ? 'fail' : 'pass', detail: JSON.stringify(sb).slice(0, 200) });
    } else {
      checks.push({ name: 'Sandbox check', result: 'skip', detail: 'Sandbox enforcement is verified separately (`npm run probe:sandbox`).' });
    }
  } catch (e) {
    checks.push({ name: 'app-server handshake', result: 'fail', detail: (e as Error).message });
  } finally {
    rpc.close();
  }
  const status: IntegrationStatus = handshake && authed ? 'connected' : authed ? 'authenticated' : handshake ? 'installed' : 'untested';
  const summary = handshake && authed ? 'Codex app-server handshake passed and the village Codex home is logged in.' : handshake ? 'Codex runs, but the village Codex home is not logged in. Run: npm run codex:login' : 'Codex is installed but the app-server handshake failed.';
  return result('codex', name, costs, checks, status, status === 'connected', version, summary);
}

export async function checkClaudeSdk(ctx: DoctorContext): Promise<IntegrationResult> {
  const name = 'Claude Agent SDK';
  const costs = 'Paid Anthropic API usage (no subscription login for SDK apps).';
  const pkg = findPackage('@anthropic-ai/claude-agent-sdk', ctx.projectRoot);
  const cli = which('claude', ctx.env);
  const checks: Check[] = [{ name: '@anthropic-ai/claude-agent-sdk in node_modules', result: pkg ? 'pass' : 'fail', detail: pkg ? `v${pkg.version}` : 'not installed (npm install in the project)' }];
  checks.push({ name: 'claude CLI on PATH (informational)', result: cli ? 'pass' : 'skip', detail: cli ? 'found' : 'not found; the SDK bundles what it needs' });
  if (!pkg) return result('claude-agent-sdk', name, costs, checks, 'unavailable', false, null, 'Agent SDK package not installed in this project yet.');
  checks.push({ name: 'SDK session handshake', result: 'skip', detail: 'Runs in the Phase 1 adapter test, not in doctor (it would start a billed session).' });
  return result('claude-agent-sdk', name, costs, checks, 'installed', true, pkg.version, 'SDK package is installed. Session handshake is tested by the Claude adapter test.');
}

export async function checkOpenAiAgents(ctx: DoctorContext): Promise<IntegrationResult> {
  const pkg = findPackage('@openai/agents', ctx.projectRoot);
  const checks: Check[] = [{ name: '@openai/agents in node_modules', result: pkg ? 'pass' : 'fail', detail: pkg ? `v${pkg.version}` : 'not installed (npm install in the project)' }];
  if (!pkg) return result('openai-agents', 'OpenAI Agents SDK', 'Free library; model calls are billed by the provider.', checks, 'unavailable', false, null, 'Agents SDK package not installed in this project yet.');
  return result('openai-agents', 'OpenAI Agents SDK', 'Free library; model calls are billed by the provider.', checks, 'installed', true, pkg.version, 'Agents SDK package is installed.');
}

async function checkApiKey(ctx: DoctorContext, o: { id: string; name: string; envVar: string; url: string; headers: (k: string) => Record<string, string>; costs: string }): Promise<IntegrationResult> {
  const key = ctx.env[o.envVar];
  const checks: Check[] = [{ name: `${o.envVar} set`, result: key ? 'pass' : 'fail', detail: key ? 'present (value not shown)' : 'not set in .env or environment' }];
  if (!key) return result(o.id, o.name, o.costs, checks, 'unavailable', false, null, `No ${o.envVar} on this machine.`);
  if (!ctx.live) {
    checks.push({ name: 'live key check', result: 'skip', detail: 'offline mode' });
    return result(o.id, o.name, o.costs, checks, 'untested', false, null, 'A key is present but was not verified (offline mode).');
  }
  const r = await httpJson(o.url, { headers: o.headers(key), timeoutMs: 10_000 });
  if (r.status === 200) {
    checks.push({ name: 'list models (free call)', result: 'pass', detail: 'HTTP 200' });
    return result(o.id, o.name, o.costs, checks, 'connected', true, null, 'Key verified with a free API call.');
  }
  if (r.status === 401 || r.status === 403) {
    checks.push({ name: 'list models (free call)', result: 'fail', detail: `HTTP ${r.status}: key rejected` });
    return result(o.id, o.name, o.costs, checks, 'installed', false, null, 'The key was rejected. Check it in your provider dashboard.');
  }
  checks.push({ name: 'list models (free call)', result: 'fail', detail: r.error ? `network: ${r.error}` : `HTTP ${r.status}` });
  return result(o.id, o.name, o.costs, checks, 'untested', false, null, 'Could not reach the API to verify the key (network or proxy).');
}

export function checkOpenAiApi(ctx: DoctorContext) {
  return checkApiKey(ctx, { id: 'openai-api', name: 'OpenAI API (Echo)', envVar: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }), costs: 'Paid per token; no free tier.' });
}

export function checkAnthropicApi(ctx: DoctorContext) {
  return checkApiKey(ctx, { id: 'anthropic-api', name: 'Anthropic API (Claude)', envVar: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }), costs: 'Paid per token.' });
}

export async function checkOllama(ctx: DoctorContext): Promise<IntegrationResult> {
  const host = (ctx.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const costs = 'Free (runs on this machine).';
  const v = await httpJson(`${host}/api/version`, { timeoutMs: 3000 });
  if (v.status !== 200) {
    const bin = which('ollama', ctx.env);
    const checks: Check[] = [{ name: 'Ollama server', result: 'fail', detail: v.error ? `not reachable at ${host}` : `HTTP ${v.status}` }, { name: 'ollama on PATH', result: bin ? 'pass' : 'fail', detail: bin ? 'installed but not running' : 'not found' }];
    return result('ollama', 'Ollama', costs, checks, bin ? 'installed' : 'unavailable', false, null, bin ? 'Ollama is installed but not running. Start it to enable local models.' : 'Ollama not found on this machine (optional).');
  }
  const tags = await httpJson(`${host}/api/tags`, { timeoutMs: 3000 });
  const models = (tags.body?.models ?? []).map((m: any) => m.name);
  const checks: Check[] = [{ name: 'Ollama server', result: 'pass', detail: `version ${v.body?.version}` }, { name: 'local models', result: models.length ? 'pass' : 'fail', detail: models.length ? models.slice(0, 8).join(', ') : 'no models pulled' }];
  return result('ollama', 'Ollama', costs, checks, 'connected', models.length > 0, v.body?.version ?? null, models.length ? 'Ollama is running with local models.' : 'Ollama is running but has no models.');
}

export async function checkBlender(ctx: DoctorContext): Promise<IntegrationResult> {
  const bin = ctx.env.BLENDER_PATH ? which(ctx.env.BLENDER_PATH, ctx.env) : which('blender', ctx.env);
  const costs = 'Free (Blender and the Blender Lab MCP are GPL).';
  if (!bin) return result('blender', 'Blender', costs, [{ name: 'blender executable', result: 'fail', detail: ctx.env.BLENDER_PATH ? `BLENDER_PATH not found` : 'not on PATH and BLENDER_PATH not set' }], 'unavailable', false, null, 'Blender is not on this machine. Blender residents stay disconnected.');
  const r = await run(bin, ['--version'], { env: ctx.env, timeoutMs: 30_000 });
  const ver = r.code === 0 ? firstLine(r.stdout).replace(/^Blender\s*/, '') : null;
  const checks: Check[] = [{ name: 'blender --version', result: ver ? 'pass' : 'fail', detail: ver ?? firstLine(r.stderr || r.error || '') }];
  checks.push({ name: 'Blender Lab MCP (BLENDER_MCP_COMMAND)', result: ctx.env.BLENDER_MCP_COMMAND ? 'skip' : 'fail', detail: ctx.env.BLENDER_MCP_COMMAND ? 'configured; verified through the Tool Gateway test' : 'not configured' });
  return result('blender', 'Blender', costs, checks, ver ? 'installed' : 'untested', Boolean(ver), ver, ver ? 'Blender found. The MCP connection is verified separately.' : 'Blender found but did not run.');
}

export async function checkUnreal(ctx: DoctorContext): Promise<IntegrationResult> {
  const root = ctx.env.UNREAL_ENGINE_ROOT;
  const costs = 'Free engine (Epic license terms); UE 5.8 MCP is experimental.';
  if (!root) return result('unreal', 'Unreal Engine', costs, [{ name: 'UNREAL_ENGINE_ROOT', result: 'fail', detail: 'not set' }], 'unavailable', false, null, 'Unreal Engine is not configured on this machine. Unreal residents stay disconnected.');
  const editor = ['Engine/Binaries/Win64/UnrealEditor.exe', 'Engine/Binaries/Mac/UnrealEditor.app', 'Engine/Binaries/Linux/UnrealEditor'].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  const checks: Check[] = [{ name: 'Unreal Editor binary', result: editor ? 'pass' : 'fail', detail: editor ? 'found' : `not found under ${root}` }];
  checks.push({ name: 'Unreal MCP (UNREAL_MCP_COMMAND)', result: ctx.env.UNREAL_MCP_COMMAND ? 'skip' : 'fail', detail: ctx.env.UNREAL_MCP_COMMAND ? 'configured; verified through the Tool Gateway test' : 'not configured' });
  return result('unreal', 'Unreal Engine', costs, checks, editor ? 'installed' : 'unavailable', Boolean(editor), null, editor ? 'Unreal Editor found. The MCP connection is verified separately.' : 'UNREAL_ENGINE_ROOT is set but no editor was found.');
}

export async function checkAura(ctx: DoctorContext): Promise<IntegrationResult> {
  const cmd = ctx.env.AURA_MCP_COMMAND;
  const costs = 'Paid Aura subscription after the trial.';
  if (!cmd) return result('aura', 'Aura', costs, [{ name: 'AURA_MCP_COMMAND', result: 'fail', detail: 'not set' }], 'unavailable', false, null, 'Aura is not configured on this machine.');
  return result('aura', 'Aura', costs, [{ name: 'AURA_MCP_COMMAND', result: 'pass', detail: 'configured' }, { name: 'Aura MCP handshake', result: 'skip', detail: 'Verified through the Tool Gateway test with Unreal and Aura running.' }], 'untested', false, null, 'Aura is configured but not verified.');
}

export async function runAllChecks(ctx: DoctorContext): Promise<IntegrationResult[]> {
  const safe = async (id: string, name: string, fn: () => Promise<IntegrationResult>): Promise<IntegrationResult> => {
    try {
      return await fn();
    } catch (e) {
      return result(id, name, '', [{ name: 'check crashed', result: 'fail', detail: (e as Error).message }], 'untested', false, null, 'The check failed unexpectedly.');
    }
  };
  return Promise.all([
    safe('node', 'Node.js', () => checkNode()),
    safe('git', 'Git', () => checkGit(ctx)),
    safe('codex', 'Codex (app-server)', () => checkCodex(ctx)),
    safe('claude-agent-sdk', 'Claude Agent SDK', () => checkClaudeSdk(ctx)),
    safe('anthropic-api', 'Anthropic API (Claude)', () => checkAnthropicApi(ctx)),
    safe('openai-agents', 'OpenAI Agents SDK', () => checkOpenAiAgents(ctx)),
    safe('openai-api', 'OpenAI API (Echo)', () => checkOpenAiApi(ctx)),
    safe('ollama', 'Ollama', () => checkOllama(ctx)),
    safe('blender', 'Blender', () => checkBlender(ctx)),
    safe('unreal', 'Unreal Engine', () => checkUnreal(ctx)),
    safe('aura', 'Aura', () => checkAura(ctx)),
  ]);
}
