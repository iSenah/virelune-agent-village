// Command line: `village doctor`, `village export`, `village codex-login`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAllChecks, villageCodexHome } from '../integrations/checks.ts';
import type { DoctorReport, IntegrationResult } from '../integrations/types.ts';
import { which } from '../integrations/util.ts';
import { loadConfig, PROJECT_ROOT } from './lib/config.ts';
import { buildZip, collectFiles, findSecrets } from './lib/zip.ts';

const [, , command = 'help', ...rest] = process.argv;
const flags = new Set(rest);

const ICON: Record<string, string> = { connected: '[connected]    ', authenticated: '[authenticated]', installed: '[installed]    ', untested: '[untested]     ', unavailable: '[unavailable]  ' };

async function doctor() {
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const integrations = await runAllChecks({ env: config.env, projectRoot: PROJECT_ROOT, dataDir: config.dataDir, live: !flags.has('--offline') });
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
  console.log('Your personal Codex settings and MCP servers are not used by the village.\n');
  const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(isCmd ? process.env.ComSpec || 'cmd.exe' : bin, isCmd ? ['/d', '/s', '/c', `"${bin}" login`] : ['login'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: home }, windowsVerbatimArguments: isCmd });
  child.on('exit', (code) => process.exit(code ?? 1));
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
  default:
    console.log('Usage: node server/cli.ts <doctor [--offline] [--verbose] [--json] | export | codex-login>');
}
