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
