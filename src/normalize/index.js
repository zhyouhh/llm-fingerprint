// Normalisation pipeline — merges raw runs and canonicalises answers.
//
// Mirrors upstream `stats/01-normalize.js` (see vendor/pamela/). The answer-level
// logic is vendored verbatim; this file only reproduces the surrounding pipeline:
// run selection, dedupe by `key`, the reasoning-trace pre-pass, and the output
// record shape. `test/golden/g0-normalize.test.js` proves the whole thing matches
// upstream's published normalized.jsonl.
//
// 🔴 This module is the NODE half. The platform-independent half lives in ./core.js and
// the two JSON reads in ./vendor-config.js, so the browser build (ui/) can import the
// same normalisation without `node:fs`. The re-exports below keep this file's public
// surface unchanged — every existing `from '../normalize/index.js'` still works.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../lib/jsonl.js';
import { createNormalizer, detectReasoningPairs, emittedTrace } from '../../vendor/pamela/normalize-core.js';
import { loadVendorConfig } from './vendor-config.js';

export { loadVendorConfig } from './vendor-config.js';
export { studyATasks, normalizeRecords } from './core.js';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

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
