import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pairBias, noiseFloor, correct, validAnswersByCell } from '../src/stats/noise.js';

const ref = JSON.parse(readFileSync(new URL('../reference/chat/genuine-gpt-5.6-sol.json', import.meta.url), 'utf8'));
const byCell = validAnswersByCell(ref.samples);

test('same seed, same numbers — exactly', () => {
  // Thresholds downstream are asserted with ===. A floor that drifts between runs
  // cannot be told apart from one that drifted because the code changed.
  const a = noiseFloor(byCell, 5, { trials: 50, seed: 7 });
  const b = noiseFloor(byCell, 5, { trials: 50, seed: 7 });
  assert.deepEqual(a.byCell, b.byCell);
  assert.equal(a.overall, b.overall);
  assert.notDeepEqual(a.byCell, noiseFloor(byCell, 5, { trials: 50, seed: 8 }).byCell, 'a different seed must differ');
});

test('a deterministic cell has a floor of exactly zero', () => {
  // Every draw returns the same answer, so both halves are the same one-point
  // distribution and the JSD is 0. Anything else means the resampling is not resampling.
  const out = noiseFloor({ 'const|en': Array(30).fill('7') }, 5, { trials: 20 });
  assert.equal(out.byCell['const|en'], 0);
  assert.equal(out.overall, 0);
});

test('the floor does not rise as reps rise', () => {
  // More samples per side ⇒ each empirical distribution is closer to the truth ⇒ the
  // two sides land closer together. A floor that grew with reps would mean the
  // correction gets worse the more you spend.
  const reps = [3, 5, 10, 15];
  const floors = reps.map((r) => noiseFloor(byCell, r, { trials: 200, seed: 1 }).overall);
  for (let i = 1; i < floors.length; i++) {
    assert.ok(floors[i] <= floors[i - 1] + 1e-12,
      `reps ${reps[i]} floor ${floors[i]} should not exceed reps ${reps[i - 1]} floor ${floors[i - 1]}`);
  }
  assert.ok(floors[0] > 0, 'a real battery is not deterministic, so the floor must be positive');
});

test('the floor is large enough to matter', () => {
  // Not a style point: roughly a third of every raw cross-endpoint distance recorded on
  // this project was this artefact (H≈0.17 raw vs ≈0.11 corrected).
  const at15 = noiseFloor(byCell, 15, { trials: 200, seed: 42 }).overall;
  assert.ok(at15 > 0.01, `floor at 15 reps is ${at15}; if this collapsed to ~0 the correction is a no-op`);
});

test('correction never yields a negative distance', () => {
  assert.equal(correct(0.17, 0.056).toFixed(3), '0.114');
  assert.equal(correct(0.02, 0.056), 0, 'same-model measurements can dip below the floor');
  assert.ok(Number.isNaN(correct(NaN, 0.05)));
});

test('only valid answers feed the floor', () => {
  const samples = [
    { cell: 'a|en', normalized: '1', answer_class: 'valid' },
    { cell: 'a|en', normalized: null, answer_class: 'empty' },
    { cell: 'a|en', normalized: 'sorry', answer_class: 'refusal' },
  ];
  assert.deepEqual(validAnswersByCell(samples), { 'a|en': ['1'] });
});

test('repsPerCell must be a positive integer', () => {
  assert.throws(() => noiseFloor(byCell, 0), /positive integer/);
  assert.throws(() => noiseFloor(byCell, 2.5), /positive integer/);
});

test('the other side of the comparison is drawn at ITS OWN size', () => {
  // 🔴 The floor answers "how far apart would these two estimates land by chance", and the
  // two estimates are not symmetric: the measurement has `reps` samples in a cell, a stored
  // REFERENCE has however many its own collection banked. Drawing both at `reps` models a
  // 15-vs-15 comparison when the real one is 15-vs-30 (or 15-vs-10), and the floor is the
  // denominator every separation divides by — so getting it wrong moves verdicts in both
  // directions depending on which side is better sampled.
  const pool = Array.from({ length: 30 }, (_, i) => `a${i % 6}`);
  const cells = { 'c1|en': pool };

  const symmetric = noiseFloor(cells, 15, { trials: 400 }).overall;
  const againstPool = noiseFloor(cells, 15, { trials: 400, against: 'pool' }).overall;
  assert.ok(againstPool < symmetric,
    `a 30-sample reference resolves better than another 15-sample run ` +
    `(15/30 ${againstPool} should be under 15/15 ${symmetric})`);

  // And the other direction, on the SAME pool so only the counts vary: a reference thinner
  // than the run widens the floor rather than narrowing it.
  const sameCounts = noiseFloor(cells, 10, { trials: 400 }).overall;
  const fifteenVsTen = noiseFloor(cells, 15, { trials: 400, against: 10 }).overall;
  assert.ok(fifteenVsTen < sameCounts,
    '15-vs-10 must be tighter than 10-vs-10, and wider than 15-vs-15');
  assert.ok(fifteenVsTen > symmetric);

  // 'self' is the default and must stay bit-identical to the original behaviour.
  assert.equal(noiseFloor(cells, 15, { trials: 400, against: 'self' }).overall, symmetric);
});

test('pairBias is the CROSS-model bias, and never a bonus', () => {
  // 🔴 Not a noise floor. The floor answers "how far apart do two samples of the SAME
  // distribution land", true value zero, so all of it is bias. A cross-model distance has a
  // large true value and a small bias on top: P = {a:1} against Q = {a:25/30, b:5/30} at
  // thirty a side has a true JSD of 0.0888 and a bias of ~0.0010, while Q's own floor is
  // ~0.0134 — fourteen times too much. D is a DENOMINATOR, so over-subtracting shrinks it
  // and pushes S/D toward the accusation line: the error runs the unsafe way.
  const P = Array.from({ length: 30 }, () => 'a');
  const Q = Array.from({ length: 30 }, (_, i) => (i < 25 ? 'a' : 'b'));

  const cross = pairBias({ c: P }, { c: Q }, 30, 30, { trials: 4000 }).overall;
  const floorQ = noiseFloor({ c: Q }, 30, { trials: 4000 }).overall;
  assert.ok(cross > 0 && cross < 0.005, `the cross-model bias is small, got ${cross}`);
  assert.ok(floorQ > cross * 5,
    `a same-model floor (${floorQ}) is a wildly different number from the cross bias (${cross})`);

  // Same pool on both sides → the true distance is zero → this IS the noise floor, bit for bit.
  assert.equal(pairBias({ c: Q }, { c: Q }, 30, 30, { trials: 4000 }).overall,
    noiseFloor({ c: Q }, 30, { trials: 4000 }).overall,
    'it must reduce to the noise floor when both sides are the same distribution');

  // 🔴 Never negative. Monte-Carlo scatter CAN put the mean a hair under the truth — this
  // fixture does it at the default seed — and an unclamped negative would be a correction
  // that ADDS to the distance it exists to shrink. D is a denominator, so that inflates it,
  // which is the safe direction by luck rather than by design; the numerator gets the same
  // treatment and there it is not safe at all.
  const bigP = Array.from({ length: 60 }, () => 'a');
  const bigQ = Array.from({ length: 60 }, (_, i) => (i < 1 ? 'a' : 'b'));
  const jittery = pairBias({ c: bigP }, { c: bigQ }, 60, 60, { trials: 10 });
  assert.equal(jittery.overall, 0,
    `raw bias here is about -0.00017, so the clamp is what makes this 0 (got ${jittery.overall})`);

  // Two deterministic disjoint pools cannot vary at all: exactly zero, clamp or no clamp.
  const far = pairBias({ c: P }, { c: Array.from({ length: 30 }, () => 'z') }, 30, 30, { trials: 200 });
  assert.equal(far.overall, 0, 'two deterministic disjoint pools have no sampling bias at all');
});

test('pairBias is symmetric bit for bit, not merely in expectation', () => {
  // 🔴 The quantity cannot depend on which side the caller names first — swapping
  // (pool, reps) together leaves the true bias untouched. One RNG stream broke that at
  // finite trials by handing the two sides different segments. Measured before the fix:
  // P={a:1} against Q={a:25/30,b:5/30} at 15-vs-10 gave 0.006417 one way and 0.002783 the
  // other, and with D = 0.100 and a corrected S of 0.067 that is S/D 0.716 versus 0.689 —
  // SUSPECT decided by which of two models the endpoint happened to be selling.
  const cells = ['c1', 'c2', 'c3'];
  const P = Array.from({ length: 30 }, () => 'a');
  const Q = Array.from({ length: 30 }, (_, i) => (i < 25 ? 'a' : 'b'));
  const pools = (pool) => Object.fromEntries(cells.map((c) => [c, pool]));
  const reps = (n) => Object.fromEntries(cells.map((c) => [c, n]));

  const ab = pairBias(pools(P), pools(Q), reps(15), reps(10));
  const ba = pairBias(pools(Q), pools(P), reps(10), reps(15));
  assert.equal(ab.overall, ba.overall, 'the two directions must be the same number');
  assert.deepEqual(ab.byCell, ba.byCell, 'and the same per cell');
  assert.ok(ab.overall > 0, 'the fixture must produce a real bias, or symmetry is trivial');

  // Asymmetric counts must still matter — the fix must not have made the two sides
  // interchangeable in a way that ignores how much each side was sampled.
  assert.notEqual(pairBias(pools(P), pools(Q), reps(15), reps(10)).overall,
    pairBias(pools(P), pools(Q), reps(30), reps(30)).overall,
    'sample counts still change the estimate');
});

test('the canonical key is unambiguous, not merely unlikely to collide', () => {
  // 🔴 A separator-joined key made ["z", "a<U+0001>b"] and ["z", "a", "b"] identical at the
  // same count, so the ordering fell back to argument order — the very asymmetry the key
  // exists to remove. Normalised answers are not screened for control characters, so both
  // of those are reachable inputs, and the two directions differed at 0.01501 vs 0.01387.
  // Every single-character separator has this flaw, so the fixture sweeps the plausible
  // ones rather than pinning the one that happened to ship. A pool answer containing the
  // separator makes ["z", "a<sep>b"] and ["z", "a", "b"] encode identically.
  for (const sep of [String.fromCharCode(1), String.fromCharCode(0), '|', '-', ',', ':']) {
    const A = { c: ['z', `a${sep}b`] };
    const B = { c: ['z', 'a', 'b'] };
    assert.equal(pairBias(A, B, 15, 15).overall, pairBias(B, A, 15, 15).overall,
      `pools that a "${sep === String.fromCharCode(0) ? 'NUL' : sep}"-joined key conflates ` +
      'must still order deterministically');
  }

  // The counts are part of the key too: same pool, different reps, must not conflate.
  const P = { c: ['a', 'a', 'b'] };
  assert.notEqual(pairBias(P, P, 15, 10).overall, pairBias(P, P, 15, 30).overall);
});
