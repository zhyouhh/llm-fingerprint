import test from 'node:test';
import assert from 'node:assert/strict';

import { profileL0a, profileL0b, ACCEPTANCE_KEYS, EFFORT_LEVELS, inferEndpointKind } from '../src/layers/l0-profile.js';
import { createGetProbe } from '../src/probe/http/get.js';
import { createResponsesClient } from '../src/probe/http/responses.js';
import { mergeCollections } from '../src/layers/result-file.js';
import { assertCollection, SAMPLE_KIND } from '../src/contracts.js';
import { startStub, responsesOk } from './helpers/stub-server.js';

const FAST = { attempts: 3, baseDelayMs: 1 };

test('I-16: L0a issues zero POSTs, and its reachability signal is display-only', async () => {
  const stub = await startStub([{ json: { ok: true } }, { json: { data: [{ id: 'm' }] } }]);
  try {
    const get = createGetProbe({ retry: FAST });
    const out = await profileL0a({ get, baseUrl: stub.baseUrl, origin: stub.origin, apiKey: 'k' });

    assert.equal(stub.received.filter((r) => r.method === 'POST').length, 0, 'not a single completion');
    assert.equal(out.meta.probes, 2);
    assert.equal(out.result.models_endpoint_reachable, true);
    assert.equal(out.result.model_count, 1);
    assert.ok(out.samples.every((s) => s.kind === SAMPLE_KIND.REACHABILITY), 'never fingerprint states');
    // 🔴 There is deliberately no chat_available field and no gate: /models answering
    // says nothing about /chat/completions, in either direction.
    assert.ok(!('chat_available' in out.result));
    assert.doesNotThrow(() => assertCollection(out));
  } finally { await stub.close(); }
});

test('I-16: 404 / 405 / dead socket all read as unreachable, not as failure', async () => {
  for (const [label, script, expected] of [
    ['404', [{ status: 404, json: {} }, { status: 404, json: {} }], false],
    ['405', [{ status: 405, json: {} }, { status: 405, json: {} }], false],
    ['200', [{ json: {} }, { json: { data: [] } }], true],
  ]) {
    const stub = await startStub(script);
    try {
      const get = createGetProbe({ retry: FAST });
      const out = await profileL0a({ get, baseUrl: stub.baseUrl, origin: stub.origin, apiKey: 'k' });
      assert.equal(out.result.models_endpoint_reachable, expected, label);
      // A non-2xx from /models is a profiling finding — the endpoint does not implement
      // it — rather than a transport failure.
      const modelsSample = out.samples[1];
      assert.equal(modelsSample.state, expected ? 'reachable' : 'http_error', label);
    } finally { await stub.close(); }
  }
});

test('L0b probes all 14 parameters and 8 juice reads = 24 logical probes', async () => {
  const stub = await startStub([{ json: responsesOk('128') }]);
  try {
    const client = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST });
    const out = await profileL0b({ client, model: 'm', protocol: 'responses' });

    assert.equal(out.meta.probes, 24, '14 acceptance + 8 juice + 2 injection');
    assert.deepEqual(Object.keys(out.result.acceptance).sort(), [...ACCEPTANCE_KEYS].sort());
    assert.equal(Object.keys(out.result.juice_by_effort).length, EFFORT_LEVELS.length);
    assert.equal(out.result.juice_by_effort.high, 128);
    assert.ok(out.samples.every((s) => s.kind === SAMPLE_KIND.CAPABILITY));
  } finally { await stub.close(); }
});

test('I-11: temperature is never sent except as its own probe', async () => {
  const stub = await startStub([{ json: responsesOk() }]);
  try {
    const client = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST });
    await profileL0b({ client, model: 'm', protocol: 'responses' });

    const withTemp = stub.received.filter((r) => r.json && 'temperature' in r.json);
    // Reasoning models frequently 400 on temperature. Sending it by default would turn
    // every other row in the matrix into a false "unsupported".
    assert.equal(withTemp.length, 1, 'exactly one request carries temperature — the temperature probe');
  } finally { await stub.close(); }
});

test('待消解 #3: a chat-only endpoint reports "not_probed", never false or unsupported', async () => {
  const stub = await startStub([{ json: responsesOk() }]);
  try {
    const client = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST });
    const out = await profileL0b({ client, model: 'm', protocol: 'chat' });

    assert.equal(out.meta.probes, 2, 'only the two injection probes');
    assert.equal(stub.count, 2);
    for (const key of ACCEPTANCE_KEYS) {
      if (key.startsWith('effort:') || key.startsWith('mode:')) {
        assert.equal(out.result.acceptance[key], 'not_probed', key);
        assert.notEqual(out.result.acceptance[key], false, `${key}: we never asked, so false would be a lie`);
      }
    }
    assert.equal(out.result.juice_by_effort, null);
    assert.equal(out.result.effort_probe_unavailable, true);
    assert.deepEqual(Object.keys(out.result.acceptance).sort(), [...ACCEPTANCE_KEYS].sort(),
      'the map stays complete even when most of it was not probed');
  } finally { await stub.close(); }
});

test('a failing sub-probe does not take the rest of the profile down', async () => {
  let n = 0;
  const stub = await startStub([() => (++n % 3 === 0 ? { status: 500, json: {} } : { json: responsesOk('7') })]);
  try {
    const client = createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: { attempts: 3, baseDelayMs: 1 } });
    const out = await profileL0b({ client, model: 'm', protocol: 'responses' });
    assert.equal(out.meta.probes, 24, 'every probe still produced a sample');
    assert.ok(out.meta.http_attempts > 24, 'and the failures were retried');
  } finally { await stub.close(); }
});

test('L0b refuses to run without a model', async () => {
  // 24 probes each needing a model in the body: without one they would fail 24 times
  // identically and read as "this endpoint rejects everything".
  await assert.rejects(() => profileL0b({ client: async () => ({}), model: undefined }), /requires a model/);
});

test('待消解 #8: the two halves merge into one file with summed counts', async () => {
  const stub = await startStub([{ json: { ok: 1 } }, { json: { data: [] } }, { json: responsesOk('9') }]);
  try {
    const a = await profileL0a({ get: createGetProbe({ retry: FAST }), baseUrl: stub.baseUrl, origin: stub.origin });
    const b = await profileL0b({
      client: createResponsesClient({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST }),
      model: 'm', protocol: 'responses',
    });
    const merged = mergeCollections([a, b], { resultKeys: ['l0a', 'l0b'] });

    // The budget check ("41 probes for a screen") only adds up if the file carries the
    // SUM; letting each half write its own meta is how it ends up reading 2 or 24.
    assert.equal(merged.meta.probes, a.meta.probes + b.meta.probes);
    assert.equal(merged.meta.probes, 26);
    assert.equal(merged.meta.http_attempts, a.meta.http_attempts + b.meta.http_attempts);
    assert.deepEqual(Object.keys(merged.result), ['l0a', 'l0b']);
    assert.doesNotThrow(() => assertCollection(merged));

    const half = mergeCollections([a, null], { resultKeys: ['l0a', 'l0b'] });
    assert.equal(half.result.l0b, null, '--only l0a still produces a well-formed file');
    assert.equal(half.meta.probes, 2);
  } finally { await stub.close(); }
});

test('endpoint kind comes off the headers', () => {
  assert.equal(inferEndpointKind({ headers: { 'x-oneapi-request-id': '1' } }), 'oneapi-newapi');
  assert.equal(inferEndpointKind({ headers: { 'X-CPA-TRACE-ID': 'x' } }), 'cliproxyapi');
  assert.equal(inferEndpointKind({ headers: {}, statusOk: true }), 'oneapi-like');
  assert.equal(inferEndpointKind({ headers: {}, modelsOk: true }), 'openai-compatible');
  assert.equal(inferEndpointKind({ headers: {} }), 'unknown');
});
