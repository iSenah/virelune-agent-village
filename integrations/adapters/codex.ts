// Codex runtime adapter: real conversations through the locally installed Codex CLI ("codex app-server",
// JSON-RPC over stdio). Protocol checked against codex-cli 0.161.0 (`codex app-server generate-ts`).
//
// Isolation and safety (all enforced here, not by convention):
// - Codex runs with the village's own CODEX_HOME (data/runtime/codex-home), signed in by `npm run codex:login`.
//   Your personal Codex config, sessions and MCP servers are never loaded. Its only MCP server is the
//   village Tool Gateway, reached with a per-session token that lives only in the child's environment.
// - Only a ChatGPT-plan login is accepted. If the village Codex home is signed in with an API key (billed per
//   token) the adapter refuses; it never falls back to another provider or a paid API. OpenAI/Anthropic keys
//   are removed from Codex's environment.
// - Threads run in the resident's workspace with sandbox "workspace-write" and approval policy "untrusted":
//   Codex must ask before file changes and before any command that is not known to be read-only. Every ask
//   becomes a village approval (Approvals tab); unanswered approvals expire as declined. Requests that point
//   outside the workspace are declined automatically. Extra-permission and user-input requests are declined.
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterContext, AdapterReply, AgentAdapter } from '../../server/lib/chat.ts';
import type { Approvals } from '../../server/lib/approvals.ts';
import type { EventLog } from '../../server/lib/events.ts';
import { StdioRpcClient, type RpcMessage } from '../jsonrpc-stdio.ts';
import { codexThreadDefaults, prepareCodexLaunch } from '../runtime-config.ts';
import { which } from '../util.ts';

export type CodexAdapterDeps = {
  dataDir: string;
  env: Record<string, string | undefined>;
  events: EventLog;
  approvals: Approvals;
  /** Issue a fresh Tool Gateway token for a resident (kept only in memory). */
  issueToken: (residentId: string) => string;
  revokeToken: (residentId: string) => void;
  /** Base URL of this Village Hall, e.g. http://127.0.0.1:4317 (the gateway lives at /mcp/<resident>). */
  gatewayUrl: () => string;
  /** The folder this resident may work in. */
  workspaceFor: (residentId: string) => string;
  /** Override the Codex executable (tests). Defaults to CODEX_PATH or `codex` on PATH. */
  command?: string;
  /** Extra arguments before `app-server` (tests run a fixture script through node). */
  commandArgs?: string[];
  approvalTimeoutMs?: number;
  idleMs?: number;
  startupTimeoutMs?: number;
  /** For tests: pretend to run on another platform. */
  platform?: NodeJS.Platform;
};

type TurnWatcher = {
  turnId: string | null;
  text: Map<string, string>; // agentMessage itemId -> final text
  order: string[];
  items: Map<string, any>;
  lastError: string | null;
  resolve: (status: { status: string; error: string | null }) => void;
  ctx: AdapterContext;
  workspace: string;
};

/** One running app-server per resident. */
class CodexSession {
  readonly residentId: string;
  readonly rpc: StdioRpcClient;
  readonly ready: Promise<void>;
  lastUsed = Date.now();
  watchers = new Map<string, TurnWatcher>(); // threadId -> active turn
  dead: string | null = null;

  constructor(residentId: string, rpc: StdioRpcClient, ready: Promise<void>) {
    this.residentId = residentId;
    this.rpc = rpc;
    this.ready = ready;
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly runtimeKind = 'codex-app-server';
  private d: CodexAdapterDeps;
  private sessions = new Map<string, CodexSession>();
  private sweeper: NodeJS.Timeout;

  constructor(deps: CodexAdapterDeps) {
    this.d = deps;
    this.sweeper = setInterval(() => this.closeIdle(), 60_000);
    this.sweeper.unref();
  }

  async reply(ctx: AdapterContext): Promise<AdapterReply> {
    const workspace = this.d.workspaceFor(ctx.resident.id);
    fs.mkdirSync(workspace, { recursive: true }); // before spawning: Codex starts inside the workspace
    const session = await this.session(ctx.resident.id);
    await this.requirePlanLogin(session);
    await this.requireSandbox(session);
    const defaults = codexThreadDefaults(workspace);
    const threadOpts = {
      ...defaults,
      model: ctx.resident.model ?? undefined,
      developerInstructions: residentInstructions(ctx, workspace),
    };
    // Resume the resident's Codex thread when we have one; start a new one if it is gone.
    let threadId: string | null = null;
    if (ctx.threadState) {
      try {
        const r = await session.rpc.request('thread/resume', { threadId: ctx.threadState, ...threadOpts, excludeTurns: true }, 30_000);
        threadId = r?.thread?.id ?? ctx.threadState;
      } catch {
        threadId = null;
      }
    }
    if (!threadId) {
      const r = await session.rpc.request('thread/start', threadOpts, 30_000);
      threadId = r?.thread?.id;
      if (!threadId) throw new Error('Codex did not start a thread');
    }
    const tid = threadId;
    const done = new Promise<{ status: string; error: string | null }>((resolve) => {
      session.watchers.set(tid, { turnId: null, text: new Map(), order: [], items: new Map(), lastError: null, resolve, ctx, workspace });
    });
    const exited = session.rpc.exited.then((code) => ({ status: 'failed', error: `Codex stopped unexpectedly (exit code ${code ?? 'unknown'}).${session.rpc.stderr ? ` ${tail(session.rpc.stderr)}` : ''}` }));
    const onAbort = () => {
      const w = session.watchers.get(tid);
      if (w?.turnId) session.rpc.request('turn/interrupt', { threadId: tid, turnId: w.turnId }, 10_000).catch(() => {});
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      session.lastUsed = Date.now();
      const started = await session.rpc.request('turn/start', { threadId: tid, input: [{ type: 'text', text: ctx.message, text_elements: [] }] }, 30_000);
      const w = session.watchers.get(tid);
      if (w && started?.turn?.id) w.turnId = started.turn.id;
      if (ctx.signal.aborted) onAbort();
      const result = await Promise.race([done, exited, abortGrace(ctx.signal, done)]);
      const watcher = session.watchers.get(tid);
      const text = watcher ? watcher.order.map((id) => watcher.text.get(id) ?? '').filter((t) => t.trim()).join('\n\n') : '';
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('stopped');
      if (result.status === 'completed') return { text, threadState: tid };
      if (result.status === 'interrupted') throw new Error('Codex stopped this reply');
      throw new Error(result.error || watcher?.lastError || `Codex could not finish (turn ${result.status})`);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      session.watchers.delete(tid);
      session.lastUsed = Date.now();
    }
  }

  /** Stop all Codex processes (village shutdown). */
  close() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.endSession(id);
  }

  // ---------- session management ----------

  private async session(residentId: string): Promise<CodexSession> {
    const existing = this.sessions.get(residentId);
    if (existing && !existing.dead) {
      await existing.ready;
      return existing;
    }
    const command = this.d.command ?? (this.d.env.CODEX_PATH ? which(this.d.env.CODEX_PATH, this.d.env) : which('codex', this.d.env));
    if (!command) throw new Error('Codex CLI not found on this machine. Install it with "npm install -g @openai/codex" (or set CODEX_PATH), then run the doctor.');
    const token = this.d.issueToken(residentId);
    const launch = prepareCodexLaunch({ dataDir: this.d.dataDir, residentId, gatewayUrl: this.d.gatewayUrl(), token, baseEnv: this.d.env });
    // Never let Codex pick up an API key from the environment: it would bill per token instead of the plan.
    delete launch.env.CODEX_API_KEY;
    delete launch.env.OPENAI_BASE_URL;
    const rpc = new StdioRpcClient(command, [...(this.d.commandArgs ?? []), ...launch.args], { env: launch.env, cwd: this.d.workspaceFor(residentId) });
    let session!: CodexSession;
    const ready = (async () => {
      await rpc.request('initialize', { clientInfo: { name: 'virelune-agent-village', title: 'Virelune Agent Village', version: '2' }, capabilities: null }, this.d.startupTimeoutMs ?? 30_000);
      rpc.notify('initialized');
    })();
    session = new CodexSession(residentId, rpc, ready);
    rpc.onNotification = (m) => this.onNotification(session, m);
    rpc.onRequest = (m) => this.onServerRequest(session, m);
    rpc.exited.then((code) => {
      session.dead = `exit ${code}`;
      if (this.sessions.get(residentId) === session) {
        this.sessions.delete(residentId);
        this.d.revokeToken(residentId);
      }
    });
    this.sessions.set(residentId, session);
    try {
      await ready;
    } catch (e) {
      this.endSession(residentId);
      const why = (e as Error).message;
      throw new Error(`Codex app-server did not start (${why}).${rpc.stderr ? ` ${tail(rpc.stderr)}` : ''}`);
    }
    return session;
  }

  private async requirePlanLogin(session: CodexSession) {
    let r: any;
    try {
      r = await session.rpc.request('account/read', {}, 20_000);
    } catch (e) {
      throw new Error(`Could not read the village Codex sign-in (${(e as Error).message}).`);
    }
    const acct = r?.account;
    if (!acct) throw new Error('Codex is not signed in for the village. In the project folder run "npm run codex:login", then press Check integrations.');
    if (acct.type !== 'chatgpt') {
      throw new Error(`The village Codex home is signed in with ${acct.type === 'apiKey' ? 'an OpenAI API key (billed per token)' : `"${acct.type}"`}. Virelune only uses Codex through your ChatGPT plan and will not start paid usage. Run "npm run codex:login" and choose "Sign in with ChatGPT".`);
    }
  }

  /** On Windows, Codex's sandbox needs a one-time setup; without it workspace limits are not enforced. */
  private async requireSandbox(session: CodexSession) {
    if ((this.d.platform ?? process.platform) !== 'win32') return;
    const r = await session.rpc.request('windowsSandbox/readiness', {}, 15_000).catch((e: Error) => ({ status: `unknown (${e.message})` }));
    if (r?.status !== 'ready') throw new Error(`Codex's Windows sandbox is ${r?.status === 'notConfigured' ? 'not set up' : r?.status === 'updateRequired' ? 'out of date' : r?.status}, so Virelune will not let Codex work yet. In the project folder run "npm run codex:sandbox-setup", then press Check integrations.`);
  }

  private endSession(residentId: string) {
    const s = this.sessions.get(residentId);
    if (!s) return;
    this.sessions.delete(residentId);
    s.dead = 'closed';
    for (const w of s.watchers.values()) w.resolve({ status: 'failed', error: 'Codex session closed' });
    s.rpc.close();
    this.d.revokeToken(residentId);
  }

  private closeIdle() {
    const idle = this.d.idleMs ?? 10 * 60_000;
    for (const [id, s] of this.sessions) if (!s.watchers.size && Date.now() - s.lastUsed > idle) this.endSession(id);
  }

  // ---------- protocol ----------

  private onNotification(s: CodexSession, m: RpcMessage) {
    const p = m.params ?? {};
    const w = p.threadId ? s.watchers.get(p.threadId) : undefined;
    if (!w) return;
    switch (m.method) {
      case 'turn/started':
        if (p.turn?.id) w.turnId = p.turn.id;
        break;
      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string') w.ctx.onDelta(p.delta);
        break;
      case 'item/started':
        if (p.item?.id) w.items.set(p.item.id, p.item);
        if (p.item?.type === 'agentMessage' && !w.order.includes(p.item.id)) w.order.push(p.item.id);
        break;
      case 'item/completed': {
        const item = p.item;
        if (!item?.id) break;
        w.items.set(item.id, item);
        if (item.type === 'agentMessage') {
          if (!w.order.includes(item.id)) w.order.push(item.id);
          w.text.set(item.id, String(item.text ?? ''));
        } else if (item.type === 'commandExecution') {
          this.d.events.append({ type: 'runtime.command_finished', actor: s.residentId, runId: w.ctx.runId, payload: { command: String(item.command ?? '').slice(0, 500), cwd: item.cwd ?? null, exitCode: item.exitCode ?? null, status: item.status ?? null } });
        } else if (item.type === 'fileChange') {
          this.d.events.append({ type: 'runtime.files_changed', actor: s.residentId, runId: w.ctx.runId, payload: { status: item.status ?? null, files: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type ?? null })).slice(0, 50) } });
        } else if (item.type === 'mcpToolCall') {
          this.d.events.append({ type: 'runtime.tool_called', actor: s.residentId, runId: w.ctx.runId, payload: { server: item.server, tool: item.tool, status: item.status ?? null } });
        }
        break;
      }
      case 'error':
        if (p.error?.message) w.lastError = String(p.error.message);
        break;
      case 'turn/completed':
        if (!w.turnId || p.turn?.id === w.turnId || !p.turn?.id) w.resolve({ status: String(p.turn?.status ?? 'failed'), error: p.turn?.error?.message ?? w.lastError });
        break;
    }
  }

  private async onServerRequest(s: CodexSession, m: RpcMessage): Promise<any> {
    const p = m.params ?? {};
    const w = p.threadId ? s.watchers.get(p.threadId) : undefined;
    const workspace = w?.workspace ?? this.d.workspaceFor(s.residentId);
    const ctx = w?.ctx;
    switch (m.method) {
      case 'item/commandExecution/requestApproval': {
        const command = String(p.command ?? (w?.items.get(p.itemId)?.command ?? '')).slice(0, 2000);
        const cwd = p.cwd ? String(p.cwd) : workspace;
        if (!isInside(cwd, workspace)) return this.autoDecline(s, ctx, 'command', `runs in ${cwd}, outside the workspace`, { command, cwd });
        const ok = await this.askHuman(s, ctx, { kind: 'codex_command', risk: 'exec', summary: `${ctx?.resident.displayName ?? s.residentId} wants to run: ${command || '(command not shown)'}`, detail: { command, cwd, reason: p.reason ?? null, network: p.networkApprovalContext ?? null, workspace } });
        return { decision: ok ? 'accept' : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        const item = w?.items.get(p.itemId);
        const changes = (item?.changes ?? []).map((c: any) => ({ path: String(c.path), kind: c.kind?.type ?? 'update', diff: String(c.diff ?? '').slice(0, 4000) }));
        const outside = changes.filter((c: any) => !isInside(path.resolve(workspace, c.path), workspace));
        if (p.grantRoot && !isInside(String(p.grantRoot), workspace)) return this.autoDecline(s, ctx, 'file change', `asks for write access to ${p.grantRoot}, outside the workspace`, { grantRoot: p.grantRoot });
        if (outside.length) return this.autoDecline(s, ctx, 'file change', `touches ${outside.map((c: any) => c.path).join(', ')}, outside the workspace`, { changes: outside.map((c: any) => c.path) });
        const names = changes.map((c: any) => `${c.kind} ${path.relative(workspace, path.resolve(workspace, c.path)) || c.path}`);
        const ok = await this.askHuman(s, ctx, { kind: 'codex_file_change', risk: 'write', summary: `${ctx?.resident.displayName ?? s.residentId} wants to change ${changes.length || 'some'} file${changes.length === 1 ? '' : 's'}${names.length ? `: ${names.slice(0, 5).join(', ')}` : ''}`, detail: { changes, reason: p.reason ?? null, workspace } });
        return { decision: ok ? 'accept' : 'decline' };
      }
      case 'item/permissions/requestApproval':
        this.autoDeclineEvent(s, ctx, 'extra permissions', 'the village does not grant extra sandbox permissions', { permissions: p.permissions ?? null });
        return { permissions: {}, scope: 'turn' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.autoDeclineEvent(s, ctx, 'legacy approval', 'legacy approval requests are not supported', {});
        return { decision: { denied: { rejection: 'Not supported by Virelune Agent Village' } } };
      default:
        throw new Error(`Virelune does not support ${m.method}`);
    }
  }

  private async askHuman(s: CodexSession, ctx: AdapterContext | undefined, a: { kind: string; risk: string; summary: string; detail: Record<string, unknown> }): Promise<boolean> {
    if (ctx?.signal.aborted) return false;
    const approval = this.d.approvals.request({ kind: a.kind, resident: s.residentId, summary: a.summary.slice(0, 300), risk: a.risk, detail: { ...a.detail, runId: ctx?.runId ?? null } });
    const decided = await this.d.approvals.wait(approval.id, this.d.approvalTimeoutMs ?? 5 * 60_000);
    return decided.status === 'approved';
  }

  private autoDecline(s: CodexSession, ctx: AdapterContext | undefined, what: string, why: string, detail: Record<string, unknown>) {
    this.autoDeclineEvent(s, ctx, what, why, detail);
    return { decision: 'decline' };
  }

  private autoDeclineEvent(s: CodexSession, ctx: AdapterContext | undefined, what: string, why: string, detail: Record<string, unknown>) {
    this.d.events.append({ type: 'runtime.request_declined', actor: 'system', runId: ctx?.runId ?? null, payload: { resident: s.residentId, what, reason: why, ...detail } });
  }
}

/** Who the resident is, in Codex's developer instructions (identity, role, boundaries). */
function residentInstructions(ctx: AdapterContext, workspace: string): string {
  const r = ctx.resident;
  return [
    `You are ${r.displayName}, a resident of Virelune Agent Village. Your role: ${r.role}.`,
    `You are talking with the village's human owner through the village chat. Be direct and concise.`,
    `Your workspace is ${workspace}. Only read and change files inside it. Every file change and every non-read-only command must be approved by the human in the village; if something is declined, say so and continue without it.`,
    r.tools.length ? `Village tools reach you only through the "village" MCP server, with the permissions the village grants.` : `You have no village tool servers.`,
  ].join('\n');
}

function isInside(target: string, root: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(root, target);
  const rel = path.relative(process.platform === 'win32' ? a.toLowerCase() : a, process.platform === 'win32' ? b.toLowerCase() : b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** After a stop request, give Codex a few seconds to report the interrupted turn, then stop waiting. */
function abortGrace(signal: AbortSignal, done: Promise<unknown>): Promise<{ status: string; error: string | null }> {
  return new Promise((resolve) => {
    const onAbort = () => {
      const t = setTimeout(() => resolve({ status: 'interrupted', error: 'stopped' }), 5000);
      done.then(() => clearTimeout(t));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function tail(s: string): string {
  const lines = s.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-3).join(' | ').slice(0, 400);
}
