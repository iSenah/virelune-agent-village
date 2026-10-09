// The ground of the expanded village, built from the layout data (config/layout/world.json): the raised
// plateau of Scholars' Heights with rocky cliffs and a stone railing, flagstone squares at the district
// crossroads, a little clutter in the Artisan Quarter, and the darker floor and mist of the Forgotten Woods.
// Everything here is AMBIENT: deterministic, always the same, never tied to agent activity.
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import * as THREE from '../../vendor/three.module.js';
import { rockField } from './hub.ts';
import { mat, mesh, PALETTE, rng, stoneColor } from './kit.ts';
import { lanternToward, type LampSpot } from './lamps.ts';
import { grassMaterial } from './nature.ts';
import { allNodes, allRoads, edgeDistance, insidePolygon, roadPoints, type Vec2, type World } from './worldModel.ts';

export type Fall = { angle: number; edge: number; height: number };
type Seg = { a: THREE.Vector2; b: THREE.Vector2; r: number };

/** Where water falls from raised ground (angle in radians, distance of the edge from the fountain, drop height). */
export function plateauFalls(world: World): Fall[] {
  const out: Fall[] = [];
  for (const p of world.plateaus) {
    for (const deg of p.waterfalls ?? []) {
      const angle = (deg * Math.PI) / 180;
      const edge = edgeDistance(p.outline, angle);
      if (edge) out.push({ angle, edge, height: p.height });
    }
  }
  return out;
}

let cliffCanvas: HTMLCanvasElement | null = null;
function cliffImage(): HTMLCanvasElement {
  if (cliffCanvas) return cliffCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#6f6656';
  ctx.fillRect(0, 0, 256, 256);
  const r = rng(515);
  // layered rock strata with cracks
  for (let y = 0; y < 256; y += 6 + r() * 14) {
    ctx.fillStyle = `rgba(${70 + r() * 50},${62 + r() * 40},${50 + r() * 30},0.55)`;
    ctx.fillRect(0, y, 256, 3 + r() * 8);
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = r() < 0.5 ? 'rgba(40,36,30,0.35)' : 'rgba(150,140,120,0.3)';
    ctx.fillRect(r() * 256, r() * 256, 2 + r() * 10, 1 + r() * 2);
  }
  ctx.strokeStyle = 'rgba(30,26,22,0.28)';
  for (let i = 0; i < 10; i++) {
    const x = r() * 256;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    let y = 0;
    let xx = x;
    while (y < 256) {
      y += 8 + r() * 20;
      xx += (r() - 0.5) * 10;
      ctx.lineTo(xx, y);
    }
    ctx.stroke();
  }
  cliffCanvas = c;
  return c;
}

function cliffMaterial(): THREE.MeshStandardMaterial {
  const tex = new THREE.CanvasTexture(cliffImage());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 7, 1 / 7);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
}

function segDist(a: Vec2, b: Vec2, p: Vec2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / (abx * abx + abz * abz || 1)));
  return Math.hypot(a[0] + abx * t - p[0], a[1] + abz * t - p[1]);
}

const box = new THREE.BoxGeometry(1, 1, 1);
function instancedBoxes(list: THREE.Matrix4[], color: number, shadows = true): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(box, mat(color), Math.max(1, list.length));
  list.forEach((m, i) => im.setMatrixAt(i, m));
  im.count = list.length;
  im.castShadow = shadows;
  im.receiveShadow = true;
  return im;
}
const m4 = (x: number, y: number, z: number, rotY: number, sx: number, sy: number, sz: number) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(sx, sy, sz));

export type Terrain = {
  group: THREE.Group;
  lampSpots: LampSpot[];
  keepout: { circles: { x: number; z: number; r: number }[]; segments: Seg[] };
};

/** `roadKeepout` keeps props off the roads. */
export function buildTerrain(world: World, roadKeepout: Seg[]): Terrain {
  const g = new THREE.Group();
  const r = rng(909);
  const lampSpots: LampSpot[] = [];
  const circles: Terrain['keepout']['circles'] = [];
  const segments: Seg[] = [];
  const nodes = allNodes(world);
  const stairs = allRoads(world).filter((x) => x.kind === 'stairs').map((x) => roadPoints(world, x, nodes)).filter((p) => p.length >= 2);
  const falls = plateauFalls(world);
  const onRoad = (x: number, z: number, pad: number) => roadKeepout.some((s) => segDist([s.a.x, s.a.y], [s.b.x, s.b.y], [x, z]) < s.r + pad);

  // ---------- raised ground ----------
  const rocks: { x: number; z: number; s: number; sy: number; rot: number; v: number; y?: number }[] = [];
  const posts: THREE.Matrix4[] = [];
  const rails: THREE.Matrix4[] = [];
  for (const p of world.plateaus) {
    const shape = new THREE.Shape(p.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: p.height + 0.06, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -0.06, 0);
    const plateau = new THREE.Mesh(geo, [grassMaterial(1 / 12), cliffMaterial()]);
    plateau.name = `plateau:${p.id}`;
    plateau.castShadow = true;
    plateau.receiveShadow = true;
    g.add(plateau);
    const n = p.outline.length;
    const nearStairs = (pt: Vec2, pad: number) => stairs.some((s) => segDist([s[0][0], s[0][2]], [s[s.length - 1][0], s[s.length - 1][2]], pt) < pad);
    const nearFall = (pt: Vec2, pad: number) => falls.some((f) => Math.hypot(pt[0] - Math.cos(f.angle) * f.edge, pt[1] - Math.sin(f.angle) * f.edge) < pad);
    for (let i = 0; i < n; i++) {
      const a = p.outline[i];
      const b = p.outline[(i + 1) % n];
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const len = Math.hypot(ex, ez);
      // outward normal
      let nx = ez / len;
      let nz = -ex / len;
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (insidePolygon([mid[0] + nx * 0.5, mid[1] + nz * 0.5], p.outline)) (nx = -nx), (nz = -nz);
      segments.push({ a: new THREE.Vector2(a[0], a[1]), b: new THREE.Vector2(b[0], b[1]), r: 3.2 });
      // rocks piled against the cliff face, in three rough layers
      const steps = Math.max(1, Math.round(len / 2.3));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const pt: Vec2 = [a[0] + ex * t, a[1] + ez * t];
        if (nearStairs(pt, 2.6) || nearFall(pt, 3.2)) continue;
        // a skirt of boulders at the foot, the odd rock on the face, and small stones along the lip
        const layers: [number, number, number, number, number][] = [
          [0.5 + r() * 0.9, 0.5, 0.9 + r() * 0.9, 0.7 + r() * 0.4, 0.75],
          [0.05 + r() * 0.2, p.height * (0.3 + r() * 0.4), 0.7 + r() * 0.6, 0.8 + r() * 0.3, 0.25],
          [0.0, p.height - 0.15, 0.5 + r() * 0.5, 0.6 + r() * 0.2, 0.45],
        ];
        for (const [out, y, s, sy, chance] of layers) {
          if (r() > chance) continue;
          rocks.push({ x: pt[0] + nx * out + (r() - 0.5) * 0.8, z: pt[1] + nz * out + (r() - 0.5) * 0.8, s, sy, rot: r() * 6, v: r(), y: y + (r() - 0.5) * 0.4 });
        }
      }
      // stone railing along the edge facing the village (not across stairs or waterfalls)
      if (Math.hypot(a[0], a[1]) > 60 || Math.hypot(b[0], b[1]) > 60) continue;
      const count = Math.max(1, Math.round(len / 2.2));
      let prev: Vec2 | null = null;
      for (let k = 0; k <= count; k++) {
        const t = k / count;
        const pt: Vec2 = [a[0] + ex * t - nx * 0.7, a[1] + ez * t - nz * 0.7];
        if (nearStairs(pt, 2.4) || nearFall(pt, 2.4)) {
          prev = null;
          continue;
        }
        if (k < count || i === n - 1) posts.push(m4(pt[0], p.height + 0.45, pt[1], 0, 0.36, 0.9, 0.36));
        if (prev) {
          const rot = -Math.atan2(pt[1] - prev[1], pt[0] - prev[0]);
          const l = Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
          rails.push(m4((pt[0] + prev[0]) / 2, p.height + 0.82, (pt[1] + prev[1]) / 2, rot, l, 0.14, 0.24));
          rails.push(m4((pt[0] + prev[0]) / 2, p.height + 0.2, (pt[1] + prev[1]) / 2, rot, l, 0.14, 0.26));
        }
        prev = pt;
      }
    }
  }
  if (rocks.length) g.add(rockField(rocks, 0, 0.12));
  if (posts.length) g.add(instancedBoxes(posts, PALETTE.stoneLight));
  if (rails.length) g.add(instancedBoxes(rails, PALETTE.stone));

  // ---------- flagstone squares at the district crossroads ----------
  const mortar: THREE.BufferGeometry[] = [];
  const flags: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  const curbs: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  const d = new THREE.Object3D();
  for (const sq of world.squares ?? []) {
    const at = nodes.get(sq.node);
    if (!at) continue;
    const [cx, cy, cz] = at;
    const R = sq.radius;
    mortar.push(new THREE.CylinderGeometry(R + 0.45, R + 0.6, 0.34, 40).translate(cx, cy + 0.17, cz));
    for (let rr = R - 0.35; rr > 0.3; rr -= 0.8) {
      const count = Math.max(1, Math.floor((2 * Math.PI * rr) / 0.82));
      const off = r() * Math.PI;
      for (let k = 0; k < count; k++) {
        const t = off + (k / count) * Math.PI * 2;
        d.position.set(cx + Math.cos(t) * rr, cy + 0.36 + r() * 0.02, cz + Math.sin(t) * rr);
        d.rotation.set(0, r() * Math.PI, 0);
        d.scale.set(0.9 + r() * 0.2, 1, 0.9 + r() * 0.2);
        d.updateMatrix();
        const c = new THREE.Color();
        stoneColor(c, r, PALETTE.stone);
        flags.push({ m: d.matrix.clone(), c });
      }
    }
    d.position.set(cx, cy + 0.37, cz);
    d.rotation.set(0, 0, 0);
    d.scale.set(1.2, 1, 1.2);
    d.updateMatrix();
    flags.push({ m: d.matrix.clone(), c: new THREE.Color(PALETTE.stoneLight) });
    const nc = Math.floor((2 * Math.PI * (R + 0.3)) / 0.75);
    for (let k = 0; k < nc; k++) {
      const t = (k / nc) * Math.PI * 2;
      d.position.set(cx + Math.cos(t) * (R + 0.3), cy + 0.38, cz + Math.sin(t) * (R + 0.3));
      d.rotation.set(0, -t + Math.PI / 2, 0);
      d.scale.set(0.7, 0.2 + r() * 0.05, 0.36);
      d.updateMatrix();
      const c = new THREE.Color();
      stoneColor(c, r, PALETTE.stone);
      curbs.push({ m: d.matrix.clone(), c });
    }
    circles.push({ x: cx, z: cz, r: R + 1.6 });
    // lamp posts on the square, placed away from the roads that meet here
    const dirs: number[] = [];
    for (const road of allRoads(world)) {
      const pts = roadPoints(world, road, nodes);
      if (road.from === sq.node && pts.length > 1) dirs.push(Math.atan2(pts[1][2] - cz, pts[1][0] - cx));
      if (road.to === sq.node && pts.length > 1) dirs.push(Math.atan2(pts[pts.length - 2][2] - cz, pts[pts.length - 2][0] - cx));
    }
    const gap = (a: number) => Math.min(...dirs.map((x) => Math.abs(Math.atan2(Math.sin(a - x), Math.cos(a - x)))), Math.PI);
    const chosen: number[] = [];
    for (let l = 0; l < (sq.lamps ?? 2); l++) {
      let best = 0;
      let score = -1;
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const apart = chosen.length ? Math.min(...chosen.map((x) => Math.abs(Math.atan2(Math.sin(a - x), Math.cos(a - x))))) : Math.PI;
        const s = Math.min(gap(a), apart * 0.8);
        if (s > score) (score = s), (best = a);
      }
      chosen.push(best);
      const off = new THREE.Vector2(Math.cos(best), Math.sin(best)).multiplyScalar(R - 0.2);
      lampSpots.push({ id: `square:${sq.node.replace(/^n:/, '')}:${l + 1}`, label: `${sq.name ?? 'Square'}, lamp ${l + 1}`, x: cx + off.x, y: cy + 0.34, z: cz + off.y, rotY: lanternToward(-off.x, -off.y) });
    }
  }
  if (mortar.length) g.add(mesh(mergeGeometries(mortar), mat(0x4a433c), 0, 0, 0, false));
  const flagGeo = new THREE.CylinderGeometry(0.42, 0.44, 0.07, 6);
  for (const [list, geo] of [[flags, flagGeo], [curbs, box]] as const) {
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), list.length);
    list.forEach((k, i) => {
      im.setMatrixAt(i, k.m);
      im.setColorAt(i, k.c);
    });
    im.receiveShadow = true;
    g.add(im);
  }

  // ---------- Artisan Quarter clutter: hay, crates and barrels beside the workshops ----------
  const hay: THREE.Matrix4[] = [];
  const crates: THREE.Matrix4[] = [];
  const barrels: THREE.Matrix4[] = [];
  for (const b of world.buildings.filter((x) => x.district === 'artisan')) {
    const rot = Math.atan2((b.face?.[0] ?? 0) - b.x, (b.face?.[1] ?? 0) - b.z);
    const local = (lx: number, lz: number) => new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot).add(new THREE.Vector3(b.x, 0, b.z));
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const p = local(side * (b.w / 2 + 1.9 + r() * 0.6), -b.d / 2 + 1 + k * (b.d / 3) + r() * 0.5);
        if (onRoad(p.x, p.z, 0.8)) continue;
        const kind = (k + (side > 0 ? 1 : 0) + (b.id === 'tripo-stable' ? 0 : 1)) % 3;
        const ry = rot + (r() - 0.5) * 0.6;
        if (kind === 0) hay.push(m4(p.x, 0.5, p.z, ry, 1, 1, 1));
        else if (kind === 1) {
          crates.push(m4(p.x, 0.42, p.z, ry, 0.85, 0.85, 0.85));
          if (r() < 0.5) crates.push(m4(p.x + 0.1, 1.2, p.z, ry + 0.4, 0.7, 0.7, 0.7));
        } else {
          barrels.push(m4(p.x, 0.5, p.z, 0, 1, 1, 1));
          barrels.push(m4(p.x + 0.75, 0.5, p.z + 0.3, 0, 1, 1, 1));
        }
        circles.push({ x: p.x, z: p.z, r: 1.4 });
      }
    }
  }
  const props = (geo: THREE.BufferGeometry, list: THREE.Matrix4[], color: number) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat(color), list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    im.receiveShadow = true;
    g.add(im);
  };
  props(new THREE.CylinderGeometry(0.55, 0.55, 1.5, 10).rotateZ(Math.PI / 2), hay, 0xc9a74e);
  props(box, crates, 0x8a6238);
  props(new THREE.CylinderGeometry(0.36, 0.32, 1.0, 9), barrels, 0x6e4a2c);

  // ---------- the Forgotten Woods: darker forest floor and a low mist ----------
  const woods = world.districts.find((x) => x.id === 'woods');
  if (woods) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const grd = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.65, '#bbbbbb');
    grd.addColorStop(1, '#000000');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    const alpha = new THREE.CanvasTexture(c);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(woods.radius + 8, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x232a1a, roughness: 1, transparent: true, alphaMap: alpha, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    );
    floor.position.set(woods.center[0], 0.0, woods.center[1]);
    floor.receiveShadow = true;
    floor.renderOrder = -1;
    floor.name = 'woods-floor';
    g.add(floor);
    const mc = document.createElement('canvas');
    mc.width = 128;
    mc.height = 64;
    const mx = mc.getContext('2d')!;
    const mg = mx.createRadialGradient(64, 32, 4, 64, 32, 60);
    mg.addColorStop(0, 'rgba(255,255,255,1)');
    mg.addColorStop(1, 'rgba(255,255,255,0)');
    mx.fillStyle = mg;
    mx.fillRect(0, 0, 128, 64);
    const mistTex = new THREE.CanvasTexture(mc);
    const mistMat = new THREE.SpriteMaterial({ map: mistTex, color: 0xa7b3ad, transparent: true, opacity: 0.16, depthWrite: false, fog: true });
    const mr = rng(77);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(mistMat);
      const a = (i / 3) * Math.PI * 2 + mr();
      s.position.set(woods.center[0] + Math.cos(a) * woods.radius * 0.4, 1.4, woods.center[1] + Math.sin(a) * woods.radius * 0.4);
      s.scale.set(26, 6, 1);
      s.name = 'mist';
      g.add(s);
    }
  }

  return { group: g, lampSpots, keepout: { circles, segments } };
}
