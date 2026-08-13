// Shared CLI plumbing: argument parsing, --help, and the endpoint/key handshake.
//
// The plan's CLI 契约 pins three exit codes and every script must honour the same ones:
//   0 = ran to completion (whatever the verdict was)
//   1 = runtime failure (network dead, reference missing, cannot write)
//   2 = usage error (unknown flag, unknown endpoint id, missing key)
//
// 🔴 The verdict is NOT expressed through the exit code. A relay judged `suspect` is a
// successful run — the tool did its job. Folding that into the exit status would make
// `&&` chains and any future scheduler treat a correct detection as a crash.

import { getEndpoint, resolveKey } from './config.js';
import { UsageError } from './errors.js';

/** `--flag value` and bare `--flag` (⇒ true). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    out[token.slice(2)] = next === undefined || next.startsWith('--') ? true : next;
  }
  return out;
}

/**
 * Resolve `--endpoint <id>` into an endpoint plus its key, handling --help and the
 * usage-error exit path.
 *
 * @param {object} args    parsed arguments
 * @param {{usage: string, requireKey?: boolean}} opts
 * @returns {{endpoint: object, apiKey: string|null}}
 */
export function resolveEndpointArg(args, { usage, requireKey = true }) {
  if (args.help || args.h) {
    console.log(usage.trim());
    process.exit(0);          // asking for help is not an error
  }
  try {
    const endpoint = getEndpoint(typeof args.endpoint === 'string' ? args.endpoint : '');
    if (!requireKey) return { endpoint, apiKey: null };
    const key = resolveKey(endpoint);
    if (!key.available) throw new UsageError(`${key.reason}\n  Put it in .env, or point auth_env at a variable that is set.`);
    return { endpoint, apiKey: key.key };
  } catch (err) {
    console.error(err instanceof UsageError ? err.message : String(err?.stack ?? err));
    console.error(`\n${usage.trim()}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}

/** Wrap a main() so an unexpected throw exits 1 rather than printing a raw rejection. */
export async function runMain(main) {
  try {
    await main();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(String(err?.stack ?? err));
    process.exit(1);
  }
}
