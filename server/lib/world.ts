// The village layout (config/layout/world.json), loaded and checked by Village Hall. The browser renders from
// the same data (GET /api/world). Resident homes and workplaces must be places in the layout.
import fs from 'node:fs';
import path from 'node:path';
import { allNodes, entrance, groundY, indicatorAnchor, validateWorld, walkGraph, type World } from '../../web/src/village/worldModel.ts';
import type { Registries } from './registry.ts';

export type LoadedWorld = { world: World | null; errors: string[]; file: string };

export function loadWorld(configDir: string, reg: Registries): LoadedWorld {
  const file = path.join(configDir, 'layout', 'world.json');
  let world: World;
  try {
    world = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { world: null, errors: [`cannot read the village layout: ${(e as Error).message}`], file };
  }
  if (world?.version !== 1 || !Array.isArray(world.buildings) || !Array.isArray(world.districts)) return { world: null, errors: ['the village layout is not a version 1 layout'], file };
  for (const k of ['nodes', 'crossings', 'roads', 'plateaus'] as const) (world as any)[k] ??= k === 'nodes' ? {} : [];
  const homes = [...reg.residents.values()].map((r) => r.building);
  const workplaces = [...(reg.profiles?.values() ?? [])].map((p) => p.workplace);
  return { world, errors: validateWorld(world, [...new Set([...homes, ...workplaces])]), file };
}

/**
 * The layout plus what the browser and future V3 behaviour need: each building's entrance and indicator anchor,
 * who lives or works there, and each resident's home and workplaces (from the registries, not invented).
 */
export function worldView(w: World, reg: Registries) {
  const residents = [...reg.residents.values()];
  return {
    ...w,
    buildings: w.buildings.map((b) => ({
      ...b,
      y: groundY(w, b),
      entrance: entrance(w, b),
      indicatorAnchor: indicatorAnchor(w, b),
      residents: residents.filter((r) => r.building === b.id).map((r) => r.id),
      workers: [...(reg.profiles?.values() ?? [])].filter((p) => p.workplace === b.id).map((p) => ({ profile: p.id, resident: p.resident })),
    })),
    homes: Object.fromEntries(residents.map((r) => [r.id, { home: r.building, workplaces: r.workplaces ?? [], planned: r.planned }])),
    walkNodes: Object.fromEntries(allNodes(w)),
    walkEdges: [...walkGraph(w).entries()].flatMap(([from, es]) => es.filter((e) => from < e.to).map((e) => ({ from, to: e.to, kind: e.road.kind, length: Math.round(e.length * 10) / 10 }))),
  };
}
