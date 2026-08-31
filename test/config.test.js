import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadEndpoints, getEndpoint, resolveKey, listWithKeys, UsageError,
} from '../src/lib/config.js';

const dir = mkdtempSync(path.join(tmpdir(), 'llmfp-config-'));

function fixture(name, obj) {
  const p = path.join(dir, `${name}.json`);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

const ONE = {
  endpoints: [{
    id: 'alpha',
    name: 'Alpha relay',
    base_url: 'https://alpha.example.com/v1',
    protocol: 'responses',
    auth_env: 'ALPHA_KEY',
    models: { subject: 'gpt-5.6-sol', control: 'gpt-5.4' },
  }],
};

test('known id resolves to an endpoint', () => {
  const ep = getEndpoint('alpha', { configPath: fixture('one', ONE) });
  assert.equal(ep.id, 'alpha');
  assert.equal(ep.base_url, 'https://alpha.example.com/v1');
  assert.equal(ep.origin, 'https://alpha.example.com'); // L0a's /api/status hangs off the origin, not the base
  assert.equal(ep.models.subject, 'gpt-5.6-sol');
});

test('unknown id is a usage error (exit code 2), not a crash', () => {
  const configPath = fixture('one2', ONE);
  assert.throws(
    () => getEndpoint('nope', { configPath }),
    (err) => err instanceof UsageError && err.exitCode === 2 && /unknown endpoint id/.test(err.message),
  );
});

test('empty --endpoint is a usage error', () => {
  assert.throws(() => getEndpoint('', { configPath: fixture('one3', ONE) }), UsageError);
});

test('missing key returns a skip marker and does NOT throw', () => {
  // acceptance scenario 4: compare.js must skip this row and keep going.
  const ep = getEndpoint('alpha', { configPath: fixture('one4', ONE) });
  const got = resolveKey(ep, {});                 // empty env
  assert.equal(got.available, false);
  assert.equal(got.auth_env, 'ALPHA_KEY');
  assert.match(got.reason, /ALPHA_KEY/);
  assert.equal(got.key, undefined);

  assert.equal(resolveKey(ep, { ALPHA_KEY: '   ' }).available, false, 'whitespace-only is not a key');
});

test('present key resolves, and the endpoint object still carries none', () => {
  const configPath = fixture('one5', ONE);
  const ep = getEndpoint('alpha', { configPath });
  const got = resolveKey(ep, { ALPHA_KEY: 'sk-CANARY-config-test' });

  assert.equal(got.available, true);
  assert.equal(got.key, 'sk-CANARY-config-test');

  // 🔴 the whole point of splitting resolveKey() out: an endpoint object is safe to
  // serialise into a result file.
  assert.doesNotMatch(JSON.stringify(ep), /sk-CANARY/);
  assert.doesNotMatch(JSON.stringify(loadEndpoints({ configPath })), /sk-CANARY/);
  assert.equal(ep.auth_env, 'ALPHA_KEY', 'the variable NAME is what gets recorded');
});

test('listWithKeys marks unavailable rows as skipped instead of failing', () => {
  const two = {
    endpoints: [
      ONE.endpoints[0],
      { ...ONE.endpoints[0], id: 'beta', name: 'Beta', base_url: 'https://beta.example.com/v1', auth_env: 'BETA_KEY' },
    ],
  };
  const rows = listWithKeys({ configPath: fixture('two', two), env: { ALPHA_KEY: 'k' } });
  assert.deepEqual(rows.map((r) => [r.endpoint.id, r.skipped]), [['alpha', false], ['beta', true]]);
  assert.match(rows[1].reason, /BETA_KEY/);
});

test('schema violations are usage errors', () => {
  const cases = {
    'missing field': { endpoints: [{ id: 'a', name: 'A', base_url: 'https://a.example.com/v1', protocol: 'chat' }] },
    'bad protocol': { endpoints: [{ ...ONE.endpoints[0], protocol: 'grpc' }] },
    'trailing slash': { endpoints: [{ ...ONE.endpoints[0], base_url: 'https://a.example.com/v1/' }] },
    'relative url': { endpoints: [{ ...ONE.endpoints[0], base_url: '/v1' }] },
    'duplicate id': { endpoints: [ONE.endpoints[0], ONE.endpoints[0]] },
    'not an array': { endpoints: {} },
  };
  for (const [label, cfg] of Object.entries(cases)) {
    assert.throws(() => loadEndpoints({ configPath: fixture(label.replace(/\W/g, '_'), cfg) }), UsageError, label);
  }
  assert.throws(() => loadEndpoints({ configPath: fixture('broken', '{not json') }), UsageError, 'invalid JSON');
  assert.throws(() => loadEndpoints({ configPath: path.join(dir, 'absent.json') }), UsageError, 'missing file');
});

test('a key pasted into the config file is rejected outright', () => {
  const leaked = { endpoints: [{ ...ONE.endpoints[0], notes: 'sk-live-oops' }] };
  assert.throws(
    () => loadEndpoints({ configPath: fixture('leaked', leaked) }),
    (err) => err instanceof UsageError && /looks like an API key/.test(err.message),
  );
});

// The committed template, not config/endpoints.json — that one is gitignored (it holds
// the base_url of every real candidate), so a fresh clone has only the example to check.
test('the committed example config is valid and key-free', () => {
  const examplePath = path.join(
    path.dirname(new URL(import.meta.url).pathname), '..', 'config', 'endpoints.example.json',
  );
  const all = loadEndpoints({ configPath: examplePath });
  assert.ok(all.length >= 1, 'at least one candidate endpoint is configured');
  assert.doesNotMatch(JSON.stringify(all), /sk-/, 'no key material in the example config');
  for (const ep of all) assert.ok(ep.auth_env.length > 0);
});
