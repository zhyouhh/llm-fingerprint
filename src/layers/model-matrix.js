// Pairwise distance matrix over every genuine reference on one wire. Zero requests.
//
// 🔴 The diagonal is not zero, and that is the point. A model compared with ITSELF still
// scores a positive distance, because two samples of the same distribution differ by
// sampling noise alone — that is the noise floor. Putting it on the diagonal turns the
// matrix into something a reader can act on without knowing any of this project's
// thresholds:
//
//   off-diagonal ≈ its row's diagonal  →  indistinguishable, same model
//   off-diagonal ≫ both diagonals      →  genuinely different models
//
// Without the diagonal, "sol vs luna = 0.18" means nothing to a reader: 0.18 is either
// enormous or trivial depending on how noisy the measurement was, and nothing on the
// screen says which.

import { jsd } from '../stats/jsd.js';
import { noiseFloor, validAnswersByCell } from '../stats/noise.js';

/** Mean JSD over the cells both fingerprints have. */
export function meanJsd(a, b) {
  const cells = Object.keys(a).filter((c) => b[c]).sort();
  if (!cells.length) return { value: NaN, cells: 0 };
  return { value: cells.reduce((s, c) => s + jsd(a[c], b[c]), 0) / cells.length, cells: cells.length };
}

/**
 * @param {Array<{model: string, fingerprint: object, samples?: object[], reps?: number}>} refs
 * @param {{trials?: number}} [opts]
 * @returns {{models: string[], matrix: number[][], floors: number[], cells: number[][]}}
 *   matrix[i][j] is the raw mean JSD; matrix[i][i] is model i's own noise floor.
 */
export function modelMatrix(refs, { trials = 400 } = {}) {
  const models = refs.map((r) => r.model);
  // Each model's own floor, measured at the reps its reference was collected with. A
  // deterministic model floors at 0; a scattered one floors much higher, and comparing
  // the two against one absolute threshold would be wrong in both directions.
  const floors = refs.map((r) => (r.samples?.length
    ? noiseFloor(validAnswersByCell(r.samples), r.reps ?? 30, { trials }).overall
    : NaN));

  const matrix = refs.map(() => new Array(refs.length).fill(NaN));
  const cells = refs.map(() => new Array(refs.length).fill(0));
  for (let i = 0; i < refs.length; i += 1) {
    matrix[i][i] = floors[i];
    cells[i][i] = Object.keys(refs[i].fingerprint ?? {}).length;
    for (let j = i + 1; j < refs.length; j += 1) {
      const { value, cells: n } = meanJsd(refs[i].fingerprint ?? {}, refs[j].fingerprint ?? {});
      matrix[i][j] = value;
      matrix[j][i] = value;
      cells[i][j] = n;
      cells[j][i] = n;
    }
  }
  return { models, matrix, floors, cells };
}

/**
 * How to read one pair, in the reader's terms rather than the project's.
 * A pair is only "same" when it is at or under BOTH models' own noise — one side being
 * deterministic does not license the call.
 */
export function classifyPair(distance, floorA, floorB) {
  if (!Number.isFinite(distance)) return 'no shared cells';
  const bar = Math.max(floorA, floorB);
  if (!Number.isFinite(bar)) return 'unknown';
  if (distance <= bar) return 'indistinguishable';
  if (distance <= bar * 2) return 'near';
  return 'distinct';
}
