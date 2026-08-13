// Locating the upstream Zenodo payload, which is gitignored (~500 MB extracted).
//
// 🔴 Missing data is a FAILURE, not a skip. The golden tests are the only thing keeping
// the statistics honest, and a safety net that silently switches itself off is at its
// most dangerous exactly when the statistics are being rewritten. `npm test` printing
// "pass 13" with all three golden suites quietly absent is the failure mode this
// guards against.
//
// Escape hatch: set LLMFP_ALLOW_MISSING_GOLDEN=1 to get the old skip behaviour, e.g. on
// a machine where the 500 MB download is not worth it. It has to be asked for.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Extracted upstream dataset root (contains data/ and results/). */
export const UPSTREAM = path.join(ROOT, 'data', 'upstream', 'data');

/** Extracted upstream source tree (contains config/, stats/, run/). */
export const UPSTREAM_CODE = path.join(ROOT, 'data', 'upstream', 'code');

export const ALLOW_MISSING_ENV = 'LLMFP_ALLOW_MISSING_GOLDEN';

export const MISSING_MESSAGE =
  'upstream Zenodo data missing — golden tests cannot run.\n' +
  '  Fix:   npm run fetch-data      (~52MB download, ~500MB extracted, one-off)\n' +
  '  Check: npm run verify-data     (lists exactly what is missing)\n' +
  `  Skip:  ${ALLOW_MISSING_ENV}=1 npm test   (explicitly accept running without the safety net)`;

/**
 * @param {{upstreamRoot?: string, env?: object}} [opts] injection points for testing
 * @returns {false|string} false when the data is present (do not skip); the skip reason
 *   when it is absent AND the escape hatch is set.
 * @throws {Error} when the data is absent and the escape hatch is not set.
 */
export function requireUpstream({ upstreamRoot = UPSTREAM, env = process.env } = {}) {
  if (existsSync(path.join(upstreamRoot, 'results', 'verification.json'))) return false;
  if (env[ALLOW_MISSING_ENV] === '1') {
    return `upstream Zenodo data missing — skipped via ${ALLOW_MISSING_ENV}=1`;
  }
  throw new Error(MISSING_MESSAGE);
}
