// Shared village layout: hand-placed decoration settings such as lamp-post rotations.
// Purely cosmetic. It is kept in the repo (config/layout/village.json) so both machines show the same village,
// and it never affects residents, tasks or permissions.
import fs from 'node:fs';
import path from 'node:path';

export type VillageLayout = { version: 1; lamps: Record<string, { rotation: number }> };

const LAMP_ID = /^[a-z0-9][a-z0-9:-]{0,63}$/;
const MAX_LAMPS = 500;

export class LayoutError extends Error {}

export class LayoutStore {
  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): VillageLayout {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const lamps: VillageLayout['lamps'] = {};
      for (const [id, v] of Object.entries(raw?.lamps ?? {})) {
        const rot = Number((v as any)?.rotation);
        if (LAMP_ID.test(id) && Number.isFinite(rot)) lamps[id] = { rotation: normalize(rot) };
      }
      return { version: 1, lamps };
    } catch {
      return { version: 1, lamps: {} };
    }
  }

  /** Set one lamp's rotation in degrees (0-359.x). `null` resets it to the village default. */
  setLampRotation(id: string, rotation: number | null): VillageLayout {
    if (typeof id !== 'string' || !LAMP_ID.test(id)) throw new LayoutError('invalid lamp id');
    if (rotation !== null && (typeof rotation !== 'number' || !Number.isFinite(rotation))) throw new LayoutError('rotation must be a number of degrees, or null to reset');
    const layout = this.read();
    if (rotation === null) delete layout.lamps[id];
    else {
      if (!(id in layout.lamps) && Object.keys(layout.lamps).length >= MAX_LAMPS) throw new LayoutError('too many lamps');
      layout.lamps[id] = { rotation: normalize(rotation) };
    }
    const sorted: VillageLayout = { version: 1, lamps: Object.fromEntries(Object.entries(layout.lamps).sort(([a], [b]) => a.localeCompare(b))) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    return sorted;
  }
}

function normalize(deg: number): number {
  return Math.round((((deg % 360) + 360) % 360) * 10) / 10;
}
