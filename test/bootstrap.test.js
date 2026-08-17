import test from 'node:test';
import assert from 'node:assert/strict';

import { ratioCI } from '../src/stats/bootstrap.js';

const S = { a: 0.18, b: 0.20, c: 0.16, d: 0.19, e: 0.17, f: 0.21 };
const H = { a: 0.17, b: 0.18, c: 0.16, d: 0.18, e: 0.16, f: 0.19 };

test('the point estimate sits inside its own interval', () => {
  const r = ratioCI(S, H, { trials: 500 });
  assert.ok(r.lo <= r.ratio && r.ratio <= r.hi, `${r.lo} ≤ ${r.ratio} ≤ ${r.hi}`);
  assert.equal(r.cells, 6);
});

test('same seed reproduces exactly', () => {
  const a = ratioCI(S, H, { trials: 300, seed: 11 });
  const b = ratioCI(S, H, { trials: 300, seed: 11 });
  assert.deepEqual(a, b);
});

test('a wider spread gives a wider interval', () => {
  // The whole point of reporting the interval: 1.05 from six tight cells and 1.05 from
  // six scattered ones are not the same claim.
  const tight = ratioCI(S, H, { trials: 800, seed: 3 });
  const noisy = ratioCI({ a: 0.05, b: 0.40, c: 0.02, d: 0.55, e: 0.10, f: 0.33 }, H, { trials: 800, seed: 3 });
  assert.ok((noisy.hi - noisy.lo) > (tight.hi - tight.lo));
});

test('a near-1 ratio stays near 1', () => {
  const r = ratioCI(S, H, { trials: 800, seed: 42 });
  assert.ok(r.ratio > 1 && r.ratio < 1.15, `ratio ${r.ratio}`);
  assert.ok(r.hi < 1.5, 'and its upper bound clears the 1.5 consistency bar');
});

test('cells missing from either side are ignored, not counted as zero', () => {
  const r = ratioCI({ ...S, g: 0.2 }, H, { trials: 200 });
  assert.equal(r.cells, 6, 'a cell with no harness measurement cannot contribute a ratio');
});

test('no overlapping cells yields NaN rather than a fabricated number', () => {
  const r = ratioCI({ x: 0.1 }, { y: 0.1 }, { trials: 100 });
  assert.ok(Number.isNaN(r.ratio));
  assert.equal(r.cells, 0);
});

test('a gap over an all-zero denominator is unbounded, never a finite number', () => {
  // A harness measured at zero explains nothing, so a subject that still differs has an
  // unbounded ratio. These trials used to be DROPPED as "uninformative", which reads the
  // sharpest available statement — the harness cannot account for this — as missing data.
  const r = ratioCI({ a: 0.01, b: 0.01 }, { a: 0, b: 0 }, { trials: 100 });
  assert.equal(r.ratio, Infinity);
  assert.equal(r.hi, Infinity, 'the upper bound must carry it, or a consistency test would pass');
  assert.ok(!(r.hi < 1.5));
});

test('no gap over an all-zero denominator is zero, not unjudgeable', () => {
  // 🔴 The other half, and the reason dropping was not a safe default: with a fully
  // deterministic reference the noise floor is exactly zero, so a PERFECT match had every
  // trial dropped, an empty interval, and could never be judged consistent.
  const r = ratioCI({ a: 0, b: 0 }, { a: 0, b: 0 }, { trials: 100 });
  assert.equal(r.ratio, 0);
  assert.equal(r.hi, 0);
});

test('Infinity and finite ratios sort together', () => {
  // 🔴 `(a, b) => a - b` returns NaN for Infinity - Infinity, Array.sort is then free to
  // do anything, and the interval came back [0, 0] — a subject differing in four of six
  // cells was judged CONSISTENT off that.
  const r = ratioCI({ a: 0.5, b: 0.5, c: 0.5, d: 0, e: 0, f: 0 }, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 },
    { trials: 500 });
  assert.ok(r.lo <= r.hi, `interval must not be inverted: [${r.lo}, ${r.hi}]`);
  assert.equal(r.hi, Infinity, 'the upper bound is reached by every trial that draws a differing cell');
});

test('the bootstrap corrects each draw by the cells that draw took', () => {
  // 🔴 A draw re-weights the cells, so its numerator and denominator are averages over that
  // draw — subtracting a whole-group scalar calibrates it against a different set than it
  // measured. It matters when the correction is uneven: twenty cells at bias 0.040 and
  // twenty at 0 average 0.020, so every draw computed 0.059/(0.100−0.020) = 0.7375 and the
  // lower bound sat exactly on the point estimate, convicting. Resampled properly the 5%
  // tail draws about fifteen high-bias cells and lands near 0.694, which does not.
  const cells = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const s = Object.fromEntries(cells.map((c) => [c, 0.059]));
  const d = Object.fromEntries(cells.map((c) => [c, 0.100]));
  // Half the cells carry all of D's bias.
  const denByCell = Object.fromEntries(cells.map((c, i) => [c, i < 20 ? 0.040 : 0]));
  const scalar = 0.020;

  const perDraw = ratioCI(s, d, { correctBy: 0, correctDen: denByCell, denomFloor: 0 });
  const grouped = ratioCI(s, d, { correctBy: 0, correctDen: scalar, denomFloor: 0 });

  assert.ok(Math.abs(perDraw.ratio - grouped.ratio) < 1e-9,
    'the point estimate is over every cell, so the two agree there');
  assert.equal(grouped.lo, grouped.hi,
    'with a scalar correction and identical cells the interval collapses onto the point');
  assert.ok(perDraw.lo < grouped.lo,
    `resampling the correction has to widen the interval downward ` +
    `(per-draw ${perDraw.lo} vs grouped ${grouped.lo})`);
});

test('the denominator FLOOR follows the draw too, not just the corrections', () => {
  // 🔴 It is a resolution limit rather than a bias, which is why it was left a scalar — and
  // that reasoning is wrong for exactly the reason the corrections' was: a resolution limit
  // is still a property of CELLS. A draw that happens to take the two noisy cells out of
  // forty cannot resolve what the battery average says it can. Codex's construction: two
  // cells at floor 0.5 and thirty-eight at 0 puts S/D's lower bound at 0.72 with a group
  // floor — over the accusation line — and at 0.532 when re-floored per draw.
  const cells = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const noisy = new Set(['c0', 'c1']);
  const s = Object.fromEntries(cells.map((c) => [c, noisy.has(c) ? 0 : 0.038]));
  const d = Object.fromEntries(cells.map((c) => [c, noisy.has(c) ? 0 : 0.038 / 0.72]));
  const floorByCell = Object.fromEntries(cells.map((c) => [c, noisy.has(c) ? 0.5 : 0]));
  const groupFloor = 2 * 0.5 / 40;

  const perDraw = ratioCI(s, d, { correctBy: 0, denomFloor: floorByCell });
  const grouped = ratioCI(s, d, { correctBy: 0, denomFloor: groupFloor });
  assert.ok(perDraw.lo < grouped.lo,
    `a draw that takes the noisy cells must widen the bound downward ` +
    `(per-draw ${perDraw.lo} vs grouped ${grouped.lo})`);
  assert.ok(grouped.lo >= 0.7 && perDraw.lo < 0.7,
    `the difference has to straddle the accusation line to matter ` +
    `(grouped ${grouped.lo}, per-draw ${perDraw.lo})`);
});

test('a per-cell map must cover every cell being compared', () => {
  // 🔴 Filling a gap with 0 is the same mistake as reading an unmeasurable floor as zero,
  // one layer down: two cells and a map naming only one halves the correction, and a halved
  // correction can carry a ratio across the line. A caller that cannot state a cell's
  // correction has to say so rather than omit it.
  const s = { a: 0.10, b: 0.10 };
  const d = { a: 0.20, b: 0.20 };
  assert.throws(() => ratioCI(s, d, { correctBy: { a: 0.06 } }), /correctBy/);
  assert.throws(() => ratioCI(s, d, { correctBy: 0, correctDen: { a: 0.06 } }), /correctDen/);
  assert.throws(() => ratioCI(s, d, { correctBy: 0, denomFloor: { a: 0.06 } }), /denomFloor/);
  // A complete map is fine, and so is the scalar form.
  assert.doesNotThrow(() => ratioCI(s, d, { correctBy: { a: 0.06, b: 0.06 } }));
  assert.doesNotThrow(() => ratioCI(s, d, { correctBy: 0.06 }));
  // NaN counts as missing: an unknown correction is not a zero one.
  assert.throws(() => ratioCI(s, d, { correctBy: { a: 0.06, b: NaN } }), /correctBy/);
});
