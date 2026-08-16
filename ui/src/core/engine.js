// Wiring, not logic.
//
// Every judgement below comes from src/ unchanged — profileL0a/L0b, screenL1,
// calibrateL2, selectCells, identify. This module's whole job is to hand them a probe
// that goes through the Worker, a reference loaded from public/data, and a progress
// callback the UI can draw. Nothing here decides anything.
//
// 🔴 If you find yourself computing a distance, a threshold or a verdict in this file,
// it belongs in src/ where the golden tests and the CLI can see it.

import { createGetProbe } from '../../../src/probe/http/get.js';
import { createResponsesClient } from '../../../src/probe/http/responses.js';
import { fingerprintProbeFactory, assertSameProtocol, FINGERPRINT_PROTOCOLS } from '../../../src/probe/http/fingerprint-probe.js';
import { profileL0a, profileL0b } from '../../../src/layers/l0-profile.js';
import { screenL1 } from '../../../src/layers/l1-screen.js';
import { calibrateL2 } from '../../../src/layers/l2-calibrate.js';
import { selectCells } from '../../../src/probe/cells.js';
import { identify, meanJsd } from '../../../src/layers/model-matrix.js';
import { mergeCollections } from '../../../src/contracts.js';

import { proxyPaths } from './endpoint.js';
import { referencesFor, referenceFor } from './references.js';

/** Browsers cap same-origin connections; 6 also matches the CLI default. */
export const DEFAULT_CONCURRENCY = 6;

/**
 * Build the three outbound clients for one endpoint. They differ only in which path they
 * append — all three go through the same Worker rewrite.
 */
export function clientsFor({ baseUrl, apiKey, protocol }) {
  const { baseUrl: proxyBase, origin: proxyOrigin } = proxyPaths(baseUrl);
  return {
    proxyBase,
    proxyOrigin,
    get: createGetProbe(),
    client: createResponsesClient({ baseUrl: proxyBase, apiKey }),
    probe: fingerprintProbeFactory(protocol)({ baseUrl: proxyBase, apiKey }),
  };
}

/**
 * GET /models, so the model picker offers what this endpoint actually serves rather than
 * asking someone to type an id from memory.
 *
 * @returns {Promise<{models: string[], error: object|null, status: number|null}>}
 */
export async function listModels({ baseUrl, apiKey }) {
  const { baseUrl: proxyBase } = proxyPaths(baseUrl);
  const res = await createGetProbe()({ url: `${proxyBase}/models`, apiKey });
  if (res.error) return { models: [], error: res.error, status: res.http_status };
  const data = Array.isArray(res.body?.data) ? res.body.data : [];
  const models = data.map((m) => m?.id).filter((id) => typeof id === 'string').sort();
  return { models, error: null, status: res.http_status };
}

/* ── L0 ─────────────────────────────────────────────────────────────────────── */

/**
 * @param {{baseUrl, apiKey, model, protocol, onStep}} args
 * @returns {Promise<object>} an L0 collection: L0a's profile merged with L0b's
 */
export async function runL0({ baseUrl, apiKey, model, protocol = 'responses', onStep = () => {} }) {
  const { get, client, proxyBase, proxyOrigin } = clientsFor({ baseUrl, apiKey, protocol });

  onStep({ phase: 'l0a', label: '读端点开放信息（0 次补全）' });
  const a = await profileL0a({ get, baseUrl: proxyBase, origin: proxyOrigin, apiKey });

  // No model means L0b cannot run at all — all 24 of its probes carry one in the body.
  // Merging with a null half keeps the result shape identical to the CLI's, so the same
  // reader handles both.
  const b = model ? await runL0b() : null;

  const merged = mergeCollections([a, b], { resultKeys: ['l0a', 'l0b'] });
  return { ...merged, meta: { ...merged.meta, tier: 'l0', model: model ?? null, protocol } };

  async function runL0b() {
    onStep({ phase: 'l0b', label: '能力探测：14 项参数 + juice + 注入量（~24 次）' });
    return profileL0b({ client, model, protocol });
  }
}

/* ── L1 ─────────────────────────────────────────────────────────────────────── */

/**
 * `probeWrap` is how cancellation reaches the sampler. runBattery has no abort signal —
 * adding one would touch the CLI's retry/budget contract — so the browser wraps the probe
 * instead and returns a synthetic transport failure once the user has asked to stop. The
 * loop then drains in milliseconds and the caller throws the result away.
 */
export async function runL1({ baseUrl, apiKey, model, control, protocol = 'responses',
                              probeWrap = (p) => p, onProgress = () => {} }) {
  const refSubject = await requireReference(model, protocol, 'subject');
  const refControl = await requireReference(control, protocol, 'control');
  assertProtocols(refSubject, refControl, protocol);

  const { probe } = clientsFor({ baseUrl, apiKey, protocol });
  return screenL1({
    probe: probeWrap(probe), model, refSubject, refControl, fpProtocol: protocol,
    // 🔴 Empty on purpose. genuineScores widens T_pass with S values measured on a
    // KNOWN-GENUINE endpoint, and a public visitor has no such endpoint on file. Feeding
    // it their own history would calibrate "genuine" from an endpoint under suspicion —
    // the threshold would drift to accept whatever they keep measuring.
    genuineScores: [],
    onProgress,
  });
}

/* ── L2 ─────────────────────────────────────────────────────────────────────── */

export async function runL2({ baseUrl, apiKey, model, control, protocol = 'responses',
                              sampleControl = true, concurrency = DEFAULT_CONCURRENCY,
                              probeWrap = (p) => p, onProgress = () => {} }) {
  const refSubject = await requireReference(model, protocol, 'subject');
  const refControl = await requireReference(control, protocol, 'control');
  assertProtocols(refSubject, refControl, protocol);

  const { probe } = clientsFor({ baseUrl, apiKey, protocol });
  return calibrateL2({
    probe: probeWrap(probe), subject: model, control, refSubject, refControl,
    fpProtocol: protocol, sampleControl, concurrency, onProgress,
  });
}

/* ── planning: what a run will cost, before it is started ───────────────────── */

/** L0b's fixed shape: 8 efforts + 2 modes + 4 params + 8 juice + 2 injection. */
export const L0B_PROBES = 24;
export const L0A_PROBES = 0;

/**
 * @returns {Promise<{probes: number, cells: number, repsPerCell: number, minutes: number}>}
 *   `probes` is logical probes; retries can push the HTTP count higher.
 */
export async function estimate({ tier, model, control, protocol, sampleControl = true, latencyMs = 2500,
                                 concurrency = DEFAULT_CONCURRENCY }) {
  if (tier === 'l0') return withTime({ probes: L0A_PROBES + L0B_PROBES, cells: 0, repsPerCell: 0 });

  const refSubject = await referenceFor(model, protocol);
  const refControl = await referenceFor(control, protocol);
  if (!refSubject || !refControl) return withTime({ probes: NaN, cells: 0, repsPerCell: 0 });

  const selection = selectCells(refSubject, refControl, { tier });
  const sides = tier === 'l2' && sampleControl ? 2 : 1;
  return withTime({
    probes: selection.cells.length * selection.repsPerCell * sides,
    cells: selection.cells.length,
    repsPerCell: selection.repsPerCell,
    liveCells: selection.liveCount,
    dead: selection.dead,
  });

  function withTime(plan) {
    return { ...plan, minutes: (plan.probes * latencyMs) / concurrency / 60_000 };
  }
}

/* ── identification: which reference is this shaped like ────────────────────── */

/**
 * Fold a finished run's samples into a per-cell distribution and name it.
 *
 * 🔴 Judged on separation from the runner-up, never on absolute distance — the absolute
 * value carries the relay's harness and there is no control to subtract it with here.
 * src/layers/model-matrix.js holds that rule; this only supplies the input.
 */
export async function identifyRun({ samples, protocol, role = 'subject' }) {
  const refs = await referencesFor(protocol);
  const measured = distributionOf(samples, role);
  const result = identify(measured, refs);
  return {
    ...result,
    cells: Object.keys(measured).length,
    // Distance to every reference, for the report's bar chart.
    distances: refs.map((r) => ({ model: r.model, ...meanJsd(measured, r.fingerprint ?? {}) })),
  };
}

/** cell → empirical distribution over valid answers, for one side of a run. */
export function distributionOf(samples, role = null) {
  const counts = {};
  for (const s of samples) {
    if (role && s.role && s.role !== role) continue;
    if (s.state !== 'valid' || s.normalized == null) continue;
    const cell = `${s.task_id}|${s.lang}`;
    (counts[cell] ??= {})[s.normalized] = (counts[cell][s.normalized] ?? 0) + 1;
  }
  const out = {};
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    out[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
  }
  return out;
}

/* ── control picking ────────────────────────────────────────────────────────── */

/**
 * Choose the control model.
 *
 * 🔴 D — how far apart the subject and the control genuinely are — is the yardstick a
 * substitution gets measured against, so the best control is the FURTHEST model both the
 * endpoint and the reference library have. Picking a near neighbour shrinks D toward the
 * noise floor and the run comes back inconclusive by construction.
 *
 * @param {{subject, available: string[], matrix, protocol}} args
 * @returns {{control: string|null, distance: number, candidates: Array}}
 */
export function pickControl({ subject, available, matrix }) {
  const idx = matrix.models.indexOf(subject);
  const offered = new Set(available);
  const candidates = matrix.models
    .map((m, j) => ({ model: m, distance: idx >= 0 ? matrix.matrix[idx][j] : NaN }))
    .filter((c) => c.model !== subject && offered.has(c.model) && Number.isFinite(c.distance))
    .sort((a, b) => b.distance - a.distance);
  return { control: candidates[0]?.model ?? null, distance: candidates[0]?.distance ?? NaN, candidates };
}

/* ── guards ─────────────────────────────────────────────────────────────────── */

async function requireReference(model, protocol, role) {
  if (!model) throw new Error(`需要指定${role === 'control' ? '对照' : '待验'}模型`);
  const ref = await referenceFor(model, protocol);
  if (!ref) {
    const have = (await referencesFor(protocol)).map((r) => r.model).join('、');
    throw new Error(`参照库里没有 ${model}（${protocol} 线）。现有：${have || '（无）'}`);
  }
  return ref;
}

function assertProtocols(refSubject, refControl, protocol) {
  // Both references must agree with each other, and with the wire this run will use.
  assertSameProtocol(refSubject.fingerprint_protocol, refControl.fingerprint_protocol ?? 'chat');
  assertSameProtocol(refSubject.fingerprint_protocol, protocol);
}

export { FINGERPRINT_PROTOCOLS };
