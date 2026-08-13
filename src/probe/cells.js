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
