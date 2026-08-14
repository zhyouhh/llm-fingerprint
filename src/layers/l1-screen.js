// L1 — the cheap screen. Fifteen probes answer "is this still the same model".
//
// Only the subject is sampled; the genuine side comes from reference/, collected once.
// That is what makes it cheap enough to run often, and it is also its limit: it can say
// "this no longer matches what we stored", not "this is model X".
//
// 🔴 S_screen is compared RAW, without subtracting the noise floor. The thresholds were
// calibrated on the same raw quantity — subtracting here would be deducting the floor
// twice and would push genuine endpoints toward the amber band.

import {
  SAMPLE_KIND, VERDICT, makeCollection, makeL1Result, assertL1Result, rates,
} from '../contracts.js';
import { jsd } from '../stats/jsd.js';
import { applyGates, usableCells } from '../stats/guards.js';
import { selectCells, calibrateL1Thresholds, combineThresholds } from '../probe/cells.js';
import { runBattery } from '../probe/runner.js';
import { noiseFloor, validAnswersByCell } from '../stats/noise.js';

/**
 * Judge an already-collected screen. Pure, zero requests — so the whole decision path
 * is unit-testable without a network.
 *
 * @param {{samples: object[], refSubject: object, selection: object, calibration: object}} args
 * @returns {object} an L1 result (contracts.makeL1Result)
 */
export function evaluateL1({ samples, refSubject, selection, calibration }) {
  const logical = selection.totalReps;
  const r = rates(samples, { logicalSamples: logical });

  // Per-cell valid counts drive the gate. L1 wants its cells FULL: the thresholds were
  // calibrated at exactly `repsPerCell` valid samples per cell, and a cell one short is
  // a different measurement rather than a weaker one.
  const perCell = {};
  for (const s of samples) {
    const key = `${s.task_id}|${s.lang}`;
    perCell[key] = (perCell[key] ?? 0) + (s.state === 'valid' ? 1 : 0);
  }
  const { live, dropped } = usableCells(perCell, { minN: selection.repsPerCell });

  const gate = applyGates({
    tier: 'l1',
    validRate: r.valid_rate,
    liveCells: live.length,
    requestedCells: selection.cells.length,
  });

  const base = {
    valid_rate: r.valid_rate, response_rate: r.response_rate,
    live_cells: live.length, t_pass: calibration.t_pass, t_fail: calibration.t_fail,
  };
  if (gate.verdict) {
    return assertL1Result(makeL1Result({ ...base, verdict: gate.verdict, s_screen: null, reason: gate.reason }));
  }
  if (!calibration.usable) {
    // No usable threshold means there is nothing to compare S against. Reporting a
    // distance without one invites the reader to eyeball it, which is exactly the
    // absolute-threshold thinking the calibration exists to replace.
    return assertL1Result(makeL1Result({
      ...base, verdict: VERDICT.INCONCLUSIVE, s_screen: null,
      reason: `L1 is not usable for this model pair: ${calibration.reason}`,
    }));
  }

  // Build this run's per-cell distribution from the valid samples only.
  const counts = {};
  for (const s of samples) {
    if (s.state !== 'valid' || s.normalized == null) continue;
    const key = `${s.task_id}|${s.lang}`;
    (counts[key] ??= {})[s.normalized] = ((counts[key] ?? {})[s.normalized] ?? 0) + 1;
  }
  const perCellJsd = {};
  for (const cell of live) {
    const total = Object.values(counts[cell]).reduce((a, b) => a + b, 0);
    const dist = Object.fromEntries(Object.entries(counts[cell]).map(([k, v]) => [k, v / total]));
    perCellJsd[cell] = jsd(dist, refSubject.fingerprint[cell]);
  }
  const cellKeys = Object.keys(perCellJsd);
  const sScreen = cellKeys.reduce((sum, c) => sum + perCellJsd[c], 0) / cellKeys.length;

  // Diagnostic only — printed so a reader can see how much of S is inherent sampling
  // spread, never subtracted and never part of the comparison.
  const floor = noiseFloor(validAnswersByCell(refSubject.samples ?? []), selection.repsPerCell,
    { trials: 200 }).overall;

  let verdict;
  if (sScreen <= calibration.t_pass) verdict = VERDICT.CONSISTENT;
  else if (sScreen >= calibration.t_fail) verdict = VERDICT.SUSPECT;
  else verdict = VERDICT.INCONCLUSIVE;

  return assertL1Result(makeL1Result({
    ...base, verdict, s_screen: sScreen, noise_floor: floor,
    per_cell: perCellJsd, dropped_cells: dropped,
  }));
}

/**
 * Collect a screen and judge it.
 *
 * @returns {Promise<object>} a collection envelope whose `result` is the L1 result
 */
export async function screenL1({ probe, model, refSubject, refControl, genuineScores = [], onProgress }) {
  const selection = selectCells(refSubject, refControl, { tier: 'l1' });
  // Simulated p99, widened by what the genuine endpoint actually scores. See
  // combineThresholds for why the simulation alone is not enough.
  const calibration = combineThresholds(
    calibrateL1Thresholds(refSubject, refControl, selection), genuineScores);

  const { samples, counters, reasoningRate } = await runBattery({
    probe, model, cells: selection.cells, reps: selection.repsPerCell, role: 'subject', onProgress,
    // 🔴 false: reference/ was collected without the trace pass, and a comparison is
    // only valid between two sides normalised the same way.
    applyReasoningTrace: false,
  });

  const result = evaluateL1({ samples, refSubject, selection, calibration });

  return makeCollection({
    result: { ...result, reasoning_rate: reasoningRate },
    samples,
    meta: {
      tier: 'l1', model,
      // 🔴 The four things a recomputation needs (重跑边界). Without them the file can
      // be re-read but not re-judged at the same calibration.
      reference_version: refSubject.collected_utc ?? 'unknown',
      cells: selection.cells.map((c) => c.cell),
      reps_per_cell: selection.repsPerCell,
      t_pass: calibration.t_pass,
      t_fail: calibration.t_fail,
    },
  });
}
