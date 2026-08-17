// Contract tests. One case per 判定语义 clause, plus one per 待消解清单 entry that the
// phase-1 contract artefact owns.
//
// Every case here must be able to FAIL — a test that passes regardless of the
// implementation is worse than no test, because it reads as coverage.
//
// I-N (outbound HTTP invariants) get added in their own owning phases: I-1/2/3/4/5/6/8/9
// in phase 2, I-14 in phase 3, I-11/I-16 in phase 4.

import test from 'node:test';

const PER_SIDE = 90;   // the classic six-cell battery, kept as a fixture value only
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SAMPLE_KIND, SAMPLE_STATES, KINDS, RATE_BEARING_KINDS, ANSWER_CLASS_TO_STATE,
  classifySample, makeSample, assertOutboundResult, REQUIRED_OUTBOUND_KEYS,
  rates, l2Rates, gateFromValidRate, L1_LOGICAL_SAMPLES, l2LogicalPerSide,
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

  // Same shape one level up: L2's per-side denominator is whatever the selection planned,
  // regardless of how many samples actually made it back.
  const l2 = l2Rates({
    subjectSamples: repeat('valid', 5), controlSamples: repeat('valid', 5), logicalPerSide: PER_SIDE,
  });
  assert.equal(l2.subject.valid_rate, 5 / PER_SIDE);
  assert.equal(gateFromValidRate(l2.subject.valid_rate), 'not_applicable');
});

test('④ L2 keeps the two sides apart — there is no merged 180 anywhere', () => {
  const subjectSamples = repeat('valid', PER_SIDE);
  const controlSamples = repeat('transport_failure', PER_SIDE);
  const r = l2Rates({ subjectSamples, controlSamples, logicalPerSide: PER_SIDE });

  assert.equal(r.subject.valid_rate, 1);
  assert.equal(r.control.valid_rate, 0);
  assert.equal(gateFromValidRate(r.subject.valid_rate), 'ok');
  assert.equal(gateFromValidRate(r.control.valid_rate), 'not_applicable',
    'a dead control side must trip the gate on its own');

  // Merged, this is 90/180 = 50% — sails past the 20% gate while H and D are garbage.
  const merged = (r.subject.n_valid + r.control.n_valid) / (2 * PER_SIDE);
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

/* ══════════════════════════════════════════════════════════════════════════════
 * I-N — outbound HTTP invariants. Phase 2 owns I-1/2/3/4/5/6/8/9; I-14 arrives in
 * phase 3 and I-11/I-16 in phase 4, because their producers are built there.
 *
 * 🔴 Every assertion here is made at the network boundary: which bytes arrived, on
 * which path, how many times. Counting calls to an internal function would pin down
 * whichever layer currently holds the retry loop — and that layer is explicitly free
 * to move.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { execFileSync } from 'node:child_process';
import { startStub, chatOk, responsesOk } from './helpers/stub-server.js';
import { createChatProbe, buildChatProbeBody, PROBE_PARAMS } from '../src/probe/http/chat.js';
import { createResponsesClient, extractText, mapFinishReason } from '../src/probe/http/responses.js';
import { createGetProbe } from '../src/probe/http/get.js';
import { isRetryable } from '../src/probe/http/transport.js';

const FAST_RETRY = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 };   // 判定语义⑥ allows ms delays for exactly this
const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/chat-request-snapshot.json', import.meta.url), 'utf8'),
);
const realResponse = JSON.parse(
  readFileSync(new URL('./fixtures/responses-sample.json', import.meta.url), 'utf8'),
).response;

test('I-1: the fingerprint body is byte-identical to what collected the reference', async () => {
  const stub = await startStub([{ json: chatOk() }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await probe({ model: 'MODEL_PLACEHOLDER', system: 'SYSTEM_PLACEHOLDER', user: 'USER_PLACEHOLDER' });

    // The snapshot was captured from src/probe/adapters/openai.js — the code that
    // actually collected reference/genuine-*.json — against a stub, with no temperature
    // passed. Key order is part of it: a reordered body is a different shell.
    assert.equal(stub.received[0].body, snapshot.body_bytes);
  } finally { await stub.close(); }
});

test('I-1: no caller can inject a sampling parameter', async () => {
  // The old adapter signature was ask({..., temperature = 1}), so "byte-identical" held
  // only while every caller happened not to pass one. There is now nowhere to put it.
  const stub = await startStub([{ json: chatOk() }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await probe({ model: 'm', system: 's', user: 'u', temperature: 0, max_tokens: 4096, top_p: 0.5 });

    const sent = stub.received[0].json;
    assert.equal(sent.temperature, PROBE_PARAMS.temperature, 'temperature must stay pinned at 1');
    assert.equal(sent.max_tokens, PROBE_PARAMS.max_tokens);
    assert.ok(!('top_p' in sent), 'unknown parameters must not reach the wire');
    assert.equal(JSON.stringify(sent), JSON.stringify(buildChatProbeBody({ model: 'm', system: 's', user: 'u' })));
  } finally { await stub.close(); }
});

test('I-2: the fingerprint path is baseUrl + /chat/completions, version segment included', async () => {
  const stub = await startStub([{ json: chatOk() }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await probe({ model: 'm', system: 's', user: 'u' });
    assert.equal(stub.received[0].path, '/v1/chat/completions');
    assert.equal(snapshot.path, '/v1/chat/completions', 'and it has not moved since the snapshot');
  } finally { await stub.close(); }
});

test('I-3: reasoning.effort / reasoning.mode appear only on the Responses path', async () => {
  const stub = await startStub([{ json: chatOk() }, { json: responsesOk() }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await probe({ model: 'm', system: 's', user: 'u' });
    const chatBody = stub.received[0].json;
    // ⚠️ What is banned is those two KEYS, not the reasoning object — I-1 requires
    // reasoning:{enabled:false} to be present.
    assert.deepEqual(chatBody.reasoning, { enabled: false });
    assert.ok(!('effort' in chatBody.reasoning) && !('mode' in chatBody.reasoning));

    const client = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await client({ model: 'm', input: 'x', reasoning: { effort: 'high', mode: 'standard' } });
    assert.deepEqual(stub.received[1].json.reasoning, { effort: 'high', mode: 'standard' });
  } finally { await stub.close(); }
});

test('I-4: every probe-path fetch lives in src/probe/http/', () => {
  // A lint, not a behavioural contract: it cannot see node:https, undici, or an aliased
  // globalThis.fetch. Treat it as a guard against new outbound points appearing by
  // accident, not as proof there are none.
  const out = execFileSync('grep', ['-rln', 'fetch(', 'src', 'scripts', '--include=*.js'],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }).trim().split('\n');
  const offenders = out.filter((f) => !f.startsWith('src/probe/http/') && f !== 'scripts/fetch-upstream-data.js');
  assert.deepEqual(offenders, [], 'outbound HTTP outside the one directory (Zenodo download excepted)');
});

test('I-5: a non-2xx comes back as a value, and the code falls back in order', async () => {
  const stub = await startStub([
    { status: 400, json: { error: { code: 'invalid_parameter', message: 'bad seed' } } },
    { status: 400, json: { error: { type: 'invalid_request_error', message: 'no code field' } } },
    { status: 503, json: { detail: 'upstream down' } },
  ]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: { attempts: 3, baseDelayMs: 1 } });

    const a = await probe({ model: 'm', system: 's', user: 'u' });
    assert.equal(a.error.code, 'invalid_parameter', 'body error.code wins');
    assert.equal(a.error.status, 400);
    assert.equal(a.raw, '', 'raw is empty string on failure, never null and never the error page');

    const b = await probe({ model: 'm', system: 's', user: 'u' });
    assert.equal(b.error.code, 'invalid_request_error', 'error.type is the second choice');

    const c = await probe({ model: 'm', system: 's', user: 'u' });
    assert.equal(c.error.code, 'http_503', 'synthesised from the status when the body says nothing');
  } finally { await stub.close(); }
});

test('I-6: a 200 carrying an HTML error page is treated like a 5xx, retry included', async () => {
  const stub = await startStub([
    { status: 200, text: '<html><body>502 Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } },
    { status: 200, text: '<html><body>502 Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } },
    { status: 200, json: chatOk('42') },
  ]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    const r = await probe({ model: 'm', system: 's', user: 'u' });

    assert.equal(r.raw, '42', 'the retry recovered');
    assert.equal(stub.count, 3, 'malformed 2xx must be retried, like the previous adapter did');
    assert.ok(isRetryable({ status: 200, code: 'malformed_json' }));
  } finally { await stub.close(); }
});

test('I-8: 429/5xx retry and permanent 4xx does not — counted at the wire, both paths', async () => {
  for (const [label, make] of [
    ['chat', (base) => {
      const probe = createChatProbe({ baseUrl: base, apiKey: 'k', retry: FAST_RETRY });
      return () => probe({ model: 'm', system: 's', user: 'u' });
    }],
    ['responses', (base) => {
      const client = createResponsesClient({ baseUrl: base, apiKey: 'k', retry: FAST_RETRY });
      return () => client({ model: 'm', input: 'x' });
    }],
  ]) {
    const okBody = label === 'chat' ? chatOk('7') : responsesOk('7');

    const retrying = await startStub([{ status: 429, json: {} }, { status: 429, json: {} }, { json: okBody }]);
    try {
      const r = await make(retrying.baseUrl)();
      assert.equal(retrying.count, 3, `${label}: stub must see exactly 3 requests`);
      assert.equal(r.attempts, 3, `${label}: attempts must report the network count`);
      assert.equal(r.error, null, `${label}: the third one succeeded`);
    } finally { await retrying.close(); }

    const permanent = await startStub([{ status: 400, json: { error: { code: 'bad' } } }]);
    try {
      const r = await make(permanent.baseUrl)();
      assert.equal(permanent.count, 1, `${label}: a permanent 4xx must not be retried`);
      assert.equal(r.attempts, 1);
      assert.equal(r.error.code, 'bad');
    } finally { await permanent.close(); }
  }
});

test('I-8: retry never regresses below the current three attempts', () => {
  // scripts/quick-check.js:63 and calibrate-probes.js:39 both do 3 today.
  assert.equal(assertRetryConfig({}).attempts, 3);
  assert.throws(() => assertRetryConfig({ attempts: 2 }), UsageError);
});

test('I-9: store:false always goes out, and extra cannot switch it off', async () => {
  const stub = await startStub([{ json: responsesOk() }]);
  try {
    const client = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await client({ model: 'm', input: 'x' });
    assert.equal(stub.received[0].json.store, false, 'default body carries it');

    // ⚠️ Testing only the default body would let `{store:false, ...extra}` pass — and
    // that shape is exactly how extra.store=true would disable the protection.
    for (const key of ['store', 'model', 'input', 'max_output_tokens']) {
      await assert.rejects(
        () => client({ model: 'm', input: 'x', extra: { [key]: 'hijack' } }),
        UsageError, key,
      );
    }
    assert.equal(stub.count, 1, 'a colliding extra must throw BEFORE anything is sent');
  } finally { await stub.close(); }
});

test('Responses extraction follows the real captured body, not a description of it', () => {
  // The live shape has no top-level output_text and no finish_reason; a stub written
  // from prose would have invented both and passed.
  assert.equal(extractText(realResponse), 'OK');
  assert.ok(!('output_text' in realResponse), 'no top-level output_text exists');
  assert.ok(!('finish_reason' in realResponse), 'Responses has no finish_reason');
  assert.equal(mapFinishReason(realResponse), 'stop', 'so status must be mapped onto one');

  assert.equal(mapFinishReason({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    'max_output_tokens', 'a truncated answer must stay distinguishable from a finished one');
  assert.equal(mapFinishReason({}), null);
  assert.equal(extractText({ output: [{ type: 'reasoning', summary: [] }] }), '',
    'reasoning items carry no text and must not break traversal');
});

test('待消解 #2 at the wire: every outbound path returns the full result shape', async () => {
  // The contract test in phase 1 pins the shape; this one proves the three real paths
  // actually produce it — including the keys that must be present-but-null.
  const stub = await startStub([{ json: chatOk() }, { json: responsesOk() }, { json: { data: [] } }]);
  try {
    const chat = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    const responses = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    const get = createGetProbe({ retry: FAST_RETRY });

    const results = [
      await chat({ model: 'm', system: 's', user: 'u' }),
      await responses({ model: 'm', input: 'x' }),
      await get({ url: `${stub.baseUrl}/models`, apiKey: 'k' }),
    ];
    for (const r of results) {
      assert.doesNotThrow(() => assertOutboundResult(r));
      for (const key of REQUIRED_OUTBOUND_KEYS) {
        assert.ok(key in r, `${key} must be present even when there is nothing to put in it`);
      }
    }
    assert.equal(results[0].model_reported, 'stub-model', 'chat reports the echoed model');
    assert.equal(results[1].model_reported, 'stub-model', 'so does Responses');
    assert.equal(results[2].model_reported, null, 'a GET has none — null, not absent');
  } finally { await stub.close(); }
});

test('a network failure is a value with no status, not an exception', async () => {
  // Nothing is listening on this port. `if (err.status)` is falsy here, which is exactly
  // how a dead endpoint could get mistaken for a successful empty completion.
  const probe = createChatProbe({
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', retry: { attempts: 3, baseDelayMs: 1 }, timeoutMs: 2000,
  });
  const r = await probe({ model: 'm', system: 's', user: 'u' });

  assert.equal(r.error.status, null);
  assert.equal(r.error.code, 'network_error');
  assert.equal(r.raw, '');
  assert.equal(r.http_status, null);
  assert.equal(r.attempts, 3, 'a connection that never reached a server still costs attempts');
  assert.equal(classifySample(SAMPLE_KIND.FINGERPRINT, { error: r.error }), 'transport_failure');
  assert.ok(isRetryable(r.error), 'and it is retryable — the previous adapter retried it too');
});

/* ── I-14 (phase 3): toDist has no default threshold ─────────────────────── */

test('I-14: toDist requires its minN, because the wrong default is silent', async () => {
  const { toDist, MIN_N } = await import('../src/stats/jsd.js');

  // With a default of MIN_N=10, L1's five-sample cells return null: no error, no cell,
  // no verdict, and nothing in the output pointing at the cause.
  assert.throws(() => toDist({ a: 3 }), /minN is required/);
  assert.deepEqual(toDist({ a: 3 }, 3), { a: 1 });
  assert.equal(toDist({ a: 3 }, 10), null, 'below the threshold it still returns null — that part is unchanged');
  assert.equal(MIN_N, 10, "the paper's threshold stays available for L2");
});
