import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Village } from '../server/lib/app.ts';
import { loadConfig, PROJECT_ROOT } from '../server/lib/config.ts';
import type { Registries } from '../server/lib/registry.ts';

export function tmpDir(prefix = 'virelune-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeVillage(opts: { registries?: Registries; isResidentActive?: (id: string) => boolean; approvalTimeoutMs?: number; env?: Record<string, string | undefined> } = {}) {
  const dataDir = tmpDir();
  const config = loadConfig({ dataDir, dbPath: path.join(dataDir, 'village.db'), layoutFile: path.join(dataDir, 'layout.json'), port: 0, machineName: 'test-machine', env: opts.env ?? { PATH: process.env.PATH } }, PROJECT_ROOT);
  const village = new Village(config, opts);
  village.start();
  return { village, dataDir, config };
}

export const FIXTURE_SERVER = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'fixture-mcp-server.ts');
