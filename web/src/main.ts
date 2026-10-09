// Virelune Agent Village web app: the control panel and the 3D village, both reading the same live state.
import { api, Store } from './store.ts';
import { BUILDINGS } from './village/buildings.ts';
import { CHOICES, parseChoice, PRESETS, type GraphicsChoice } from './village/graphics.ts';
import { deriveActivity, deriveVisuals, describeEvent } from './village/state.ts';
import type { LampInfo, VillageScene } from './village/scene.ts';

import { $, el } from './dom.ts';
import { ResidentWindow } from './residentWindow.ts';

const store = new Store();
let scene: VillageScene | null = null;
let selected: { building?: string; resident?: string } | null = null;
const residentWindow = new ResidentWindow(store, new Map(BUILDINGS.map((b) => [b.id, b.place])));
residentWindow.onClose = () => {
  selected = null;
  scene?.overview();
  renderResidents();
};

/** Open the resident window (and fly the camera there) for a building or a specific resident. */
function openResident(building?: string, resident?: string) {
  residentWindow.open(building, resident);
  selected = { building: residentWindow.currentBuilding ?? building, resident: residentWindow.currentResident ?? resident };
  const b = resident ? store.state?.residents.find((r: any) => r.id === resident)?.building : building;
  if (b) scene?.focusBuilding(b);
  renderResidents();
}

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
    scene.onSelect = (s) => openResident(s.building, s.resident);
    wireLamps(scene);
    wireGraphics(scene);
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

/** Per-browser conveniences; storage may be unavailable (private windows), so failures are ignored. */
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`virelune.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`virelune.${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

/** Graphics menu: Auto / High / Medium / Low, and the diagnostics display (G). */
function wireGraphics(sc: VillageScene) {
  let diag = prefs.get('diagnostics') === '1' || new URLSearchParams(location.search).has('stats');
  sc.setGraphics(parseChoice(prefs.get('graphics')));
  sc.setDiagnostics(diag);
  const btn = $<HTMLButtonElement>('#graphics');
  const menu = $('#gfxmenu');
  const render = () => {
    const g = sc.graphics();
    btn.textContent = `Graphics: ${g.choice === 'auto' ? `Auto (${g.preset.label})` : g.preset.label}`;
    menu.replaceChildren(
      el('div', { class: 'gfx-title' }, 'Graphics quality'),
      ...CHOICES.map((c) =>
        el('label', { class: 'gfx-opt' },
          el('input', { type: 'radio', name: 'gfx', value: c.id, checked: g.choice === c.id, onchange: () => { prefs.set('graphics', c.id); sc.setGraphics(c.id as GraphicsChoice); render(); } }),
          el('span', {}, el('strong', {}, c.label), el('span', { class: 'hint' }, c.id === 'auto' ? 'Starts at High and steps down only if frames stay slow.' : PRESETS[c.id as keyof typeof PRESETS].description)),
        ),
      ),
      el('label', { class: 'gfx-opt' }, el('input', { type: 'checkbox', checked: diag, onchange: (e: Event) => { diag = (e.target as HTMLInputElement).checked; prefs.set('diagnostics', diag ? '1' : '0'); sc.setDiagnostics(diag); } }), el('span', {}, el('strong', {}, 'Show diagnostics'), el('span', { class: 'hint' }, 'Frame rate, draw calls, triangles and what each part of the village costs (G).'))),
      el('div', { class: 'hint' }, 'Presets change only rendering cost. Every building, resident and landscape feature stays.'),
    );
  };
  sc.onGraphics = () => render();
  render();
  btn.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest('.gfx')) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key.toLowerCase() !== 'g' || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(t?.tagName ?? '')) return;
    diag = !diag;
    prefs.set('diagnostics', diag ? '1' : '0');
    sc.setDiagnostics(diag);
    render();
  });
}

/** Lamp posts: click one in the village to select it, then turn it. Rotations are saved to the shared layout. */
function wireLamps(sc: VillageScene) {
  api('GET', '/api/layout')
    .then((layout) => sc.applyLayout(layout))
    .catch(() => {}); // defaults stay
  const timers = new Map<string, number>();
  sc.onLampRotate = (id, rotation) => {
    clearTimeout(timers.get(id));
    // save shortly after the last turn, so clicking several times sends one request
    timers.set(id, window.setTimeout(() => {
      timers.delete(id);
      api('PUT', `/api/layout/lamps/${encodeURIComponent(id)}`, { rotation }).catch((e) => alertLine(`Could not save the lamp rotation: ${(e as Error).message}`));
    }, 400));
  };
  sc.onLampSelect = (info) => renderLampTool(sc, info);
}

function renderLampTool(sc: VillageScene, info: LampInfo | null) {
  const box = $('#lamptool');
  if (!info) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const turn = (d: number, label: string, title: string) => el('button', { class: 'btn ghost', type: 'button', title, onclick: () => sc.rotateSelectedLamp(d) }, label);
  box.replaceChildren(
    el('div', { class: 'lt-head' },
      el('strong', {}, 'Lamp post'),
      el('span', { class: 'muted' }, ` · ${info.label}`),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Done', onclick: () => sc.selectLamp(null) }, '×'),
    ),
    el('div', { class: 'lt-row' },
      turn(-45, '⟲ 45°', 'Turn left 45°'),
      turn(-15, '⟲ 15°', 'Turn left 15° ([ key, Shift for 5°)'),
      el("span", { class: "lt-angle" }, `${Math.round((360 - info.rotation) % 360)}°`),
      turn(15, '15° ⟳', 'Turn right 15° (] key, Shift for 5°)'),
      turn(45, '45° ⟳', 'Turn right 45°'),
    ),
    el('div', { class: 'lt-row' },
      el('button', { class: 'btn ghost', type: 'button', disabled: !info.custom, onclick: () => sc.resetSelectedLamp() }, 'Reset'),
      el('button', { class: 'btn primary', type: 'button', onclick: () => sc.selectLamp(null) }, 'Done'),
    ),
    el('div', { class: 'hint' }, '[ and ] turn it (Shift for 5°), Esc to finish. Saved to the village layout, so it is the same on every machine after a git pull.'),
  );
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
  renderPaid();
  renderResidents();
  renderFeed();
  renderTasks();
  renderApprovals();
  renderIntegrations();
  const { activeRuns } = deriveActivity(store.events);
  $('#truth').textContent = activeRuns.size
    ? `${activeRuns.size} real run${activeRuns.size === 1 ? '' : 's'} in progress. Everything that looks like work comes from real events.`
    : 'No resident is working right now. Every sign of work in the village comes from real backend events; lanterns, weather and the clock are ambient.';
  scene?.update(s.residents, deriveVisuals(s.residents, store.events));
}

/** Top bar: which residents may spend money right now, and an emergency stop. */
function renderPaid() {
  const s = store.state!;
  const on = s.residents.filter((r: any) => r.billing?.allowed);
  const box = $('#paid');
  if (!on.length) {
    box.className = 'paidbar off';
    box.title = 'No resident may make billed requests. Paid residents (Claude, Echo and their variants) need "Allow paid use" in their Profile.';
    box.replaceChildren('Paid use: off');
    return;
  }
  box.className = 'paidbar on';
  box.title = 'These residents may make requests billed to your API accounts.';
  box.replaceChildren(
    `Paid use on: ${on.map((r: any) => r.displayName).join(', ')}`,
    el('button', { class: 'btn danger', type: 'button', onclick: () => api('POST', '/api/paid-use/disable-all').catch((e) => alertLine(e.message)) }, 'Stop all paid use'),
  );
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
  // Grouped by where each resident lives, in village order (Town Hall first).
  const known = new Set(BUILDINGS.map((b) => b.id));
  const groups: { id: string; name: string; rs: any[] }[] = BUILDINGS.map((b) => ({ id: b.id, name: b.place, rs: s.residents.filter((r: any) => r.building === b.id) }));
  const elsewhere = s.residents.filter((r: any) => !known.has(r.building));
  if (elsewhere.length) groups.push({ id: '', name: 'Elsewhere', rs: elsewhere });
  const pick = (building: string, resident?: string) => openResident(building, resident);
  const { activeRuns } = deriveActivity(store.events);
  const answering = new Set(activeRuns.values());
  list.replaceChildren(
    ...groups
      .filter((g) => g.rs.length)
      .flatMap((g) => [
        el('li', { class: `group${selected?.building === g.id && !selected?.resident ? ' selected' : ''}`, onclick: () => g.id && pick(g.id) }, g.name),
        ...[...g.rs]
          .sort((a, b) => Number(b.focus) - Number(a.focus) || a.displayName.localeCompare(b.displayName))
          .map((r) =>
            el('li', { class: selected?.resident === r.id ? 'selected' : '', onclick: () => pick(r.building, r.id) },
              el('span', { class: `dot ${r.status}` }),
              el('span', { class: 'name' }, r.displayName, r.focus ? el('span', { class: 'tag' }, 'focus') : null, answering.has(r.id) ? el('span', { class: 'tag busy' }, 'working') : null, r.billing?.allowed ? el('span', { class: 'tag paid', title: 'Paid use allowed' }, 'paid') : null),
              el('span', { class: 'why' }, r.status === 'connected' ? 'Connected: integration checks passed' : r.reasons[0] ?? ''),
            ),
          ),
      ]),
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

boot();
