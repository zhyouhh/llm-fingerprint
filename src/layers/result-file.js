// Result files — the whole storage contract for milestone 1.
//
// `var/runs/<endpoint-id>__<tier>__<UTC-ISO-seconds>.json`, holding {meta, samples, result}.
//
// 🔴 Two counts, never merged: with retries the logical probe count and the network
// attempt count necessarily differ, so a single "requests" number is always wrong for
// one of them. Budget reconciliation reads the first, cost and rate-limit exposure the
// second.
//
// 🔴 No key ever reaches disk. meta records the NAME of the environment variable.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCollection, countersFromSamples } from '../contracts.js';

// Moved to contracts.js so the browser build can merge L0's two halves the same way —
// re-exported here because every existing caller imports it from this module.
export { mergeCollections } from '../contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNS_DIR = path.join(ROOT, 'var', 'runs');

/** UTC to the second — enough to order runs, short enough to read. */
export function stamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
}

/**
 * @param {{endpointId, tier, result, samples, meta, now?}} args
 * @returns {string} the path written
 */
export function writeResultFile({ endpointId, tier, result, samples, meta = {}, now = new Date() }) {
  const payload = {
    meta: {
      endpoint_id: endpointId,
      tier,
      utc: now.toISOString(),
      ...meta,
      ...countersFromSamples(samples),
    },
    samples,
    result,
  };
  assertCollection(payload);

  const serialised = JSON.stringify(payload, null, 2);
  // Cheap belt-and-braces on the "no keys on disk" rule: the loader already keeps keys
  // out of endpoint objects, but this file is the thing that actually persists.
  if (/\bsk-[A-Za-z0-9_-]{6,}/.test(serialised)) {
    throw new Error('refusing to write a result file containing what looks like an API key');
  }

  mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${endpointId}__${tier}__${stamp(now)}.json`);
  writeFileSync(file, `${serialised}\n`);
  return file;
}
