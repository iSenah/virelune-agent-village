// Village lamp posts: ambient decoration that glows regardless of agent activity.
// Posts near the camera share ONE instanced mesh of the custom street-lamp model (one draw call); distant posts
// share a second instanced mesh of a very light stand-in (about 100 triangles instead of 12k) that looks the
// same from far away. Until the model loads, or if it fails, procedural lanterns stand in. Each post can be selected and rotated; rotations are saved to
// the shared village layout (config/layout/village.json) by the caller.
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { glowSprite, lantern, PALETTE } from './kit.ts';

export type LampSpot = {
  /** Stable id, used as the key in the saved layout (e.g. "road:library:left"). */
  id: string;
  /** Human label shown when the lamp is selected. */
  label: string;
  x: number;
  y: number;
  z: number;
  /** Default rotation in radians, chosen so the lantern hangs over the path. */
  rotY: number;
};

/** Default rotation so the hanging lantern (on the model's -X side) points along (dx, dz). */
export function lanternToward(dx: number, dz: number): number {
  return Math.atan2(dz, -dx);
}

// Where the hanging lantern sits on the custom model, in its own units (measured from the model:
// 0.97 units tall, lantern 0.25 to the -X side of the post at 58% height).
const MODEL_LANTERN = new THREE.Vector3(-0.25, 0.567, 0);
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

export class LampSet {
  readonly group = new THREE.Group();
  readonly proxies: THREE.Mesh[] = [];
  /** Called whenever something moved and the cached shadow map should be refreshed. */
  onDirty: () => void = () => {};
  private spots = new Map<string, LampSpot>();
  private overrides = new Map<string, number>(); // id -> degrees
  private fallback = new Map<string, THREE.Group>();
  private glows = new Map<string, THREE.Sprite>();
  private proxyById = new Map<string, THREE.Mesh>();
  private index = new Map<string, number>();
  private instanced: THREE.InstancedMesh | null = null;
  /** Light stand-in for distant posts (same footprint, height and lantern position as the model). */
  private far: THREE.InstancedMesh | null = null;
  private near = new Set<string>();
  private detailDistance = 70;
  private lastEye = new THREE.Vector3(Infinity, 0, 0);
  private fit = new THREE.Matrix4();
  private lanternLocal = new THREE.Vector3(0, 2.1, 0); // procedural lantern until the model loads
  private ring: THREE.Mesh;
  private selectedId: string | null = null;

  constructor(spots: LampSpot[]) {
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    spots.forEach((s, i) => {
      this.spots.set(s.id, s);
      this.index.set(s.id, i);
      const l = lantern();
      // lantern() brings its own halo; the lamp set manages glows itself so they follow the model's lantern.
      l.remove(l.userData.ambientGlow);
      this.group.add(l);
      this.fallback.set(s.id, l);
      const g = glowSprite(1.7);
      this.group.add(g);
      this.glows.set(s.id, g);
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.5, 1.1), proxyMat);
      proxy.userData.lampId = s.id;
      this.group.add(proxy);
      this.proxies.push(proxy);
      this.proxyById.set(s.id, proxy);
    });
    const ringMat = new THREE.MeshBasicMaterial({ color: PALETTE.gold, transparent: true, opacity: 0.9, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.07, 6, 40).rotateX(Math.PI / 2), ringMat);
    // a small notch on the ring shows which way the lantern faces
    const notch = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 4).rotateZ(Math.PI / 2), ringMat);
    notch.position.set(-1.45, 0, 0);
    this.ring.add(notch);
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.group.add(this.ring);
    for (const s of spots) this.place(s.id);
  }

  ids(): string[] {
    return [...this.spots.keys()];
  }

  label(id: string): string {
    return this.spots.get(id)?.label ?? id;
  }

  /** Current rotation of a lamp in degrees (saved value, or the village default). */
  rotation(id: string): number {
    const o = this.overrides.get(id);
    if (o !== undefined) return o;
    const s = this.spots.get(id);
    return s ? Math.round(((deg(s.rotY) % 360) + 360) % 360) : 0;
  }

  isCustom(id: string): boolean {
    return this.overrides.has(id);
  }

  /** Apply rotations from the saved layout. Unknown ids are ignored. */
  setOverrides(lamps: Record<string, { rotation: number }>) {
    this.overrides.clear();
    for (const [id, v] of Object.entries(lamps)) if (this.spots.has(id) && Number.isFinite(v?.rotation)) this.overrides.set(id, v.rotation);
    for (const id of this.spots.keys()) this.place(id);
    this.onDirty();
  }

  /** Swap the procedural lanterns for the custom model (one instanced mesh). */
  attachModel(source: THREE.Object3D, height: number) {
    source.updateMatrixWorld(true);
    let found: THREE.Mesh | null = null;
    source.traverse((o: any) => {
      if (!found && o.isMesh) found = o;
    });
    if (!found) throw new Error('street lamp model has no mesh');
    const src = found as THREE.Mesh;
    const geo = src.geometry.clone().applyMatrix4(src.matrixWorld);
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const scale = height / Math.max(size.y, 1e-6);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    this.fit.makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-cx, -box.min.y, -cz));
    this.lanternLocal.copy(MODEL_LANTERN).multiplyScalar(scale * (size.y / 0.97));
    const material = (Array.isArray(src.material) ? src.material[0] : src.material).clone();
    const im = new THREE.InstancedMesh(geo, material, this.spots.size);
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData.isLamps = true;
    this.instanced = im;
    this.group.add(im);
    const far = new THREE.InstancedMesh(farLampGeometry(height, this.lanternLocal), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 }), this.spots.size);
    far.castShadow = true;
    far.receiveShadow = true;
    far.name = 'lamps-far';
    this.far = far;
    this.group.add(far);
    // every post starts with the light stand-in; updateDetail() promotes the ones near the camera
    this.near.clear();
    this.lastEye.set(Infinity, 0, 0);
    for (const l of this.fallback.values()) this.group.remove(l);
    this.fallback.clear();
    for (const id of this.spots.keys()) this.place(id);
    this.writeInstances();
    this.onDirty();
  }

  /** Posts closer than this (metres) use the full model. */
  setDetailDistance(d: number) {
    this.detailDistance = d;
    this.lastEye.set(Infinity, 0, 0);
  }

  /** Choose full model or light stand-in per post from the camera position. Cheap; call every frame. */
  updateDetail(eye: THREE.Vector3) {
    if (!this.instanced || eye.distanceToSquared(this.lastEye) < 1) return;
    this.lastEye.copy(eye);
    const next = new Set<string>();
    const d2 = this.detailDistance * this.detailDistance;
    for (const s of this.spots.values()) if ((s.x - eye.x) ** 2 + (s.y - eye.y) ** 2 + (s.z - eye.z) ** 2 < d2) next.add(s.id);
    if (next.size === this.near.size && [...next].every((id) => this.near.has(id))) return;
    this.near = next;
    this.writeInstances();
    this.onDirty();
  }

  private matrix(id: string): THREE.Matrix4 {
    const s = this.spots.get(id)!;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad(this.rotation(id)));
    return new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(1, 1, 1));
  }

  private writeInstances() {
    if (!this.instanced || !this.far) return;
    let n = 0;
    let f = 0;
    for (const id of this.spots.keys()) {
      const m = this.matrix(id);
      if (this.near.has(id)) this.instanced.setMatrixAt(n++, m.multiply(this.fit));
      else this.far.setMatrixAt(f++, m);
    }
    this.instanced.count = n;
    this.far.count = f;
    this.instanced.visible = n > 0;
    this.far.visible = f > 0;
    this.instanced.instanceMatrix.needsUpdate = true;
    this.far.instanceMatrix.needsUpdate = true;
    this.instanced.computeBoundingSphere();
    this.far.computeBoundingSphere();
  }

  select(id: string | null) {
    this.selectedId = id && this.spots.has(id) ? id : null;
    this.ring.visible = !!this.selectedId;
    if (this.selectedId) this.place(this.selectedId);
  }

  selected(): string | null {
    return this.selectedId;
  }

  /** Rotate a lamp by a number of degrees; returns the new rotation in degrees. */
  rotateBy(id: string, deltaDeg: number): number {
    const next = Math.round((((this.rotation(id) + deltaDeg) % 360) + 360) % 360 * 10) / 10;
    this.overrides.set(id, next);
    this.place(id);
    this.onDirty();
    return next;
  }

  /** Back to the village default. */
  reset(id: string) {
    this.overrides.delete(id);
    this.place(id);
    this.onDirty();
  }

  private place(id: string) {
    const s = this.spots.get(id)!;
    const r = rad(this.rotation(id));
    const pos = new THREE.Vector3(s.x, s.y, s.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r);
    const fb = this.fallback.get(id);
    if (fb) {
      fb.position.copy(pos);
      fb.quaternion.copy(q);
    }
    if (this.instanced) this.writeInstances();
    this.glows.get(id)!.position.copy(this.lanternLocal.clone().applyQuaternion(q).add(pos));
    const proxy = this.proxyById.get(id)!;
    proxy.position.copy(pos).add(new THREE.Vector3(0, 1.75, 0));
    proxy.quaternion.copy(q);
    if (this.selectedId === id) {
      this.ring.position.copy(pos).add(new THREE.Vector3(0, 0.08, 0));
      this.ring.quaternion.copy(q);
    }
  }
}

/** A very light lamp post for distant views: base, post, arm and lantern, coloured like the model. */
function farLampGeometry(height: number, lanternAt: THREE.Vector3): THREE.BufferGeometry {
  const parts: [THREE.BufferGeometry, number][] = [
    [new THREE.BoxGeometry(0.42, 0.36, 0.42).translate(0, 0.18, 0), 0x6e675e],
    [new THREE.CylinderGeometry(0.07, 0.09, height * 0.92, 6).translate(0, height * 0.46, 0), 0x3b322b],
    [new THREE.BoxGeometry(Math.abs(lanternAt.x) + 0.15, 0.07, 0.07).translate(lanternAt.x / 2, lanternAt.y + 0.32, 0), 0x3b322b],
    [new THREE.BoxGeometry(0.3, 0.42, 0.3).translate(lanternAt.x, lanternAt.y, lanternAt.z), 0xffc46e],
    [new THREE.ConeGeometry(0.24, 0.2, 4).rotateY(Math.PI / 4).translate(lanternAt.x, lanternAt.y + 0.31, lanternAt.z), 0x3b322b],
  ];
  const geos = parts.map(([g, color]) => {
    const ng = g.index ? g.toNonIndexed() : g;
    const c = new THREE.Color(color);
    const cols = new Float32Array(ng.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) cols.set([c.r, c.g, c.b], i);
    ng.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    ng.deleteAttribute('uv');
    return ng;
  });
  return mergeGeometries(geos);
}
