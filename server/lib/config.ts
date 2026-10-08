// Machine configuration: environment variables plus an optional git-ignored .env file.
// No hardcoded machine paths. Everything is resolved relative to the project folder or the environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type VillageConfig = {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  configDir: string;
  webDir: string;
  machineName: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
};

/** Parse a .env file (KEY=VALUE lines, # comments, optional quotes). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Real environment wins over .env, so CI and shells can override. */
export function loadEnv(root = PROJECT_ROOT, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const file = path.join(root, '.env');
  const fromFile = fs.existsSync(file) ? parseDotEnv(fs.readFileSync(file, 'utf8')) : {};
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== '') merged[k] = v;
  return merged;
}

export function loadConfig(overrides: Partial<VillageConfig> = {}, root = PROJECT_ROOT): VillageConfig {
  const env = overrides.env ?? loadEnv(root);
  const dataDirRaw = env.VILLAGE_DATA_DIR || './data';
  const dataDir = overrides.dataDir ?? (path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(root, dataDirRaw));
  const host = overrides.host ?? (env.VILLAGE_HOST || '127.0.0.1');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`VILLAGE_HOST must be a loopback address (got ${host}). The village is local-only by design.`);
  }
  return {
    host,
    port: overrides.port ?? Number(env.VILLAGE_PORT || 4317),
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'village.db'),
    configDir: overrides.configDir ?? path.join(root, 'config'),
    webDir: overrides.webDir ?? path.join(root, 'web'),
    machineName: overrides.machineName ?? (env.VILLAGE_MACHINE_NAME || os.hostname()),
    platform: process.platform,
    env,
  };
}
