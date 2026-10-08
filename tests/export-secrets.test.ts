import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { PROJECT_ROOT, parseDotEnv } from '../server/lib/config.ts';
import { buildZip, collectFiles, findSecrets, isExcluded } from '../server/lib/zip.ts';
import { tmpDir } from './helpers.ts';

test('machine files and secrets are excluded from exports', () => {
  for (const p of ['.env', '.env.local', 'config/residents/x.local.json', 'data/village.db', 'data/runtime/codex-home/auth.json', 'node_modules/a/index.js', 'exports/old.zip', '.git/config', 'keys/server.pem', 'village.db-wal']) assert.equal(isExcluded(p), true, p);
  for (const p of ['.env.example', 'config/residents/codex.json', 'server/main.ts', 'README.md']) assert.equal(isExcluded(p), false, p);
});

test('the .gitignore covers the same machine files', () => {
  const gi = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  for (const p of ['.env', '*.local.json', 'data/', '*.db', 'node_modules/', 'exports/']) assert.ok(gi.includes(p), p);
});

test('secret scan catches real-looking keys and the repository has none', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'leak.txt'), `OPENAI_API_KEY=sk-proj-${'a'.repeat(40)}`);
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'OPENAI_API_KEY=');
  assert.deepEqual(findSecrets(dir, ['leak.txt', 'ok.txt']).map((h) => h.file), ['leak.txt']);
  assert.deepEqual(findSecrets(PROJECT_ROOT, collectFiles(PROJECT_ROOT)), []);
});

test('.env.example contains no values for credentials', () => {
  const env = parseDotEnv(fs.readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8'));
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(env[k], '', k);
});

test('ZIP export round-trips file contents', () => {
  const files = [
    { name: 'a/hello.txt', data: Buffer.from('hello village'), mtime: new Date('2026-10-08T12:00:00') },
    { name: 'b/big.bin', data: Buffer.alloc(100_000, 7), mtime: new Date('2026-10-08T12:00:00') },
  ];
  const zip = buildZip(files);
  // Parse our own central directory and inflate each entry.
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let off = zip.readUInt32LE(end + 16);
  assert.equal(count, 2);
  for (const f of files) {
    assert.equal(zip.readUInt32LE(off), 0x02014b50);
    const compSize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const localOff = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString();
    assert.equal(name, f.name);
    const lNameLen = zip.readUInt16LE(localOff + 26);
    const data = zlib.inflateRawSync(zip.subarray(localOff + 30 + lNameLen, localOff + 30 + lNameLen + compSize));
    assert.ok(data.equals(f.data));
    off += 46 + nameLen;
  }
  // If a system unzip exists, it must accept the archive too.
  const dir = tmpDir();
  const zp = path.join(dir, 't.zip');
  fs.writeFileSync(zp, zip);
  try {
    const out = execFileSync('unzip', ['-t', zp], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
});
