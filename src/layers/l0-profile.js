// L0 — endpoint profiling, in two halves with very different price tags.
//
// L0a costs zero completions: two GETs and the response headers. It answers "what KIND
// of thing am I talking to" — and that alone catches a relay claiming to be a direct
// official API, because official APIs do not serve /api/status and do not stamp
// x-oneapi-request-id.
//
// L0b costs ~24 probes and answers "what does it accept": which effort levels, which
// reasoning modes, whether logprobs/seed/n are accepted.
//
// 🔴 That last group does NOT mean "bare API", which is what this comment used to claim.
// Measured against OpenAI directly on 2026-08-14: the vendor API refuses top_logprobs,
// seed and n over Responses — they belong to /chat/completions, and reasoning models do
// not expose logprobs on this wire. Accepting them is therefore a difference FROM the
// vendor, usually a gateway swallowing parameters it does not implement.
//
// The signal that DOES separate endpoint types is the injected preamble: ~7 tokens on the
// vendor API, ~294 on the self-hosted subscription gateway, thousands on some resellers.
//
// 🔴 Nothing here gates L1 or L2. Whether /models answers says nothing about whether
// /chat/completions works: some compatible endpoints serve chat without implementing
// /models, and the reverse happens too. The only real answer to "can this be
// fingerprinted" is L1's first sampling run.

import { SAMPLE_KIND, classifySample, makeSample, makeCollection } from '../contracts.js';
import { JUICE_PROMPT, parseJuice } from '../probes/juice.js';

/** The eight effort levels worth probing, coarsest first. */
export const EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const REASONING_MODES = Object.freeze(['standard', 'pro']);

/**
 * What one acceptance row is allowed to say.
 *
 * 🔴 `null` is not `false`. A 4xx is the endpoint telling us it will not take that
 * parameter; a 5xx is the endpoint falling over, which says nothing about the parameter
 * at all. Collapsing the two was a real bug, caught on the very first live run: three
 * 503s produced a profile claiming the gateway "does not support seed / n / temperature".
 */
export const ACCEPTANCE = Object.freeze({
  YES: true,                 // 2xx
  NO: false,                 // 4xx — a statement about this parameter
  UNKNOWN: null,             // 5xx / network — probed, learned nothing
  NOT_PROBED: 'not_probed',  // never asked (wrong protocol for this parameter)
});

const STATE_TO_ACCEPTANCE = Object.freeze({
  accepted: ACCEPTANCE.YES,
  rejected: ACCEPTANCE.NO,
  transport_failure: ACCEPTANCE.UNKNOWN,
  not_probed: ACCEPTANCE.NOT_PROBED,
});

/** 14 probed parameters: 8 efforts + 2 modes + logprobs + seed + n + temperature. */
export const ACCEPTANCE_KEYS = Object.freeze([
  ...EFFORT_LEVELS.map((e) => `effort:${e}`),
  ...REASONING_MODES.map((m) => `mode:${m}`),
  'top_logprobs', 'seed', 'n', 'temperature',
]);

/** Injection measurement: two inputs of known, different length. */
const INJECTION_SHORT = 'Hi.';
const INJECTION_LONG = `Hi. ${'word '.repeat(200)}`.trim();

/**
 * Infer what sort of thing this is from headers and the open status endpoint.
 * Display only — 决策 #1's point is that endpoint type is cheap context, not a verdict.
 */
export function inferEndpointKind({ headers = {}, statusOk = false, modelsOk = false }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if ('x-oneapi-request-id' in h || 'x-newapi-request-id' in h) return 'oneapi-newapi';
  if (Object.keys(h).some((k) => k.startsWith('x-cpa-'))) return 'cliproxyapi';
  if (statusOk) return 'oneapi-like';            // serves an open /api/status
  if ('openai-organization' in h || 'openai-processing-ms' in h) return 'openai-direct-or-passthrough';
  return modelsOk ? 'openai-compatible' : 'unknown';
}

/**
 * L0a — zero completion requests.
 *
 * @param {{get: Function, baseUrl: string, origin: string, apiKey?: string}} args
 * @returns {Promise<object>} a collection envelope (判定语义⑦)
 */
export async function profileL0a({ get, baseUrl, origin, apiKey }) {
  const status = await get({ url: `${origin}/api/status` });        // open endpoint, no auth
  const models = await get({ url: `${baseUrl}/models`, apiKey });

  const samples = [status, models].map((r, i) => makeSample({
    kind: SAMPLE_KIND.REACHABILITY,
    state: classifySample(SAMPLE_KIND.REACHABILITY, { error: r.error }),
    attempts: r.attempts,
    label: i === 0 ? 'status' : 'models',
    http_status: r.http_status,
    latency_ms: r.latency_ms,
  }));

  const headers = models.headers ?? status.headers ?? {};
  const statusOk = !status.error;
  const modelsOk = !models.error;

  return makeCollection({
    result: {
      // 🔴 Display only (I-16). Two-way non-implication: reachable does not mean chat
      // works, unreachable does not mean it does not.
      models_endpoint_reachable: modelsOk,
      endpoint_kind: inferEndpointKind({ headers, statusOk, modelsOk }),
      status_endpoint: statusOk ? String(status.raw ?? '').slice(0, 32_768) : null,
      headers,
      model_count: Array.isArray(models.body?.data) ? models.body.data.length : null,
    },
    samples,
    meta: { tier: 'l0a', probes_kind: 'reachability' },
  });
}

/**
 * L0b — capability probing over the Responses API.
 *
 * @param {{client: Function, model: string, protocol: 'responses'|'chat'}} args
 *   `client` is injected so the whole layer stays testable against a stub.
 * @returns {Promise<object>} a collection envelope
 */
export async function profileL0b({ client, model, protocol = 'responses' }) {
  if (!model) {
    // 24 probes, every one of which needs a model in its body — a missing model would
    // fail 24 times identically and read as "this endpoint rejects everything".
    throw new Error('profileL0b requires a model');
  }
  const samples = [];
  const acceptance = {};
  const juiceByEffort = {};

  // 🔴 One judgement, used twice. The acceptance row is DERIVED from the sample state
  // rather than recomputed from `!r.error` — that second copy is what turned three 503s
  // into "does not support seed / n / temperature" on the first live run, while the
  // sample sitting right beside it correctly said transport_failure.
  const record = (label, r, { probed = true } = {}) => {
    const state = classifySample(SAMPLE_KIND.CAPABILITY, { error: r?.error ?? null, probed });
    samples.push(makeSample({
      kind: SAMPLE_KIND.CAPABILITY,
      state,
      attempts: r?.attempts ?? 1,
      label,
      http_status: r?.http_status ?? null,
      error_code: r?.error?.code ?? null,
    }));
    return STATE_TO_ACCEPTANCE[state];
  };

  // A chat-only endpoint cannot answer any of this: effort and reasoning.mode only take
  // effect on Responses, so probing them there measures the protocol, not the endpoint.
  const canProbeReasoning = protocol === 'responses';

  if (canProbeReasoning) {
    for (const effort of EFFORT_LEVELS) {
      const r = await client({ model, input: 'Say OK.', maxOutputTokens: 16, reasoning: { effort } });
      acceptance[`effort:${effort}`] = record(`effort:${effort}`, r);
    }
    for (const mode of REASONING_MODES) {
      const r = await client({ model, input: 'Say OK.', maxOutputTokens: 16, reasoning: { mode } });
      acceptance[`mode:${mode}`] = record(`mode:${mode}`, r);
    }
  }

  const extras = [
    ['top_logprobs', { top_logprobs: 1, include: ['message.output_text.logprobs'] }],
    ['seed', { seed: 42 }],
    ['n', { n: 2 }],
    // 🔴 I-11: temperature is NOT sent by default anywhere in L0b — reasoning models
    // often 400 on it, which would contaminate every other row with a false negative.
    // It is probed exactly once, here, as the subject of its own probe.
    ['temperature', { temperature: 1 }],
  ];

  if (canProbeReasoning) {
    for (const [label, extra] of extras) {
      const r = await client({ model, input: 'Say OK.', maxOutputTokens: 16, extra });
      acceptance[label] = record(label, r);
    }
  } else {
    // 🔴 The whole matrix is skipped on a chat-only endpoint, not just the reasoning
    // half: these probes go out over Responses, and an endpoint that does not serve
    // Responses would refuse all of them for that reason alone. The result would be a
    // profile row saying "does not support seed" when what we learned was "wrong
    // protocol" — the same mistake that once produced a flatly inverted conclusion
    // about effort forwarding. This keeps L0b at 2 probes there (the injection pair).
    for (const key of ACCEPTANCE_KEYS) {
      // `not_probed`, not `false` and not `unsupported`: we never asked. Recording a
      // refusal we never received is the difference between "this endpoint lacks the
      // feature" and "we did not look".
      acceptance[key] = ACCEPTANCE.NOT_PROBED;
    }
  }

  // Juice: one read per effort level. Red light only — see src/probes/juice.js.
  if (canProbeReasoning) {
    for (const effort of EFFORT_LEVELS) {
      const r = await client({ model, input: JUICE_PROMPT, maxOutputTokens: 64, reasoning: { effort } });
      juiceByEffort[effort] = r.error ? null : parseJuice(r.raw);
      record(`juice:${effort}`, r);
    }
  }

  // Injection: two inputs whose lengths differ by a known amount. The intercept is the
  // gateway's own preamble — 305 input_tokens for a three-token input means ~300 of
  // wrapper, and a wrapper is what makes cross-endpoint fingerprints incomparable.
  const short = await client({ model, input: INJECTION_SHORT, maxOutputTokens: 16 });
  record('injection:short', short);
  const long = await client({ model, input: INJECTION_LONG, maxOutputTokens: 16 });
  record('injection:long', long);

  const shortIn = short.usage?.input_tokens ?? null;
  const longIn = long.usage?.input_tokens ?? null;
  let injectionTokens = null;
  if (Number.isFinite(shortIn) && Number.isFinite(longIn) && longIn > shortIn) {
    // tokens = intercept + k·length. Two points give the slope; the intercept is what
    // the gateway added on top of our own text.
    const slope = (longIn - shortIn) / (INJECTION_LONG.length - INJECTION_SHORT.length);
    injectionTokens = Math.max(0, Math.round(shortIn - slope * INJECTION_SHORT.length));
  }

  return makeCollection({
    result: {
      acceptance,                       // all 14 keys, always
      juice_by_effort: canProbeReasoning ? juiceByEffort : null,
      injection_tokens: injectionTokens,
      effort_probe_unavailable: !canProbeReasoning,
      reasoning_echo: short.reasoning_echo ?? null,
      model_reported: short.model_reported ?? null,
    },
    samples,
    meta: { tier: 'l0b', model, protocol },
  });
}
