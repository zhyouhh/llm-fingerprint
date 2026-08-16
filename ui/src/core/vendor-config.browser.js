// Browser stand-in for src/normalize/vendor-config.js (see vite.config.js).
//
// 🔴 Same two files, bundled instead of read. Not a browser-flavoured copy of the battery:
// these imports point at vendor/pamela/ itself, so a prompt change reaches the web build
// and the CLI in the same commit. If this file ever grows logic, the split has gone wrong.

import prompts from '../../../vendor/pamela/config/prompts.json';
import colorLex from '../../../vendor/pamela/stats/color-lexicon.json';

export function loadVendorConfig() {
  return { prompts, colorLex };
}
