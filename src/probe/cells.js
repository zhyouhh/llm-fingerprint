// Cell selection: which of the battery's cells are worth spending samples on.
//
// 决策 #4 — computed fresh on every run, never hard-coded. A cell that separates two
// models is a property of THAT PAIR: sol vs 5.4 gets nothing at all from
// num10-random (both models answer identically, JSD 0.000000), while colour and animal
// cells separate them cleanly. Freeze that list and the next model pair silently spends
// a quarter of its budget on cells that cannot say anything.
//
// Signal-to-noise, not raw signal: a cell whose two models differ by 0.05 is useless if
// the same model measured twice already differs by 0.04.

import { jsd } from '../stats/jsd.js';
import { noiseFloor, validAnswersByCell } from '../stats/noise.js';
import { mulberry32, drawWithReplacement, empiricalDist, percentile } from '../lib/rng.js';

/** A cell whose two models produce the same distribution carries no information. */
export const DEAD_CELL_SIGNAL = 0.01;

export const TIER_PLAN = Object.freeze({
  l1: { cells: 3, reps: 5 },    // 15 logical probes — the cheap screen
  l2: { cells: null, reps: 15 }, // every live cell — null means "no cap"
});

/**
 * @param {object} refSubject  reference/genuine-<subject>.json
 * @param {object} refControl  reference/genuine-<control>.json
 * @param {{tier: 'l1'|'l2', trials?: number, seed?: number}} opts
 * @returns {{cells: Array<{task_id, lang, reps, signal, noise, snr}>, repsPerCell,
 *           totalReps, dead: string[], tier: string}}
 */
export function selectCells(refSubject, refControl, { tier = 'l1', trials, seed } = {}) {
  const plan = TIER_PLAN[tier];
  if (!plan) throw new Error(`unknown tier: ${tier}`);

  const subjectFp = refSubject?.fingerprint ?? {};
  const controlFp = refControl?.fingerprint ?? {};
  const shared = Object.keys(subjectFp).filter((c) => controlFp[c]).sort();

  // Noise is measured at the reps this tier will actually collect — a floor computed at
  // 30 reps would understate the noise of a 5-rep screen and make its SNR look better
  // than it is.
  const noise = noiseFloor(validAnswersByCell(refSubject.samples ?? []), plan.reps, { trials, seed });

  const scored = shared.map((cell) => {
    const [task_id, lang] = cell.split('|');
    const signal = jsd(subjectFp[cell], controlFp[cell]);
    const n = noise.byCell[cell] ?? 0;
    return {
      task_id, lang, cell, signal, noise: n,
      // A zero floor means the cell is deterministic, so any signal at all is infinitely
      // clean; Infinity sorts it to the front, which is correct.
      snr: n > 0 ? signal / n : (signal > 0 ? Infinity : 0),
    };
  });

  const dead = scored.filter((c) => c.signal <= DEAD_CELL_SIGNAL).map((c) => c.cell);
  const live = scored.filter((c) => c.signal > DEAD_CELL_SIGNAL)
    // Ties broken by cell name so the selection is deterministic.
    .sort((a, b) => (b.snr - a.snr) || a.cell.localeCompare(b.cell));

  const chosen = (plan.cells == null ? live : live.slice(0, plan.cells))
    .map((c) => ({ ...c, reps: plan.reps }));

  return {
    tier,
    cells: chosen,
    repsPerCell: plan.reps,
    totalReps: chosen.length * plan.reps,
    dead,
    liveCount: live.length,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L1 threshold calibration — offline, zero requests.
 *
 * 🔴 Every knob below is pinned. Change any one of them and the thresholds change,
 * which is why they are not the implementer's to choose:
 *
 *   sampling          WITH replacement — a screen draws 5 NEW samples from the model's
 *                     true distribution; without replacement it draws a subset of the
 *                     reference itself, the finite-population correction shrinks the
 *                     variance, T_pass comes out tight, and genuine endpoints start
 *                     landing in the amber band.
 *   trials            20000 — at 4000, 190 of 200 seeds agree (8.2% spread); at 20000,
 *                     all 200 seeds return the identical value. It costs ~100ms.
 *   randomness        mulberry32, seed 42, ONE stream per group consumed continuously
 *                     across trial × cell. Restarting the stream per cell yields
 *                     T_fail = 0.3576 instead of 0.3412 — a wrong number that looks
 *                     just as plausible.
 *   reference side    refSubject.fingerprint[cell] as stored, NOT rebuilt from samples.
 *                     The two differ in the tenth decimal, and the stored one is what a
 *                     live comparison actually uses.
 *   percentile        nearest-rank. Interpolation invents a threshold no trial produced.
 *   rounding          none until display.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const CALIBRATION_TRIALS = 20_000;
export const CALIBRATION_SEED = 42;

function poolsFor(ref, cells) {
  const byCell = validAnswersByCell(ref.samples ?? []);
  return cells.map((c) => byCell[c.cell] ?? []);
}

/**
 * Score one simulated screen: draw `reps` fresh answers per cell and average the JSD
 * against the subject reference.
 */
function screenScore(pools, targets, reps, rng) {
  let sum = 0;
  for (let i = 0; i < pools.length; i++) {
    sum += jsd(empiricalDist(drawWithReplacement(pools[i], reps, rng)), targets[i]);
  }
  return sum / pools.length;
}

/**
 * @returns {{t_pass: number|null, t_fail: number|null, usable: boolean, reason?: string}}
 */
export function calibrateL1Thresholds(refSubject, refControl, selection,
                                      { trials = CALIBRATION_TRIALS, seed = CALIBRATION_SEED } = {}) {
  const cells = selection.cells;
  const unusable = (reason) => ({ t_pass: null, t_fail: null, usable: false, reason });

  // Fewer than three live cells means the pair has too little signal to screen on at
  // all — returning thresholds anyway would hand downstream a number it must not use.
  if (cells.length < TIER_PLAN.l1.cells) {
    return unusable(`only ${cells.length} live cells; L1 needs ${TIER_PLAN.l1.cells}`);
  }

  const targets = cells.map((c) => refSubject.fingerprint[c.cell]);
  const subjectPools = poolsFor(refSubject, cells);
  const controlPools = poolsFor(refControl, cells);
  if (subjectPools.some((p) => !p.length) || controlPools.some((p) => !p.length)) {
    return unusable('a selected cell has no valid samples on one side');
  }

  const reps = selection.repsPerCell;
  // Two independent streams, each restarted from the same seed: the genuine and the
  // impostor simulations are separate experiments that happen to share a seed.
  const positiveRng = mulberry32(seed);
  const impostorRng = mulberry32(seed);

  const genuine = new Array(trials);
  for (let t = 0; t < trials; t++) genuine[t] = screenScore(subjectPools, targets, reps, positiveRng);

  const impostor = new Array(trials);
  for (let t = 0; t < trials; t++) impostor[t] = screenScore(controlPools, targets, reps, impostorRng);

  genuine.sort((a, b) => a - b);
  impostor.sort((a, b) => a - b);

  const t_pass = percentile(genuine, 0.99);   // 99% of genuine screens land at or below
  const t_fail = percentile(impostor, 0.01);  // 99% of substitutions land at or above

  // Overlapping distributions mean no threshold separates them. Returning the midpoint
  // would be a number that is guaranteed to be wrong in both directions.
  if (!(t_pass < t_fail)) {
    return { t_pass: null, t_fail: null, usable: false, reason: `distributions overlap (p99 ${t_pass} ≥ p01 ${t_fail})` };
  }
  return { t_pass, t_fail, usable: true };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Empirical T_pass — measured, not simulated.
 *
 * 🔴 Why the simulation is not enough, learned the hard way:
 *
 * The resampling calibration draws from the reference POOL, so it can only ever
 * produce answers the pool already contains. Refreshing the reference made two of the
 * three cells perfectly deterministic ({47: 1.0} from thirty identical draws), the
 * simulated genuine spread collapsed with them, and T_pass tightened from 0.080 to
 * 0.0178 — which happens to be exactly the score of a flawless screen. Five live runs
 * against the KNOWN-GENUINE endpoint landed at 0.0056 / 0.0178 / 0.0178 / 0.0416 /
 * 0.0544: two of five above the bar. A 40% false-negative rate on the endpoint the
 * reference was collected from.
 *
 * The gap is structural. A reference saying {47: 1.0} assigns probability zero to
 * everything else, and JSD punishes a zero hard — one unusual answer in five samples
 * costs that cell 0.108. The pool cannot simulate an answer it does not contain, so the
 * simulation is blind to precisely the event that matters.
 *
 * So T_pass takes the LARGER of the simulated p99 and a bound derived from live genuine
 * screens. Simulation alone under-estimates; live runs alone are too few to trust a
 * percentile from. Both, and take the wider.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Below this many live screens, a percentile is not meaningful — pad the max instead. */
export const EMPIRICAL_MIN_RUNS = 20;
/** Headroom on the observed maximum while the sample is small. */
export const EMPIRICAL_MARGIN = 1.3;

/**
 * @param {number[]} observed  S_screen from live runs against a known-genuine endpoint
 * @returns {{t_pass: number|null, basis: string, n: number}}
 */
export function empiricalTPass(observed = []) {
  const values = observed.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return { t_pass: null, basis: 'no live genuine screens recorded', n: 0 };
  if (values.length >= EMPIRICAL_MIN_RUNS) {
    return { t_pass: percentile(values, 0.99), basis: `p99 of ${values.length} live genuine screens`, n: values.length };
  }
  return {
    t_pass: values.at(-1) * EMPIRICAL_MARGIN,
    // Named provisional so nobody reads a padded maximum as a calibrated percentile.
    basis: `provisional: max of ${values.length} live genuine screens × ${EMPIRICAL_MARGIN} ` +
           `(needs ${EMPIRICAL_MIN_RUNS} for a percentile)`,
    n: values.length,
  };
}

/**
 * Combine both calibrations. The simulated bound stays in play because with few live
 * runs it can still be the wider of the two.
 */
export function combineThresholds(simulated, observed = []) {
  if (!simulated.usable) return simulated;
  const emp = empiricalTPass(observed);
  if (emp.t_pass == null) return { ...simulated, t_pass_basis: 'simulation only — no live genuine screens yet' };
  const t_pass = Math.max(simulated.t_pass, emp.t_pass);
  if (!(t_pass < simulated.t_fail)) {
    return { ...simulated, t_pass: null, t_fail: null, usable: false,
      reason: `the genuine spread (${emp.t_pass.toFixed(4)}) reaches the substitution threshold ` +
              `(${simulated.t_fail.toFixed(4)}) — this cell set cannot separate the two` };
  }
  return {
    ...simulated, t_pass,
    t_pass_basis: t_pass === emp.t_pass ? emp.basis : `simulated p99 (wider than ${emp.basis})`,
    t_pass_simulated: simulated.t_pass,
    t_pass_empirical: emp.t_pass,
  };
}
