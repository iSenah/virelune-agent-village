// Every road in the village layout, drawn by kind: cobble (one batched mesh set for the whole village),
// dirt (one merged ribbon), and stone stairs (one merged mesh). Bridges are drawn by the hub (river).
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import * as THREE from '../../vendor/three.module.js';
import { mat, PALETTE, RoadBatch, rng } from './kit.ts';
import { allNodes, allRoads, roadPoints, type RoadSpec, type Vec3, type World } from './worldModel.ts';

export type RoadStyle = { width: number; curbs: boolean };

/** Founders' roads from the fountain to a building are wide with curbs; crossing trails narrow; the rest medium. */
export function roadStyle(r: RoadSpec): RoadStyle {
  if (r.from === 'plaza' && r.to.startsWith('b:')) return { width: 2.6, curbs: true };
  if (r.from === 'plaza' && r.to.startsWith('x:')) return { width: 1.7, curbs: false };
  return { width: 2.2, curbs: true };
}

let dirtCanvas: HTMLCanvasElement | null = null;
function dirtImage(): HTMLCanvasElement {
  if (dirtCanvas) return dirtCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#6e5a3f';
  ctx.fillRect(0, 0, 128, 128);
  const r = rng(808);
  for (let i = 0; i < 700; i++) {
    const v = r();
    ctx.fillStyle = v < 0.5 ? `rgba(60,46,30,${0.2 + r() * 0.4})` : `rgba(140,118,86,${0.2 + r() * 0.35})`;
    const s = 1 + r() * 3;
    ctx.fillRect(r() * 128, r() * 128, s, s);
  }
  dirtCanvas = c;
  return c;
}

/** A flat ribbon along a polyline (x/z, with heights), UVs in metres. */
function pathRibbon(points: Vec3[], halfWidth: number, lift: number): THREE.BufferGeometry {
  // Resample so curves are smooth (Catmull-Rom through the points).
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal');
  const n = Math.max(8, Math.round(curve.getLength() / 1.5));
  const pts = curve.getSpacedPoints(n);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let along = 0;
  pts.forEach((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const t = new THREE.Vector2(next.x - prev.x, next.z - prev.z).normalize();
    const nrm = new THREE.Vector2(-t.y, t.x);
    if (i) along += p.distanceTo(pts[i - 1]);
    // the edges wobble a little so the trail looks worn, not drawn
    const hw = halfWidth * (1 + Math.sin(i * 1.7) * 0.12);
    for (const s of [-1, 1]) {
      pos.push(p.x + nrm.x * hw * s, p.y + lift, p.z + nrm.y * hw * s);
      uv.push((s + 1) * halfWidth * 0.5, along * 0.5);
    }
    if (i < pts.length - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if ((g.attributes.normal as THREE.BufferAttribute).getY(0) < 0) {
    idx.reverse();
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** Stone stairs from a (bottom) to b (top), with low side walls. */
function stairs(a: Vec3, b: Vec3, width: number): THREE.BufferGeometry {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const run = Math.hypot(dx, dz);
  const rise = b[1] - a[1];
  const n = Math.max(2, Math.round(Math.abs(rise) / 0.32));
  const rot = Math.atan2(dx, dz);
  const parts: THREE.BufferGeometry[] = [];
  const at = (t: number) => new THREE.Vector3(a[0] + dx * t, a[1] + rise * t, a[2] + dz * t);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const p = at(t);
    const h = (rise / n) * (i + 1);
    // each step is a block from the ground under it up to its tread
    const g = new THREE.BoxGeometry(width, h, run / n + 0.04);
    g.translate(0, a[1] + h / 2 - p.y, 0);
    parts.push(g.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1))));
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i += 2) {
      const t = (i + 1) / n;
      const p = at(t).add(new THREE.Vector3(side * (width / 2 + 0.25), 0, 0).applyQuaternion(q));
      const h = rise * t + 0.6;
      const g = new THREE.BoxGeometry(0.5, h, (run / n) * 2 + 0.05);
      g.translate(0, a[1] + h / 2 - p.y, 0);
      parts.push(g.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1))));
    }
  }
  return mergeGeometries(parts);
}

export type RoadNetwork = {
  group: THREE.Group;
  /** For the landscape: where not to put trees. */
  keepout: { a: THREE.Vector2; b: THREE.Vector2; r: number }[];
  /** Founders' roads (fountain to building), for fences and the road-mouth lamps. */
  foundersRoads: { building: string; start: THREE.Vector2; end: THREE.Vector2 }[];
};

export function buildRoads(world: World, plazaRadius: number): RoadNetwork {
  const group = new THREE.Group();
  const nodes = allNodes(world);
  const batch = new RoadBatch();
  const dirt: THREE.BufferGeometry[] = [];
  const steps: THREE.BufferGeometry[] = [];
  const keepout: RoadNetwork['keepout'] = [];
  const foundersRoads: RoadNetwork['foundersRoads'] = [];
  allRoads(world).forEach((road, i) => {
    if (road.kind === 'bridge') return; // the hub draws bridges over the river
    let pts = roadPoints(world, road, nodes);
    if (pts.length < 2) return;
    const style = roadStyle(road);
    // Roads stop at the edge of a flagstone square instead of running across it.
    const square = (id: string) => world.squares?.find((q) => q.node === id);
    const trim = (from: Vec3, to: Vec3, by: number): Vec3 => {
      const dx = from[0] - to[0];
      const dz = from[2] - to[2];
      const l = Math.hypot(dx, dz) || 1;
      const k = Math.min(by, l - 0.5) / l;
      return [to[0] + dx * k, to[1] + (from[1] - to[1]) * k, to[2] + dz * k];
    };
    const sqFrom = square(road.from);
    const sqTo = square(road.to);
    if (sqFrom) pts = [trim(pts[1], pts[0], sqFrom.radius - 0.1), ...pts.slice(1)];
    if (sqTo) pts = [...pts.slice(0, -1), trim(pts[pts.length - 2], pts[pts.length - 1], sqTo.radius - 0.1)];
    // Roads from the fountain start at the plaza edge (crossing trails a little further out, past the balustrade).
    if (road.from === 'plaza') {
      const d = new THREE.Vector2(pts[1][0], pts[1][2]).normalize();
      const start = d.multiplyScalar(road.to.startsWith('x:') ? plazaRadius + 1.4 : plazaRadius + 0.3);
      pts = [[start.x, 0, start.y], ...pts.slice(1)];
    }
    for (let k = 1; k < pts.length; k++) keepout.push({ a: new THREE.Vector2(pts[k - 1][0], pts[k - 1][2]), b: new THREE.Vector2(pts[k][0], pts[k][2]), r: style.width / 2 + 1.3 });
    if (road.kind === 'stairs') {
      steps.push(stairs(pts[0], pts[pts.length - 1], 2.4));
      return;
    }
    if (road.kind === 'dirt') {
      dirt.push(pathRibbon(pts, 1.2, 0.03));
      return;
    }
    for (let k = 1; k < pts.length; k++) {
      const a = new THREE.Vector2(pts[k - 1][0], pts[k - 1][2]);
      const b = new THREE.Vector2(pts[k][0], pts[k][2]);
      batch.add(a, b, style.width, 100 + i * 7 + k, { y: Math.min(pts[k - 1][1], pts[k][1]), curbs: style.curbs, extend: k > 1 ? style.width / 2 : 0 });
    }
    if (road.from === 'plaza' && road.to.startsWith('b:')) foundersRoads.push({ building: road.to.slice(2), start: new THREE.Vector2(pts[0][0], pts[0][2]), end: new THREE.Vector2(pts[pts.length - 1][0], pts[pts.length - 1][2]) });
  });
  group.add(batch.build());
  if (dirt.length) {
    const tex = new THREE.CanvasTexture(dirtImage());
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(mergeGeometries(dirt), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    m.receiveShadow = true;
    group.add(m);
  }
  if (steps.length) {
    const m = new THREE.Mesh(mergeGeometries(steps), mat(PALETTE.stoneLight));
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  return { group, keepout, foundersRoads };
}
