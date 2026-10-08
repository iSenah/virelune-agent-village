// Virelune Agent Village web app: the control panel and the 3D village, both reading the same live state.
import { api, Store } from './store.ts';
import { deriveActivity, deriveVisuals, describeEvent } from './village/state.ts';
import type { VillageScene } from './village/scene.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Tiny DOM builder. Text is always set via textContent, so agent-provided strings can never inject HTML. */
function el(tag: string, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const store = new Store();
let scene: VillageScene | null = null;
let selected: { building?: string; resident?: string } | null = null;

async function boot() {
  try {
    const { VillageScene } = await import('./village/scene.ts');
    const { onModelStatus } = await import('./village/models.ts');
    onModelStatus((m) => {
      const badge = $('#models');
      if (!m.total) return;
      badge.hidden = false;
      badge.textContent = m.failed.length ? `Models ${m.loaded}/${m.total} · ${m.failed.length} using placeholder` : m.loaded < m.total ? `Loading models ${m.loaded}/${m.total}` : `Models ${m.loaded}/${m.total}`;
      badge.className = `live ${m.failed.length ? 'off' : 'on'}`;
      badge.title = m.failed.length ? `Could not load: ${m.failed.map((f) => `${f.key} (${f.file}: ${f.error})`).join('; ')}. Placeholders are shown instead.` : 'Custom 3D models';
    });
    scene = new VillageScene($<HTMLCanvasElement>('#village'));
    scene.onSelect = (s) => {
      selected = s;
      if (s.building) scene!.focusBuilding(s.building);
      renderDetail();
    };
  } catch (e) {
    // The control panel keeps working even if 3D cannot start (old GPU, WebGL disabled).
    $('#truth').textContent = `The 3D village could not start (${(e as Error).message}). The control panel still works.`;
  }
  store.subscribe(render);
  wireControls();
  try {
    await store.start();
  } catch (e) {
    $('#machine').textContent = `Cannot reach Village Hall: ${(e as Error).message}`;
  }
}

function wireControls() {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', (p as HTMLElement).dataset.pane === b.dataset.tab));
    }),
  );
  $('#doctor').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#doctor');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await api('POST', '/api/doctor/run', { live: true });
    } catch (e) {
      alertLine(`Integration check failed: ${(e as Error).message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check integrations';
    }
  });
  const togglePanels = () => document.body.classList.toggle('panels-hidden');
  $('#panels').addEventListener('click', togglePanels);
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'p' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) togglePanels();
  });
  $('#daynight').addEventListener('click', () => {
    if (!scene) return;
    scene.setNight(!scene.isNight());
    $('#daynight').textContent = scene.isNight() ? 'Day' : 'Night';
  });
  $<HTMLFormElement>('#taskForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const data = new FormData(f);
    try {
      await api('POST', '/api/tasks', { title: data.get('title'), description: data.get('description'), assignee: data.get('assignee') || null });
      f.reset();
    } catch (e) {
      alertLine(`Could not add task: ${(e as Error).message}`);
    }
  });
}

function alertLine(msg: string) {
  $('#truth').textContent = msg;
}

function names(): Map<string, string> {
  return new Map((store.state?.residents ?? []).map((r: any) => [r.id, r.displayName]));
}

function render() {
  const s = store.state;
  const live = $('#live');
  live.textContent = store.connected ? 'live' : 'offline';
  live.className = `live ${store.connected ? 'on' : 'off'}`;
  if (!s) return;
  $('#machine').textContent = `${s.machine} · ${s.platform} · ${s.residents.length} residents registered`;
  renderAutonomy();
  renderResidents();
  renderFeed();
  renderTasks();
  renderApprovals();
  renderIntegrations();
  renderDetail();
  const { activeRuns } = deriveActivity(store.events);
  $('#truth').textContent = activeRuns.size
    ? `${activeRuns.size} real run${activeRuns.size === 1 ? '' : 's'} in progress. Everything that looks like work comes from real events.`
    : 'No resident is working right now. Every sign of work in the village comes from real backend events; lanterns, weather and the clock are ambient.';
  scene?.update(s.residents, deriveVisuals(s.residents, store.events));
}

function renderAutonomy() {
  const s = store.state!;
  const box = $('#autonomy');
  box.replaceChildren(
    ...s.echo.levels.map((l) =>
      el('button', {
        type: 'button',
        class: l.id === s.echo.autonomy ? 'active' : '',
        disabled: !l.available,
        title: l.description,
        onclick: async () => {
          try {
            await api('PUT', '/api/settings/echo-autonomy', { level: l.id });
          } catch (e) {
            alertLine((e as Error).message);
          }
        },
      }, l.label + (l.available ? '' : ' (soon)')),
    ),
  );
}

function renderResidents() {
  const s = store.state!;
  const list = $('#residents');
  const order = { connected: 0, untested: 1, disconnected: 2 } as Record<string, number>;
  const rs = [...s.residents].sort((a, b) => Number(b.focus) - Number(a.focus) || order[a.status] - order[b.status]);
  list.replaceChildren(
    ...rs.map((r) =>
      el('li', { class: selected?.resident === r.id ? 'selected' : '', onclick: () => { selected = { building: r.building, resident: r.id }; scene?.focusBuilding(r.building); renderDetail(); render(); } },
        el('span', { class: `dot ${r.status}` }),
        el('span', { class: 'name' }, r.displayName, r.focus ? el('span', { class: 'tag' }, 'focus') : null),
        el('span', { class: 'why' }, r.status === 'connected' ? 'Connected: integration checks passed' : r.reasons[0] ?? ''),
      ),
    ),
  );
  const sel = document.querySelector<HTMLSelectElement>('#taskForm select[name=assignee]')!;
  if (sel.options.length !== s.residents.length + 1) {
    sel.replaceChildren(el('option', { value: '' }, 'No assignee (Echo plans it)'), ...s.residents.map((r: any) => el('option', { value: r.id }, r.displayName)));
  }
}

function renderFeed() {
  const n = names();
  const items = store.events.slice(-200).reverse();
  $('#feed').replaceChildren(
    ...(items.length
      ? items.map((e) => el('li', {}, describeEvent(e, n), el('div', { class: 'meta' }, `#${e.seq} · ${new Date(e.ts).toLocaleTimeString()} · ${e.type}`)))
      : [el('li', { class: 'empty' }, 'No events yet.')]),
  );
}

function renderTasks() {
  const s = store.state!;
  const n = names();
  $('#tasks').replaceChildren(
    ...(s.tasks.length
      ? [...s.tasks].reverse().map((t: any) =>
          el('li', {},
            el('div', { class: 'status' }, t.status.replace('_', ' ')),
            el('strong', {}, t.title),
            el('div', { class: 'hint' }, `${t.assignee ? n.get(t.assignee) ?? t.assignee : 'Unassigned'}${t.waitingReason ? ` · ${t.waitingReason}` : ''}`),
            ['done', 'failed', 'cancelled'].includes(t.status) ? null : el('button', { class: 'btn ghost', type: 'button', onclick: () => api('POST', `/api/tasks/${t.id}/cancel`).catch((e) => alertLine(e.message)) }, 'Cancel'),
          ),
        )
      : [el('li', { class: 'empty' }, 'No tasks yet.')]),
  );
}

function renderApprovals() {
  const s = store.state!;
  $('#approvalCount').textContent = s.approvals.length ? String(s.approvals.length) : '';
  $('#approvals').replaceChildren(
    ...(s.approvals.length
      ? s.approvals.map((a: any) =>
          el('li', {},
            el('div', { class: 'status' }, `${a.kind.replace('_', ' ')} · risk: ${a.risk}`),
            el('strong', {}, a.summary),
            el('pre', { class: 'hint' }, JSON.stringify(a.detail, null, 2).slice(0, 1200)),
            el('div', { class: 'actions' },
              el('button', { class: 'btn primary', type: 'button', onclick: () => api('POST', `/api/approvals/${a.id}`, { decision: 'approve' }).catch((e) => alertLine(e.message)) }, 'Approve'),
              el('button', { class: 'btn ghost', type: 'button', onclick: () => api('POST', `/api/approvals/${a.id}`, { decision: 'deny', reason: 'Denied in the control panel' }).catch((e) => alertLine(e.message)) }, 'Deny'),
            ),
          ),
        )
      : [el('li', { class: 'empty' }, 'Nothing is waiting for your approval.')]),
  );
}

function renderIntegrations() {
  const s = store.state!;
  const box = $('#integrations');
  if (!s.doctor.results) {
    box.replaceChildren(el('p', { class: 'empty' }, 'No integration check has run on this machine yet. Press "Check integrations".'));
    return;
  }
  box.replaceChildren(
    ...s.doctor.results.map((r: any) =>
      el('div', {},
        el('h3', { style: 'font-size:15px;margin:10px 0 4px' }, r.name, ' ', el('span', { class: `badge ${r.status}` }, r.status)),
        el('div', { class: 'hint' }, r.summary, r.costs ? ` Cost: ${r.costs}` : ''),
        el('table', { class: 'checks' }, ...r.checks.map((c: any) => el('tr', {}, el('td', {}, c.result.toUpperCase()), el('td', {}, c.name), el('td', { class: 'muted' }, c.detail)))),
      ),
    ),
  );
}

function renderDetail() {
  const box = $('#detail');
  const s = store.state;
  if (!selected || !s) {
    box.hidden = true;
    return;
  }
  const rs = s.residents.filter((r: any) => (selected!.resident ? r.id === selected!.resident : r.building === selected!.building));
  if (!rs.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren(
    el('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: () => { selected = null; scene?.overview(); renderDetail(); } }, '×'),
    ...rs.flatMap((r: any) => [
      el('h3', {}, r.displayName),
      el('div', { class: 'hint' }, r.role),
      el('div', {}, el('span', { class: `badge ${r.status === 'connected' ? 'connected' : r.status === 'untested' ? 'untested' : 'unavailable'}` }, r.status), ` runtime: ${r.runtime} · provider: ${r.provider}${r.model ? ` · model: ${r.model}` : ''}`),
      r.reasons.length ? el('ul', { class: 'hint' }, ...r.reasons.map((x: string) => el('li', {}, '• ' + x))) : null,
      r.parts.length ? el('table', { class: 'checks' }, ...r.parts.map((p: any) => el('tr', {}, el('td', {}, el('span', { class: `badge ${p.status}` }, p.status)), el('td', {}, p.name)))) : null,
    ]),
  );
}

boot();
