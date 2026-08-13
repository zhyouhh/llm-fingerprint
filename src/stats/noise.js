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
export function noiseFloor(samplesByCell, repsPerCell, { trials = DEFAULT_TRIALS, seed = DEFAULT_SEED } = {}) {
  if (!Number.isInteger(repsPerCell) || repsPerCell < 1) {
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
    let sum = 0;
    for (let t = 0; t < trials; t++) {
      const a = empiricalDist(drawWithReplacement(pool, repsPerCell, rng));
      const b = empiricalDist(drawWithReplacement(pool, repsPerCell, rng));
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
