// Contract tests. One case per 判定语义 clause, plus one per 待消解清单 entry that the
// phase-1 contract artefact owns.
//
// Every case here must be able to FAIL — a test that passes regardless of the
// implementation is worse than no test, because it reads as coverage.
//
// I-N (outbound HTTP invariants) get added in their own owning phases: I-1/2/3/4/5/6/8/9
// in phase 2, I-14 in phase 3, I-11/I-16 in phase 4.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SAMPLE_KIND, SAMPLE_STATES, KINDS, RATE_BEARING_KINDS, ANSWER_CLASS_TO_STATE,
  classifySample, makeSample, assertOutboundResult, REQUIRED_OUTBOUND_KEYS,
  rates, l2Rates, gateFromValidRate, L1_LOGICAL_SAMPLES, L2_LOGICAL_SAMPLES_PER_SIDE,
  countersFromSamples, assertCounters,
  assertRetryConfig, RETRY_ATTEMPTS_MIN, RETRY_ATTEMPTS_MAX,
  buildResponsesBody, RESPONSES_RESERVED_KEYS,
  makeL1Result, assertL1Result, makeL2Result, assertL2Result,
  makeCollection, assertCollection, assertReplayableMeta,
  VERDICT, COMPARE_SORT_ORDER, assertVerdict,
} from '../src/contracts.js';
import { UsageError } from '../src/lib/errors.js';

const fp = (state, extra = {}) => makeSample({ kind: SAMPLE_KIND.FINGERPRINT, state, attempts: 1, ...extra });
const repeat = (state, n) => Array.from({ length: n }, () => fp(state));

/* ── 判定语义① — kinds dispatch, and only fingerprints carry rates ────────── */

test('① every kind has its own non-overlapping state set, and it is enumerable', () => {
  assert.deepEqual([...KINDS].sort(), ['capability', 'fingerprint', 'reachability', 'reasoning']);

  // Exhaustive, not "one sample landed in the set": a classifier that only ever knows
  // valid/transport_failure would pass a single-sample check.
  assert.deepEqual([...SAMPLE_STATES[SAMPLE_KIND.FINGERPRINT]],
    ['valid', 'empty_completion', 'invalid_completion', 'post_reasoning', 'transport_failure']);
  assert.deepEqual([...SAMPLE_STATES[SAMPLE_KIND.CAPABILITY]],
    ['accepted', 'rejected', 'not_probed', 'transport_failure']);
  assert.deepEqual([...SAMPLE_STATES[SAMPLE_KIND.REASONING]],
    ['graded_correct', 'graded_wrong', 'ungradable', 'transport_failure']);
  assert.deepEqual([...SAMPLE_STATES[SAMPLE_KIND.REACHABILITY]],
    ['reachable', 'http_error', 'transport_failure']);

  // The fingerprint four-state machine must NOT have leaked onto the others.
  for (const kind of [SAMPLE_KIND.CAPABILITY, SAMPLE_KIND.REASONING, SAMPLE_KIND.REACHABILITY]) {
    assert.ok(!SAMPLE_STATES[kind].includes('valid'), `${kind} must not borrow "valid"`);
    assert.ok(!SAMPLE_STATES[kind].includes('empty_completion'), `${kind} must not borrow fingerprint states`);
  }
  assert.deepEqual([...RATE_BEARING_KINDS], ['fingerprint']);
});

test('① every state a kind declares is reachable through classifySample', () => {
  // Guards against a declared-but-unproducible state: the enum would look complete
  // while the classifier could never emit it.
  const produced = {
    [SAMPLE_KIND.FINGERPRINT]: new Set(
      Object.keys(ANSWER_CLASS_TO_STATE)
        .map((answer_class) => classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class }))
        .concat(classifySample(SAMPLE_KIND.FINGERPRINT, { error: { status: 500, code: 'http_500' } })),
    ),
    [SAMPLE_KIND.CAPABILITY]: new Set([
      classifySample(SAMPLE_KIND.CAPABILITY, {}),
      classifySample(SAMPLE_KIND.CAPABILITY, { error: { status: 400, code: 'bad' } }),
      classifySample(SAMPLE_KIND.CAPABILITY, { probed: false }),
      classifySample(SAMPLE_KIND.CAPABILITY, { error: { status: 503, code: 'x' } }),
    ]),
    [SAMPLE_KIND.REASONING]: new Set([
      classifySample(SAMPLE_KIND.REASONING, { correct: true }),
      classifySample(SAMPLE_KIND.REASONING, { correct: false }),
      classifySample(SAMPLE_KIND.REASONING, { correct: null }),
      classifySample(SAMPLE_KIND.REASONING, { error: { status: null, code: 'network_error' } }),
    ]),
    [SAMPLE_KIND.REACHABILITY]: new Set([
      classifySample(SAMPLE_KIND.REACHABILITY, {}),
      classifySample(SAMPLE_KIND.REACHABILITY, { error: { status: 404, code: 'http_404' } }),
      classifySample(SAMPLE_KIND.REACHABILITY, { error: { status: null, code: 'timeout' } }),
    ]),
  };
  for (const kind of KINDS) {
    assert.deepEqual([...produced[kind]].sort(), [...SAMPLE_STATES[kind]].sort(),
      `${kind}: declared states and reachable states must match exactly`);
  }
});

test('① asking a non-fingerprint kind for a rate throws — it does not return 0', () => {
  // A 400 on an L0b capability probe is a NORMAL profiling result. Counting those into a
  // rate makes a healthy endpoint read as broken.
  for (const kind of [SAMPLE_KIND.CAPABILITY, SAMPLE_KIND.REASONING, SAMPLE_KIND.REACHABILITY]) {
    const s = makeSample({ kind, state: SAMPLE_STATES[kind][0], attempts: 1 });
    assert.throws(() => rates([s], { logicalSamples: 1 }), UsageError, kind);
  }
});

test('① unknown kinds and mismatched states are rejected', () => {
  assert.throws(() => classifySample('made_up', {}), UsageError);
  assert.throws(() => makeSample({ kind: SAMPLE_KIND.CAPABILITY, state: 'valid', attempts: 1 }), UsageError,
    'a fingerprint state on a capability sample must not be constructible');
});

/* ── 判定语义② — validity comes from answer_class, never from "text is non-empty" ── */

test('② the answer_class map covers everything the normaliser can emit', () => {
  // Read the vendored source rather than trusting a hand-kept list: if upstream adds a
  // class, this test goes red instead of the class silently falling through.
  const vendorSrc = readFileSync(new URL('../vendor/pamela/normalize-core.js', import.meta.url), 'utf8');
  const ourSrc = readFileSync(new URL('../src/normalize/index.js', import.meta.url), 'utf8');
  const emitted = new Set(
    [...`${vendorSrc}\n${ourSrc}`.matchAll(/answer_class\s*[:=]\s*'([a-z_]+)'/g)].map((m) => m[1]),
  );
  assert.ok(emitted.size >= 5, `expected the normaliser vocabulary, found ${[...emitted]}`);
  for (const cls of emitted) {
    assert.ok(cls in ANSWER_CLASS_TO_STATE,
      `answer_class "${cls}" is emitted by the normaliser but has no state mapping`);
  }
});

test('② non-empty text that is not usable never counts as valid', () => {
  // Refusals and prose are non-empty; treating them as valid inflates valid_rate, and
  // valid_rate is the gate that catches reasoning pollution.
  assert.equal(classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class: 'refusal' }), 'invalid_completion');
  assert.equal(classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class: 'invalid' }), 'invalid_completion');
  assert.equal(classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class: 'post_reasoning' }), 'post_reasoning');
  assert.equal(classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class: 'valid' }), 'valid');
  assert.throws(() => classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class: 'made_up' }), UsageError);

  // post_reasoning must not reach the numerator.
  const r = rates([fp('valid'), fp('post_reasoning')], { logicalSamples: 2 });
  assert.equal(r.n_valid, 1);
  assert.equal(r.valid_rate, 0.5);
});

/* ── 判定语义③ — transport failure vs empty completion stay distinguishable ── */

test('③ the error object decides first, even when a body came along', () => {
  // Both produce "no usable answer"; only the error separates "endpoint broke" from
  // "model burned its 16 tokens on hidden reasoning". Merging them lets network noise
  // dilute the reasoning-pollution signal.
  assert.equal(
    classifySample(SAMPLE_KIND.FINGERPRINT, { error: { status: 500, code: 'http_500' }, answer_class: 'valid' }),
    'transport_failure',
    'an error must win over whatever the body normalised to',
  );
  assert.equal(classifySample(SAMPLE_KIND.FINGERPRINT, { answer_class: 'empty' }), 'empty_completion');

  // A network error has no status code — the classifier must not key off status alone.
  assert.equal(
    classifySample(SAMPLE_KIND.FINGERPRINT, { error: { status: null, code: 'network_error' } }),
    'transport_failure',
    'status:null must still be recognised as a failure (`if (err.status)` is falsy here)',
  );
});

/* ── 判定语义④ — denominators ───────────────────────────────────────────── */

test('④ the denominator must be handed in explicitly', () => {
  assert.throws(() => rates([fp('valid')]), UsageError, 'no denominator');
  assert.throws(() => rates([fp('valid')], { logicalSamples: 0 }), UsageError);
  assert.throws(() => rates([fp('valid')], { logicalSamples: 1.5 }), UsageError);
  assert.throws(() => rates(repeat('valid', 3), { logicalSamples: 2 }), UsageError, 'more samples than declared');
});

test('④ the denominator is the logical sample count, not the responses that came back', () => {
  // 13 of 15 died in transport, 2 came back valid.
  const samples = [...repeat('transport_failure', 13), ...repeat('valid', 2)];
  const r = rates(samples, { logicalSamples: L1_LOGICAL_SAMPLES });

  assert.equal(r.valid_rate, 2 / 15);
  assert.equal(gateFromValidRate(r.valid_rate), 'not_applicable');
  // Using responses-as-denominator would give 2/2 = 1.0 and a green light for an
  // endpoint that failed 87% of the time.
  assert.notEqual(r.valid_rate, 1);
  assert.equal(r.response_rate, 2 / 15);
});

test('④ the denominator survives failures that never reached the array', () => {
  // The case above cannot catch `samples.length` being used as the denominator, because
  // there it equals 15 either way. This one can: a collector that drops failed samples
  // instead of recording them hands over a SHORT array, and then the denominator
  // silently shrinks to match — 2/2 = 100% for an endpoint that answered twice in 15.
  const onlyTheSurvivors = repeat('valid', 2);
  const r = rates(onlyTheSurvivors, { logicalSamples: L1_LOGICAL_SAMPLES });

  assert.equal(r.logical_samples, 15);
  assert.equal(r.valid_rate, 2 / 15);
  assert.notEqual(r.valid_rate, 1, 'the declared denominator must win over samples.length');
  assert.equal(gateFromValidRate(r.valid_rate), 'not_applicable');

  // Same shape one level up: L2's per-side denominator is fixed at 90 regardless of how
  // many samples actually made it back.
  const l2 = l2Rates({ subjectSamples: repeat('valid', 5), controlSamples: repeat('valid', 5) });
  assert.equal(l2.subject.valid_rate, 5 / L2_LOGICAL_SAMPLES_PER_SIDE);
  assert.equal(gateFromValidRate(l2.subject.valid_rate), 'not_applicable');
});

test('④ L2 keeps the two sides apart — there is no merged 180 anywhere', () => {
  const subjectSamples = repeat('valid', L2_LOGICAL_SAMPLES_PER_SIDE);
  const controlSamples = repeat('transport_failure', L2_LOGICAL_SAMPLES_PER_SIDE);
  const r = l2Rates({ subjectSamples, controlSamples });

  assert.equal(r.subject.valid_rate, 1);
  assert.equal(r.control.valid_rate, 0);
  assert.equal(gateFromValidRate(r.subject.valid_rate), 'ok');
  assert.equal(gateFromValidRate(r.control.valid_rate), 'not_applicable',
    'a dead control side must trip the gate on its own');

  // Merged, this is 90/180 = 50% — sails past the 20% gate while H and D are garbage.
  const merged = (r.subject.n_valid + r.control.n_valid) / (2 * L2_LOGICAL_SAMPLES_PER_SIDE);
  assert.equal(merged, 0.5);
  assert.notEqual(gateFromValidRate(merged), 'not_applicable',
    'this is exactly the mistake the split denominators prevent');
});

test('④ gate thresholds', () => {
  assert.equal(gateFromValidRate(0.19), 'not_applicable');
  assert.equal(gateFromValidRate(0.20), 'low_confidence');   // boundary is inclusive-below
  assert.equal(gateFromValidRate(0.79), 'low_confidence');
  assert.equal(gateFromValidRate(0.80), 'ok');
  assert.equal(gateFromValidRate(1), 'ok');
  assert.throws(() => gateFromValidRate(1.5), UsageError);
  assert.throws(() => gateFromValidRate(NaN), UsageError);
});

/* ── 判定语义⑤ — two counts, never merged ──────────────────────────────── */

test('⑤ probes and http_attempts are counted separately', () => {
  const samples = [fp('valid', { attempts: 3 }), fp('valid'), fp('transport_failure')];
  const counts = countersFromSamples(samples);
  assert.equal(counts.probes, 3);
  assert.equal(counts.http_attempts, 5);
  assert.notEqual(counts.probes, counts.http_attempts, 'with a retry the two must differ');
  assert.doesNotThrow(() => assertCounters(counts));
});

test('⑤ a merged "requests" field is rejected, and attempts < probes is impossible', () => {
  for (const key of ['requests', 'requests_sent', 'request_count', 'actual_requests', 'total_requests']) {
    assert.throws(() => assertCounters({ probes: 2, http_attempts: 2, [key]: 2 }), UsageError, key);
  }
  assert.throws(() => assertCounters({ probes: 5, http_attempts: 4 }), UsageError);
  assert.throws(() => assertCounters({ probes: 1 }), UsageError, 'http_attempts is mandatory');
});

test('⑤ a sample must declare how many network attempts it cost', () => {
  assert.throws(() => makeSample({ kind: SAMPLE_KIND.FINGERPRINT, state: 'valid' }), UsageError);
  assert.throws(() => makeSample({ kind: SAMPLE_KIND.FINGERPRINT, state: 'valid', attempts: 0 }), UsageError);
});

/* ── 判定语义⑥ — retry configuration ───────────────────────────────────── */

test('⑥ the retry number counts TOTAL attempts and the range is closed [3,5]', () => {
  assert.equal(RETRY_ATTEMPTS_MIN, 3, 'current quick-check.js does 3 total attempts; no regression');
  assert.equal(RETRY_ATTEMPTS_MAX, 5, 'higher blows the 180-request per-endpoint promise');
  assert.equal(assertRetryConfig({}).attempts, 3, 'default');
  assert.equal(assertRetryConfig({ attempts: 5 }).attempts, 5);

  for (const bad of [2, 6, 0, -1, 3.5, NaN, '3', null]) {
    assert.throws(() => assertRetryConfig({ attempts: bad }), UsageError, String(bad));
  }
});

test('⑥ illegal backoff delays are rejected before anything is sent (待消解 #9)', () => {
  // Negative / zero / NaN turn backoff into three attempts inside a millisecond, which
  // under rate limiting is no backoff at all.
  for (const bad of [0, -1, NaN, Infinity, '1500', null]) {
    assert.throws(() => assertRetryConfig({ baseDelayMs: bad }), UsageError, String(bad));
  }
  // Millisecond delays stay legal: contract tests must be able to squeeze the backoff.
  assert.equal(assertRetryConfig({ baseDelayMs: 1 }).baseDelayMs, 1);
});

test('⑥ configuration is never clamped into range', () => {
  // Clamping desynchronises "I configured 10" from what runs, and budget reconciliation
  // can never be trusted again.
  assert.throws(() => assertRetryConfig({ attempts: 10 }), UsageError);
  let clamped = null;
  try { clamped = assertRetryConfig({ attempts: 10 }); } catch { /* expected */ }
  assert.equal(clamped, null, 'must throw rather than silently return 5');
});

/* ── 判定语义⑦ — collection envelope ───────────────────────────────────── */

test('⑦ a collecting entry point hands back result + samples + both counts', () => {
  const samples = [fp('valid', { attempts: 2 }), fp('empty_completion')];
  const col = makeCollection({ result: { verdict: VERDICT.CONSISTENT }, samples, meta: { tier: 'l1' } });

  assert.deepEqual(Object.keys(col).sort(), ['meta', 'result', 'samples']);
  assert.equal(col.samples.length, 2);
  assert.equal(col.meta.probes, 2);
  assert.equal(col.meta.http_attempts, 3);
  assert.equal(col.meta.tier, 'l1', 'caller meta is preserved');
  assert.doesNotThrow(() => assertCollection(col));
});

test('⑦ an envelope whose counts disagree with its samples is rejected', () => {
  const samples = [fp('valid', { attempts: 2 })];
  assert.throws(() => assertCollection({ result: {}, samples, meta: { probes: 1, http_attempts: 1 } }),
    UsageError, 'http_attempts must equal Σ attempts');
  assert.throws(() => assertCollection({ result: {}, samples, meta: { probes: 5, http_attempts: 5 } }),
    UsageError, 'probes must equal samples.length');
  assert.throws(() => assertCollection({ result: {}, meta: { probes: 0, http_attempts: 0 } }),
    UsageError, 'samples[] is not optional');
});

/* ── 判定语义⑧ — Responses body ────────────────────────────────────────── */

test('⑧ store:false is always sent and extra cannot override it', () => {
  const body = buildResponsesBody({ model: 'm', input: 'hi', maxOutputTokens: 16, extra: { temperature: 1 } });
  assert.equal(body.store, false);
  assert.equal(body.temperature, 1, 'unreserved extras still pass through');

  for (const key of RESPONSES_RESERVED_KEYS) {
    assert.throws(() => buildResponsesBody({ model: 'm', input: 'hi', maxOutputTokens: 16, extra: { [key]: 'x' } }),
      UsageError, key);
  }
});

test('⑧ extra is spread first, so reserved fields win even without the collision check', () => {
  // `{store:false, ...extra}` is the natural-looking implementation that quietly lets
  // extra.store = true disable the protection. Key order proves which shape is in use.
  const body = buildResponsesBody({ model: 'm', input: 'hi', maxOutputTokens: 16, extra: { z: 1 } });
  const keys = Object.keys(body);
  assert.ok(keys.indexOf('z') < keys.indexOf('store'), 'extra must be spread before the reserved fields');
  assert.throws(() => buildResponsesBody({ model: '', input: 'hi', maxOutputTokens: 16 }), UsageError);
  assert.throws(() => buildResponsesBody({ model: 'm', input: 'hi', maxOutputTokens: 0 }), UsageError);
});

/* ── 待消解清单 ────────────────────────────────────────────────────────── */

test('待消解 #1: L1/L2 products have a definition, and L1 has no low-confidence flag', () => {
  const l1 = makeL1Result({
    verdict: VERDICT.CONSISTENT, s_screen: 0.03, t_pass: 0.08, t_fail: 0.34,
    valid_rate: 1, response_rate: 1, live_cells: 3,
  });
  assert.doesNotThrow(() => assertL1Result(l1));
  assert.ok(!('low_confidence' in l1));
  // L1 is all-or-nothing: every cell needs a full 5 valid samples, so the 20–80% band is
  // unreachable and a flag there would be dead code implying a wounded verdict exists.
  assert.throws(() => assertL1Result({ ...l1, low_confidence: false }), UsageError);

  const l2 = makeL2Result({
    verdict: VERDICT.CONSISTENT, h: 0.17, s: 0.18, d: 0.35, h_c: 0.11, s_c: 0.12, d_c: 0.29,
    ratio: 1.05, ratio_ci_lo: 0.9, ratio_ci_hi: 1.2, noise_floor: 0.056,
    subject: { valid_rate: 1, response_rate: 1 }, control: { valid_rate: 1, response_rate: 1 },
    low_confidence: false, live_cells: 6,
  });
  assert.doesNotThrow(() => assertL2Result(l2));
  assert.equal(l2.low_confidence, false, 'L2 does carry the flag');
  assert.throws(() => makeL2Result({ ...l2, low_confidence: undefined }), UsageError);
  assert.throws(() => assertL2Result({ ...l2, valid_rate: 0.9 }), UsageError,
    'a merged rate on L2 hides a dead control side');
});

test('待消解 #2: finish_reason / model_reported are required keys, null-valued when absent', () => {
  const base = {
    raw: '7', error: null, http_status: 200, latency_ms: 120, attempts: 1, usage: {},
    finish_reason: null, model_reported: null,
  };
  assert.doesNotThrow(() => assertOutboundResult(base), 'present-but-null is the required shape');

  for (const key of ['finish_reason', 'model_reported']) {
    const { [key]: _omitted, ...without } = base;
    assert.throws(() => assertOutboundResult(without), UsageError,
      `${key} must not be optional — it is the only producer of the model-echo signal`);
  }
  assert.ok(REQUIRED_OUTBOUND_KEYS.includes('model_reported'));
});

test('待消解 #3: a chat-protocol endpoint gets "not_probed", which is not "unsupported"', () => {
  // The endpoint never got asked, so neither true, false nor "unsupported" is honest.
  assert.equal(classifySample(SAMPLE_KIND.CAPABILITY, { probed: false }), 'not_probed');
  assert.notEqual(classifySample(SAMPLE_KIND.CAPABILITY, { probed: false }), 'rejected');
  assert.ok(SAMPLE_STATES[SAMPLE_KIND.CAPABILITY].includes('not_probed'));
});

test('待消解 #7: 4xx means the parameter was refused; 5xx and network errors do not', () => {
  assert.equal(classifySample(SAMPLE_KIND.CAPABILITY, { error: { status: 400, code: 'bad_request' } }), 'rejected');
  assert.equal(classifySample(SAMPLE_KIND.CAPABILITY, { error: { status: 422, code: 'unprocessable' } }), 'rejected');
  // Recording a 503 as "rejected" would freeze one flaky minute into "does not support seed".
  assert.equal(classifySample(SAMPLE_KIND.CAPABILITY, { error: { status: 503, code: 'unavailable' } }), 'transport_failure');
  assert.equal(classifySample(SAMPLE_KIND.CAPABILITY, { error: { status: null, code: 'timeout' } }), 'transport_failure');
});

test('重跑边界: meta must carry what a recomputation needs, and never a key', () => {
  const base = { probes: 15, http_attempts: 15, reference_version: '2026-07-21', cells: ['a|en'], reps_per_cell: 5 };
  assert.throws(() => assertReplayableMeta(base, { tier: 'l1' }), UsageError, 'L1 also needs both thresholds');
  assert.doesNotThrow(() => assertReplayableMeta({ ...base, t_pass: 0.08, t_fail: 0.34 }, { tier: 'l1' }));
  assert.doesNotThrow(() => assertReplayableMeta(base, { tier: 'l2' }));

  for (const key of ['reference_version', 'cells', 'reps_per_cell']) {
    const { [key]: _omitted, ...without } = base;
    assert.throws(() => assertReplayableMeta(without, { tier: 'l2' }), UsageError, key);
  }
  assert.throws(() => assertReplayableMeta({ ...base, api_key: 'x' }, { tier: 'l2' }), UsageError);
  assert.throws(() => assertReplayableMeta({ ...base, note: 'sk-CANARY-abcdefgh' }, { tier: 'l2' }), UsageError);
});

test('compare table: sort order is total, and low_confidence is not a verdict', () => {
  assert.deepEqual([...COMPARE_SORT_ORDER],
    ['consistent', 'inconclusive', 'suspect', 'not_applicable', 'fingerprint_unavailable', 'skipped']);
  for (const v of Object.values(VERDICT)) {
    assert.ok(COMPARE_SORT_ORDER.includes(v), `${v} must have a sort position`);
    assert.doesNotThrow(() => assertVerdict(v));
  }
  assert.ok(!COMPARE_SORT_ORDER.includes('low_confidence'), 'it is a separate column, never a verdict');
  assert.throws(() => assertVerdict('low_confidence'), UsageError);
});

test('the contract artefact imports nothing from a later phase', () => {
  // Phase 1 must stand alone: importing l1-screen / l2-calibrate / db (phases 5/6/M2)
  // would make this phase's milestone unreachable.
  const src = readFileSync(new URL('../src/contracts.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./lib/errors.js'], 'contracts.js must depend only on the error type');
});
