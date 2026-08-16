// Smoke tests for the pieces that broke, or could break, without saying so.
//
// 🔴 Why this file exists: the first render of the site was missing its header and its
// entire hero, and nothing errored. `h('div', someNode)` had been treating the node as a
// props object, Object.entries() of a DOM node is empty, and so the child was silently
// dropped. That is the same failure shape as this project's most expensive bugs — no
// exception, no symptom, just a result that quietly means something else.
//
// Run with `npm --prefix ui test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTarget, assertHostAllowed, ProxyError, ALLOWED_SUFFIXES, isLocalDeployment }
  from '../worker/proxy.js';
import { normaliseBaseUrl, proxyPaths, EndpointError } from '../src/core/endpoint.js';
import { rehydrate } from '../src/core/references.js';
import { band } from '../src/components/heatmap.js';
import { modeOf, displayCells } from '../src/components/fingerprint-grid.js';
import { validAnswersByCell } from '../../src/stats/noise.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = JSON.parse(readFileSync(path.join(ROOT, 'ui/public/data/references.json'), 'utf8'));

/* ── the proxy is the only server-side code; its guards are the security model ── */

const inbound = (p, host = 'llmfingerprint.z0y0h.work') => new URL(`https://${host}${p}`);

test('proxy rewrites /p/<host>/<path> onto https', () => {
  assert.equal(resolveTarget(inbound('/p/api.relay.com/v1/responses')).href,
    'https://api.relay.com/v1/responses');
  assert.equal(resolveTarget(inbound('/p/api.relay.com:8443/v1/chat/completions')).href,
    'https://api.relay.com:8443/v1/chat/completions');
  // L0a's status probe hangs off the origin, not the versioned base.
  assert.equal(resolveTarget(inbound('/p/api.relay.com/api/status')).href,
    'https://api.relay.com/api/status');
});

test('proxy refuses anything that is not a public https host', () => {
  for (const target of ['/p/localhost/v1/models', '/p/127.0.0.1/v1/models',
                        '/p/foo.internal/v1/models', '/p/box.local/v1/models',
                        '/p/singlelabel/v1/models', '/p/[::1]/v1/models']) {
    assert.throws(() => resolveTarget(inbound(target)), ProxyError, `should refuse ${target}`);
  }
});

test('proxy forwards only the probe paths', () => {
  for (const suffix of ALLOWED_SUFFIXES) {
    assert.ok(resolveTarget(inbound(`/p/api.relay.com/v1${suffix}`)));
  }
  for (const bad of ['/v1/secret', '/admin', '/v1/models/../../etc', '/v1/responses/stream']) {
    assert.throws(() => resolveTarget(inbound(`/p/api.relay.com${bad}`)), ProxyError, `should refuse ${bad}`);
  }
});

test('proxy will not be pointed at itself', () => {
  assert.throws(() => resolveTarget(inbound('/p/llmfingerprint.z0y0h.work/v1/models'),
    'llmfingerprint.z0y0h.work'), ProxyError);
});

test('the local escape hatch is keyed on the INBOUND host, never a flag', () => {
  assert.equal(isLocalDeployment('localhost'), true);
  assert.equal(isLocalDeployment('127.0.0.1'), true);
  assert.equal(isLocalDeployment('llmfingerprint.z0y0h.work'), false);
  // Served from localhost: the stub relay is reachable, over http.
  assert.equal(resolveTarget(new URL('http://localhost:5177/p/localhost:8791/v1/responses')).href,
    'http://localhost:8791/v1/responses');
  // Served from production: the same target is refused. This is the whole safety argument
  // for having a dev escape hatch at all.
  assert.throws(() => resolveTarget(inbound('/p/localhost:8791/v1/responses')), ProxyError);
});

test('assertHostAllowed rejects a malformed port rather than passing it through', () => {
  assert.throws(() => assertHostAllowed('relay.com:notaport'), ProxyError);
  assert.equal(assertHostAllowed('relay.com:8443'), 'relay.com:8443');
});

/* ── endpoint normalisation ───────────────────────────────────────────────── */

test('a typed base URL becomes proxy paths the probe layer can append to', () => {
  const n = normaliseBaseUrl('https://api.relay.com/v1/');
  assert.equal(n.url, 'https://api.relay.com/v1');
  const { baseUrl, origin } = proxyPaths(n.url);
  assert.equal(baseUrl, '/p/api.relay.com/v1');
  assert.equal(origin, '/p/api.relay.com');
  // What the outbound clients actually build:
  assert.equal(`${baseUrl}/responses`, '/p/api.relay.com/v1/responses');
  assert.equal(`${origin}/api/status`, '/p/api.relay.com/api/status');
});

test('the guessed /v1 is reported, not applied silently', () => {
  const n = normaliseBaseUrl('api.relay.com');
  assert.equal(n.url, 'https://api.relay.com/v1');
  assert.equal(n.addedPath, true, 'the UI has to be able to show what it filled in');
  assert.equal(n.addedScheme, true);
  assert.equal(normaliseBaseUrl('https://api.relay.com/openai/v1').addedPath, false);
});

test('http and non-public hosts are refused', () => {
  assert.throws(() => normaliseBaseUrl('http://api.relay.com/v1'), EndpointError);
  assert.throws(() => normaliseBaseUrl(''), EndpointError);
});

/* ── the slim reference must be the same measurement ──────────────────────── */

test('rehydrate reproduces exactly the answer pools noiseFloor draws from', () => {
  for (const [protocol, list] of Object.entries(bundle)) {
    for (const lean of list) {
      const pools = validAnswersByCell(rehydrate(lean).samples);
      assert.deepEqual(pools, lean.answers,
        `${protocol}/${lean.model}: rehydrate must round-trip, ORDER INCLUDED — ` +
        'drawWithReplacement indexes into these arrays and a reordered pool moves the noise floor');
    }
  }
});

test('every shipped reference declares the protocol of its own directory', () => {
  for (const [protocol, list] of Object.entries(bundle)) {
    for (const lean of list) {
      assert.equal(lean.fingerprint_protocol, protocol, `${lean.model} is filed under the wrong wire`);
      assert.ok(Object.keys(lean.fingerprint).length > 0, `${lean.model} has no cells`);
    }
  }
});

test('references carry no endpoint URL or key', () => {
  const serialised = JSON.stringify(bundle);
  assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}/.test(serialised), 'a key-shaped string is in the shipped bundle');
  assert.ok(!/https?:\/\//.test(serialised), 'an endpoint URL is in the shipped bundle');
});

/* ── display logic ────────────────────────────────────────────────────────── */

test('modeOf picks the most likely answer, not the first', () => {
  assert.deepEqual(modeOf({ 47: 0.2, 57: 0.8 }), { answer: '57', p: 0.8 });
  assert.deepEqual(modeOf({}), { answer: null, p: 0 });
  assert.deepEqual(modeOf(undefined), { answer: null, p: 0 });
});

test('displayCells mixes discriminating cells with ones that never move', () => {
  const refs = bundle.responses;
  const cells = displayCells(refs, { total: 16, stable: 4 });
  assert.equal(cells.length, 16);
  assert.equal(new Set(cells).size, 16, 'no cell may appear twice');

  const answersFor = (cell) => new Set(refs.map((r) => modeOf(r.fingerprint[cell]).answer));
  const moving = cells.filter((c) => answersFor(c).size > 1).length;
  assert.ok(moving >= 8, `expected most cells to discriminate, got ${moving}`);
  assert.ok(moving < 16, 'the point of the tail is that some cells never move');
});

test('heatmap bands put "indistinguishable" at the alarming end', () => {
  assert.equal(band(0.5), 0);
  assert.equal(band(1), 0, '1× exactly is still inside the noise floor');
  assert.equal(band(1.01), 1);
  assert.equal(band(4.6), 2);      // the closest real pair: gpt-5.3-codex ↔ gpt-5.4
  assert.equal(band(100), 5);
  assert.equal(band(NaN), -1);
});

test('the bands actually spread the real data instead of piling into one step', () => {
  // A ramp whose steps are never used is a ramp that teaches nothing — the first cut had
  // three of six empty and drew the whole map in a single colour.
  const m = JSON.parse(readFileSync(path.join(ROOT, 'ui/public/data/model-matrix.json'), 'utf8')).responses;
  const used = new Set();
  for (let i = 0; i < m.models.length; i += 1) {
    for (let j = 0; j < m.models.length; j += 1) {
      if (i === j) continue;
      used.add(band(m.matrix[i][j] / Math.max(m.floors[i], m.floors[j])));
    }
  }
  assert.ok(used.size >= 3, `only ${used.size} band(s) in use across 45 pairs: ${[...used]}`);
  assert.ok(!used.has(0), 'a pair inside the noise floor would mean the method cannot separate two official models');
});
