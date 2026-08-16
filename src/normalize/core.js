// Normalisation — the parts that run anywhere.
//
// Split out of index.js so the browser build can reach them without dragging `node:fs`
// along. The split is by PLATFORM DEPENDENCY, not by convenience: everything here is
// pure given `loadVendorConfig()`, and everything left in index.js touches the disk.
//
// 🔴 Nothing in this file may be reimplemented on the ui/ side. The answer-level logic is
// vendored verbatim from upstream and `test/golden/g0-normalize.test.js` proves the whole
// pipeline matches upstream's published normalized.jsonl; a second copy would be a second
// thing to keep matching, and a mismatch here does not error — it silently voids every
// comparison downstream.

import { createNormalizer, detectReasoningPairs, emittedTrace } from '../../vendor/pamela/normalize-core.js';
import { loadVendorConfig } from './vendor-config.js';

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
 *   the paper's 176-model DB  built WITH it (normalizeRuns in index.js).
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
