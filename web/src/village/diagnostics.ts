// Graphics diagnostics: what the village costs to draw, by part of the village. Read-only; changes nothing.
import * as THREE from '../../vendor/three.module.js';

export type PartCost = { part: string; draws: number; triangles: number; objects: number };

/** Draw calls and triangles per top-level part of the scene (only visible objects count). */
export function sceneBreakdown(scene: THREE.Scene): PartCost[] {
  const parts = new Map<string, PartCost>();
  for (const top of scene.children) {
    if (!top.visible) continue;
    const name = (top.name || top.type).split(':')[0];
    const cost = parts.get(name) ?? { part: name, draws: 0, triangles: 0, objects: 0 };
    top.traverseVisible((o: any) => {
      if (!(o.isMesh || o.isPoints || o.isSprite || o.isLine)) return;
      if (o.material && (Array.isArray(o.material) ? o.material.every((m: any) => !m.visible) : !o.material.visible)) return;
      cost.objects += 1;
      cost.draws += Array.isArray(o.material) ? o.material.length : 1;
      if (o.isSprite) cost.triangles += 2;
      else if (o.isMesh) {
        const g = o.geometry as THREE.BufferGeometry;
        const per = (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
        cost.triangles += per * (o.isInstancedMesh ? o.count : 1);
      }
    });
    parts.set(name, cost);
  }
  return [...parts.values()].filter((p) => p.draws).sort((a, b) => b.triangles - a.triangles);
}

/** Lights that actually cost shader time (visible ones; three.js skips invisible lights). */
export function activeLights(scene: THREE.Scene): { point: number; directional: number; shadowCasting: number } {
  const out = { point: 0, directional: 0, shadowCasting: 0 };
  scene.traverseVisible((o: any) => {
    if (o.isPointLight) out.point++;
    if (o.isDirectionalLight) out.directional++;
    if (o.isLight && o.castShadow) out.shadowCasting++;
  });
  return out;
}

export function gpuName(renderer: THREE.WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return 'unknown';
  }
}
