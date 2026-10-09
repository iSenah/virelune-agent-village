// Command line: `village doctor`, `village export`, `village codex-login`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCodex, runAllChecks, villageCodexHome } from '../integrations/checks.ts';
import type { DoctorReport, IntegrationResult } from '../integrations/types.ts';
import { StdioRpcClient } from '../integrations/jsonrpc-stdio.ts';
import { prepareCodexLaunch } from '../integrations/runtime-config.ts';
import { which } from '../integrations/util.ts';
import { createServer } from './lib/api.ts';
import { Village } from './lib/app.ts';
import { loadConfig, PROJECT_ROOT } from './lib/config.ts';
import { createRuntimeAdapters } from './lib/runtimes.ts';
import { buildZip, collectFiles, findSecrets } from './lib/zip.ts';

const [, , command = 'help', ...rest] = process.argv;
const flags = new Set(rest);

const ICON: Record<string, string> = { connected: '[connected]    ', authenticated: '[authenticated]', installed: '[installed]    ', untested: '[untested]     ', unavailable: '[unavailable]  ' };

async function doctor() {
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const integrations = await runAllChecks({ env: config.env, projectRoot: PROJECT_ROOT, dataDir: config.dataDir, live: !flags.has('--offline'), workspace: config.sandboxDir ?? path.join(config.dataDir, 'workspaces', 'codex') });
  const report: DoctorReport = { machine: config.machineName, platform: `${process.platform} ${os.release()} ${process.arch}`, node: process.versions.node, startedAt, finishedAt: new Date().toISOString(), live: !flags.has('--offline'), integrations };
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(report));
    return;
  }
  console.log(`\nVirelune Agent Village doctor: ${report.machine} (${report.platform}, Node ${report.node})${report.live ? '' : ' [offline]'}\n`);
  for (const r of integrations) printResult(r, flags.has('--verbose'));
  console.log('\nStatuses: connected = live handshake passed and auth verified; authenticated = credentials verified;');
  console.log('installed = found but not authenticated/usable; untested = present but not verifiable here; unavailable = not found.');
  console.log('Run with --verbose for every check. Results are recorded in the village when the doctor runs from the control panel.\n');
}

function printResult(r: IntegrationResult, verbose: boolean) {
  console.log(`  ${ICON[r.status]} ${r.name}${r.version ? ` ${r.version}` : ''}`);
  console.log(`                   ${r.summary}`);
  if (verbose) for (const c of r.checks) console.log(`                   - ${c.result.toUpperCase()} ${c.name}: ${c.detail}`);
}

function exportZip() {
  const config = loadConfig();
  const files = collectFiles(PROJECT_ROOT);
  const secrets = findSecrets(PROJECT_ROOT, files);
  if (secrets.length) {
    console.error('Export refused: these files look like they contain credentials:');
    for (const s of secrets) console.error(`  ${s.file} (${s.pattern}...)`);
    process.exit(2);
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outDir = path.join(PROJECT_ROOT, 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `virelune-agent-village-${stamp}.zip`);
  const zip = buildZip(files.map((f) => ({ name: `virelune-agent-village/${f.replace(/\\/g, '/')}`, data: fs.readFileSync(path.join(PROJECT_ROOT, f)), mtime: fs.statSync(path.join(PROJECT_ROOT, f)).mtime })));
  fs.writeFileSync(out, zip);
  console.log(`Exported ${files.length} files to ${out}`);
  console.log('Excluded: .env, *.local.json, data/ (database), node_modules/, exports/, .git/, key files.');
  void config;
}

function codexLogin() {
  const config = loadConfig();
  const bin = config.env.CODEX_PATH ? which(config.env.CODEX_PATH, config.env) : which('codex', config.env);
  if (!bin) {
    console.error('Codex CLI not found. Install it with: npm install -g @openai/codex');
    process.exit(1);
  }
  const home = villageCodexHome({ env: config.env, projectRoot: PROJECT_ROOT, dataDir: config.dataDir, live: false });
  fs.mkdirSync(home, { recursive: true });
  console.log(`Logging Codex in for the village (separate Codex home: ${home}).`);
  console.log('Your personal Codex settings and MCP servers are not used by the village.');
  console.log('Choose "Sign in with ChatGPT". The village refuses API-key sign-ins, which are billed per token.\n');
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(isCmd ? process.env.ComSpec || 'cmd.exe' : bin, isCmd ? ['/d', '/s', '/c', `"${bin}" login`] : ['login'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined }, windowsVerbatimArguments: isCmd });
  child.on('exit', (code) => process.exit(code ?? 1));
}

/**
 * One real Codex conversation turn through the village adapter, printed as it streams. It uses exactly what the
 * village server uses: the same adapter factory, village Codex home, launch settings and workspace. Only the
 * conversation itself goes to a scratch database that is deleted afterwards.
 */
async function codexVerify() {
  const config = loadConfig();
  const workspace = config.sandboxDir ?? path.join(config.dataDir, 'workspaces', 'codex');
  console.log(`\nVerifying Codex for Virelune Agent Village on ${config.machineName}`);
  console.log(`Workspace: ${workspace}\n`);
  const check = await checkCodex({ env: config.env, projectRoot: PROJECT_ROOT, dataDir: config.dataDir, live: true, workspace });
  for (const c of check.checks) console.log(`  ${c.result === 'pass' ? 'PASS' : c.result === 'skip' ? 'SKIP' : 'FAIL'}  ${c.name}: ${c.detail}`);
  if (!check.ready) {
    console.error(`\nCodex is not ready: ${check.summary}`);
    process.exit(1);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'virelune-codex-verify-'));
  let port = 0;
  // Same config (data folder, Codex home, sandbox folder); only the database is a throwaway.
  const village = new Village({ ...config, dbPath: path.join(scratch, 'verify.db'), layoutFile: path.join(scratch, 'layout.json') }, { isResidentActive: (id) => id === 'codex', adapters: (v) => createRuntimeAdapters(v, () => `http://127.0.0.1:${port}`) });
  village.start();
  const server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
  const adapter = village.adapters.get('codex-app-server')!;
  const resident = village.registries.residents.get('codex')!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('no reply within 3 minutes')), 180_000);
  let code = 0;
  try {
    process.stdout.write('\nCodex: ');
    const out = await adapter.reply({ resident, runId: 'verify', message: 'This is a connection test from Virelune Agent Village. Reply with one short friendly sentence that includes the words "village connection OK". Do not run commands or change files.', history: [], threadState: null, signal: controller.signal, onDelta: (t) => process.stdout.write(t) });
    console.log(`\n\nVerified: a genuine Codex reply (${out.text.length} characters) through the village adapter.`);
    console.log('Now start the village (npm start), click Codex at the Engineering Forge, and say hello.');
  } catch (e) {
    console.error(`\n\nCodex did not reply: ${(e as Error).message}`);
    code = 1;
  } finally {
    clearTimeout(timer);
    await adapter.close?.(); // wait for Codex to exit: Windows cannot delete files a running process still uses
    await new Promise<void>((r) => server.close(() => r()));
    village.close();
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      console.warn(`(Could not delete the scratch folder ${scratch}: ${(e as Error).message}. It is safe to delete it yourself.)`);
    }
  }
  process.exit(code);
}

/** Windows only: run Codex's own one-time sandbox setup for the village Codex home. */
async function codexSandboxSetup() {
  if (process.platform !== 'win32') {
    console.log('The Codex sandbox setup is only needed on Windows. Nothing to do here.');
    return;
  }
  const config = loadConfig();
  const bin = config.env.CODEX_PATH ? which(config.env.CODEX_PATH, config.env) : which('codex', config.env);
  if (!bin) {
    console.error('Codex CLI not found. Install it with: npm install -g @openai/codex');
    process.exit(1);
  }
  const mode = flags.has('--elevated') ? 'elevated' : 'unelevated';
  const workspace = config.sandboxDir ?? path.join(config.dataDir, 'workspaces', 'codex');
  fs.mkdirSync(workspace, { recursive: true });
  // The same launch settings the village runs Codex with (village Codex home, gateway only, features off).
  const launch = prepareCodexLaunch({ dataDir: config.dataDir, residentId: 'codex', gatewayUrl: `http://127.0.0.1:${config.port}`, token: 'sandbox-setup-only', baseEnv: config.env });
  console.log(`Setting up Codex's Windows sandbox (${mode}) for the village Codex home.${mode === 'elevated' ? ' Windows will ask for administrator permission.' : ''}`);
  const rpc = new StdioRpcClient(bin, launch.args, { env: launch.env, cwd: workspace });
  rpc.onRequest = () => {
    throw new Error('not supported');
  };
  const completed = new Promise<any>((resolve) => {
    rpc.onNotification = (m) => m.method === 'windowsSandbox/setupCompleted' && resolve(m.params);
  });
  let code = 0;
  try {
    await rpc.request('initialize', { clientInfo: { name: 'virelune-agent-village', title: 'Virelune Agent Village', version: '2' }, capabilities: null }, 30_000);
    rpc.notify('initialized');
    const before = await rpc.request('windowsSandbox/readiness', {}, 15_000);
    if (before?.status === 'ready') {
      console.log('The sandbox is already set up. Press Check integrations in the village.');
    } else {
      await rpc.request('windowsSandbox/setupStart', { mode, cwd: workspace }, 30_000);
      const done = await Promise.race([completed, new Promise<any>((r) => setTimeout(() => r({ success: false, error: 'no answer within 5 minutes' }), 300_000))]);
      const after = await rpc.request('windowsSandbox/readiness', {}, 15_000).catch(() => null);
      if (done?.success && after?.status === 'ready') console.log('Done: the Codex sandbox is ready. Press Check integrations in the village.');
      else {
        console.error(`The sandbox setup did not finish: ${done?.error ?? after?.status ?? 'unknown error'}.${mode === 'unelevated' ? ' You can try the stronger setup with: npm run codex:sandbox-setup -- --elevated' : ''}`);
        code = 1;
      }
    }
  } catch (e) {
    console.error(`Sandbox setup failed: ${(e as Error).message}`);
    code = 1;
  } finally {
    rpc.close();
    await rpc.exited;
  }
  process.exit(code);
}

/**
 * One small REAL request to a paid provider through the village adapter (Claude or Echo). It costs money, so it
 * only runs when you pass --confirm-paid AND paid use is already allowed for that resident in the village.
 */
async function paidVerify() {
  const id = rest.find((a) => !a.startsWith('--'));
  if (!id || !['claude', 'echo'].includes(id)) {
    console.error('Usage: npm run paid:verify -- <claude|echo> --confirm-paid');
    process.exit(2);
  }
  const config = loadConfig();
  const village = new Village(config, { adapters: (v) => createRuntimeAdapters(v, () => `http://127.0.0.1:${config.port}`) });
  const resident = village.registries.residents.get(id)!;
  const rt = village.registries.runtimes.get(resident.runtime)!;
  const adapter = village.adapters.get(rt.kind);
  const billing = village.billing.info(id);
  console.log(`\n${resident.displayName} uses the ${billing.providerName} (${billing.kind}). Paid use in the village: ${billing.allowed ? 'ALLOWED' : 'off'}.`);
  const fail = (msg: string) => {
    console.error(msg);
    village.close();
    process.exit(1);
  };
  if (!flags.has('--confirm-paid')) fail('This makes one billed request. Re-run with --confirm-paid if you accept a small charge to your provider account.');
  if (!billing.allowed) fail(`Paid use is off for ${resident.displayName}. Allow it in the village (Profile tab) first. This command never turns it on.`);
  if (!adapter) fail(`No adapter for ${rt.displayName}.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('no reply within 2 minutes')), 120_000);
  let code = 0;
  try {
    process.stdout.write(`\n${resident.displayName}: `);
    const out = await adapter!.reply({ resident, runId: 'paid-verify', message: 'This is a one-time connection test from Virelune Agent Village. Reply with one short sentence that includes the words "village connection OK".', history: [], threadState: null, signal: controller.signal, onDelta: (t) => process.stdout.write(t), assertPaidAllowed: () => village.billing.assertAllowed(id, 'paid:verify') });
    console.log(`\n\nVerified: a genuine ${billing.providerName} reply (${out.text.length} characters) through the village adapter.`);
  } catch (e) {
    console.error(`\n\n${resident.displayName} did not reply: ${(e as Error).message}`);
    code = 1;
  } finally {
    clearTimeout(timer);
    village.close();
  }
  process.exit(code);
}

switch (command) {
  case 'doctor':
    await doctor();
    break;
  case 'export':
    exportZip();
    break;
  case 'codex-login':
    codexLogin();
    break;
  case 'codex-verify':
    await codexVerify();
    break;
  case 'codex-sandbox-setup':
    await codexSandboxSetup();
    break;
  case 'paid-verify':
    await paidVerify();
    break;
  default:
    console.log('Usage: node server/cli.ts <doctor [--offline] [--verbose] [--json] | export | codex-login | codex-verify | codex-sandbox-setup [--elevated] | paid-verify <claude|echo> --confirm-paid>');
}
