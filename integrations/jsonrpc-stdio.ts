// Minimal newline-delimited JSON-RPC 2.0 client over a child process's stdio.
// Used for the Codex app-server and for stdio MCP servers behind the Tool Gateway.
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { resolveSpawn } from './util.ts';

export type RpcMessage = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: any } };

export class StdioRpcClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly transcript: { dir: 'out' | 'in'; msg: RpcMessage }[] = [];
  stderr = '';
  private includeVersion = true;
  exited: Promise<number | null>;
  onRequest: (msg: RpcMessage) => Promise<any> | any = () => {
    throw new Error('no handler');
  };
  onNotification: (msg: RpcMessage) => void = () => {};

  constructor(command: string, args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; jsonrpcField?: boolean } = {}) {
    const sp = resolveSpawn(command, args);
    this.child = spawn(sp.cmd, sp.argv, { env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd, windowsVerbatimArguments: sp.verbatim, stdio: ['pipe', 'pipe', 'pipe'] });
    this.includeVersion = opts.jsonrpcField ?? true;
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-20_000)));
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code) => {
        for (const p of this.pending.values()) p.reject(new Error(`process exited (code ${code})`));
        this.pending.clear();
        resolve(code);
      });
      this.child.on('error', (e) => {
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        resolve(null);
      });
    });
    const rl = readline.createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => this.handleLine(line));
  }

  private send(msg: RpcMessage) {
    const out = this.includeVersion ? { jsonrpc: '2.0', ...msg } : msg;
    this.transcript.push({ dir: 'out', msg: out });
    this.child.stdin!.write(JSON.stringify(out) + '\n');
  }

  private async handleLine(line: string) {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    this.transcript.push({ dir: 'in', msg });
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      try {
        const result = await this.onRequest(msg);
        this.send({ id: msg.id, result });
      } catch (e) {
        this.send({ id: msg.id, error: { code: -32000, message: (e as Error).message } });
      }
      return;
    }
    if (msg.method) this.onNotification(msg);
  }

  request(method: string, params: any, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: any) {
    this.send(params === undefined ? { method } : { method, params });
  }

  close() {
    try {
      this.child.stdin!.end();
    } catch {
      /* ignore */
    }
    this.child.kill();
  }
}
