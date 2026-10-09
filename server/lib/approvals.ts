// Approval inbox. Approvals fail safe: unanswered means not approved.
import crypto from 'node:crypto';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import type { EventLog } from './events.ts';
import { ConflictError, NotFoundError, ValidationError } from './tasks.ts';

export type Approval = {
  id: string;
  kind: string;
  resident: string | null;
  taskId: string | null;
  summary: string;
  detail: Record<string, unknown>;
  risk: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
};

export class Approvals {
  private db: DB;
  private events: EventLog;
  private waiters = new Map<string, (a: Approval) => void>();

  constructor(db: DB, events: EventLog) {
    this.db = db;
    this.events = events;
  }

  request(input: { kind: string; resident?: string | null; taskId?: string | null; summary: string; detail?: Record<string, unknown>; risk: string }): Approval {
    const id = `a_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO approvals (id, kind, resident, task_id, summary, detail_json, risk, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.kind, input.resident ?? null, input.taskId ?? null, input.summary, JSON.stringify(input.detail ?? {}), input.risk, 'pending', now);
      this.events.append({ type: 'approval.requested', actor: input.resident ?? 'system', taskId: input.taskId ?? null, payload: { approvalId: id, kind: input.kind, summary: input.summary, risk: input.risk, runId: typeof input.detail?.runId === 'string' ? input.detail.runId : null } });
    });
    return this.get(id)!;
  }

  get(id: string): Approval | null {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    if (!r) return null;
    return { id: r.id, kind: r.kind, resident: r.resident, taskId: r.task_id, summary: r.summary, detail: JSON.parse(r.detail_json), risk: r.risk, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, reason: r.reason, createdAt: r.created_at };
  }

  list(status?: Approval['status']): Approval[] {
    const rows = status ? this.db.prepare('SELECT id FROM approvals WHERE status = ? ORDER BY created_at').all(status) : this.db.prepare('SELECT id FROM approvals ORDER BY created_at').all();
    return (rows as any[]).map((r) => this.get(r.id)!);
  }

  decide(id: string, decision: 'approve' | 'deny', by: string, reason = ''): Approval {
    if (decision !== 'approve' && decision !== 'deny') throw new ValidationError('decision must be "approve" or "deny"');
    const a = this.get(id);
    if (!a) throw new NotFoundError(`approval "${id}" not found`);
    if (a.status !== 'pending') throw new ConflictError(`approval "${id}" is already ${a.status}`);
    const status = decision === 'approve' ? 'approved' : 'denied';
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?').run(status, by, now, reason, id);
      this.events.append({ type: 'approval.decided', actor: by, taskId: a.taskId, payload: { approvalId: id, decision: status, reason } });
    });
    const updated = this.get(id)!;
    this.waiters.get(id)?.(updated);
    this.waiters.delete(id);
    return updated;
  }

  /** Wait for a decision. Times out as "expired", which is treated as denied. */
  wait(id: string, timeoutMs: number): Promise<Approval> {
    const a = this.get(id);
    if (a && a.status !== 'pending') return Promise.resolve(a);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        const cur = this.get(id)!;
        if (cur.status === 'pending') {
          tx(this.db, () => {
            this.db.prepare("UPDATE approvals SET status = 'expired', decided_by = 'system', decided_at = ? WHERE id = ?").run(new Date().toISOString(), id);
            this.events.append({ type: 'approval.decided', actor: 'system', taskId: cur.taskId, payload: { approvalId: id, decision: 'expired', reason: 'No decision before timeout' } });
          });
        }
        resolve(this.get(id)!);
      }, timeoutMs);
      this.waiters.set(id, (x) => {
        clearTimeout(timer);
        resolve(x);
      });
    });
  }
}
