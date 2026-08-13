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

test('an all-zero harness does not produce Infinity', () => {
  // Self-comparison drives H to zero; a trial that draws only zero-harness cells has
  // nothing to say about the ratio and must be dropped, not turned into Infinity.
  const r = ratioCI({ a: 0.01, b: 0.01 }, { a: 0, b: 0 }, { trials: 100 });
  assert.equal(r.trials, 0, 'every trial was uninformative');
  assert.ok(!Number.isFinite(r.lo) || Number.isNaN(r.lo));
});
