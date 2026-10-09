// Composition root: wires the database, event log, registries, task engine, approvals, settings and gateway.
import type { IntegrationResult } from '../../integrations/types.ts';
import path from 'node:path';
import { Approvals } from './approvals.ts';
import { BillingGuard } from './billing.ts';
import { ChatService, type AgentAdapter } from './chat.ts';
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
  readonly chat: ChatService;
  /** Paid API safeguards: per-resident "Allow paid use", off by default. */
  readonly billing: BillingGuard;
  /** Runtime adapters by runtime kind. Only real adapters are ever registered; none means nobody can answer. */
  readonly adapters: Map<string, AgentAdapter>;
  registries: Registries;
  private doctorResults: Map<string, IntegrationResult> | null;
  private lastViews = new Map<string, string>();
  doctorRunning = false;

  constructor(config: VillageConfig, opts: { registries?: Registries; isResidentActive?: (id: string) => boolean; approvalTimeoutMs?: number; adapters?: AgentAdapter[] | ((v: Village) => AgentAdapter[]); chatReplyTimeoutMs?: number } = {}) {
    this.config = config;
    this.db = openDb(config.dbPath);
    this.events = new EventLog(this.db);
    this.registries = opts.registries ?? loadRegistries(config.configDir);
    this.approvals = new Approvals(this.db, this.events);
    this.settings = new Settings(this.db, this.events);
    this.billing = new BillingGuard(this.db, this.events, () => this.registries);
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
    const adapters = typeof opts.adapters === 'function' ? opts.adapters(this) : (opts.adapters ?? []);
    this.adapters = new Map(adapters.map((a) => [a.runtimeKind, a]));
    this.chat = new ChatService({ db: this.db, events: this.events, registries: () => this.registries, residents: () => this.residents(), adapters: this.adapters, billing: this.billing, replyTimeoutMs: opts.chatReplyTimeoutMs });
    // Switching paid use off stops a paid reply that is in progress right away.
    this.billing.onRevoked = (id) => this.chat.stop(id, 'switching paid use off');
  }

  /** Startup: record the boot, report registry problems, recover interrupted work. */
  start() {
    tx(this.db, () => {
      this.events.append({ type: 'village.started', actor: 'system', payload: { machine: this.config.machineName, platform: this.config.platform, node: process.versions.node, residents: this.registries.residents.size, registryErrors: this.registries.errors.length } });
      for (const e of this.registries.errors) this.events.append({ type: 'registry.invalid', actor: 'system', payload: { file: e.file, message: e.message } });
    });
    this.tasks.recoverAfterRestart();
    this.chat.recoverAfterRestart();
    this.refreshResidents();
  }

  residents(): ResidentView[] {
    return residentViews(this.registries, this.doctorResults).map((v) => ({ ...v, billing: this.billing.info(v.id) }));
  }

  /** The folder a resident works in: the sandbox repo if configured, else its own folder under data/workspaces. */
  workspaceFor(residentId: string): string {
    return this.config.sandboxDir ?? path.join(this.config.dataDir, 'workspaces', residentId);
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
    for (const a of this.adapters.values()) {
      try {
        a.close?.();
      } catch {
        /* ignore */
      }
    }
    this.gateway.close();
    this.db.close();
  }
}
