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
 * 90% cluster bootstrap over CELLS for a ratio of two per-cell means.
 *
 * @param {object} sPerCell  numerator, cell → value
 * @param {object} dPerCell  denominator, cell → value
 * @param {object} [opts]
 * @param {number|object} [opts.correctBy]  sampling bias removed from the NUMERATOR. A
 *   number, or a cell → value map, in which case each bootstrap draw averages it over the
 *   cells it drew — the correction is a property of cells, so a draw that re-weights them
 *   re-weights it too. A map must cover every cell being compared; a gap is an error, not
 *   a zero.
 * @param {number|object|null} [opts.correctDen]  sampling bias removed from the DENOMINATOR,
 *   number or per-cell map, same rules as `correctBy`.
 *   Defaults to `correctBy`, which is right only when both sides are the same kind of
 *   comparison. They often are not: S is a measurement against a stored reference and D,
 *   when a control was sampled, is one measurement against another — different sample
 *   counts, and in D's case a cross-model bias rather than a same-model floor. Left as one
 *   number, the two silently rescale each other.
 * @param {number|object} [opts.denomFloor]  the smallest denominator to divide by, number
 *   or per-cell map — a resolution limit is a property of cells too, so it follows the draw
 *   like the corrections do. NOT the same
 *   question as `correctDen`: this one asks "is the gap inside what the MEASUREMENT can
 *   resolve", so it is the numerator side's floor. Setting it to the denominator's own
 *   floor lets a denominator that cannot vary reach zero, and the ratio goes to Infinity.
 */
export function ratioCI(sPerCell, dPerCell, {
  trials = DEFAULT_TRIALS, seed = DEFAULT_SEED, level = 0.90, correctBy = 0,
  // 🔴 The denominator may need a DIFFERENT correction from the numerator, because the two
  // are not the same comparison. S is a measurement against a stored reference; D, when a
  // control was sampled, is one measurement against another. Their resolution limits differ
  // — one is 15-vs-30, the other 15-vs-15 — and subtracting the same number from both
  // silently rescales the ratio. Defaults to `correctBy`, so a caller with one floor keeps
  // the old behaviour bit for bit.
  correctDen = null, denomFloor = 0,
} = {}) {
  const correctD = correctDen ?? correctBy;
  if (correctD == null) throw new Error('ratioCI: correctDen resolved to null');
  const cells = Object.keys(sPerCell).filter((c) => Number.isFinite(sPerCell[c]) && Number.isFinite(dPerCell?.[c])).sort();
  const n = cells.length;
  if (n === 0) return { ratio: NaN, lo: NaN, hi: NaN, cells: 0, trials: 0 };

  // One statistic, used for both the point estimate and every resample — the two cannot
  // drift apart because there is only one definition.
  // 🔴 The corrections follow the DRAWN cells, not the whole set. A bootstrap draw
  // re-weights the cells, so its numerator and denominator are averages over that draw —
  // and subtracting a whole-group scalar from them calibrates the draw against a different
  // set of cells than it measured. Same defect, same shape, as the run-wide floor the
  // identification bootstrap used to divide by. It matters when the bias is uneven across
  // cells: twenty cells at bias 0.040 and twenty at 0, group mean 0.020, gives every draw
  // 0.059/(0.100−0.020) = 0.7375 and a lower bound at 0.7375 — convicting. Resampled
  // properly the 5% tail draws about fifteen high-bias cells, 0.059/(0.100−0.015) ≈ 0.694,
  // and does not.
  const perCell = (v) => (typeof v === 'number' || v == null ? null : v);
  const numMap = perCell(correctBy);
  const denMap = perCell(correctD);
  // 🔴 …and the floor under the denominator follows the draw too. It is a resolution limit
  // rather than a bias, which is why it was left as a scalar — but a resolution limit is
  // still a property of CELLS, and a draw that happens to take the two noisy cells of forty
  // cannot resolve what the battery average says it can. Measured: two cells at floor 0.5
  // and thirty-eight at 0 give a group floor that puts S/D's lower bound at 0.72 and
  // convicts, where re-floored per draw it is 0.532 and does not. Same shape as the
  // corrections, one line apart, and I nearly shipped the reasoning for keeping it.
  const floorMap = perCell(denomFloor);
  // 🔴 Every participating cell must have a value. Filling a gap with 0 is the same mistake
  // as reading an unmeasurable floor as zero, one layer down: two cells and a map naming
  // only one of them silently halves the correction, which can carry a ratio across the
  // line. A caller that cannot state a cell's correction has to say so, not omit it.
  for (const [name, map] of [['correctBy', numMap], ['correctDen', denMap], ['denomFloor', floorMap]]) {
    if (!map) continue;
    const missing = cells.filter((c) => !Number.isFinite(map[c]));
    if (missing.length) {
      throw new Error(`ratioCI: ${name} is a per-cell map missing ${missing.length} of the ` +
        `${cells.length} cells being compared (${missing.slice(0, 3).join(', ')}…). A gap ` +
        `would be filled with 0, which reads "no correction here" — say it explicitly.`);
    }
  }
  const meanOver = (map, drawn) => {
    let t = 0;
    for (const c of drawn) t += map[c];
    return t / drawn.length;
  };
  const stat = (drawn) => {
    let sSum = 0;
    let dSum = 0;
    for (const c of drawn) { sSum += sPerCell[c]; dSum += dPerCell[c]; }
    const cNum = numMap ? meanOver(numMap, drawn) : correctBy;
    const cDen = denMap ? meanOver(denMap, drawn) : correctD;
    const cFloor = floorMap ? meanOver(floorMap, drawn) : denomFloor;
    const num = Math.max(0, sSum / drawn.length - cNum);
    const den = Math.max(Math.max(0, dSum / drawn.length - cDen), cFloor);
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
