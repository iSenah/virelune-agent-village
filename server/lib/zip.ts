// Minimal ZIP writer (deflate) using only node:zlib, so exports work on any machine without extra tools.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export type ZipEntry = { name: string; data: Buffer; mtime: Date };

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = zlib.crc32(e.data);
    const { time, date } = dosTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Files that must never leave the machine: secrets, machine settings, databases, dependencies, exports. */
export function isExcluded(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  const base = p.split('/').pop()!;
  if (/^(\.git|node_modules|data|exports|machine)(\/|$)/.test(p)) return true;
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true;
  if (/\.local\.json$/.test(base)) return true;
  if (/\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|pem|key|p12|pfx)$/i.test(base)) return true;
  if (base === 'auth.json' || base === 'credentials.json') return true;
  return false;
}

export function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full);
      if (isExcluded(rel)) continue;
      if (d.isDirectory()) walk(full);
      else if (d.isFile()) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/** Patterns that look like real credentials. The export refuses to proceed if any file matches. */
export const SECRET_PATTERNS: RegExp[] = [/sk-ant-[A-Za-z0-9_-]{20,}/, /sk-(proj-)?[A-Za-z0-9_-]{32,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

export function findSecrets(root: string, files: string[]): { file: string; pattern: string }[] {
  const hits: { file: string; pattern: string }[] = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(root, f));
    if (buf.length > 5_000_000) continue;
    const text = buf.toString('utf8');
    for (const re of SECRET_PATTERNS) if (re.test(text)) hits.push({ file: f, pattern: re.source.slice(0, 20) });
  }
  return hits;
}
