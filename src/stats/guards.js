// Gate rules — the only thing standing between a broken endpoint and a green light.
//
// 🔴 The per-cell threshold DIFFERS BY LAYER, and hard-coding MIN_N = 10 here would be
// silently fatal for L1: it collects five samples per cell, so a 10-sample bar drops
// every cell, leaves zero live cells, and L1 returns `inconclusive` forever without
// anything looking wrong.
//
//   L2 → minN = 10   (the paper's threshold, required for comparability with reference/)
//   L1 → minN = 5    (its own requested reps — a FULL count, not a floor)
//
// L1 wants the full count because its thresholds were calibrated at "exactly 5 valid
// samples per cell". One sample short changes the noise, and a threshold calibrated at
// a different noise level is simply the wrong threshold. Better inconclusive than a
// green light computed at the wrong calibration.

import { VERDICT, gateFromValidRate } from '../contracts.js';
import { usageError } from '../lib/errors.js';

export { VERDICT };

/** The paper's threshold — required whenever a distance is compared with reference/. */
export const L2_MIN_N = 10;

/**
 * Drop cells that did not collect enough valid samples.
 *
 * @param {Record<string, {n_valid: number}|number>} perCell
 * @param {{minN: number}} opts  🔴 mandatory: there is no safe default across layers,
 *   and a default of 10 would silently empty every L1 run.
 * @returns {{live: string[], dropped: Array<{cell: string, n_valid: number}>}}
 */
export function usableCells(perCell, { minN } = {}) {
  if (!Number.isInteger(minN) || minN < 1) {
    usageError('usableCells(): minN must be passed explicitly (L1 uses its reps, L2 uses 10)');
  }
  const live = [];
  const dropped = [];
  for (const cell of Object.keys(perCell ?? {}).sort()) {
    const entry = perCell[cell];
    const n = typeof entry === 'number' ? entry : (entry?.n_valid ?? 0);
    if (n >= minN) live.push(cell);
    else dropped.push({ cell, n_valid: n });
  }
  return { live, dropped };
}

/**
 * Apply the gates for one layer.
 *
 * @param {object} opts
 * @param {'l1'|'l2'} opts.tier
 * @param {number} opts.validRate      🔴 already computed against the LOGICAL sample
 *                                     count of that side (contracts.rates)
 * @param {number} opts.liveCells      cells that survived usableCells()
 * @param {number} opts.requestedCells how many cells this run asked for
 * @returns {{verdict: string|null, lowConfidence: boolean, reason: string|null}}
 *   `verdict: null` means "no gate tripped — go ahead and judge".
 */
export function applyGates({ tier, validRate, liveCells, requestedCells }) {
  if (tier !== 'l1' && tier !== 'l2') throw new Error(`unknown tier: ${tier}`);

  const rateGate = gateFromValidRate(validRate);
  if (rateGate === 'not_applicable') {
    return {
      verdict: VERDICT.NOT_APPLICABLE,
      lowConfidence: false,
      reason: `valid rate ${(validRate * 100).toFixed(1)}% is below 20% — the endpoint cannot produce ` +
              `single-pass completions, so the method does not apply`,
    };
  }

  // L1: all cells or nothing. Its thresholds assume three cells at five valid samples
  // each; two cells is a different measurement, not a weaker one.
  if (tier === 'l1' && liveCells < requestedCells) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      lowConfidence: false,
      reason: `only ${liveCells}/${requestedCells} cells reached full strength; L1's thresholds are ` +
              `calibrated at exactly ${requestedCells} full cells — re-run or go to L2`,
    };
  }

  // L2 averages over cells and degrades gracefully, down to a floor of three.
  if (tier === 'l2' && liveCells < 3) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      lowConfidence: false,
      reason: `only ${liveCells} live cells — fewer than three leaves the mean too thin to judge`,
    };
  }

  // 🔴 The 20–80% band flags low confidence for L2 only. L1 cannot reach it: it demands
  // five valid samples in every cell and drops any cell that falls short, so a run that
  // reaches a verdict is necessarily at 15/15. A low-confidence branch there would be
  // dead code that also implies L1 can return a wounded verdict.
  return {
    verdict: null,
    lowConfidence: tier === 'l2' && rateGate === 'low_confidence',
    reason: null,
  };
}
