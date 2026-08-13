// Contract code — the single source of truth for the plan's eight 判定语义 clauses.
//
// Zero dependencies, pure functions, issues no requests, reads no files, and imports
// nothing from later phases. Everything downstream (outbound clients, runner, guards,
// layers, CLIs) imports from here instead of carrying its own copy of a field list.
//
// Why this file exists at all: the same definitions previously lived in prose in the
// plan, where five to ten consumers each kept a copy and the copies drifted every time
// the definition changed. An `import` keeps them in step for free.
//
// Plan: docs/plans/2026-08-11-relay-picker-plan.md → 「接口契约与数据 · 判定语义」

import { usageError } from './lib/errors.js';

const isInt = (v) => Number.isInteger(v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义① — sample kinds, each with its OWN state set
 *
 * "四类样本的「什么算有效」根本不是同一个概念。" There is no shared state machine:
 * L0b is told to record accept/reject without looking at the body, the reasoning layer
 * grades integers rather than normalising, and a 404 from /models is a profiling
 * finding rather than a failure.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const SAMPLE_KIND = Object.freeze({
  FINGERPRINT: 'fingerprint',   // L1/L2 chat POSTs — the only kind carrying rates
  CAPABILITY: 'capability',     // L0b parameter matrix / juice / injection probes
  REASONING: 'reasoning',       // generated hard questions, graded by an integer grader
  REACHABILITY: 'reachability', // L0a GETs (/api/status, /models)
});

export const SAMPLE_STATES = Object.freeze({
  [SAMPLE_KIND.FINGERPRINT]: Object.freeze([
    'valid',              // normaliser said `valid` — the only state entering a distribution
    'empty_completion',   // answered, nothing usable — the reasoning-pollution signal
    'invalid_completion', // answered with something unusable (refusal, prose, out of range)
    'post_reasoning',     // answer carries reasoning residue (see 判定语义② note)
    'transport_failure',  // no usable HTTP response at all
  ]),
  [SAMPLE_KIND.CAPABILITY]: Object.freeze([
    'accepted',           // 2xx — the endpoint took the parameter
    'rejected',           // 4xx — the endpoint refused THIS parameter
    'not_probed',         // deliberately not attempted (protocol:"chat" skips effort/mode)
    'transport_failure',  // 5xx / network — says nothing about the parameter
  ]),
  [SAMPLE_KIND.REASONING]: Object.freeze([
    'graded_correct',
    'graded_wrong',
    'ungradable',         // answered, but the grader found nothing to score
    'transport_failure',
  ]),
  [SAMPLE_KIND.REACHABILITY]: Object.freeze([
    'reachable',          // 2xx
    'http_error',         // non-2xx — a profiling finding, NOT a transport failure
    'transport_failure',  // connection reset / DNS / timeout
  ]),
});

/** 判定语义①: only fingerprint samples carry the two rates. */
export const RATE_BEARING_KINDS = Object.freeze([SAMPLE_KIND.FINGERPRINT]);

export const KINDS = Object.freeze(Object.values(SAMPLE_KIND));

export function assertKind(kind) {
  if (!SAMPLE_STATES[kind]) {
    usageError(`unknown sample kind: ${JSON.stringify(kind)}; known: ${KINDS.join(', ')}`);
  }
  return kind;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义②③ — classification
 *
 * ② validity is decided by the normaliser's `answer_class`, never by "text is
 *   non-empty": refusals and explanatory prose are non-empty but must not inflate
 *   valid_rate, which is the gate signal for reasoning pollution.
 * ③ "endpoint/network broke" and "answered with nothing" must stay distinguishable —
 *   only the error object separates them, so the error is checked FIRST.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The normaliser's full vocabulary, verified against the upstream corpus
 * (data/upstream/.../normalized.jsonl contains exactly these five) plus
 * `post_reasoning`, which src/normalize/index.js sets on top of vendor output.
 */
export const ANSWER_CLASS_TO_STATE = Object.freeze({
  valid: 'valid',
  empty: 'empty_completion',
  invalid: 'invalid_completion',
  refusal: 'invalid_completion',
  post_reasoning: 'post_reasoning',
});

/**
 * Classify one sample. Each kind takes its own evidence shape — a single shared shape
 * is what made the previous "one state machine for everything" unimplementable.
 *
 * @param {string} kind SAMPLE_KIND value
 * @param {object} ev   kind-specific evidence:
 *   fingerprint  {error, answer_class}
 *   capability   {error, probed}          probed:false ⇒ 'not_probed'
 *   reasoning    {error, correct}         correct: true | false | null (ungradable)
 *   reachability {error}
 *   `error` is the structured error VALUE the outbound client returns (I-5: a non-2xx
 *   does not throw), shaped {status: number|null, code: string}; null when fine.
 * @returns {string} a member of SAMPLE_STATES[kind]
 */
export function classifySample(kind, ev = {}) {
  assertKind(kind);
  const err = ev.error ?? null;

  switch (kind) {
    case SAMPLE_KIND.FINGERPRINT: {
      if (err) return 'transport_failure';                    // ③ error wins, always
      const state = ANSWER_CLASS_TO_STATE[ev.answer_class];
      if (!state) {
        usageError(`unknown answer_class: ${JSON.stringify(ev.answer_class)}; known: ` +
                   `${Object.keys(ANSWER_CLASS_TO_STATE).join(', ')}`);
      }
      return state;
    }

    case SAMPLE_KIND.CAPABILITY: {
      // 待消解 #3: a chat-protocol endpoint skips the effort/mode probes entirely. That
      // is neither true nor false nor "unsupported" — it is "we never asked".
      if (ev.probed === false) return 'not_probed';
      if (err) {
        // 待消解 #7: only a 4xx is a statement about the PARAMETER. A 5xx or a network
        // error is the endpoint misbehaving; recording it as "rejected" would turn a
        // flaky minute into a permanent "does not support seed" in the profile.
        return isInt(err.status) && err.status >= 400 && err.status < 500
          ? 'rejected'
          : 'transport_failure';
      }
      return 'accepted';
    }

    case SAMPLE_KIND.REASONING: {
      if (err) return 'transport_failure';
      if (ev.correct === null || ev.correct === undefined) return 'ungradable';
      if (typeof ev.correct !== 'boolean') {
        usageError(`reasoning evidence.correct must be true/false/null, got ${JSON.stringify(ev.correct)}`);
      }
      return ev.correct ? 'graded_correct' : 'graded_wrong';
    }

    case SAMPLE_KIND.REACHABILITY: {
      // I-16: a 404 from /models means "this endpoint does not implement /models" —
      // a profiling finding. It is not evidence that chat is unusable, and it never
      // gates L1/L2.
      if (err) return isInt(err.status) ? 'http_error' : 'transport_failure';
      return 'reachable';
    }

    default:
      return usageError(`unhandled kind: ${kind}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Sample records
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 待消解 #2 — `finish_reason` and `model_reported` are NOT optional. Present-but-null
 * is required; an absent key is rejected.
 *
 * Why it matters: "the model echo changed mid-run" is the sharpest evidence of account
 * rotation / backend switching, and this is its only producer. If a gateway omits the
 * field and we omit the key, the signal disappears with nobody noticing.
 */
export const REQUIRED_OUTBOUND_KEYS = Object.freeze([
  'raw', 'error', 'http_status', 'latency_ms', 'attempts', 'usage',
  'finish_reason', 'model_reported',
]);

export function assertOutboundResult(result) {
  if (!result || typeof result !== 'object') usageError('outbound result must be an object');
  for (const key of REQUIRED_OUTBOUND_KEYS) {
    if (!(key in result)) {
      usageError(`outbound result is missing "${key}" — present-but-null is required, ` +
                 `an absent key is not (待消解 #2)`);
    }
  }
  if (!isInt(result.attempts) || result.attempts < 1) {
    usageError('outbound result: attempts must be an integer >= 1');
  }
  return result;
}

/**
 * Build one sample record. `extra` carries whatever the layer needs (cell, rep, role,
 * label…); the contract only pins kind/state/attempts.
 */
export function makeSample({ kind, state, attempts, ...extra }) {
  assertKind(kind);
  if (!SAMPLE_STATES[kind].includes(state)) {
    usageError(`state ${JSON.stringify(state)} is not valid for kind "${kind}"; ` +
               `allowed: ${SAMPLE_STATES[kind].join(', ')}`);
  }
  // 判定语义⑤: attempts is a NETWORK count and feeds the run's http_attempts. It is
  // never implied by the sample merely existing.
  if (!isInt(attempts) || attempts < 1) {
    usageError(`sample.attempts must be an integer >= 1, got ${JSON.stringify(attempts)}`);
  }
  return Object.freeze({ kind, state, attempts, ...extra });
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义④ — the two rates
 *
 * Denominator = the LOGICAL SAMPLE COUNT OF THAT SIDE. Never the network attempt
 * count, never the number of responses that came back, and never the length of the
 * array handed in — failed samples may never have reached the array, and then the
 * denominator silently shrinks.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const SIDE = Object.freeze({ SUBJECT: 'subject', CONTROL: 'control' });

export const L1_LOGICAL_SAMPLES = 15;          // 3 cells × 5 reps, subject side only
export const L2_LOGICAL_SAMPLES_PER_SIDE = 90; // 6 cells × 15 reps, per model

/** Gate thresholds, shared by L1 and L2 (判定规则). */
export const VALID_RATE_NOT_APPLICABLE = 0.20; // below this the method does not apply
export const VALID_RATE_LOW_CONFIDENCE = 0.80; // below this, L2 flags low confidence

/**
 * @param {object[]} samples  fingerprint samples for ONE side
 * @param {{logicalSamples: number}} opts  denominator — mandatory and explicit
 * @returns {{valid_rate, response_rate, n_valid, n_responded, logical_samples}}
 */
export function rates(samples, { logicalSamples } = {}) {
  if (!Array.isArray(samples)) usageError('rates(): samples must be an array');
  if (!isInt(logicalSamples) || logicalSamples <= 0) {
    usageError('rates(): logicalSamples must be a positive integer, passed explicitly ' +
               '(deriving it from samples.length hides dropped failures)');
  }
  for (const s of samples) {
    // 判定语义①: asking a non-fingerprint kind for a rate is an ERROR, not a 0. A
    // capability probe answering "400, parameter refused" is a NORMAL profiling result;
    // folding those into a rate makes a healthy endpoint look broken.
    if (s?.kind !== SAMPLE_KIND.FINGERPRINT) {
      usageError(`rates(): ${JSON.stringify(s?.kind)} samples carry no rate (判定语义①); ` +
                 `only ${RATE_BEARING_KINDS.join('/')} do`);
    }
  }
  if (samples.length > logicalSamples) {
    usageError(`rates(): ${samples.length} samples exceed the declared denominator ${logicalSamples}`);
  }
  const n_valid = samples.filter((s) => s.state === 'valid').length;
  // Response rate = the endpoint answered at all. Everything that is not a transport
  // failure counts, including refusals and empty completions — that is exactly what
  // separates "endpoint is broken" from "model is burning the budget on hidden
  // reasoning", which valid_rate alone cannot tell apart.
  const n_responded = samples.filter((s) => s.state !== 'transport_failure').length;

  return Object.freeze({
    n_valid,
    n_responded,
    logical_samples: logicalSamples,
    valid_rate: n_valid / logicalSamples,
    response_rate: n_responded / logicalSamples,
  });
}

/**
 * L2's two sides. 判定语義④'s 🔴: separate denominators of 90, separate gate passes.
 * There is deliberately NO way to ask for a merged 180 rate — subject 90/90 valid with
 * control 0/90 valid would compute to 50% and sail past the gate while H and D are
 * both garbage.
 */
export function l2Rates({ subjectSamples, controlSamples }) {
  return Object.freeze({
    subject: rates(subjectSamples, { logicalSamples: L2_LOGICAL_SAMPLES_PER_SIDE }),
    control: rates(controlSamples, { logicalSamples: L2_LOGICAL_SAMPLES_PER_SIDE }),
  });
}

/** `valid_rate` → gate outcome. Shared by both layers so the thresholds live once. */
export function gateFromValidRate(validRate) {
  if (!isFiniteNum(validRate) || validRate < 0 || validRate > 1) {
    usageError(`valid_rate must be a number in [0,1], got ${JSON.stringify(validRate)}`);
  }
  if (validRate < VALID_RATE_NOT_APPLICABLE) return 'not_applicable';
  return validRate < VALID_RATE_LOW_CONFIDENCE ? 'low_confidence' : 'ok';
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义⑤ — the two counts, never merged
 * ═══════════════════════════════════════════════════════════════════════════ */

export const COUNT_KEYS = Object.freeze({ PROBES: 'probes', ATTEMPTS: 'http_attempts' });

// The plan bans "一个含糊的「实际请求数」字段" without naming it. These are the names
// such a field would plausibly take; rejecting them keeps the ban enforceable.
const FORBIDDEN_MERGED_COUNT_KEYS = Object.freeze([
  'requests', 'requests_sent', 'request_count', 'actual_requests', 'total_requests',
]);

export function countersFromSamples(samples) {
  if (!Array.isArray(samples)) usageError('countersFromSamples(): samples must be an array');
  return Object.freeze({
    probes: samples.length,
    http_attempts: samples.reduce((sum, s) => sum + (s?.attempts ?? 0), 0),
  });
}

export function assertCounters(meta) {
  if (!meta || typeof meta !== 'object') usageError('meta must be an object');
  if (!isInt(meta.probes) || meta.probes < 0) usageError('meta.probes must be a non-negative integer');
  if (!isInt(meta.http_attempts) || meta.http_attempts < 0) {
    usageError('meta.http_attempts must be a non-negative integer');
  }
  // A probe costs at least one attempt; retries only add. attempts < probes is
  // impossible and means someone merged or mislabelled the counts.
  if (meta.http_attempts < meta.probes) {
    usageError(`meta.http_attempts (${meta.http_attempts}) < meta.probes (${meta.probes}): impossible`);
  }
  for (const key of FORBIDDEN_MERGED_COUNT_KEYS) {
    if (key in meta) {
      usageError(`meta.${key} is forbidden (判定语义⑤): with retries the two counts differ, ` +
                 `so a single merged number is always wrong for one of them`);
    }
  }
  return meta;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义⑥ — retry configuration
 * ═══════════════════════════════════════════════════════════════════════════ */

// 🔴 This number counts TOTAL ATTEMPTS, not "retries after the first". Reading it the
// other way turns the per-endpoint ceiling from 180 into 240 requests, and 180 is what
// the compliance table promises the relay operators.
export const RETRY_ATTEMPTS_MIN = 3;      // current quick-check.js:63 is 3 total; no regression
export const RETRY_ATTEMPTS_MAX = 5;      // higher and the budget / ban risk runs away
export const RETRY_ATTEMPTS_DEFAULT = 3;
export const RETRY_BASE_DELAY_MS_DEFAULT = 1500; // matches the withRetry being removed from runner.js

/**
 * Validate BEFORE any request goes out. Never clamp and never silently fall back:
 * clamping desynchronises "I configured 10" from what actually ran, and then budget
 * reconciliation can never be trusted again.
 */
export function assertRetryConfig(retry = {}) {
  const { attempts = RETRY_ATTEMPTS_DEFAULT, baseDelayMs = RETRY_BASE_DELAY_MS_DEFAULT } = retry ?? {};
  if (!isInt(attempts)) {
    usageError(`retry.attempts must be an integer (total attempts, not extra retries), ` +
               `got ${JSON.stringify(attempts)}`);
  }
  if (attempts < RETRY_ATTEMPTS_MIN || attempts > RETRY_ATTEMPTS_MAX) {
    usageError(`retry.attempts ${attempts} is outside [${RETRY_ATTEMPTS_MIN}, ${RETRY_ATTEMPTS_MAX}]`);
  }
  // 待消解 #9 — a non-positive or non-finite delay turns backoff into an instant hammer:
  // three attempts inside a millisecond, which under rate limiting is no backoff at all.
  // Sub-second values stay legal on purpose: contract tests must be able to configure 1ms.
  if (!isFiniteNum(baseDelayMs) || baseDelayMs <= 0) {
    usageError(`retry.baseDelayMs must be a finite number > 0 (ms), got ${JSON.stringify(baseDelayMs)}`);
  }
  return Object.freeze({ attempts, baseDelayMs });
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义⑧ — Responses request body
 * ═══════════════════════════════════════════════════════════════════════════ */

// `store` defaults to true upstream, which would leave freshly generated probe
// questions sitting on the other side — directly against "题库不公开", the one real
// advantage this project has over a static public bank.
export const RESPONSES_RESERVED_KEYS = Object.freeze(['store', 'model', 'input', 'max_output_tokens']);

/**
 * Merge caller `extra` with the fields it must not be able to override. Written so that
 * `extra` is spread FIRST: even if the collision check below were ever removed, the
 * reserved fields would still win. `{store:false, ...extra}` is the broken shape this
 * guards against — it lets `extra.store = true` switch the protection off.
 */
export function buildResponsesBody({ model, input, maxOutputTokens, extra = {} }) {
  if (typeof model !== 'string' || !model) usageError('responses body: model is required');
  if (input === undefined || input === null) usageError('responses body: input is required');
  if (!isInt(maxOutputTokens) || maxOutputTokens <= 0) {
    usageError('responses body: maxOutputTokens must be a positive integer');
  }
  if (extra && typeof extra !== 'object') usageError('responses body: extra must be an object');
  for (const key of Object.keys(extra ?? {})) {
    if (RESPONSES_RESERVED_KEYS.includes(key)) {
      // Throwing beats silently dropping: silently dropping means the caller believes a
      // setting took effect when it did not.
      usageError(`extra.${key} collides with a reserved key (判定语义⑧); ` +
                 `reserved: ${RESPONSES_RESERVED_KEYS.join(', ')}`);
    }
  }
  return { ...extra, model, input, max_output_tokens: maxOutputTokens, store: false };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Verdicts and layer products (待消解 #1)
 * ═══════════════════════════════════════════════════════════════════════════ */

export const VERDICT = Object.freeze({
  CONSISTENT: 'consistent',
  INCONCLUSIVE: 'inconclusive',
  SUSPECT: 'suspect',
  NOT_APPLICABLE: 'not_applicable',
});

/** Row states that share the compare table's verdict column without being verdicts. */
export const ROW_STATE = Object.freeze({
  FINGERPRINT_UNAVAILABLE: 'fingerprint_unavailable',
  SKIPPED: 'skipped',
});

/**
 * Phase 8's sort order, most trustworthy first. `low_confidence` is deliberately absent:
 * it is a separate column and an independent flag, never a verdict value.
 */
export const COMPARE_SORT_ORDER = Object.freeze([
  VERDICT.CONSISTENT,
  VERDICT.INCONCLUSIVE,
  VERDICT.SUSPECT,
  VERDICT.NOT_APPLICABLE,
  ROW_STATE.FINGERPRINT_UNAVAILABLE,
  ROW_STATE.SKIPPED,
]);

export function assertVerdict(v) {
  if (!Object.values(VERDICT).includes(v)) {
    usageError(`not a verdict: ${JSON.stringify(v)}; allowed: ${Object.values(VERDICT).join(', ')}`);
  }
  return v;
}

/**
 * L1 product.
 * 🔴 No low-confidence flag, and `assertL1Result` actively rejects one: L1 requires a
 * full 5 valid samples per cell and drops any cell short of that, so it reaches a
 * verdict only at 15/15 — the 20–80% band is unreachable here. A flag would be dead
 * code that also implies L1 can return a wounded verdict.
 */
export function makeL1Result({ verdict, s_screen, t_pass, t_fail, valid_rate, response_rate,
                               live_cells, noise_floor = null }) {
  assertVerdict(verdict);
  return Object.freeze({
    verdict, s_screen, t_pass, t_fail, valid_rate, response_rate, live_cells,
    noise_floor, // diagnostic print only — never enters the judgement
  });
}

export function assertL1Result(result) {
  if (!result || typeof result !== 'object') usageError('L1 result must be an object');
  for (const forbidden of ['low_confidence', 'lowConfidence']) {
    if (forbidden in result) {
      usageError(`L1 result must not carry ${forbidden}: that branch is unreachable in L1 ` +
                 `(every cell needs a full 5 valid samples), so the flag would be dead code`);
    }
  }
  assertVerdict(result.verdict);
  return result;
}

/**
 * L2 product. Both sides' rates are reported separately, always — there is no merged
 * number to accidentally read, which is what hides "control side is entirely dead".
 */
export function makeL2Result({ verdict, h, s, d, h_c, s_c, d_c, ratio, ratio_ci_lo, ratio_ci_hi,
                               noise_floor, subject, control, low_confidence, live_cells }) {
  assertVerdict(verdict);
  if (typeof low_confidence !== 'boolean') usageError('L2 result: low_confidence must be a boolean');
  return Object.freeze({
    verdict, h, s, d, h_c, s_c, d_c, ratio, ratio_ci_lo, ratio_ci_hi, noise_floor,
    subject: Object.freeze({ ...subject }),   // {valid_rate, response_rate, n_valid, ...}
    control: Object.freeze({ ...control }),
    low_confidence, live_cells,
  });
}

export function assertL2Result(result) {
  if (!result || typeof result !== 'object') usageError('L2 result must be an object');
  assertVerdict(result.verdict);
  for (const merged of ['valid_rate', 'response_rate', 'success_rate']) {
    if (merged in result) {
      usageError(`L2 result must not carry a merged ${merged}: the two sides are reported ` +
                 `separately (判定语义④), and a merged number hides a dead control side`);
    }
  }
  for (const side of ['subject', 'control']) {
    if (!result[side] || typeof result[side] !== 'object') {
      usageError(`L2 result is missing the ${side} side`);
    }
  }
  return result;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 判定语义⑦ — what a request-issuing entry point hands back
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every entry point that issues requests returns {result, samples, meta}. Pure judgement
 * functions (0 requests) return the bare product instead.
 *
 * The previous shape let collectors return only their verdict, so callers never saw the
 * samples — while the result-file contract requires them on disk.
 */
export function makeCollection({ result, samples, meta = {} }) {
  if (!Array.isArray(samples)) usageError('collection: samples must be an array (判定语义⑦)');
  const counts = countersFromSamples(samples);
  return Object.freeze({
    result,
    samples: Object.freeze([...samples]),
    meta: Object.freeze(assertCounters({ ...meta, ...counts })),
  });
}

export function assertCollection(collection) {
  if (!collection || typeof collection !== 'object') usageError('collection must be an object');
  if (!('result' in collection)) usageError('collection is missing `result`');
  if (!Array.isArray(collection.samples)) usageError('collection is missing `samples[]` (判定语义⑦)');
  assertCounters(collection.meta ?? usageError('collection is missing `meta`'));

  const counts = countersFromSamples(collection.samples);
  if (collection.meta.probes !== counts.probes) {
    usageError(`meta.probes (${collection.meta.probes}) != samples.length (${counts.probes})`);
  }
  if (collection.meta.http_attempts !== counts.http_attempts) {
    usageError(`meta.http_attempts (${collection.meta.http_attempts}) != ` +
               `Σ samples[].attempts (${counts.http_attempts})`);
  }
  return collection;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Result-file meta — the 重跑边界 promise
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * "Result file + local reference is enough to recompute without re-sampling" holds only
 * if these survive to disk: the samples alone cannot tell you which reference version,
 * which cells, how many reps, or which thresholds produced the verdict.
 */
export const REPLAY_KEYS_BASE = Object.freeze(['reference_version', 'cells', 'reps_per_cell']);
export const REPLAY_KEYS_L1 = Object.freeze([...REPLAY_KEYS_BASE, 't_pass', 't_fail']);

export function assertReplayableMeta(meta, { tier }) {
  assertCounters(meta);
  const required = tier === 'l1' ? REPLAY_KEYS_L1 : REPLAY_KEYS_BASE;
  for (const key of required) {
    if (meta[key] === undefined || meta[key] === null) {
      usageError(`meta.${key} is required for tier "${tier}" — without it the run cannot be ` +
                 `recomputed at the same calibration (重跑边界)`);
    }
  }
  // The key never goes to disk; only the variable's NAME does.
  const serialised = JSON.stringify(meta);
  if (/\bsk-[A-Za-z0-9_-]{6,}/.test(serialised) || 'api_key' in meta || 'key' in meta) {
    usageError('meta must never carry key material — record the env var NAME (auth_env) only');
  }
  return meta;
}
