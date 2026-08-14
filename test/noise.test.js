import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { noiseFloor, correct, validAnswersByCell } from '../src/stats/noise.js';

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
