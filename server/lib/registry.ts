// Agent Registry and Tool Registry: residents, runtimes, providers, tool servers and playbooks are data.
// Manifests are JSON files under config/. They are validated on load; invalid manifests are reported, not loaded.
import fs from 'node:fs';
import path from 'node:path';

export type RiskClass = 'read' | 'write' | 'exec';
export const RISK_CLASSES: RiskClass[] = ['read', 'write', 'exec'];

export type ToolGrant = { server: string; allow: string[]; ask: string[] };

export type Resident = {
  id: string;
  displayName: string;
  role: string;
  capabilities: string[];
  runtime: string;
  provider: string;
  model: string | null;
  building: string;
  /** figure: false keeps the resident registered but without a figure standing in the village. */
  appearance: { lineage: string; color: string; figure: boolean };
  tools: ToolGrant[];
  requires: string[];
  focus: boolean;
  verification: { required: boolean };
  permissions: string;
  budget: { perTaskUsd: number; dailyUsd: number; maxTurns: number };
  /** Planned resident: home reserved, no runtime or provider yet; never connected, never receives messages. */
  planned: boolean;
  /** Set on execution profiles: the one real resident this profile belongs to. */
  parent?: string;
  /** Shared workplaces this resident works at (from its profiles), e.g. blender-house. */
  workplaces: string[];
};

/**
 * An execution profile: a specialist way for an existing resident to work (e.g. Claude in Blender) with its own
 * runtime, tools and verification. Not a separate resident: no figure, no own chat, no own paid-use switch.
 */
export type Profile = {
  id: string;
  resident: string;
  displayName: string;
  role: string;
  workplace: string;
  capabilities: string[];
  runtime: string;
  provider: string;
  model: string | null;
  tools: ToolGrant[];
  requires: string[];
  verification: { required: boolean };
  permissions: string;
  budget: { perTaskUsd: number; dailyUsd: number; maxTurns: number };
};

export type Runtime = { id: string; displayName: string; kind: string; integration: string };
export type Provider = { id: string; displayName: string; integration: string; billing: string; notes: string };
export type ToolServer = {
  id: string;
  displayName: string;
  kind: 'mcp';
  transport: 'stdio';
  command: string | null;
  commandEnv: string | null;
  args: string[];
  requires: string[];
  exclusive: boolean;
  leaseSeconds: number;
  risk: Record<string, RiskClass>;
};
export type Playbook = { id: string; displayName: string; steps: { id: string; needs: string[]; after: string[]; output: string | null }[] };

export type Registries = {
  residents: Map<string, Resident>;
  profiles: Map<string, Profile>;
  /** Everything that can hold a Tool Gateway session: residents and their execution profiles. */
  principals: Map<string, Resident>;
  runtimes: Map<string, Runtime>;
  providers: Map<string, Provider>;
  tools: Map<string, ToolServer>;
  playbooks: Map<string, Playbook>;
  errors: { file: string; message: string }[];
};

const ID = /^[a-z][a-z0-9-]{1,40}$/;

class V {
  errors: string[] = [];
  private obj: any;
  constructor(obj: any) {
    this.obj = obj;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) this.errors.push('manifest must be a JSON object');
  }
  str(key: string, opts: { optional?: boolean; pattern?: RegExp } = {}): string | null {
    const v = this.obj?.[key];
    if (v === undefined || v === null) {
      if (!opts.optional) this.errors.push(`${key} is required`);
      return null;
    }
    if (typeof v !== 'string' || v.length === 0) {
      this.errors.push(`${key} must be a non-empty string`);
      return null;
    }
    if (opts.pattern && !opts.pattern.test(v)) this.errors.push(`${key} has an invalid format`);
    return v;
  }
  strArr(key: string, optional = true): string[] {
    const v = this.obj?.[key];
    if (v === undefined) {
      if (!optional) this.errors.push(`${key} is required`);
      return [];
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.errors.push(`${key} must be an array of strings`);
      return [];
    }
    return v;
  }
  bool(key: string, dflt: boolean): boolean {
    const v = this.obj?.[key];
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') this.errors.push(`${key} must be true or false`);
    return Boolean(v);
  }
  num(key: string, dflt: number, min = 0): number {
    const v = this.obj?.[key];
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) this.errors.push(`${key} must be a number >= ${min}`);
    return Number(v);
  }
  sub(key: string): V {
    const v = new V(this.obj?.[key] ?? {});
    return v;
  }
  raw(key: string): any {
    return this.obj?.[key];
  }
  noExtra(allowed: string[]) {
    if (!this.obj || typeof this.obj !== 'object') return;
    for (const k of Object.keys(this.obj)) if (!allowed.includes(k)) this.errors.push(`unknown field "${k}"`);
  }
}

function parseGrant(g: any, errors: string[]): ToolGrant | null {
  if (!g || typeof g !== 'object') {
    errors.push('each tools[] entry must be an object');
    return null;
  }
  const allow = Array.isArray(g.allow) ? g.allow : [];
  const ask = Array.isArray(g.ask) ? g.ask : [];
  for (const sel of [...allow, ...ask]) {
    if (typeof sel !== 'string') {
      errors.push('tool grant selectors must be strings');
      continue;
    }
    if (sel.startsWith('risk:')) {
      const cls = sel.slice(5);
      if (!RISK_CLASSES.includes(cls as RiskClass)) errors.push(`grant selector "${sel}" is not a known risk class`);
    } else if (sel === '*' || sel.includes('*')) {
      errors.push(`wildcard grant "${sel}" is not allowed; grant risk classes or named tools`);
    }
  }
  if (allow.includes('risk:exec')) errors.push('risk:exec may only be granted under "ask", never "allow"');
  if (typeof g.server !== 'string') {
    errors.push('tools[].server is required');
    return null;
  }
  return { server: g.server, allow, ask };
}

export function parseResident(obj: any): { value: Resident | null; errors: string[] } {
  const v = new V(obj);
  v.noExtra(['id', 'displayName', 'role', 'capabilities', 'runtime', 'provider', 'model', 'building', 'appearance', 'tools', 'requires', 'focus', 'verification', 'permissions', 'budget', 'planned', '$comment']);
  const id = v.str('id', { pattern: ID });
  const displayName = v.str('displayName');
  const role = v.str('role');
  const capabilities = v.strArr('capabilities', false);
  const planned = v.bool('planned', false);
  // Planned residents have no runtime or provider yet.
  const runtime = planned ? (v.str('runtime', { pattern: ID, optional: true }) ?? '') : v.str('runtime', { pattern: ID });
  const provider = planned ? (v.str('provider', { pattern: ID, optional: true }) ?? '') : v.str('provider', { pattern: ID });
  if (planned && obj?.focus === true) v.errors.push('a planned resident cannot be a focus resident');
  const model = v.str('model', { optional: true });
  const building = v.str('building', { pattern: ID });
  const ap = v.sub('appearance');
  const lineage = ap.str('lineage') ?? 'neutral';
  const color = ap.str('color', { pattern: /^#[0-9a-fA-F]{6}$/ }) ?? '#888888';
  const figure = ap.bool('figure', true);
  v.errors.push(...ap.errors.map((e) => `appearance.${e}`));
  const toolsRaw = v.raw('tools') ?? [];
  const tools: ToolGrant[] = [];
  if (!Array.isArray(toolsRaw)) v.errors.push('tools must be an array');
  else for (const g of toolsRaw) {
    const parsed = parseGrant(g, v.errors);
    if (parsed) tools.push(parsed);
  }
  const requires = v.strArr('requires', false);
  const focus = v.bool('focus', false);
  const ver = v.sub('verification');
  const verification = { required: ver.bool('required', true) };
  const permissions = v.str('permissions') ?? 'restricted';
  const b = v.sub('budget');
  const budget = { perTaskUsd: b.num('perTaskUsd', 1), dailyUsd: b.num('dailyUsd', 5), maxTurns: b.num('maxTurns', 30, 1) };
  v.errors.push(...b.errors.map((e) => `budget.${e}`));
  if (v.errors.length) return { value: null, errors: v.errors };
  return {
    value: { id: id!, displayName: displayName!, role: role!, capabilities, runtime: runtime!, provider: provider!, model, building: building!, appearance: { lineage, color, figure }, tools, requires, focus, verification, permissions, budget, planned, workplaces: [] },
    errors: [],
  };
}

export function parseProfile(obj: any): { value: Profile | null; errors: string[] } {
  const v = new V(obj);
  v.noExtra(['id', 'resident', 'displayName', 'role', 'workplace', 'capabilities', 'runtime', 'provider', 'model', 'tools', 'requires', 'verification', 'permissions', 'budget', '$comment']);
  const id = v.str('id', { pattern: ID });
  const resident = v.str('resident', { pattern: ID });
  const displayName = v.str('displayName');
  const role = v.str('role');
  const workplace = v.str('workplace', { pattern: ID });
  const capabilities = v.strArr('capabilities', false);
  const runtime = v.str('runtime', { pattern: ID });
  const provider = v.str('provider', { pattern: ID });
  const model = v.str('model', { optional: true });
  const toolsRaw = v.raw('tools') ?? [];
  const tools: ToolGrant[] = [];
  if (!Array.isArray(toolsRaw)) v.errors.push('tools must be an array');
  else for (const g of toolsRaw) {
    const parsed = parseGrant(g, v.errors);
    if (parsed) tools.push(parsed);
  }
  const requires = v.strArr('requires', false);
  const ver = v.sub('verification');
  const verification = { required: ver.bool('required', true) };
  const permissions = v.str('permissions') ?? 'restricted';
  const b = v.sub('budget');
  const budget = { perTaskUsd: b.num('perTaskUsd', 1), dailyUsd: b.num('dailyUsd', 5), maxTurns: b.num('maxTurns', 30, 1) };
  v.errors.push(...b.errors.map((e) => `budget.${e}`));
  if (v.errors.length) return { value: null, errors: v.errors };
  return { value: { id: id!, resident: resident!, displayName: displayName!, role: role!, workplace: workplace!, capabilities, runtime: runtime!, provider: provider!, model, tools, requires, verification, permissions, budget }, errors: [] };
}

/** A profile as a principal for the Tool Gateway and status checks (never a figure, never focus). */
export function profilePrincipal(p: Profile, parent: Resident): Resident {
  return { ...p, building: p.workplace, appearance: { ...parent.appearance, figure: false }, focus: false, planned: false, parent: parent.id, workplaces: [] };
}

export function parseRuntime(obj: any): { value: Runtime | null; errors: string[] } {
  const v = new V(obj);
  v.noExtra(['id', 'displayName', 'kind', 'integration', '$comment']);
  const r = { id: v.str('id', { pattern: ID })!, displayName: v.str('displayName')!, kind: v.str('kind')!, integration: v.str('integration', { pattern: ID })! };
  return v.errors.length ? { value: null, errors: v.errors } : { value: r, errors: [] };
}

export function parseProvider(obj: any): { value: Provider | null; errors: string[] } {
  const v = new V(obj);
  v.noExtra(['id', 'displayName', 'integration', 'billing', 'notes', '$comment']);
  const billing = v.str('billing');
  if (billing && !['paid-api', 'subscription', 'free-local', 'limited-free'].includes(billing)) v.errors.push('billing must be paid-api, subscription, free-local or limited-free');
  const r = { id: v.str('id', { pattern: ID })!, displayName: v.str('displayName')!, integration: v.str('integration', { pattern: ID })!, billing: billing!, notes: v.str('notes', { optional: true }) ?? '' };
  return v.errors.length ? { value: null, errors: v.errors } : { value: r, errors: [] };
}

export function parseToolServer(obj: any): { value: ToolServer | null; errors: string[] } {
  const v = new V(obj);
  v.noExtra(['id', 'displayName', 'kind', 'transport', 'command', 'commandEnv', 'args', 'requires', 'exclusive', 'leaseSeconds', 'risk', '$comment']);
  const kind = v.str('kind');
  if (kind && kind !== 'mcp') v.errors.push('kind must be "mcp"');
  const transport = v.str('transport');
  if (transport && transport !== 'stdio') v.errors.push('transport must be "stdio" (the gateway is the only network-facing MCP endpoint)');
  const riskRaw = v.raw('risk') ?? {};
  const risk: Record<string, RiskClass> = {};
  if (typeof riskRaw !== 'object' || Array.isArray(riskRaw)) v.errors.push('risk must be an object of toolName: read|write|exec');
  else for (const [tool, cls] of Object.entries(riskRaw)) {
    if (!RISK_CLASSES.includes(cls as RiskClass)) v.errors.push(`risk.${tool} must be read, write or exec`);
    else risk[tool] = cls as RiskClass;
  }
  const r: ToolServer = {
    id: v.str('id', { pattern: ID })!,
    displayName: v.str('displayName')!,
    kind: 'mcp',
    transport: 'stdio',
    command: v.str('command', { optional: true }),
    commandEnv: v.str('commandEnv', { optional: true, pattern: /^[A-Z][A-Z0-9_]*$/ }),
    args: v.strArr('args'),
    requires: v.strArr('requires'),
    exclusive: v.bool('exclusive', true),
    leaseSeconds: v.num('leaseSeconds', 900, 10),
    risk,
  };
  if (!r.command && !r.commandEnv) v.errors.push('either command or commandEnv is required');
  return v.errors.length ? { value: null, errors: v.errors } : { value: r, errors: [] };
}

export function parsePlaybook(obj: any): { value: Playbook | null; errors: string[] } {
  const v = new V(obj);
  v.noExtra(['id', 'displayName', 'steps', '$comment']);
  const id = v.str('id', { pattern: ID });
  const displayName = v.str('displayName');
  const stepsRaw = v.raw('steps');
  const steps: Playbook['steps'] = [];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) v.errors.push('steps must be a non-empty array');
  else {
    const seen = new Set<string>();
    for (const s of stepsRaw) {
      const sv = new V(s);
      const sid = sv.str('id', { pattern: ID });
      const step = { id: sid!, needs: sv.strArr('needs', false), after: sv.strArr('after'), output: sv.str('output', { optional: true }) };
      for (const a of step.after) if (!seen.has(a)) sv.errors.push(`step "${sid}" depends on unknown or later step "${a}"`);
      if (sid) seen.add(sid);
      v.errors.push(...sv.errors.map((e) => `steps.${e}`));
      steps.push(step);
    }
  }
  return v.errors.length ? { value: null, errors: v.errors } : { value: { id: id!, displayName: displayName!, steps }, errors: [] };
}

function readDir<T extends { id: string }>(dir: string, parse: (o: any) => { value: T | null; errors: string[] }, errors: Registries['errors']): Map<string, T> {
  const out = new Map<string, T>();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const file = path.join(dir, f);
    let obj: unknown;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push({ file, message: `invalid JSON: ${(e as Error).message}` });
      continue;
    }
    const { value, errors: errs } = parse(obj);
    if (!value) {
      errors.push({ file, message: errs.join('; ') });
      continue;
    }
    if (out.has(value.id)) {
      errors.push({ file, message: `duplicate id "${value.id}"` });
      continue;
    }
    out.set(value.id, value);
  }
  return out;
}

/** Load every registry and check references between them. */
export function loadRegistries(configDir: string): Registries {
  const errors: Registries['errors'] = [];
  const runtimes = readDir(path.join(configDir, 'runtimes'), parseRuntime, errors);
  const providers = readDir(path.join(configDir, 'providers'), parseProvider, errors);
  const tools = readDir(path.join(configDir, 'tools'), parseToolServer, errors);
  const playbooks = readDir(path.join(configDir, 'playbooks'), parsePlaybook, errors);
  const residentsRaw = readDir(path.join(configDir, 'residents'), parseResident, errors);
  const profilesRaw = readDir(path.join(configDir, 'profiles'), parseProfile, errors);
  const residents = new Map<string, Resident>();
  const refCheck = (r: { runtime: string; provider: string; tools: ToolGrant[] }, planned: boolean): string[] => {
    const refErrors: string[] = [];
    if (!planned || r.runtime) if (!runtimes.has(r.runtime)) refErrors.push(`runtime "${r.runtime}" is not registered`);
    if (!planned || r.provider) if (!providers.has(r.provider)) refErrors.push(`provider "${r.provider}" is not registered`);
    for (const g of r.tools) {
      const server = tools.get(g.server);
      if (!server) {
        refErrors.push(`tool server "${g.server}" is not registered`);
        continue;
      }
      for (const sel of [...g.allow, ...g.ask]) {
        if (!sel.startsWith('risk:') && !(sel in server.risk)) refErrors.push(`tool "${sel}" is not classified on server "${g.server}"`);
        if (!sel.startsWith('risk:') && g.allow.includes(sel) && server.risk[sel] === 'exec') refErrors.push(`exec tool "${sel}" may only be granted under "ask"`);
      }
    }
    return refErrors;
  };
  for (const [id, r] of residentsRaw) {
    const refErrors = refCheck(r, r.planned);
    if (refErrors.length) errors.push({ file: path.join(configDir, 'residents', `${id}.json`), message: refErrors.join('; ') });
    else residents.set(id, r);
  }
  const profiles = new Map<string, Profile>();
  const principals = new Map<string, Resident>(residents);
  for (const [id, p] of profilesRaw) {
    const refErrors = refCheck(p, false);
    const parent = residents.get(p.resident);
    if (!parent) refErrors.push(`resident "${p.resident}" is not registered`);
    else if (parent.planned) refErrors.push(`resident "${p.resident}" is only planned`);
    if (residents.has(id)) refErrors.push(`id "${id}" is already a resident`);
    if (refErrors.length) {
      errors.push({ file: path.join(configDir, 'profiles', `${id}.json`), message: refErrors.join('; ') });
      continue;
    }
    profiles.set(id, p);
    principals.set(id, profilePrincipal(p, parent!));
    if (!parent!.workplaces.includes(p.workplace)) parent!.workplaces.push(p.workplace);
  }
  return { residents, profiles, principals, runtimes, providers, tools, playbooks, errors };
}

/** Decide whether a resident's grant covers a tool, and how. Default: deny. */
export function grantFor(resident: Resident, server: ToolServer, tool: string): 'allow' | 'ask' | 'deny' {
  const cls = server.risk[tool];
  if (!cls) return 'deny'; // unclassified tools are never exposed
  const grant = resident.tools.find((g) => g.server === server.id);
  if (!grant) return 'deny';
  const matches = (sel: string) => sel === tool || sel === `risk:${cls}`;
  if (grant.ask.some(matches)) return 'ask';
  if (grant.allow.some(matches)) return cls === 'exec' ? 'ask' : 'allow';
  return 'deny';
}
