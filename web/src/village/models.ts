// Custom GLB models for buildings and residents, described by web/assets/models/manifest.json.
// Each file is fetched once and cloned per use (geometry and textures are shared; materials are cloned
// so each resident can show its own real status). Any failure leaves the procedural placeholder in place.
import { GLTFLoader } from '../../vendor/GLTFLoader.js';
import * as THREE from '../../vendor/three.module.js';

export type ModelEntry = { file: string; source?: string; width?: number; height?: number; rotateY?: number };
export type ModelManifest = { version: number; buildings: Record<string, ModelEntry>; characters: Record<string, ModelEntry> };

export type ModelStatus = { total: number; loaded: number; failed: { key: string; file: string; error: string }[] };

const BASE = '/assets/models/';
const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

export const modelStatus: ModelStatus = { total: 0, loaded: 0, failed: [] };
const statusListeners = new Set<(s: ModelStatus) => void>();
export function onModelStatus(l: (s: ModelStatus) => void) {
  statusListeners.add(l);
  l(modelStatus);
}
function emitStatus() {
  for (const l of statusListeners) l(modelStatus);
}

let manifestPromise: Promise<ModelManifest | null> | null = null;
export function loadManifest(): Promise<ModelManifest | null> {
  manifestPromise ??= fetch(`${BASE}manifest.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return manifestPromise;
}

function fetchModel(file: string): Promise<THREE.Group> {
  let p = cache.get(file);
  if (!p) {
    p = loader.loadAsync(BASE + file).then((gltf: any) => {
      const root = gltf.scene as THREE.Group;
      root.traverse((o: any) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return root;
    });
    cache.set(file, p);
  }
  return p;
}

/**
 * Load a model and return a clone scaled to the requested width (buildings) or height (characters),
 * standing on y = 0 and centred on x/z. Materials are cloned per instance; textures stay shared.
 */
export async function instantiate(key: string, entry: ModelEntry): Promise<THREE.Group> {
  modelStatus.total += 1;
  emitStatus();
  try {
    const source = await fetchModel(entry.file);
    const inst = source.clone(true);
    inst.traverse((o: any) => {
      if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m: THREE.Material) => m.clone()) : o.material.clone();
    });
    const box = new THREE.Box3().setFromObject(inst);
    const size = box.getSize(new THREE.Vector3());
    const scale = entry.height ? entry.height / Math.max(size.y, 1e-6) : (entry.width ?? 1) / Math.max(size.x, 1e-6);
    const wrapper = new THREE.Group();
    inst.position.set(-(box.min.x + size.x / 2), -box.min.y, -(box.min.z + size.z / 2));
    wrapper.add(inst);
    wrapper.scale.setScalar(scale);
    if (entry.rotateY) wrapper.rotation.y = entry.rotateY;
    wrapper.userData.modelKey = key;
    wrapper.userData.fittedSize = size.clone().multiplyScalar(scale);
    modelStatus.loaded += 1;
    emitStatus();
    return wrapper;
  } catch (e) {
    modelStatus.failed.push({ key, file: entry.file, error: (e as Error)?.message ?? String(e) });
    emitStatus();
    console.warn(`[Virelune] Model "${key}" (${entry.file}) failed to load; keeping the placeholder.`, e);
    throw e;
  }
}

/** Every standard material in a model instance, for status tinting. */
export function modelMaterials(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && 'color' in m) out.push(m);
  });
  return out;
}
