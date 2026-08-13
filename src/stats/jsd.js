// Jensen-Shannon divergence between two answer distributions.
//
// Logic vendored from upstream `stats/03-divergence.js` (MIT). Base-2 logarithm, so
// the value is bounded [0, 1]: 0 = identical distributions, 1 = disjoint support.
// Changing the base silently rescales every threshold in the project.

/** Minimum valid samples for a cell to enter a distance. Upstream constant. */
export const MIN_N = 10;

/**
 * @param {Record<string, number>} p probability mass keyed by canonical answer
 * @param {Record<string, number>} q
 * @returns {number} JSD in bits, in [0, 1]
 */
export function jsd(p, q) {
  const support = new Set([...Object.keys(p), ...Object.keys(q)]);
  let d = 0;
  for (const x of support) {
    const px = p[x] ?? 0, qx = q[x] ?? 0, mx = (px + qx) / 2;
    if (px > 0) d += 0.5 * px * Math.log2(px / mx);
    if (qx > 0) d += 0.5 * qx * Math.log2(qx / mx);
  }
  return d;
}

/**
 * Mean JSD across the cells both fingerprints cover.
 *
 * @param {Record<string, Record<string, number>>} a cell key -> distribution
 * @param {Record<string, Record<string, number>>} b
 * @returns {{mean: number, cells: number}} cells = how many cells contributed
 */
export function meanJsd(a, b) {
  let sum = 0, cells = 0;
  for (const cell of Object.keys(a)) {
    if (!b[cell]) continue;
    sum += jsd(a[cell], b[cell]);
    cells++;
  }
  return { mean: cells ? sum / cells : NaN, cells };
}

/**
 * Counts -> probability distribution, or null when the cell is too thin to trust.
 *
 * @param {Record<string, number>} counts
 * @param {number} minN
 */
export function toDist(counts, minN) {
  // I-14: no default. With one, L1's five-sample cells silently return null against
  // the paper's MIN_N of 10 — no error, no cell, no verdict, and nothing to look at.
  if (!Number.isInteger(minN) || minN < 1) {
    throw new Error(`toDist(counts, minN): minN is required (L1 passes its reps, L2 passes ${MIN_N})`);
  }
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  if (n < minN) return null;
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / n]));
}
