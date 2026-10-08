// Probe: does Codex's sandbox really stop a command from writing outside the workspace or reaching the network?
// Run on each machine: npm run probe:sandbox. It never needs a login and makes no model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/lib/config.ts';
import { run, which } from '../util.ts';

const config = loadConfig();
const bin = config.env.CODEX_PATH ? which(config.env.CODEX_PATH, config.env) : which('codex', config.env);
if (!bin) {
  console.log('UNTESTED: Codex CLI not found on this machine.');
  process.exit(0);
}
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'virelune-sandbox-ws-'));
const outside = path.join(os.tmpdir(), `virelune-outside-${Date.now()}.txt`);
const codexHome = path.join(config.dataDir, 'runtime', 'codex-home');
fs.mkdirSync(codexHome, { recursive: true });
const script = `
const fs=require('fs');
try{fs.writeFileSync('inside.txt','ok');console.log('INSIDE_WRITE=ok')}catch(e){console.log('INSIDE_WRITE=blocked')}
try{fs.writeFileSync(${JSON.stringify(outside)},'bad');console.log('OUTSIDE_WRITE=ok')}catch(e){console.log('OUTSIDE_WRITE=blocked')}
fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('NETWORK=ok '+r.status)).catch(()=>console.log('NETWORK=blocked'));
`;
const r = await run(bin, ['sandbox', '-c', 'sandbox_mode=workspace-write', '--', process.execPath, '-e', script], { cwd: workspace, env: { ...config.env, CODEX_HOME: codexHome }, timeoutMs: 60_000 });
const out = r.stdout + r.stderr;
const get = (k: string) => (out.match(new RegExp(`${k}=(\\w+)`)) ?? [])[1] ?? 'unknown';
const res = { inside: get('INSIDE_WRITE'), outside: get('OUTSIDE_WRITE'), network: get('NETWORK') };
const outsideExists = fs.existsSync(outside);
if (outsideExists) fs.rmSync(outside);
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`Codex sandbox probe on ${process.platform}:`);
if (res.inside === 'unknown') {
  console.log('UNTESTED: the sandbox could not run here.');
  console.log(out.split(/\r?\n/).filter((l) => /bwrap|sandbox|error/i.test(l)).slice(0, 5).join('\n'));
  process.exit(0);
}
console.log(`  write inside workspace : ${res.inside}`);
console.log(`  write outside workspace: ${res.outside}${outsideExists ? ' (file was created!)' : ''}`);
console.log(`  network access         : ${res.network}`);
const pass = res.inside === 'ok' && res.outside === 'blocked' && !outsideExists && res.network === 'blocked';
console.log(pass ? 'PASS: the sandbox enforces workspace-only writes and no network.' : 'FAIL: the sandbox did not enforce the expected boundaries. Do not enable Codex residents on this machine.');
process.exit(pass ? 0 : 1);
