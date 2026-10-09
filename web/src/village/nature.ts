// Ambient landscape: grass ground, lawns, trees, bushes, rocks, flowers and grass tufts.
// Purely decorative and deterministic (seeded); nothing here reflects or implies agent activity.
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import * as THREE from '../../vendor/three.module.js';
import { rng } from './kit.ts';

export type Keepout = {
  circles: { x: number; z: number; r: number }[];
  segments: { a: THREE.Vector2; b: THREE.Vector2; r: number }[];
  custom?: (x: number, z: number, pad: number) => boolean;
  /** Ground height (plants on Scholars' Heights stand on the plateau). */
  heightAt?: (x: number, z: number) => number;
};

type Item = { x: number; y: number; z: number; s: number; rot: number; v: number };
/** Where to scatter: a ring around the fountain, or a disc around a point (e.g. the Forgotten Woods). */
type Area = { cx?: number; cz?: number; minR: number; maxR: number };

let grassCanvas: HTMLCanvasElement | null = null;

/** A painterly grass texture drawn once on a canvas (no image files needed). */
function grassImage(): HTMLCanvasElement {
  if (grassCanvas) return grassCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#4f7d3c';
  ctx.fillRect(0, 0, 512, 512);
  const r = rng(42);
  const greens = ['#5c8c44', '#46733a', '#6a9a4c', '#3f6a33', '#77a656', '#557f3f'];
  // soft colour patches
  for (let i = 0; i < 60; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const rad = 30 + r() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const col = greens[Math.floor(r() * greens.length)];
    g.addColorStop(0, col + 'aa');
    g.addColorStop(1, col + '00');
    ctx.fillStyle = g;
    for (const dx of [-512, 0, 512]) for (const dy of [-512, 0, 512]) {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      ctx.restore();
    }
  }
  // blades
  for (let i = 0; i < 9000; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const len = 3 + r() * 7;
    const ang = -Math.PI / 2 + (r() - 0.5) * 0.9;
    ctx.strokeStyle = greens[Math.floor(r() * greens.length)];
    ctx.globalAlpha = 0.35 + r() * 0.5;
    ctx.lineWidth = 1 + r();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  grassCanvas = c;
  return c;
}

export function grassMaterial(repeat: number): THREE.MeshStandardMaterial {
  const tex = new THREE.CanvasTexture(grassImage());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
  m.envMapIntensity = 0.25;
  return m;
}

export function grassGround(radius: number): THREE.Mesh {
  const geo = new THREE.CircleGeometry(radius, 64).rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, grassMaterial(radius / 6));
  m.position.y = -0.02;
  m.receiveShadow = true;
  return m;
}

function blocked(k: Keepout, x: number, z: number, pad = 0): boolean {
  if (k.custom?.(x, z, pad)) return true;
  for (const c of k.circles) if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + pad) ** 2) return true;
  const p = new THREE.Vector2(x, z);
  for (const s of k.segments) {
    const ab = s.b.clone().sub(s.a);
    const t = Math.max(0, Math.min(1, p.clone().sub(s.a).dot(ab) / ab.lengthSq()));
    if (s.a.clone().add(ab.multiplyScalar(t)).distanceTo(p) < s.r + pad) return true;
  }
  return false;
}

function scatter(k: Keepout, count: number, seed: number, area: Area, pad: number, avoid?: Area): Item[] {
  const r = rng(seed);
  const out: Item[] = [];
  const cx = area.cx ?? 0;
  const cz = area.cz ?? 0;
  for (let tries = 0; out.length < count && tries < count * 40; tries++) {
    const ang = r() * Math.PI * 2;
    const rad = area.minR + Math.sqrt(r()) * (area.maxR - area.minR);
    const x = cx + Math.cos(ang) * rad;
    const z = cz + Math.sin(ang) * rad;
    if (avoid && Math.hypot(x - (avoid.cx ?? 0), z - (avoid.cz ?? 0)) < avoid.maxR) continue;
    if (blocked(k, x, z, pad)) continue;
    if (out.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 < pad * pad * 0.5)) continue;
    out.push({ x, y: k.heightAt?.(x, z) ?? 0, z, s: 0.75 + r() * 0.6, rot: r() * Math.PI * 2, v: r() });
  }
  return out;
}

function instanced(geo: THREE.BufferGeometry, material: THREE.Material, items: Item[], place: (d: THREE.Object3D, it: (typeof items)[number]) => void, color?: (c: THREE.Color, it: (typeof items)[number]) => void, shadows = true): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, material, Math.max(1, items.length));
  const d = new THREE.Object3D();
  const c = new THREE.Color();
  items.forEach((it, i) => {
    d.position.set(it.x, it.y, it.z);
    d.rotation.set(0, it.rot, 0);
    d.scale.setScalar(it.s);
    place(d, it);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
    if (color) {
      color(c, it);
      im.setColorAt(i, c);
    }
  });
  im.count = items.length;
  im.castShadow = shadows;
  im.receiveShadow = true;
  return im;
}

const flat = (color: number, rough = 0.9) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true });
  m.envMapIntensity = 0.3;
  return m;
};

/**
 * Trees, bushes, rocks, flowers and grass tufts around the village, kept off roads and building lots.
 * `woods` is the Forgotten Woods: a dense, darker pine forest with mossy rocks.
 */
export function landscape(k: Keepout, woods?: { x: number; z: number; r: number }): THREE.Group {
  const g = new THREE.Group();
  const wood: Area | undefined = woods && { cx: woods.x, cz: woods.z, minR: 0, maxR: woods.r };
  const near: Area = { minR: 14, maxR: 30 };
  const outer: Area = { minR: 30, maxR: 112 };
  // --- broadleaf trees: trunk + two foliage blobs (none inside the woods: those are all pines)
  const trees = scatter(k, 120, 11, outer, 3.2, wood).concat(scatter(k, 12, 12, near, 3.5));
  g.add(instanced(new THREE.CylinderGeometry(0.22, 0.38, 2.4, 6), flat(0x6b4a2f), trees, (d) => (d.position.y += 1.2)));
  const foliage = mergeGeometries([new THREE.IcosahedronGeometry(1.7, 1).translate(0, 3.4, 0), new THREE.IcosahedronGeometry(1.25, 1).translate(0.8, 4.4, 0.3), new THREE.IcosahedronGeometry(1.1, 1).translate(-0.7, 4.1, -0.4)]);
  g.add(instanced(foliage, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, color: 0xffffff }), trees, () => {}, (c, it) => c.setHSL(0.26 + it.v * 0.06, 0.5, 0.3 + it.v * 0.1, THREE.SRGBColorSpace)));
  // --- pines: scattered around the valley, and packed close in the Forgotten Woods
  const pines = scatter(k, 150, 21, outer, 2.8, wood).concat(scatter(k, 110, 22, { minR: 60, maxR: 125 }, 2.6, wood));
  const woodPines = wood ? scatter(k, 150, 23, { ...wood, maxR: wood.maxR + 6 }, 2.0) : [];
  const pine = mergeGeometries([new THREE.CylinderGeometry(0.18, 0.25, 1.2, 5).translate(0, 0.6, 0), new THREE.ConeGeometry(1.5, 2.4, 7).translate(0, 2.2, 0), new THREE.ConeGeometry(1.15, 2.0, 7).translate(0, 3.4, 0), new THREE.ConeGeometry(0.75, 1.6, 7).translate(0, 4.5, 0)]);
  const allPines = [...pines.map((p) => ({ ...p, dark: false })), ...woodPines.map((p) => ({ ...p, s: p.s * 1.25, dark: true }))];
  g.add(instanced(pine, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, color: 0xffffff }), allPines, (d, it) => d.scale.setScalar(it.s * 1.15), (c, it) => ((it as any).dark ? c.setHSL(0.4 + it.v * 0.05, 0.3, 0.12 + it.v * 0.06, THREE.SRGBColorSpace) : c.setHSL(0.36 + it.v * 0.04, 0.45, 0.22 + it.v * 0.07, THREE.SRGBColorSpace))));
  // --- bushes near lots and roads
  const bushes = scatter(k, 230, 31, { minR: 8, maxR: 85 }, 1.1, wood);
  g.add(instanced(new THREE.IcosahedronGeometry(0.75, 1), new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true, color: 0xffffff }), bushes, (d, it) => {
    d.position.y += 0.35;
    d.scale.set(it.s, it.s * 0.7, it.s);
  }, (c, it) => c.setHSL(0.27 + it.v * 0.07, 0.48, 0.26 + it.v * 0.08, THREE.SRGBColorSpace)));
  // --- rocks (mossier and darker in the woods)
  const rocks = scatter(k, 80, 41, { minR: 9, maxR: 100 }, 1.4, wood).concat(wood ? scatter(k, 30, 42, wood, 1.6).map((x) => ({ ...x, s: x.s * 1.6, v: -1 })) : []);
  g.add(instanced(new THREE.DodecahedronGeometry(0.55, 0), new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, color: 0xffffff }), rocks, (d, it) => {
    d.position.y += 0.15;
    d.scale.set(it.s, it.s * 0.6, it.s * 0.85);
  }, (c, it) => (it.v < 0 ? c.setHSL(0.2, 0.12, 0.27, THREE.SRGBColorSpace) : c.setHSL(0.08, 0.06, 0.45 + it.v * 0.15, THREE.SRGBColorSpace))));
  // --- flowers (no shadows; tiny; none in the woods)
  const flowers = scatter(k, 600, 51, { minR: 7, maxR: 70 }, 0.35, wood);
  const palette = [0xf2c94c, 0xf5f0e6, 0xe58fb3, 0xb59cf0, 0xf08a4b];
  const flowerMesh = instanced(new THREE.IcosahedronGeometry(0.09, 0), new THREE.MeshStandardMaterial({ roughness: 0.7, flatShading: true, color: 0xffffff }), flowers, (d) => (d.position.y += 0.12), (c, it) => c.setHex(palette[Math.floor(it.v * palette.length)]), false);
  flowerMesh.userData.groundDetail = true;
  g.add(flowerMesh);
  // --- grass tufts: a few thin blades per tuft
  const blades: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const b = new THREE.ConeGeometry(0.05, 0.55, 3);
    b.translate(0, 0.27, 0);
    b.rotateZ((i - 2) * 0.22);
    b.rotateY(i * 1.3);
    b.translate((i - 2) * 0.05, 0, ((i * 7) % 3) * 0.04);
    blades.push(b);
  }
  const tufts = scatter(k, 2000, 61, { minR: 6.5, maxR: 75 }, 0.3);
  const tuftMesh = instanced(mergeGeometries(blades), new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, color: 0xffffff }), tufts, () => {}, (c, it) => c.setHSL(0.25 + it.v * 0.07, 0.5, 0.32 + it.v * 0.1, THREE.SRGBColorSpace), false);
  tuftMesh.userData.groundDetail = true;
  g.add(tuftMesh);
  return g;
}
