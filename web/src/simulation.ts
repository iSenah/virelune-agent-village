// SIMULATION MODE (development only, open the village with ?simulate). Feeds made-up runs, approvals and outcomes
// straight into the browser's resident-life visuals so movement and state changes can be inspected. Nothing is
// sent to Village Hall: no events, no tasks, no approvals, no entries in the activity feed, no provider calls.
// A banner stays on screen the whole time. Turning it off returns the village to real activity.
import { el } from './dom.ts';

type Run = { runId: string; workplace: string; seq: number; kind: string; taskId: string | null; progress: { done: number; total: number; label: string | null } | null };
type Approval = { approvalId: string; workplace: string; seq: number; runId: string | null; taskId: string | null };
type Outcome = { result: 'completed' | 'failed' | 'stopped'; workplace: string; seq: number; at: string; runId: string | null; taskId: string | null };
type Act = { runs: Run[]; approvals: Approval[]; lastOutcome: Outcome | null };

export class Simulation {
  private acts: Record<string, Act> = {};
  // far above any real event number, so simulated outcomes always count as new
  private seq = 1_000_000_000;
  private n = 0;
  onChange: () => void = () => {};

  snapshot() {
    return { now: new Date().toISOString(), seq: this.seq, residents: structuredClone(this.acts), simulated: true };
  }

  private act(id: string): Act {
    return (this.acts[id] ??= { runs: [], approvals: [], lastOutcome: null });
  }

  start(resident: string, workplace: string, withProgress = false) {
    const id = `sim-run-${++this.n}`;
    this.act(resident).runs.push({ runId: id, workplace, seq: ++this.seq, kind: 'task', taskId: `sim-task-${this.n}`, progress: withProgress ? { done: 0, total: 4, label: 'steps' } : null });
    this.onChange();
  }

  progress(resident: string) {
    const r = this.act(resident).runs[0];
    if (r?.progress && r.progress.done < r.progress.total) r.progress = { ...r.progress, done: r.progress.done + 1 };
    this.onChange();
  }

  requestApproval(resident: string) {
    const r = this.act(resident).runs[0];
    if (!r) return;
    this.act(resident).approvals.push({ approvalId: `sim-approval-${++this.n}`, workplace: r.workplace, seq: ++this.seq, runId: r.runId, taskId: r.taskId });
    this.onChange();
  }

  approve(resident: string) {
    this.act(resident).approvals.shift();
    this.onChange();
  }

  end(resident: string, result: Outcome['result']) {
    const a = this.act(resident);
    const r = a.runs.shift();
    if (!r) return;
    a.approvals = a.approvals.filter((x) => x.runId !== r.runId);
    a.lastOutcome = { result, workplace: r.workplace, seq: ++this.seq, at: new Date().toISOString(), runId: r.runId, taskId: r.taskId };
    this.onChange();
  }

  reset() {
    this.acts = {};
    this.onChange();
  }
}

/**
 * The simulation panel. `residents` are those with a character; each can work at home or at any of its profiles'
 * workplaces. `places` names buildings.
 */
export function mountSimulationPanel(sim: Simulation, residents: () => { id: string; displayName: string; building: string; profiles?: { displayName: string; workplace: string }[] }[], places: () => Map<string, string>, onExit: () => void) {
  document.body.classList.add('simulating');
  const banner = el('div', { class: 'sim-banner', role: 'status' }, 'SIMULATION · not real activity. Nothing here is sent to Village Hall or written to the activity feed.');
  document.body.append(banner);
  const panel = el('section', { class: 'sim-panel', 'aria-label': 'Simulation controls' });
  document.body.append(panel);
  let who = '';
  let where = '';
  const render = () => {
    const rs = residents();
    if (!rs.some((r) => r.id === who)) who = rs[0]?.id ?? '';
    const r = rs.find((x) => x.id === who);
    const spots = r ? [[r.building, `${places().get(r.building) ?? r.building} (home)`], ...(r.profiles ?? []).map((p) => [p.workplace, `${places().get(p.workplace) ?? p.workplace} (${p.displayName})`])] : [];
    if (!spots.some(([id]) => id === where)) where = spots[0]?.[0] ?? '';
    const btn = (label: string, fn: () => void) => el('button', { class: 'btn ghost small', type: 'button', onclick: fn }, label);
    panel.replaceChildren(
      el('div', { class: 'gfx-title' }, 'Simulation (development only)'),
      el('label', {}, 'Resident ', el('select', { onchange: (e: Event) => { who = (e.target as HTMLSelectElement).value; render(); } }, ...rs.map((x) => el('option', { value: x.id, selected: x.id === who }, x.displayName)))),
      el('label', {}, 'Work at ', el('select', { onchange: (e: Event) => { where = (e.target as HTMLSelectElement).value; } }, ...spots.map(([id, label]) => el('option', { value: id, selected: id === where }, label)))),
      el('div', { class: 'chips' },
        btn('Start work', () => sim.start(who, where)),
        btn('Start with progress', () => sim.start(who, where, true)),
        btn('Progress +1', () => sim.progress(who)),
        btn('Ask approval', () => sim.requestApproval(who)),
        btn('Approve', () => sim.approve(who)),
        btn('Complete', () => sim.end(who, 'completed')),
        btn('Fail', () => sim.end(who, 'failed')),
        btn('Stop', () => sim.end(who, 'stopped')),
      ),
      el('div', { class: 'chips' }, btn('Clear simulation', () => sim.reset()), btn('Back to real activity', () => exit())),
      el('p', { class: 'hint' }, 'Several "Start work" presses give one resident several runs: the character goes to the oldest one.'),
    );
  };
  const exit = () => {
    panel.remove();
    banner.remove();
    document.body.classList.remove('simulating');
    onExit();
  };
  render();
  return { render };
}
