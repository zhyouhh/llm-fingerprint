// G2 — verification protocol (AUC / EER).
//
// Claim under test: our JS reimplementation of upstream's R script (which uses pROC)
// produces the same verification numbers. Proof: feed it upstream's own published
// split-scores.json and compare against upstream's own published verification.json.
//
// These are the numbers the whole tool's verdict thresholds are derived from. If the
// EER is wrong, every "pass / suspicious" call the tool makes is calibrated wrong.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { auc, eer, trialScores } from '../../src/stats/verify.js';
import { UPSTREAM, requireUpstream } from '../helpers/upstream.js';

describe('G2: verification protocol matches upstream', { skip: requireUpstream() }, () => {
  let scores;      // upstream split-half trials
  let expected;    // upstream verification.json
  let trials;      // our aggregation over the full battery

  before(() => {
    scores = JSON.parse(readFileSync(path.join(UPSTREAM, 'results', 'split-scores.json'), 'utf8')).scores;
    expected = JSON.parse(readFileSync(path.join(UPSTREAM, 'results', 'verification.json'), 'utf8'));
    trials = trialScores(scores, null);
  });

  test('full battery covers 40 cells', () => {
    const cells = new Set(scores.map((s) => `${s.task_id}|${s.lang}`));
    assert.equal(cells.size, expected.n_cells);
  });

  test('genuine / impostor trial counts match', () => {
    assert.equal(trials.filter((t) => t.genuine).length, expected.full_battery.n_genuine);
    assert.equal(trials.filter((t) => !t.genuine).length, expected.full_battery.n_impostor);
  });

  test('AUC reproduces upstream to 6 decimals', () => {
    const got = auc(trials);
    assert.ok(Math.abs(got - expected.full_battery.auc) < 5e-7,
      `AUC ${got} vs upstream ${expected.full_battery.auc}`);
  });

  test('EER reproduces upstream to 5 decimals', () => {
    const got = eer(trials).eer;
    assert.ok(Math.abs(got - expected.full_battery.eer) < 5e-6,
      `EER ${got} vs upstream ${expected.full_battery.eer}`);
  });

  test('genuine trials score far below impostor trials', () => {
    const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
    const g = med(trials.filter((t) => t.genuine).map((t) => t.score));
    const i = med(trials.filter((t) => !t.genuine).map((t) => t.score));
    // Paper reports ~0.075 within-model vs ~0.489 between-model.
    assert.ok(g < 0.15, `genuine median ${g} unexpectedly high`);
    assert.ok(i > 0.40, `impostor median ${i} unexpectedly low`);
    assert.ok(i - g > 0.30, `separation ${i - g} too small`);
  });
});
