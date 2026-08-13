// Deterministic PRNG.
//
// Every resampling result in this project has to be reproducible byte for byte:
// thresholds get asserted with `===`, and a value that drifts between runs cannot be
// told apart from a value that drifted because the code changed.
//
// mulberry32 — small, fast, and good enough for resampling (it is not cryptographic and
// must never be used as if it were).

/**
 * @param {number} seed 32-bit integer
 * @returns {() => number} successive values in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `k` items WITH replacement. */
export function drawWithReplacement(pool, k, rng) {
  const out = new Array(k);
  for (let i = 0; i < k; i++) out[i] = pool[Math.floor(rng() * pool.length)];
  return out;
}

/** Empirical distribution of a list of canonical answers. */
export function empiricalDist(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  const dist = {};
  for (const [k, n] of Object.entries(counts)) dist[k] = n / values.length;
  return dist;
}

/**
 * Nearest-rank percentile: `sorted[ceil(n·p) − 1]`.
 *
 * 🔴 Not interpolated. On a discrete resampling distribution interpolation invents a
 * threshold that no trial produced, and thresholds here are asserted exactly.
 */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return NaN;
  const rank = Math.ceil(sortedAsc.length * p);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}
