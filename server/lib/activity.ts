// Who is doing what, right now, and where. Built only from real events appended since Village Hall started
// (anything in flight before a restart has already been marked interrupted), so after a page reload the village
// is rebuilt from this snapshot instead of replaying history as if it were happening again.
//
// Event contract for runs (chat replies today, task runs later):
//   run.started   actor: resident or execution profile, runId, taskId?  payload: { kind, profile?, workplace? }
//   run.progress  runId  payload: { done, total, label? }   (only when a provider reports real, measurable progress)
//   run.finished / run.failed / run.interrupted   runId
//   approval.requested  actor: resident or profile, taskId?  payload: { approvalId, runId? }
//   approval.decided    payload: { approvalId }
// A profile (e.g. codex-unreal) always resolves to its one resident (codex) and its workplace (unreal-studio).
// A resident working without a profile works at home.
import type { EventLog, VillageEvent } from './events.ts';
import type { Registries } from './registry.ts';

export type Progress = { done: number; total: number; label: string | null };

export type ActiveRun = {
  runId: string;
  resident: string;
  profile: string | null;
  workplace: string;
  kind: string;
  taskId: string | null;
  startedAt: string;
  seq: number;
  /** Only set when the provider reported real, measurable progress. */
  progress: Progress | null;
};

export type PendingApproval = {
  approvalId: string;
  resident: string;
  profile: string | null;
  workplace: string;
  runId: string | null;
  taskId: string | null;
  requestedAt: string;
  seq: number;
};

export type Outcome = {
  result: 'completed' | 'failed' | 'stopped';
  resident: string;
  profile: string | null;
  workplace: string;
  runId: string | null;
  taskId: string | null;
  kind: string;
  at: string;
  seq: number;
};

export type ResidentActivity = {
  runs: ActiveRun[];
  approvals: PendingApproval[];
  lastOutcome: Outcome | null;
};

export type ActivitySnapshot = {
  /** Server clock when the snapshot was taken (to age outcomes without trusting the browser's clock). */
  now: string;
  /** Last event folded into this snapshot. */
  seq: number;
  residents: Record<string, ResidentActivity>;
};

/** Resolve the actor of an event to its one resident, the profile it used (if any) and where that work happens. */
export function placeOf(reg: Registries, actor: string, payload: Record<string, unknown> = {}): { resident: string; profile: string | null; workplace: string } | null {
  const explicit = typeof payload.profile === 'string' ? reg.principals?.get(payload.profile) : undefined;
  const p = explicit ?? reg.residents.get(actor) ?? reg.principals?.get(actor);
  if (!p) return null;
  const resident = p.parent ?? p.id;
  const home = reg.residents.get(resident);
  if (!home) return null;
  const workplace = typeof payload.workplace === 'string' && payload.workplace ? payload.workplace : p.building;
  return { resident, profile: p.parent ? p.id : null, workplace };
}

export class ActivityTracker {
  private registries: () => Registries;
  private runs = new Map<string, ActiveRun>();
  private approvals = new Map<string, PendingApproval>();
  private outcomes = new Map<string, Outcome>();
  private seq = 0;
  private events: EventLog | null = null;

  constructor(registries: () => Registries) {
    this.registries = registries;
  }

  /** Follow the event log from now on (older history is never folded in). */
  attach(events: EventLog) {
    this.events = events;
    this.seq = events.lastSeq();
  }

  detach() {
    this.events = null;
  }

  /** Fold in every event recorded since the last look (reads the log itself, so it is always up to date). */
  private sync() {
    if (!this.events) return;
    for (;;) {
      const batch = this.events.list(this.seq, 5000);
      for (const e of batch) this.apply(e);
      if (batch.length < 5000) return;
    }
  }

  /** Fold one event into the current picture. Unknown events are ignored. */
  apply(e: VillageEvent) {
    this.seq = Math.max(this.seq, e.seq);
    const p = e.payload ?? {};
    const reg = this.registries();
    switch (e.type) {
      case 'village.started':
        // Nothing survives a restart: runs in flight were interrupted, their approvals can no longer be answered.
        this.runs.clear();
        this.approvals.clear();
        return;
      case 'run.started': {
        if (!e.runId) return;
        const where = placeOf(reg, e.actor, p);
        if (!where) return;
        this.runs.set(e.runId, { runId: e.runId, ...where, kind: String(p.kind ?? 'task'), taskId: e.taskId, startedAt: e.ts, seq: e.seq, progress: null });
        return;
      }
      case 'run.progress': {
        const r = e.runId ? this.runs.get(e.runId) : undefined;
        const done = Number(p.done);
        const total = Number(p.total);
        // Only meaningful numbers are kept; anything else leaves the indicator indeterminate.
        if (r && Number.isFinite(done) && Number.isFinite(total) && total > 0 && done >= 0 && done <= total) r.progress = { done, total, label: typeof p.label === 'string' ? p.label : null };
        return;
      }
      case 'run.finished':
      case 'run.failed':
      case 'run.interrupted': {
        const r = e.runId ? this.runs.get(e.runId) : undefined;
        if (!r) return;
        this.runs.delete(r.runId);
        for (const [id, a] of this.approvals) if (a.runId === r.runId) this.approvals.delete(id);
        const result = e.type === 'run.finished' ? 'completed' : e.type === 'run.failed' ? 'failed' : 'stopped';
        this.outcomes.set(r.resident, { result, resident: r.resident, profile: r.profile, workplace: r.workplace, runId: r.runId, taskId: r.taskId, kind: r.kind, at: e.ts, seq: e.seq });
        return;
      }
      case 'approval.requested': {
        const id = String(p.approvalId ?? '');
        if (!id) return;
        const runId = typeof p.runId === 'string' ? p.runId : null;
        const run = runId ? this.runs.get(runId) : undefined;
        const where = run ?? placeOf(reg, e.actor, p);
        if (!where) return;
        this.approvals.set(id, { approvalId: id, resident: where.resident, profile: where.profile, workplace: where.workplace, runId, taskId: e.taskId ?? run?.taskId ?? null, requestedAt: e.ts, seq: e.seq });
        return;
      }
      case 'approval.decided':
        this.approvals.delete(String(p.approvalId ?? ''));
        return;
    }
  }

  snapshot(now = new Date()): ActivitySnapshot {
    this.sync();
    const residents: Record<string, ResidentActivity> = {};
    const of = (id: string) => (residents[id] ??= { runs: [], approvals: [], lastOutcome: null });
    for (const r of this.runs.values()) of(r.resident).runs.push({ ...r, progress: r.progress && { ...r.progress } });
    for (const a of this.approvals.values()) of(a.resident).approvals.push({ ...a });
    for (const o of this.outcomes.values()) of(o.resident).lastOutcome = { ...o };
    for (const v of Object.values(residents)) {
      v.runs.sort((a, b) => a.seq - b.seq);
      v.approvals.sort((a, b) => a.seq - b.seq);
    }
    return { now: now.toISOString(), seq: this.seq, residents };
  }
}
