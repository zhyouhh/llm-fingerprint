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
import { identify, identification, MIN_ID_CELLS } from '../../../src/layers/model-matrix.js';
import { oldestAge } from '../../../src/layers/l2-calibrate.js';
import { L2_MIN_N } from '../../../src/stats/guards.js';
import { mergeCollections } from '../../../src/contracts.js';

import { proxyPaths } from './endpoint.js';
import { referencesFor, referenceFor } from './references.js';

/** Browsers cap same-origin connections; 6 also matches the CLI default. */
export const DEFAULT_CONCURRENCY = 6;

/**
 * Build the three outbound clients for one endpoint. They differ only in which path they
 * append — all three go through the same Worker rewrite.
 */
export function clientsFor({ baseUrl, apiKey, protocol, cancelled }) {
  // 🔴 Required, explicit null allowed — the precedent is `applyReasoningTrace` and `refs`.
  // A default of null read as "this caller has no cancel flag", and one call site that
  // merely FORGOT looked identical: L2's preflight built its clients without one, so a
  // worker that hit a 429 during preflight sat out the full cooldown and then retried,
  // after the user had pressed Stop. Omission and intent must not look the same.
  if (cancelled === undefined) {
    throw new Error('clientsFor: pass `cancelled` (a () => boolean), or explicit null when the ' +
      'caller has no way to stop. Without it a worker parked in a shared 429 cooldown cannot ' +
      'hear Stop — wrapping the probe only refuses probes that have not started yet.');
  }
  const { baseUrl: proxyBase, origin: proxyOrigin } = proxyPaths(baseUrl);
  return {
    proxyBase,
    proxyOrigin,
    get: createGetProbe(),
    // 🔴 `cancelled` goes all the way to `request`. Wrapping the probe only refuses jobs that
    // have not started; a worker already inside a shared 429 pause holds the timer itself,
    // and without this Stop left six of them waiting out the cooldown and then retrying.
    client: createResponsesClient({ baseUrl: proxyBase, apiKey, cancelled }),
    probe: fingerprintProbeFactory(protocol)({ baseUrl: proxyBase, apiKey, cancelled }),
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
  // L0 has no cancel path — it is 24 probes and a few seconds. Explicit, not defaulted.
  const { get, client, proxyBase, proxyOrigin } = clientsFor({ baseUrl, apiKey, protocol, cancelled: null });

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
                              probeWrap = (p) => p, cancelled = null, onProgress = () => {} }) {
  const refSubject = await requireReference(model, protocol, 'subject');
  const refControl = await requireReference(control, protocol, 'control');
  assertProtocols(refSubject, refControl, protocol);

  const { probe } = clientsFor({ baseUrl, apiKey, protocol, cancelled });
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

/**
 * 🔴 `sampleControl` defaults to FALSE here and to true in the CLI, and the difference is
 * deliberate rather than drift. See pickControl above for why the web never sightings the
 * control: nobody can pick it correctly, and a substituted one reverses the verdict.
 *
 * Re-judged against every stored run, dropping it moved no genuine endpoint off green —
 * and it flipped one archived false CONSISTENT (both model names substituted, the two
 * errors cancelling inside H) to inconclusive. Halves the probes, halves the wall clock.
 */
export async function runL2({ baseUrl, apiKey, model, control, protocol = 'responses',
                              sampleControl = false, concurrency = DEFAULT_CONCURRENCY,
                              probeWrap = (p) => p, cancelled = null, onProgress = () => {} }) {
  const refSubject = await requireReference(model, protocol, 'subject');
  const refControl = await requireReference(control, protocol, 'control');
  assertProtocols(refSubject, refControl, protocol);

  const { probe } = clientsFor({ baseUrl, apiKey, protocol, cancelled });
  return calibrateL2({
    probe: probeWrap(probe), subject: model, control, refSubject, refControl,
    // The whole library — the identification route is what names a same-generation swap,
    // and it has no answer with only the two references this run samples against.
    refs: await referencesFor(protocol),
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
export async function estimate({ tier, model, control, protocol, sampleControl = false, latencyMs = 2500,
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
export async function identifyRun({ samples, protocol, role = 'subject', sold = null, validRate }) {
  // 🔴 The MEASURED rate, handed in from the stored result — never recomputed from the rows
  // that happen to be here. Explicit null means "this record does not say", which withholds
  // the name rather than assuming the run was complete.
  if (validRate === undefined) {
    throw new Error('identifyRun: pass `validRate` from the stored result (or explicit null). ' +
      'Recomputing it from `samples` divides by the rows that survived, so a truncated record ' +
      'reads as 100% valid and re-convicts a run the decision layer withheld.');
  }
  const refs = await referencesFor(protocol);
  // Split by MODEL when the rows carry one — the same discriminator rejudge uses — with
  // role as the fallback for archives that only labelled sides.
  const { dist: measured, reps } = distributionOf(samples, { model: sold, role });
  const soldRef = sold ? refs.find((r) => r.model === sold) : null;
  const result = identify(measured, refs);
  return {
    ...result,
    // 🔴 The accusation itself comes from src/, the same call evaluateL2 makes — the
    // report must not re-apply the separation and cell rules with its own copy of the
    // numbers. Recomputed rather than read off the stored result on purpose: a stored
    // verdict is the judgement of the day it ran, and the library has grown since.
    //
    // 🔴 …and with the SAME inputs, which is where this went wrong: it passed a flat
    // `repsPerCell` and no valid rate at all, so a run `evaluateL2` had held back to
    // inconclusive for a 57% valid rate re-convicted itself the moment someone opened the
    // report. A rule enforced in one caller is not a rule.
    identification: soldRef
      ? identification(measured, refs, sold, {
        reps,
        validRate,
        // 🔴 The oldest of EVERY reference that takes part, matching `evaluateL2` exactly.
        // Reading only the defended model's date here meant the same run reported two
        // different ages depending on which code path rendered it, and the smaller one
        // came from the page — a two-day-old subject reference next to a candidate whose
        // fingerprint is a year old, displayed as "2 days".
        referenceAgeDays: oldestAge([soldRef, ...refs]),
      })
      : null,
    // 🔴 How many cells the MEASUREMENT produced, before the library had any say. Without
    // it the report cannot tell "no cell reached ten valid samples" from "the library could
    // not line up with the cells we did measure" — both arrive as an empty ranking, and the
    // page attributed every one of them to thin sampling, sending the reader to fix probes
    // that were fine.
    measuredCells: Object.keys(measured).length,
    // 🔴 The bar chart shows `identify`'s own ranking, NOT a fresh pairwise meanJsd. Those
    // are different numbers — pairwise intersects per candidate, the ranking uses one
    // shared cell set — and the page was capable of naming B in the headline while drawing
    // A as the nearest bar underneath it.
    distances: result.ranked.map((x) => ({ model: x.model, value: x.value, cells: x.cells })),
  };
}

/**
 * cell → empirical distribution over valid answers, for one side of a run.
 *
 * 🔴 Cells with fewer than `minN` valid samples are DROPPED, exactly as evaluateL2 drops
 * them. Without this the page reconstructed every cell that had a single answer in it, so
 * twelve cells of nine samples each — which L2 refuses outright — could produce an exact
 * match to another model and a red accusation on screen. That is the UI applying a
 * materially different input rule while claiming to share the decision.
 */
export function distributionOf(samples, { role = null, model = null } = {}, minN = L2_MIN_N) {
  // 🔴 `model` first, because that is what `rejudge` splits on — and the two must not be
  // able to disagree about the same file. `role` is not a contract field: `makeSample` pins
  // only kind/state/attempts, so an archive can legitimately carry no roles at all.
  //
  // The old test was `role && s.role && s.role !== role`, which lets a sample with NO role
  // through for every role. On a record without roles that silently merged subject and
  // control into one distribution — 15 samples of A and 15 of B read as one 50/50 cell —
  // and if some third reference happens to look like that mixture, the page names it and
  // the CLI, reading only A's rows, does not.
  const wanted = (s) => {
    if (model != null && s.model != null) return s.model === model;
    if (role != null && s.role != null) return s.role === role;
    return true;
  };
  // 🔴 EVERY row must be labelled, not merely "not some of them". A file with no labels at
  // all used to fall through to `return true` for every row, which is the exact averaging
  // this guard exists to stop — an honest subject A and control B, fifteen samples each and
  // no labels, become one 30-sample 50/50 cell, and if some reference happens to look like
  // that mixture the page names it while the re-judge path, splitting by model, does not.
  // "There is only one side in here" is not something the rows can prove, so it is refused
  // rather than assumed.
  if ((model != null || role != null) && samples.length
      && !samples.every((s) => s.model != null || s.role != null)) {
    throw new Error('distributionOf: these samples carry no model/role on every row, so the ' +
      'subject and control sides cannot be told apart. Mixing them averages two models into ' +
      'one distribution — which is how the page and the re-judge path came to disagree about ' +
      'the same file. Re-run the measurement, or drop this record.');
  }
  const counts = {};
  for (const s of samples) {
    if (!wanted(s)) continue;
    if (s.state !== 'valid' || s.normalized == null) continue;
    const cell = `${s.task_id}|${s.lang}`;
    (counts[cell] ??= {})[s.normalized] = (counts[cell][s.normalized] ?? 0) + 1;
  }
  const out = {};
  // 🔴 Per-cell counts travel with the distribution, so the noise floor can describe the
  // measurement each cell actually got rather than the one the run planned.
  //
  // ⚠️ The valid RATE is deliberately NOT computed here. Its denominator is the planned
  // logical sample count, not `samples.length` — see `rates()` in contracts.js, which
  // refuses to derive it precisely because failures that never reached the array would
  // vanish from the denominator. A run saved mid-flight, or truncated, has exactly that
  // shape: 120 rows of 210 planned would read as 100% valid and re-convict a run the
  // decision layer had already withheld. It comes from the stored result instead.
  const reps = {};
  for (const [cell, c] of Object.entries(counts)) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    if (n < minN) continue;
    out[cell] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
    reps[cell] = n;
  }
  return { dist: out, reps };
}

/* ── the yardstick model (formerly "the control") ───────────────────────────── */

/**
 * Pick the second model L2 needs. It is never sampled from the web, so it is never asked
 * about either — this runs automatically and the result does not appear in the UI.
 *
 * 🔴 It used to be a dropdown, and that was a design error worth recording. The control
 * calibration rests on one assumption — the control model is genuine on BOTH sides — and
 * that assumption is exactly what the run exists to test: a relay was measured serving
 * gpt-5.6-luna under the names sol AND terra, so choosing terra as the control put a
 * substituted model in the denominator. Worse, the choice moved the verdict: the same 840
 * samples convict with one control and acquit with another, which made a dropdown nobody
 * could answer correctly decide whether a vendor got accused.
 *
 * Not sampling it removes both problems, and leaves this function two jobs, both offline:
 *
 *   selectCells   which cells separate the pair — a far model lights up more cells
 *   D             the "what a model swap looks like" scale in evaluateL2's S/D test
 *
 * FURTHEST still wins for the first job. ⚠️ It is the wrong end of the range for the
 * second: a swap to the NEAREST neighbour scores S ≈ that neighbour's distance, and
 * measured against the furthest model's D it cannot reach the 0.7 accusation line on 8 of
 * the 10 references — no matter how many probes are spent. The identification layer is
 * what actually catches those, which is why it now leads the report. Splitting D off onto
 * the nearest neighbour is a change to the judgement layer in src/, not to this wiring.
 *
 * `available` is accepted but no longer filters: with no sampling, the endpoint does not
 * have to sell the yardstick model. An endpoint offering exactly one model with a
 * reference used to be unrunnable at L2 for no reason at all.
 *
 * @param {{subject: string, available?: string[], matrix: object}} args
 * @returns {{control: string|null, distance: number, candidates: Array}}
 */
/**
 * Fewest LIVE cells a control may offer and still be worth running.
 *
 * 🔴 Live, not shared, and the difference is not pedantic. `matrix.cells` counts cells both
 * references can be compared on; `selectCells` then discards every cell where the two agree
 * (`signal <= DEAD_CELL_SIGNAL`), because a cell both models answer identically cannot tell
 * them apart. A pair sharing forty cells and disagreeing on two passes a shared-cell bar of
 * twelve and then hands L1 two cells to screen on and L2 two live cells — which its own gate
 * refuses outright. Counting the wrong quantity produced BOTH errors at once: unrunnable
 * pairs accepted, and pairs with ten live cells rejected although L1 needs only three.
 *
 * Three is L1's requirement and L2's hard gate, so it is the point below which nothing at
 * all can run. Whether twelve are available — the identification route's bar — is reported
 * separately in `liveCells`, for a caller deciding which tiers to offer.
 */
export const PICK_CONTROL_MIN_LIVE = 3;

export function pickControl({ subject, matrix, minLive = PICK_CONTROL_MIN_LIVE }) {
  const idx = matrix.models.indexOf(subject);
  const all = matrix.models
    .map((m, j) => ({
      model: m,
      distance: idx >= 0 ? matrix.matrix[idx][j] : NaN,
      // 🔴 How many cells that distance is a mean OVER, and how many of those can actually
      // discriminate. Sorting means computed over different cell counts as though they were
      // comparable is the mistake this whole review kept finding; here it has a second cost,
      // because the pair's live cells ARE the cells the run will collect.
      cells: idx >= 0 ? (matrix.cells?.[idx]?.[j] ?? 0) : 0,
      liveCells: idx >= 0 ? (matrix.live?.[idx]?.[j] ?? 0) : 0,
      // 🔴 And whether this pair can be calibrated at all. A reference carrying a
      // fingerprint but no samples keeps its cells (it is refused on other grounds) and
      // yields a NaN pair floor — the map knows the comparison has no resolution limit, and
      // choosing it anyway starts a run whose D rests on a fingerprint nothing can scale.
      floor: idx >= 0 ? (matrix.pairFloors?.[idx]?.[j] ?? NaN) : NaN,
    }))
    .filter((c) => c.model !== subject && Number.isFinite(c.distance));
  const why = (c) => (c.liveCells < minLive ? `只有 ${c.liveCells} 个有区分度的格子，至少要 ${minLive}`
    : !Number.isFinite(c.floor) ? '这一对算不出噪声地板（参照没带样本）'
      : null);
  const candidates = all.filter((c) => why(c) === null)
    .sort((a, b) => b.distance - a.distance || a.model.localeCompare(b.model));
  return {
    control: candidates[0]?.model ?? null,
    distance: candidates[0]?.distance ?? NaN,
    cells: candidates[0]?.cells ?? 0,
    liveCells: candidates[0]?.liveCells ?? 0,
    candidates,
    // Reported, never silent: a caller that offers a tier has to know the difference between
    // "no reference for this model" and "references exist but none can serve as a yardstick".
    rejected: all.filter((c) => why(c) !== null).map((c) => ({ ...c, reason: why(c) })),
  };
}

/**
 * Which tiers can actually run, given what the library holds.
 *
 * 🔴 A decision, so it lives where a test can reach it. It used to be one boolean computed
 * inside the view's closure — `hasRef`, true when both model names were known — and it
 * enabled BOTH tiers. L1 screens on three cells and the identification route will not name
 * a model under twelve, so a control clearing only the lower bar let the page offer L2 and
 * promise "which model is it", and the run then spent 150 probes to arrive at
 * `withheld: 'cells'`, guaranteed before it started.
 *
 * @param {{subject: string, known: Set<string>, yardstick: {l1: object, l2: object}}} args
 * @returns {{l0: true, l1: boolean, l2: boolean, controlL1: string, controlL2: string}}
 */
export function tierAvailability({ subject, known, matrix }) {
  // 🔴 The two `pickControl` calls happen HERE, not in the caller. Leaving them outside and
  // taking pre-built yardsticks meant the numbers that decide — 3 for the screen, 12 for
  // naming — still lived in the view's closure, where changing `minLive: MIN_ID_CELLS` back
  // to 3 re-enabled an L2 that cannot name and every test still passed. A decision is only
  // as testable as its inputs.
  const l1 = pickControl({ subject, matrix, minLive: PICK_CONTROL_MIN_LIVE });
  const l2 = pickControl({ subject, matrix, minLive: MIN_ID_CELLS });
  const has = (m) => Boolean(m) && known.has(m);
  return {
    l0: true,
    l1: has(subject) && has(l1.control),
    l2: has(subject) && has(l2.control),
    controlL1: l1.control ?? '',
    controlL2: l2.control ?? '',
    yardstick: { l1, l2 },
  };
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
