// Village buildings, signboards and the procedural stand-in bodies. Positions come from the layout
// (config/layout/world.json); the seven original buildings have procedural bodies until their custom models load.
// New building slots (Tripo Stable, Runway Cinema, the Heights and the Woods) deliberately get NO generic house:
// they show only a development marker until their real models arrive.
import * as THREE from '../../vendor/three.module.js';
import { house, mat, mesh, PALETTE, plinth, steps, tower } from './kit.ts';
import { buildingRotY, groundY, type BuildingKind, type BuildingSpec, type World } from './worldModel.ts';

/** title/subtitle/tagline are the signboard lines; place is the building's name in the resident list. */
export type BuildingDef = { id: string; place: string; title: string; subtitle: string; tagline: string; x: number; y: number; z: number; rotY: number; w: number; d: number; kind: BuildingKind; district: string; modelNote?: string; indicatorHeight: number };

/** The buildings that have a procedural stand-in body. Every other slot waits for its real model. */
export const PROCEDURAL_BODIES = new Set(['town-hall', 'library', 'unreal-workshop', 'engineering-forge', 'blender-house', 'unreal-studio', 'post-office']);

export function defFromSpec(world: World, b: BuildingSpec): BuildingDef {
  return { id: b.id, place: b.place, title: b.title, subtitle: b.subtitle, tagline: b.tagline, x: b.x, y: groundY(world, b), z: b.z, rotY: buildingRotY(b), w: b.w, d: b.d, kind: b.kind, district: b.district, modelNote: b.modelNote, indicatorHeight: b.indicatorHeight ?? 14 };
}

const F = (id: string, place: string, title: string, subtitle: string, tagline: string, x: number, z: number, w: number, d: number): BuildingSpec => ({ id, place, title, subtitle, tagline, district: 'founders', kind: 'residence', x, z, w, d });
/**
 * Used only if Village Hall cannot send the layout: Founders' Square on its own, exactly as it has always been.
 * The full layout (with the other districts) lives in config/layout/world.json.
 */
export const FALLBACK_WORLD: World = {
  version: 1,
  plazaRadius: 6.8,
  districts: [{ id: 'founders', name: "Founders' Square", subtitle: 'Where the village began', center: [0, 0], radius: 36, elevation: 0 }],
  buildings: [
    F('town-hall', 'Town Hall', 'Echo', 'Town Hall', 'Coordinator · Mayor', 0, -18, 11, 8),
    F('library', 'Library & Archives', 'Claude', 'Library & Archives', 'Designer · Researcher', -20, -10, 9, 7.5),
    F('unreal-workshop', 'Unreal Workshop', 'Aura', 'Unreal Workshop', '3D · Environments', 20, -10, 9, 7.5),
    F('engineering-forge', 'Engineering Forge', 'Codex', 'Engineering Forge', 'Developer · Automation', -19, 13.5, 9, 7.5),
    F('post-office', 'Post Office', 'Scribe', 'Post Office', 'Notes · Summaries', 0, 23.5, 7, 6),
  ],
  nodes: {},
  crossings: [-124, -56, 0, 116].map((angle) => ({ id: String(angle), angle })),
  roads: ['town-hall', 'library', 'unreal-workshop', 'engineering-forge', 'post-office'].map((id) => ({ from: 'plaza', to: `b:${id}`, kind: 'cobble' as const })),
  plateaus: [],
};

/** Display names, for the control panel before the layout arrives. */
export const BUILDING_NAMES: [string, string][] = [
  ...FALLBACK_WORLD.buildings.map((b) => [b.id, b.place] as [string, string]),
  ['blender-house', 'Blender House'],
  ['unreal-studio', 'UE Studio'],
];

/** Where the two lamp posts flank a building's front (building-local coordinates, on the plinth top). */
export function plinthLampSpots(def: BuildingDef): { side: 'left' | 'right'; local: THREE.Vector3 }[] {
  return [
    { side: 'left', local: new THREE.Vector3(-def.w / 2 + 0.7, 0.95, def.d / 2 - 0.3) },
    { side: 'right', local: new THREE.Vector3(def.w / 2 - 0.7, 0.95, def.d / 2 - 0.3) },
  ];
}

export type BuildingHandle = {
  def: BuildingDef;
  group: THREE.Group;
  windowMat: THREE.MeshStandardMaterial;
  accentMats: THREE.MeshStandardMaterial[];
  light: THREE.PointLight;
  sign: THREE.Sprite;
  signCanvas: HTMLCanvasElement;
  chimney: THREE.Vector3 | null;
  doorLocal: THREE.Vector3;
  smoke: THREE.Sprite[];
  /** The procedural building body: the placeholder until a custom model loads, and the fallback if it fails. */
  body: THREE.Group;
  /** The custom GLB model once loaded. */
  model: THREE.Group | null;
  /** Development marker for a building slot whose model has not arrived yet (null for the original seven). */
  marker: THREE.Group | null;
};

const KIND_COLOR: Record<BuildingKind, number> = { residence: 0x5b8cff, workplace: 0xe0a030, service: 0xb070ff };
const KIND_WORD: Record<BuildingKind, string> = { residence: 'Home', workplace: 'Workplace', service: 'Service' };

/** Text laid flat on the plinth: what will stand here. Reads upright from the front of the slot. */
function slotLabel(def: BuildingDef, color: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 192;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(20,16,12,0.55)';
  ctx.beginPath();
  ctx.roundRect(6, 6, 500, 180, 22);
  ctx.fill();
  ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.setLineDash([18, 12]);
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4ead6';
  ctx.font = '600 34px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(`${KIND_WORD[def.kind]} slot · model coming`, 256, 72);
  ctx.font = '32px Georgia, "Times New Roman", serif';
  ctx.fillStyle = '#d8ccb2';
  const note = def.modelNote ?? def.place;
  ctx.fillText(note.length > 30 ? `${note.slice(0, 29)}…` : note, 256, 128);
  ctx.font = '24px system-ui, "Segoe UI", sans-serif';
  ctx.fillStyle = '#a99c84';
  ctx.fillText('Development marker', 256, 166);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const w = Math.min(def.w - 1.2, 8);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, (w * 192) / 512).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.position.set(0, 1.06, def.d / 2 - (w * 192) / 1024 - 0.5);
  m.renderOrder = 3;
  return m;
}

/**
 * A development-only marker for a slot without its model: a see-through volume of roughly the final size, a dashed
 * outline, an arrow at the entrance and a label saying what will stand here. Never a stand-in house.
 */
function slotMarker(def: BuildingDef): THREE.Group {
  const g = new THREE.Group();
  g.name = 'slot-marker';
  const color = KIND_COLOR[def.kind];
  const top = 0.95;
  const h = Math.max(6, def.indicatorHeight - 5);
  const box = new THREE.BoxGeometry(def.w - 0.8, h, def.d - 0.8);
  const vol = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
  vol.position.y = top + h / 2;
  vol.renderOrder = 2;
  g.add(vol);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineDashedMaterial({ color, dashSize: 0.7, gapSize: 0.45 }));
  edges.position.copy(vol.position);
  edges.computeLineDistances();
  g.add(edges);
  // arrow on the ground in front of the steps, pointing in through the door
  const arrow = new THREE.Shape();
  arrow.moveTo(0, -0.9);
  arrow.lineTo(0.8, 0.3);
  arrow.lineTo(0.28, 0.3);
  arrow.lineTo(0.28, 0.9);
  arrow.lineTo(-0.28, 0.9);
  arrow.lineTo(-0.28, 0.3);
  arrow.lineTo(-0.8, 0.3);
  arrow.closePath();
  const a = new THREE.Mesh(new THREE.ShapeGeometry(arrow).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
  a.position.set(0, 0.52, def.d / 2 + 2.6);
  a.renderOrder = 3;
  g.add(a);
  g.add(slotLabel(def, color));
  return g;
}

function windowMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: PALETTE.glass, emissive: PALETTE.glow, emissiveIntensity: 0, roughness: 0.4, flatShading: true });
}

export function drawSign(canvas: HTMLCanvasElement, def: BuildingDef, status: { label: string; color: string }) {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(r, 8);
  ctx.lineTo(W - r, 8);
  ctx.quadraticCurveTo(W - 8, 8, W - 8, r);
  ctx.lineTo(W - 8, H - r);
  ctx.quadraticCurveTo(W - 8, H - 8, W - r, H - 8);
  ctx.lineTo(r, H - 8);
  ctx.quadraticCurveTo(8, H - 8, 8, H - r);
  ctx.lineTo(8, r);
  ctx.quadraticCurveTo(8, 8, r, 8);
  ctx.closePath();
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#2f2722');
  grd.addColorStop(1, '#1d1714');
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#c99a45';
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(201,154,69,0.55)';
  ctx.strokeRect(22, 22, W - 44, H - 44);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4ead6';
  ctx.font = '600 64px Georgia, "Times New Roman", serif';
  ctx.fillText(def.title, W / 2, 86);
  ctx.font = '36px Georgia, "Times New Roman", serif';
  ctx.fillStyle = '#eadfca';
  ctx.fillText(def.subtitle, W / 2, 132);
  ctx.font = '28px Georgia, "Times New Roman", serif';
  ctx.fillStyle = '#cdbf9f';
  ctx.fillText(def.tagline, W / 2, 172);
  // status chip from REAL resident status
  ctx.font = '600 26px system-ui, "Segoe UI", sans-serif';
  const tw = ctx.measureText(status.label).width + 44;
  const cx = W / 2 - tw / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.roundRect(cx, 196, tw, 40, 20);
  ctx.fill();
  ctx.fillStyle = status.color;
  ctx.beginPath();
  ctx.arc(cx + 22, 216, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#efe6d2';
  ctx.textAlign = 'left';
  ctx.fillText(status.label, cx + 36, 225);
}

function signboard(def: BuildingDef, height: number): { sprite: THREE.Sprite; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  drawSign(canvas, def, { label: 'Not checked yet', color: '#8aa0c8' });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(7.6, 3.8, 1);
  sprite.position.set(0, height, 0);
  sprite.renderOrder = 10;
  return { sprite, canvas };
}

function gearEmblem(): THREE.Group {
  const g = new THREE.Group();
  const gold = mat(PALETTE.gold, { metal: 0.6, rough: 0.35 });
  g.add(mesh(new THREE.TorusGeometry(0.55, 0.16, 6, 16), gold));
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    const tooth = mesh(new THREE.BoxGeometry(0.22, 0.3, 0.18), gold, Math.cos(t) * 0.78, Math.sin(t) * 0.78, 0);
    tooth.rotation.z = t;
    g.add(tooth);
  }
  g.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.2, 10).rotateX(Math.PI / 2), gold));
  return g;
}

function cubeEmblem(): THREE.Group {
  // A neutral "3D asset" emblem (an isometric cube), not any product's logo.
  const g = new THREE.Group();
  const c = mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(PALETTE.gold, { metal: 0.55, rough: 0.35 }));
  c.rotation.set(Math.PI / 5, Math.PI / 4, 0);
  g.add(c);
  g.add(mesh(new THREE.TorusGeometry(0.85, 0.06, 6, 24), mat(PALETTE.gold, { metal: 0.55, rough: 0.35 })));
  return g;
}

export function buildBuilding(def: BuildingDef): BuildingHandle {
  const group = new THREE.Group();
  group.position.set(def.x, def.y, def.z);
  group.rotation.y = def.rotY;
  group.userData.buildingId = def.id;
  const windowMat = windowMaterial();
  const accentMats: THREE.MeshStandardMaterial[] = [];
  group.add(plinth(def.w, def.d));
  const top = 0.95;
  const body = new THREE.Group();
  body.position.y = top;
  group.add(body);
  let signY = 9.5;
  let chimney: THREE.Vector3 | null = null;

  if (def.id === 'town-hall') {
    const hall = house({ w: 7, d: 4.6, h: 3.6, roof: PALETTE.roofBlue, roofH: 2.6, windowsFront: 4 }, windowMat);
    body.add(hall);
    chimney = hall.userData.chimneyTop ?? null;
    for (const x of [-4.1, 4.1]) {
      const t = tower(1.0, 5.2, PALETTE.roofNavy, windowMat);
      t.position.set(x, 0.2, 0.6);
      body.add(t);
    }
    const front = tower(0.95, 6.6, PALETTE.roofBlue, windowMat);
    front.position.set(0, 0.2, 2.2);
    body.add(front);
    const clock = mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.1, 20).rotateX(Math.PI / 2), mat(0xf3e2b5, { emissive: 0xffd28a, emissiveIntensity: 0.25 }), 0, 5.2, 3.18, false);
    body.add(clock);
    body.add(mesh(new THREE.TorusGeometry(0.64, 0.07, 6, 24), mat(PALETTE.gold, { metal: 0.5, rough: 0.4 }), 0, 5.2, 3.2, false));
    const hand1 = mesh(new THREE.BoxGeometry(0.05, 0.42, 0.03), mat(0x2a2320), 0, 5.35, 3.25, false);
    const hand2 = mesh(new THREE.BoxGeometry(0.32, 0.05, 0.03), mat(0x2a2320), 0.12, 5.2, 3.25, false);
    body.add(hand1, hand2);
    group.userData.clockHands = [hand1, hand2];
    // flag
    body.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6), mat(PALETTE.timberDark), 0, 10.2, 2.2));
    const flag = mesh(new THREE.BoxGeometry(0.9, 0.5, 0.03), mat(PALETTE.roofBlue), 0.45, 10.7, 2.2);
    body.add(flag);
    group.userData.flag = flag;
    for (const x of [-1.6, 1.6]) {
      body.add(mesh(new THREE.BoxGeometry(0.75, 2.2, 0.05), mat(PALETTE.roofBlue), x, 2.4, 2.36, false));
      body.add(mesh(new THREE.BoxGeometry(0.3, 0.3, 0.06), mat(PALETTE.gold, { metal: 0.5 }), x, 2.6, 2.4, false));
    }
    signY = 12.6;
  } else if (def.id === 'library') {
    const h = house({ w: 6.2, d: 4.8, h: 3.4, roof: PALETTE.roofOrange, roofH: 2.8, windowsFront: 4 }, windowMat);
    body.add(h);
    chimney = h.userData.chimneyTop ?? null;
    const t = tower(0.8, 5.4, PALETTE.roofOrange, windowMat);
    t.position.set(-3.3, 0.2, 1.4);
    body.add(t);
    const glow = mat(PALETTE.crystal, { emissive: PALETTE.crystal, emissiveIntensity: 0 });
    accentMats.push(glow as THREE.MeshStandardMaterial);
    body.add(mesh(new THREE.OctahedronGeometry(0.28), glow, 1.6, 6.2, 0.8, false));
    signY = 10.2;
  } else if (def.id === 'unreal-workshop') {
    const h = house({ w: 6.2, d: 4.8, h: 3.4, roof: PALETTE.roofPurple, roofH: 2.8, windowsFront: 4 }, windowMat);
    body.add(h);
    chimney = h.userData.chimneyTop ?? null;
    const crystal = mat(PALETTE.crystal, { emissive: PALETTE.crystal, emissiveIntensity: 0 });
    accentMats.push(crystal as THREE.MeshStandardMaterial);
    for (const x of [-3.5, 3.5]) {
      body.add(mesh(new THREE.BoxGeometry(0.7, 4.6, 0.7), mat(PALETTE.stone), x, 2.3, 1.9));
      const c = mesh(new THREE.OctahedronGeometry(0.45), crystal, x, 5.2, 1.9, false);
      c.scale.y = 1.8;
      body.add(c);
    }
    const rose = mesh(new THREE.TorusGeometry(0.55, 0.1, 6, 20), crystal, 0, 4.4, 2.5, false);
    body.add(rose);
    signY = 10.2;
  } else if (def.id === 'engineering-forge') {
    const h = house({ w: 6.0, d: 4.8, h: 3.2, roof: PALETTE.roofBlue, roofH: 2.5, windowsFront: 4 }, windowMat);
    body.add(h);
    chimney = h.userData.chimneyTop ?? null;
    body.add(mesh(new THREE.BoxGeometry(0.7, 2.2, 0.7), mat(PALETTE.stoneDark), -2.3, 5.4, -0.8));
    const gear = gearEmblem();
    gear.position.set(0, 4.65, 2.75);
    body.add(gear);
    group.userData.gear = gear;
    const fire = mat(0xff7b2e, { emissive: 0xff6a1a, emissiveIntensity: 0 });
    accentMats.push(fire as THREE.MeshStandardMaterial);
    body.add(mesh(new THREE.BoxGeometry(1.2, 0.8, 0.1), fire, 1.9, 1.0, 2.46, false));
    signY = 9.8;
  } else if (def.id === 'blender-house') {
    const h = house({ w: 6.2, d: 4.8, h: 3.4, roof: PALETTE.roofNavy, roofH: 2.7, windowsFront: 4 }, windowMat);
    body.add(h);
    chimney = h.userData.chimneyTop ?? null;
    const annex = house({ w: 2.4, d: 3.2, h: 2.4, roof: PALETTE.roofBlue, roofH: 1.6, windowsFront: 1, chimney: false }, windowMat);
    annex.position.set(4.0, 0, -0.6);
    body.add(annex);
    const em = cubeEmblem();
    em.position.set(0, 4.55, 2.75);
    body.add(em);
    signY = 9.8;
  } else if (def.id === 'unreal-studio') {
    const h = house({ w: 6.6, d: 4.6, h: 3.2, roof: 0x34302e, roofH: 2.5, windowsFront: 4 }, windowMat);
    body.add(h);
    chimney = h.userData.chimneyTop ?? null;
    const em = cubeEmblem();
    em.position.set(0, 4.4, 2.6);
    body.add(em);
    signY = 9.6;
  } else if (def.id === 'post-office') {
    const h = house({ w: 4.6, d: 3.8, h: 2.8, roof: PALETTE.roofGreen, roofH: 2.0, windowsFront: 3 }, windowMat);
    body.add(h);
    chimney = h.userData.chimneyTop ?? null;
    body.add(mesh(new THREE.BoxGeometry(0.5, 0.7, 0.4), mat(0xb33b2e), 1.7, 0.75, 2.3)); // mailbox
    signY = 8.2;
  }

  let marker: THREE.Group | null = null;
  if (!PROCEDURAL_BODIES.has(def.id)) {
    marker = slotMarker(def);
    group.add(marker);
    signY = Math.max(6, def.indicatorHeight - 5) + 3.2;
  }

  // front steps (ambient). The lamp posts are placed by the scene's lamp set (see plinthLampSpots).
  const st = steps(2.4, 3);
  st.position.set(0, 0.05, def.d / 2 + 1.2);
  st.rotation.y = Math.PI;
  group.add(st);
  // The window light belongs to the building group, not the placeholder body (which is hidden once the custom
  // model loads). It is only visible, and only costs anything, while it is actually on.
  const light = new THREE.PointLight(0xffb866, 0, 12, 1.6);
  light.position.set(0, top + 3.2, 2.8);
  light.visible = false;
  group.add(light);
  const { sprite, canvas } = signboard(def, signY);
  group.add(sprite);
  // chimney smoke puffs: hidden unless a real run is active in this building
  const smoke: THREE.Sprite[] = [];
  if (chimney) {
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xd9d2c8, transparent: true, opacity: 0, depthWrite: false }));
      s.position.copy(chimney).add(new THREE.Vector3(0, top, 0));
      s.scale.setScalar(0.6);
      s.userData.phase = i / 4;
      s.visible = false; // drawn only while a real run is active
      group.add(s);
      smoke.push(s);
    }
  }
  return { def, group, windowMat, accentMats, light, sign: sprite, signCanvas: canvas, chimney, doorLocal: new THREE.Vector3(0, 0.95, def.d / 2 + 0.6), smoke, body, model: null, marker };
}

/**
 * Swap the procedural body for a loaded custom model. The plinth, steps, sign, light and smoke stay,
 * so status indicators keep working. The model stands on the plinth top, front (+Z) toward the plaza.
 */
export function attachBuildingModel(b: BuildingHandle, model: THREE.Group) {
  const top = 0.95;
  model.position.set(0, top, -0.3);
  model.userData.buildingId = b.def.id;
  b.group.add(model);
  b.body.visible = false;
  b.model = model;
  if (b.marker) b.marker.visible = false; // the real model has arrived
  const size = model.userData.fittedSize as THREE.Vector3;
  b.sign.position.y = top + size.y + 2.4;
  // Smoke rises from near the top of the roof line; it only shows while a real run is active.
  const chimney = new THREE.Vector3(size.x * 0.22, top + size.y * 0.92, -size.z * 0.15);
  b.chimney = chimney.clone().sub(new THREE.Vector3(0, top, 0));
  for (const s of b.smoke) s.position.copy(chimney);
  b.light.position.set(0, top + size.y * 0.45, size.z / 2 + 1.2);
}
