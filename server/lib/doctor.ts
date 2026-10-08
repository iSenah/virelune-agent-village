// Runs `village doctor` in a separate process so a misbehaving integration can never take down the village.
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DoctorReport, IntegrationResult } from '../../integrations/types.ts';
import { PROJECT_ROOT } from './config.ts';
import { tx, type DB } from './db.ts';
import type { EventLog } from './events.ts';

export function runDoctorChild(opts: { live: boolean; timeoutMs?: number }): Promise<DoctorReport> {
  return new Promise((resolve, reject) => {
    const args = ['--disable-warning=ExperimentalWarning', path.join(PROJECT_ROOT, 'server', 'cli.ts'), 'doctor', '--json'];
    if (!opts.live) args.push('--offline');
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`doctor failed (exit ${code}): ${errOut.slice(-500)}`));
      }
    });
  });
}

/** Record a doctor report as events. Returns the per-integration results map. */
export function recordDoctorReport(db: DB, events: EventLog, report: DoctorReport): Map<string, IntegrationResult> {
  tx(db, () => {
    for (const r of report.integrations) events.append({ type: 'integration.checked', actor: 'doctor', payload: { ...r, machine: report.machine } });
    events.append({ type: 'doctor.completed', actor: 'doctor', payload: { machine: report.machine, platform: report.platform, node: report.node, live: report.live, startedAt: report.startedAt, finishedAt: report.finishedAt, count: report.integrations.length } });
  });
  return new Map(report.integrations.map((r) => [r.id, r]));
}

/** Rebuild the latest results from the event log (on startup). Results from another machine are not trusted. */
export function latestDoctorResults(events: EventLog, machine: string): Map<string, IntegrationResult> | null {
  const done = events.latestOfType('doctor.completed');
  if (!done || done.payload.machine !== machine) return null;
  // A report's integration.checked events are written in the same transaction, right before doctor.completed.
  const count = Number(done.payload.count ?? 0);
  const all = events.list(Math.max(0, done.seq - count - 1), count, ['integration.checked']).filter((e) => e.seq < done.seq && e.payload.machine === machine);
  const map = new Map<string, IntegrationResult>();
  for (const e of all) map.set(String(e.payload.id), e.payload as unknown as IntegrationResult);
  return map;
}
