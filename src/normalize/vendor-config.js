// The vendored prompt battery and colour lexicon — Node implementation.
//
// 🔴 This file exists to be the ONLY thing the browser build has to swap out. Everything
// that reads these two JSON files goes through `loadVendorConfig()`, so `ui/`'s Vite
// config aliases this one module to a three-line version that imports the same two files
// as bundled JSON. Nothing else is platform-specific, and in particular no normalisation
// or judgement logic is ever duplicated for the browser — that class of copy is what
// 开发日志 2026-08-14 calls the project's most expensive bug.
//
// Cached because the browser side is cached by construction (module-level import): an
// uncached Node side would be the same data with different timing, and "the two platforms
// differ only in ways nobody wrote down" is how drift starts.

import { readFileSync } from 'node:fs';

const VENDOR = new URL('../../vendor/pamela/', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

let cached = null;

/**
 * @returns {{prompts: object, colorLex: object}} the frozen upstream battery.
 *   Treat as read-only — callers share one instance.
 */
export function loadVendorConfig() {
  cached ??= {
    prompts: readJson(new URL('config/prompts.json', VENDOR)),
    colorLex: readJson(new URL('stats/color-lexicon.json', VENDOR)),
  };
  return cached;
}
