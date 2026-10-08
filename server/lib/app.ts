// Composition root: wires the database, event log, registries, task engine, approvals, settings and gateway.
import type { IntegrationResult } from '../../integrations/types.ts';
import { Approvals } from './approvals.ts';
import type { VillageConfig } from './config.ts';
import { openDb, tx, type DB } from './db.ts';
import { latestDoctorResults, recordDoctorReport, runDoctorChild } from './doctor.ts';
import { EventLog } from './events.ts';
import { ToolGateway } from './gateway.ts';
import { loadRegistries, type Registries } from './registry.ts';
import { residentViews, type ResidentView } from './residents.ts';
import { Settings } from './settings.ts';
import { TaskEngine } from './tasks.ts';

export class Village {
  readonly config: VillageConfig;
  readonly db: DB;
  readonly events: EventLog;
  readonly approvals: Approvals;
  readonly settings: Settings;
  readonly tasks: TaskEngine;
  readonly gateway: ToolGateway;
  registries: Registries;
  private doctorResults: Map<string, IntegrationResult> | null;
  private lastViews = new Map<string, string>();
  doctorRunning = false;

  constructor(config: VillageConfig, opts: { registries?: Registries; isResidentActive?: (id: string) => boolean; approvalTimeoutMs?: number } = {}) {
    this.config = config;
    this.db = openDb(config.dbPath);
    this.events = new EventLog(this.db);
    this.registries = opts.registries ?? loadRegistries(config.configDir);
    this.approvals = new Approvals(this.db, this.events);
    this.settings = new Settings(this.db, this.events);
    this.doctorResults = latestDoctorResults(this.events, config.machineName);
    this.tasks = new TaskEngine(this.db, this.events, (id) => {
      const v = this.residents().find((r) => r.id === id);
      if (!v) return { known: false, ready: false, reason: 'unknown resident' };
      if (v.status === 'connected') return { known: true, ready: true, reason: '' };
      return { known: true, ready: false, reason: `${v.displayName} is ${v.status === 'untested' ? 'not checked yet' : 'disconnected'}: ${v.reasons[0] ?? ''}`.trim() };
    });
    this.gateway = new ToolGateway({
      db: this.db,
      events: this.events,
      approvals: this.approvals,
      registries: () => this.registries,
      env: config.env,
      isResidentActive: opts.isResidentActive ?? ((id) => this.residents().find((r) => r.id === id)?.status === 'connected'),
      approvalTimeoutMs: opts.approvalTimeoutMs,
    });
  }

  /** Startup: record the boot, report registry problems, recover interrupted work. */
  start() {
    tx(this.db, () => {
      this.events.append({ type: 'village.started', actor: 'system', payload: { machine: this.config.machineName, platform: this.config.platform, node: process.versions.node, residents: this.registries.residents.size, registryErrors: this.registries.errors.length } });
      for (const e of this.registries.errors) this.events.append({ type: 'registry.invalid', actor: 'system', payload: { file: e.file, message: e.message } });
    });
    this.tasks.recoverAfterRestart();
    this.refreshResidents();
  }

  residents(): ResidentView[] {
    return residentViews(this.registries, this.doctorResults);
  }

  doctorLatest() {
    return this.doctorResults ? [...this.doctorResults.values()] : null;
  }

  /** Emit resident.status_changed only when a resident's status or reasons actually change. */
  refreshResidents() {
    tx(this.db, () => {
      for (const v of this.residents()) {
        const key = JSON.stringify([v.status, v.reasons]);
        if (this.lastViews.get(v.id) === key) continue;
        const prev = this.lastViews.get(v.id);
        this.lastViews.set(v.id, key);
        // On boot, only announce residents whose status differs from the last recorded one.
        const last = this.db.prepare("SELECT payload_json FROM events WHERE type = 'resident.status_changed' AND actor = ? ORDER BY seq DESC LIMIT 1").get(v.id) as any;
        if (!prev && last) {
          const p = JSON.parse(last.payload_json);
          if (p.status === v.status && JSON.stringify(p.reasons) === JSON.stringify(v.reasons)) continue;
        }
        this.events.append({ type: 'resident.status_changed', actor: v.id, payload: { status: v.status, reasons: v.reasons, building: v.building } });
      }
    });
    tx(this.db, () => this.tasks.evaluateAll('system'));
  }

  async runDoctor(live: boolean) {
    if (this.doctorRunning) throw Object.assign(new Error('The doctor is already running'), { status: 409 });
    this.doctorRunning = true;
    this.events.append({ type: 'doctor.started', actor: 'human', payload: { live } });
    try {
      const report = await runDoctorChild({ live });
      this.doctorResults = recordDoctorReport(this.db, this.events, report);
      this.refreshResidents();
      return report;
    } catch (e) {
      this.events.append({ type: 'doctor.failed', actor: 'doctor', payload: { error: (e as Error).message } });
      throw e;
    } finally {
      this.doctorRunning = false;
    }
  }

  /** For tests: inject doctor results without running real checks. Never used by the server. */
  setDoctorResultsForTest(results: IntegrationResult[]) {
    this.doctorResults = new Map(results.map((r) => [r.id, r]));
    this.refreshResidents();
  }

  close() {
    this.gateway.close();
    this.db.close();
  }
}
