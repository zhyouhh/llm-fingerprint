// Knowledge-cutoff probes: does the endpoint know facts a stale model could not?
//
// These differ from the reasoning probes in kind. A reasoning answer is COMPUTED, so it
// can be generated fresh every run and checked against a solver. A knowledge answer is a
// real-world fact that only a trusted source can supply — there is no solver, so the
// items are CURATED (probes/knowledge.json) rather than generated. That inherits hvoy's
// weakness: a curated bank can eventually be read out of a relay's logs. It is mitigated,
// not cured, by sampling a random subset from a pool and by keeping each item auditable
// (source + date).
//
// Scope caveat, stated so no one over-trusts a green result: this only catches a swap to
// a model whose cutoff PREDATES the events. It cannot separate two current-generation
// models, and under the subscription-reverse threat model an arbitrary old model is not
// even sourceable — so this layer is the weakest of the four for that case.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadBank() {
  return JSON.parse(readFileSync(path.join(ROOT, 'probes', 'knowledge.json'), 'utf8'));
}

/**
 * Deterministic subset selection given a seed, so a run is reproducible but a relay
 * cannot predict which items it will face next time.
 */
export function sample(items, n, seed) {
  let s = seed >>> 0;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
  const pool = items.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

/**
 * An answer counts as correct if any accepted form appears as a whole-word match,
 * and the model did not decline. UNKNOWN is scored as not-correct but tracked
 * separately — a stale model saying UNKNOWN is the intended negative signal, not noise.
 *
 * @returns {{correct: boolean, unknown: boolean}}
 */
export function grade(reply, accepted) {
  const t = String(reply ?? '').toLowerCase();
  if (/\bunknown\b/.test(t) || !t.trim()) return { correct: false, unknown: true };
  const hit = accepted.some((a) => new RegExp(`\\b${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
  return { correct: hit, unknown: false };
}
