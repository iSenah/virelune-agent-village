// The append-only event log: the single source of truth for the control panel and the village.
import type { DB } from './db.ts';

export const EVENT_SCHEMA_VERSION = 1;

export type VillageEvent = {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  taskId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  schemaVersion: number;
};

export type NewEvent = {
  type: string;
  actor: string;
  taskId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
};

type Listener = (e: VillageEvent) => void;

const TYPE_PATTERN = /^[a-z]+(\.[a-z_]+)+$/;

export class EventLog {
  private db: DB;
  private listeners = new Set<Listener>();

  constructor(db: DB) {
    this.db = db;
  }

  /** Append one event. Call inside the same transaction as the state change it describes. */
  append(e: NewEvent): VillageEvent {
    if (!TYPE_PATTERN.test(e.type)) throw new Error(`Invalid event type: ${e.type}`);
    if (!e.actor) throw new Error('Event actor is required');
    const ts = new Date().toISOString();
    const payload = e.payload ?? {};
    const info = this.db
      .prepare('INSERT INTO events (ts, type, actor, task_id, run_id, payload_json, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ts, e.type, e.actor, e.taskId ?? null, e.runId ?? null, JSON.stringify(payload), EVENT_SCHEMA_VERSION);
    const event: VillageEvent = {
      seq: Number(info.lastInsertRowid),
      ts,
      type: e.type,
      actor: e.actor,
      taskId: e.taskId ?? null,
      runId: e.runId ?? null,
      payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
    };
    // Notify after the caller's transaction has a chance to commit; listeners must not throw.
    queueMicrotask(() => {
      for (const l of this.listeners) {
        try {
          l(event);
        } catch {
          /* a broken listener never breaks the log */
        }
      }
    });
    return event;
  }

  list(afterSeq = 0, limit = 500, types?: string[]): VillageEvent[] {
    const lim = Math.max(1, Math.min(limit, 5000));
    let rows: unknown[];
    if (types && types.length) {
      const ph = types.map(() => '?').join(',');
      rows = this.db
        .prepare(`SELECT * FROM events WHERE seq > ? AND type IN (${ph}) ORDER BY seq ASC LIMIT ?`)
        .all(afterSeq, ...types, lim);
    } else {
      rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, lim);
    }
    return rows.map(rowToEvent);
  }

  lastSeq(): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null };
    return r.s ?? 0;
  }

  latestOfType(type: string): VillageEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1').get(type);
    return r ? rowToEvent(r) : null;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function rowToEvent(r: any): VillageEvent {
  return {
    seq: Number(r.seq),
    ts: r.ts,
    type: r.type,
    actor: r.actor,
    taskId: r.task_id,
    runId: r.run_id,
    payload: JSON.parse(r.payload_json),
    schemaVersion: Number(r.schema_version),
  };
}
