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
import { VERDICT, SAMPLE_KIND, l2LogicalPerSide } from '../src/contracts.js';

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
function referenceFor(answers) {
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
  return { fingerprint, samples };
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

function judge({ subject, control, refSubject, refControl }) {
  return evaluateL2({
    subjectSamples: samplesFor('subj', subject),
    controlSamples: samplesFor('ctl', control),
    refSubject: referenceFor(refSubject),
    refControl: referenceFor(refControl),
    selection,
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
    refSubject: referenceFor(args.refSubject), refControl: referenceFor(args.refControl),
    selection,
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
    refSubject: referenceFor(every(...VARIED)), refControl: referenceFor(every(...CTRL)),
    selection,
  });
  assert.equal(r.verdict, VERDICT.NOT_APPLICABLE);
});
