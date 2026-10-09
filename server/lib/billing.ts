// Paid API safeguards. Residents whose provider bills per use ("paid-api", e.g. the Anthropic and OpenAI APIs)
// may only make model requests while you have switched on "Allow paid use" for that resident.
// - Off by default, for every resident, on every machine. Nothing turns it on except an explicit request from
//   the control panel (PUT /api/residents/<id>/paid-use with acknowledge: true). No .env setting enables it.
// - Checked on the server before every billable request (chat replies now, task runs later), and again by the
//   adapter right before it calls the provider. Switching it off stops any paid reply in progress.
// - Each resident has its own switch: allowing Claude does not allow Claude · Blender or Echo.
// - Every change and every refused request is recorded in the event log.
// Plan-based residents (Codex through your ChatGPT plan) and free local ones (Ollama) are not billed per use and
// need no switch; Codex still refuses API-key sign-ins on its own.
import type { DB } from './db.ts';
import { tx } from './db.ts';
import type { EventLog } from './events.ts';
import type { Registries } from './registry.ts';
import { NotFoundError, ValidationError } from './tasks.ts';

export type BillingInfo = {
  /** Provider billing kind from config/providers: paid-api | subscription | free-local */
  kind: string;
  providerName: string;
  /** True when requests cost money per use and need the switch. */
  paid: boolean;
  /** Whether paid use is currently allowed for this resident (always false for non-paid residents). */
  allowed: boolean;
  changedAt: string | null;
  changedBy: string | null;
  /** Plain-language answer to "can this resident's actions cost me money?" */
  charges: string;
};

type Stored = { allowed: boolean; changedAt: string; changedBy: string };

const KEY = (residentId: string) => `paid_use.${residentId}`;

export class BillingGuard {
  private db: DB;
  private events: EventLog;
  private registries: () => Registries;
  /** Called when paid use is switched off, to stop paid work in progress for that resident. */
  onRevoked: (residentId: string) => void = () => {};

  constructor(db: DB, events: EventLog, registries: () => Registries) {
    this.db = db;
    this.events = events;
    this.registries = registries;
  }

  private stored(residentId: string): Stored | null {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(KEY(residentId)) as any;
    if (!r) return null;
    try {
      const v = JSON.parse(r.value_json);
      return { allowed: v?.allowed === true, changedAt: String(v?.changedAt ?? ''), changedBy: String(v?.changedBy ?? '') };
    } catch {
      return null; // unreadable means not allowed
    }
  }

  info(residentId: string): BillingInfo {
    const reg = this.registries();
    const r = reg.residents.get(residentId);
    if (!r) throw new NotFoundError(`resident "${residentId}" not found`);
    const pv = reg.providers.get(r.provider);
    const kind = pv?.billing ?? 'unknown';
    // Unknown billing is treated as paid: fail safe.
    const paid = kind !== 'subscription' && kind !== 'free-local';
    const s = this.stored(residentId);
    const allowed = paid && s?.allowed === true;
    const providerName = pv?.displayName ?? r.provider;
    const charges = !paid
      ? kind === 'free-local'
        ? 'No. Runs on this machine for free.'
        : `No per-use charges. Uses your ${providerName} subscription, within its limits.`
      : allowed
        ? `Yes. Each reply is billed to your ${providerName} account.`
        : `It would: each reply would be billed to your ${providerName} account, so nothing is sent until you allow paid use.`;
    return { kind, providerName, paid, allowed, changedAt: s?.changedAt || null, changedBy: s?.changedBy || null, charges };
  }

  /** null if a billable request may go ahead now; otherwise the reason it may not. Does not record anything. */
  blocker(residentId: string): string | null {
    const b = this.info(residentId);
    if (!b.paid || b.allowed) return null;
    const name = this.registries().residents.get(residentId)!.displayName;
    return `Paid use is off for ${name}. ${name} uses the ${b.providerName}, which bills per use. Allow paid use in ${name}'s Profile to let it reply.`;
  }

  /**
   * Gate a billable request. Records a billing.request_denied event when refused.
   * Returns null when allowed, or the reason when refused.
   */
  authorize(residentId: string, purpose: string, ref: Record<string, unknown> = {}): string | null {
    const why = this.blocker(residentId);
    if (why) {
      const b = this.info(residentId);
      this.events.append({ type: 'billing.request_denied', actor: 'system', payload: { resident: residentId, provider: this.registries().residents.get(residentId)!.provider, billing: b.kind, purpose, reason: why, ...ref } });
    }
    return why;
  }

  /** For adapters, right before calling a paid provider: throws if paid use is (no longer) allowed. */
  assertAllowed(residentId: string, purpose: string, ref: Record<string, unknown> = {}) {
    const why = this.authorize(residentId, purpose, ref);
    if (why) throw new Error(why);
  }

  /**
   * Switch paid use on or off for one resident. Turning it on needs `acknowledge: true` (the control panel asks
   * you first); turning it off never does and takes effect immediately.
   */
  set(residentId: string, allowed: unknown, acknowledge: unknown, actor = 'human'): BillingInfo {
    if (typeof allowed !== 'boolean') throw new ValidationError('allowed must be true or false');
    const before = this.info(residentId);
    if (!before.paid) throw new ValidationError(`${this.registries().residents.get(residentId)!.displayName} is not billed per use, so there is no paid-use switch.`);
    if (allowed && acknowledge !== true) throw new ValidationError('Allowing paid use needs acknowledge: true (you confirm that replies will be billed to your provider account).');
    if (before.allowed === allowed) return before;
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(KEY(residentId), JSON.stringify({ allowed, changedAt: now, changedBy: actor }));
      this.events.append({ type: 'billing.paid_use_changed', actor, payload: { resident: residentId, allowed, provider: this.registries().residents.get(residentId)!.provider, billing: before.kind } });
    });
    if (!allowed) this.onRevoked(residentId);
    return this.info(residentId);
  }

  /** Emergency stop: switch paid use off for every resident at once. Returns the residents that were on. */
  disableAll(actor = 'human'): string[] {
    const on = [...this.registries().residents.keys()].filter((id) => this.info(id).allowed);
    for (const id of on) this.set(id, false, false, actor);
    return on;
  }
}
