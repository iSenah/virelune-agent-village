// Cross-platform helpers for integration checks. Windows-aware (PATHEXT, .cmd shims, quoting).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function which(cmd: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!cmd) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const tryFile = (p: string): string | null => {
    for (const ext of isWin && !path.extname(p) ? exts : ['']) {
      const full = p + ext;
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
    return null;
  };
  if (cmd.includes('/') || cmd.includes('\\')) return tryFile(path.resolve(cmd));
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const hit = tryFile(path.join(d, cmd));
    if (hit) return hit;
  }
  return null;
}

export type RunResult = { code: number | null; stdout: string; stderr: string; error: string | null; timedOut: boolean };

/** On Windows, npm installs .cmd shims that cannot be spawned directly; run them through cmd.exe with quoting. */
export function resolveSpawn(file: string, args: string[]): { cmd: string; argv: string[]; verbatim: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const quoted = [file, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
    return { cmd: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${quoted}"`], verbatim: true };
  }
  return { cmd: file, argv: args, verbatim: false };
}

export function run(file: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string | undefined>; input?: string; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const { cmd, argv, verbatim } = resolveSpawn(file, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, argv, { env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd, windowsVerbatimArguments: verbatim, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 15_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: e.message, timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: null, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function httpJson(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; body: any; error: string | null }> {
  try {
    const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body, error: null };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { status: 0, body: null, error: err.cause?.code || err.name || err.message };
  }
}

/** Find a package installed in the project (node_modules) without importing it. */
export function findPackage(name: string, root: string): { version: string; dir: string } | null {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return { version: String(pkg.version), dir };
  } catch {
    return null;
  }
}

export function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
}
