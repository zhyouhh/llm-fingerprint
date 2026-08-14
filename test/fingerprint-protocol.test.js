import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FINGERPRINT_PROTOCOLS, fingerprintProbeFactory, assertSameProtocol,
} from '../src/probe/http/fingerprint-probe.js';
import { startStub, chatOk, responsesOk } from './helpers/stub-server.js';

const FAST = { attempts: 3, baseDelayMs: 1 };

test('a protocol mismatch is refused, loudly', () => {
  // Same failure class as the normalisation mismatch: no error, no symptom, just a
  // distance that means nothing. Measured on the self-hosted gateway, num100-random|en
  // is 47 at probability 1 over chat and 47/57/57 over Responses at effort:none.
  assert.throws(() => assertSameProtocol('chat', 'responses'), /protocol mismatch/);
  assert.throws(() => assertSameProtocol('responses', 'chat'), /protocol mismatch/);
  assert.equal(assertSameProtocol('responses', 'responses'), 'responses');
  // References written before the field existed were all collected over chat.
  assert.equal(assertSameProtocol(undefined, 'chat'), 'chat');
  assert.throws(() => assertSameProtocol(undefined, 'responses'), /protocol mismatch/);
});

test('the Responses fingerprint body is frozen, like I-1 freezes the chat one', async () => {
  const stub = await startStub([{ json: responsesOk('47') }]);
  try {
    const probe = fingerprintProbeFactory('responses')({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST });
    const r = await probe({ model: 'm', system: 'SYS', user: 'USR' });

    const sent = stub.received[0].json;
    assert.equal(stub.received[0].path, '/v1/responses');
    assert.equal(sent.model, 'm');
    assert.equal(sent.instructions, 'SYS', 'the system prompt rides on instructions here');
    assert.equal(sent.input, 'USR');
    assert.equal(sent.max_output_tokens, 16);
    assert.deepEqual(sent.reasoning, { effort: 'none' },
      'effort:none is what keeps a reasoning model from eating the whole budget — the ' +
      'official API has no reasoning:{enabled:false}');
    assert.equal(sent.store, false, 'probe questions must not be retained on the far side');
    assert.equal(r.raw, '47');
  } finally { await stub.close(); }
});

test('the chat probe still sends the paper body', async () => {
  const stub = await startStub([{ json: chatOk('47') }]);
  try {
    const probe = fingerprintProbeFactory('chat')({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST });
    await probe({ model: 'm', system: 'SYS', user: 'USR' });
    const sent = stub.received[0].json;
    assert.equal(stub.received[0].path, '/v1/chat/completions');
    assert.deepEqual(sent.reasoning, { enabled: false });
    assert.equal(sent.max_tokens, 16);
  } finally { await stub.close(); }
});

test('both protocols are declared with what they actually send', () => {
  assert.deepEqual(Object.keys(FINGERPRINT_PROTOCOLS), ['chat', 'responses']);
  assert.deepEqual(FINGERPRINT_PROTOCOLS.chat.params.reasoning, { enabled: false });
  assert.deepEqual(FINGERPRINT_PROTOCOLS.responses.params.reasoning, { effort: 'none' });
  assert.throws(() => fingerprintProbeFactory('grpc'), /unknown fingerprint protocol/);
});
