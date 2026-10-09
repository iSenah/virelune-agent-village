// Procedural building kit for the village: stone plinths, cobblestone paths, a star plaza, lanterns,
// timber-framed houses, towers and signboards. Simple shapes, warm palette, no external assets.
import * as THREE from '../../vendor/three.module.js';

export const PALETTE = {
  ground: 0x2b2729,
  stoneLight: 0xb9ab97,
  stone: 0x9d8f7d,
  stoneDark: 0x7c7166,
  /** warm sandstone for the plaza and roads, as in the hub concept */
  sand: 0xb59f80,
  wall: 0xeadcbc,
  timber: 0x6a4327,
  timberDark: 0x4a2e1b,
  door: 0x7a4a26,
  gold: 0xd9a441,
  roofBlue: 0x3a4f9e,
  roofNavy: 0x2b3a78,
  roofPurple: 0x6c4bc4,
  roofOrange: 0xc65a2c,
  roofGreen: 0x4f7a4a,
  glass: 0x2a2f45,
  glow: 0xffbe5c,
  crystal: 0xa875ff,
};

const matCache = new Map<string, THREE.Material>();
export function mat(color: number, opts: { rough?: number; metal?: number; emissive?: number; emissiveIntensity?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}-${opts.rough ?? 0.85}-${opts.metal ?? 0}-${opts.emissive ?? 0}-${opts.emissiveIntensity ?? 0}`;
  let m = matCache.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.85, metalness: opts.metal ?? 0, emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 0, flatShading: true });
    m.envMapIntensity = 0.3; // the environment light is tuned for the custom models; keep procedural stone matte
    matCache.set(key, m);
  }
  return m;
}

export function mesh(geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, cast = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A two-tier stone plinth with a rim of blocks, like a tabletop diorama base. */
export function plinth(w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const lower = new THREE.ExtrudeGeometry(roundedRect(w + 1.2, d + 1.2, 1.2), { depth: 0.55, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 1, curveSegments: 6 });
  lower.rotateX(-Math.PI / 2);
  g.add(mesh(lower, mat(PALETTE.stoneDark), 0, 0, 0));
  const upper = new THREE.ExtrudeGeometry(roundedRect(w, d, 1), { depth: 0.35, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1, curveSegments: 6 });
  upper.rotateX(-Math.PI / 2);
  g.add(mesh(upper, mat(PALETTE.stoneLight), 0, 0.6, 0));
  // rim blocks
  const block = new THREE.BoxGeometry(0.7, 0.42, 0.42);
  const rim = new THREE.InstancedMesh(block, mat(PALETTE.stone), 200);
  let i = 0;
  const dummy = new THREE.Object3D();
  const hw = (w + 1.1) / 2;
  const hd = (d + 1.1) / 2;
  const place = (x: number, z: number, rot: number) => {
    if (i >= 200) return;
    dummy.position.set(x, 0.32, z);
    dummy.rotation.set(0, rot, 0);
    dummy.scale.set(1, 0.9 + ((i * 37) % 10) / 50, 1);
    dummy.updateMatrix();
    rim.setMatrixAt(i++, dummy.matrix);
  };
  for (let x = -hw + 0.9; x <= hw - 0.9; x += 0.78) {
    place(x, hd, 0);
    place(x, -hd, 0);
  }
  for (let z = -hd + 0.9; z <= hd - 0.9; z += 0.78) {
    place(hw, z, Math.PI / 2);
    place(-hw, z, Math.PI / 2);
  }
  rim.count = i;
  rim.castShadow = true;
  rim.receiveShadow = true;
  g.add(rim);
  return g;
}

/** Deterministic pseudo-random numbers so the village looks the same every load. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Irregular, slightly domed stones (a squashed dodecahedron) read as hand-laid cobbles.
const cobbleGeo = new THREE.DodecahedronGeometry(0.29, 0).scale(1, 0.4, 1);
const curbGeo = new THREE.BoxGeometry(1, 1, 1);
const MORTAR = 0x4a433c;
function cobbleMesh(count: number) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, flatShading: true });
  m.envMapIntensity = 0.3;
  const im = new THREE.InstancedMesh(cobbleGeo, m, count);
  im.receiveShadow = true;
  return im;
}

/** Weathered stone colour: warm greys and tans, the odd mossy or darker stone. */
function stoneColor(c: THREE.Color, r: () => number, base = PALETTE.stone) {
  const roll = r();
  c.setHex(base);
  if (roll < 0.08) c.lerp(new THREE.Color(0x6f7a4e), 0.35); // moss
  else if (roll < 0.2) c.multiplyScalar(0.8);
  c.offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.05, (r() - 0.5) * 0.14);
}

/** A row of curb blocks of varying length along a line (local frame: along +x). */
function curbRow(len: number, z: number, r: () => number, into: { m: THREE.Matrix4; c: THREE.Color }[]) {
  const d = new THREE.Object3D();
  let x = -len / 2;
  while (x < len / 2 - 0.2) {
    const l = Math.min(0.6 + r() * 0.5, len / 2 - x);
    d.position.set(x + l / 2, 0.34 + r() * 0.03, z + (r() - 0.5) * 0.04);
    d.rotation.set(0, (r() - 0.5) * 0.05, 0);
    d.scale.set(l - 0.05, 0.3 + r() * 0.05, 0.34);
    d.updateMatrix();
    const c = new THREE.Color();
    stoneColor(c, r, PALETTE.stoneLight);
    into.push({ m: d.matrix.clone(), c });
    x += l;
  }
}

/** A cobblestone road from a to b (x/z): stones set in dark mortar, with curbs of irregular blocks. */
export function road(a: THREE.Vector2, b: THREE.Vector2, width: number, seed: number, withCurbs = true): THREE.Group {
  const g = new THREE.Group();
  const dir = b.clone().sub(a);
  const len = dir.length();
  const angle = Math.atan2(dir.y, dir.x);
  const r = rng(seed);
  const frame = new THREE.Group();
  frame.position.set((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
  frame.rotation.y = -angle;
  g.add(frame);
  frame.add(mesh(new THREE.BoxGeometry(len, 0.3, width + 0.7), mat(MORTAR), 0, 0.15, 0, false));
  const spacing = 0.44;
  const cols = Math.max(2, Math.floor(width / spacing));
  const rows = Math.max(2, Math.floor(len / spacing));
  const im = cobbleMesh(cols * rows);
  const d = new THREE.Object3D();
  const col = new THREE.Color();
  let i = 0;
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const along = -len / 2 + (ri + 0.5) * (len / rows) + (ci % 2 ? 0.11 : -0.11) + (r() - 0.5) * 0.07;
      const across = (ci + 0.5) * (width / cols) - width / 2 + (r() - 0.5) * 0.06;
      d.position.set(along, 0.31 + r() * 0.03, across);
      d.rotation.set((r() - 0.5) * 0.06, r() * Math.PI, (r() - 0.5) * 0.06);
      d.scale.set(0.92 + r() * 0.25, 0.9 + r() * 0.25, 0.88 + r() * 0.25);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
      stoneColor(col, r, PALETTE.sand);
      im.setColorAt(i++, col);
    }
  }
  frame.add(im);
  if (!withCurbs) return g;
  const curbs: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  curbRow(len, width / 2 + 0.2, r, curbs);
  curbRow(len, -width / 2 - 0.2, r, curbs);
  const cm = new THREE.InstancedMesh(curbGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), curbs.length);
  curbs.forEach((cb, k) => {
    cm.setMatrixAt(k, cb.m);
    cm.setColorAt(k, cb.c);
  });
  cm.castShadow = true;
  cm.receiveShadow = true;
  frame.add(cm);
  return g;
}

/** Central plaza: rings of cobbles in mortar, a curb of radial blocks, and a compass-star inlay. */
export function plaza(radius: number): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(radius + 0.75, radius + 0.95, 0.5, 48), mat(PALETTE.stoneDark), 0, 0.2, 0));
  g.add(mesh(new THREE.CylinderGeometry(radius + 0.4, radius + 0.4, 0.16, 48), mat(MORTAR), 0, 0.52, 0, false));
  const r = rng(7);
  const rings: number[] = [];
  for (let rr = radius; rr > 3.7; rr -= 0.47) rings.push(rr);
  const total = rings.reduce((n, rr) => n + Math.floor((2 * Math.PI * rr) / 0.46), 0);
  const im = cobbleMesh(total);
  const d = new THREE.Object3D();
  const col = new THREE.Color();
  let i = 0;
  for (const rr of rings) {
    const n = Math.floor((2 * Math.PI * rr) / 0.46);
    const offset = r() * Math.PI;
    for (let k = 0; k < n; k++) {
      const t = offset + (k / n) * Math.PI * 2;
      d.position.set(Math.cos(t) * rr, 0.6 + r() * 0.025, Math.sin(t) * rr);
      d.rotation.set(0, -t + (r() - 0.5) * 0.4, 0);
      d.scale.set(0.85 + r() * 0.25, 0.9 + r() * 0.2, 0.85 + r() * 0.2);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
      stoneColor(col, r, PALETTE.sand);
      im.setColorAt(i++, col);
    }
  }
  g.add(im);
  // outer curb of radial blocks
  const n = Math.floor((2 * Math.PI * (radius + 0.45)) / 0.75);
  const curb = new THREE.InstancedMesh(curbGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), n);
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    d.position.set(Math.cos(t) * (radius + 0.45), 0.62, Math.sin(t) * (radius + 0.45));
    d.rotation.set(0, -t + Math.PI / 2, 0);
    d.scale.set(0.7, 0.24 + r() * 0.05, 0.4);
    d.updateMatrix();
    curb.setMatrixAt(k, d.matrix);
    stoneColor(col, r, PALETTE.stoneLight);
    curb.setColorAt(k, col);
  }
  curb.receiveShadow = true;
  g.add(curb);
  // inlay under the fountain: blue disc, gold rings and an 8-point star whose tips reach out from the basin
  g.add(mesh(new THREE.CylinderGeometry(3.7, 3.7, 0.12, 48), mat(0x3f4f96), 0, 0.64, 0, false));
  g.add(mesh(new THREE.TorusGeometry(3.55, 0.08, 6, 48).rotateX(Math.PI / 2), mat(PALETTE.gold, { metal: 0.4, rough: 0.5 }), 0, 0.71, 0, false));
  g.add(mesh(new THREE.TorusGeometry(3.05, 0.05, 6, 48).rotateX(Math.PI / 2), mat(PALETTE.gold, { metal: 0.4, rough: 0.5 }), 0, 0.71, 0, false));
  const star = new THREE.Shape();
  for (let k = 0; k < 16; k++) {
    const rad = k % 2 === 0 ? (k % 4 === 0 ? 3.5 : 3.2) : 2.4;
    const t = (k / 16) * Math.PI * 2;
    if (k === 0) star.moveTo(Math.cos(t) * rad, Math.sin(t) * rad);
    else star.lineTo(Math.cos(t) * rad, Math.sin(t) * rad);
  }
  const sg = new THREE.ExtrudeGeometry(star, { depth: 0.06, bevelEnabled: false });
  sg.rotateX(-Math.PI / 2);
  g.add(mesh(sg, mat(PALETTE.gold, { metal: 0.45, rough: 0.45 }), 0, 0.69, 0, false));
  return g;
}

let haloTexture: THREE.Texture | null = null;
function halo(): THREE.Texture {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,214,140,0.95)');
  grd.addColorStop(0.35, 'rgba(255,180,90,0.35)');
  grd.addColorStop(1, 'rgba(255,160,60,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 64);
  haloTexture = new THREE.CanvasTexture(c);
  return haloTexture;
}

export function glowSprite(size: number, color = 0xffc070): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.set(size, size, size);
  return s;
}

/** Lantern on a post. Ambient decoration: it glows regardless of agent activity. */
export function lantern(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(0.14, 1.5, 0.14), mat(PALETTE.timberDark), 0, 1.05, 0));
  g.add(mesh(new THREE.BoxGeometry(0.42, 0.12, 0.42), mat(PALETTE.timberDark), 0, 1.86, 0));
  g.add(mesh(new THREE.BoxGeometry(0.32, 0.38, 0.32), mat(PALETTE.glow, { emissive: PALETTE.glow, emissiveIntensity: 1.6 }), 0, 2.1, 0, false));
  g.add(mesh(new THREE.ConeGeometry(0.3, 0.28, 4).rotateY(Math.PI / 4), mat(PALETTE.timberDark), 0, 2.43, 0));
  const h = glowSprite(1.6);
  h.position.set(0, 2.1, 0);
  g.add(h);
  g.userData.ambientGlow = h;
  return g;
}

export function steps(width: number, count: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) g.add(mesh(new THREE.BoxGeometry(width, 0.2, 0.45), mat(i % 2 ? PALETTE.stone : PALETTE.stoneLight), 0, 0.1 + i * 0.2, -i * 0.42));
  return g;
}

export type HouseOptions = { w: number; d: number; h: number; roof: number; roofH?: number; windowsFront?: number; chimney?: boolean };

/** A timber-framed house with a gabled roof. Window panes share one material so status can light them. */
export function house(o: HouseOptions, windowMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const { w, d, h } = o;
  const roofH = o.roofH ?? h * 0.75;
  g.add(mesh(new THREE.BoxGeometry(w, 0.4, d), mat(PALETTE.stone), 0, 0.2, 0));
  g.add(mesh(new THREE.BoxGeometry(w, h, d), mat(PALETTE.wall), 0, 0.4 + h / 2, 0));
  const timber = mat(PALETTE.timber);
  const post = new THREE.BoxGeometry(0.18, h, 0.18);
  for (const [x, z] of [[-w / 2, d / 2], [w / 2, d / 2], [-w / 2, -d / 2], [w / 2, -d / 2]]) g.add(mesh(post, timber, x, 0.4 + h / 2, z));
  for (const y of [0.45, 0.4 + h * 0.55, 0.4 + h]) {
    g.add(mesh(new THREE.BoxGeometry(w + 0.1, 0.14, 0.12), timber, 0, y, d / 2 + 0.03));
    g.add(mesh(new THREE.BoxGeometry(0.12, 0.14, d + 0.1), timber, w / 2 + 0.03, y, 0));
    g.add(mesh(new THREE.BoxGeometry(0.12, 0.14, d + 0.1), timber, -w / 2 - 0.03, y, 0));
  }
  // front windows
  const n = o.windowsFront ?? 2;
  const pane = new THREE.BoxGeometry(0.55, 0.8, 0.06);
  const frame = new THREE.BoxGeometry(0.72, 0.97, 0.05);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : -w / 2 + 0.9 + (i * (w - 1.8)) / (n - 1);
    if (Math.abs(x) < 0.8) continue; // leave room for the door
    g.add(mesh(frame, timber, x, 0.4 + h * 0.62, d / 2 + 0.03, false));
    g.add(mesh(pane, windowMat, x, 0.4 + h * 0.62, d / 2 + 0.07, false));
  }
  for (const side of [1, -1]) {
    g.add(mesh(new THREE.BoxGeometry(0.05, 0.97, 0.72), timber, side * (w / 2 + 0.03), 0.4 + h * 0.62, 0, false));
    g.add(mesh(new THREE.BoxGeometry(0.06, 0.8, 0.55), windowMat, side * (w / 2 + 0.07), 0.4 + h * 0.62, 0, false));
  }
  // door with arch
  g.add(mesh(new THREE.BoxGeometry(1.0, 1.5, 0.08), mat(PALETTE.door), 0, 0.4 + 0.75, d / 2 + 0.05));
  g.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 12, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), mat(PALETTE.door), 0, 0.4 + 1.5, d / 2 + 0.05));
  // gabled roof along x
  const tri = new THREE.Shape();
  const ov = 0.45;
  tri.moveTo(-(d / 2 + ov), 0);
  tri.lineTo(d / 2 + ov, 0);
  tri.lineTo(0, roofH);
  tri.closePath();
  const rg = new THREE.ExtrudeGeometry(tri, { depth: w + ov * 2, bevelEnabled: false });
  rg.rotateY(Math.PI / 2);
  rg.translate(-(w / 2 + ov), 0.4 + h - 0.05, 0);
  g.add(mesh(rg, mat(o.roof), 0, 0, 0));
  g.add(mesh(new THREE.BoxGeometry(w + ov * 2 + 0.1, 0.18, 0.3), mat(PALETTE.timberDark), 0, 0.4 + h + roofH - 0.05, 0));
  // roof tile rows (subtle ridges)
  const slope = Math.atan2(roofH, d / 2 + ov);
  const slopeLen = Math.hypot(roofH, d / 2 + ov);
  for (let k = 1; k < 4; k++) {
    const t = k / 4;
    for (const side of [1, -1]) {
      const bar = mesh(new THREE.BoxGeometry(w + ov * 2, 0.06, 0.08), mat(new THREE.Color(o.roof).multiplyScalar(0.8).getHex()), 0, 0.4 + h + roofH * t, side * (d / 2 + ov) * (1 - t), false);
      bar.rotation.x = side * slope;
      g.add(bar);
    }
  }
  void slopeLen;
  if (o.chimney !== false) {
    g.add(mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), mat(PALETTE.stoneDark), w / 2 - 0.8, 0.4 + h + roofH * 0.55, -d / 4));
    g.add(mesh(new THREE.BoxGeometry(0.75, 0.18, 0.75), mat(PALETTE.stone), w / 2 - 0.8, 0.4 + h + roofH * 0.55 + 0.85, -d / 4));
    g.userData.chimneyTop = new THREE.Vector3(w / 2 - 0.8, 0.4 + h + roofH * 0.55 + 1.0, -d / 4);
  }
  return g;
}

/** A round tower with a cone roof and a gold finial. */
export function tower(radius: number, height: number, roof: number, windowMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(radius, radius * 1.05, height, 10), mat(PALETTE.wall), 0, height / 2, 0));
  g.add(mesh(new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, 0.2, 10), mat(PALETTE.timber), 0, height, 0));
  g.add(mesh(new THREE.ConeGeometry(radius * 1.35, radius * 2.6, 10), mat(roof), 0, height + radius * 1.3, 0));
  g.add(mesh(new THREE.ConeGeometry(0.08, 0.6, 6), mat(PALETTE.gold, { metal: 0.5, rough: 0.4 }), 0, height + radius * 2.6 + 0.25, 0));
  for (const y of [height * 0.45, height * 0.78]) g.add(mesh(new THREE.BoxGeometry(0.34, 0.6, 0.06), windowMat, 0, y, radius + 0.01, false));
  return g;
}
