// Village lamp posts: ambient decoration that glows regardless of agent activity.
// All posts share ONE instanced mesh of the custom street-lamp model (one draw call). Until the model loads,
// or if it fails, procedural lanterns stand in. Each post can be selected and rotated; rotations are saved to
// the shared village layout (config/layout/village.json) by the caller.
import * as THREE from '../../vendor/three.module.js';
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
    for (const l of this.fallback.values()) this.group.remove(l);
    this.fallback.clear();
    for (const id of this.spots.keys()) this.place(id);
    im.computeBoundingSphere();
    this.onDirty();
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
    if (this.instanced) {
      const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)).multiply(this.fit);
      this.instanced.setMatrixAt(this.index.get(id)!, m);
      this.instanced.instanceMatrix.needsUpdate = true;
    }
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
