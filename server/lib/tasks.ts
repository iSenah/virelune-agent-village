// Task engine: persistent queue with dependencies, validated status transitions, and honest waiting reasons.
// In this milestone no runtime adapter is enabled, so the engine never moves a task to "running" by itself.
import crypto from 'node:crypto';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import type { EventLog } from './events.ts';

export type TaskStatus = 'draft' | 'ready' | 'blocked' | 'running' | 'awaiting_approval' | 'review' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export const TERMINAL: TaskStatus[] = ['done', 'failed', 'cancelled'];

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['ready', 'blocked', 'cancelled'],
  ready: ['draft', 'blocked', 'running', 'cancelled'],
  blocked: ['draft', 'ready', 'cancelled'],
  running: ['awaiting_approval', 'review', 'failed', 'cancelled', 'interrupted'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'interrupted'],
  review: ['done', 'ready', 'failed', 'cancelled'],
  interrupted: ['ready', 'cancelled'],
  done: [],
  failed: ['ready'],
  cancelled: [],
};

export type Task = {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  project: string | null;
  status: TaskStatus;
  waitingReason: string | null;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
};

export type NewTask = { title: string; description?: string; assignee?: string | null; project?: string | null; dependsOn?: string[] };

/** Tells the engine whether a resident could take work right now, and why not. */
export type ResidentReadiness = (residentId: string) => { known: boolean; ready: boolean; reason: string };

export class ValidationError extends Error {
  status = 400;
}
export class NotFoundError extends Error {
  status = 404;
}
export class ConflictError extends Error {
  status = 409;
}

export class TaskEngine {
  private db: DB;
  private events: EventLog;
  private readiness: ResidentReadiness;

  constructor(db: DB, events: EventLog, readiness: ResidentReadiness) {
    this.db = db;
    this.events = events;
    this.readiness = readiness;
  }

  create(input: NewTask, actor = 'human'): Task {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('title is required');
    if (title.length > 200) throw new ValidationError('title must be 200 characters or fewer');
    const description = String(input.description ?? '').slice(0, 10_000);
    const assignee = input.assignee ? String(input.assignee) : null;
    if (assignee && !this.readiness(assignee).known) throw new ValidationError(`unknown resident "${assignee}"`);
    const deps = [...new Set(input.dependsOn ?? [])];
    for (const d of deps) if (!this.get(d)) throw new ValidationError(`dependency "${d}" does not exist`);
    const id = `t_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    return tx(this.db, () => {
      this.db.prepare('INSERT INTO tasks (id, title, description, assignee, project, status, waiting_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, description, assignee, input.project ?? null, 'draft', null, now, now);
      for (const d of deps) this.db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)').run(id, d);
      this.events.append({ type: 'task.created', actor, taskId: id, payload: { title, assignee, dependsOn: deps, project: input.project ?? null } });
      this.evaluateOne(id, 'system');
      return this.get(id)!;
    });
  }

  get(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!r) return null;
    const deps = (this.db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?').all(id) as any[]).map((d) => d.depends_on);
    return { id: r.id, title: r.title, description: r.description, assignee: r.assignee, project: r.project, status: r.status, waitingReason: r.waiting_reason, dependsOn: deps, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  list(): Task[] {
    return (this.db.prepare('SELECT id FROM tasks ORDER BY created_at ASC').all() as any[]).map((r) => this.get(r.id)!);
  }

  /** Validated transition with an event, in one transaction. */
  transition(id: string, to: TaskStatus, actor: string, reason: string | null = null): Task {
    const t = this.get(id);
    if (!t) throw new NotFoundError(`task "${id}" not found`);
    if (t.status === to && t.waitingReason === reason) return t;
    if (t.status !== to && !TRANSITIONS[t.status].includes(to)) throw new ConflictError(`cannot move task from ${t.status} to ${to}`);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET status = ?, waiting_reason = ?, updated_at = ? WHERE id = ?').run(to, reason, now, id);
    this.events.append({ type: 'task.status_changed', actor, taskId: id, payload: { from: t.status, to, reason } });
    return this.get(id)!;
  }

  cancel(id: string, actor = 'human'): Task {
    const current = this.get(id);
    if (!current) throw new NotFoundError(`task "${id}" not found`);
    if (TERMINAL.includes(current.status)) throw new ConflictError(`task is already ${current.status}`);
    return tx(this.db, () => {
      const t = this.transition(id, 'cancelled', actor, 'Cancelled');
      this.evaluateAll('system');
      return t;
    });
  }

  /** Recompute where each waiting task stands. Never starts work: no adapter is enabled in this milestone. */
  evaluateAll(actor = 'system'): void {
    for (const t of this.list()) if (!TERMINAL.includes(t.status) && !['running', 'awaiting_approval', 'review', 'interrupted'].includes(t.status)) this.evaluateOne(t.id, actor);
  }

  private evaluateOne(id: string, actor: string): void {
    const t = this.get(id)!;
    const deps = t.dependsOn.map((d) => this.get(d)!);
    const failedDep = deps.find((d) => d.status === 'failed' || d.status === 'cancelled');
    if (failedDep) {
      this.transition(id, 'blocked', actor, `Dependency "${failedDep.title}" is ${failedDep.status}`);
      return;
    }
    const pending = deps.filter((d) => d.status !== 'done');
    if (pending.length) {
      this.transition(id, 'blocked', actor, `Waiting for ${pending.length} dependenc${pending.length === 1 ? 'y' : 'ies'}`);
      return;
    }
    if (!t.assignee) {
      this.transition(id, 'draft', actor, 'Needs an assignee (Echo plans in Supervised mode need your approval)');
      return;
    }
    const r = this.readiness(t.assignee);
    if (!r.ready) {
      this.transition(id, 'ready', actor, r.reason);
      return;
    }
    this.transition(id, 'ready', actor, 'Resident is available, but runtime adapters are not enabled in this milestone');
  }

  /** On startup, anything that was mid-run is marked interrupted. Nothing is resumed silently. */
  recoverAfterRestart(): number {
    const stuck = this.list().filter((t) => t.status === 'running' || t.status === 'awaiting_approval');
    for (const t of stuck) tx(this.db, () => this.transition(t.id, 'interrupted', 'system', 'Village Hall restarted during this run'));
    return stuck.length;
  }

  /** Detect dependency cycles (used by tests and by future plan validation). */
  static hasCycle(edges: Map<string, string[]>): boolean {
    const state = new Map<string, 1 | 2>();
    const visit = (n: string): boolean => {
      if (state.get(n) === 1) return true;
      if (state.get(n) === 2) return false;
      state.set(n, 1);
      for (const m of edges.get(n) ?? []) if (visit(m)) return true;
      state.set(n, 2);
      return false;
    };
    for (const n of edges.keys()) if (visit(n)) return true;
    return false;
  }
}
