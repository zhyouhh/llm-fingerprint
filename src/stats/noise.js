// Noise floor: how far apart two samples of the SAME model land, purely from finite
// sampling.
//
// Why it matters: a JSD of 0.17 between two endpoints sounds like a difference until
// you know that the same model measured twice already scores 0.056. Roughly a third of
// every raw distance recorded so far was this artefact. Subtracting it is what turns
// "H ≈ 0.17, S ≈ 0.18" into the far sharper "H ≈ 0.11, S ≈ 0.12".
//
// Estimated by resampling a cell's own answers against itself: draw two independent
// batches of `repsPerCell` WITH replacement, take the JSD, average over trials. With
// replacement because that is what the real measurement does — each run draws fresh
// samples from the model's true distribution, it does not partition a fixed pool.

import { jsd } from './jsd.js';
import { mulberry32, drawWithReplacement, empiricalDist } from '../lib/rng.js';

export const DEFAULT_TRIALS = 400;
export const DEFAULT_SEED = 42;

/**
 * @param {Record<string, string[]>} samplesByCell  cell key → the cell's valid answers
 * @param {number} repsPerCell  how many samples a real run collects per cell
 * @param {{trials?: number, seed?: number}} [opts]
 * @returns {{byCell: Record<string, number>, overall: number, cells: number}}
 */
export function noiseFloor(samplesByCell, repsPerCell, {
  trials = DEFAULT_TRIALS, seed = DEFAULT_SEED,
  // What the FIRST draw is being compared against. 'self' (the default) is the original
  // symmetric question — two runs of the same measurement — and is bit-identical to before.
  // 'pool' uses each cell's own pool size, which is the right answer when the other side is
  // a stored reference: it has exactly the samples it banked, not however many this run
  // planned to collect.
  against = 'self',
} = {}) {
  // 🔴 A number, or a per-cell map. The floor answers "how far apart would two runs of THIS
  // measurement land", so the count has to be the count that cell actually got. A run that
  // planned 15 and lost five to rate limiting has a wider floor on those cells than on the
  // untouched ones, and one scalar taken from the plan understates it — which inflates every
  // ratio taken against it, in the direction of accusing. Passing a number keeps the old
  // behaviour bit for bit.
  // 🔴 The two draws may be different sizes, and for a cross-comparison they must be. The
  // floor answers "how far apart would these two estimates land by chance", and the two
  // estimates are not symmetric: the measurement has `reps` samples in a cell, the
  // REFERENCE has however many its own collection banked there. Drawing both at `reps`
  // models a 15-vs-15 comparison when the real one is 15-vs-10 — and fewer samples scatter
  // further, so it understates the floor, which is the denominator every separation is
  // divided by. Measured on a 12-cell fixture: a 15/15 floor of 0.025 gives separation 2.4
  // and names a model; the honest 15/10 floor of 0.04 gives 1.5 and withholds.
  const repsFor = typeof repsPerCell === 'number' ? () => repsPerCell : (c) => repsPerCell?.[c];
  const otherFor = (c, pool) => (against === 'self' ? repsFor(c)
    : against === 'pool' ? pool.length
      : (typeof against === 'number' ? against : against?.[c]));
  if (typeof repsPerCell !== 'number' && (repsPerCell === null || typeof repsPerCell !== 'object')) {
    throw new Error(`repsPerCell must be a positive integer or a cell→count map, got ${JSON.stringify(repsPerCell)}`);
  }
  if (typeof repsPerCell === 'number' && (!Number.isInteger(repsPerCell) || repsPerCell < 1)) {
    throw new Error(`repsPerCell must be a positive integer, got ${repsPerCell}`);
  }
  // One stream, consumed in a fixed cell order: the result must not depend on the
  // insertion order of the input object.
  const rng = mulberry32(seed);
  const cells = Object.keys(samplesByCell).sort();
  const byCell = {};

  for (const cell of cells) {
    const pool = samplesByCell[cell];
    if (!pool?.length) continue;
    const reps = repsFor(cell);
    if (!Number.isInteger(reps) || reps < 1) {
      throw new Error(`repsPerCell has no usable count for cell ${cell}, got ${JSON.stringify(reps)}`);
    }
    const other = otherFor(cell, pool);
    if (!Number.isInteger(other) || other < 1) {
      throw new Error(`noiseFloor: no usable count for the other side of cell ${cell}, ` +
        `got ${JSON.stringify(other)}`);
    }
    let sum = 0;
    for (let t = 0; t < trials; t++) {
      const a = empiricalDist(drawWithReplacement(pool, reps, rng));
      const b = empiricalDist(drawWithReplacement(pool, other, rng));
      sum += jsd(a, b);
    }
    byCell[cell] = sum / trials;
  }

  const values = Object.values(byCell);
  return {
    byCell,
    overall: values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0,
    cells: values.length,
  };
}

/**
 * Subtract the floor from a raw mean distance.
 *
 * Clamped at 0: a corrected value can legitimately come out slightly negative when the
 * two sides really are the same model, but a negative "distance" downstream reads as
 * closer-than-identical and breaks the ratio comparisons.
 */
export function correct(raw, floor) {
  if (!Number.isFinite(raw) || !Number.isFinite(floor)) return NaN;
  return Math.max(0, raw - floor);
}

/** Pull `{cell: [answers]}` out of a reference file's per-sample rows. */
export function validAnswersByCell(samples) {
  const out = {};
  for (const s of samples) {
    if (s.answer_class !== 'valid' || s.normalized == null) continue;
    (out[s.cell] ??= []).push(String(s.normalized));
  }
  return out;
}

/**
 * Which of a reference's cells may be used in a comparison at all: it has a fingerprint
 * there, AND that fingerprint rests on at least `minN` valid samples.
 *
 * 🔴 Lives here, next to the pools it reads, because EVERY layer has to apply it — and the
 * first version of this bar was added only to the identification layer, which left the
 * cheap daily screen running on the rule it had just been fixed for. A cell estimated from
 * one sample is wrong twice over and the two compound:
 *   · it enters an equal-weight mean as if it were as well measured as the rest;
 *   · and `noiseFloor` reads a one-element pool as perfectly deterministic, floors it at 0,
 *     and every ratio taken against that floor — SNR when picking cells, separation when
 *     naming a model — comes out infinite. The least-measured cells claim the most
 *     resolution, get picked FIRST for the 3-cell screen, and their genuine band is
 *     calibrated by resampling a pool with one distinct value in it. An honest endpoint
 *     answering anything else there fails L1.
 * `refresh-reference.js` only checks a collection's overall valid rate, so a 40×30 run can
 * bank several such cells and still be saved.
 *
 * A reference carrying no `samples` at all keeps its whole fingerprint: it cannot state its
 * own noise, callers refuse it on that ground, and refusing it twice would turn a clear
 * "no floor" into a confusing "no cells".
 *
 * @param {{fingerprint?: object, samples?: object[]}} ref
 * @param {number} minN  required, and deliberately so — the bar belongs to the caller's
 *   tier, and a default here would silently pick one for layers that have not thought about it
 * @returns {Set<string>}
 */
/**
 * How many valid samples a REFERENCE cell needs before anything may be compared on it.
 *
 * 🔴 One constant, one owner, and deliberately here rather than beside `L2_MIN_N`. They
 * happen to share a value and they are not the same rule: `L2_MIN_N` is about the run being
 * judged, this is about the library it is judged against. They were briefly two constants
 * with the same number and different comments, which is a silent fork waiting for someone
 * to raise one of them — selection would go on choosing a 10-sample cell that
 * identification had started dropping, and the two layers would disagree without erroring.
 */
export const REFERENCE_MIN_N = 10;

export function comparableCells(ref, minN) {
  if (!Number.isInteger(minN) || minN < 1) {
    throw new Error(`comparableCells: minN must be a positive integer, got ${JSON.stringify(minN)}`);
  }
  const fp = ref?.fingerprint ?? {};
  if (!Array.isArray(ref?.samples) || ref.samples.length === 0) return new Set(Object.keys(fp));
  const pools = validAnswersByCell(ref.samples);
  return new Set(Object.keys(fp).filter((c) => (pools[c]?.length ?? 0) >= minN));
}

/**
 * The upward bias of a CROSS-model distance estimate — how much two finite samples of two
 * DIFFERENT distributions overstate the distance between the distributions themselves.
 *
 * 🔴 This is not the noise floor, and using a noise floor in its place is wrong by more
 * than a little. The floor answers "how far apart do two samples of the SAME distribution
 * land", whose true value is zero, so the whole measurement is bias. A cross-model distance
 * has a large true value and only a small bias on top: measured on P = {a:1} against
 * Q = {a:25/30, b:5/30} at thirty samples a side, the true JSD is 0.0888 and the bias is
 * 0.00098, while Q's own split-half floor is 0.0134 — fourteen times too much.
 *
 * And the direction is the dangerous one. D is a DENOMINATOR: over-subtracting shrinks it,
 * which raises S/D toward the accusation line. The "take the larger of the two floors"
 * reasoning borrowed from `comparisonFloor` does not transfer — there a larger number is
 * more conservative, here it is less.
 *
 * Reduces to `noiseFloor` when both sides are the same pool, because the true distance is
 * then zero and the bias is the whole of it.
 *
 * @param {object} poolsA cell → valid answers, side A
 * @param {object} poolsB cell → valid answers, side B
 * @param {number|object} repsA how many samples side A contributes (number or per-cell map)
 * @param {number|object} repsB likewise for side B
 * @returns {{byCell: object, overall: number, cells: number}}
 */
/**
 * A stable, role-free ordering key for one side of a pair.
 *
 * 🔴 Unambiguous, not merely "unlikely to collide". A separator-joined key made
 * `["z", "a\u0001b"]` and `["z", "a", "b"]` identical at the same count — and normalised
 * answers are not screened for U+0001, so those are both reachable inputs. A collision puts
 * the ordering back in the hands of argument order, which is the asymmetry this key exists
 * to remove: measured on that pair, the two directions give 0.01501 and 0.01387.
 */
const keyOf = (pool, n) => JSON.stringify([n, pool]);

export function pairBias(poolsA, poolsB, repsA, repsB, { trials = DEFAULT_TRIALS, seed = DEFAULT_SEED } = {}) {
  const nFor = (r) => (typeof r === 'number' ? () => r : (c) => r?.[c]);
  const nA = nFor(repsA);
  const nB = nFor(repsB);
  const rng = mulberry32(seed);
  const cells = Object.keys(poolsA).filter((c) => poolsB[c]?.length).sort();
  const byCell = {};
  for (const cell of cells) {
    const a = poolsA[cell];
    const b = poolsB[cell];
    if (!a?.length || !b?.length) continue;
    const ca = nA(cell);
    const cb = nB(cell);
    if (!Number.isInteger(ca) || ca < 1 || !Number.isInteger(cb) || cb < 1) {
      throw new Error(`pairBias: no usable counts for cell ${cell}, got ${JSON.stringify([ca, cb])}`);
    }
    const truth = jsd(empiricalDist(a), empiricalDist(b));
    // 🔴 A CANONICAL order, so the estimate does not depend on which side the caller called
    // A. The quantity is symmetric — swapping (pool, reps) together cannot change the true
    // bias — but one RNG stream hands the two sides different segments, so at 400 trials the
    // estimate was not. Measured: P={a:1} against Q={a:25/30,b:5/30} at 15-vs-10 gives
    // 0.006417 one way round and 0.002783 the other, and with D = 0.100 and S = 0.067 that
    // is S/D 0.716 versus 0.689 — SUSPECT or not, decided by which model the endpoint
    // happened to be selling. Expectation-symmetry is not enough when a verdict reads one
    // realisation; the estimator has to be symmetric structurally.
    const [p1, n1, p2, n2] = keyOf(a, ca) <= keyOf(b, cb) ? [a, ca, b, cb] : [b, cb, a, ca];
    let sum = 0;
    for (let t = 0; t < trials; t += 1) {
      sum += jsd(empiricalDist(drawWithReplacement(p1, n1, rng)),
        empiricalDist(drawWithReplacement(p2, n2, rng)));
    }
    // ⚠️ Clamped, and the reason is narrower than "a sample cannot make them closer" — it
    // can: draw one from {a:0.6,b:0.4} and one from {a:0.4,b:0.6} and both may come up `a`,
    // giving an empirical JSD of 0 under a positive truth. What is non-negative is the
    // EXPECTED bias, by joint convexity of the divergence. So this clamps the Monte-Carlo
    // error in estimating a quantity that is itself non-negative, and it matters because a
    // negative correction would be ADDED to the distance it exists to shrink.
    byCell[cell] = Math.max(0, sum / trials - truth);
  }
  const values = Object.values(byCell);
  return {
    byCell,
    overall: values.length ? values.reduce((s2, v) => s2 + v, 0) / values.length : 0,
    cells: values.length,
  };
}
