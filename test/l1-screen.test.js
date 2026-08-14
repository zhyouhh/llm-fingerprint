import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { selectCells, calibrateL1Thresholds } from '../src/probe/cells.js';
import { evaluateL1 } from '../src/layers/l1-screen.js';
import { makeSample, VERDICT, L1_LOGICAL_SAMPLES } from '../src/contracts.js';
import { mulberry32, drawWithReplacement } from '../src/lib/rng.js';

// 🔴 A FROZEN copy, not reference/. These tests pin exact values to lock the
// calculation pipeline — thresholds are asserted with ===, no tolerance — and
// reference/ is expected to be re-collected whenever the endpoint warrants it.
// Pointing them at the live file would mean every legitimate refresh breaks the
// regression suite, and a suite that breaks for legitimate reasons gets muted.
const load = (m) => JSON.parse(readFileSync(new URL(`./fixtures/reference/genuine-${m}.json`, import.meta.url), 'utf8'));
const sol = load('gpt-5.6-sol');
const g54 = load('gpt-5.4');

const selection = selectCells(sol, g54, { tier: 'l1' });
const calibration = calibrateL1Thresholds(sol, g54, selection);

function poolOf(ref) {
  const out = {};
  for (const s of ref.samples) if (s.answer_class === 'valid') (out[s.cell] ??= []).push(String(s.normalized));
  return out;
}

/**
 * 🔴 Pre-generated from a pinned seed, never drawn at test time. T_pass is the 99th
 * percentile, so by definition ~1% of genuine screens exceed it — a test that resampled
 * live would go red about once in a hundred runs for no reason at all, and a flaky
 * safety net gets muted rather than fixed.
 */
function screenFrom(pools, seed) {
  const rng = mulberry32(seed);
  const samples = [];
  for (const c of selection.cells) {
    for (const value of drawWithReplacement(pools[c.cell], selection.repsPerCell, rng)) {
      samples.push(makeSample({
        kind: 'fingerprint', state: 'valid', attempts: 1,
        task_id: c.task_id, lang: c.lang, normalized: value, answer_class: 'valid',
      }));
    }
  }
  return samples;
}

test('the thresholds reproduce the calibrated values exactly', () => {
  // Asserted with ===, no tolerance. The knobs are pinned, so the result is determined;
  // a tolerance would let "one PRNG stream per cell" (T_fail 0.3576) slip through.
  assert.equal(calibration.t_pass, 0.07997368614112692);
  assert.equal(calibration.t_fail, 0.34121235356437096);
  assert.equal(calibration.usable, true);
  assert.deepEqual(selection.cells.map((c) => c.cell),
    ['num100-random|zh', 'color-random|en', 'num100-random|en']);
  assert.equal(selection.totalReps, L1_LOGICAL_SAMPLES);
});

test('① a genuine resample is judged consistent', () => {
  const r = evaluateL1({ samples: screenFrom(poolOf(sol), 123), refSubject: sol, selection, calibration });
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  assert.equal(r.s_screen.toFixed(6), '0.040203', 'pinned: any drift in the chain moves this');
  assert.ok(r.s_screen < calibration.t_pass);
  assert.equal(r.valid_rate, 1);
  assert.equal(r.live_cells, 3);
  assert.ok(!('low_confidence' in r), 'L1 never carries the flag');
});

test('② the control model impersonating the subject is judged suspect', () => {
  const r = evaluateL1({ samples: screenFrom(poolOf(g54), 123), refSubject: sol, selection, calibration });
  assert.equal(r.verdict, VERDICT.SUSPECT);
  assert.equal(r.s_screen.toFixed(6), '0.506049');
  assert.ok(r.s_screen > calibration.t_fail);
});

test('a dead endpoint is not applicable, and never green', () => {
  // 13 of 15 lost in transport, 2 valid. Using responses as the denominator would read
  // 2/2 = 100% and wave it through.
  const samples = [
    ...Array.from({ length: 13 }, () => makeSample({
      kind: 'fingerprint', state: 'transport_failure', attempts: 3,
      task_id: 'num100-random', lang: 'zh',
    })),
    ...Array.from({ length: 2 }, () => makeSample({
      kind: 'fingerprint', state: 'valid', attempts: 1,
      task_id: 'num100-random', lang: 'zh', normalized: '7', answer_class: 'valid',
    })),
  ];
  const r = evaluateL1({ samples, refSubject: sol, selection, calibration });
  assert.equal(r.verdict, VERDICT.NOT_APPLICABLE);
  assert.equal(r.valid_rate, 2 / 15);
  assert.equal(r.s_screen, null, 'no distance is reported when the method does not apply');
});

test('an all-empty endpoint is not applicable either, and does not throw', () => {
  const samples = Array.from({ length: 15 }, () => makeSample({
    kind: 'fingerprint', state: 'empty_completion', attempts: 1,
    task_id: 'num100-random', lang: 'zh', answer_class: 'empty',
  }));
  const r = evaluateL1({ samples, refSubject: sol, selection, calibration });
  assert.equal(r.verdict, VERDICT.NOT_APPLICABLE);
  assert.equal(r.valid_rate, 0);
  assert.equal(r.response_rate, 1, 'the endpoint answered — it just said nothing usable');
});

test('one cell short of full strength is inconclusive, not a weaker verdict', () => {
  const full = screenFrom(poolOf(sol), 123);
  const short = full.slice(0, full.length - 1);   // 14 of 15: one cell now has 4
  const r = evaluateL1({ samples: short, refSubject: sol, selection, calibration });
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.match(r.reason, /calibrated/);
});

test('an unusable calibration blocks the verdict rather than reporting a bare distance', () => {
  // Same reference on both sides: every cell is dead, so there is no threshold to
  // compare against. Reporting S anyway invites eyeballing it against nothing.
  const selfSel = selectCells(sol, sol, { tier: 'l1' });
  const selfCal = calibrateL1Thresholds(sol, sol, selfSel);
  assert.equal(selfCal.usable, false);
  assert.equal(selfCal.t_pass, null);
  assert.equal(selfCal.t_fail, null);
  assert.match(selfCal.reason, /live cells/);
});
