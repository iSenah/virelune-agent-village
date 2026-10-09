// Graphics presets and the automatic quality controller. Pure data and logic (no three.js), so it is unit-tested.
// Presets change only rendering cost, never what is in the village: every building, resident, lamp, tree and
// landscape feature stays. Low thins out tiny ground detail (grass tufts, flowers) and turns shadows off.

export type PresetId = 'low' | 'medium' | 'high';
export type GraphicsChoice = PresetId | 'auto';

export type Preset = {
  id: PresetId;
  label: string;
  /** Highest render resolution, as a multiple of CSS pixels (the device's own ratio caps it further). */
  maxPixelRatio: number;
  /** Lowest resolution the adaptive scaler may drop to before giving up quality elsewhere. */
  minPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  softShadows: boolean;
  /** Share of grass tufts and flowers drawn (trees, rocks, bushes, buildings are always drawn). */
  groundDetail: number;
  /** Lantern and fountain glows. */
  glows: boolean;
  /** 0 = as fast as the display allows. */
  maxFps: number;
  description: string;
};

export const PRESETS: Record<PresetId, Preset> = {
  high: { id: 'high', label: 'High', maxPixelRatio: 1.5, minPixelRatio: 0.75, shadows: true, shadowMapSize: 2048, softShadows: true, groundDetail: 1, glows: true, maxFps: 0, description: 'Full resolution on high-density screens, soft shadows, all ground detail.' },
  medium: { id: 'medium', label: 'Medium', maxPixelRatio: 1, minPixelRatio: 0.75, shadows: true, shadowMapSize: 1024, softShadows: false, groundDetail: 0.5, glows: true, maxFps: 0, description: 'Standard resolution, sharper but cheaper shadows, half the grass tufts and flowers.' },
  low: { id: 'low', label: 'Low', maxPixelRatio: 0.75, minPixelRatio: 0.5, shadows: false, shadowMapSize: 1024, softShadows: false, groundDetail: 0, glows: true, maxFps: 30, description: 'Reduced resolution, no shadows, no grass tufts or flowers, capped at 30 fps to keep laptops cool.' },
};

export const CHOICES: { id: GraphicsChoice; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

const ORDER: PresetId[] = ['low', 'medium', 'high'];

export function parseChoice(v: unknown): GraphicsChoice {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'auto' ? v : 'auto';
}

/**
 * Auto mode: start at High; if the frame rate stays low even at the preset's lowest resolution, step down one
 * preset; if there is lots of headroom at full resolution for a long while, step back up. Steps are rare and
 * need sustained evidence, so the picture does not flicker between presets.
 */
export class AutoQuality {
  current: PresetId = 'high';
  private lowFor = 0;
  private highFor = 0;

  /**
   * Feed one measurement window (average fps and the current pixel ratio). Returns a new preset when it should
   * change, otherwise null.
   */
  observe(fps: number, pixelRatio: number, windowSeconds: number): PresetId | null {
    const p = PRESETS[this.current];
    const atFloor = pixelRatio <= p.minPixelRatio + 1e-6;
    const atCeiling = pixelRatio >= Math.min(p.maxPixelRatio, 1) - 1e-6;
    if (fps < 28 && atFloor) this.lowFor += windowSeconds;
    else this.lowFor = 0;
    if (fps > 58 && atCeiling) this.highFor += windowSeconds;
    else this.highFor = 0;
    const i = ORDER.indexOf(this.current);
    if (this.lowFor >= 4 && i > 0) {
      this.current = ORDER[i - 1];
      this.lowFor = 0;
      return this.current;
    }
    if (this.highFor >= 30 && i < ORDER.length - 1) {
      this.current = ORDER[i + 1];
      this.highFor = 0;
      return this.current;
    }
    return null;
  }
}

/** Next pixel ratio for the adaptive scaler, within the preset's range. */
export function nextPixelRatio(fps: number, current: number, preset: Preset, devicePixelRatio: number): number {
  const max = Math.min(devicePixelRatio, preset.maxPixelRatio);
  const min = Math.min(preset.minPixelRatio, max);
  if (fps < 40) return Math.max(min, current - 0.25);
  if (fps > 57) return Math.min(max, current + 0.25);
  return Math.min(max, Math.max(min, current));
}
