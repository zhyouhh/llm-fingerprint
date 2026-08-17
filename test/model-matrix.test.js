// The matrix is what a reader will actually look at, so the thing it must never do is
// present a distance without the scale that makes it mean something.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelMatrix, meanJsd, classifyPair, identify, identification,
  SEPARATION, MIN_ID_CELLS, RANKING_STABILITY, modelFloors, rankingBootstrap,
} from '../src/layers/model-matrix.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDatedSnapshot } from '../src/lib/reference-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { noiseFloor, validAnswersByCell } from '../src/stats/noise.js';

/**
 * A reference with the `samples` the resolution floor is measured from. Bare
 * `{model, fingerprint}` objects cannot name anything now — without samples there is no
 * noise floor, and `identification` refuses rather than assuming zero.
 */
function withSamples(model, fingerprint, { reps = 30 } = {}) {
  const samples = [];
  for (const [cell, dist] of Object.entries(fingerprint)) {
    const entries = Object.entries(dist);
    for (let i = 0; i < reps; i += 1) {
      // Deterministic: walk the distribution proportionally so the pool reproduces it.
      let acc = 0;
      const target = (i + 0.5) / reps;
      let pick = entries[entries.length - 1][0];
      for (const [answer, p] of entries) { acc += p; if (target <= acc) { pick = answer; break; } }
      samples.push({ cell, answer_class: 'valid', normalized: pick });
    }
  }
  return { model, fingerprint, samples };
}

/** Widen a two-cell fixture to `n` cells so it clears MIN_ID_CELLS. */
const widen = (dist, n = MIN_ID_CELLS) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`w${i}|en`, dist]));

const mk = (model, answers, spread) => {
  const fingerprint = {}; const samples = [];
  for (const [cell, a] of Object.entries(answers)) {
    fingerprint[cell] = spread ? { [a]: 0.8, other: 0.2 } : { [a]: 1 };
    for (let i = 0; i < 30; i++) {
      samples.push({ cell, answer_class: 'valid', normalized: spread && i % 5 === 0 ? 'other' : a });
    }
  }
  return { model, fingerprint, samples, reps: 30 };
};
const CELLS = { 'c1|en': 'a', 'c2|en': 'b', 'c3|en': 'c' };
const other = Object.fromEntries(Object.entries(CELLS).map(([k]) => [k, 'z']));

test('the diagonal carries each model\'s own noise floor, not zero', () => {
  // 🔴 A zero diagonal would tell the reader that any positive number means "different",
  // which is false — the same model measured twice is already positive.
  const { matrix, floors } = modelMatrix([mk('det', CELLS, false), mk('noisy', CELLS, true)], { trials: 200 });
  assert.equal(matrix[0][0], floors[0]);
  assert.equal(matrix[1][1], floors[1]);
  assert.equal(floors[0], 0, 'a deterministic model has no sampling noise');
  assert.ok(floors[1] > 0, 'a scattered one does — and the two must not share one threshold');
});

test('the map is drawn on measured cells only — it chooses the yardstick model', () => {
  // 🔴 The matrix is not just a picture: `pickControl` reads it to choose the model that
  // sets D. A pair whose distance rests partly on cells one side measured once is not a
  // distance anyone should pick a yardstick from, and the diagonal — each model's own noise
  // floor — is worse still, because a one-sample pool floors at 0 and makes the model look
  // perfectly repeatable on the cell nobody measured.
  const cells = ['w0|en', 'w1|en', 'w2|en'];
  const ref = (model, answer, thinAnswer) => ({
    model,
    fingerprint: Object.fromEntries(cells.map((c, i) => [c, { [i === 0 ? thinAnswer : answer]: 1 }])),
    samples: cells.flatMap((c, i) => Array.from({ length: i === 0 ? 1 : 30 },
      (_, k) => ({ cell: c, answer_class: 'valid', normalized: i === 0 ? thinAnswer : (k % 5 ? answer : `${answer}-alt`) }))),
    reps: 30,
  });
  const a = ref('a', 'x', 'p');
  const b = ref('b', 'x', 'q');   // identical everywhere EXCEPT the one-sample cell

  const { matrix, cells: counts } = modelMatrix([a, b], { trials: 200, minN: 10 });
  assert.equal(counts[0][1], 2, 'the one-sample cell is not part of the comparison');
  assert.equal(matrix[0][1], 0,
    'and with it excluded these two are indistinguishable — including it would put them 1/3 apart');
});

test('the matrix floors use each cell\'s ACTUAL pool, not the declared reps', () => {
  // 🔴 `reps` on a reference is a PLAN, and real collections miss it: this project's own
  // library has gpt-5.6-luna carrying cells at 15, 22, 25, 26 and 30 while declaring 30,
  // and gpt-5.6-terra carrying one with four. Reading the declaration calibrates a
  // thin cell as though it were fully sampled, which understates the floor exactly where
  // the measurement is weakest — and the floor is what `classifyPair` divides against.
  const full = Array.from({ length: 4 }, (_, i) => `w${i}|en`);
  const lean = 'lean|en';
  const spread = { a: 0.5, b: 0.5 };
  const mkRef = (model) => ({
    model,
    // Same fingerprint everywhere, so the DISTANCE cannot be what moves — only the floor.
    fingerprint: Object.fromEntries([...full, lean].map((c) => [c, spread])),
    samples: [...full, lean].flatMap((c) => Array.from({ length: c === lean ? 10 : 30 },
      (_, k) => ({ cell: c, answer_class: 'valid', normalized: k % 2 ? 'a' : 'b' }))),
    reps: 30,                                  // the declaration, deliberately wrong for `lean`
  });
  const m = modelMatrix([mkRef('p'), mkRef('q')], { trials: 400 });

  // What the declaration would have produced, for contrast.
  const pools = validAnswersByCell(mkRef('p').samples);
  const declared = noiseFloor(pools, 30, { trials: 400, against: 'pool' }).overall;
  const actual = noiseFloor(pools,
    Object.fromEntries(Object.entries(pools).map(([c, v]) => [c, v.length])),
    { trials: 400, against: 'pool' }).overall;

  assert.ok(actual > declared,
    `a 10-sample cell must widen the floor (actual ${actual} vs declared ${declared})`);
  assert.equal(m.floors[0], actual, 'the diagonal must use the real counts');
  assert.equal(m.pairFloors[0][1], actual, 'and so must the pair floor');
});

test('the matrix is symmetric and identical models sit at their floor', () => {
  const { matrix } = modelMatrix([mk('a', CELLS, true), mk('a-copy', CELLS, true)], { trials: 200 });
  assert.equal(matrix[0][1], matrix[1][0]);
  assert.equal(matrix[0][1], 0, 'identical fingerprints are zero apart');
});

test('models answering differently everywhere are far apart', () => {
  const { matrix } = modelMatrix([mk('a', CELLS, false), mk('z', other, false)], { trials: 200 });
  assert.equal(matrix[0][1], 1, 'disjoint deterministic answers are maximally far');
});

test('classifyPair takes ONE bar, already paired', () => {
  // 🔴 It used to take two floors and max them, and every caller handed it each model's
  // whole-battery floor while the distance was a mean over the pair's intersection — two
  // different cell sets with a comparison between them. `modelMatrix` now computes
  // `pairFloors[i][j]` on the shared cells and this takes that number, so the mistake is
  // unavailable rather than merely discouraged.
  assert.equal(classifyPair(0.05, 0.10), 'indistinguishable');
  assert.equal(classifyPair(0.05, 0.0), 'distinct');
  assert.equal(classifyPair(0.15, 0.10), 'near');
  assert.equal(classifyPair(NaN, 0.1), 'no shared cells');
  assert.equal(classifyPair(0.1, NaN), 'unknown', 'an unknowable bar is not a verdict');
});

test('the pair floor is measured on the cells that pair SHARES', () => {
  // 🔴 Codex's construction: A carries one deterministic cell that B also has, plus nine
  // noisy cells B does not. A's whole-battery floor is dominated by the nine — 0.113 — so
  // a distance of 0.108 on the ONE shared cell read as "indistinguishable". On the cell
  // they actually share A is deterministic, the bar is B's 0.015, and 0.108 is well past
  // twice that: distinct.
  const shared = 'w0|en';
  const noisy = Array.from({ length: 9 }, (_, i) => `n${i}|en`);
  const spread = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`x${i}`, 0.1]));
  const a = {
    model: 'a',
    fingerprint: { [shared]: { p: 1 }, ...Object.fromEntries(noisy.map((c) => [c, spread])) },
    samples: [
      ...Array.from({ length: 30 }, () => ({ cell: shared, answer_class: 'valid', normalized: 'p' })),
      ...noisy.flatMap((c) => Array.from({ length: 30 },
        (_, k) => ({ cell: c, answer_class: 'valid', normalized: `x${k % 10}` }))),
    ],
    reps: 30,
  };
  const b = {
    model: 'b',
    fingerprint: { [shared]: { p: 0.8, q: 0.2 } },
    samples: Array.from({ length: 30 },
      (_, k) => ({ cell: shared, answer_class: 'valid', normalized: k % 5 ? 'p' : 'q' })),
    reps: 30,
  };
  const m = modelMatrix([a, b], { trials: 300 });
  assert.equal(m.cells[0][1], 1, 'they share exactly one cell');
  assert.ok(m.floors[0] > m.pairFloors[0][1] * 3,
    `A's whole-battery floor (${m.floors[0]}) must dwarf the pair's (${m.pairFloors[0][1]}), ` +
    'or the fixture does not exercise the difference');
  assert.equal(classifyPair(m.matrix[0][1], m.pairFloors[0][1]), 'distinct');
  // And what the old code did, spelled out so a regression is unmistakable.
  assert.equal(classifyPair(m.matrix[0][1], Math.max(m.floors[0], m.floors[1])), 'indistinguishable');
});

test('cells present on only one side are ignored, not scored as a difference', () => {
  const a = { 'c1|en': { x: 1 }, 'c2|en': { y: 1 } };
  const b = { 'c1|en': { x: 1 } };
  const r = meanJsd(a, b);
  assert.equal(r.cells, 1);
  assert.equal(r.value, 0, 'the shared cell agrees, so the pair agrees');
});

test('identification is decided by separation, not by absolute distance', () => {
  // 🔴 The regression: a real gateway sits 0.154 from the model it genuinely serves,
  // because the distance carries its harness. Judged against a noise floor that reads
  // "matches nothing" — which is how the first version labelled twelve measured rows,
  // four of them already proven genuine by L2. The runner-up ratio cancels the harness.
  const target = { 'c1|en': { a: 1 }, 'c2|en': { b: 1 } };
  const far = { 'c1|en': { z: 1 }, 'c2|en': { z: 1 } };
  // Measured sits well away from BOTH in absolute terms, but far closer to target.
  const measured = { 'c1|en': { a: 0.6, q: 0.4 }, 'c2|en': { b: 0.6, q: 0.4 } };

  const refs = [withSamples('target', widen(target['c1|en'])), withSamples('far', widen(far['c1|en']))];
  const wide = widen(measured['c1|en']);
  const r = identify(wide, refs);
  assert.equal(r.best.model, 'target');
  assert.ok(r.best.value > 0.2, 'absolute distance is large — a floor test would reject it');
  // The naming rule lives in identification(), which is where all three bars are applied.
  const id = identification(wide, refs, 'far', { reps: 15, validRate: 1 });
  assert.ok(id.separation_lo >= SEPARATION, `interval lower bound ${id.separation_lo}`);
  assert.equal(id.model, 'target', 'and yet it is a confident identification');
  assert.equal(id.impostor, true, 'target is not what was sold');
});

/**
 * Eleven cells with no discriminating power and one that has all of it.
 *
 * Every bootstrap draw that misses the one signal cell scores the two candidates EXACTLY
 * equally — the same values summed in the same order — which is what makes this the fixture
 * for ties. A draw of 12 from 12 with replacement misses a given cell (11/12)^12 ≈ 35% of
 * the time, so a rule that counts ties as a win for the winner reports ~100% stability and
 * one that withholds them reports ~65%.
 */
function tieFixture() {
  const n = MIN_ID_CELLS;
  const flat = { p: 0.9, q: 0.1 };
  const base = Object.fromEntries(Array.from({ length: n - 1 }, (_, i) => [`w${i}|en`, flat]));
  // The signal cell is fully divergent, so the SEPARATION bar is cleared with room to
  // spare (~3.1×) — this fixture must not be able to fail for the boring reason.
  return {
    measured: { ...base, 'sig|en': { p: 1 } },
    sold: withSamples('sold', { ...base, 'sig|en': { q: 1 } }),
    cand: withSamples('cand', { ...base, 'sig|en': { p: 1 } }),
  };
}

test('a tie is not a win for whichever reference loaded first', () => {
  // 🔴 The ranking breaks ties by model name; the bootstrap kept input order and counted a
  // tie as a win for the earlier entry. So the verdict depended on the order references
  // happen to come off disk. Measured on this fixture before the fix: [cand, sold] gave
  // stability 1.000 and convicted, [sold, cand] gave 0.638 and did not — same fingerprints,
  // same samples, opposite outcomes, and an honest endpoint on the losing side of it.
  const { measured, sold, cand } = tieFixture();
  const forward = identification(measured, [cand, sold], 'sold', { reps: 15, validRate: 1 });
  const reversed = identification(measured, [sold, cand], 'sold', { reps: 15, validRate: 1 });

  assert.equal(forward.rank_stability, reversed.rank_stability,
    'the same evidence must produce the same stability in either order');
  assert.equal(forward.model, reversed.model);
  assert.equal(forward.impostor, reversed.impostor);
  // And the substance: 35% of draws carry no evidence at all, so this is not a name.
  assert.ok(forward.rank_stability < 0.8,
    `draws with no discriminating cell must not count as wins, got ${forward.rank_stability}`);
  assert.equal(forward.model, null);
  assert.equal(forward.impostor, false, 'an honest endpoint is not convicted by array order');
});

test('a big separation does not name a model the ranking cannot hold on to', () => {
  // 🔴 The two tests are not copies of each other. This fixture clears the separation bar
  // comfortably while the winner loses first place in a third of resampled draws — the
  // exact case a point estimate alone waves through.
  const { measured, sold, cand } = tieFixture();
  const id = identification(measured, [sold, cand], 'sold', { reps: 15, validRate: 1 });
  assert.ok(id.separation >= SEPARATION,
    `the gap itself is wide (${id.separation}) — it is the stability that must refuse`);
  assert.ok(id.rank_stability < RANKING_STABILITY);
  assert.equal(id.model, null, 'both bars must be cleared, not either one');
});

test('a third candidate stealing first place shows up in the stability, not the gap', () => {
  // 🔴 Why `rank_stability` replaced `separation_lo > 1`. The lower bound describes only the
  // two models that led on the full data; a third can take first place in draw after draw
  // while that pair's own gap stays perfectly stable, and nothing in the old number moved.
  const n = MIN_ID_CELLS + 4;
  const cells = Array.from({ length: n }, (_, i) => `w${i}|en`);
  const at = (f) => Object.fromEntries(cells.map((c, i) => [c, f(i)]));

  const measured = at(() => ({ p: 1 }));
  const sold = withSamples('sold', at(() => ({ q: 1 })));                       // nowhere near
  // Two rivals that each match most cells and miss a different one: on the full data one of
  // them leads, but which one flips with the draw.
  const rivalA = withSamples('rivalA', at((i) => (i === 0 ? { q: 1 } : { p: 0.97, q: 0.03 })));
  const rivalB = withSamples('rivalB', at((i) => (i === 1 ? { q: 1 } : { p: 0.97, q: 0.03 })));

  const id = identification(measured, [sold, rivalA, rivalB], 'sold', { reps: 15, validRate: 1 });
  assert.ok(['rivalA', 'rivalB'].includes(id.nearest));
  assert.ok(id.rank_stability < RANKING_STABILITY,
    `two interchangeable rivals cannot yield a stable winner, got ${id.rank_stability}`);
  assert.equal(id.model, null, 'and so neither is named');
});

test('modelFloors draws the reference side at ITS OWN sample count', () => {
  // 🔴 Having the option is not using it. `noiseFloor` learned an asymmetric draw; this
  // asserts `modelFloors` actually asks for it, because the reference is not another run of
  // this measurement — it is a stored fingerprint with exactly the samples it banked. A cell
  // where the library holds 30 and this run collected 15 is a 15-vs-30 comparison, and
  // drawing both at 15 overstates the floor by treating the library as no better sampled
  // than a single run. The floor is the denominator every separation divides by.
  const cells = Array.from({ length: MIN_ID_CELLS }, (_, i) => `w${i}|en`);
  const ref = {
    model: 'r',
    fingerprint: Object.fromEntries(cells.map((c) => [c, { a: 0.7, b: 0.3 }])),
    samples: cells.flatMap((c) => Array.from({ length: 30 },
      (_, k) => ({ cell: c, answer_class: 'valid', normalized: k % 10 < 7 ? 'a' : 'b' }))),
  };
  const pools = validAnswersByCell(ref.samples);
  const got = modelFloors([ref], cells, 15, { trials: 400 }).get('r').overall;
  const asymmetric = noiseFloor(pools, 15, { trials: 400, against: 'pool' }).overall;
  const symmetric = noiseFloor(pools, 15, { trials: 400 }).overall;

  assert.notEqual(asymmetric, symmetric, 'the fixture must distinguish the two draws');
  assert.equal(got, asymmetric, 'modelFloors must draw the reference at its own pool size');
  assert.notEqual(got, symmetric);
});

test('the per-draw floor follows the cells that draw took, not the whole battery', () => {
  // 🔴 The bootstrap resamples cells, so a draw's ratio is an average over the DRAWN cells.
  // Dividing that by one scalar averaged over ALL cells calibrates numerator and denominator
  // on different weightings — the same mismatch the shared cell set fixed one level up. With
  // eleven quiet cells and one noisy one it is a factor of several either way: a draw that
  // misses the noisy cell should be judged against ~0, one that takes it six times against
  // ~0.06, and the stored scalar says 0.01 to both.
  const n = MIN_ID_CELLS;
  const cells = Array.from({ length: n }, (_, i) => `w${i}|en`);
  const noisyAt = cells[0];
  // Quiet cells are deterministic (floor 0). The noisy one spreads over ten answers, so two
  // draws of fifteen land far apart — a coin flip is not enough, it floors at only ~0.03.
  const SPREAD = Array.from({ length: 10 }, (_, i) => `x${i}`);
  const uniformOverSpread = Object.fromEntries(SPREAD.map((a) => [a, 1 / SPREAD.length]));
  const fpOf = (answer) => Object.fromEntries(cells.map((c) =>
    [c, c === noisyAt ? uniformOverSpread : { [answer]: 1 }]));
  const samplesOf = (answer) => cells.flatMap((c) => Array.from({ length: 30 }, (_, k) => ({
    cell: c, answer_class: 'valid',
    normalized: c === noisyAt ? SPREAD[k % SPREAD.length] : answer,
  })));
  const refOf = (model, answer) => ({ model, fingerprint: fpOf(answer), samples: samplesOf(answer) });

  const floors = modelFloors([refOf('sold', 'b'), refOf('cand', 'a')], cells, 15, { trials: 200 });
  const perCell = floors.get('cand').byCell;
  assert.ok(perCell[0] > 0.1, `the noisy cell must actually be noisy, got ${perCell[0]}`);
  assert.ok(perCell.slice(1).every((f) => f === 0), 'and the rest must be quiet');
  // The scalar the old code used everywhere is the average — far from either regime.
  assert.ok(floors.get('cand').overall > 0 && floors.get('cand').overall < perCell[0] / 5,
    'a single scalar is neither of the two answers it is standing in for');

  // 🔴 The load-bearing comparison: the SAME bootstrap, once with per-cell floors and once
  // with each model's floor flattened to its own scalar — which is what the code did before.
  // If these come out equal the per-draw calibration is not reaching the ratio at all.
  const eligible = [refOf('sold', 'b'), refOf('cand', 'a')];
  const measured = fpOf('a');
  const flattened = new Map([...floors].map(([m, f]) =>
    [m, { overall: f.overall, byCell: f.byCell.map(() => f.overall) }]));

  const perDraw = rankingBootstrap(measured, eligible, cells, 'cand', { floors, sold: 'sold', trials: 400 });
  const scalar = rankingBootstrap(measured, eligible, cells, 'cand', { floors: flattened, sold: 'sold', trials: 400 });
  assert.ok(Number.isFinite(perDraw.lo) && Number.isFinite(scalar.lo));
  assert.notEqual(perDraw.lo, scalar.lo,
    'a scalar floor and a per-draw floor cannot produce the same interval on a heteroscedastic battery');
  // 🔴 LOWER, and the mechanism is the point. The 5% tail is made of draws that took the
  // noisy cell several times over; their real resolution limit is that cell's ~0.5, not the
  // battery average of ~0.04. The scalar divides those draws by the average and reports them
  // as though they could resolve a difference they cannot — an interval flattered by exactly
  // the draws that carry the least information.
  assert.ok(perDraw.lo < scalar.lo,
    `the noisy tail must be judged at its own limit, not the battery average ` +
    `(per-draw ${perDraw.lo}, scalar ${scalar.lo})`);
  assert.equal(perDraw.stability, scalar.stability,
    'the floor must not touch the RANKING — it divides, it does not reorder');

  // End to end: still runs, still reports a finite bound.
  const id = identification(measured, eligible, 'sold', { reps: 15, validRate: 1, trials: 200 });
  assert.equal(id.nearest, 'cand');
  assert.ok(Number.isFinite(id.separation_lo), 'the lower bound survives a heteroscedastic floor');
  assert.ok(id.separation_lo <= id.separation);
});

test('a lucky exact match against near-duplicate references is not certainty', () => {
  // 🔴 Two near-duplicate references, and a finite run that reproduces one exactly. The raw
  // ratio is ε/0 = Infinity — "infinitely certain" about a pair the method can barely tell
  // apart. The resolution floor is what stops that, and it is the LARGEST of the floors of
  // the models being divided, not just the defended one's: under the impostor hypothesis
  // the measurement's own scatter belongs to the NAMED candidate.
  const a = widen({ x: 0.5, y: 0.5 });
  const b = widen({ x: 0.53, y: 0.47 });
  const refs = [withSamples('a', a), withSamples('b', b)];
  const id = identification(widen({ x: 0.5, y: 0.5 }), refs, 'b', { reps: 15, validRate: 1 });

  assert.ok(id.floor > 0, 'two scattered references have a real resolution limit');
  assert.ok(!(id.separation_lo >= SEPARATION),
    `references this close cannot separate: lower bound ${id.separation_lo}`);
  assert.equal(id.impostor, false, 'and so nobody is accused');
});

test('an unknowable resolution limit refuses to name rather than assuming zero', () => {
  // References with no `samples` cannot report their own repeat-measurement noise. A ratio
  // taken against an unknown floor is exactly the mistake the floor was added to prevent.
  const refs = [{ model: 'a', fingerprint: widen({ x: 1 }) }, { model: 'b', fingerprint: widen({ y: 1 }) }];
  const id = identification(widen({ x: 1 }), refs, 'b', { reps: 15, validRate: 1 });
  assert.ok(Number.isNaN(id.floor));
  assert.equal(id.model, null);
  assert.equal(id.impostor, false);
  assert.equal(id.nearest, 'a', 'the ranking is still reported — only the name is withheld');
  assert.equal(id.withheld, 'floor',
    'and it says THIS bar, not the cell bar it happens to share a return object with');
  // 🔴 `leaning` too, or the reason is written and never rendered: the UI reaches
  // `withheldGloss` only through this flag, so inheriting `false` here made the 'floor'
  // wording unreachable on the one screen it exists for. [[guards-that-cannot-fail]] in its
  // presentation form — the explanation is correct, complete, and never shown.
  assert.equal(id.leaning, true, 'the nearest is not what was sold, so this is a finding');
});

test('every candidate is ranked over the SAME cells', () => {
  // 🔴 meanJsd intersects per pair. Ranked that way, a reference covering only the easy
  // half of the battery matches those exactly, scores 0, and beats a reference measured
  // over all of them — the cells it never answered are simply not counted against it.
  const measured = { 'c1|en': { a: 1 }, 'c2|en': { a: 1 }, 'c3|en': { a: 1 }, 'c4|en': { b: 1 } };
  const full = { 'c1|en': { a: 1 }, 'c2|en': { a: 1 }, 'c3|en': { a: 1 }, 'c4|en': { b: 1 } };
  const partial = { 'c1|en': { a: 1 }, 'c2|en': { a: 1 } };           // covers half, matches it

  // Per-pair intersection would put `partial` at 0 over 2 cells and `full` at 0 over 4 —
  // a tie decided by nothing. On the common set both are scored over the same 2 cells.
  const r = identify(measured, [{ model: 'full', fingerprint: full }, { model: 'partial', fingerprint: partial }],
    { minCells: 2 });
  assert.equal(r.cells, 2, 'the shared set is what every candidate is measured on');
  assert.ok(r.ranked.every((x) => x.cells === 2), 'no candidate is scored over its own subset');
});

test('the per-cell sample bar applies to the REFERENCE side too', () => {
  // 🔴 The measurement side drops any cell under ten valid samples. The reference side used
  // to accept a cell estimated from ONE — and that is the same protocol mismatch this
  // project keeps paying for, in its most expensive direction. Two ways it hurts, and they
  // compound: the one-sample cell enters the equal-weight mean as if it were as well
  // measured as the rest, and `noiseFloor` reads a single-element pool as perfectly
  // deterministic and floors it at 0 — so the least-measured cells claim the most
  // resolution, and the floor is the denominator every separation is divided by.
  //
  // `refresh-reference.js` only checks a collection's OVERALL valid rate, so a 40×30 run can
  // bank several such cells and still be saved.
  const n = MIN_ID_CELLS + 4;
  const cells = Array.from({ length: n }, (_, i) => `w${i}|en`);
  const fp = (answer) => Object.fromEntries(cells.map((c) => [c, { [answer]: 1 }]));
  // A reference whose last four cells came back only once each.
  const patchy = {
    model: 'patchy',
    fingerprint: fp('a'),
    samples: cells.flatMap((c, i) => Array.from({ length: i < n - 4 ? 30 : 1 },
      () => ({ cell: c, answer_class: 'valid', normalized: 'a' }))),
  };
  const measured = fp('a');

  const r = identify(measured, [withSamples('full', fp('b')), patchy]);
  assert.equal(r.cells, n - 4,
    'cells the reference measured once must not be compared on');
  assert.ok(r.ranked.every((x) => x.cells === n - 4), 'and every candidate is scored on that same set');

  // The floor must refuse them too, rather than reading a one-sample pool as noise-free.
  assert.equal(modelFloors([patchy], cells, 15, { trials: 50 }), null,
    'a floor over cells the reference barely measured is not a floor');
  assert.ok(modelFloors([patchy], cells.slice(0, n - 4), 15, { trials: 50 }),
    'and the well-measured cells still produce one');
});

test('a threadbare candidate cannot veto the whole library', () => {
  // 🔴 The other side of a shared cell set: one 2-cell reference dropped into a library of
  // full ones would collapse the intersection for everyone and silently switch naming off.
  // A reference that could never support a name does not get to remove one — and the ones
  // set aside are reported, so a shrunken set is never silent.
  const full = widen({ a: 1 }, MIN_ID_CELLS + 6);
  const other = widen({ b: 1 }, MIN_ID_CELLS + 6);
  const measured = widen({ a: 1 }, MIN_ID_CELLS + 6);
  const runt = { 'w0|en': { a: 1 }, 'w1|en': { a: 1 } };

  const refs = [withSamples('full', full), withSamples('other', other),
    { model: 'runt', fingerprint: runt, samples: [] }];
  const r = identify(measured, refs);
  assert.equal(r.cells, MIN_ID_CELLS + 6, 'the runt did not drag the shared set down');
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].model, 'runt');
  assert.equal(r.dropped[0].cells, 2, 'and it is reported, not hidden');
  assert.ok(!r.ranked.some((x) => x.model === 'runt'));
});

test('a candidate too thin to WIN can still refute a name', () => {
  // 🔴 The other edge of the same rule. Excluding an under-covered reference from the
  // ranking must not manufacture uniqueness: one that matches eleven of twelve cells
  // exactly cannot be named, but its existence destroys any claim that some other model
  // is the only answer.
  const n = MIN_ID_CELLS + 6;
  const measured = widen({ a: 1 }, n);
  const sold = widen({ b: 1 }, n);                       // far from the measurement
  const winner = widen({ a: 0.7, b: 0.3 }, n);           // closest of the eligible ones
  const runt = Object.fromEntries(Object.entries(widen({ a: 1 }, n)).slice(0, 3));  // exact, too thin

  const clean = identification(measured, [withSamples('sold', sold), withSamples('winner', winner)],
    'sold', { reps: 15, validRate: 1 });
  assert.equal(clean.model, 'winner', 'without the runt this is a confident name');

  const contested = identification(measured,
    [withSamples('sold', sold), withSamples('winner', winner), { model: 'runt', fingerprint: runt, samples: [] }],
    'sold', { reps: 15, validRate: 1 });
  assert.equal(contested.model, null, 'a nearer candidate refutes the name even unranked');
  assert.equal(contested.impostor, false);
  assert.ok(contested.refuted_by.some((c) => c.model === 'runt'));
});

test('the veto is decided head-to-head, not by two averages over different cells', () => {
  // 🔴 [[silent-comparison-mismatch]]. The dropped candidate's mean is over ITS cells and
  // the winner's is over ALL the shared ones, and the first version put `<=` between them.
  // Here the winner averages 0.33 over eighteen cells while sitting at 1.0 on the six the
  // candidate actually answers, and the candidate is at 0.5 on those same six. Compared as
  // stored: 0.5 > 0.33, no veto, and a name goes out that was never unique. Compared where
  // both were measured: 0.5 < 1.0, and it is not unique at all.
  const n = MIN_ID_CELLS + 6;
  const cells = Array.from({ length: n }, (_, i) => `w${i}|en`);
  const at = (f) => Object.fromEntries(cells.map((c, i) => [c, f(i)]));
  const thin = (f) => Object.fromEntries(cells.slice(0, 6).map((c, i) => [c, f(i)]));

  const measured = at(() => ({ p: 1 }));
  const sold = withSamples('sold', at(() => ({ q: 1 })));                 // 1.0 everywhere
  // Matches the last twelve exactly, misses the first six completely: mean 6/18 = 0.33.
  const winner = withSamples('winner', at((i) => (i < 6 ? { q: 1 } : { p: 1 })));
  // Only covers those first six. On them it sits at ~0.61 — nearer than the winner's 1.0
  // there, yet FURTHER than the winner's 0.33 overall. That gap between the two readings is
  // the whole point of the fixture.
  const rival = withSamples('rival', thin(() => ({ p: 0.2, q: 0.8 })));

  const alone = identification(measured, [sold, winner], 'sold', { reps: 15, validRate: 1 });
  assert.equal(alone.model, 'winner', 'without the rival the winner is a confident name');

  const contested = identification(measured, [sold, winner, rival], 'sold', { reps: 15, validRate: 1 });
  const veto = contested.refuted_by.find((c) => c.model === 'rival');
  assert.ok(veto, 'the rival must veto');
  assert.ok(veto.value > contested.distance,
    `it must veto DESPITE looking worse when the two means are compared as stored ` +
    `(${veto.value.toFixed(3)} vs the winner's ${contested.distance.toFixed(3)})`);
  assert.ok(veto.value_vs_best < veto.best_value_here,
    'the comparison that decides is on the cells they both answer');
  assert.equal(contested.model, null);
  assert.equal(contested.impostor, false);
});

test('a thin candidate that is genuinely further away does not veto', () => {
  // The other direction, or the rule above would just switch naming off whenever a small
  // reference exists. A candidate further away on the shared cells has no claim.
  const n = MIN_ID_CELLS + 6;
  const cells = Array.from({ length: n }, (_, i) => `w${i}|en`);
  const at = (f) => Object.fromEntries(cells.map((c, i) => [c, f(i)]));

  const measured = at(() => ({ p: 1 }));
  const sold = withSamples('sold', at(() => ({ q: 1 })));
  const winner = withSamples('winner', at(() => ({ p: 0.95, q: 0.05 })));
  const far = withSamples('far', Object.fromEntries(cells.slice(0, 5).map((c) => [c, { q: 1 }])));

  const id = identification(measured, [sold, winner, far], 'sold', { reps: 15, validRate: 1 });
  assert.deepEqual(id.refuted_by, [], 'nothing here contests the winner');
  assert.equal(id.model, 'winner');
  assert.equal(id.impostor, true);
  assert.ok(id.dropped_candidates.some((c) => c.model === 'far'),
    'it is still reported as set aside — a shrunken candidate set is never silent');
});

test('two near-equal candidates are refused a name', () => {
  // Exactly equidistant: the measured distribution sits halfway between the two.
  const a = { 'c1|en': { x: 0.45, y: 0.55 } };
  const b = { 'c1|en': { x: 0.50, y: 0.50 } };
  const measured = { 'c1|en': { x: 0.475, y: 0.525 } };
  const refs = [withSamples('a', widen(a['c1|en'])), withSamples('b', widen(b['c1|en']))];
  const id = identification(widen(measured['c1|en']), refs, 'a', { reps: 15, validRate: 1 });
  assert.equal(id.model, null, 'when two references are equally close, neither is the answer');
});

test('a lone reference is never a match by default', () => {
  // "The only model we hold a reference for" is not an identification.
  const refs = [withSamples('only', widen({ a: 1 }))];
  assert.equal(identify(widen({ a: 1 }), refs).best.model, 'only');
  const id = identification(widen({ a: 1 }), refs, 'sold', { reps: 15, validRate: 1 });
  assert.equal(id.model, null);
  assert.ok(Number.isNaN(id.separation_lo));
  assert.equal(id.impostor, false, 'a lone candidate must never produce an accusation');
});

test('a measurement with nothing comparable is a FINDING, not a missing check', () => {
  // 🔴 `null` is reserved for "never asked". A run whose cells all fell under the sample
  // bar used to be stored identically to one that was handed no library at all.
  const id = identification({}, [withSamples('a', widen({ x: 1 }))], 'a', { reps: 15, validRate: 1 });
  assert.notEqual(id, null, 'asked-and-nothing-matched must not look like never-asked');
  assert.equal(id.cells, 0);
  assert.equal(id.nearest, null);
  assert.equal(id.impostor, false);
});

test('the winner is the closest reference, not the first one handed in', () => {
  // 🔴 Every other case here happens to list the right answer first, so dropping the sort
  // left them all green — a mutation caught that. Order the input adversarially.
  const target = { 'c1|en': { a: 1 }, 'c2|en': { b: 1 } };
  const decoy = { 'c1|en': { z: 1 }, 'c2|en': { z: 1 } };
  const measured = { 'c1|en': { a: 0.9, z: 0.1 }, 'c2|en': { b: 0.9, z: 0.1 } };

  const r = identify(measured, [{ model: 'decoy', fingerprint: decoy }, { model: 'target', fingerprint: target }],
    { minCells: 2 });
  assert.equal(r.best.model, 'target', 'the answer is last in the input array');
  assert.equal(r.runnerUp.model, 'decoy');
  assert.ok(r.ranked[0].value < r.ranked[1].value, 'ranked must come back ascending');
});

test('the dated-snapshot predicate covers both backup forms', () => {
  // 🔴 This pattern lived twice — here and in ui/scripts/build-data.js — and the second
  // copy was missing the `-N` form. One extra backup file would then have given the CLI
  // and the browser DIFFERENT candidate libraries: the browser ranking a near-duplicate of
  // the sold model as runner-up, separation collapsing under the bar, an accusation
  // quietly turning into a shrug. The browser's own bit-for-bit proof could not see it,
  // because both sides of that proof used the browser's list.
  for (const backup of ['gpt-5.6-sol.2026-08-14', 'gpt-5.6-sol.2026-08-14-1', 'gpt-5.4.2026-01-02-12']) {
    assert.equal(isDatedSnapshot(backup), true, `${backup} is a backup`);
  }
  for (const current of ['gpt-5.6-sol', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']) {
    assert.equal(isDatedSnapshot(current), false, `${current} is a live reference — the model name has dots`);
  }
});

test('the CLI export carries everything a consumer decides on', { timeout: 60_000 }, () => {
  // 🔴 An integration test, and it has to be: the export is built in `scripts/`, nothing
  // else imports it, and `live` was left out of it the moment it was added — a consumer
  // feeding that file to `pickControl` then sees zero discriminating cells for every
  // candidate and refuses the whole library. The script now spreads the whole result rather
  // than enumerating fields, which is the structural fix; this is what notices if anyone
  // enumerates again.
  const out = path.join(tmpdir(), `mm-export-${process.pid}.json`);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/model-matrix.js'), '--json', out],
    { cwd: ROOT, stdio: 'ignore' });
  const payload = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });

  // The CLI writes one protocol's payload at the top level.
  const one = payload.models ? payload : (payload.responses ?? Object.values(payload)[0]);
  for (const key of ['models', 'matrix', 'floors', 'pairFloors', 'cells', 'live']) {
    assert.ok(one[key] !== undefined, `the export is missing \`${key}\`, which a reader decides on`);
  }
  assert.ok(Number.isFinite(one.pairFloors[0][1]), 'pairFloors must be real numbers');
  assert.ok(Number.isInteger(one.live[0][1]), 'live must be a count');
});
