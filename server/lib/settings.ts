// Village settings. Echo's autonomy: only Supervised is functional in this milestone.
import type { DB } from './db.ts';
import { tx } from './db.ts';
import type { EventLog } from './events.ts';
import { ConflictError, ValidationError } from './tasks.ts';

export type AutonomyLevel = 'supervised' | 'assisted' | 'autonomous';
export const AUTONOMY_LEVELS: { id: AutonomyLevel; label: string; available: boolean; description: string }[] = [
  { id: 'supervised', label: 'Supervised', available: true, description: 'Every plan Echo proposes waits for your approval.' },
  { id: 'assisted', label: 'Assisted', available: false, description: 'Plans within a known playbook and budget run automatically. Available after testing.' },
  { id: 'autonomous', label: 'Autonomous', available: false, description: 'Echo also re-plans after failures, within caps. Available after testing.' },
];

export class Settings {
  private db: DB;
  private events: EventLog;
  constructor(db: DB, events: EventLog) {
    this.db = db;
    this.events = events;
  }

  private read<T>(key: string, dflt: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as any;
    return r ? (JSON.parse(r.value_json) as T) : dflt;
  }

  echoAutonomy(): AutonomyLevel {
    const v = this.read<AutonomyLevel>('echo.autonomy', 'supervised');
    // Defensive: if a database from a future version stored an unavailable level, run supervised.
    return AUTONOMY_LEVELS.find((l) => l.id === v && l.available) ? v : 'supervised';
  }

  setEchoAutonomy(level: string, actor = 'human'): AutonomyLevel {
    const def = AUTONOMY_LEVELS.find((l) => l.id === level);
    if (!def) throw new ValidationError(`unknown autonomy level "${level}"`);
    if (!def.available) throw new ConflictError(`${def.label} is not available yet. It will be enabled after testing.`);
    const prev = this.echoAutonomy();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run('echo.autonomy', JSON.stringify(level));
      if (prev !== level) this.events.append({ type: 'settings.changed', actor, payload: { key: 'echo.autonomy', from: prev, to: level } });
    });
    return level as AutonomyLevel;
  }
}
