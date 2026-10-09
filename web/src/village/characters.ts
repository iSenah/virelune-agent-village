// Procedural low-poly residents based on the concept art in docs/concept-art/.
//   Echo   - fluffy lynx-eared Mayor in a navy coat with gold trim and a blue-crystal staff
//   Claude - scholarly badger in a cream coat, red scarf, with a book and backpack
//   Codex  - brass tinkerer robot with goggles, glowing blue eyes, navy scarf and a wrench
//   Aura   - stone golem with purple crystals and glowing eyes
// "glow" materials (eyes, crystals) are driven by REAL connection status: lit when connected, dim otherwise.
import * as THREE from '../../vendor/three.module.js';
import { glowSprite } from './kit.ts';
import { modelMaterials } from './models.ts';

type Built = { group: THREE.Group; materials: THREE.MeshStandardMaterial[]; glow: THREE.MeshStandardMaterial[] };

function make(): { g: THREE.Group; mats: THREE.MeshStandardMaterial[]; glow: THREE.MeshStandardMaterial[]; m: (color: number, o?: { metal?: number; rough?: number }) => THREE.MeshStandardMaterial; gm: (color: number) => THREE.MeshStandardMaterial; add: (geo: THREE.BufferGeometry, mat: THREE.Material, x?: number, y?: number, z?: number) => THREE.Mesh } {
  const g = new THREE.Group();
  const mats: THREE.MeshStandardMaterial[] = [];
  const glow: THREE.MeshStandardMaterial[] = [];
  const m = (color: number, o: { metal?: number; rough?: number } = {}) => {
    const mat = new THREE.MeshStandardMaterial({ color, metalness: o.metal ?? 0, roughness: o.rough ?? 0.75, flatShading: true, transparent: true });
    mats.push(mat);
    return mat;
  };
  const gm = (color: number) => {
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.1, roughness: 0.3, flatShading: true, transparent: true });
    mats.push(mat);
    glow.push(mat);
    return mat;
  };
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  return { g, mats, glow, m, gm, add };
}

function echo(): Built {
  const { g, mats, glow, m, gm, add } = make();
  const navy = m(0x2c3566);
  const gold = m(0xd9a441, { metal: 0.5, rough: 0.4 });
  const fur = m(0xe8dccb);
  const furDark = m(0x5b5f7d);
  add(new THREE.CylinderGeometry(0.32, 0.55, 0.9, 8), navy, 0, 0.55, 0); // coat
  add(new THREE.CylinderGeometry(0.56, 0.56, 0.06, 8), gold, 0, 0.12, 0); // hem trim
  add(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 10).rotateX(Math.PI / 2), gold, 0, 0.75, 0.33); // leaf medallion
  const head = add(new THREE.IcosahedronGeometry(0.42, 1), fur, 0, 1.28, 0);
  head.scale.set(1.1, 0.95, 1);
  add(new THREE.IcosahedronGeometry(0.3, 0), furDark, 0, 1.42, -0.08).scale.set(1.2, 0.7, 1);
  for (const s of [1, -1]) {
    const ear = add(new THREE.ConeGeometry(0.17, 0.62, 5), furDark, s * 0.3, 1.78, -0.02);
    ear.rotation.z = -s * 0.45;
    add(new THREE.ConeGeometry(0.05, 0.25, 4), fur, s * 0.47, 2.12, -0.02).rotation.z = -s * 0.45; // ear tufts
    add(new THREE.SphereGeometry(0.075, 8, 6), m(0x2a1d12), s * 0.15, 1.32, 0.36); // eyes
  }
  add(new THREE.SphereGeometry(0.045, 6, 4), m(0x8a5a4a), 0, 1.2, 0.42); // nose
  const tail = add(new THREE.IcosahedronGeometry(0.38, 1), furDark, -0.38, 0.75, -0.4);
  tail.scale.set(0.75, 1.5, 0.75);
  tail.rotation.z = 0.6;
  add(new THREE.IcosahedronGeometry(0.2, 1), fur, -0.62, 1.18, -0.55);
  // staff with a blue crystal (glows only when Echo is connected)
  add(new THREE.CylinderGeometry(0.04, 0.05, 1.9, 6), m(0x6a4327), 0.55, 0.95, 0.1);
  add(new THREE.OctahedronGeometry(0.16), gm(0x4aa8ff), 0.55, 2.0, 0.1).scale.y = 1.5;
  return { group: g, materials: mats, glow };
}

function claude(): Built {
  const { g, mats, glow, m, gm, add } = make();
  const coat = m(0xe8dcc4);
  const red = m(0x9c3426);
  const leather = m(0x6b4127);
  const black = m(0x2b2626);
  const white = m(0xf2ece2);
  add(new THREE.CylinderGeometry(0.4, 0.6, 1.0, 8), coat, 0, 0.55, 0);
  add(new THREE.CylinderGeometry(0.61, 0.61, 0.05, 8), m(0xc9a26b), 0, 0.1, 0);
  add(new THREE.TorusGeometry(0.33, 0.12, 6, 10).rotateX(Math.PI / 2), red, 0, 1.08, 0); // scarf
  add(new THREE.BoxGeometry(0.5, 0.6, 0.3), leather, 0, 0.75, -0.42); // backpack
  add(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 6), m(0xe9d9b0), 0.15, 1.2, -0.45).rotation.z = 0.3; // scroll
  const head = add(new THREE.IcosahedronGeometry(0.4, 1), white, 0, 1.45, 0.05);
  head.scale.set(1, 0.95, 1.15);
  for (const s of [1, -1]) {
    const stripe = add(new THREE.BoxGeometry(0.16, 0.34, 0.62), black, s * 0.2, 1.5, 0.05);
    stripe.rotation.z = s * 0.15;
    add(new THREE.SphereGeometry(0.1, 6, 4), black, s * 0.3, 1.82, -0.05); // ears
    add(new THREE.SphereGeometry(0.05, 6, 4), m(0x3b2412), s * 0.13, 1.5, 0.43); // eyes
  }
  add(new THREE.SphereGeometry(0.075, 6, 4), black, 0, 1.38, 0.52); // nose
  // the open book: its page glow is the real-status light for Claude
  const book = add(new THREE.BoxGeometry(0.42, 0.06, 0.32), leather, 0.32, 0.86, 0.38);
  book.rotation.x = -0.6;
  add(new THREE.BoxGeometry(0.36, 0.02, 0.26), gm(0xffd27a), 0.32, 0.9, 0.4).rotation.x = -0.6;
  return { group: g, materials: mats, glow };
}

function codex(): Built {
  const { g, mats, glow, m, gm, add } = make();
  const brass = m(0xb9853c, { metal: 0.7, rough: 0.35 });
  const brassDark = m(0x7a5426, { metal: 0.6, rough: 0.45 });
  const navy = m(0x2c3566);
  add(new THREE.CylinderGeometry(0.42, 0.5, 0.8, 10), brass, 0, 0.6, 0);
  add(new THREE.BoxGeometry(0.5, 0.55, 0.06), m(0x5a3a22), 0, 0.5, 0.45); // apron
  add(new THREE.TorusGeometry(0.36, 0.11, 6, 12).rotateX(Math.PI / 2), navy, 0, 1.02, 0); // scarf
  for (const s of [1, -1]) add(new THREE.CylinderGeometry(0.13, 0.15, 0.3, 8), brassDark, s * 0.24, 0.13, 0); // boots
  const head = add(new THREE.SphereGeometry(0.48, 12, 10), brass, 0, 1.48, 0);
  head.scale.set(1.05, 0.95, 1);
  add(new THREE.BoxGeometry(0.62, 0.36, 0.1), m(0x15161c, { rough: 0.3 }), 0, 1.45, 0.42); // visor
  const eye = gm(0x5ab8ff);
  for (const s of [1, -1]) {
    add(new THREE.SphereGeometry(0.08, 8, 6), eye, s * 0.15, 1.46, 0.48);
    add(new THREE.TorusGeometry(0.13, 0.05, 6, 12), brassDark, s * 0.17, 1.86, 0.25).rotation.x = -0.6; // goggles
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10).rotateX(Math.PI / 2 - 0.6), eye, s * 0.17, 1.86, 0.25);
  }
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4), brassDark, 0.12, 2.05, -0.05); // antenna
  add(new THREE.SphereGeometry(0.06, 6, 4), brass, 0.12, 2.27, -0.05);
  // wrench
  add(new THREE.BoxGeometry(0.06, 0.6, 0.06), m(0x9aa0a8, { metal: 0.8, rough: 0.3 }), 0.55, 0.85, 0.2).rotation.z = -0.3;
  add(new THREE.TorusGeometry(0.08, 0.035, 4, 8, Math.PI * 1.4), m(0x9aa0a8, { metal: 0.8, rough: 0.3 }), 0.64, 1.16, 0.2);
  return { group: g, materials: mats, glow };
}

function aura(): Built {
  const { g, mats, glow, m, gm, add } = make();
  const stone = m(0x8f877a);
  const stoneDark = m(0x5e584f);
  const cloak = m(0x4b2f7a);
  const crystal = gm(0xb07cff);
  add(new THREE.DodecahedronGeometry(0.55, 0), stone, 0, 0.7, 0).scale.set(1.1, 1, 0.9);
  add(new THREE.ConeGeometry(0.6, 0.9, 6), cloak, 0, 0.45, -0.05);
  for (const s of [1, -1]) {
    add(new THREE.DodecahedronGeometry(0.28, 0), stoneDark, s * 0.62, 0.95, 0); // shoulders
    add(new THREE.DodecahedronGeometry(0.22, 0), stone, s * 0.7, 0.5, 0.1); // fists
    add(new THREE.OctahedronGeometry(0.14), crystal, s * 0.68, 1.25, 0).scale.y = 2;
    add(new THREE.BoxGeometry(0.22, 0.25, 0.25), stoneDark, s * 0.22, 0.12, 0); // feet
  }
  const head = add(new THREE.DodecahedronGeometry(0.42, 0), stone, 0, 1.45, 0);
  head.scale.set(1.05, 1, 1);
  add(new THREE.ConeGeometry(0.46, 0.5, 4), stoneDark, 0, 1.75, 0).rotation.y = Math.PI / 4; // hood
  add(new THREE.BoxGeometry(0.5, 0.22, 0.1), m(0x141018), 0, 1.42, 0.36); // face shadow
  for (const s of [1, -1]) add(new THREE.SphereGeometry(0.07, 8, 6), crystal, s * 0.12, 1.43, 0.42);
  for (let i = 0; i < 5; i++) {
    const c = add(new THREE.OctahedronGeometry(0.12 + (i % 2) * 0.05), crystal, (i - 2) * 0.15, 2.0 + (i % 2) * 0.12, -0.1);
    c.scale.y = 2.2;
    c.rotation.z = (i - 2) * 0.25;
  }
  return { group: g, materials: mats, glow };
}

function scribe(): Built {
  // No concept art yet: a small green-cloaked courier with a satchel.
  const { g, mats, glow, m, gm, add } = make();
  add(new THREE.ConeGeometry(0.5, 1.1, 8), m(0x3f6b45), 0, 0.55, 0);
  add(new THREE.SphereGeometry(0.3, 10, 8), m(0xf0d6b4), 0, 1.25, 0);
  add(new THREE.ConeGeometry(0.34, 0.5, 8), m(0x2d4f33), 0, 1.6, 0);
  add(new THREE.BoxGeometry(0.35, 0.3, 0.15), m(0x6b4127), 0.38, 0.6, 0.15);
  add(new THREE.BoxGeometry(0.2, 0.14, 0.02), gm(0xffe6a8), 0.38, 0.65, 0.24); // letter
  return { group: g, materials: mats, glow };
}

/** Combination residents reuse their runtime's character and carry their specialty's emblem. */
function withSpecialty(base: Built, specialty: 'blender' | 'unreal' | null): Built {
  if (!specialty) return base;
  const mat = new THREE.MeshStandardMaterial({ color: specialty === 'blender' ? 0xe0782f : 0xb07cff, emissive: specialty === 'blender' ? 0xe0782f : 0xb07cff, emissiveIntensity: 0.1, flatShading: true, transparent: true });
  base.materials.push(mat);
  base.glow.push(mat);
  const emblem = new THREE.Mesh(specialty === 'blender' ? new THREE.BoxGeometry(0.22, 0.22, 0.22) : new THREE.OctahedronGeometry(0.16), mat);
  emblem.position.set(-0.55, 1.0, 0.35);
  emblem.rotation.set(0.6, 0.7, 0);
  emblem.userData.keepWithModel = true; // stays visible next to the custom model
  base.group.add(emblem);
  return base;
}

export function buildCharacter(residentId: string, lineage: string): THREE.Group {
  const specialty = residentId.endsWith('-blender') ? 'blender' : residentId.endsWith('-unreal') ? 'unreal' : null;
  const base = lineage === 'echo' ? echo() : lineage === 'claude' ? claude() : lineage === 'codex' ? codex() : lineage === 'aura' ? aura() : scribe();
  const built = withSpecialty(base, specialty);
  const g = built.group;
  g.scale.setScalar(1.15);
  g.userData.materials = built.materials;
  g.userData.glow = built.glow;
  const marker = glowSprite(0.9, 0xffe08a);
  marker.position.set(0, 2.6, 0);
  marker.visible = false;
  g.add(marker);
  g.userData.marker = marker;
  return g;
}

/**
 * Swap a resident's procedural placeholder for its custom model. Combination residents (e.g. Codex · Blender)
 * reuse their runtime's model and keep a small specialty emblem. The placeholder stays as the fallback.
 */
export function attachCharacterModel(g: THREE.Group, model: THREE.Group) {
  const marker = g.userData.marker as THREE.Sprite;
  for (const child of g.children) {
    if (child === marker || child.userData.keepWithModel) continue;
    child.visible = false;
  }
  g.add(model);
  g.userData.model = model;
  g.userData.modelMats = modelMaterials(model).map((m) => ({ mat: m, base: m.color.clone() }));
  // The placeholder was scaled up; the model is already fitted, so undo that scale for the model.
  model.scale.multiplyScalar(1 / g.scale.x);
  const h = (model.userData.fittedSize as THREE.Vector3).y / g.scale.x;
  marker.position.y = h + 0.5;
  // Status ring on the ground: shown only while the resident is really connected.
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.0, depthWrite: false }));
  ring.position.y = 0.03;
  g.add(ring);
  g.userData.ring = ring;
}

/** Apply a resident's REAL status. Disconnected and unchecked residents look inactive (dimmed, no glow). */
export function applyCharacterStatus(g: THREE.Group, status: 'untested' | 'disconnected' | 'connected') {
  const opacity = status === 'connected' ? 1 : status === 'disconnected' ? 0.7 : 0.45;
  for (const m of g.userData.materials as THREE.MeshStandardMaterial[]) m.opacity = opacity;
  for (const m of g.userData.glow as THREE.MeshStandardMaterial[]) m.emissiveIntensity = status === 'connected' ? 1.6 : 0.05;
  const dim = status === 'connected' ? 1 : status === 'disconnected' ? 0.62 : 0.75;
  for (const { mat, base } of (g.userData.modelMats ?? []) as { mat: THREE.MeshStandardMaterial; base: THREE.Color }[]) mat.color.copy(base).multiplyScalar(dim);
  const ring = g.userData.ring as THREE.Mesh | undefined;
  if (ring) {
    (ring.material as THREE.MeshBasicMaterial).opacity = status === 'connected' ? 0.55 : 0;
    ring.visible = status === 'connected'; // no draw call while hidden
  }
}
