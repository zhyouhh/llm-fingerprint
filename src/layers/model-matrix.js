// Pairwise distance matrix over every genuine reference on one wire. Zero requests.
//
// 🔴 The diagonal is not zero, and that is the point. A model compared with ITSELF still
// scores a positive distance, because two samples of the same distribution differ by
// sampling noise alone — that is the noise floor. Putting it on the diagonal turns the
// matrix into something a reader can act on without knowing any of this project's
// thresholds:
//
//   off-diagonal ≈ the scale of the diagonals  →  indistinguishable, same model
//   off-diagonal ≫ them                        →  genuinely different models
//
// Without the diagonal, "sol vs luna = 0.18" means nothing to a reader: 0.18 is either
// enormous or trivial depending on how noisy the measurement was, and nothing on the
// screen says which.
//
// ⚠️ The diagonal is for READING, not for deciding. Each one is a mean over that model's
// whole battery while an off-diagonal cell is a mean over the pair's intersection, so when
// two references cover different cells those are two different measurements. `pairFloors`
// holds the number a decision must use, measured on the cells that pair shares.

import { jsd } from '../stats/jsd.js';
import { noiseFloor, validAnswersByCell, comparableCells, REFERENCE_MIN_N } from '../stats/noise.js';
import { mulberry32, percentile } from '../lib/rng.js';
// The same bar selectCells uses to call a cell dead — 'shared' and 'useful' are different
// questions, and a caller choosing a control needs the second one.
import { DEAD_CELL_SIGNAL } from '../probe/cells.js';
// The same bar `applyGates` uses, from the same place — a second copy of 0.80 here is how
// the CLI and the page end up applying a rule the verdict layer no longer does.
import { VALID_RATE_LOW_CONFIDENCE } from '../contracts.js';

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
export function modelMatrix(refs, { trials = 400, minN = REFERENCE_MIN_N } = {}) {
  const models = refs.map((r) => r.model);
  // 🔴 The same per-cell sample bar the ranking and the screen apply. The map is not just a
  // picture: `pickControl` reads it to choose the yardstick model, and that choice sets D.
  // A pair whose distance rests partly on cells one side measured once is not a distance
  // anyone should be picking a yardstick from.
  const ok = refs.map((r) => comparableCells(r, minN));
  const restrict = (i) => Object.fromEntries(
    Object.entries(refs[i].fingerprint ?? {}).filter(([c]) => ok[i].has(c)));

  // Each model's own floor, measured at the reps its reference was collected with. A
  // deterministic model floors at 0; a scattered one floors much higher, and comparing
  // the two against one absolute threshold would be wrong in both directions.
  // 🔴 Each cell at the count that cell ACTUALLY holds, on both draws — not the reference's
  // declared `reps`. That declaration is a plan, and real collections miss it: in this
  // project's own library gpt-5.6-luna has cells at 15, 22, 25, 26 and 30 while declaring
  // 30, and gpt-5.6-terra carries one cell with four. Both sides of this comparison are
  // stored references, so both are drawn at their own pool size.
  const poolsOf = refs.map((r) => validAnswersByCell(r.samples ?? []));
  const floorOn = (i, keys) => {
    const kept = Object.fromEntries(Object.entries(poolsOf[i]).filter(([c]) => keys.has(c)));
    if (!Object.keys(kept).length) return NaN;
    const sizes = Object.fromEntries(Object.entries(kept).map(([c, pool]) => [c, pool.length]));
    return noiseFloor(kept, sizes, { trials, against: 'pool' }).overall;
  };
  const floors = refs.map((r, i) => (r.samples?.length ? floorOn(i, ok[i]) : NaN));

  const fp = refs.map((_, i) => restrict(i));
  // 🔴 A floor PER PAIR, on the cells that pair actually shares.
  //
  // The off-diagonal is a mean over the intersection; `floors[i]` is a mean over model i's
  // whole comparable set. `classifyPair` puts them side by side, so unless both describe
  // the same cells the comparison is two different measurements with a `<=` between them —
  // this project's oldest and most expensive bug shape. Measured on a constructed pair: one
  // shared deterministic cell plus nine noisy cells only A carries reads as
  // "indistinguishable" at distance 0.108 against A's whole-set floor of 0.113, while on the
  // cell they actually share A's floor is 0 and the honest answer is "distinct".
  const pairFloor = (i, j) => {
    const shared = Object.keys(fp[i]).filter((c) => fp[j][c]);
    if (!shared.length) return NaN;
    const sharedSet = new Set(shared);
    const on = (k) => {
      if (Object.keys(poolsOf[k]).filter((c) => sharedSet.has(c)).length < shared.length) return NaN;
      return floorOn(k, sharedSet);
    };
    return Math.max(on(i), on(j));
  };

  const matrix = refs.map(() => new Array(refs.length).fill(NaN));
  const cells = refs.map(() => new Array(refs.length).fill(0));
  const live = refs.map(() => new Array(refs.length).fill(0));
  const pairFloors = refs.map(() => new Array(refs.length).fill(NaN));
  for (let i = 0; i < refs.length; i += 1) {
    matrix[i][i] = floors[i];
    pairFloors[i][i] = floors[i];
    cells[i][i] = Object.keys(fp[i]).length;
    live[i][i] = 0;                       // a model against itself has no signal anywhere
    for (let j = i + 1; j < refs.length; j += 1) {
      const { value, cells: n } = meanJsd(fp[i], fp[j]);
      matrix[i][j] = value;
      matrix[j][i] = value;
      cells[i][j] = n;
      cells[j][i] = n;
      // 🔴 How many of those shared cells carry SIGNAL — the count `selectCells` will
      // actually be able to work with. "Comparable" and "useful" are different questions:
      // a pair can share forty cells and agree on thirty-eight of them, and a caller
      // choosing a yardstick on the first number gets a run that cannot be screened.
      const l = Object.keys(fp[i]).filter((c) => fp[j][c] && jsd(fp[i][c], fp[j][c]) > DEAD_CELL_SIGNAL).length;
      live[i][j] = l;
      live[j][i] = l;
      const f = pairFloor(i, j);
      pairFloors[i][j] = f;
      pairFloors[j][i] = f;
    }
  }
  // `floors` stays each model's own overall noise, because that is what the diagonal SHOWS
  // a reader. `pairFloors` is what a decision must use, and `live` is what a caller needs
  // before it promises a run.
  return { models, matrix, floors, pairFloors, cells, live };
}

/**
 * How to read one pair, in the reader's terms rather than the project's.
 *
 * 🔴 ONE bar, computed by the caller as `pairFloors[i][j]` — not two floors taken apart.
 * It used to accept `(distance, floorA, floorB)` and max them itself, and every caller
 * passed each model's WHOLE-battery floor while the distance was a mean over the pair's
 * intersection. Two different cell sets with a comparison between them, which is the shape
 * this project keeps paying for. A single already-paired number makes that mistake
 * unavailable rather than merely discouraged.
 *
 * ⚠️ And the bar is the LARGER of the two sides' floors, which this comment used to
 * describe as "at or under BOTH" — those are different statements and the second one is
 * false. With floors 0.02 and 0.10 a distance of 0.08 is called indistinguishable while
 * being above one of them. The behaviour is the conservative one and stays: the noisier
 * model's own scatter is the resolution the PAIR has, so one side being deterministic must
 * not license a call the other side cannot support. Only the description was wrong.
 */
export function classifyPair(distance, bar) {
  if (!Number.isFinite(distance)) return 'no shared cells';
  if (!Number.isFinite(bar)) return 'unknown';
  if (distance <= bar) return 'indistinguishable';
  if (distance <= bar * 2) return 'near';
  return 'distinct';
}

/** Runner-up must be this many times further before a name goes on a distribution. */
export const SEPARATION = 2.0;

/**
 * Below this many cells a name is not evidence, however clean the separation looks.
 *
 * ⚠️ **This number is fitted in-sample, and so is the 4-of-4 / 0-of-5 record quoted for the
 * rule it gates.** Both come from the same ~13 archived runs that the rule was designed
 * against; there is no held-out set, no false-accusation rate with an interval on it, and
 * no second collection epoch. Treat it as a floor chosen to be conservative, not as a
 * validated threshold — the honest summary is "it has never been wrong on the data we
 * happen to have", which is a much weaker claim than it sounds.
 *
 * What it was read off: one endpoint measured at three battery sizes gave three different
 * answers — 3-cell L1 said gpt-5.6-terra at 2.51×, 6-cell L2 said terra at 2.79×, 29-cell
 * runs said gpt-5.6-luna and gpt-5.6-sol. Twelve is double the six this project documents
 * as "coarse and heavy-tailed whatever the reps".
 *
 * To make it defensible rather than plausible: fix the thresholds first, then collect
 * genuine runs across gateways, model pairs and collection epochs that had no part in
 * choosing them, and report the false-accusation rate with its interval.
 *
 * The consequence worth stating: L1 (3 cells) can never name a model. That is what L1 is —
 * a screen answering "still the same one?", not an identification answering "then what".
 */
export const MIN_ID_CELLS = 12;

/**
 * The winner must stay the winner in at least this share of resampled cell draws.
 *
 * 🔴 Measured directly, not inferred from an interval. `separation`'s lower bound only
 * describes the gap between the two models that happened to rank first and second on the
 * full data; a third candidate can take first place in one draw in ten while that gap
 * looks perfectly stable. This asks the question the name depends on — "would a different
 * draw of cells have named someone else" — of every eligible candidate at once.
 *
 * 0.95 is the complement of the 5% tail the reported 90% interval already uses, so the two
 * numbers on the page describe the same level of doubt rather than two different ones.
 */
export const RANKING_STABILITY = 0.95;

/**
 * Name a measured distribution by finding which reference it is shaped like.
 *
 * 🔴 Decided on SEPARATION from the runner-up, never on the absolute distance.
 *
 * The absolute distance carries the relay's harness, and there is no control model here to
 * subtract it with — a gateway measures 0.154 from the model it is genuinely serving. Judged
 * against a noise floor that reads "matches nothing", which is how the first version of this
 * labelled all twelve measured rows, four of which L2 had already proven genuine.
 *
 * ⚠️ The ratio ATTENUATES the harness; it does not cancel it, and the earlier wording here
 * claiming it did was wrong. A harness that pushes every candidate out by the same additive
 * amount `h` turns `d₂/d₁` into `(d₂+h)/(d₁+h)`, which moves toward 1 — the ranking is
 * preserved and naming gets harder, which is the safe direction. What is NOT bounded is a
 * distortion that is model- or cell-dependent: that can reorder candidates outright, and
 * nothing in this layer would notice. It is the reason a name is a claim about shape rather
 * than proof of identity, and the reason the separation bar is set well above 1.
 *
 * @param {object} measured  cell → distribution
 * @param {Array<{model: string, fingerprint: object}>} refs
 * @returns {{best, runnerUp, cells: number, ranked}}  ranking only — the naming rule and
 *   its two bars live in `identification()`, so there is one place they can be read from.
 */
export function identify(measured, refs, { minCells = MIN_ID_CELLS, minN = REFERENCE_MIN_N } = {}) {
  // 🔴 ONE cell set for every candidate. `meanJsd` intersects per pair, so ranking each
  // reference over whatever it happens to share turns the ranking into a comparison of
  // incomparable means: a reference covering only the twelve easiest cells can match those
  // exactly, score 0, and beat a reference measured over all twenty-four — the twelve it
  // never answered are simply not counted against it.
  //
  // ⚠️ But a shared set also hands every candidate a veto: drop one 11-cell reference into
  // the library and the intersection collapses for everyone, silently switching the whole
  // naming route off. So a reference that covers fewer of the measured cells than we would
  // ever name on is not a candidate at all — it cannot support a name, so it does not get
  // to remove one. Which ones were set aside comes back in `dropped`, because a shrunken
  // cell set must never be silent.
  // One pass over each reference's sample pools, reused everywhere below.
  const comparable = new Map(refs.map((r) => [r, comparableCells(r, minN)]));
  const eligible = refs.filter((r) => coverage(measured, r, minN) >= minCells);
  const thin = refs.filter((r) => coverage(measured, r, minN) < minCells);
  const cells = commonCells(measured, eligible, comparable);
  const ranked = eligible
    .map((r) => ({
      model: r.model,
      value: cells.length
        ? cells.reduce((s, c) => s + jsd(measured[c], r.fingerprint[c]), 0) / cells.length
        : NaN,
      cells: cells.length,
    }))
    .filter((x) => Number.isFinite(x.value))
    .sort((a, b) => a.value - b.value || a.model.localeCompare(b.model));
  const best = ranked[0] ?? null;
  const bestRef = best ? eligible.find((r) => r.model === best.model) : null;

  const meanOver = (ref, keys) => (keys.length
    ? keys.reduce((s, c) => s + jsd(measured[c], ref.fingerprint[c]), 0) / keys.length
    : NaN);

  // 🔴 Coverage too thin to WIN is not coverage too thin to VETO: a reference matching
  // eleven of twelve cells exactly cannot be named, but its existence destroys any claim
  // that some other model is the unique answer.
  //
  // 🔴 …and the veto has to be decided HEAD-TO-HEAD, on the cells the two of them both
  // answer. Comparing this candidate's mean over its own eleven cells against the winner's
  // mean over all forty is [[silent-comparison-mismatch]] in its purest form — two averages
  // of different things, with `<=` between them. It fails in the direction that matters:
  // winner 0.055 over forty cells, candidate 0.060 over its eleven, no veto — while on those
  // same eleven the winner sits at 0.20 and the candidate is plainly the nearer of the two.
  // A name then goes out that was never unique.
  const dropped = thin.map((r) => {
    // Same sample bar as everywhere else: a veto rests on cells that were measured, on
    // both sides. A one-sample reference cell must not be able to unseat a name either.
    const own = Object.keys(measured).filter((c) => comparable.get(r).has(c));
    const shared = bestRef ? own.filter((c) => comparable.get(bestRef).has(c)) : [];
    return {
      model: r.model,
      cells: own.length,
      value: meanOver(r, own),
      // The head-to-head, and the winner's distance measured on the very same cells.
      shared_cells: shared.length,
      value_vs_best: meanOver(r, shared),
      best_value_here: bestRef ? meanOver(bestRef, shared) : NaN,
    };
  });
  return {
    best, runnerUp: ranked[1] ?? null,
    cells: cells.length, cellKeys: cells, ranked, dropped, eligible,
  };
}

/**
 * Cluster bootstrap over cells that RE-RANKS every eligible candidate in each draw.
 *
 * 🔴 The first version fixed best and runner-up on the full data and then resampled only
 * that pair's ratio. It therefore measured "is this pair's gap stable" and was commented
 * as "is the ranking stable" — a claim it could not support. A third candidate sitting
 * just behind can take first place in well over 5% of draws while the pair's own interval
 * stays narrow, and nothing in the reported number would move.
 *
 * @returns {{ratio, lo, stability}} `stability` is the share of draws in which the
 *   full-data winner stayed first — the quantity the naming rule actually needs.
 */
export function rankingBootstrap(measured, eligible, cellKeys, bestModel, {
  trials = 1000, seed = 42, level = 0.90, floors = null, sold = null,
} = {}) {
  const n = cellKeys.length;
  if (!n || eligible.length < 2) return { ratio: NaN, lo: NaN, stability: NaN };
  // Per-cell distances once; every draw is a re-average of these.
  const per = eligible.map((r) => ({
    model: r.model,
    d: cellKeys.map((c) => jsd(measured[c], r.fingerprint[c])),
  }));

  const rng = mulberry32(seed);
  const ratios = [];
  let held = 0;
  const idx = new Array(n);
  for (let t = 0; t < trials; t += 1) {
    for (let i = 0; i < n; i += 1) idx[i] = Math.floor(rng() * n);
    let first = null;
    let second = null;
    // 🔴 A draw in which two candidates come out EQUAL is not evidence for either of them.
    // The first version kept whichever appeared earlier in the array, which made the verdict
    // depend on the order references happen to load in. It is not hypothetical: with eleven
    // cells carrying no discriminating signal and one that does, every draw missing that one
    // cell ties exactly — and an honest endpoint was convicted at stability 1.000 or cleared
    // at 0.638 by nothing but which of the two files came first.
    let tied = false;
    for (const cand of per) {
      let sum = 0;
      for (const i of idx) sum += cand.d[i];
      const mean = sum / n;
      if (first === null || mean < first.mean) {
        second = first; first = { model: cand.model, mean }; tied = false;
      } else if (mean === first.mean) {
        tied = true;
        if (second === null || mean < second.mean) second = { model: cand.model, mean };
      } else if (second === null || mean < second.mean) {
        second = { model: cand.model, mean };
      }
    }
    // A tie for SECOND place is irrelevant — only a tie at the top withholds the draw.
    if (!tied && first.model === bestModel) held += 1;
    // 🔴 THIS draw's pair AND this draw's cells set the floor. A single run-wide scalar is a
    // resolution limit belonging to two other models, averaged over a different set of cells
    // than the ratio above it.
    const drawFloor = drawFloorFor(floors, [sold, first.model, second.model], idx);
    ratios.push(second.mean / Math.max(first.mean, Number.isFinite(drawFloor) ? drawFloor : 0));
  }
  ratios.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ratio: NaN, lo: percentile(ratios, (1 - level) / 2), stability: held / trials };
}

/** How many of the measured cells this reference can be compared on. */
const coverage = (measured, ref, minN) => {
  const ok = comparableCells(ref, minN);
  return Object.keys(measured ?? {}).filter((c) => ok.has(c)).length;
};

/**
 * Each model's own repeat-measurement noise on the shared cells, at this run's reps.
 *
 * 🔴 Per model, computed once, because the resolution limit belongs to a PAIR and the pair
 * changes. Every bootstrap draw re-ranks all candidates, so the two distances being divided
 * in a given draw can be any two of them. One number for the whole run has to be either the
 * full-data top two's (wrong for every other draw) or the max over everybody (which lets the
 * noisiest reference in the library set the bar for a comparison it takes no part in —
 * measured, that pushed a confirmed substitution from 3.6× down to 2.2× because gpt-5.4-nano
 * happens to be jittery). Keep them separate and take the max of the two that are actually
 * being divided.
 *
 * @returns {Map<string, number>|null} null if ANY reference in play cannot state its own —
 *   a ratio against an unknown resolution limit is the mistake the floor exists to prevent,
 *   and dropping the unknowable ones silently omits exactly the model about to be named.
 */
export function modelFloors(refsInPlay, cellKeys, reps, { trials = 400, minN = REFERENCE_MIN_N } = {}) {
  const present = refsInPlay.filter(Boolean);
  if (!present.length) return null;
  const out = new Map();
  for (const r of present) {
    const byCell = validAnswersByCell(r.samples ?? []);
    const kept = Object.fromEntries(Object.entries(byCell)
      // 🔴 …and each pool must clear the same sample bar the measurement side clears.
      // `noiseFloor` reads a one-element pool as perfectly deterministic and returns 0 for
      // it, so the least-measured cells would claim the most resolution — and the floor is
      // the denominator every separation is divided by.
      .filter(([c, pool]) => cellKeys.includes(c) && pool.length >= minN));
    // 🔴 Every shared cell, or the floor describes a different comparison. A reference with
    // a sample pool for one of twelve cells would otherwise have that single cell's
    // dispersion stand in for all twelve.
    if (Object.keys(kept).length < cellKeys.length) return null;
    // 🔴 `against: 'pool'` — the reference side is not another run of this measurement, it
    // is a stored fingerprint with exactly the samples it banked. A cell where the library
    // holds 10 and this run collected 15 is a 15-vs-10 comparison; drawing both at 15
    // understates the floor, and the floor is the denominator every separation divides by.
    const nf = noiseFloor(kept, reps, { trials, against: 'pool' });
    // 🔴 Per cell as well as overall. A bootstrap draw re-weights the cells, so its ratio's
    // numerator is an average over the DRAWN cells while a single stored scalar is an
    // average over all of them — numerator and denominator calibrated on different cell
    // weightings, which is what `separation_lo` was quietly reporting. Twelve cells with
    // eleven at floor 0 and one at 0.12 make that a factor of six either way.
    const perCell = cellKeys.map((c) => nf.byCell[c]);
    if (!Number.isFinite(nf.overall) || !perCell.every(Number.isFinite)) return null;
    out.set(r.model, { overall: nf.overall, byCell: perCell });
  }
  return out;
}

/**
 * The resolution limit for ONE comparison: the largest floor among the models being divided.
 *
 * 🔴 Why the largest, and why not just the defended model's. Under the impostor hypothesis
 * the measurement's own scatter is the NAMED candidate's, not the defended one's — so a
 * defended reference that happens to be deterministic would license a ratio the named
 * candidate's own repeat-measurement noise cannot support. Concretely: the named candidate
 * floors at 0.10, best = 0.02, runner-up = 0.05, and the raw ratio 2.5 "convicts" on two
 * distances that candidate cannot itself tell apart. `classifyPair` already takes the max
 * of two floors for exactly this reason.
 */
export function comparisonFloor(floors, models) {
  if (!floors) return NaN;
  const vs = models.filter(Boolean).map((m) => floors.get(m)?.overall);
  return vs.length && vs.every(Number.isFinite) ? Math.max(...vs) : NaN;
}

/**
 * The same limit for ONE bootstrap draw: each model's floor re-averaged over the cells that
 * draw actually took, then the max across the models being divided. Same cell weighting as
 * the distances in that draw, which is the whole point.
 */
function drawFloorFor(floors, models, idx) {
  if (!floors) return 0;
  let worst = 0;
  for (const m of models) {
    if (!m) continue;
    const f = floors.get(m);
    if (!f) return NaN;
    let sum = 0;
    for (const i of idx) sum += f.byCell[i];
    const mean = sum / idx.length;
    if (mean > worst) worst = mean;
  }
  return worst;
}

/**
 * Cells the measurement and EVERY candidate reference can all be compared on.
 *
 * `comparable` maps each reference to its usable cell set (fingerprint present AND enough
 * valid samples behind it); pass it when you already have it, otherwise it is derived.
 */
export function commonCells(measured, refs, comparable = null) {
  const ok = (r) => (comparable?.get(r) ?? comparableCells(r, REFERENCE_MIN_N));
  return Object.keys(measured ?? {})
    .filter((c) => refs.length > 0 && refs.every((r) => ok(r).has(c)))
    .sort();
}

/**
 * `identify`, plus the two bars a verdict needs before it may accuse, plus the comparison
 * against what the endpoint claims to sell. One implementation — the CLI, the re-judge
 * path and the web report all call this rather than each applying the rule themselves.
 *
 * 🔴 Why this is a decision function and not a display one. The S/D test cannot convict a
 * swap to a NEAR neighbour: such a swap puts S at roughly the genuine neighbour distance,
 * so S/D lands near 1.0 with a cluster-bootstrap interval of about ±30%, and the rule
 * demands the whole interval above 0.7. Measured across every stored L2: with D from the
 * furthest reference it convicted 0 of 4 confirmed substitutions; with D from the nearest
 * it convicted 1 (one of the misses had a lower bound of 0.69). More cells cannot fix it —
 * the battery already uses every live cell, and the bootstrap resamples cells, not
 * samples. This layer got 4 of 4, and named the right model each time, with no false
 * accusation against 5 confirmed-genuine runs.
 *
 * ⚠️ It can only recognise models the reference library holds. A relay serving something
 * outside it produces `impostor: false` with a low separation — "unknown", not "genuine".
 *
 * 🔴 **Every bar the accusation depends on is applied HERE**, including the one on how much
 * of the run came back. It used to sit in `evaluateL2`, and the consequence was that the
 * layer people actually read went round it: `headline()` tests `identification.impostor`
 * before it looks at the verdict, and the report and the CLI both re-run this function from
 * the stored samples. A run held back to `inconclusive` for a 57% valid rate therefore still
 * opened as a red, named accusation. A gate outside the object it guards is not a gate.
 *
 * @param {object} measured  cell → distribution, from the side under test
 * @param {Array<{model: string, fingerprint: object}>} refs
 * @param {string} sold      the model the endpoint claims this distribution came from
 * @param {number|object} opts.reps  samples behind each measured cell: one number, or a
 *   cell→count map when the run lost probes unevenly
 * @param {number|null} opts.validRate  REQUIRED. The subject side's valid rate, or explicit
 *   null for "unknown", which withholds the name. Not optional and not defaulted: probe loss
 *   is not random, and a default would silently choose the accusing side.
 * @returns {{nearest, distance, runner_up, runner_up_distance, separation, cells,
 *           model: string|null, impostor: boolean, withheld: string|null}}
 */
export function identification(measured, refs, sold, { reps, validRate, referenceAgeDays = null,
                                                      separation = SEPARATION,
                                                      minCells = MIN_ID_CELLS, trials } = {}) {
  if (typeof sold !== 'string' || sold.trim() === '') {
    throw new Error('identification: `sold` must be the non-empty model name being defended — ' +
      'without it every match differs from it and every run reads as an impostor.');
  }
  const repsOk = typeof reps === 'object' && reps !== null
    ? Object.values(reps).every((n) => Number.isInteger(n) && n >= 1)
    : Number.isInteger(reps) && reps >= 1;
  if (!repsOk) {
    throw new Error(`identification: reps must be the run's samples-per-cell — a positive integer, ` +
      `or a cell→count map when cells came back unevenly — so the noise floor describes THIS ` +
      `measurement rather than the reference collection, got ${JSON.stringify(reps)}`);
  }
  if (validRate === undefined) {
    throw new Error('identification: `validRate` is required (pass explicit null for "unknown"). ' +
      'A thinned run must not be able to convict: probe loss on this path is not random — ' +
      'measured, the cells 429s killed averaged S 0.140 against 0.211 for the survivors — and ' +
      'resampling the survivors cannot see it. Defaulting it would pick the accusing side.');
  }
  if (validRate !== null && !(Number.isFinite(validRate) && validRate >= 0 && validRate <= 1)) {
    throw new Error(`identification: validRate must be a number in [0,1] or null, got ${JSON.stringify(validRate)}`);
  }
  const { best, runnerUp, cells, cellKeys, dropped, eligible } = identify(measured, refs, { minCells });

  const blank = {
    nearest: null, distance: NaN, runner_up: null, runner_up_distance: NaN,
    separation: NaN, separation_lo: NaN, rank_stability: NaN, floor: NaN, cells,
    dropped_candidates: dropped, refuted_by: [],
    reference_age_days: referenceAgeDays, model: null, impostor: false, leaning: false,
    withheld: 'cells',
  };
  // 🔴 An object, never null — "asked, and nothing was comparable" is a finding. `null` is
  // reserved for "never asked", and a run whose cells all fell under the sample bar used to
  // be stored identically to one that was handed no library at all.
  if (!best) return Object.freeze(blank);

  // 🔴 A floor for EVERY candidate the bootstrap can rank, not just the two that lead on the
  // full data. Each draw re-ranks all of them, so the pair being divided in a given draw can
  // be any pair, and a fixed floor from the full-data top two would divide a third
  // candidate's distances by a resolution limit that is not its own. Per model here; the
  // pair-specific max is taken at each point of use.
  const inPlay = [refs.find((r) => r.model === sold), ...eligible]
    .filter(Boolean)
    .filter((r, i, all) => all.findIndex((o) => o.model === r.model) === i);
  const floors = modelFloors(inPlay, cellKeys, reps, trials ? { trials } : {});
  // What the reported point estimate is judged against: the pair that actually leads.
  const floor = comparisonFloor(floors, [sold, best.model, runnerUp?.model]);
  // 🔴 No floor, no name. A library whose references carry no samples cannot say what its
  // own repeat-measurement noise is, and a ratio taken against an unknown resolution limit
  // is the exact mistake the floor was added to prevent. Refuse rather than assume zero.
  if (!Number.isFinite(floor)) {
    return Object.freeze({
      ...blank,
      nearest: best.model, distance: best.value,
      runner_up: runnerUp?.model ?? null, runner_up_distance: runnerUp?.value ?? NaN,
      // 🔴 Its own state. Falling through to the blank's `'cells'` made a report say "only
      // 12 cells, naming needs 12" — a sentence that contradicts itself, about a bar that
      // passed. What failed is that the library cannot state its own resolution limit.
      withheld: 'floor',
      // …and `leaning` has to be set here too, or the reason is unreachable in the UI:
      // `headline()` only reaches `withheldGloss` through this flag, so inheriting the
      // blank's `false` left the 'floor' wording written but never rendered.
      leaning: best.model !== sold,
    });
  }

  // 🔴 TWO tests, and the second one is not a second copy of the first.
  //
  //   separation      >= SEPARATION      the gap is big enough to be a claim
  //   rank_stability  >= RANKING_STABILITY   the WINNER is stable, not just the gap
  //
  // ⚠️ It was `separation_lo > 1` here, which reads as the same thing and is not. The lower
  // bound describes only the two models that led on the full data; a third candidate can
  // take first place in one draw in ten while that pair's interval stays clear of 1, and
  // nothing in the number would move. `rank_stability` asks the question the name actually
  // rests on — "would a different draw of cells have named someone else" — of every
  // candidate at once. `separation_lo` is still reported, labelled as context, because a
  // marginal gap should stay legible; it decides nothing.
  //
  // ⚠️ Why not require the whole interval past 2.0, which is the stricter reading and the
  // one S/D uses. Measured on this project's archive: that names 2 of 4 confirmed
  // substitutions (misses at 1.56 and 1.99); the pair of tests above names 4 of 4. Neither
  // produces a false accusation on the 5 confirmed genuine runs.
  const ci = runnerUp && Number.isFinite(floor)
    ? rankingBootstrap(measured, eligible, cellKeys, best.model, { floors, sold })
    : { ratio: NaN, lo: NaN, stability: NaN };
  const point = runnerUp ? runnerUp.value / Math.max(best.value, floor) : NaN;

  // 🔴 A candidate too thin to be ranked can still refute — but only on a comparison that
  // means something. `value_vs_best` and `best_value_here` are the two distances over the
  // cells this candidate and the winner BOTH answer, so `<=` between them is a real
  // head-to-head rather than two averages of different cell sets.
  const refutes = (c) => Number.isFinite(c.value_vs_best) && Number.isFinite(c.best_value_here)
    && c.value_vs_best <= c.best_value_here;
  const refuted = dropped.some(refutes);

  // A single candidate cannot be "separated" from anything. Naming on it would mean "the
  // only model we happen to hold a reference for", which is not an identification.
  //
  // 🔴 `Number.isFinite`, deliberately. An infinite lower bound means the floor itself came
  // out zero — every reference perfectly deterministic on every shared cell — and thirty
  // identical samples do not establish that the true probability is 1. That regime is the
  // one this floor exists to refuse, so it is refused rather than read as certainty. With a
  // real floor an exact match still names: the floor, not the raw zero, carries the ratio.
  // Three things, and each rules out a different way of being wrong:
  //   point ≥ SEPARATION    the gap is big enough to be a claim at all
  //   stability ≥ 0.95      the winner stayed the winner across resampled cell draws
  //   cells ≥ minCells      there is enough evidence for a ranking to mean anything
  // plus: nothing too thin to rank was nonetheless closer than the winner.
  //
  // 🔴 …and a fourth, which is not about the ranking at all: enough of the run has to have
  // come back. Probe loss is not random — measured, the cells 429s killed averaged S 0.140
  // against 0.211 for the survivors — so a ranking over the survivors can be perfectly
  // stable and still be an artefact of which minute the quota ran out in. 29 cells × 15 reps
  // needs only the first twelve to survive to clear both the 20% bar and the twelve-cell
  // bar. `rank_stability` cannot see this; only the valid rate can.
  const thinRun = validRate === null || validRate < VALID_RATE_LOW_CONFIDENCE;
  const confident = Number.isFinite(point) && point >= separation
    && Number.isFinite(ci.stability) && ci.stability >= RANKING_STABILITY
    && cells >= minCells && !refuted && !thinRun;
  // Which bar stopped it, so a report can say "re-run this" rather than going quiet. Ordered
  // most-specific first; only meaningful when a name was withheld.
  const withheld = confident ? null
    : refuted ? 'refuted'
      : cells < minCells ? 'cells'
        : thinRun ? 'valid_rate'
          : !(Number.isFinite(point) && point >= separation) ? 'separation'
            : 'stability';
  return Object.freeze({
    ...blank,
    nearest: best.model,
    distance: best.value,
    runner_up: runnerUp?.model ?? null,
    runner_up_distance: runnerUp?.value ?? NaN,
    separation: point,
    // The 90% lower bound on the same ratio, re-ranked in every draw.
    separation_lo: ci.lo,
    // 🔴 What the accusation actually turns on: the share of resampled cell draws in which
    // the named model stayed nearest. A ratio can look wide while a third candidate is
    // taking first place in one draw out of ten.
    rank_stability: ci.stability,
    refuted_by: dropped.filter(refutes),
    // The floor the ratio was taken against, so a reader can see when it did the work.
    floor,
    // ⚠️ How old the defended reference is. A vendor that has since updated the model's
    // weights turns an honest relay into a mismatch, and a sibling reference can then be
    // the nearest — the one way this layer accuses without a substitution having happened.
    reference_age_days: referenceAgeDays,
    // The name, only when it is one we are willing to stand behind.
    model: confident ? best.model : null,
    // 🔴 The accusation. Naming the model that WAS sold is a confirmation, not an impostor.
    impostor: Boolean(confident && best.model !== sold),
    // 🔴 Not a threshold — a comparison. "The nearest reference is not the one you bought,
    // but the interval does not reach the bar." Without this state the conservative rule
    // would put a run whose distribution plainly leans elsewhere back under a calm
    // "not enough evidence", which is the exact burial this whole layer exists to undo.
    // It is reported, never convicted on.
    leaning: Boolean(best.model !== sold && !confident),
    // Which bar withheld the name — 'refuted' | 'cells' | 'floor' | 'valid_rate' |
    // 'separation' | 'stability', or null when nothing did. A withheld name has to be explainable or the
    // report is back to saying "not enough evidence" about a distribution it can see.
    withheld,
  });
}
