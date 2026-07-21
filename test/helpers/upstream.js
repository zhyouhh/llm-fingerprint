// Locating the upstream Zenodo payload, which is gitignored (~500 MB extracted).
// Golden tests skip with a clear instruction rather than failing when it is absent.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Extracted upstream dataset root (contains data/ and results/). */
export const UPSTREAM = path.join(ROOT, 'data', 'upstream', 'data');

/** Extracted upstream source tree (contains config/, stats/, run/). */
export const UPSTREAM_CODE = path.join(ROOT, 'data', 'upstream', 'code');

/**
 * @returns {false|string} false when present (do not skip), else the skip reason.
 */
export function requireUpstream() {
  const probe = path.join(UPSTREAM, 'results', 'verification.json');
  if (existsSync(probe)) return false;
  return 'upstream Zenodo data missing — run `npm run fetch-data` first';
}
