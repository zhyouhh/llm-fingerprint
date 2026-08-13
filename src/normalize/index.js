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
 * Same semantics as normalizeRuns() below, reasoning-trace pre-pass included:
 * `post_reasoning` is decided per (model, provider) across the WHOLE batch using
 * upstream's `n >= 20 && rsn/n >= 0.3` threshold (vendor/pamela/normalize-core.js:120).
 * One consequence worth knowing rather than rediscovering: L1 collects 15 samples a run
 * and can never trip that threshold, while L2's 90-per-side can. The asymmetry belongs
 * to the threshold, not to either layer.
 *
 * @param {object[]} records raw records in upstream's responses.jsonl shape
 * @returns {object[]} the same records plus {normalized, answer_class, color_canon}
 */
export function normalizeRecords(records) {
  const { prompts, colorLex } = loadVendorConfig();
  const normalize = createNormalizer(prompts, colorLex);
  const reasoningPairs = detectReasoningPairs(records);

  return records.map((rec) => {
    const n = normalize(rec);
    if (emittedTrace(rec, reasoningPairs)) n.answer_class = 'post_reasoning';
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
