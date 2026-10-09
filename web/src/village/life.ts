// Resident life: where each resident's ONE character is and what it is doing, derived only from Village Hall's
// activity snapshot (real runs, approvals and outcomes). Pure TypeScript (no three.js, no DOM), so it is tested
// in Node. Visual state is kept separate from task state: the backend decides what is happening; this module only
// decides how the character gets there and what it looks like on the way.
//
// Destination rule (deterministic, documented in docs/v3a-resident-life.md):
//   1. If the resident has pending approvals, the oldest one wins: stand outside that workplace's door.
//   2. Otherwise, if it has active runs, the earliest-started one wins (ties: lower run id): work inside that
//      workplace (a profile's workplace, or home for work without a profile).
//   3. Otherwise go home. Queued or ready tasks never move a character; only active runs do.
import { BRIDGE_SPAN, buildingRotY, groundY, route, walkGraph, type Vec3, type WalkGraph, type World } from './worldModel.ts';

export type LifeState = 'idle_home' | 'waking' | 'traveling_to_work' | 'working' | 'awaiting_approval' | 'task_completed' | 'task_failed' | 'returning_home';

export type ActiveRunLike = { runId: string; workplace: string; seq: number; taskId?: string | null; kind?: string; progress?: { done: number; total: number; label: string | null } | null };
export type ApprovalLike = { approvalId: string; workplace: string; seq: number; runId?: string | null; taskId?: string | null };
export type OutcomeLike = { result: 'completed' | 'failed' | 'stopped'; workplace: string; seq: number; at: string; runId?: string | null; taskId?: string | null };
export type ResidentActivityLike = { runs: ActiveRunLike[]; approvals: ApprovalLike[]; lastOutcome: OutcomeLike | null };

export type Desired = { mode: 'home' } | { mode: 'work'; workplace: string; ref: string } | { mode: 'approval'; workplace: string; ref: string };

export const LIFE_CONFIG = {
  /** Walking speed, metres per second. */
  walkSpeed: 4,
  /** How long waking up takes before leaving home. */
  wakeSeconds: 1.2,
  /** How long a resident shows a real completion or failure at the door before heading home. */
  outcomeSeconds: 2.5,
  /** How long a building keeps its gold (completed) or red (failed) indicator after the real outcome. */
  outcomeIndicatorMinutes: 3,
  /** Floating Zzz above idle, connected residents. */
  zzz: true,
};

export function desiredFor(a: ResidentActivityLike | undefined | null): Desired {
  if (!a) return { mode: 'home' };
  const byAge = <T extends { seq: number }>(xs: T[], key: (x: T) => string) => [...xs].sort((x, y) => x.seq - y.seq || key(x).localeCompare(key(y)))[0];
  if (a.approvals.length) {
    const ap = byAge(a.approvals, (x) => x.approvalId);
    return { mode: 'approval', workplace: ap.workplace, ref: ap.approvalId };
  }
  if (a.runs.length) {
    const r = byAge(a.runs, (x) => x.runId);
    return { mode: 'work', workplace: r.workplace, ref: r.runId };
  }
  return { mode: 'home' };
}

// ---------- paths ----------

export type Path = { points: Vec3[]; cum: number[]; nodes: { id: string; at: number }[] };

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Height of a walker standing on a road surface above the ground point. */
const ROAD = 0.42;

function makePath(points: Vec3[], nodes: { id: string; index: number }[]): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  return { points, cum, nodes: nodes.map((n) => ({ id: n.id, at: cum[n.index] })) };
}

/** Points along one walk-graph edge as feet positions: road surface, arched bridge decks, stairs. */
function edgePoints(kind: string, pts: Vec3[]): Vec3[] {
  if (kind !== 'bridge') return pts.map((p) => [p[0], p[1] + ROAD, p[2]]);
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = dist(a, b);
  const out: Vec3[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = (t - 0.5) * len; // distance from the middle of the bridge
    const deck = Math.abs(s) <= BRIDGE_SPAN / 2 ? 0.31 + 1.1 * Math.cos((Math.PI * s) / BRIDGE_SPAN) : ROAD;
    out.push([a[0] + (b[0] - a[0]) * t, Math.max(ROAD, deck), a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** Where a resident goes in: the door at the top of the front steps. */
export function doorPoint(world: World, buildingId: string): Vec3 | null {
  const b = world.buildings.find((x) => x.id === buildingId);
  if (!b) return null;
  const r = buildingRotY(b);
  const out = b.d / 2 + 0.4;
  return [b.x + Math.sin(r) * out, groundY(world, b) + 0.95, b.z + Math.cos(r) * out];
}

/** The walkable route between two walk-graph nodes, following roads, bridges and stairs only. */
export function pathBetween(world: World, graph: WalkGraph, from: string, to: string): Path | null {
  if (from === to) {
    const p = graph.get(from)?.[0]?.points[0];
    return p ? makePath([[p[0], p[1] + ROAD, p[2]]], [{ id: from, index: 0 }]) : null;
  }
  const r = route(world, from, to, graph);
  if (!r) return null;
  const points: Vec3[] = [];
  const nodes: { id: string; index: number }[] = [];
  for (let i = 0; i < r.via.length - 1; i++) {
    const edges = (graph.get(r.via[i]) ?? []).filter((e) => e.to === r.via[i + 1]).sort((x, y) => x.length - y.length);
    const e = edges[0];
    const pts = edgePoints(e.road.kind, e.points);
    if (!points.length) {
      nodes.push({ id: r.via[i], index: 0 });
      points.push(pts[0]);
    }
    points.push(...pts.slice(1));
    nodes.push({ id: r.via[i + 1], index: points.length - 1 });
  }
  return makePath(points, nodes);
}

function pointAt(p: Path, d: number): Vec3 {
  if (d <= 0) return p.points[0];
  const total = p.cum[p.cum.length - 1];
  if (d >= total) return p.points[p.points.length - 1];
  let i = 1;
  while (p.cum[i] < d) i++;
  const t = (d - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1] || 1);
  const a = p.points[i - 1];
  const b = p.points[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The part of a path walked so far, reversed: back from here to the last node passed. */
function backToLastNode(p: Path, d: number): { path: Path; node: string } {
  const passed = [...p.nodes].reverse().find((n) => n.at <= d + 1e-6) ?? p.nodes[0];
  const pts: Vec3[] = [pointAt(p, d)];
  for (let i = p.points.length - 1; i >= 0; i--) if (p.cum[i] < d - 1e-6 && p.cum[i] >= passed.at - 1e-6) pts.push(p.points[i]);
  if (dist(pts[pts.length - 1], pointAt(p, passed.at)) > 1e-6) pts.push(pointAt(p, passed.at));
  return { path: makePath(pts, [{ id: passed.id, index: pts.length - 1 }]), node: passed.id };
}

function join(a: Path, b: Path): Path {
  const pts = [...a.points, ...b.points.slice(1)];
  const offset = a.points.length - 1;
  const nodes = [...a.nodes.map((n) => ({ id: n.id, index: a.cum.indexOf(n.at) })), ...b.nodes.map((n) => ({ id: n.id, index: b.cum.indexOf(n.at) + offset }))];
  // de-duplicate the joining node
  const seen = new Set<number>();
  return makePath(pts, nodes.filter((n) => n.index >= 0 && !seen.has(n.index) && seen.add(n.index)));
}

// ---------- one resident ----------

export type LifeView = {
  state: LifeState;
  /** Feet position. */
  position: Vec3;
  /** Facing (radians around Y, three.js convention: 0 faces +Z). */
  heading: number;
  /** False while inside a building. */
  visible: boolean;
  walking: boolean;
  /** Where the character is or is heading (building id). */
  place: string;
  /** The real run or approval that decides the current destination, if any. */
  ref: string | null;
};

export class ResidentLife {
  readonly id: string;
  readonly home: string;
  private world: World;
  private graph: WalkGraph;
  state: LifeState = 'idle_home';
  private desired: Desired = { mode: 'home' };
  private path: Path | null = null;
  private along = 0;
  private timer = 0;
  private pos: Vec3;
  private heading: number;
  private place: string;
  /** Destination node of the current walk (b:<id>). */
  private target: string | null = null;
  /** After the current walk: go inside (work), stand at the door (approval) or rest (home). */
  private onArrive: 'enter' | 'door' | 'rest' = 'rest';
  private inside = false;

  constructor(world: World, id: string, home: string, graph = walkGraph(world)) {
    this.world = world;
    this.graph = graph;
    this.id = id;
    this.home = home;
    this.place = home;
    this.pos = this.standAt(home);
    this.heading = this.facing(home);
  }

  private node(b: string) {
    return `b:${b}`;
  }

  private standAt(b: string): Vec3 {
    const p = this.graph.get(this.node(b))?.[0]?.points[0];
    return p ? [p[0], p[1] + ROAD, p[2]] : (doorPoint(this.world, b) ?? [0, ROAD, 0]);
  }

  /** Facing toward the building (away from the road) when standing at its entrance. */
  private facing(b: string): number {
    const spec = this.world.buildings.find((x) => x.id === b);
    return spec ? buildingRotY(spec) + Math.PI : 0;
  }

  /**
   * Place the character directly where the current real activity says it is, without walking there. Used on page
   * load so a reload never replays history: active work is already inside, a pending approval is at the door.
   */
  settle(d: Desired) {
    this.desired = d;
    this.path = null;
    this.timer = 0;
    if (d.mode === 'home') {
      this.goState('idle_home', this.home, false);
    } else if (d.mode === 'work') {
      this.goState('working', d.workplace, true);
    } else {
      this.goState('awaiting_approval', d.workplace, false);
    }
  }

  private goState(s: LifeState, place: string, inside: boolean) {
    this.state = s;
    this.place = place;
    this.inside = inside;
    this.pos = this.standAt(place);
    this.heading = this.facing(place);
  }

  /**
   * New real activity. `outcome` is set when a run just ended (live, not on load): the resident shows it briefly
   * at the door of the workplace before heading home.
   */
  update(d: Desired, outcome?: OutcomeLike['result'] | null) {
    const prev = this.desired;
    this.desired = d;
    const same = prev.mode === d.mode && (prev as any).workplace === (d as any).workplace;
    if (same && !outcome) return;
    const result = outcome === 'completed' ? 'task_completed' : outcome === 'failed' ? 'task_failed' : null;
    switch (this.state) {
      case 'idle_home':
        if (d.mode !== 'home') this.startWaking();
        return;
      case 'waking':
        if (d.mode === 'home') this.goState('idle_home', this.home, false);
        return; // otherwise it leaves when awake, toward whatever is wanted then
      case 'working':
      case 'awaiting_approval':
        if (d.mode === 'home') {
          this.inside = false;
          if (result) this.show(result);
          else this.leaveFor(this.home, 'rest');
        } else if (d.workplace === this.place) {
          // same building: go in to work, or come out to the door for an approval
          this.inside = d.mode === 'work';
          this.state = d.mode === 'work' ? 'working' : 'awaiting_approval';
        } else {
          this.inside = false;
          this.leaveFor(d.workplace, d.mode === 'work' ? 'enter' : 'door');
        }
        return;
      case 'task_completed':
      case 'task_failed':
        if (d.mode !== 'home') {
          this.timer = 0;
          if (d.workplace === this.place) this.goState(d.mode === 'work' ? 'working' : 'awaiting_approval', this.place, d.mode === 'work');
          else this.leaveFor(d.workplace, d.mode === 'work' ? 'enter' : 'door');
        }
        return;
      case 'traveling_to_work':
      case 'returning_home':
        // Work ended, failed or changed while walking: show a real outcome on the spot, then turn toward the new
        // destination along the roads (back to the last crossing passed, never across the river or a building).
        if (result && d.mode === 'home') {
          this.show(result);
          return;
        }
        this.reroute(d);
        return;
    }
  }

  private startWaking() {
    this.state = 'waking';
    this.timer = LIFE_CONFIG.wakeSeconds;
  }

  /** Pause where it stands (at a door, or mid-road) to show a real outcome; the walk, if any, resumes after. */
  private show(s: 'task_completed' | 'task_failed') {
    this.state = s;
    this.timer = LIFE_CONFIG.outcomeSeconds;
  }

  private destinationOf(d: Desired): { place: string; arrive: 'enter' | 'door' | 'rest' } {
    return d.mode === 'home' ? { place: this.home, arrive: 'rest' } : { place: d.workplace, arrive: d.mode === 'work' ? 'enter' : 'door' };
  }

  /** Start walking from where the character stands (a building entrance) to another building. */
  private leaveFor(place: string, arrive: 'enter' | 'door' | 'rest') {
    const from = this.place;
    if (from === place) {
      this.arrive(place, arrive);
      return;
    }
    const p = pathBetween(this.world, this.graph, this.node(from), this.node(place));
    if (!p) {
      // No walkable route (a broken layout): stay put rather than walking through things.
      this.arrive(from, arrive === 'rest' ? 'rest' : 'door');
      return;
    }
    this.path = p;
    this.along = 0;
    this.target = this.node(place);
    this.onArrive = arrive;
    this.place = place;
    this.state = place === this.home ? 'returning_home' : 'traveling_to_work';
  }

  private reroute(d: Desired) {
    const { place, arrive } = this.destinationOf(d);
    if (!this.path) {
      this.leaveFor(place, arrive);
      return;
    }
    if (this.target === this.node(place)) {
      this.onArrive = arrive;
      this.state = place === this.home ? 'returning_home' : 'traveling_to_work';
      return;
    }
    const back = backToLastNode(this.path, this.along);
    const onward = pathBetween(this.world, this.graph, back.node, this.node(place));
    if (!onward) return;
    this.path = join(back.path, onward);
    this.along = 0;
    this.target = this.node(place);
    this.onArrive = arrive;
    this.place = place;
    this.state = place === this.home ? 'returning_home' : 'traveling_to_work';
  }

  private arrive(place: string, how: 'enter' | 'door' | 'rest') {
    this.path = null;
    this.target = null;
    this.goState(how === 'enter' ? 'working' : how === 'door' ? 'awaiting_approval' : 'idle_home', place, how === 'enter');
  }

  step(dt: number) {
    if (this.state === 'waking') {
      this.timer -= dt;
      if (this.timer <= 0) {
        const { place, arrive } = this.destinationOf(this.desired);
        if (this.desired.mode === 'home') this.goState('idle_home', this.home, false);
        else this.leaveFor(place, arrive);
      }
      return;
    }
    if (this.state === 'task_completed' || this.state === 'task_failed') {
      this.timer -= dt;
      if (this.timer <= 0) {
        const { place, arrive } = this.destinationOf(this.desired);
        if (this.path) this.reroute(this.desired);
        else if (place === this.place && arrive === 'rest') this.goState('idle_home', this.home, false);
        else if (this.atBuilding()) this.leaveFor(place, arrive);
        else this.reroute(this.desired);
      }
      return;
    }
    if (!this.path) return;
    const total = this.path.cum[this.path.cum.length - 1];
    const prev = this.pos;
    this.along = Math.min(total, this.along + LIFE_CONFIG.walkSpeed * dt);
    this.pos = pointAt(this.path, this.along);
    const dx = this.pos[0] - prev[0];
    const dz = this.pos[2] - prev[2];
    if (dx * dx + dz * dz > 1e-8) this.heading = Math.atan2(dx, dz);
    if (this.along >= total - 1e-6) this.arrive(this.place, this.onArrive);
  }

  /** True when standing at a building entrance (not mid-road). */
  private atBuilding(): boolean {
    return dist(this.pos, this.standAt(this.place)) < 0.05;
  }

  view(): LifeView {
    const walking = !!this.path;
    const ref = this.desired.mode === 'home' ? null : this.desired.ref;
    return { state: this.state, position: [...this.pos] as Vec3, heading: this.heading, visible: !this.inside, walking, place: this.place, ref };
  }
}

// ---------- building indicators ----------

export type IndicatorColor = 'blue' | 'amber' | 'red' | 'gold';
export type Indicator = {
  building: string;
  color: IndicatorColor;
  /** Real progress from the provider, or null for an indeterminate indicator. */
  progress: { done: number; total: number; label: string | null } | null;
  /** The real runs, approvals and tasks behind this indicator. */
  runIds: string[];
  approvalIds: string[];
  taskIds: string[];
};

/**
 * What each building's indicator shows, from the activity snapshot only. Waiting for approval (amber) outranks
 * active work (blue); a recent real failure (red) or completion (gold) shows only when nothing is active there,
 * and only for a few minutes after it happened by Village Hall's clock. A stopped run shows nothing.
 */
export function buildingIndicators(residents: Record<string, ResidentActivityLike>, serverNow: string, fadeMinutes = LIFE_CONFIG.outcomeIndicatorMinutes): Map<string, Indicator> {
  const out = new Map<string, Indicator>();
  const get = (b: string, color: IndicatorColor) => {
    let ind = out.get(b);
    if (!ind) out.set(b, (ind = { building: b, color, progress: null, runIds: [], approvalIds: [], taskIds: [] }));
    return ind;
  };
  const rank: Record<IndicatorColor, number> = { amber: 3, blue: 2, red: 1, gold: 0 };
  for (const a of Object.values(residents)) {
    for (const r of a.runs) {
      const ind = get(r.workplace, 'blue');
      if (rank.blue > rank[ind.color]) ind.color = 'blue';
      ind.runIds.push(r.runId);
      if (r.taskId) ind.taskIds.push(r.taskId);
      // progress is shown only for a single run with real numbers; several runs stay indeterminate
      ind.progress = ind.runIds.length === 1 && r.progress ? { ...r.progress } : null;
    }
    for (const ap of a.approvals) {
      const ind = get(ap.workplace, 'amber');
      ind.color = 'amber';
      ind.approvalIds.push(ap.approvalId);
      if (ap.taskId) ind.taskIds.push(ap.taskId);
    }
  }
  const now = Date.parse(serverNow);
  for (const a of Object.values(residents)) {
    const o = a.lastOutcome;
    if (!o || o.result === 'stopped' || out.has(o.workplace)) continue;
    if (!(now - Date.parse(o.at) <= fadeMinutes * 60_000)) continue;
    const ind = get(o.workplace, o.result === 'failed' ? 'red' : 'gold');
    if (o.runId) ind.runIds.push(o.runId);
    if (o.taskId) ind.taskIds.push(o.taskId);
  }
  for (const ind of out.values()) if (ind.color !== 'blue') ind.progress = null;
  return out;
}

// ---------- the whole village ----------

/**
 * Keeps one ResidentLife per shown resident in step with the activity snapshot. The first snapshot settles
 * everyone where they are (no replay); later snapshots move them, and a newly recorded outcome is shown once.
 */
export class LifeDirector {
  private world: World;
  private graph: WalkGraph;
  readonly lives = new Map<string, ResidentLife>();
  private seenOutcome = new Map<string, number>();

  constructor(world: World) {
    this.world = world;
    this.graph = walkGraph(world);
  }

  /** `residents`: id and home of each resident that has a character in the village. */
  sync(residents: { id: string; home: string }[], activity: Record<string, ResidentActivityLike>) {
    const fresh = new Set<string>();
    for (const r of residents) {
      if (!this.lives.has(r.id) && this.world.buildings.some((b) => b.id === r.home)) {
        this.lives.set(r.id, new ResidentLife(this.world, r.id, r.home, this.graph));
        fresh.add(r.id);
      }
    }
    for (const id of [...this.lives.keys()]) if (!residents.some((r) => r.id === id)) this.lives.delete(id);
    for (const [id, life] of this.lives) {
      const a = activity[id];
      const d = desiredFor(a);
      const o = a?.lastOutcome ?? null;
      const isNew = o && o.seq > (this.seenOutcome.get(id) ?? -1) ? o : null;
      if (o) this.seenOutcome.set(id, o.seq);
      // On first sight (page load, or a resident added later) place the character directly: never replay.
      if (fresh.has(id)) life.settle(d);
      else life.update(d, isNew?.result ?? null);
    }
  }

  step(dt: number) {
    for (const l of this.lives.values()) l.step(dt);
  }
}
