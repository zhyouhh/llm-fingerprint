// The L2 verdict — the layer that decides whether a relay swapped the model.
//
// It had no tests at all, and five defects were sitting in it at once. Each one below is
// pinned by a construction that lands squarely in the regime it broke:
//   1. `suspect` convicted on a point estimate while `consistent` needed an interval —
//      backwards for a tool whose expensive error is accusing an honest relay.
//   2. A harness term below the noise floor abandoned the run as "measured nothing",
//      when it is in fact the best case a control can produce.
//   3. The reported S/H and the tested S/H were different numbers.
//   4. makeL2Result silently dropped `reason`, so no explanation ever reached anyone.
//   5. The bootstrap sorted with `(a, b) => a - b`, so once a ratio could be Infinity the
//      interval came out [0, 0] and four-of-six-cells-different read as CONSISTENT.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateL2, CONSISTENT_RATIO, SUSPECT_RATIO } from '../src/layers/l2-calibrate.js';
import { VERDICT, SAMPLE_KIND, l2LogicalPerSide, assertL2Result } from '../src/contracts.js';
import { MIN_ID_CELLS, identification } from '../src/layers/model-matrix.js';
import { noiseFloor, validAnswersByCell, pairBias, REFERENCE_MIN_N } from '../src/stats/noise.js';
import { ratioCI } from '../src/stats/bootstrap.js';

const CELLS = ['c1|en', 'c2|en', 'c3|en', 'c4|en', 'c5|en', 'c6|en'];
const REPS = 15;

/** Samples for one model: `answers[cell]` is the repeating answer pattern for that cell. */
function samplesFor(model, answers) {
  const out = [];
  for (const cell of CELLS) {
    const [task_id, lang] = cell.split('|');
    const pattern = answers[cell];
    for (let i = 0; i < REPS; i++) {
      out.push({
        kind: SAMPLE_KIND.FINGERPRINT, state: 'valid', attempts: 1, model,
        task_id, lang, rep: i, normalized: pattern[i % pattern.length],
      });
    }
  }
  return out;
}

/** A reference file: the fingerprint, plus the raw rows the noise floor is measured from. */
function referenceFor(answers, model = 'subj-model') {
  const fingerprint = {};
  const samples = [];
  for (const cell of CELLS) {
    const pattern = answers[cell];
    const counts = {};
    for (let i = 0; i < 30; i++) {
      const a = pattern[i % pattern.length];
      counts[a] = (counts[a] ?? 0) + 1;
      samples.push({ cell, answer_class: 'valid', normalized: a });
    }
    fingerprint[cell] = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / 30]));
  }
  // `model` is what the identification route defends: a match on this name is a
  // confirmation, a match on any other is an accusation.
  return { model, fingerprint, samples };
}

const selection = {
  cells: CELLS.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })),
  repsPerCell: REPS,
};

/** Same pattern in every cell. */
const every = (...pattern) => Object.fromEntries(CELLS.map((c) => [c, pattern]));
/** `pattern` everywhere, except the first `k` cells which answer something else entirely. */
function withOffCells(pattern, k, off = 'zzz') {
  const a = every(...pattern);
  for (let i = 0; i < k; i++) a[CELLS[i]] = [off];
  return a;
}

// A varied pattern gives a NON-zero noise floor; a constant one gives a floor of exactly
// zero. Both regimes are real — the project has produced a reference cell of thirty
// identical answers twice — and they break differently, so both are exercised.
const VARIED = ['a', 'a', 'a', 'a', 'b'];
const CTRL = ['x', 'x', 'x', 'x', 'y'];

/**
 * `refs: null` by default — these cases are about the H/S/D arithmetic, and supplying a
 * library would let the identification route decide some of them before the arithmetic
 * ran. The route has its own tests at the bottom of this file.
 */
function judge({ subject, control, refSubject, refControl, refs = null }) {
  return evaluateL2({
    subjectSamples: samplesFor('subj', subject),
    controlSamples: samplesFor('ctl', control),
    refSubject: referenceFor(refSubject),
    refControl: referenceFor(refControl, 'ctl-model'),
    selection, refs,
  });
}

test('the two sides carry their own denominators, and 90 is the per-side budget', () => {
  const r = judge({
    subject: every(...VARIED), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  // 🔴 The denominator follows THIS selection (6 cells × 15), not a frozen 90.
  assert.equal(r.subject.logical_samples, l2LogicalPerSide(selection));
  assert.equal(r.control.logical_samples, CELLS.length * REPS);
  assert.ok(!('valid_rate' in r), 'a merged rate would hide a dead control side');
});

test('a control identical on both sides is the best case, not an unjudgeable one', () => {
  // 🔴 The regime that used to be abandoned outright. The control matches perfectly, so
  // H_c is zero; the subject is off by less than the noise floor. Without a floor under
  // the denominator this is 0.0068/0 = Infinity and never consistent.
  const r = judge({
    subject: every('a', 'a', 'a', 'b', 'b'), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.equal(r.h_c, 0);
  assert.ok(r.s_c > 0, 'the subject must actually differ, or the floor is not being exercised');
  assert.ok(r.s_c < r.noise_floor);
  assert.equal(r.denominator_basis, 'noise floor');
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  // 🔴 And it must SAY so, on the file — this is the field makeL2Result used to drop.
  assert.match(r.reason, /below the noise floor/);
  assert.ok(r.per_cell?.h && r.per_cell?.s && r.per_cell?.d);
});

test('a zero harness term must not wave through a subject outside the noise floor', () => {
  const r = judge({
    subject: every('a', 'a', 'a', 'a', 'c'), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.equal(r.h_c, 0);
  assert.ok(r.s_c > r.noise_floor);
  assert.notEqual(r.verdict, VERDICT.CONSISTENT);
});

test('a never-varying control must not make a wildly different subject consistent', () => {
  // 🔴 Constant patterns → noise floor exactly 0 → every resampled S/H is either 0 or
  // Infinity. Sorted with `a - b` that array came back as [0, 0] and this exact input —
  // four of six cells answering something else entirely — was judged CONSISTENT.
  const r = judge({
    subject: withOffCells(['a'], 4), control: every('x'),
    refSubject: every('a'), refControl: every('x'),
  });
  assert.equal(r.noise_floor, 0);
  assert.notEqual(r.verdict, VERDICT.CONSISTENT);
  assert.ok(r.ratio_ci_hi >= r.ratio_ci_lo, 'the interval must not come out inverted');
  assert.ok(!(r.ratio_ci_hi < CONSISTENT_RATIO), 'a subject this far off cannot have a tight low interval');
});

test('accusing requires the whole interval, not just the point estimate', () => {
  // Five of six cells off: the mean clears the suspect line, but a resample that misses
  // those cells does not. Before the fix the point estimate alone convicted.
  const r = judge({
    subject: withOffCells(VARIED, 5), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.ok(r.sd_ratio >= SUSPECT_RATIO, `point estimate ${r.sd_ratio} should clear ${SUSPECT_RATIO}`);
  assert.ok(r.sd_ci_lo < SUSPECT_RATIO, `interval lower bound ${r.sd_ci_lo} should fall below it`);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.match(r.reason, /interval falls to/);
});

test('a subject different in every cell is convicted, interval and all', () => {
  const r = judge({
    subject: withOffCells(VARIED, 6), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.ok(r.sd_ci_lo >= SUSPECT_RATIO, `interval lower bound ${r.sd_ci_lo} must clear ${SUSPECT_RATIO}`);
  assert.equal(r.verdict, VERDICT.SUSPECT);
});

test('a collapsed D blocks CONSISTENT too, not just SUSPECT', () => {
  // 🔴 The false green this guard exists for, and it was measured, not imagined: relay-B
  // returned H_c 0.3286, S_c 0.2325, D_c 0.0791 against a floor of 0.0833 and was reported
  // CONSISTENT — the enormous H swallowed the enormous S. Both models were off; nothing was
  // a harness. The check used to sit after the consistent branch, so it never ran.
  //
  // Here: the control does NOT match its reference (so H is large), and the relay returns
  // the same thing for both names (so D collapses).
  const r = judge({
    subject: every('same'), control: every('same'),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.ok(r.h_c > r.noise_floor, 'H must be large, or this is not the regime being tested');
  assert.ok(r.d_c < r.noise_floor, 'D must have collapsed');
  assert.ok(r.ratio_ci_hi < CONSISTENT_RATIO, 'and S/H must otherwise PASS — that is the trap');
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.match(r.reason, /BOTH model names/);
});

test('a relay serving the control model under both names has no scale to be judged against', () => {
  // The realistic version: the control matches its reference exactly (H ≈ 0), and the
  // subject comes back as the control. D — the yardstick for "what a different model looks
  // like" — collapses to zero, because on this relay the two names ARE the same thing.
  //
  // S/D would read enormous and convict; that number is an artefact of a zero denominator,
  // not evidence. The honest output is `inconclusive` plus the specific fact, which is
  // alarming on its own terms and is what the reader needs to act on.
  const r = judge({
    subject: every(...CTRL), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.equal(r.h_c, 0, 'the control must match its reference, or H explains the gap');
  assert.ok(r.d_c < r.noise_floor);
  assert.ok(r.s_c > r.noise_floor);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.match(r.reason, /BOTH model names/);
});

test('the reported ratio is the ratio the verdict tested', () => {
  // 🔴 These used to be two different numbers: the test compared corrected means while the
  // printed interval was built from raw per-cell values. One run printed S/H = 1.94 while
  // the comparison it fed was evaluating 20.8.
  const r = judge({
    subject: every('a', 'a', 'a', 'a', 'c'), control: every('x', 'x', 'x', 'y', 'y'),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  const tested = r.s_c / Math.max(r.h_c, r.noise_floor);
  assert.ok(Math.abs(r.ratio - tested) < 1e-9,
    `reported ${r.ratio} must BE the tested quantity ${tested}, not merely resemble it`);
  assert.ok(r.ratio_ci_lo <= r.ratio && r.ratio <= r.ratio_ci_hi,
    'the point estimate must lie inside its own interval');
});

test('the per-side denominator follows the selection, it is not a frozen 90', () => {
  // 🔴 It WAS frozen — `90 = 6 cells × 15 reps`, written when the reference held eight
  // cells. Growing the battery to the paper's full forty made every L2 run die on
  // "435 samples exceed the declared denominator 90".
  const wide = {
    cells: [...CELLS, 'c7|en', 'c8|en'].map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })),
    repsPerCell: REPS,
  };
  assert.equal(l2LogicalPerSide(selection), CELLS.length * REPS);
  assert.equal(l2LogicalPerSide(wide), (CELLS.length + 2) * REPS);
  assert.notEqual(l2LogicalPerSide(wide), l2LogicalPerSide(selection));
});

test('a run with no control says so, and takes its scale from the references', () => {
  // Half the probes. The control is what measures the harness, so dropping it means the
  // harness is assumed zero — safe only on a wire where it has been measured small, and
  // the result has to carry that caveat rather than imply a harness was accounted for.
  const args = {
    subject: every(...VARIED), refSubject: every(...VARIED), refControl: every(...CTRL),
  };
  const withControl = judge({ ...args, control: every(...CTRL) });
  const without = evaluateL2({
    subjectSamples: samplesFor('subj', args.subject),
    controlSamples: null,
    refSubject: referenceFor(args.refSubject), refControl: referenceFor(args.refControl, 'ctl-model'),
    selection, refs: null,
  });

  assert.equal(without.control, null, 'not measured is not the same claim as measured zero');
  assert.ok('control' in without, 'the key must still be there — an absent side reads as an oversight');
  assert.match(without.denominator_basis, /control not sampled/);
  assert.ok(Number.isNaN(without.h_c) || without.h_c === 0);

  // D now measures the model PAIR on ground truth rather than on the relay, so it is a
  // real number even though nothing was sampled for the control.
  assert.ok(Number.isFinite(without.d) && without.d > 0);
  assert.equal(without.verdict, VERDICT.CONSISTENT, 'a subject matching its reference still passes');
  assert.equal(withControl.verdict, VERDICT.CONSISTENT);
});

test('dropping the control does not silently drop the not-applicable gate', () => {
  const dead = samplesFor('subj', every('a')).map((s) => ({ ...s, state: 'empty_completion', normalized: null }));
  const r = evaluateL2({
    subjectSamples: dead, controlSamples: null,
    refSubject: referenceFor(every(...VARIED)), refControl: referenceFor(every(...CTRL), 'ctl-model'),
    selection, refs: null,
  });
  assert.equal(r.verdict, VERDICT.NOT_APPLICABLE);
});

test('a no-control run survives the round trip through a result file', async () => {
  // 🔴 "Not sampled" has to come back as null, not as an empty array. Filtering the stored
  // rows for the control model yields [] either way, and [] reads as "the control answered
  // nothing" — which drove every re-judged --no-control run to not_applicable.
  const { rejudgeL2 } = await import('../src/layers/rejudge.js');
  const stored = {
    meta: {
      tier: 'l2', model: 'gpt-5.6-sol', control: 'gpt-5.4', fingerprint_protocol: 'responses',
      cells: ['num100-random|en'], reps_per_cell: 15, sampled_control: false,
    },
    samples: [],
  };
  // Reaching evaluateL2 at all is the point; the references exist on disk for this wire.
  const out = rejudgeL2(stored);
  assert.notEqual(out.result.verdict, undefined);
  assert.equal(out.result.control, null, 'the control side must stay null through the round trip');
  assert.ok(!/control: valid rate/.test(out.result.reason ?? ''), 'the control gate must not fire on a side that was never sampled');
});

/* ── the identification route to `suspect` ──────────────────────────────────
 *
 * 🔴 Why this route exists at all, measured rather than argued. S/D cannot convict a swap
 * to a NEAR neighbour: such a swap puts S at roughly the genuine neighbour distance, so
 * the ratio lands near 1.0 with a ±30% cluster-bootstrap interval, and the rule wants the
 * whole interval above 0.7. Across every stored L2 in this project, S/D convicted 0 of 4
 * confirmed substitutions with D from the furthest reference and 1 of 4 with D from the
 * nearest. Adding probes cannot help — the battery already uses every live cell and the
 * bootstrap resamples cells, not samples. This route got 4 of 4 with no false accusation
 * against 5 confirmed-genuine runs. */

/** A library of `n` distinct references, cell patterns supplied per model. */
const library = (entries) => Object.entries(entries)
  .map(([model, answers]) => ({ model, ...referenceFor(answers, model) }));

/** Enough distinct cells that the identification is allowed to name anything at all. */
const WIDE = Array.from({ length: 14 }, (_, i) => `w${i}|en`);

const wideBuild = (answers, model) => {
  const fingerprint = {};
  const samples = [];
  for (const cell of WIDE) {
    const counts = {};
    for (let i = 0; i < 30; i++) {
      const a = answers[cell][i % answers[cell].length];
      counts[a] = (counts[a] ?? 0) + 1;
      samples.push({ cell, answer_class: 'valid', normalized: a });
    }
    fingerprint[cell] = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / 30]));
  }
  return { model, fingerprint, samples };
};

const wideRows = (answers, model) => WIDE.flatMap((cell) => {
  const [task_id, lang] = cell.split('|');
  return Array.from({ length: REPS }, (_, i) => ({
    kind: SAMPLE_KIND.FINGERPRINT, state: 'valid', attempts: 1, model,
    task_id, lang, rep: i, normalized: answers[cell][i % answers[cell].length],
  }));
});

function wideJudge({ subjectAnswers, refAnswers, refs, controlAnswers = null, refControlAnswers = null }) {
  return evaluateL2({
    subjectSamples: wideRows(subjectAnswers, 'subj'),
    controlSamples: controlAnswers ? wideRows(controlAnswers, 'ctl') : null,
    refSubject: wideBuild(refAnswers, 'sold-model'),
    refControl: wideBuild(refControlAnswers ?? Object.fromEntries(WIDE.map((c) => [c, ['ctl']])), 'ctl-model'),
    selection: { cells: WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })), repsPerCell: REPS },
    refs: refs.map((r) => wideBuild(r.answers, r.model)),
  });
}

/**
 * A model that answers `answer` most of the time. NOT deterministic on purpose: a
 * reference of thirty identical answers has a resolution floor of exactly zero, and
 * `identification` now refuses to name against an unknowable floor rather than reading a
 * lucky exact match as certainty. Real models scatter; the fixtures should too.
 */
const uniform = (cells, answer, minority = `${answer}-alt`) =>
  Object.fromEntries(cells.map((c) => [c, [answer, answer, answer, answer, minority]]));

test('a distribution shaped like a model that was not sold is convicted and named', () => {
  const r = wideJudge({
    subjectAnswers: uniform(WIDE, 'luna'),
    refAnswers: uniform(WIDE, 'sol'),
    refs: [{ model: 'sold-model', answers: uniform(WIDE, 'sol') },
           { model: 'other-model', answers: uniform(WIDE, 'luna') },
           { model: 'third-model', answers: uniform(WIDE, 'terra') }],
  });
  assert.equal(r.verdict, VERDICT.SUSPECT);
  assert.equal(r.identification.impostor, true);
  assert.equal(r.identification.model, 'other-model');
  assert.match(r.reason, /other-model/, 'the name must reach the reader, not just the flag');
});

test('a thinned sample reports the name but does not convict on it', () => {
  // 🔴 The survivors of a rate-limited run are not a random subset. Measured on two real
  // runs: 102 and 137 of one side's 420 probes died on HTTP 429 and zero on the other, and
  // the cells that died averaged S = 0.140 against 0.211 for those that lived. Resampling
  // the survivors cannot see that — `rank_stability` will read ~1.0 on a set selected FOR
  // agreeing with the wrong reference — so the valid rate is the only thing that can stop
  // it. 29 cells × 15 reps needs only the first twelve cells to survive to clear both the
  // 20% floor and the twelve-cell bar.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  const refs = [wideBuild(uniform(WIDE, 'sol'), 'sold-model'), wideBuild(uniform(WIDE, 'luna'), 'other-model')];
  // The shape rate limiting actually produces: two cells wiped out entirely and the rest
  // thinned to the bare minimum that still counts. Twelve live cells (enough to name on) at
  // ten samples each — 120 valid of 210, a 57% rate, squarely inside [0.20, 0.80).
  const kill = (s) => ({ ...s, state: 'transport_failure', normalized: null });
  const dead = wideRows(uniform(WIDE, 'luna'), 'subj')
    .map((s) => {
      const idx = WIDE.indexOf(`${s.task_id}|${s.lang}`);
      return idx >= MIN_ID_CELLS || s.rep >= 10 ? kill(s) : s;
    });
  const r = evaluateL2({
    subjectSamples: dead, controlSamples: null,
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells, repsPerCell: REPS },
    refs,
  });
  assert.ok(r.subject.valid_rate >= 0.20 && r.subject.valid_rate < 0.80,
    `the fixture must land in the low-confidence band, got ${r.subject.valid_rate}`);
  // 🔴 The bar lives inside `identification`, so `impostor` is false everywhere — including
  // in the report and the CLI, which both re-run this function from the stored samples. It
  // used to be suppressed only in `evaluateL2`'s verdict, and the page reads `impostor`
  // BEFORE it reads the verdict: a run held back at 57% still opened as a red accusation.
  assert.equal(r.identification.impostor, false, 'the gate has to travel with the object it guards');
  assert.equal(r.identification.model, null);
  assert.equal(r.identification.withheld, 'valid_rate', 'and it has to say which bar stopped it');
  // …but the finding is not thrown away. Silence here is the burial this layer exists to undo.
  assert.equal(r.identification.nearest, 'other-model', 'the ranking still ran and still says luna');
  assert.equal(r.identification.leaning, true);
  assert.notEqual(r.verdict, VERDICT.SUSPECT, 'and it must not convict on a sample this thin');
  assert.notEqual(r.verdict, VERDICT.CONSISTENT,
    'and it must not fall through to a clean bill of health either — both routes read the same survivors');
  assert.equal(r.low_confidence, true);
  // 🔴 Reported, not buried. Silence here is the failure this project already made once,
  // when a page wrote "证据不足" over an identification that had named luna at 3.55×.
  assert.match(r.reason, /other-model/, 'the leaning must reach the reader');
  assert.match(r.reason, /not random/, 'and so must the reason it was not acted on');
});

test('the floor is measured at what each cell GOT, not at what the run planned', () => {
  // 🔴 A genuine-endpoint conviction path, and the reason it is subtle: this run passes the
  // valid-rate bar comfortably (86%), so nothing else stops it. Two cells came back with ten
  // samples instead of fifteen; ten samples scatter further than fifteen, so those cells'
  // true resolution limit is higher. Taking `selection.repsPerCell` for every cell understates
  // the floor, and the floor is the DENOMINATOR of the separation — understating it inflates
  // every ratio, in the direction of accusing. Which cells get thinned is decided by which
  // minute the quota ran out in.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  const refs = [wideBuild(uniform(WIDE, 'sol'), 'sold-model'), wideBuild(uniform(WIDE, 'luna'), 'other-model')];
  const thinned = new Set(WIDE.slice(0, 2));
  const samples = wideRows(uniform(WIDE, 'luna'), 'subj').map((s) => (
    thinned.has(`${s.task_id}|${s.lang}`) && s.rep >= 10
      ? { ...s, state: 'transport_failure', normalized: null }
      : s));
  const run = () => evaluateL2({
    subjectSamples: samples, controlSamples: null,
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells, repsPerCell: REPS },
    refs,
  });
  const r = run();
  assert.ok(r.subject.valid_rate >= 0.80,
    `this must clear the valid-rate bar, or a different guard is doing the work (${r.subject.valid_rate})`);

  // Rebuild the same distribution the layer saw, so the two floors below differ in exactly
  // one thing: the counts they were told each cell came back with.
  const measured = {};
  const counts = {};
  for (const s of samples) {
    if (s.state !== 'valid') continue;
    const c = `${s.task_id}|${s.lang}`;
    (counts[c] ??= {})[s.normalized] = (counts[c][s.normalized] ?? 0) + 1;
  }
  const reps = {};
  for (const [c, v] of Object.entries(counts)) {
    const n = Object.values(v).reduce((a, b) => a + b, 0);
    reps[c] = n;
    measured[c] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x / n]));
  }
  assert.ok(Object.values(reps).some((n) => n === 10) && Object.values(reps).some((n) => n === 15),
    'the fixture must actually be uneven');

  const honest = identification(measured, refs, 'sold-model', { reps, validRate: r.subject.valid_rate });
  const optimistic = identification(measured, refs, 'sold-model', { reps: REPS, validRate: r.subject.valid_rate });
  assert.ok(honest.floor > optimistic.floor,
    `thinner cells must widen the floor (${honest.floor} vs ${optimistic.floor})`);
  assert.ok(honest.separation < optimistic.separation,
    'and a wider floor must make the accusation harder, not easier');
  // What evaluateL2 actually used has to be the honest one.
  assert.equal(r.identification.floor, honest.floor,
    'evaluateL2 must pass the per-cell counts, not the planned reps');
});

test('the noise floor describes the cells the comparison actually ran on', () => {
  // 🔴 H, S and D all have this subtracted and S/D divides by it, so every way of getting it
  // wrong moves a verdict. It used to be a mean over ALL the reference's cells at the
  // PLANNED reps, while H/S/D are computed over the LIVE ones — cells excluded from the
  // comparison still pulled the number, and a cell the reference measured once contributes
  // a floor of 0. Codex's arithmetic: three live cells each floored at 0.15, in a battery of
  // forty, report 0.011; S/D then reads 0.74 where the honest calibration says 0.33, and a
  // genuine endpoint comes back SUSPECT.
  const live = WIDE.slice(0, 4);
  const dead = WIDE.slice(4);
  // Live cells are scattered (real floor); the excluded ones are deterministic (floor 0)
  // and would drag the average down if they were counted.
  const answers = Object.fromEntries(WIDE.map((c) => [c, live.includes(c) ? ['a', 'b'] : ['z']]));
  const ref = wideBuild(answers, 'sold-model');
  // Only the live cells come back at all, so `usableCells` keeps exactly those four.
  const samples = wideRows(answers, 'subj')
    .filter((r) => live.includes(`${r.task_id}|${r.lang}`));

  const r = evaluateL2({
    subjectSamples: samples, controlSamples: null,
    refSubject: ref,
    refControl: wideBuild(Object.fromEntries(WIDE.map((c) => [c, ['ctl']])), 'ctl-model'),
    selection: { cells: WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })), repsPerCell: REPS },
    refs: null,
  });
  assert.equal(r.live_cells, live.length, 'the fixture must have exactly the live cells it plans to');

  const pools = validAnswersByCell(ref.samples);
  // Same options the layer uses: live cells, each at its actual count, against the
  // reference's own pool size.
  const onLive = noiseFloor(Object.fromEntries(Object.entries(pools).filter(([c]) => live.includes(c))),
    Object.fromEntries(live.map((c) => [c, REPS])), { trials: 400, against: 'pool' }).overall;
  const onAll = noiseFloor(pools, REPS, { trials: 400, against: 'pool' }).overall;
  assert.ok(onLive > onAll * 1.5,
    `the excluded cells must actually distort the average (live ${onLive} vs all ${onAll})`);
  assert.equal(r.noise_floor, onLive,
    'the reported floor must be the one measured on the cells that were compared');
});

test('H, S and D each carry their own floor, because they are three comparisons', () => {
  // 🔴 S is this run's subject against a STORED subject reference; H is this run's control
  // against a stored control reference; D — with a control sampled — is one measurement
  // against another. Their resolution limits differ, and one number cannot calibrate all
  // three. A single symmetric floor was right for D and wrong for S; making it right for S
  // (drawing the reference at its own pool size) made it wrong for D, which is worse rather
  // than neutral: on a 40-cell construction with S 0.230, D 0.285, H 0, the symmetric floor
  // 0.113 gives S/D 0.680 and CONSISTENT, and the pool floor 0.089 gives 0.719 — convicting
  // a genuine endpoint.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  // The two references are sampled to different depths, so the three floors must differ.
  const refS = wideBuild(uniform(WIDE, 'sol'), 'sold-model');
  const refC = wideBuild(uniform(WIDE, 'ctl'), 'ctl-model');
  refC.samples = refC.samples.filter((_, i) => i % 3 !== 0);       // thinner control library

  const r = evaluateL2({
    subjectSamples: wideRows(uniform(WIDE, 'sol'), 'subj'),
    controlSamples: wideRows(uniform(WIDE, 'ctl'), 'ctl'),
    refSubject: refS, refControl: refC,
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });

  assert.ok(Number.isFinite(r.noise_floor) && Number.isFinite(r.noise_floor_h)
    && Number.isFinite(r.noise_floor_d), 'all three are reported');
  assert.notEqual(r.noise_floor, r.noise_floor_h,
    'S and H are measured against libraries of different depth, so their floors differ');
  // 🔴 D is a CROSS-model quantity, so its correction is the sampling BIAS of a distance
  // that is genuinely large — not a same-model floor, whose true value is zero and which is
  // therefore all bias. Those differ by more than an order of magnitude: for P = {a:1}
  // against Q = {a:25/30, b:5/30} at thirty a side, the true JSD is 0.0888 and the bias is
  // 0.00098 while Q's own floor is 0.0134. Substituting the floor over-subtracts, and D is
  // a DENOMINATOR — a smaller D raises S/D toward the accusation line, so the error runs
  // the unsafe way.
  assert.ok(r.noise_floor_d < r.noise_floor,
    `D's correction is a cross-model bias and must be far smaller than a same-model floor ` +
    `(D ${r.noise_floor_d} vs S ${r.noise_floor})`);
  const sameModelProxy = Math.max(
    noiseFloor(validAnswersByCell(refS.samples), REPS, { trials: 400 }).overall,
    noiseFloor(validAnswersByCell(refC.samples), REPS, { trials: 400 }).overall);
  assert.ok(sameModelProxy > r.noise_floor_d * 3,
    `the old same-model proxy (${sameModelProxy}) must be visibly larger than the honest ` +
    `cross-model bias (${r.noise_floor_d}), or this fixture proves nothing`);

  // And the corrections actually use them, rather than all three sharing one. `correct`
  // clamps at zero, so compare against the same clamp rather than the raw subtraction.
  const clamp = (x, f) => Math.max(0, x - f);
  assert.equal(r.d_c, clamp(r.d, r.noise_floor_d), 'D is corrected by D\'s floor');
  assert.equal(r.s_c, clamp(r.s, r.noise_floor), 'S is corrected by S\'s floor');
  assert.equal(r.h_c, clamp(r.h, r.noise_floor_h), 'H is corrected by H\'s floor');
  // The distinguishing check: correcting D by S's floor would give a different number.
  assert.notEqual(clamp(r.d, r.noise_floor_d), clamp(r.d, r.noise_floor),
    'the floors must be far enough apart that using the wrong one is visible');
});

test('the denominator floor is what the MEASUREMENT resolves, not the denominator\'s own noise', () => {
  // 🔴 `correctDen` and `denomFloor` answer different questions and setting them alike
  // breaks the guard exactly where it earns its keep. `denomFloor` is "the smallest
  // denominator we will divide by" — the subject's resolution limit. Set it to H's instead
  // and a control reference that never varies floors at 0, so the denominator may be 0 and
  // the ratio goes to Infinity: measured, relay-C's S/H stopped being a number at all and two
  // genuine endpoints left CONSISTENT for the arithmetic rather than the evidence.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  // A control that is identical on both sides AND deterministic in its reference: H is 0
  // and so is H's own floor.
  const ctlAnswers = Object.fromEntries(WIDE.map((c) => [c, ['ctl']]));
  // 🔴 The subject must ALSO be off its reference, or the numerator is zero and `ratioCI`
  // short-circuits to 0 before the denominator can matter — the fixture would then pass
  // whatever `denomFloor` is set to, which is the trap this whole review keeps finding.
  const drifted = Object.fromEntries(WIDE.map((c) => [c, ['sol', 'sol', 'drift', 'drift', 'drift']]));
  const r = evaluateL2({
    subjectSamples: wideRows(drifted, 'subj'),
    controlSamples: wideRows(ctlAnswers, 'ctl'),
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(ctlAnswers, 'ctl-model'),
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  assert.equal(r.noise_floor_h, 0, 'the fixture must actually produce a zero H floor');
  assert.ok(r.noise_floor > 0, 'while the subject side still has one');
  assert.ok(r.s_c > 0, 'and the numerator must be non-zero, or the denominator never matters');
  assert.ok(Number.isFinite(r.ratio) && Number.isFinite(r.ratio_ci_hi),
    `S/H must stay a number when the control cannot vary (got ${r.ratio}, hi ${r.ratio_ci_hi})`);
  assert.equal(r.denominator_basis, 'noise floor');
});

test('S/D corrects its denominator by D\'s floor, not by S\'s', () => {
  // 🔴 The two are different comparisons — S is 15-vs-30 against the library, D is 15-vs-15
  // between two measurements — so subtracting S's floor from D silently rescales the ratio
  // that decides SUSPECT. This asserts the shipped number matches the correct calibration
  // and differs from the wrong one.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  const r = evaluateL2({
    subjectSamples: wideRows(uniform(WIDE, 'luna'), 'subj'),
    controlSamples: wideRows(uniform(WIDE, 'ctl'), 'ctl'),
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  // The shipped interval must differ from the one computed with a single floor. Compare on
  // the point estimate, which the per-cell and scalar forms agree on when the correction is
  // uniform — what must NOT agree is correcting the denominator by the numerator's floor.
  const wrong = ratioCI(r.per_cell.s, r.per_cell.d,
    { correctBy: r.noise_floor, denomFloor: r.noise_floor });
  assert.notEqual(r.sd_ratio, wrong.ratio,
    'correcting D by S\'s floor must give a visibly different ratio');
  // And the shipped number is the one calibrated with D's own correction.
  const right = ratioCI(r.per_cell.s, r.per_cell.d,
    { correctBy: r.noise_floor, correctDen: r.noise_floor_d, denomFloor: r.noise_floor });
  assert.ok(Math.abs(r.sd_ratio - right.ratio) < 1e-9,
    `point estimate ${r.sd_ratio} should match the scalar-equivalent ${right.ratio}`);
});

test('each floor uses ITS OWN side\'s sample counts, not the minimum of the two', () => {
  // 🔴 `counts` is min(subject, control) — the right rule for deciding whether a cell is
  // live, the wrong one for calibrating anything. With the subject at 14 and the control at
  // 15, H's comparison is 15-vs-reference and D's is 14-vs-15; running all three at 14
  // mis-scales two of them. Measured on a 40-cell construction: S/H 1.507 vs 1.467 and
  // S/D 0.702 vs 0.696 — SUSPECT against CONSISTENT, on a 93%-valid endpoint.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  // The subject loses one probe per cell; the control keeps all fifteen.
  const subjRows = wideRows(uniform(WIDE, 'sol'), 'subj')
    .map((r, i) => (i % REPS === 0 ? { ...r, state: 'transport_failure', normalized: null } : r));
  const r = evaluateL2({
    subjectSamples: subjRows,
    controlSamples: wideRows(uniform(WIDE, 'ctl'), 'ctl'),
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  assert.equal(r.live_cells, WIDE.length, 'every cell still clears the sample bar at 14');

  // H is drawn at the CONTROL's 15, so it must equal the 15-count computation and differ
  // from the 14-count one the shared minimum would have produced.
  const ctlPools = validAnswersByCell(wideBuild(uniform(WIDE, 'ctl'), 'ctl-model').samples);
  const at = (n) => noiseFloor(ctlPools, Object.fromEntries(WIDE.map((c) => [c, n])),
    { trials: 400, against: 'pool' }).overall;
  assert.equal(r.noise_floor_h, at(15), 'H is calibrated at the control side\'s own count');
  assert.notEqual(at(15), at(14), 'and the two counts must actually give different floors');
});

test('without a control, D is a reference-vs-reference comparison at THEIR counts', () => {
  // 🔴 The branch the web version takes by default, and the one the sampled-control test
  // could not reach. With no control sampled, D is the distance between two stored
  // fingerprints — 30 samples against 30 — not this run's 15 against anything.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  // 🔴 The two must OVERLAP, or every draw scores JSD 1 and the bias is identically zero at
  // any count — a fixture that cannot tell the two calibrations apart.
  const sAns = Object.fromEntries(WIDE.map((c) => [c, ['a', 'a', 'a', 'a', 'b']]));
  const cAns = Object.fromEntries(WIDE.map((c) => [c, ['a', 'a', 'b', 'b', 'b']]));
  const refS = wideBuild(sAns, 'sold-model');
  const refC = wideBuild(cAns, 'ctl-model');
  const r = evaluateL2({
    subjectSamples: wideRows(sAns, 'subj'), controlSamples: null,
    refSubject: refS, refControl: refC,
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  const poolsS = validAnswersByCell(refS.samples);
  const poolsC = validAnswersByCell(refC.samples);
  const sizes = (p2) => Object.fromEntries(Object.entries(p2).map(([c, v]) => [c, v.length]));
  const atPools = pairBias(poolsS, poolsC, sizes(poolsS), sizes(poolsC), { trials: 400 }).overall;
  const atRun = pairBias(poolsS, poolsC,
    Object.fromEntries(WIDE.map((c) => [c, REPS])),
    Object.fromEntries(WIDE.map((c) => [c, REPS])), { trials: 400 }).overall;
  assert.equal(r.noise_floor_d, atPools, 'D is drawn at the references\' own pool sizes');
  assert.notEqual(atPools, atRun, 'and that differs from drawing it at this run\'s counts');
});

test('a floor that cannot be measured is refused, never read as zero', () => {
  // 🔴 `noiseFloor({})` returns 0 by construction and `ratioCI` fills a missing correction
  // key with 0, so a reference carrying a fingerprint but NO samples used to mean "this
  // comparison has no sampling noise at all" — the most confident possible statement, from
  // the least evidence. Constructed, it convicts a genuine endpoint at an S/D lower bound of
  // 1.0. Reachable without contrivance: `selectCells` plans runs against such a reference,
  // and the CLI's path does not pass the UI's floor guard.
  const cells = WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' }));
  const answers = uniform(WIDE, 'sol');
  const refS = wideBuild(answers, 'sold-model');
  const refC = wideBuild(uniform(WIDE, 'ctl'), 'ctl-model');
  // 🔴 ONE sample per cell, not zero. "Has at least one sample" is not the bar — a cell the
  // library measured once cannot state its noise any more than one it never measured, and
  // `modelFloors` already refuses exactly that pool. Fresh runs filter such cells during
  // selection, but `rejudge` replays the cells a stored run used, so they come straight
  // back: a subject reference at one sample per cell against a genuine 15-sample run
  // reported floor 0, an S/D lower bound of 1.0, and SUSPECT.
  refS.samples = WIDE.map((cell) => ({ cell, answer_class: 'valid', normalized: 'sol' }));

  const r = evaluateL2({
    subjectSamples: wideRows(answers, 'subj'), controlSamples: null,
    refSubject: refS, refControl: refC,
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE, 'it must refuse rather than calibrate at zero');
  assert.match(r.reason, /算不出噪声地板/);
  assert.match(r.reason, new RegExp(String(REFERENCE_MIN_N)), 'and it names the bar it applied');
  assert.match(r.reason, /sold-model/);

  // 🔴 And the disqualified quantities are NaN, not the numbers a refused pool produced.
  // `noise_floor_h = 0` and `d_c = 1` render as ordinary calibrated values on the CLI and
  // the page, and nothing tells a reader the pool behind them was thrown out — which goes
  // unquestioned precisely because the verdict does not use them.
  assert.ok(Number.isNaN(r.noise_floor), 'S was calibrated from the refused pool');
  assert.ok(Number.isNaN(r.s_c));
  assert.ok(Number.isNaN(r.noise_floor_d), 'and D rests on it too');
  assert.ok(Number.isNaN(r.d_c));

  // 🔴 The CONTROL side has to be checked as well, and with no control sampled — that is the
  // branch where the control reference is one half of D. The guard briefly read
  // `(sampledControl || true) && …`, which cannot branch, and a test that only thinned the
  // subject side would not have noticed if it were deleted.
  const thinControl = wideBuild(uniform(WIDE, 'ctl'), 'ctl-model');
  thinControl.samples = WIDE.map((cell) => ({ cell, answer_class: 'valid', normalized: 'ctl' }));
  const c = evaluateL2({
    subjectSamples: wideRows(answers, 'subj'), controlSamples: null,
    refSubject: wideBuild(answers, 'sold-model'), refControl: thinControl,
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  assert.equal(c.verdict, VERDICT.INCONCLUSIVE, 'a thin CONTROL reference must refuse too');
  assert.match(c.reason, /ctl-model/);
  assert.ok(Number.isNaN(c.noise_floor_d), 'D cannot be calibrated from it');
  assert.ok(Number.isFinite(c.noise_floor), 'while the subject side, which is fine, still reports');

  // With both references thick the same run judges normally — the refusal is about the
  // pools, not about anything else in the fixture.
  const ok = evaluateL2({
    subjectSamples: wideRows(answers, 'subj'), controlSamples: null,
    refSubject: wideBuild(answers, 'sold-model'), refControl: refC,
    selection: { cells, repsPerCell: REPS },
    refs: null,
  });
  assert.notEqual(ok.verdict, VERDICT.INCONCLUSIVE);
});

test('matching the model that WAS sold is a confirmation, never an accusation', () => {
  const r = wideJudge({
    subjectAnswers: uniform(WIDE, 'sol'),
    refAnswers: uniform(WIDE, 'sol'),
    refs: [{ model: 'sold-model', answers: uniform(WIDE, 'sol') },
           { model: 'other-model', answers: uniform(WIDE, 'luna') }],
  });
  assert.equal(r.identification.impostor, false);
  assert.equal(r.identification.model, 'sold-model');
  assert.equal(r.verdict, VERDICT.CONSISTENT);
});

test('a name is withheld below the cell floor, however clean the separation', () => {
  // Six cells, a perfect match to the wrong model, infinite separation — and still no
  // accusation. Measured: one endpoint was named three different models at 3, 6 and 29
  // cells, agreeing with the archive only at 29.
  const r = judge({
    subject: every('zzz'), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
    refs: library({ 'subj-model': every(...VARIED), 'other-model': every('zzz') }),
  });
  // Six cells is under MIN_ID_CELLS, so these references cannot support a name at all —
  // they are set aside as candidates rather than ranked and then rejected.
  assert.equal(r.identification.model, null, 'no name is put on six cells');
  assert.equal(r.identification.impostor, false);
  assert.ok(r.identification.dropped_candidates.length > 0, 'and the exclusion is reported');
  // This construction is also a blatant S/D substitution, so the verdict is `suspect`
  // either way — what must not happen is that it gets there by NAMING something on six
  // cells. The reason is where the two routes are told apart.
  assert.ok(!/shaped like/.test(r.reason ?? ''), 'six cells must not convict by identification');
});

test('a near-exact match is named because the FLOOR carries the ratio, not a raw zero', () => {
  // 🔴 The resolution floor is what makes an exact match nameable. Without it the ratio is
  // ε/0 = Infinity, which reads as certainty about something thirty samples cannot
  // establish; with it the denominator is the measurement's own limit and the ratio stays
  // a finite, checkable number.
  const r = wideJudge({
    subjectAnswers: uniform(WIDE, 'luna'),
    refAnswers: uniform(WIDE, 'sol'),
    refs: [{ model: 'sold-model', answers: uniform(WIDE, 'sol') },
           { model: 'other-model', answers: uniform(WIDE, 'luna') }],
  });
  assert.ok(r.identification.floor > 0, 'a scattered reference has a real resolution limit');
  assert.ok(Number.isFinite(r.identification.separation_lo), 'and so the ratio stays finite');
  assert.equal(r.identification.model, 'other-model');

  const tie = wideJudge({
    subjectAnswers: uniform(WIDE, 'sol'),
    refAnswers: uniform(WIDE, 'sol'),
    refs: [{ model: 'sold-model', answers: uniform(WIDE, 'sol') },
           { model: 'twin-model', answers: uniform(WIDE, 'sol') }],
  });
  assert.ok(!(tie.identification.separation_lo >= 2), 'two identical references separate from nothing');
  assert.equal(tie.identification.model, null);
});

test('a nearest match that is not clear of the runner-up names nothing', () => {
  const r = wideJudge({
    subjectAnswers: uniform(WIDE, 'sol'),
    refAnswers: uniform(WIDE, 'nobody'),
    // Two candidates equidistant from the measurement: separation 1.0, far under the bar.
    refs: [{ model: 'sold-model', answers: uniform(WIDE, 'nobody') },
           { model: 'other-model', answers: uniform(WIDE, 'nothing') }],
  });
  assert.equal(r.identification.model, null);
  assert.equal(r.identification.impostor, false);
  assert.ok(r.identification.separation < 2);
});

test('identification outranks the collapsed-scale guard', () => {
  // 🔴 The run this was built for: both model names substituted, so D collapses and the
  // H/S/D arithmetic cannot calibrate — while the distribution is plainly a third model.
  // "Cannot calibrate" is true of the arithmetic and irrelevant to identification, which
  // never touches the control. Reporting only the former threw the finding away.
  const bothServeLuna = uniform(WIDE, 'luna');
  const r = wideJudge({
    subjectAnswers: bothServeLuna,
    controlAnswers: bothServeLuna,                    // both names answer alike → D = 0
    refAnswers: uniform(WIDE, 'sol'),
    refControlAnswers: uniform(WIDE, 'terra'),
    refs: [{ model: 'sold-model', answers: uniform(WIDE, 'sol') },
           { model: 'ctl-model', answers: uniform(WIDE, 'terra') },
           { model: 'other-model', answers: uniform(WIDE, 'luna') }],
  });
  assert.equal(r.d_c, 0, 'the scale really has collapsed');
  assert.ok(r.d_c < r.noise_floor || r.noise_floor === 0);
  assert.equal(r.verdict, VERDICT.SUSPECT, 'a collapsed scale must not bury a named impostor');
  assert.equal(r.identification.model, 'other-model');
  // The collapse itself stays legible in the numbers for anyone who wants it.
  assert.ok(Number.isFinite(r.d_c) && Number.isFinite(r.noise_floor));
});

test('no library means the question was not asked, not that nothing matched', () => {
  const r = judge({
    subject: every(...VARIED), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL),
  });
  assert.equal(r.identification, null, 'null is "not checked" — a shape, not a finding');
  assert.throws(() => evaluateL2({
    subjectSamples: samplesFor('subj', every(...VARIED)), controlSamples: null,
    refSubject: referenceFor(every(...VARIED)), refControl: referenceFor(every(...CTRL), 'ctl-model'),
    selection,
  }), /refs must be an array/, 'omitting refs entirely is an error, not a silent null');
});

test('a run that fails its gate is never named', () => {
  const dead = samplesFor('subj', every('a')).map((s) => ({ ...s, state: 'empty_completion', normalized: null }));
  const r = evaluateL2({
    subjectSamples: dead, controlSamples: null,
    refSubject: referenceFor(every(...VARIED)), refControl: referenceFor(every(...CTRL), 'ctl-model'),
    selection,
    refs: library({ 'subj-model': every(...VARIED), 'other-model': every('zzz') }),
  });
  assert.equal(r.verdict, VERDICT.NOT_APPLICABLE);
  assert.equal(r.identification, null, 'a distribution built from scraps must not carry a name');
});

test('a crippled control shrinks the intervals but never the identification', () => {
  // 🔴 Pins a deliberate asymmetry. `live` is the intersection of the two sides, so a
  // control starved of samples drags it down — measured, twice: rate limiting killed 102
  // and 137 of one side's 420 probes, taking live cells from 28 to 20 and 16. The
  // identification never touches the control, so gating it on `live` would let the
  // control's bad luck suppress the one finding that does not depend on it.
  const starved = wideRows(uniform(WIDE, 'ctl'), 'ctl')
    // Everything past the fourth cell comes back empty: `live` collapses to 4, well under
    // MIN_ID_CELLS, while the subject still has all of WIDE.
    .map((s) => (WIDE.indexOf(`${s.task_id}|${s.lang}`) < 4
      ? s : { ...s, state: 'empty_completion', normalized: null }));

  const r = evaluateL2({
    subjectSamples: wideRows(uniform(WIDE, 'luna'), 'subj'),
    controlSamples: starved,
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells: WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })), repsPerCell: REPS },
    refs: [wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
           wideBuild(uniform(WIDE, 'luna'), 'other-model')],
  });

  assert.ok(r.live_cells < MIN_ID_CELLS, `the control really did cripple live cells (${r.live_cells})`);
  assert.equal(r.identification.cells, WIDE.length, 'identification counts the SUBJECT’s cells');
  assert.equal(r.identification.model, 'other-model');
  assert.equal(r.verdict, VERDICT.SUSPECT);
});

test('the contract refuses a result that both accuses and acquits', () => {
  // 🔴 Reachability, stated honestly: `evaluateL2` returns from the impostor branch before
  // the consistent branch, so IT cannot produce this pair — mutating the assertion away
  // breaks no end-to-end test. The assertion guards the CONTRACT, i.e. any other producer
  // of an L2 result, so it is exercised the only way it can be: directly.
  const ok = {
    verdict: VERDICT.CONSISTENT, subject: {}, control: null, low_confidence: false,
    identification: { impostor: false, model: 'gpt-5.6-sol' },
  };
  assert.doesNotThrow(() => assertL2Result(ok));
  assert.throws(() => assertL2Result({ ...ok, identification: { impostor: true, model: 'gpt-5.6-luna' } }),
    /impostor with verdict "consistent"/);
  assert.throws(() => assertL2Result({ verdict: VERDICT.CONSISTENT, subject: {}, control: null }),
    /identification key/, 'an absent key must read as an oversight, not as "not checked"');
  assert.throws(() => assertL2Result({ ...ok, identification: { model: 'x' } }),
    /impostor must be a boolean/, 'a missing flag is falsy, and falsy would silently acquit');
});

test('a subject reference with no model name refuses to judge rather than accuse', async () => {
  const { fingerprint, samples } = referenceFor(every(...VARIED));
  assert.throws(() => evaluateL2({
    subjectSamples: samplesFor('subj', every(...VARIED)), controlSamples: null,
    refSubject: { fingerprint, samples },                 // no `model`
    refControl: referenceFor(every(...CTRL), 'ctl-model'),
    selection,
    refs: library({ 'subj-model': every(...VARIED) }),
  }), /carries no usable `model`/);

  // An empty string is a string. It used to pass a `typeof` check and then defend "" —
  // against which every candidate is a different name, i.e. every run an accusation.
  assert.throws(() => evaluateL2({
    subjectSamples: samplesFor('subj', every(...VARIED)), controlSamples: null,
    refSubject: { model: '  ', fingerprint, samples },
    refControl: referenceFor(every(...CTRL), 'ctl-model'),
    selection,
    refs: library({ 'subj-model': every(...VARIED) }),
  }), /carries no usable `model`/);
});

test('an empty library is an error, not a quiet "not checked"', () => {
  assert.throws(() => judge({
    subject: every(...VARIED), control: every(...CTRL),
    refSubject: every(...VARIED), refControl: every(...CTRL), refs: [],
  }), /empty array/, '[] would be stored as null and read as "never asked"');
});

test('a dead control cannot suppress an identification it has nothing to do with', () => {
  // 🔴 Measured twice on real runs: rate limiting killed 102 and 137 of one side's 420
  // probes. With identification placed after the gates, a control answering nothing at all
  // returned not_applicable and discarded a subject side that named an impostor outright.
  const deadControl = wideRows(uniform(WIDE, 'ctl'), 'ctl')
    .map((s) => ({ ...s, state: 'transport_failure', normalized: null }));
  const r = evaluateL2({
    subjectSamples: wideRows(uniform(WIDE, 'luna'), 'subj'),
    controlSamples: deadControl,
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells: WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })), repsPerCell: REPS },
    refs: [wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
           wideBuild(uniform(WIDE, 'luna'), 'other-model')],
  });
  assert.equal(r.control.valid_rate, 0, 'the control really did answer nothing');
  assert.equal(r.identification.model, 'other-model');
  assert.equal(r.verdict, VERDICT.SUSPECT, 'the control failing its gate must not bury the name');
  assert.match(r.reason, /failed its gate/, 'and the reader is told the numbers are absent');
});

test('a dead SUBJECT still names nothing — that distribution is scraps', () => {
  const deadSubject = wideRows(uniform(WIDE, 'luna'), 'subj')
    .map((s) => ({ ...s, state: 'empty_completion', normalized: null }));
  const r = evaluateL2({
    subjectSamples: deadSubject, controlSamples: null,
    refSubject: wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells: WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })), repsPerCell: REPS },
    refs: [wideBuild(uniform(WIDE, 'sol'), 'sold-model'),
           wideBuild(uniform(WIDE, 'luna'), 'other-model')],
  });
  assert.equal(r.verdict, VERDICT.NOT_APPLICABLE);
  assert.equal(r.identification, null);
});

test('the accusation always states how old the yardstick is', () => {
  // ⚠️ A reference collected before the vendor updated that model's weights turns an
  // honest relay into a mismatch, and nothing in the data distinguishes that from a swap.
  // The reader is told the age rather than left to go and look it up.
  const fresh = wideBuild(uniform(WIDE, 'sol'), 'sold-model');
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  // Every candidate carries a date, so the age reported is the defended one's — see the
  // undated case at the bottom for what happens when even one of them does not.
  const other = { ...wideBuild(uniform(WIDE, 'luna'), 'other-model'), collected_utc: daysAgo(1) };
  const run = (collected, refs) => evaluateL2({
    subjectSamples: wideRows(uniform(WIDE, 'luna'), 'subj'), controlSamples: null,
    refSubject: { ...fresh, collected_utc: collected },
    refControl: wideBuild(uniform(WIDE, 'ctl'), 'ctl-model'),
    selection: { cells: WIDE.map((cell) => ({ cell, task_id: cell.split('|')[0], lang: 'en' })), repsPerCell: REPS },
    refs: refs ?? [{ ...fresh, collected_utc: collected }, other],
  });
  // ⚠️ Past the mark it still convicts, and says so loudly. A silent in-place weight
  // update behind an unchanged model id is rare — vendors ship a new id — so withholding
  // every verdict here would trade a common true finding for an uncommon confound.
  const old = run(daysAgo(400));
  assert.ok(old.identification.reference_age_days >= 399);
  assert.equal(old.verdict, VERDICT.SUSPECT, 'a stale yardstick warns, it does not disqualify');
  assert.match(old.reason, /past the 90-day mark/);
  assert.match(old.reason, /Re-collect the reference/);

  const recent = run(daysAgo(2));
  assert.equal(recent.verdict, VERDICT.SUSPECT);
  assert.match(recent.reason, /collected 2 days ago/);

  // 🔴 The age is the OLDEST reference in play, and a candidate is in play. Reading only the
  // defended model's date reported a two-day-old yardstick while the model actually being
  // named came off a fingerprint from last year.
  const staleCandidate = run(daysAgo(2), [{ ...fresh, collected_utc: daysAgo(2) },
    { ...other, collected_utc: daysAgo(400) }]);
  assert.ok(staleCandidate.identification.reference_age_days >= 399,
    'the oldest reference in play sets the age, not the defended one');
  assert.match(staleCandidate.reason, /past the 90-day mark/);

  // 🔴 One undated reference makes the whole answer unknown rather than "the oldest of the
  // ones that happen to say". Skipping the unknowns reported the reassuring half of a fact
  // whose other half was missing — here, "2 days" for a set containing an undated candidate.
  const unknownCandidate = run(daysAgo(2), [{ ...fresh, collected_utc: daysAgo(2) },
    { ...other, collected_utc: undefined }]);
  assert.equal(unknownCandidate.identification.reference_age_days, null);
  assert.match(unknownCandidate.reason, /collection date is unknown/);

  const unknown = run(undefined);
  assert.equal(unknown.identification.reference_age_days, null);
  assert.equal(unknown.verdict, VERDICT.SUSPECT, 'an unknown date is not treated as expired');
  assert.match(unknown.reason, /collection date is unknown/);
});
