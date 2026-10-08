// HTTP API: REST commands, a Server-Sent Events stream of the event log, the Tool Gateway endpoint,
// and the static web app. Loopback only. State-changing browser requests must come from the village itself.
import fs from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import type { Village } from './app.ts';
import { AUTONOMY_LEVELS } from './settings.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;

const MAX_BODY = 1024 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary' };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

export function createServer(village: Village): http.Server {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, p: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, pattern, keys, handler });
  };
  const expectedOrigin = () => `http://${village.config.host === '::1' ? '[::1]' : village.config.host}:${(server.address() as any)?.port ?? village.config.port}`;

  // ---------- Read endpoints ----------
  route('GET', '/api/health', (_q, res) => send(res, 200, { ok: true, name: 'Virelune Agent Village', machine: village.config.machineName, lastSeq: village.events.lastSeq() }));

  route('GET', '/api/state', (_q, res) =>
    send(res, 200, {
      machine: village.config.machineName,
      platform: village.config.platform,
      lastSeq: village.events.lastSeq(),
      residents: village.residents(),
      tasks: village.tasks.list(),
      approvals: village.approvals.list('pending'),
      echo: { autonomy: village.settings.echoAutonomy(), levels: AUTONOMY_LEVELS },
      doctor: { running: village.doctorRunning, results: village.doctorLatest() },
      registry: {
        residents: village.registries.residents.size,
        runtimes: [...village.registries.runtimes.values()],
        providers: [...village.registries.providers.values()],
        tools: [...village.registries.tools.values()].map((t) => ({ id: t.id, displayName: t.displayName, exclusive: t.exclusive, classifiedTools: Object.keys(t.risk).length })),
        playbooks: [...village.registries.playbooks.values()],
        errors: village.registries.errors,
      },
    }),
  );

  route('GET', '/api/events', (_q, res, _p, url) => {
    const after = Number(url.searchParams.get('after') ?? 0) || 0;
    const limit = Number(url.searchParams.get('limit') ?? 500) || 500;
    send(res, 200, { events: village.events.list(after, limit) });
  });

  route('GET', '/api/events/stream', (req, res, _p, url) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0;
    const write = (e: { seq: number }) => {
      if (e.seq <= cursor) return;
      cursor = e.seq;
      res.write(`id: ${e.seq}\nevent: village\ndata: ${JSON.stringify(e)}\n\n`);
    };
    res.write('retry: 2000\n\n');
    // Replay what the client missed, then go live.
    for (let batch = village.events.list(cursor, 1000); batch.length; batch = village.events.list(cursor, 1000)) batch.forEach(write);
    const unsub = village.events.subscribe(write);
    const ping = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  route('GET', '/api/tasks', (_q, res) => send(res, 200, { tasks: village.tasks.list() }));
  route('GET', '/api/approvals', (_q, res) => send(res, 200, { approvals: village.approvals.list() }));
  route('GET', '/api/doctor', (_q, res) => send(res, 200, { running: village.doctorRunning, results: village.doctorLatest() }));

  // ---------- Commands ----------
  route('POST', '/api/tasks', async (req, res) => {
    const b = await readJson(req);
    const t = village.tasks.create({ title: b.title, description: b.description, assignee: b.assignee || null, project: b.project || null, dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn : [] }, 'human');
    send(res, 201, { task: t });
  });
  route('POST', '/api/tasks/:id/cancel', (_q, res, p) => send(res, 200, { task: village.tasks.cancel(p.id, 'human') }));
  route('POST', '/api/approvals/:id', async (req, res, p) => {
    const b = await readJson(req);
    send(res, 200, { approval: village.approvals.decide(p.id, b.decision, 'human', typeof b.reason === 'string' ? b.reason.slice(0, 1000) : '') });
  });
  route('PUT', '/api/settings/echo-autonomy', async (req, res) => {
    const b = await readJson(req);
    send(res, 200, { autonomy: village.settings.setEchoAutonomy(String(b.level ?? ''), 'human') });
  });
  route('POST', '/api/doctor/run', async (req, res) => {
    const b = await readJson(req);
    const report = await village.runDoctor(b.live !== false);
    send(res, 200, { report });
  });

  // ---------- Tool Gateway (MCP over HTTP, JSON responses) ----------
  route('POST', '/mcp/:resident', async (req, res, p) => {
    if (req.headers.origin) throw new HttpError(403, 'browser requests are not accepted by the Tool Gateway');
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const resident = decodeURIComponent(p.resident);
    const verdict = village.registries.residents.has(resident) ? village.gateway.authenticate(resident, token) : 'unauthenticated';
    if (verdict === 'unauthenticated') {
      village.events.append({ type: 'tool.auth_failed', actor: 'gateway', payload: { resident, reason: token ? 'bad token' : 'no token' } });
      throw new HttpError(401, 'unauthenticated');
    }
    if (verdict === 'forbidden') throw new HttpError(403, `${resident} is not an active resident`);
    const body = await readJson(req);
    if (Array.isArray(body)) throw new HttpError(400, 'batch requests are not supported');
    const out = await village.gateway.handle(resident, body);
    if (!out) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, out);
  });
  route('GET', '/mcp/:resident', () => {
    throw new HttpError(405, 'server-sent streams are not offered by the Tool Gateway');
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      // Defense against other websites driving the local API (CSRF / DNS rebinding).
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, 'invalid Host header');
      if (method !== 'GET' && method !== 'HEAD' && url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && origin !== expectedOrigin() && origin !== expectedOrigin().replace('127.0.0.1', 'localhost')) throw new HttpError(403, 'cross-origin request refused');
        if (req.headers['x-village-client'] !== '1') throw new HttpError(403, 'missing X-Village-Client header');
      }
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1]));
        await r.handler(req, res, params, url);
        return;
      }
      if (method === 'GET' || method === 'HEAD') return serveStatic(village.config.webDir, url.pathname, res, req);
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = (e as any).status ?? 500;
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
      if (status === 500) console.error(e);
    }
  });
  return server;
}

const tsCache = new Map<string, { mtime: number; js: string }>();

function serveStatic(webDir: string, pathname: string, res: http.ServerResponse, req?: http.IncomingMessage) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.resolve(webDir, '.' + rel);
  if (!file.startsWith(path.resolve(webDir) + path.sep)) throw new HttpError(403, 'forbidden');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (!stat.isFile()) throw new HttpError(404, 'not found');
  const ext = path.extname(file);
  const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  if (ext === '.html') headers['content-security-policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' blob:";
  if (ext === '.ts') {
    // The browser app is written in TypeScript and served as JavaScript via Node's built-in type stripping.
    let c = tsCache.get(file);
    if (!c || c.mtime !== stat.mtimeMs) {
      c = { mtime: stat.mtimeMs, js: stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' }) };
      tsCache.set(file, c);
    }
    res.writeHead(200, headers);
    res.end(c.js);
    return;
  }
  // Large assets (the GLB models) are revalidated cheaply instead of re-downloaded on every load.
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  headers.etag = etag;
  if (req?.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(stat.size);
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
