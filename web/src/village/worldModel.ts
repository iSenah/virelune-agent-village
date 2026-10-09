// The village layout as data: districts, building slots, entrances, river crossings and walkable roads.
// Pure TypeScript (no three.js, no DOM), shared by Village Hall (validation, future resident destinations) and
// the browser (rendering). The layout itself lives in config/layout/world.json so it can be adjusted without
// touching code, e.g. when a final building model arrives and needs a slightly different spot.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type District = {
  id: string;
  name: string;
  subtitle: string;
  center: Vec2;
  radius: number;
  /** Ground height of the district (Scholars' Heights is raised). */
  elevation: number;
};

export type BuildingKind = 'residence' | 'workplace' | 'service';

export type BuildingSpec = {
  id: string;
  /** Name in the resident list and the Go to menu. */
  place: string;
  /** Signboard lines. */
  title: string;
  subtitle: string;
  tagline: string;
  district: string;
  kind: BuildingKind;
  x: number;
  z: number;
  /** Ground height under the building (defaults to its district's elevation). */
  y?: number;
  /** Point the front door faces (defaults to the fountain at [0, 0]). */
  face?: Vec2;
  /** Plinth footprint, in metres. */
  w: number;
  d: number;
  /** Height above the ground reserved for future task-progress indicators. */
  indicatorHeight?: number;
  /** Short description of the final model, for the development placeholder. */
  modelNote?: string;
};

export type RoadKind = 'cobble' | 'dirt' | 'stairs' | 'bridge';

export type RoadSpec = {
  from: string;
  to: string;
  kind: RoadKind;
  /** Bend points between the two ends (x, z; height follows the ends). */
  via?: Vec2[];
};

export type Crossing = { id: string; angle: number };

export type Plateau = { id: string; height: number; outline: Vec2[] };

export type World = {
  version: 1;
  plazaRadius: number;
  districts: District[];
  buildings: BuildingSpec[];
  /** Named waypoints: "n:<id>". Buildings provide "b:<id>" (their entrance); "plaza" is the fountain square. */
  nodes: Record<string, Vec3>;
  /** River bridges at these angles (degrees; 0 = east, 90 = south). Each provides nodes "x:<id>:in" and "x:<id>:out". */
  crossings: Crossing[];
  roads: RoadSpec[];
  plateaus: Plateau[];
};

// ---------- river ----------

export const RIVER_W = 4.4;
/** The river winds around Founders' Square at roughly this distance from the fountain. */
export function riverRadius(theta: number): number {
  return 41 + 1.6 * Math.sin(3 * theta + 0.7) + 0.8 * Math.sin(5 * theta);
}
/** Length of a river bridge (deck), in metres. */
export const BRIDGE_SPAN = RIVER_W + 3.4;

// ---------- buildings ----------

export function districtOf(world: World, b: BuildingSpec): District | undefined {
  return world.districts.find((d) => d.id === b.district);
}

export function groundY(world: World, b: BuildingSpec): number {
  return b.y ?? districtOf(world, b)?.elevation ?? 0;
}

/** Rotation (radians, around Y) so the building's front (+Z) faces its `face` point. */
export function buildingRotY(b: BuildingSpec): number {
  const [fx, fz] = b.face ?? [0, 0];
  return Math.atan2(fx - b.x, fz - b.z);
}

/** Where a resident stands to go in: just in front of the steps. */
export function entrance(world: World, b: BuildingSpec): Vec3 {
  const r = buildingRotY(b);
  const out = b.d / 2 + 2.4;
  return [b.x + Math.sin(r) * out, groundY(world, b), b.z + Math.cos(r) * out];
}

/** Anchor above the building for future task-progress indicators. */
export function indicatorAnchor(world: World, b: BuildingSpec): Vec3 {
  return [b.x, groundY(world, b) + (b.indicatorHeight ?? 14), b.z];
}

/** Rough footprint radius (plinth with its lower rim), for spacing checks. */
export function footprintRadius(b: BuildingSpec): number {
  return Math.hypot(b.w + 1.2, b.d + 1.2) / 2;
}

// ---------- nodes and the walk graph ----------

export function crossingEnds(world: World, c: Crossing): { inner: Vec3; outer: Vec3 } {
  const a = (c.angle * Math.PI) / 180;
  const R = riverRadius(a);
  const half = BRIDGE_SPAN / 2 + 0.6;
  return { inner: [Math.cos(a) * (R - half), 0, Math.sin(a) * (R - half)], outer: [Math.cos(a) * (R + half), 0, Math.sin(a) * (R + half)] };
}

/** Every named point: plaza, waypoints, building entrances and bridge ends. */
export function allNodes(world: World): Map<string, Vec3> {
  const m = new Map<string, Vec3>();
  m.set('plaza', [0, 0, 0]);
  for (const [id, p] of Object.entries(world.nodes)) m.set(id, p);
  for (const b of world.buildings) m.set(`b:${b.id}`, entrance(world, b));
  for (const c of world.crossings) {
    const e = crossingEnds(world, c);
    m.set(`x:${c.id}:in`, e.inner);
    m.set(`x:${c.id}:out`, e.outer);
  }
  return m;
}

/** Roads including the implicit ones: plaza to each bridge, and each bridge itself. */
export function allRoads(world: World): RoadSpec[] {
  const implicit: RoadSpec[] = world.crossings.flatMap((c) => [
    { from: 'plaza', to: `x:${c.id}:in`, kind: 'cobble' as const },
    { from: `x:${c.id}:in`, to: `x:${c.id}:out`, kind: 'bridge' as const },
  ]);
  return [...implicit, ...world.roads];
}

/** A road as a polyline of 3D points (heights interpolated between its ends). */
export function roadPoints(world: World, road: RoadSpec, nodes = allNodes(world)): Vec3[] {
  const a = nodes.get(road.from);
  const b = nodes.get(road.to);
  if (!a || !b) return [];
  const pts: Vec3[] = [a];
  const via = road.via ?? [];
  via.forEach((v, i) => {
    const t = (i + 1) / (via.length + 1);
    pts.push([v[0], a[1] + (b[1] - a[1]) * t, v[1]]);
  });
  pts.push(b);
  return pts;
}

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export type WalkGraph = Map<string, { to: string; road: RoadSpec; points: Vec3[]; length: number }[]>;

export function walkGraph(world: World): WalkGraph {
  const nodes = allNodes(world);
  const g: WalkGraph = new Map();
  const add = (from: string, to: string, road: RoadSpec, points: Vec3[]) => {
    const length = points.slice(1).reduce((n, p, i) => n + dist3(points[i], p), 0);
    if (!g.has(from)) g.set(from, []);
    g.get(from)!.push({ to, road, points, length });
  };
  for (const r of allRoads(world)) {
    const pts = roadPoints(world, r, nodes);
    if (pts.length < 2) continue;
    add(r.from, r.to, r, pts);
    add(r.to, r.from, r, [...pts].reverse());
  }
  return g;
}

/**
 * Shortest walkable route between two nodes (e.g. "b:library" to "b:blender-house"), as points along the roads.
 * Prepared for V3 resident walking; null when there is no route.
 */
export function route(world: World, from: string, to: string, graph = walkGraph(world)): { points: Vec3[]; length: number; via: string[] } | null {
  const best = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; points: Vec3[] }>();
  const open = new Set([from]);
  while (open.size) {
    let cur = '';
    let curD = Infinity;
    for (const n of open) if ((best.get(n) ?? Infinity) < curD) (cur = n), (curD = best.get(n)!);
    open.delete(cur);
    if (cur === to) break;
    for (const e of graph.get(cur) ?? []) {
      const nd = curD + e.length;
      if (nd < (best.get(e.to) ?? Infinity)) {
        best.set(e.to, nd);
        prev.set(e.to, { node: cur, points: e.points });
        open.add(e.to);
      }
    }
  }
  if (!best.has(to)) return null;
  const via: string[] = [to];
  const segs: Vec3[][] = [];
  for (let n = to; n !== from; ) {
    const p = prev.get(n)!;
    segs.unshift(p.points);
    n = p.node;
    via.unshift(n);
  }
  const points: Vec3[] = segs.length ? [segs[0][0]] : [];
  for (const s of segs) points.push(...s.slice(1));
  return { points, length: best.get(to)!, via };
}

// ---------- validation ----------

export function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function footprintCorners(b: BuildingSpec): Vec2[] {
  const r = buildingRotY(b);
  const hw = (b.w + 1.2) / 2;
  const hd = (b.d + 1.2) / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => [b.x + x * Math.cos(r) + z * Math.sin(r), b.z - x * Math.sin(r) + z * Math.cos(r)] as Vec2);
}

function segPointDist(a: Vec2, b: Vec2, p: Vec2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const len = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len));
  return Math.hypot(a[0] + abx * t - p[0], a[1] + abz * t - p[1]);
}

/** Problems with a layout (empty = fine). `homes` are building ids residents live or work in. */
export function validateWorld(world: World, homes: string[] = []): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const b of world.buildings) {
    if (ids.has(b.id)) errs.push(`building "${b.id}" is listed twice`);
    ids.add(b.id);
    if (!districtOf(world, b)) errs.push(`building "${b.id}" is in unknown district "${b.district}"`);
    if (!(b.w > 0 && b.d > 0)) errs.push(`building "${b.id}" needs a positive footprint`);
  }
  // Buildings must not overlap each other, the plaza, or the river.
  for (let i = 0; i < world.buildings.length; i++) {
    const a = world.buildings[i];
    if (Math.hypot(a.x, a.z) - footprintRadius(a) < world.plazaRadius + 3) errs.push(`building "${a.id}" overlaps the plaza`);
    const ang = Math.atan2(a.z, a.x);
    if (Math.abs(Math.hypot(a.x, a.z) - riverRadius(ang)) < footprintRadius(a) + RIVER_W / 2 + 1) errs.push(`building "${a.id}" sits on the river`);
    for (let j = i + 1; j < world.buildings.length; j++) {
      const b = world.buildings[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < footprintRadius(a) + footprintRadius(b) + 1) errs.push(`buildings "${a.id}" and "${b.id}" overlap`);
    }
  }
  // Raised ground: buildings of a raised district must stand on its plateau, and nothing else may.
  for (const b of world.buildings) {
    const elev = districtOf(world, b)?.elevation ?? 0;
    const on = world.plateaus.filter((p) => insidePolygon([b.x, b.z], p.outline));
    if (elev > 0 && !on.some((p) => p.height === elev)) errs.push(`building "${b.id}" should stand on a plateau ${elev} m up`);
    if (elev === 0 && on.length) errs.push(`building "${b.id}" is inside raised ground "${on[0].id}"`);
    if (elev > 0) for (const c of footprintCorners(b)) if (!on.some((p) => insidePolygon(c, p.outline))) errs.push(`building "${b.id}" hangs over the edge of its plateau`);
  }
  for (const h of homes) if (!ids.has(h)) errs.push(`a resident lives or works at "${h}", which is not in the layout`);
  // Roads must connect known points and must not run through other buildings.
  const nodes = allNodes(world);
  for (const r of allRoads(world)) {
    for (const end of [r.from, r.to]) if (!nodes.has(end)) errs.push(`road ${r.from} -> ${r.to}: unknown point "${end}"`);
    const pts = roadPoints(world, r, nodes);
    for (let k = 1; k < pts.length; k++) {
      for (const b of world.buildings) {
        if (r.from === `b:${b.id}` || r.to === `b:${b.id}`) continue;
        const d = segPointDist([pts[k - 1][0], pts[k - 1][2]], [pts[k][0], pts[k][2]], [b.x, b.z]);
        if (d < footprintRadius(b)) errs.push(`road ${r.from} -> ${r.to} runs through "${b.id}"`);
      }
    }
  }
  // Every building must be reachable on foot from the plaza.
  const g = walkGraph(world);
  const seen = new Set(['plaza']);
  const stack = ['plaza'];
  while (stack.length) for (const e of g.get(stack.pop()!) ?? []) if (!seen.has(e.to)) seen.add(e.to), stack.push(e.to);
  for (const b of world.buildings) if (!seen.has(`b:${b.id}`)) errs.push(`building "${b.id}" cannot be reached on foot from the plaza`);
  return errs;
}
