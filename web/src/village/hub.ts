// The hub look from the concept art, built procedurally: a crystal fountain on the plaza, a stone balustrade,
// wooden fences along the roads, a river ring with arched wooden bridges (one per crossing in the layout),
// and waterfalls dropping from Scholars' Heights into creeks that feed the river. Everything here is AMBIENT: deterministic, always the same,
// and never tied to (or suggestive of) agent activity.
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import * as THREE from '../../vendor/three.module.js';
import { glowSprite, mat, mesh, PALETTE, rng } from './kit.ts';
import { lanternToward, type LampSpot } from './lamps.ts';
import type { Fall } from './terrain.ts';
import { BRIDGE_SPAN, RIVER_W, riverRadius, type World } from './worldModel.ts';

export const PLAZA_R = 6.8;
export { RIVER_W, riverRadius } from './worldModel.ts';

const WOOD = 0x7a5231;
const WOOD_DARK = 0x5a3b22;

// ---------- animated water ----------
let waterCanvas: HTMLCanvasElement | null = null;
function waterImage(): HTMLCanvasElement {
  if (waterCanvas) return waterCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3d8fb4';
  ctx.fillRect(0, 0, 256, 256);
  const r = rng(77);
  for (let i = 0; i < 260; i++) {
    const x = r() * 256;
    const y = r() * 256;
    const w = 8 + r() * 30;
    ctx.strokeStyle = r() < 0.5 ? 'rgba(190,235,250,0.35)' : 'rgba(30,90,130,0.35)';
    ctx.lineWidth = 1 + r() * 1.5;
    for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) {
      ctx.beginPath();
      ctx.moveTo(x + dx - w / 2, y + dy);
      ctx.quadraticCurveTo(x + dx, y + dy - 2 - r() * 2, x + dx + w / 2, y + dy);
      ctx.stroke();
    }
  }
  waterCanvas = c;
  return c;
}

function waterMaterial(repeatU: number, repeatV: number): THREE.MeshStandardMaterial {
  const tex = new THREE.CanvasTexture(waterImage());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatU, repeatV);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({ map: tex, color: 0xd8f1ff, roughness: 0.18, metalness: 0.05, emissive: 0x0b2c3d, emissiveIntensity: 0.6 });
  m.envMapIntensity = 0.9;
  return m;
}

function fallImage(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const r = rng(91);
  ctx.fillStyle = 'rgba(170,220,240,0.75)';
  ctx.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 90; i++) {
    const x = r() * 128;
    ctx.strokeStyle = r() < 0.6 ? 'rgba(255,255,255,0.8)' : 'rgba(90,160,200,0.6)';
    ctx.lineWidth = 1 + r() * 3;
    const y = r() * 256;
    const len = 30 + r() * 90;
    for (const dy of [-256, 0, 256]) {
      ctx.beginPath();
      ctx.moveTo(x, y + dy);
      ctx.lineTo(x + (r() - 0.5) * 3, y + dy + len);
      ctx.stroke();
    }
  }
  return c;
}

/** A flat ribbon following a path of centre points (x/z), with UVs running along the flow. */
function ribbon(points: THREE.Vector2[], halfWidth: (i: number) => number, y: number, closed: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let along = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t = next.clone().sub(prev).normalize();
    const nrm = new THREE.Vector2(-t.y, t.x);
    const hw = halfWidth(i);
    if (i > 0) along += points[i].distanceTo(points[i - 1]);
    for (const s of [-1, 1]) {
      pos.push(points[i].x + nrm.x * hw * s, y, points[i].y + nrm.y * hw * s);
      uv.push((s + 1) / 2, along / 6);
    }
    if (i < n - 1 || closed) {
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // the winding above faces down; flip so the ribbon faces up
  const ix = g.getIndex()!;
  for (let k = 0; k < ix.count; k += 3) {
    const tmp = ix.getX(k + 1);
    ix.setX(k + 1, ix.getX(k + 2));
    ix.setX(k + 2, tmp);
  }
  g.computeVertexNormals();
  return g;
}

/** Place boxes (or other unit geometry) along a path; merged into one geometry. */
function placeAll(geo: THREE.BufferGeometry, mats: THREE.Matrix4[]): THREE.BufferGeometry {
  return mergeGeometries(mats.map((m) => geo.clone().applyMatrix4(m)));
}

const m4 = (x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1, rotZ = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, rotZ, 'YXZ')), new THREE.Vector3(sx, sy, sz));

// ---------- fountain ----------
function fountain(water: THREE.Material): { group: THREE.Group; crystal: THREE.Group; light: THREE.PointLight } {
  const g = new THREE.Group();
  const top = 0.62; // plaza surface
  g.add(mesh(new THREE.CylinderGeometry(2.75, 2.9, 0.28, 8), mat(PALETTE.stone), 0, top + 0.14, 0));
  g.add(mesh(new THREE.CylinderGeometry(2.2, 2.35, 0.5, 8), mat(PALETTE.stoneLight), 0, top + 0.53, 0));
  const rim = mesh(new THREE.TorusGeometry(2.12, 0.2, 5, 8).rotateX(Math.PI / 2).rotateY(Math.PI / 8), mat(PALETTE.stoneLight), 0, top + 0.8, 0);
  g.add(rim);
  g.add(mesh(new THREE.TorusGeometry(2.36, 0.05, 4, 8).rotateX(Math.PI / 2).rotateY(Math.PI / 8), mat(PALETTE.gold, { metal: 0.5, rough: 0.4 }), 0, top + 0.32, 0, false));
  const pool = new THREE.Mesh(new THREE.CircleGeometry(2.0, 8).rotateX(-Math.PI / 2).rotateY(Math.PI / 8), water);
  pool.position.y = top + 0.8;
  pool.receiveShadow = true;
  g.add(pool);
  // pedestal and bowl
  g.add(mesh(new THREE.CylinderGeometry(0.45, 0.62, 1.1, 8), mat(PALETTE.stoneDark), 0, top + 1.3, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.95, 0.5, 0.35, 8), mat(PALETTE.stoneLight), 0, top + 1.95, 0));
  g.add(mesh(new THREE.TorusGeometry(0.9, 0.05, 4, 8).rotateX(Math.PI / 2), mat(PALETTE.gold, { metal: 0.5, rough: 0.4 }), 0, top + 2.1, 0, false));
  // the crystal cluster (ambient glow, gently turning)
  const crystalMat = new THREE.MeshStandardMaterial({ color: 0x6fb4ff, emissive: 0x2f7bff, emissiveIntensity: 1.3, roughness: 0.15, metalness: 0.1, flatShading: true });
  const crystal = new THREE.Group();
  crystal.position.y = top + 2.15;
  const main = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), crystalMat);
  main.scale.set(1, 2.7, 1);
  main.position.y = 1.35;
  crystal.add(main);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.22 + (i % 2) * 0.06, 0), crystalMat);
    c.scale.set(1, 2.2, 1);
    c.position.set(Math.cos(a) * 0.45, 0.45, Math.sin(a) * 0.45);
    c.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
    crystal.add(c);
  }
  g.add(crystal);
  const halo = glowSprite(6, 0x6fb2ff);
  halo.position.y = top + 3.5;
  g.add(halo);
  const light = new THREE.PointLight(0x5c9dff, 8, 16, 1.6);
  light.position.y = top + 3.4;
  g.add(light);
  return { group: g, crystal, light };
}

// ---------- plaza balustrade ----------
function inGap(a: number, gaps: number[], half: number) {
  return gaps.some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < half);
}

function balustrade(radius: number, gaps: number[]): THREE.Group {
  const g = new THREE.Group();
  const n = Math.round((2 * Math.PI * radius) / 1.25);
  const half = 2.0 / radius;
  const posts: THREE.Matrix4[] = [];
  const caps: THREE.Matrix4[] = [];
  const rails: THREE.Matrix4[] = [];
  const balusters: THREE.Matrix4[] = [];
  const y = 0.45;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const b = ((k + 1) / n) * Math.PI * 2;
    if (inGap(a, gaps, half)) continue;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    posts.push(m4(x, y + 0.45, z, -a, 0.34, 0.9, 0.34));
    caps.push(m4(x, y + 0.95, z, -a, 0.44, 0.12, 0.44));
    if (inGap(b, gaps, half)) continue;
    const mid = (a + b) / 2;
    const chord = 2 * radius * Math.sin((b - a) / 2);
    const mx = Math.cos(mid) * radius;
    const mz = Math.sin(mid) * radius;
    rails.push(m4(mx, y + 0.82, mz, -mid + Math.PI / 2, chord, 0.12, 0.2));
    rails.push(m4(mx, y + 0.12, mz, -mid + Math.PI / 2, chord, 0.12, 0.24));
    for (const t of [-0.25, 0.25]) {
      const ba = mid + (t * (b - a)) / 1;
      balusters.push(m4(Math.cos(ba) * radius, y + 0.47, Math.sin(ba) * radius, -ba, 0.12, 0.6, 0.12));
    }
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  const add = (list: THREE.Matrix4[], color: number) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(box, mat(color), list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    im.receiveShadow = true;
    g.add(im);
  };
  add(posts, PALETTE.stoneLight);
  add(caps, PALETTE.stone);
  add(rails, PALETTE.stoneLight);
  add(balusters, PALETTE.stone);
  return g;
}

// ---------- wooden fences ----------
/** Low wooden fences along both sides of a path from a to b (x/z), `offset` from its centre line. */
export function fenceAlong(segments: { a: THREE.Vector2; b: THREE.Vector2; offset: number }[]): THREE.Group {
  const g = new THREE.Group();
  const posts: THREE.Matrix4[] = [];
  const rails: THREE.Matrix4[] = [];
  for (const s of segments) {
    const dir = s.b.clone().sub(s.a);
    const len = dir.length();
    if (len < 1.5) continue;
    dir.normalize();
    const nrm = new THREE.Vector2(-dir.y, dir.x);
    const rot = -Math.atan2(dir.y, dir.x);
    const count = Math.max(1, Math.round(len / 1.7));
    for (const side of [1, -1]) {
      const o = nrm.clone().multiplyScalar(s.offset * side);
      for (let i = 0; i <= count; i++) {
        const p = s.a.clone().add(dir.clone().multiplyScalar((i / count) * len)).add(o);
        posts.push(m4(p.x, 0.45, p.y, rot, 0.16, 0.9, 0.16));
      }
      const mid = s.a.clone().add(s.b).multiplyScalar(0.5).add(o);
      rails.push(m4(mid.x, 0.72, mid.y, rot, len, 0.1, 0.07));
      rails.push(m4(mid.x, 0.4, mid.y, rot, len, 0.1, 0.07));
    }
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  for (const [list, color] of [[posts, WOOD_DARK], [rails, WOOD]] as const) {
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(box, mat(color), list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = true;
    im.receiveShadow = true;
    g.add(im);
  }
  return g;
}

// ---------- bridges ----------
/** An arched wooden bridge along +X in its own frame, centred on the origin. */
function bridge(length: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const rise = 1.1;
  const h = (s: number) => 0.25 + rise * Math.sin(Math.PI * (s / length + 0.5));
  const slope = (s: number) => Math.atan(((rise * Math.PI) / length) * Math.cos(Math.PI * (s / length + 0.5)));
  const planks: THREE.Matrix4[] = [];
  const dark: THREE.Matrix4[] = [];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const n = Math.round(length / 0.36);
  for (let i = 0; i < n; i++) {
    const s = -length / 2 + ((i + 0.5) / n) * length;
    planks.push(m4(s, h(s), 0, 0, length / n - 0.04, 0.12, width + (i % 3 === 0 ? 0.12 : 0), slope(s)));
  }
  // beams under the deck, posts and hand rails
  for (const side of [1, -1]) {
    const z = side * (width / 2 - 0.15);
    for (let i = 0; i < 8; i++) {
      const s = -length / 2 + ((i + 0.5) / 8) * length;
      dark.push(m4(s, h(s) - 0.17, z, 0, length / 8 + 0.05, 0.22, 0.22, slope(s)));
    }
    const pz = side * (width / 2 + 0.05);
    const np = 5;
    for (let i = 0; i <= np; i++) {
      const s = -length / 2 + 0.25 + (i / np) * (length - 0.5);
      dark.push(m4(s, h(s) + 0.45, pz, 0, 0.18, 0.95, 0.18));
      if (i < np) {
        const s2 = -length / 2 + 0.25 + ((i + 1) / np) * (length - 0.5);
        const mid = (s + s2) / 2;
        const len = Math.hypot(s2 - s, h(s2) - h(s));
        const ang = Math.atan2(h(s2) - h(s), s2 - s);
        planks.push(m4(mid, (h(s) + h(s2)) / 2 + 0.88, pz, 0, len + 0.1, 0.1, 0.14, ang));
        planks.push(m4(mid, (h(s) + h(s2)) / 2 + 0.5, pz, 0, len, 0.07, 0.08, ang));
      }
    }
  }
  const wood = new THREE.Mesh(placeAll(box, planks), mat(WOOD));
  const woodDark = new THREE.Mesh(placeAll(box, dark), mat(WOOD_DARK));
  // stone abutments at both ends
  const stones: THREE.Matrix4[] = [];
  for (const end of [-1, 1]) {
    stones.push(m4(end * (length / 2 + 0.3), 0.25, 0, 0, 1.2, 0.6, width + 0.9));
    for (const side of [1, -1]) stones.push(m4(end * (length / 2 + 0.3), 0.75, side * (width / 2 + 0.25), 0, 0.6, 1.1, 0.6));
  }
  const stone = new THREE.Mesh(placeAll(box, stones), mat(PALETTE.stone));
  for (const m of [wood, woodDark, stone]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// ---------- rocks and cliffs ----------
/** Instanced boulders. `darken` lowers their lightness (cliff rocks are a little darker than bank stones). */
export function rockField(items: { x: number; z: number; s: number; sy: number; rot: number; v: number; y?: number }[], detail = 0, darken = 0): THREE.InstancedMesh {
  const geo = new THREE.DodecahedronGeometry(1, detail);
  const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, color: 0xffffff }), Math.max(1, items.length));
  const d = new THREE.Object3D();
  const c = new THREE.Color();
  items.forEach((it, i) => {
    d.position.set(it.x, it.y ?? it.s * it.sy * 0.35, it.z);
    d.rotation.set(it.v * 0.6, it.rot, it.v * 0.3);
    d.scale.set(it.s, it.s * it.sy, it.s * (0.8 + it.v * 0.3));
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
    c.setHSL(0.07 + it.v * 0.03, 0.08 + it.v * 0.05, 0.42 + it.v * 0.16 - darken, THREE.SRGBColorSpace);
    im.setColorAt(i, c);
  });
  im.count = items.length;
  im.castShadow = true;
  im.receiveShadow = true;
  return im;
}

export type Hub = {
  group: THREE.Group;
  lampSpots: LampSpot[];
  /** True where trees and bushes should not grow (river, banks, waterfall pools). */
  blocked: (x: number, z: number, pad: number) => boolean;
  /** Bridges and creeks (for the landscape's keep-out). */
  segments: { a: THREE.Vector2; b: THREE.Vector2; r: number }[];
  update: (t: number) => void;
  setNight: (night: boolean) => void;
};

/**
 * Build the hub. `roadAngles` are the directions (radians) of the roads leaving the plaza toward buildings;
 * the balustrade leaves openings there and at the river crossings. `falls` come from the raised ground.
 */
export function buildHub(world: World, roadAngles: number[], falls: Fall[]): Hub {
  const g = new THREE.Group();
  const r = rng(303);
  const lampSpots: LampSpot[] = [];
  const segments: { a: THREE.Vector2; b: THREE.Vector2; r: number }[] = [];
  const animated: THREE.Texture[] = [];
  const fallTextures: THREE.Texture[] = [];

  const riverMat = waterMaterial(2, 1);
  animated.push(riverMat.map!);
  const poolMat = waterMaterial(1.5, 1.5);
  animated.push(poolMat.map!);

  // fountain and balustrade
  const f = fountain(poolMat);
  g.add(f.group);
  const crossingAngles = world.crossings.map((c) => (c.angle * Math.PI) / 180);
  g.add(balustrade(PLAZA_R + 1.25, [...roadAngles, ...crossingAngles]));

  // river ring with banks
  const N = 280;
  const centre: THREE.Vector2[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const R = riverRadius(th);
    centre.push(new THREE.Vector2(Math.cos(th) * R, Math.sin(th) * R));
  }
  const bank = new THREE.Mesh(ribbon(centre, () => RIVER_W / 2 + 1.1, 0.0, true), new THREE.MeshStandardMaterial({ color: 0x6f6a4c, roughness: 1 }));
  bank.receiveShadow = true;
  g.add(bank);
  const river = new THREE.Mesh(ribbon(centre, (i) => RIVER_W / 2 + Math.sin(i * 0.37) * 0.25, 0.05, true), riverMat);
  river.receiveShadow = true;
  g.add(river);
  // bank stones
  const bankRocks: { x: number; z: number; s: number; sy: number; rot: number; v: number }[] = [];
  for (let i = 0; i < 260; i++) {
    const th = r() * Math.PI * 2;
    if (crossingAngles.some((a) => Math.abs(Math.atan2(Math.sin(th - a), Math.cos(th - a))) < 0.07)) continue;
    const side = r() < 0.5 ? -1 : 1;
    const R = riverRadius(th) + side * (RIVER_W / 2 + 0.3 + r() * 1.2);
    bankRocks.push({ x: Math.cos(th) * R, z: Math.sin(th) * R, s: 0.35 + r() * 0.7, sy: 0.55 + r() * 0.3, rot: r() * 6, v: r() });
  }
  g.add(rockField(bankRocks, 0));

  // an arched wooden bridge at every river crossing (the roads to and from it are drawn with the other roads)
  world.crossings.forEach((c) => {
    const a = (c.angle * Math.PI) / 180;
    const dir = new THREE.Vector2(Math.cos(a), Math.sin(a));
    const R = riverRadius(a);
    const p = (d: number) => dir.clone().multiplyScalar(d);
    const inner = R - BRIDGE_SPAN / 2 - 0.6;
    const outer = R + BRIDGE_SPAN / 2 + 0.6;
    const br = bridge(BRIDGE_SPAN, 2.3);
    br.position.set(dir.x * R, 0, dir.y * R);
    br.rotation.y = -a;
    g.add(br);
    segments.push({ a: p(inner - 1), b: p(outer + 1), r: 2.2 });
    // a lamp post at the village end of each bridge, lantern hanging over the trail
    const side = new THREE.Vector2(-dir.y, dir.x).multiplyScalar(1.9);
    const lp = p(inner - 0.8).add(side);
    lampSpots.push({ id: `bridge:${c.angle}`, label: `Bridge (${compass(a)})`, x: lp.x, y: 0, z: lp.y, rotY: lanternToward(-side.x, -side.y) });
  });

  // waterfalls down the edge of the raised ground, each feeding a creek that runs to the river
  const fallTex = new THREE.CanvasTexture(fallImage());
  fallTex.wrapS = fallTex.wrapT = THREE.RepeatWrapping;
  fallTex.colorSpace = THREE.SRGBColorSpace;
  fallTextures.push(fallTex);
  const fallMat = new THREE.MeshStandardMaterial({ map: fallTex, transparent: true, opacity: 0.9, roughness: 0.3, emissive: 0x2a5a70, emissiveIntensity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  const creekMat = waterMaterial(1, 1);
  animated.push(creekMat.map!);
  const sideRocks: { x: number; z: number; s: number; sy: number; rot: number; v: number; y?: number }[] = [];
  const pools: { x: number; z: number; r: number }[] = [];
  for (const fl of falls) {
    const a = fl.angle;
    const dir = new THREE.Vector2(Math.cos(a), Math.sin(a));
    const across = new THREE.Vector2(-dir.y, dir.x);
    const top = fl.height;
    // the fall itself: a curtain down the cliff face, facing the village
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(3.2, top + 0.2, 1, 6), fallMat);
    fall.position.set(dir.x * (fl.edge - 0.35), top / 2, dir.y * (fl.edge - 0.35));
    fall.rotation.y = -a - Math.PI / 2;
    fall.renderOrder = 2;
    g.add(fall);
    // rocks either side of the fall
    for (const s of [-1, 1]) {
      for (let j = 0; j < 4; j++) {
        const n = across.clone().multiplyScalar(s * (2.6 + j * 0.5));
        const R = fl.edge - 0.8 + j * 0.3;
        sideRocks.push({ x: dir.x * R + n.x, z: dir.y * R + n.y, s: 1.5 + j * 0.25, sy: 1.2 + (3 - j) * 0.15, rot: j + s, v: 0.3 + j * 0.1, y: 1 + j * (top / 4) });
      }
    }
    // a short stream on top running to the edge
    const upper: THREE.Vector2[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      upper.push(dir.clone().multiplyScalar(fl.edge + 9 - t * 9).add(across.clone().multiplyScalar(Math.sin(t * Math.PI * 1.5) * 0.8)));
    }
    const upperCreek = new THREE.Mesh(ribbon(upper, () => 1.1, top + 0.04, false), creekMat);
    upperCreek.receiveShadow = true;
    g.add(upperCreek);
    // foam pool at the foot and a creek down to the river
    const foot = dir.clone().multiplyScalar(fl.edge - 2.2);
    const foam = new THREE.Mesh(new THREE.CircleGeometry(2.4, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe6f6fb, roughness: 0.5, transparent: true, opacity: 0.85, emissive: 0x335566, emissiveIntensity: 0.3 }));
    foam.position.set(foot.x, 0.07, foot.y);
    g.add(foam);
    pools.push({ x: foot.x, z: foot.y, r: 3.4 });
    const from = dir.clone().multiplyScalar(fl.edge - 2);
    const to = dir.clone().multiplyScalar(riverRadius(a) + RIVER_W / 2 - 0.4);
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(from.clone().lerp(to, t).add(across.clone().multiplyScalar(Math.sin(t * Math.PI * 2) * 0.9)));
    }
    const creekBank = new THREE.Mesh(ribbon(pts, () => 1.9, 0.01, false), bank.material as THREE.Material);
    creekBank.receiveShadow = true;
    g.add(creekBank);
    const creek = new THREE.Mesh(ribbon(pts, () => 1.1, 0.055, false), creekMat);
    creek.receiveShadow = true;
    g.add(creek);
    segments.push({ a: from, b: to, r: 2.8 });
    segments.push({ a: dir.clone().multiplyScalar(fl.edge), b: dir.clone().multiplyScalar(fl.edge + 9), r: 2.4 });
  }
  if (sideRocks.length) g.add(rockField(sideRocks, 0));

  const blocked = (x: number, z: number, pad: number) => {
    const th = Math.atan2(z, x);
    const d = Math.hypot(x, z);
    if (Math.abs(d - riverRadius(th)) < RIVER_W / 2 + 1.4 + pad) return true;
    return pools.some((p) => (x - p.x) ** 2 + (z - p.z) ** 2 < (p.r + pad) ** 2);
  };

  return {
    group: g,
    lampSpots,
    blocked,
    segments,
    update: (t: number) => {
      // ambient only: water flows, the crystal turns slowly
      for (const tex of animated) tex.offset.y = -t * 0.05;
      for (const tex of fallTextures) tex.offset.y = t * 0.6;
      f.crystal.rotation.y = t * 0.25;
      f.crystal.position.y = 0.62 + 2.15 + Math.sin(t * 1.1) * 0.06;
    },
    setNight: (night: boolean) => {
      f.light.intensity = night ? 10 : 3;
    },
  };
}

function compass(a: number): string {
  // 0 = east (+X), +Z = south on screen
  const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const i = Math.round(((((a * 180) / Math.PI) % 360) + 360) % 360 / 45) % 8;
  return names[i];
}
