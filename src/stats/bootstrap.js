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
 * @param {Record<string, number>} sPerCell  cell → subject cross-endpoint JSD
 * @param {Record<string, number>} hPerCell  cell → control cross-endpoint JSD (harness)
 * @param {{trials?, seed?, level?}} [opts]  level = interval coverage, default 0.90
 * @returns {{ratio: number, lo: number, hi: number, cells: number, trials: number}}
 */
export function ratioCI(sPerCell, hPerCell, { trials = DEFAULT_TRIALS, seed = DEFAULT_SEED, level = 0.90 } = {}) {
  const cells = Object.keys(sPerCell).filter((c) => Number.isFinite(sPerCell[c]) && Number.isFinite(hPerCell?.[c])).sort();
  const n = cells.length;
  if (n === 0) return { ratio: NaN, lo: NaN, hi: NaN, cells: 0, trials: 0 };

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const point = mean(cells.map((c) => sPerCell[c])) / mean(cells.map((c) => hPerCell[c]));

  const rng = mulberry32(seed);
  const ratios = [];
  for (let t = 0; t < trials; t++) {
    let sSum = 0;
    let hSum = 0;
    for (let i = 0; i < n; i++) {
      const cell = cells[Math.floor(rng() * n)];
      sSum += sPerCell[cell];
      hSum += hPerCell[cell];
    }
    // hSum can be 0 when the control model is identical on both sides in every drawn
    // cell. That trial carries no information about the ratio, so it is dropped rather
    // than contributing an Infinity that would swallow the upper bound.
    if (hSum > 0) ratios.push(sSum / hSum);
  }
  ratios.sort((a, b) => a - b);

  const tail = (1 - level) / 2;
  return {
    ratio: point,
    lo: percentile(ratios, tail),
    hi: percentile(ratios, 1 - tail),
    cells: n,
    trials: ratios.length,
  };
}
