// Resident conversations. Every reply comes from a real runtime adapter; there is no fallback text.
// A message reaches a resident only when the resident is connected (real doctor checks) AND an adapter for its
// runtime is enabled. Otherwise the message is stored as "undelivered" with the honest reason, and nothing replies.
import crypto from 'node:crypto';
import type { BillingGuard } from './billing.ts';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import type { EventLog } from './events.ts';
import type { Registries, Resident } from './registry.ts';
import type { ResidentView } from './residents.ts';
import { ConflictError, NotFoundError, ValidationError } from './tasks.ts';

export const MAX_MESSAGE_CHARS = 8000;
const HISTORY_TURNS = 30;
const REPLY_TIMEOUT_MS = 10 * 60_000;

export type ChatRole = 'human' | 'resident';
/** human: pending -> delivered -> answered | failed | stopped, or pending -> undelivered. resident: streaming -> complete | failed | stopped | interrupted */
export type ChatStatus = 'pending' | 'delivered' | 'answered' | 'undelivered' | 'failed' | 'stopped' | 'streaming' | 'complete' | 'interrupted';

export type ChatMessage = {
  id: string;
  resident: string;
  thread: string;
  role: ChatRole;
  body: string;
  status: ChatStatus;
  reason: string | null;
  runId: string | null;
  replyTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatTurn = { role: ChatRole; body: string };

/** What an adapter gets for one reply. It must answer with real model output or throw. */
export type AdapterContext = {
  resident: Resident;
  /** The village run id for this reply (events and approvals made during the reply carry it). */
  runId: string;
  message: string;
  /** Earlier completed turns of this conversation, oldest first (not including `message`). */
  history: ChatTurn[];
  /** Adapter-owned state saved from the previous reply (e.g. a runtime thread id), or null. */
  threadState: string | null;
  signal: AbortSignal;
  /** Stream partial text as it arrives (optional). */
  onDelta: (text: string) => void;
  /**
   * Adapters for paid providers call this right before every provider request. It throws (and records a denied
   * request) if paid use is not allowed for this resident, e.g. because it was just switched off.
   */
  assertPaidAllowed: () => void;
};
export type AdapterReply = { text: string; threadState?: string | null };

export interface AgentAdapter {
  /** Runtime kind this adapter serves (matches config/runtimes/*.json "kind"). */
  readonly runtimeKind: string;
  reply(ctx: AdapterContext): Promise<AdapterReply>;
  /** Release processes and connections (village shutdown). */
  close?(): void | Promise<void>;
}

type Deps = {
  db: DB;
  events: EventLog;
  registries: () => Registries;
  residents: () => ResidentView[];
  adapters: Map<string, AgentAdapter>;
  billing: BillingGuard;
  replyTimeoutMs?: number;
};

export class ChatService {
  private d: Deps;
  private active = new Map<string, { controller: AbortController; runId: string; replyId: string; partial: string }>();

  constructor(deps: Deps) {
    this.d = deps;
  }

  /** Why a message to this resident cannot be delivered right now, or null if it can. */
  deliveryBlocker(residentId: string): string | null {
    const r = this.d.registries().residents.get(residentId);
    if (!r) return 'unknown resident';
    if (r.planned) return `${r.displayName} is a planned resident: its home is reserved, but no runtime or provider is connected yet, so nothing can answer.`;
    const v = this.d.residents().find((x) => x.id === residentId);
    if (!v || v.status !== 'connected') {
      const state = v?.status === 'untested' ? 'not checked yet' : 'disconnected';
      return `${r.displayName} is ${state}${v?.reasons[0] ? `: ${v.reasons[0]}` : ''}`;
    }
    const rt = this.d.registries().runtimes.get(r.runtime);
    if (!rt || !this.d.adapters.has(rt.kind)) return `${r.displayName}'s integrations pass their checks, but the ${rt?.displayName ?? r.runtime} adapter is not enabled yet, so nothing can answer.`;
    return this.d.billing.blocker(residentId);
  }

  isBusy(residentId: string): boolean {
    return this.active.has(residentId);
  }

  /** Text streamed so far for a reply in progress (not yet saved). */
  partial(residentId: string): { replyId: string; text: string } | null {
    const a = this.active.get(residentId);
    return a ? { replyId: a.replyId, text: a.partial } : null;
  }

  list(residentId: string, thread = 'main', limit = 200): ChatMessage[] {
    this.requireResident(residentId);
    const lim = Math.max(1, Math.min(limit, 1000));
    const rows = this.d.db.prepare('SELECT * FROM (SELECT rowid AS rid, * FROM chat_messages WHERE resident = ? AND thread = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid ASC').all(residentId, thread, lim) as any[];
    return rows.map(rowToMessage);
  }

  /**
   * Read-only history kept from before the Blender and Unreal variants became execution profiles of Claude and
   * Codex (their old conversations stay in the database; nothing new is ever added to them).
   */
  archived(principalId: string, limit = 200): ChatMessage[] {
    const reg = this.d.registries();
    if (!reg.principals?.has(principalId) || reg.residents.has(principalId)) throw new NotFoundError(`profile "${principalId}" not found`);
    const rows = this.d.db.prepare('SELECT * FROM (SELECT rowid AS rid, * FROM chat_messages WHERE resident = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid ASC').all(principalId, Math.max(1, Math.min(limit, 1000))) as any[];
    return rows.map(rowToMessage);
  }

  get(id: string): ChatMessage | null {
    const r = this.d.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as any;
    return r ? rowToMessage(r) : null;
  }

  /**
   * Store a message from the human and, only if the resident can really answer, start a reply in the background.
   * Returns the stored message immediately; follow progress through events.
   */
  send(residentId: string, rawBody: unknown, actor = 'human'): ChatMessage {
    const r = this.requireResident(residentId);
    const body = typeof rawBody === 'string' ? rawBody.trim() : '';
    if (!body) throw new ValidationError('message is empty');
    if (body.length > MAX_MESSAGE_CHARS) throw new ValidationError(`message must be ${MAX_MESSAGE_CHARS} characters or fewer`);
    if (this.active.has(residentId)) throw new ConflictError(`${r.displayName} is still answering your previous message`);
    const blocker = this.deliveryBlocker(residentId);
    const id = `m_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    tx(this.d.db, () => {
      this.d.db.prepare('INSERT INTO chat_messages (id, resident, thread, role, body, status, reason, run_id, reply_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, residentId, 'main', 'human', body, 'pending', null, null, null, now, now);
      this.d.events.append({ type: 'chat.message_sent', actor, payload: { messageId: id, resident: residentId, chars: body.length } });
      if (blocker) {
        // A refusal because paid use is off is also recorded as a denied billable request.
        if (blocker === this.d.billing.blocker(residentId)) this.d.billing.authorize(residentId, 'chat reply', { messageId: id });
        this.setStatus(id, 'undelivered', blocker);
        this.d.events.append({ type: 'chat.message_undelivered', actor: 'system', payload: { messageId: id, resident: residentId, reason: blocker } });
      }
    });
    if (!blocker) this.startReply(r, id, body);
    return this.get(id)!;
  }

  /** Stop a reply in progress. The partial text is kept and marked stopped. */
  stop(residentId: string, actor = 'human'): boolean {
    this.requireResident(residentId);
    const a = this.active.get(residentId);
    if (!a) return false;
    a.controller.abort(new StopRequested(actor));
    return true;
  }

  /** After a restart, replies that were in flight are marked interrupted. Nothing is resumed silently. */
  recoverAfterRestart(): number {
    const rows = this.d.db.prepare("SELECT id, reply_to FROM chat_messages WHERE status IN ('streaming', 'pending', 'delivered')").all() as any[];
    if (!rows.length) return 0;
    tx(this.d.db, () => {
      for (const row of rows) this.setStatus(row.id, row.reply_to ? 'interrupted' : 'failed', 'Village Hall restarted before the reply finished');
    });
    return rows.length;
  }

  private startReply(r: Resident, messageId: string, body: string) {
    const rt = this.d.registries().runtimes.get(r.runtime)!;
    const adapter = this.d.adapters.get(rt.kind)!;
    const runId = `r_${crypto.randomUUID().slice(0, 12)}`;
    const replyId = `m_${crypto.randomUUID().slice(0, 12)}`;
    const history = this.history(r.id, messageId);
    const threadState = (this.d.db.prepare("SELECT runtime_state FROM chat_threads WHERE resident = ? AND thread = 'main'").get(r.id) as any)?.runtime_state ?? null;
    const now = new Date().toISOString();
    tx(this.d.db, () => {
      this.setStatus(messageId, 'delivered', null, runId);
      this.d.db.prepare('INSERT INTO chat_messages (id, resident, thread, role, body, status, reason, run_id, reply_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(replyId, r.id, 'main', 'resident', '', 'streaming', null, runId, messageId, now, now);
      this.d.events.append({ type: 'run.started', actor: r.id, runId, payload: { kind: 'chat', runtime: rt.id, messageId, replyId } });
    });
    const controller = new AbortController();
    const limit = this.d.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error(`No reply within ${limit >= 60_000 ? `${Math.round(limit / 60_000)} minutes` : `${Math.round(limit / 1000)} seconds`}; the reply was stopped.`)), limit);
    const entry = { controller, runId, replyId, partial: '' };
    this.active.set(r.id, entry);
    const onDelta = (text: string) => {
      entry.partial += text;
      this.d.events.ephemeral('chat.delta', { resident: r.id, replyId, text });
    };
    Promise.resolve()
      .then(() => adapter.reply({ resident: r, runId, message: body, history, threadState, signal: controller.signal, onDelta, assertPaidAllowed: () => this.d.billing.assertAllowed(r.id, 'chat reply', { runId, messageId }) }))
      .then((out) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const text = typeof out?.text === 'string' ? out.text : '';
        if (!text.trim()) throw new Error('the runtime returned an empty reply');
        tx(this.d.db, () => {
          this.d.db.prepare("UPDATE chat_messages SET body = ?, status = 'complete', updated_at = ? WHERE id = ?").run(text, new Date().toISOString(), replyId);
          this.setStatus(messageId, 'answered', null);
          if (out.threadState !== undefined) this.d.db.prepare("INSERT INTO chat_threads (resident, thread, runtime_state, updated_at) VALUES (?, 'main', ?, ?) ON CONFLICT(resident, thread) DO UPDATE SET runtime_state = excluded.runtime_state, updated_at = excluded.updated_at").run(r.id, out.threadState, new Date().toISOString());
          this.d.events.append({ type: 'chat.reply_completed', actor: r.id, runId, payload: { messageId, replyId, chars: text.length } });
          this.d.events.append({ type: 'run.finished', actor: r.id, runId, payload: { kind: 'chat' } });
        });
      })
      .catch((err) => {
        const stopped = err instanceof StopRequested;
        const reason = stopped ? `Stopped by ${err.by}` : String((err as Error)?.message ?? err).slice(0, 500);
        tx(this.d.db, () => {
          this.d.db.prepare('UPDATE chat_messages SET body = ?, status = ?, reason = ?, updated_at = ? WHERE id = ?').run(entry.partial, stopped ? 'stopped' : 'failed', reason, new Date().toISOString(), replyId);
          this.setStatus(messageId, stopped ? 'stopped' : 'failed', reason);
          if (stopped) this.d.events.append({ type: 'run.interrupted', actor: r.id, runId, payload: { kind: 'chat', reason } });
          else this.d.events.append({ type: 'run.failed', actor: r.id, runId, payload: { kind: 'chat', error: reason } });
        });
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.active.get(r.id) === entry) this.active.delete(r.id);
      });
  }

  private history(residentId: string, excludeId: string): ChatTurn[] {
    const rows = this.d.db
      .prepare("SELECT role, body FROM (SELECT rowid AS rid, role, body, status, id FROM chat_messages WHERE resident = ? AND thread = 'main' AND id != ? AND status IN ('answered', 'complete') ORDER BY rowid DESC LIMIT ?) ORDER BY rid ASC")
      .all(residentId, excludeId, HISTORY_TURNS) as any[];
    return rows.map((x) => ({ role: x.role, body: x.body }));
  }

  private setStatus(id: string, status: ChatStatus, reason: string | null, runId?: string) {
    if (runId) this.d.db.prepare('UPDATE chat_messages SET status = ?, reason = ?, run_id = ?, updated_at = ? WHERE id = ?').run(status, reason, runId, new Date().toISOString(), id);
    else this.d.db.prepare('UPDATE chat_messages SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, new Date().toISOString(), id);
  }

  private requireResident(id: string): Resident {
    const r = this.d.registries().residents.get(id);
    if (!r) throw new NotFoundError(`resident "${id}" not found`);
    return r;
  }
}

class StopRequested extends Error {
  by: string;
  constructor(by: string) {
    super('stopped');
    this.by = by;
  }
}

function rowToMessage(r: any): ChatMessage {
  return { id: r.id, resident: r.resident, thread: r.thread, role: r.role, body: r.body, status: r.status, reason: r.reason, runId: r.run_id, replyTo: r.reply_to, createdAt: r.created_at, updatedAt: r.updated_at };
}
