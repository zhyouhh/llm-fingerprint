// A genuine reference is addressed by (model, protocol) — never by model alone.
//
// 🔴 Why the protocol lives in the PATH and not only in the file:
//
// refresh-reference merges a partial refresh into whatever file already exists. While a
// model had exactly one reference file, `--cells l1 --fp-protocol responses` inherited
// the five cells it did not re-collect — chat data — and then stamped the merged file
// `fingerprint_protocol: "responses"`. assertSameProtocol reads that stamp, so the guard
// passed with five of eight cells measured on the other wire.
//
// That is the normalisation-mismatch failure one level deeper: not a missing guard, but
// a guard reading a field the writer had just made untrue. Splitting the directory makes
// the merge structurally same-protocol — there is no longer a file to inherit the wrong
// cells from. loadReference still checks the stamp, for files moved by hand.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageError } from './errors.js';
import { FINGERPRINT_PROTOCOLS } from '../probe/http/fingerprint-probe.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_REFERENCE_ROOT = path.join(REPO_ROOT, 'reference');

/** Files written before the split carry no `fingerprint_protocol`; they are all chat. */
export const DEFAULT_PROTOCOL = 'chat';

export const PROTOCOL_IDS = Object.freeze(Object.keys(FINGERPRINT_PROTOCOLS));

function assertKnown(protocol) {
  if (!FINGERPRINT_PROTOCOLS[protocol]) {
    usageError(`unknown fingerprint protocol ${JSON.stringify(protocol)} — expected one of ${PROTOCOL_IDS.join(' | ')}`);
  }
  return protocol;
}

/** @returns {string} `<root>/<protocol>/genuine-<model>.json` */
export function referencePath(model, protocol, { root = DEFAULT_REFERENCE_ROOT } = {}) {
  assertKnown(protocol);
  if (typeof model !== 'string' || model.trim() === '') usageError('referencePath: model is required');
  return path.join(root, protocol, `genuine-${model}.json`);
}

export function referenceExists(model, protocol, opts = {}) {
  return existsSync(referencePath(model, protocol, opts));
}

/**
 * Read one reference, verifying that the directory it sits in and the protocol it
 * declares agree. A file hand-copied into the wrong directory is the one way the path
 * split can still produce a cross-protocol comparison.
 */
export function loadReference(model, protocol, opts = {}) {
  const file = referencePath(model, protocol, opts);
  if (!existsSync(file)) {
    usageError(`missing ${path.relative(REPO_ROOT, file)} — collect it once from a known-genuine endpoint:\n` +
               `  node scripts/refresh-reference.js --endpoint <genuine-id> --model ${model} ` +
               `--cells all --fp-protocol ${protocol}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    usageError(`reference is not valid JSON (${path.relative(REPO_ROOT, file)}): ${err.message}`);
  }
  const declared = parsed.fingerprint_protocol ?? DEFAULT_PROTOCOL;
  if (declared !== protocol) {
    usageError(`${path.relative(REPO_ROOT, file)} sits under ${protocol}/ but declares ` +
               `fingerprint_protocol ${JSON.stringify(declared)}. One of the two is wrong, and ` +
               `comparing against it would silently mix wires. Move it to ${declared}/ or re-collect.`);
  }
  return parsed;
}

/** Protocols that have a reference for EVERY model in `models`. */
export function availableProtocols(models, opts = {}) {
  return PROTOCOL_IDS.filter((p) => models.every((m) => referenceExists(m, p, opts)));
}

/**
 * Decide which protocol a run should use.
 *
 * Explicit request wins. Otherwise: exactly one protocol has the full set → use it (no
 * reason to make the caller name the only option); more than one → make them choose,
 * because guessing here is guessing the meaning of the whole comparison.
 *
 * @param {{models: string[], requested?: string|null, root?: string, flag?: string}} args
 */
export function resolveProtocol({ models, requested = null, root, flag = '--fp-protocol' }) {
  const opts = root ? { root } : {};
  if (requested != null) {
    assertKnown(requested);
    const missing = models.filter((m) => !referenceExists(m, requested, opts));
    if (missing.length) {
      usageError(`no ${requested} reference for ${missing.join(', ')} — collect it first:\n` +
                 missing.map((m) => `  node scripts/refresh-reference.js --endpoint <genuine-id> ` +
                                    `--model ${m} --cells all --fp-protocol ${requested}`).join('\n'));
    }
    return requested;
  }
  const have = availableProtocols(models, opts);
  if (have.length === 1) return have[0];
  if (have.length === 0) {
    usageError(`no protocol has a reference for all of ${models.join(', ')}.\n` +
               PROTOCOL_IDS.map((p) => `  ${p}: ${models.filter((m) => referenceExists(m, p, opts)).join(', ') || '(none)'}`).join('\n') +
               `\nCollect the missing ones with scripts/refresh-reference.js --cells all --fp-protocol <p>.`);
  }
  usageError(`references exist for more than one protocol (${have.join(', ')}) — pass ${flag} to say ` +
             `which comparison you mean. They are not interchangeable: the same question produces ` +
             `different distributions on the two wires.`);
}
