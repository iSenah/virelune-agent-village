// SQLite through Node's built-in node:sqlite module: no native add-ons to compile on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: core tables
  `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    task_id TEXT,
    run_id TEXT,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  );
  CREATE INDEX events_type ON events(type);
  CREATE INDEX events_task ON events(task_id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    assignee TEXT,
    project TEXT,
    status TEXT NOT NULL,
    waiting_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE task_deps (
    task_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on)
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    resident TEXT,
    task_id TEXT,
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE leases (
    tool_server TEXT PRIMARY KEY,
    resident TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
  // 2: resident conversations
  `
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    resident TEXT NOT NULL,
    thread TEXT NOT NULL DEFAULT 'main',
    role TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    run_id TEXT,
    reply_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX chat_messages_resident ON chat_messages(resident, thread);
  CREATE TABLE chat_threads (
    resident TEXT NOT NULL,
    thread TEXT NOT NULL,
    runtime_state TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (resident, thread)
  );
  `,
];

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
