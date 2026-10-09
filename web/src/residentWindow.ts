// The resident window: one place to talk to a resident and see what it is doing.
// Chat history comes from Village Hall's database; replies come only from real runtimes. If a resident can't
// receive messages, the window says exactly why and the composer stays disabled. Nothing here invents a reply.
import { $, el } from './dom.ts';
import { api, type Store } from './store.ts';

type Tab = 'chat' | 'tasks' | 'approvals' | 'profile';

const HUMAN_STATUS: Record<string, string> = { pending: 'Sending…', delivered: 'Delivered', answered: '', undelivered: 'Not delivered', failed: 'Failed', stopped: 'Stopped' };
const REPLY_STATUS: Record<string, string> = { streaming: 'Answering…', complete: '', failed: 'Did not finish', stopped: 'Stopped', interrupted: 'Interrupted by a restart' };

export class ResidentWindow {
  private root = $('#resident');
  private store: Store;
  private places: Map<string, string>;
  private id: string | null = null;
  private building: string | null = null;
  private tab: Tab = 'chat';
  private detail: any = null;
  private drafts = new Map<string, string>();
  private loadSeq = 0;
  private reloadTimer: number | null = null;
  private notice = '';
  private confirmPaid = false;
  // persistent elements for the current resident
  private body!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private compose!: HTMLFormElement;
  onClose: () => void = () => {};

  constructor(store: Store, places: Map<string, string>) {
    this.store = store;
    this.places = places;
    store.onEvent((e) => this.handleEvent(e));
    store.onEphemeral((name, data) => name === 'chat.delta' && this.handleDelta(data));
  }

  get currentResident() {
    return this.id;
  }

  get currentBuilding() {
    return this.building;
  }

  /** Open for a building (all its residents, as tabs) and optionally a specific resident. */
  open(building: string | undefined, residentId?: string) {
    const all = this.store.state?.residents ?? [];
    const resident = residentId ? all.find((r: any) => r.id === residentId) : null;
    const b = resident?.building ?? building;
    const here = all.filter((r: any) => r.building === b);
    const pick = resident ?? [...here].sort((a: any, c: any) => Number(c.focus) - Number(a.focus))[0];
    if (!pick) return;
    if (this.id !== pick.id) {
      this.tab = 'chat';
      this.confirmPaid = false;
    }
    this.building = pick.building;
    this.switchTo(pick.id);
  }

  close() {
    if (this.id && this.textarea) this.drafts.set(this.id, this.textarea.value);
    this.id = null;
    this.building = null;
    this.detail = null;
    this.root.hidden = true;
    this.onClose();
  }

  private switchTo(id: string) {
    if (this.id && this.textarea) this.drafts.set(this.id, this.textarea.value);
    this.id = id;
    this.detail = null;
    this.notice = '';
    this.root.hidden = false;
    this.buildSkeleton();
    this.load();
  }

  private load() {
    const id = this.id;
    if (!id) return;
    const seq = ++this.loadSeq;
    api('GET', `/api/residents/${encodeURIComponent(id)}`)
      .then((d) => {
        if (seq !== this.loadSeq || id !== this.id) return;
        this.detail = d;
        this.render();
      })
      .catch((e) => {
        if (seq !== this.loadSeq) return;
        this.notice = `Could not load ${id}: ${(e as Error).message}`;
        this.render();
      });
  }

  private scheduleReload() {
    if (this.reloadTimer !== null) return;
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      this.load();
    }, 120);
  }

  private handleEvent(e: any) {
    if (!this.id) return;
    const id = this.id;
    const p = e.payload ?? {};
    if (e.actor === id || p.resident === id || /^(task|approval)\./.test(e.type) || e.type === 'doctor.completed' || e.type === 'resident.status_changed') this.scheduleReload();
  }

  private handleDelta(d: { resident: string; replyId: string; text: string }) {
    if (d.resident !== this.id || this.tab !== 'chat') return;
    const bubble = this.root.querySelector<HTMLElement>(`[data-reply="${CSS.escape(d.replyId)}"] .bubble`);
    if (!bubble) return this.scheduleReload();
    const list = bubble.closest('.rw-msgs') as HTMLElement;
    const stick = nearBottom(list);
    bubble.textContent = (bubble.textContent ?? '') + d.text;
    if (stick) list.scrollTop = list.scrollHeight;
  }

  // ---------- layout ----------

  private buildSkeleton() {
    const all = this.store.state?.residents ?? [];
    const here = all.filter((r: any) => r.building === this.building);
    this.body = el('section', { class: 'rw-body' });
    this.textarea = el('textarea', { rows: 2, maxlength: 8000, 'aria-label': 'Message' }) as HTMLTextAreaElement;
    this.textarea.value = this.drafts.get(this.id!) ?? '';
    this.textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.compose.requestSubmit();
      }
      ev.stopPropagation(); // keep village keyboard controls (WASD, P, [ ]) out of the composer
    });
    this.textarea.addEventListener('keyup', (ev) => ev.stopPropagation());
    this.textarea.addEventListener('input', () => this.renderComposeState());
    this.compose = el('form', { class: 'rw-compose' }, this.textarea, el('div', { class: 'row' }, el('span', { class: 'count muted' }), el('span', { class: 'spacer' }), el('button', { class: 'btn ghost stop', type: 'button', hidden: true, onclick: () => this.stop() }, 'Stop'), el('button', { class: 'btn primary send', type: 'submit' }, 'Send'))) as HTMLFormElement;
    this.compose.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.send();
    });
    const parts: HTMLElement[] = [el('header', { class: 'rw-head' })];
    if (here.length > 1)
      parts.push(
        el('div', { class: 'rw-switch', role: 'tablist', 'aria-label': `Residents of ${this.places.get(this.building!) ?? this.building}` },
            ...here.map((r: any) => el('button', { type: 'button', class: r.id === this.id ? 'active' : '', onclick: () => r.id !== this.id && this.switchTo(r.id) }, el('span', { class: `dot ${r.status}` }), r.displayName))),
      );
    parts.push(el('nav', { class: 'rw-tabs', role: 'tablist' }), this.body);
    this.root.replaceChildren(...parts);
    this.render();
  }

  private render() {
    if (!this.id) return;
    const r = this.detail?.resident ?? (this.store.state?.residents ?? []).find((x: any) => x.id === this.id);
    if (!r) return;
    const head = this.root.querySelector('.rw-head')!;
    const place = this.places.get(r.building) ?? r.building;
    head.replaceChildren(
      el('span', { class: 'rw-crest', style: `background:${r.appearance?.color ?? '#888'}` }),
      el('div', { class: 'rw-title' }, el('h3', {}, r.displayName), el('div', { class: 'hint' }, `${r.role} · ${place}`)),
      el('span', { class: `badge ${r.status === 'connected' ? 'connected' : r.status === 'untested' ? 'untested' : 'unavailable'}` }, r.status === 'untested' ? 'not checked' : r.status),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, '×'),
    );
    const d = this.detail;
    const tabs: [Tab, string][] = [['chat', 'Chat'], ['tasks', `Tasks${d?.tasks.length ? ` ${d.tasks.length}` : ''}`], ['approvals', `Approvals${d?.approvals.length ? ` ${d.approvals.length}` : ''}`], ['profile', 'Profile']];
    this.root.querySelector('.rw-tabs')!.replaceChildren(...tabs.map(([t, label]) => el('button', { type: 'button', role: 'tab', class: this.tab === t ? 'active' : '', onclick: () => { this.tab = t; this.render(); } }, label)));
    if (!d) {
      this.body.replaceChildren(el('p', { class: 'empty' }, this.notice || 'Loading…'));
      return;
    }
    if (this.tab === 'chat') this.renderChat();
    else if (this.tab === 'tasks') this.renderTasks();
    else if (this.tab === 'approvals') this.renderApprovals();
    else this.renderProfile();
  }

  private renderChat() {
    const d = this.detail;
    const r = d.resident;
    const prevList = this.body.querySelector<HTMLElement>('.rw-msgs');
    const stick = !prevList || nearBottom(prevList);
    const blocker: string | null = d.chat.blocker;
    const paidOff = !!blocker && d.billing?.paid && !d.billing.allowed && blocker.startsWith('Paid use is off');
    const conn = paidOff
      ? el('div', { class: 'rw-conn paid' }, el('strong', {}, 'Paid use is off. '), `${r.displayName} uses the ${d.billing.providerName}, which bills per use, so nothing is sent until you allow it. `, el('button', { class: 'btn ghost', type: 'button', onclick: () => { this.tab = 'profile'; this.confirmPaid = true; this.render(); } }, 'Review paid use'))
      : blocker
        ? el('div', { class: 'rw-conn off' }, el('strong', {}, "Can't receive messages. "), blocker, ' ', el('button', { class: 'btn ghost', type: 'button', onclick: () => $('#doctor').click() }, 'Check integrations'))
        : el('div', { class: 'rw-conn on' }, el('strong', {}, 'Connected. '), `Replies come from ${d.profile.runtime?.displayName ?? r.runtime}. `, d.billing?.paid ? el('span', { class: 'paid-note' }, `Paid use is on: each reply is billed to your ${d.billing.providerName} account.`) : (d.billing?.charges ?? ''));
    const msgs = d.chat.messages as any[];
    const partial = d.chat.partial as { replyId: string; text: string } | null;
    const list = el('ul', { class: 'rw-msgs', 'aria-live': 'polite' },
      ...(msgs.length
        ? msgs.map((m) => {
            const time = new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            if (m.role === 'human') {
              const st = HUMAN_STATUS[m.status] ?? m.status;
              return el('li', { class: `msg human ${m.status}` }, el('div', { class: 'bubble' }, m.body), el('div', { class: 'meta' }, time, st ? ` · ${st}` : '', m.reason ? `: ${m.reason}` : ''));
            }
            const text = m.status === 'streaming' && partial?.replyId === m.id ? partial.text : m.body;
            const st = REPLY_STATUS[m.status] ?? m.status;
            return el('li', { class: `msg resident ${m.status}`, 'data-reply': m.id }, el('div', { class: 'who' }, r.displayName), el('div', { class: 'bubble' }, text), el('div', { class: 'meta' }, time, st ? ` · ${st}` : '', m.reason ? `: ${m.reason}` : ''));
          })
        : [el('li', { class: 'empty' }, blocker ? `No messages yet. ${r.displayName} will be able to reply once it is connected.` : `No messages yet. Say hello to ${r.displayName}.`)]),
    );
    // Anything this resident is waiting for you to approve shows right in the conversation.
    const asks = (d.approvals as any[]).length
      ? el('div', { class: 'rw-asks' }, ...(d.approvals as any[]).map((a) => this.approvalCard(a, true)))
      : null;
    this.body.replaceChildren(...[conn, this.notice ? el('div', { class: 'rw-notice' }, this.notice) : null, list, asks, this.compose].filter((x): x is HTMLElement => !!x));
    if (stick) list.scrollTop = list.scrollHeight;
    else if (prevList) list.scrollTop = prevList.scrollTop;
    this.renderComposeState();
  }

  private renderComposeState() {
    const d = this.detail;
    if (!d || !this.compose) return;
    const blocker = d.chat.blocker;
    const busy = d.chat.busy;
    const len = this.textarea.value.trim().length;
    this.textarea.disabled = !!blocker;
    this.textarea.placeholder = blocker ? `${d.resident.displayName} can't receive messages right now` : busy ? `${d.resident.displayName} is answering…` : `Message ${d.resident.displayName} (Enter to send, Shift+Enter for a new line)`;
    (this.compose.querySelector('.send') as HTMLButtonElement).disabled = !!blocker || busy || !len;
    (this.compose.querySelector('.stop') as HTMLButtonElement).hidden = !busy;
    this.compose.querySelector('.count')!.textContent = this.textarea.value.length > 7000 ? `${this.textarea.value.length}/8000` : '';
  }

  private async send() {
    const id = this.id!;
    const text = this.textarea.value.trim();
    if (!text) return;
    this.notice = '';
    try {
      await api('POST', `/api/residents/${encodeURIComponent(id)}/chat`, { body: text });
      if (this.id === id) {
        this.textarea.value = '';
        this.drafts.delete(id);
      }
    } catch (e) {
      this.notice = `Not sent: ${(e as Error).message}`;
    }
    this.load();
  }

  private async stop() {
    try {
      await api('POST', `/api/residents/${encodeURIComponent(this.id!)}/chat/stop`);
    } catch (e) {
      this.notice = (e as Error).message;
    }
    this.load();
  }

  private renderTasks() {
    const d = this.detail;
    const form = el('form', { class: 'taskform' },
      el('input', { name: 'title', placeholder: `New task for ${d.resident.displayName}`, maxlength: 200, required: true }),
      el('textarea', { name: 'description', placeholder: 'Details (optional)', rows: 2 }),
      el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Tasks start only when a runtime adapter can run them.'), el('button', { class: 'btn primary', type: 'submit' }, 'Add task')),
    ) as HTMLFormElement;
    for (const f of form.querySelectorAll('input,textarea')) f.addEventListener('keydown', (ev) => ev.stopPropagation());
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      try {
        await api('POST', '/api/tasks', { title: data.get('title'), description: data.get('description'), assignee: this.id });
        form.reset();
      } catch (e) {
        this.notice = `Could not add task: ${(e as Error).message}`;
        this.render();
      }
    });
    this.body.replaceChildren(
      form,
      el('ul', { class: 'tasks' },
        ...(d.tasks.length
          ? [...d.tasks].reverse().map((t: any) =>
              el('li', {},
                el('div', { class: 'status' }, t.status.replace('_', ' ')),
                el('strong', {}, t.title),
                t.waitingReason ? el('div', { class: 'hint' }, t.waitingReason) : null,
                ['done', 'failed', 'cancelled'].includes(t.status) ? null : el('button', { class: 'btn ghost', type: 'button', onclick: () => api('POST', `/api/tasks/${t.id}/cancel`).catch((e) => ((this.notice = e.message), this.render())) }, 'Cancel'),
              ),
            )
          : [el('li', { class: 'empty' }, `No tasks assigned to ${d.resident.displayName}.`)]),
      ),
    );
  }

  private renderApprovals() {
    const d = this.detail;
    this.body.replaceChildren(
      el('ul', { class: 'approvals' },
        ...(d.approvals.length ? d.approvals.map((a: any) => this.approvalCard(a, false)) : [el('li', { class: 'empty' }, `Nothing from ${d.resident.displayName} is waiting for your approval.`)]),
      ),
    );
  }

  /** Provider, billing method, whether actions may cost money, and the Allow paid use switch. */
  private billingBlock(): HTMLElement {
    const d = this.detail;
    const b = d.billing;
    const name = d.resident.displayName;
    const kindLabel: Record<string, string> = { 'paid-api': 'Paid API, billed per use', subscription: 'Subscription (no per-use charges)', 'free-local': 'Free, runs on this machine' };
    const set = async (allowed: boolean) => {
      try {
        await api('PUT', `/api/residents/${encodeURIComponent(d.resident.id)}/paid-use`, allowed ? { allowed: true, acknowledge: true } : { allowed: false });
        this.confirmPaid = false;
      } catch (e) {
        this.notice = (e as Error).message;
      }
      this.load();
    };
    const when = b.changedAt ? ` (since ${new Date(b.changedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '';
    let control: HTMLElement | null = null;
    if (b.paid && b.allowed) control = el('div', { class: 'row' }, el('button', { class: 'btn danger', type: 'button', onclick: () => set(false) }, 'Turn paid use off'), el('span', { class: 'hint' }, 'Takes effect immediately and stops a paid reply in progress.'));
    else if (b.paid && this.confirmPaid)
      control = el('div', { class: 'rw-confirm' },
        el('strong', {}, `Allow ${name} to make requests billed to your ${b.providerName} account?`),
        el('ul', {},
          el('li', {}, `Every reply ${name} writes is a billed request. The village will not stop at a spending limit yet, so set a monthly limit in your provider's dashboard.`),
          el('li', {}, `${name}'s planned budget: $${d.profile.budget.perTaskUsd} per task, $${d.profile.budget.dailyUsd} per day (shown for reference; not enforced yet).`),
          el('li', {}, 'Only this resident is affected. You can turn it off at any time, including from the top bar.'),
        ),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => set(true) }, `Allow paid use for ${name}`), el('button', { class: 'btn ghost', type: 'button', onclick: () => { this.confirmPaid = false; this.render(); } }, 'Cancel')),
      );
    else if (b.paid) control = el('div', { class: 'row' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => { this.confirmPaid = true; this.render(); } }, 'Allow paid use…'));
    return el('div', { class: `rw-billing ${b.paid ? (b.allowed ? 'on' : 'off') : 'free'}` },
      el('h4', {}, 'Billing'),
      el('table', { class: 'rw-profile' },
        el('tr', {}, el('th', {}, 'Provider'), el('td', {}, b.providerName)),
        el('tr', {}, el('th', {}, 'Billing'), el('td', {}, kindLabel[b.kind] ?? b.kind)),
        el('tr', {}, el('th', {}, 'Costs money?'), el('td', {}, b.charges)),
        b.paid ? el('tr', {}, el('th', {}, 'Paid use'), el('td', {}, el('span', { class: `badge ${b.allowed ? 'installed' : 'unavailable'}` }, b.allowed ? 'allowed' : 'off'), when)) : null,
      ),
      control,
      b.paid ? el('div', { class: 'hint' }, 'API keys stay on Village Hall (in your .env). They are never sent to this page.') : null,
    );
  }

  /** One approval: what exactly the resident wants to do, and Approve / Deny. */
  private approvalCard(a: any, compact: boolean): HTMLElement {
    const det = a.detail ?? {};
    const decide = (decision: 'approve' | 'deny') => api('POST', `/api/approvals/${a.id}`, decision === 'approve' ? { decision } : { decision, reason: 'Denied in the resident window' }).catch((e) => ((this.notice = e.message), this.render()));
    let what: HTMLElement;
    if (a.kind === 'codex_command') what = el('div', {}, el('code', { class: 'rw-cmd' }, String(det.command ?? '')), el('div', { class: 'hint' }, `in ${det.cwd ?? ''}${det.reason ? ` · ${det.reason}` : ''}`));
    else if (a.kind === 'codex_file_change')
      what = el('div', {}, ...(det.changes ?? []).map((c: any) => el('details', { class: 'rw-diff' }, el('summary', {}, `${c.kind} ${relativeTo(String(c.path), String(det.workspace ?? ''))}`), el('pre', {}, c.diff || '(no preview)'))), det.reason ? el('div', { class: 'hint' }, det.reason) : null);
    else what = el('pre', { class: 'hint' }, JSON.stringify(det, null, 2).slice(0, 1200));
    return el(compact ? 'div' : 'li', { class: compact ? 'rw-ask' : '' },
      el('div', { class: 'status' }, `${compact ? 'Waiting for you · ' : ''}${a.kind.replace(/_/g, ' ')} · risk: ${a.risk}`),
      el('strong', {}, a.summary),
      what,
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: () => decide('approve') }, 'Approve'), el('button', { class: 'btn ghost', type: 'button', onclick: () => decide('deny') }, 'Deny')),
      el('div', { class: 'hint' }, 'If nobody answers within a few minutes, this is declined automatically.'),
    );
  }

  private renderProfile() {
    const d = this.detail;
    const p = d.profile;
    const r = d.resident;
    const row = (k: string, ...v: (Node | string | null)[]) => el('tr', {}, el('th', {}, k), el('td', {}, ...v));
    const billing: Record<string, string> = { 'paid-api': 'paid API (billed per use)', subscription: 'subscription', 'free-local': 'free, runs locally' };
    this.body.replaceChildren(
      this.billingBlock(),
      el('table', { class: 'rw-profile' },
        row('Role', r.role),
        row('Lives at', this.places.get(r.building) ?? r.building),
        row('Skills', el('span', { class: 'chips' }, ...p.capabilities.map((c: string) => el('span', { class: 'chip' }, c)))),
        row('Runtime', p.runtime ? `${p.runtime.displayName}` : r.runtime, el('div', { class: 'hint' }, p.runtime?.adapterEnabled ? 'Adapter enabled' : 'Adapter not enabled yet: this resident cannot reply or run tasks')),
        row('Provider', p.provider ? `${p.provider.displayName}` : r.provider, p.provider ? el('div', { class: 'hint' }, `${billing[p.provider.billing] ?? p.provider.billing}. ${p.provider.notes}`) : null),
        row('Model', p.model ?? 'runtime default'),
        row('Workspace', el('code', {}, p.workspace), el('div', { class: 'hint' }, 'The only folder this resident may change, and only with your approval.')),
        row('Permissions', p.permissions, el('div', { class: 'hint' }, 'Tools only through the Tool Gateway; anything that executes code always asks you first.')),
        row('Budget', `$${p.budget.perTaskUsd} per task · $${p.budget.dailyUsd} per day · ${p.budget.maxTurns} turns`),
        row('Verification', p.focus ? 'Focus resident: connects when its checks pass' : 'Kept disconnected until its own verification test passes'),
      ),
      el('h4', {}, 'Tools'),
      p.tools.length
        ? el('table', { class: 'checks' },
            ...p.tools.map((t: any) => el('tr', {}, el('td', {}, t.displayName, t.exclusive ? el('div', { class: 'hint' }, 'one resident at a time') : null), el('td', { class: 'muted' }, `allowed: ${t.allow.join(', ') || 'nothing'} · asks: ${t.ask.join(', ') || 'nothing'}`, t.classifiedTools ? '' : el('div', { class: 'hint' }, 'No tools on this server are classified yet, so none are exposed.')))))
        : el('p', { class: 'hint' }, 'No tool servers. Works through its runtime only.'),
      el('h4', {}, 'Integration checks'),
      r.parts.length
        ? el('table', { class: 'checks' }, ...r.parts.map((x: any) => el('tr', {}, el('td', {}, el('span', { class: `badge ${x.status}` }, x.status)), el('td', {}, x.name, el('div', { class: 'hint' }, x.summary)))))
        : el('p', { class: 'hint' }, r.reasons[0] ?? 'No checks yet.'),
    );
  }
}

/** Show a path relative to the resident's workspace when it is inside it. */
function relativeTo(p: string, root: string): string {
  if (!root) return p;
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const r = norm(root);
  return a.toLowerCase().startsWith(r.toLowerCase() + '/') ? a.slice(r.length + 1) : p;
}

function nearBottom(list: HTMLElement) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
}
