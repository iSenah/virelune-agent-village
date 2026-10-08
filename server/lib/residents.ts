// Resident status is derived only from real doctor results and verification records, never assumed.
import type { IntegrationResult } from '../../integrations/types.ts';
import type { Registries, Resident } from './registry.ts';

export type ResidentStatus = 'untested' | 'disconnected' | 'connected';

export type ResidentView = {
  id: string;
  displayName: string;
  role: string;
  building: string;
  appearance: Resident['appearance'];
  capabilities: string[];
  focus: boolean;
  status: ResidentStatus;
  reasons: string[];
  parts: { integration: string; name: string; status: string; ready: boolean; summary: string }[];
  runtime: string;
  provider: string;
  model: string | null;
  tools: string[];
};

export function residentStatus(r: Resident, reg: Registries, results: Map<string, IntegrationResult> | null): Pick<ResidentView, 'status' | 'reasons' | 'parts'> {
  if (!results) return { status: 'untested', reasons: ['No integration check has run on this machine yet. Run the doctor.'], parts: [] };
  const needed = new Set(r.requires);
  const rt = reg.runtimes.get(r.runtime);
  const pv = reg.providers.get(r.provider);
  if (rt) needed.add(rt.integration);
  if (pv) needed.add(pv.integration);
  for (const g of r.tools) for (const i of reg.tools.get(g.server)?.requires ?? []) needed.add(i);
  const parts: ResidentView['parts'] = [];
  const reasons: string[] = [];
  for (const id of needed) {
    const res = results.get(id);
    if (!res) {
      parts.push({ integration: id, name: id, status: 'untested', ready: false, summary: 'No check exists for this integration yet.' });
      reasons.push(`${id}: no check available yet`);
      continue;
    }
    parts.push({ integration: id, name: res.name, status: res.status, ready: res.ready, summary: res.summary });
    if (!res.ready) reasons.push(`${res.name}: ${res.summary}`);
  }
  if (!r.focus) reasons.unshift('Awaiting its individual verification test. Registered, but kept disconnected until verified.');
  // Runtime adapters are not enabled in this milestone, so even a fully ready resident cannot take work yet.
  const allReady = reasons.length === 0;
  if (allReady) return { status: 'connected', reasons: [], parts };
  return { status: 'disconnected', reasons, parts };
}

export function residentViews(reg: Registries, results: Map<string, IntegrationResult> | null): ResidentView[] {
  return [...reg.residents.values()].map((r) => ({
    id: r.id,
    displayName: r.displayName,
    role: r.role,
    building: r.building,
    appearance: r.appearance,
    capabilities: r.capabilities,
    focus: r.focus,
    runtime: r.runtime,
    provider: r.provider,
    model: r.model,
    tools: r.tools.map((t) => t.server),
    ...residentStatus(r, reg, results),
  }));
}
