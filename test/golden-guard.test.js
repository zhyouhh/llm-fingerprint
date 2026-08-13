// The safety net's own safety net: does the golden-test guard actually fail?
//
// This is the one thing `npm test` cannot demonstrate about itself — if the guard were
// broken, every golden suite would vanish and the run would still print pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireUpstream, ALLOW_MISSING_ENV, MISSING_MESSAGE, UPSTREAM } from './helpers/upstream.js';

const emptyRoot = mkdtempSync(path.join(tmpdir(), 'llmfp-no-upstream-'));

test('missing data throws, and the message says how to fix it', () => {
  assert.throws(
    () => requireUpstream({ upstreamRoot: emptyRoot, env: {} }),
    (err) => /npm run fetch-data/.test(err.message) && /npm run verify-data/.test(err.message),
  );
});

test('the escape hatch has to be asked for, and then it skips instead', () => {
  const reason = requireUpstream({ upstreamRoot: emptyRoot, env: { [ALLOW_MISSING_ENV]: '1' } });
  assert.equal(typeof reason, 'string');
  assert.match(reason, new RegExp(ALLOW_MISSING_ENV));

  // Only the exact opt-in counts — a stray truthy value must not disarm the net.
  for (const sloppy of ['0', 'true', 'yes', '']) {
    assert.throws(() => requireUpstream({ upstreamRoot: emptyRoot, env: { [ALLOW_MISSING_ENV]: sloppy } }),
      Error, `${ALLOW_MISSING_ENV}=${sloppy}`);
  }
});

test('the guard agrees with what is actually on this disk', () => {
  // Must hold in both states, or this file becomes the one test that fails whenever the
  // escape hatch is in use — which is precisely when the rest of the suite must stay green.
  const hasData = existsSync(path.join(UPSTREAM, 'results', 'verification.json'));
  if (hasData) {
    assert.equal(requireUpstream({ env: {} }), false, 'data is present → run the suites');
  } else {
    assert.throws(() => requireUpstream({ env: {} }), Error, 'data is absent → fail loudly');
    assert.equal(typeof requireUpstream({ env: { [ALLOW_MISSING_ENV]: '1' } }), 'string',
      'data is absent but the hatch is open → skip');
  }
});

test('the failure message names all three routes', () => {
  for (const needle of ['npm run fetch-data', 'npm run verify-data', ALLOW_MISSING_ENV]) {
    assert.ok(MISSING_MESSAGE.includes(needle), needle);
  }
});
