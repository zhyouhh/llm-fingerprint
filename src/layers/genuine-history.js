// Live screens against a known-genuine endpoint, harvested from result files.
//
// This is what turns T_pass from a simulation into a measurement. The simulated
// calibration resamples the reference pool and therefore cannot produce an answer the
// pool lacks — exactly the event that costs a cell 0.108 — so on a deterministic
// reference it under-estimates the genuine spread badly enough to reject the genuine
// endpoint two runs in five.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROTOCOL } from '../lib/reference-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS = path.join(ROOT, 'var', 'runs');

/**
 * @param {{endpointId: string, model: string, referenceVersion?: string,
 *          fingerprintProtocol?: string}} filter
 * @returns {number[]} S_screen from every stored screen matching the filter
 */
export function genuineScreenScores({
  endpointId, model, referenceVersion = null, fingerprintProtocol = null, runsDir = RUNS,
}) {
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const f of readdirSync(runsDir).filter((x) => x.startsWith(`${endpointId}__l1__`))) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(runsDir, f), 'utf8')); } catch { continue; }
    if (j.meta?.model !== model) continue;
    // 🔴 Scores computed against a different reference version are a different
    // measurement and must not be pooled — that is how a stale run would widen the bar
    // for the current one.
    if (referenceVersion && j.meta?.reference_version !== referenceVersion) continue;
    // 🔴 Same argument, one axis over: an S measured on the other wire is not a sample of
    // this threshold's distribution at all. Runs from before the split carry no field and
    // are chat by construction.
    if (fingerprintProtocol && (j.meta?.fingerprint_protocol ?? DEFAULT_PROTOCOL) !== fingerprintProtocol) continue;
    if (typeof j.result?.s_screen === 'number') out.push(j.result.s_screen);
  }
  return out;
}

/** The endpoint whose genuineness is established outside this tool (supply chain). */
export function genuineEndpointId(endpoints) {
  return endpoints.find((e) => e.genuine)?.id ?? null;
}
