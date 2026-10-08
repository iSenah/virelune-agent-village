// Tool Gateway: the only road from a resident to an MCP tool server.
// - Residents authenticate with a per-session token issued by Village Hall (never stored on disk).
// - Only tools a resident is granted are listed; unclassified tools are never exposed (default deny).
// - "ask" tools (and every exec-class tool) wait for a human approval; unanswered means denied.
// - Exclusive tool servers (one running app, e.g. Blender) require a lease; one resident at a time.
// - Every request, denial, approval and result is an event.
import crypto from 'node:crypto';
import { StdioRpcClient } from '../../integrations/jsonrpc-stdio.ts';
import type { Approvals } from './approvals.ts';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import type { EventLog } from './events.ts';
import { grantFor, type Registries, type Resident, type ToolServer } from './registry.ts';

export type JsonRpcRequest = { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: number | string | null; result?: any; error?: { code: number; message: string } };

export const GATEWAY_ERRORS = { DENIED: -32001, APPROVAL_DENIED: -32002, BUSY: -32003, UNAVAILABLE: -32004, BAD_REQUEST: -32600, NO_METHOD: -32601, BAD_PARAMS: -32602 };

const MAX_ARGS_BYTES = 256 * 1024;
const NAME_SEP = '__';

type Upstream = { client: StdioRpcClient; tools: { name: string; description?: string; inputSchema?: unknown }[] };

export type GatewayOptions = {
  db: DB;
  events: EventLog;
  approvals: Approvals;
  registries: () => Registries;
  env: Record<string, string | undefined>;
  /** Only residents for which this returns true may use the gateway (production: resident is connected). */
  isResidentActive: (residentId: string) => boolean;
  approvalTimeoutMs?: number;
};

export class ToolGateway {
  private opts: GatewayOptions;
  private tokens = new Map<string, Buffer>(); // residentId -> sha256(token)
  private upstreams = new Map<string, Promise<Upstream>>();

  constructor(opts: GatewayOptions) {
    this.opts = opts;
  }

  /** Issue a fresh session token for a resident. The plain token is returned once and only kept as a hash. */
  issueToken(residentId: string): string {
    if (!this.opts.registries().residents.has(residentId)) throw new Error(`unknown resident ${residentId}`);
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(residentId, crypto.createHash('sha256').update(token).digest());
    return token;
  }

  revokeToken(residentId: string) {
    this.tokens.delete(residentId);
    this.releaseLeases(residentId);
  }

  authenticate(residentId: string, token: string | null): 'ok' | 'unauthenticated' | 'forbidden' {
    const expected = this.tokens.get(residentId);
    if (!token || !expected) return 'unauthenticated';
    const got = crypto.createHash('sha256').update(token).digest();
    if (!crypto.timingSafeEqual(got, expected)) return 'unauthenticated';
    if (!this.opts.isResidentActive(residentId)) return 'forbidden';
    return 'ok';
  }

  private resident(id: string): Resident {
    const r = this.opts.registries().residents.get(id);
    if (!r) throw new Error('unknown resident');
    return r;
  }

  private server(id: string): ToolServer | undefined {
    return this.opts.registries().tools.get(id);
  }

  private commandFor(server: ToolServer): { cmd: string; args: string[] } | null {
    if (server.command) return { cmd: server.command, args: server.args };
    const raw = server.commandEnv ? this.opts.env[server.commandEnv] : undefined;
    if (!raw || !raw.trim()) return null;
    // Simple split; paths with spaces should be quoted: "C:\\Program Files\\x.exe" --flag
    const parts = raw.match(/"[^"]*"|\S+/g)!.map((p) => p.replace(/^"|"$/g, ''));
    return { cmd: parts[0], args: [...parts.slice(1), ...server.args] };
  }

  private upstream(server: ToolServer): Promise<Upstream> {
    let p = this.upstreams.get(server.id);
    if (!p) {
      p = (async () => {
        const c = this.commandFor(server);
        if (!c) throw new Error(`${server.displayName} is not configured on this machine`);
        const client = new StdioRpcClient(c.cmd, c.args, { env: this.opts.env });
        // Tool servers may not call back into the village (no sampling, no elicitation).
        client.onRequest = () => {
          throw new Error('server-initiated requests are not permitted by the Virelune Tool Gateway');
        };
        await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'virelune-tool-gateway', version: '0.1.0' } }, 20_000);
        client.notify('notifications/initialized');
        const list = await client.request('tools/list', {}, 20_000);
        client.exited.then(() => this.upstreams.delete(server.id));
        return { client, tools: Array.isArray(list?.tools) ? list.tools : [] };
      })();
      p.catch(() => this.upstreams.delete(server.id));
      this.upstreams.set(server.id, p);
    }
    return p;
  }

  /** Handle one MCP JSON-RPC message from an authenticated resident. Returns null for notifications. */
  async handle(residentId: string, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = msg?.id ?? null;
    const ok = (result: any): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return err(GATEWAY_ERRORS.BAD_REQUEST, 'invalid JSON-RPC request');
    if (msg.id === undefined) return null; // notifications (e.g. notifications/initialized) need no reply
    const resident = this.resident(residentId);
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'virelune-tool-gateway', version: '0.1.0' }, instructions: 'All tools are mediated by Virelune Agent Village. Some calls wait for human approval.' });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: await this.listTools(resident) });
      case 'tools/call':
        return this.callTool(resident, msg.params, ok, err);
      default:
        // resources, prompts, sampling and anything else are not passed through.
        return err(GATEWAY_ERRORS.NO_METHOD, `method "${msg.method}" is not available through the Virelune Tool Gateway`);
    }
  }

  private async listTools(resident: Resident) {
    const out: { name: string; description: string; inputSchema: unknown }[] = [];
    for (const g of resident.tools) {
      const server = this.server(g.server);
      if (!server) continue;
      let up: Upstream;
      try {
        up = await this.upstream(server);
      } catch {
        continue; // unavailable servers simply contribute no tools
      }
      for (const t of up.tools) {
        const decision = grantFor(resident, server, t.name);
        if (decision === 'deny') continue;
        out.push({ name: `${server.id}${NAME_SEP}${t.name}`, description: `${decision === 'ask' ? '[Needs your approval] ' : ''}${t.description ?? ''}`.trim(), inputSchema: t.inputSchema ?? { type: 'object' } });
      }
    }
    return out;
  }

  private async callTool(resident: Resident, params: any, ok: (r: any) => JsonRpcResponse, err: (c: number, m: string) => JsonRpcResponse): Promise<JsonRpcResponse> {
    const full = params?.name;
    const args = params?.arguments ?? {};
    if (typeof full !== 'string' || !full.includes(NAME_SEP)) return err(GATEWAY_ERRORS.BAD_PARAMS, 'tool name must be "<server>__<tool>"');
    if (typeof args !== 'object' || Array.isArray(args) || args === null) return err(GATEWAY_ERRORS.BAD_PARAMS, 'arguments must be an object');
    const argsJson = JSON.stringify(args);
    if (Buffer.byteLength(argsJson) > MAX_ARGS_BYTES) return err(GATEWAY_ERRORS.BAD_PARAMS, 'arguments too large');
    const sep = full.indexOf(NAME_SEP);
    const serverId = full.slice(0, sep);
    const tool = full.slice(sep + NAME_SEP.length);
    const server = this.server(serverId);
    const decision = server ? grantFor(resident, server, tool) : 'deny';
    const base = { resident: resident.id, server: serverId, tool, argsBytes: Buffer.byteLength(argsJson) };
    this.opts.events.append({ type: 'tool.call_requested', actor: resident.id, payload: { ...base, decision } });
    if (!server || decision === 'deny') {
      this.opts.events.append({ type: 'tool.call_denied', actor: 'gateway', payload: { ...base, reason: 'not granted' } });
      return err(GATEWAY_ERRORS.DENIED, `tool "${full}" is not granted to ${resident.displayName}`);
    }
    if (decision === 'ask') {
      const a = this.opts.approvals.request({ kind: 'tool_call', resident: resident.id, summary: `${resident.displayName} wants to run ${server.displayName}: ${tool}`, detail: { server: serverId, tool, arguments: args }, risk: server.risk[tool] ?? 'unclassified' });
      const decided = await this.opts.approvals.wait(a.id, this.opts.approvalTimeoutMs ?? 10 * 60_000);
      if (decided.status !== 'approved') {
        this.opts.events.append({ type: 'tool.call_denied', actor: 'gateway', payload: { ...base, reason: `approval ${decided.status}`, approvalId: a.id } });
        return err(GATEWAY_ERRORS.APPROVAL_DENIED, `approval ${decided.status} for "${full}"`);
      }
    }
    if (server.exclusive) {
      const lease = this.acquireLease(server, resident.id);
      if (!lease.ok) {
        this.opts.events.append({ type: 'tool.call_denied', actor: 'gateway', payload: { ...base, reason: `busy: lease held by ${lease.holder}` } });
        return err(GATEWAY_ERRORS.BUSY, `${server.displayName} is in use by ${lease.holder}`);
      }
    }
    let up: Upstream;
    try {
      up = await this.upstream(server);
    } catch (e) {
      this.opts.events.append({ type: 'tool.call_denied', actor: 'gateway', payload: { ...base, reason: `unavailable: ${(e as Error).message}` } });
      return err(GATEWAY_ERRORS.UNAVAILABLE, (e as Error).message);
    }
    try {
      const res = await up.client.request('tools/call', { name: tool, arguments: args }, 5 * 60_000);
      this.opts.events.append({ type: 'tool.call_completed', actor: resident.id, payload: { ...base, isError: Boolean(res?.isError) } });
      return ok(res);
    } catch (e) {
      this.opts.events.append({ type: 'tool.call_completed', actor: resident.id, payload: { ...base, isError: true, error: (e as Error).message } });
      return err(GATEWAY_ERRORS.UNAVAILABLE, `tool server error: ${(e as Error).message}`);
    }
  }

  acquireLease(server: ToolServer, residentId: string): { ok: true } | { ok: false; holder: string } {
    return tx(this.opts.db, () => {
      const now = Date.now();
      const row = this.opts.db.prepare('SELECT resident, expires_at FROM leases WHERE tool_server = ?').get(server.id) as any;
      if (row && row.resident !== residentId && Date.parse(row.expires_at) > now) return { ok: false as const, holder: row.resident };
      if (row && row.resident !== residentId) this.opts.events.append({ type: 'lease.expired', actor: 'gateway', payload: { server: server.id, resident: row.resident } });
      const expires = new Date(now + server.leaseSeconds * 1000).toISOString();
      this.opts.db.prepare('INSERT INTO leases (tool_server, resident, acquired_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(tool_server) DO UPDATE SET resident = excluded.resident, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at').run(server.id, residentId, new Date(now).toISOString(), expires);
      if (!row || row.resident !== residentId) this.opts.events.append({ type: 'lease.acquired', actor: residentId, payload: { server: server.id, expiresAt: expires } });
      return { ok: true as const };
    });
  }

  releaseLeases(residentId: string) {
    tx(this.opts.db, () => {
      const rows = this.opts.db.prepare('SELECT tool_server FROM leases WHERE resident = ?').all(residentId) as any[];
      for (const r of rows) {
        this.opts.db.prepare('DELETE FROM leases WHERE tool_server = ?').run(r.tool_server);
        this.opts.events.append({ type: 'lease.released', actor: residentId, payload: { server: r.tool_server } });
      }
    });
  }

  close() {
    for (const p of this.upstreams.values()) p.then((u) => u.client.close()).catch(() => {});
    this.upstreams.clear();
  }
}
