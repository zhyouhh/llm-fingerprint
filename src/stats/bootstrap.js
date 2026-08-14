// Confidence interval for the S/H ratio.
//
// The L2 verdict turns on whether S is within 1.5× of H. With six cells behind each of
// them, a point estimate of 1.05 and one of 1.45 can easily be the same underlying
// truth — reporting the interval is what keeps "consistent" from being read as
// certainty it never had.
//
// Resampled over CELLS, not over samples: the cells are the independent units here
// (each contributes one JSD), and the per-cell distances are what the verdict averages.

import { mulberry32, percentile } from '../lib/rng.js';

export const DEFAULT_TRIALS = 1000;
export const DEFAULT_SEED = 42;

/**
 * 🔴 `correctBy` and `denomFloor` exist so the interval describes THE SAME QUANTITY the
 * verdict tests. They used to describe a different one: the verdict compared corrected
 * means (S_c ≤ 1.5 × H_c) while the interval was built from raw per-cell values, so a run
 * could print "S/H = 1.94" while the test it fed was evaluating 20.8. Whoever read the
 * report was reading a number no decision was made on.
 *
 * @param {Record<string, number>} sPerCell  cell → subject cross-endpoint JSD
 * @param {Record<string, number>} dPerCell  cell → denominator JSD (harness H, or scale D)
 * @param {{trials?, seed?, level?, correctBy?, denomFloor?}} [opts]
 *   level      interval coverage, default 0.90
 *   correctBy  noise floor subtracted from both means, matching stats/noise.correct
 *   denomFloor smallest denominator the measurement can resolve; below it the ratio is
 *              not a statement about the harness, so the floor stands in for it
 * @returns {{ratio: number, lo: number, hi: number, cells: number, trials: number}}
 */
export function ratioCI(sPerCell, dPerCell, {
  trials = DEFAULT_TRIALS, seed = DEFAULT_SEED, level = 0.90, correctBy = 0, denomFloor = 0,
} = {}) {
  const cells = Object.keys(sPerCell).filter((c) => Number.isFinite(sPerCell[c]) && Number.isFinite(dPerCell?.[c])).sort();
  const n = cells.length;
  if (n === 0) return { ratio: NaN, lo: NaN, hi: NaN, cells: 0, trials: 0 };

  // One statistic, used for both the point estimate and every resample — the two cannot
  // drift apart because there is only one definition.
  const stat = (drawn) => {
    let sSum = 0;
    let dSum = 0;
    for (const c of drawn) { sSum += sPerCell[c]; dSum += dPerCell[c]; }
    const num = Math.max(0, sSum / drawn.length - correctBy);
    const den = Math.max(Math.max(0, dSum / drawn.length - correctBy), denomFloor);
    // 🔴 0/0 is not missing data here, it is the sharpest possible answer: nothing to
    // explain on either side. Returning NaN made it unjudgeable, and that regime is real
    // — a reference pool of thirty identical answers has a noise floor of exactly zero,
    // which this project has already produced twice. A positive gap over a zero
    // denominator is the opposite extreme and must reach the upper bound, not be dropped.
    if (num === 0) return 0;
    if (den === 0) return Infinity;
    return num / den;
  };

  const point = stat(cells);

  const rng = mulberry32(seed);
  const ratios = [];
  const drawn = new Array(n);
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < n; i++) drawn[i] = cells[Math.floor(rng() * n)];
    // Without a denomFloor the denominator can come out 0 — the control model identical
    // on both sides in every drawn cell. That trial says nothing about the ratio, so it
    // is dropped rather than contributing an Infinity that swallows the upper bound.
    const r = stat(drawn);
    if (!Number.isNaN(r)) ratios.push(r);
  }
  // 🔴 Not `(a, b) => a - b`. Infinity - Infinity is NaN, a comparator that returns NaN
  // leaves Array.sort with undefined behaviour, and the interval comes out of the shuffle
  // reading [0.00, 0.00] — which turned "four of six cells answer differently" into a
  // CONSISTENT verdict. The most dangerous output this tool can produce, from a
  // subtraction.
  ratios.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const tail = (1 - level) / 2;
  return {
    ratio: point,
    lo: percentile(ratios, tail),
    hi: percentile(ratios, 1 - tail),
    cells: n,
    trials: ratios.length,
  };
}
