// Normalisation pipeline — merges raw runs and canonicalises answers.
//
// Mirrors upstream `stats/01-normalize.js` (see vendor/pamela/). The answer-level
// logic is vendored verbatim; this file only reproduces the surrounding pipeline:
// run selection, dedupe by `key`, the reasoning-trace pre-pass, and the output
// record shape. `test/golden/g0-normalize.test.js` proves the whole thing matches
// upstream's published normalized.jsonl.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../lib/jsonl.js';
import { createNormalizer, detectReasoningPairs, emittedTrace } from '../../vendor/pamela/normalize-core.js';

const VENDOR = new URL('../../vendor/pamela/', import.meta.url);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Load the vendored prompt battery and colour lexicon. */
export function loadVendorConfig() {
  return {
    prompts: readJson(new URL('config/prompts.json', VENDOR)),
    colorLex: readJson(new URL('stats/color-lexicon.json', VENDOR)),
  };
}

/**
 * The Study-A fingerprint battery: paper-1 tasks only (10 tasks × 4 languages = 40
 * cells). Upstream collects 15 tasks in the same runs, but the coordination /
 * anticoordination / secrecy tasks belong to a pre-registered DISJOINT analysis
 * (Study B) and must never contribute fingerprint dimensions.
 *
 * @returns {Set<string>} task ids
 */
export function studyATasks(prompts) {
  return new Set(prompts.tasks.filter((t) => t.paper === 1).map((t) => t.id));
}

/** Runs whose manifest notes begin with "ABANDONED" never enter analysis by default. */
export function selectRuns(runsDir, explicit = null) {
  if (explicit) return explicit;
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((id) => {
    const mp = path.join(runsDir, id, 'manifest.json');
    return !(existsSync(mp) && /^ABANDONED/.test(readJson(mp).notes ?? ''));
  });
}

/**
 * Normalise records already in memory — the live sampling path, where nothing has been
 * written to disk yet.
 *
 * 🔴 `applyReasoningTrace` MUST match whatever the comparison target was normalised
 * with. This is not a tuning knob — it is the "采样参数不可改" constraint in a second
 * guise, and getting it wrong silently voids the comparison:
 *
 *   reference/genuine-*.json  collected WITHOUT the trace pass. 154 of its 240 samples
 *                             carry reasoning_len > 0 (this model routinely emits 9–13
 *                             reasoning tokens) yet every one is answer_class 'valid'.
 *                             → L1/L2 must pass `applyReasoningTrace: false`.
 *   the paper's 176-model DB  built WITH it (normalizeRuns below).
 *                             → ranking against it must pass true.
 *
 * Applying it against reference/ marks two thirds of a perfectly healthy run as
 * post_reasoning, drops the cells, and reports the project's own genuine endpoint as
 * inconclusive. That is exactly what happened on the first live screen.
 *
 * <sub>⚠️ A note that was wrong and is worth correcting explicitly: the `n >= 20`
 * threshold in detectReasoningPairs does NOT gate this. emittedTrace flags any record
 * with reasoning_len > 0 outright; the threshold only governs INFERRING the flag for
 * older records that lack the field. A 15-sample L1 run trips it immediately.</sub>
 *
 * @param {object[]} records raw records in upstream's responses.jsonl shape
 * @param {{applyReasoningTrace?: boolean}} [opts]
 * @returns {object[]} the same records plus {normalized, answer_class, color_canon}
 */
export function normalizeRecords(records, { applyReasoningTrace = true } = {}) {
  const { prompts, colorLex } = loadVendorConfig();
  const normalize = createNormalizer(prompts, colorLex);
  const reasoningPairs = applyReasoningTrace ? detectReasoningPairs(records) : new Set();

  return records.map((rec) => {
    const n = normalize(rec);
    if (applyReasoningTrace && emittedTrace(rec, reasoningPairs)) n.answer_class = 'post_reasoning';
    return { ...rec, ...n };
  });
}

/**
 * Normalise one or more raw runs into analysis-ready records.
 *
 * Nothing is dropped: invalid / refusal / empty / post_reasoning answers stay in the
 * output, flagged via `answer_class`, so every exclusion downstream is countable.
 *
 * @param {string} runsDir            directory holding <run-id>/responses.jsonl
 * @param {object} opts
 * @param {string[]|null} opts.runs   explicit run ids (bypasses the ABANDONED filter)
 * @returns {Promise<object[]>}       normalised records
 */
export async function normalizeRuns(runsDir, { runs = null } = {}) {
  const { prompts, colorLex } = loadVendorConfig();
  const normalize = createNormalizer(prompts, colorLex);
  const runIds = selectRuns(runsDir, runs);
  if (!runIds.length) throw new Error(`No runs found in ${runsDir}`);

  const filesFor = (id) => path.join(runsDir, id, 'responses.jsonl');

  // Pre-pass: derive which (model, provider) pairs emit hidden reasoning traces.
  const pairInput = [];
  for (const id of runIds) {
    for await (const rec of readJsonl(filesFor(id))) pairInput.push(rec);
  }
  const reasoningPairs = detectReasoningPairs(pairInput);

  const seen = new Set();
  const out = [];
  for (const rec of pairInput) {
    if (rec.error || seen.has(rec.key)) continue;
    seen.add(rec.key);
    const n = normalize(rec);
    if (emittedTrace(rec, reasoningPairs)) n.answer_class = 'post_reasoning';
    out.push({
      key: rec.key, run_id: rec.run_id, model: rec.model, provider: rec.provider,
      task_id: rec.task_id, lang: rec.lang, temperature: rec.temperature, rep: rec.rep,
      request_utc: rec.request_utc, raw: rec.raw, ...n,
    });
  }
  return out;
}
