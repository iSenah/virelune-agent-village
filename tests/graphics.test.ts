// Graphics presets and Auto quality: pure logic, no browser needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoQuality, nextPixelRatio, parseChoice, PRESETS } from '../web/src/village/graphics.ts';

test('presets only trade rendering cost, from High down to Low', () => {
  const { high, medium, low } = PRESETS;
  assert.ok(high.maxPixelRatio >= medium.maxPixelRatio && medium.maxPixelRatio >= low.maxPixelRatio);
  assert.ok(high.groundDetail >= medium.groundDetail && medium.groundDetail >= low.groundDetail);
  assert.equal(high.shadows, true);
  assert.equal(low.shadows, false);
  assert.equal(high.maxFps, 0);
  assert.equal(low.maxFps, 30);
  for (const p of Object.values(PRESETS)) assert.ok(p.description.length > 20, `${p.id} explains itself`);
});

test('unknown or missing saved choices fall back to Auto', () => {
  assert.equal(parseChoice('medium'), 'medium');
  assert.equal(parseChoice('ultra'), 'auto');
  assert.equal(parseChoice(null), 'auto');
});

test('adaptive resolution stays inside the preset range and the device limit', () => {
  assert.equal(nextPixelRatio(20, 1.5, PRESETS.high, 2), 1.25);
  assert.equal(nextPixelRatio(20, 0.75, PRESETS.high, 2), 0.75, 'never below the preset floor');
  assert.equal(nextPixelRatio(60, 1.5, PRESETS.high, 2), 1.5, 'never above the preset ceiling');
  assert.equal(nextPixelRatio(60, 1, PRESETS.high, 1), 1, 'never above the device pixel ratio');
  assert.equal(nextPixelRatio(60, 0.5, PRESETS.low, 2), 0.75);
  assert.equal(nextPixelRatio(50, 1.5, PRESETS.medium, 2), 1, 'switching to a lower preset clamps the resolution');
});

test('Auto steps down only after sustained slow frames at the lowest resolution, and back up only after a long time', () => {
  const a = new AutoQuality();
  assert.equal(a.observe(20, 1.0, 1.5), null, 'slow but resolution can still drop: no preset change');
  assert.equal(a.observe(20, 0.75, 1.5), null);
  assert.equal(a.observe(20, 0.75, 1.5), null);
  assert.equal(a.observe(20, 0.75, 1.5), 'medium', 'about 4 seconds slow at the floor');
  assert.equal(a.observe(45, 0.75, 1.5), null, 'fine frame rates do not change anything');
  for (let i = 0; i < 3; i++) a.observe(15, 0.75, 1.5);
  assert.equal(a.current, 'low');
  assert.equal(a.observe(10, 0.5, 10), null, 'never below Low');
  let up: string | null = null;
  let seconds = 0;
  for (; seconds < 40 && !up; seconds++) up = a.observe(60, 0.75, 1);
  assert.equal(up, 'medium', 'plenty of headroom on Low at its full resolution: step back up');
  assert.equal(seconds, 30, 'only after 30 seconds');
  const b = new AutoQuality();
  b.current = 'medium';
  for (let i = 0; i < 29; i++) assert.equal(b.observe(60, 1, 1), null);
  assert.equal(b.observe(60, 1, 1), 'high', '30 seconds of headroom at full resolution');
  const c = new AutoQuality();
  c.observe(20, 0.75, 2);
  c.observe(50, 0.75, 2);
  assert.equal(c.observe(20, 0.75, 2), null, 'a good window resets the count');
});
