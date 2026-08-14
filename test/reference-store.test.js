// The fingerprint layer has two wires, and a reference is only meaningful on its own.
//
// These tests exist because the first version of that guard was fake: assertSameProtocol
// read a file-level stamp that refresh-reference had just written over cells collected on
// the other wire, and screen.js called it with the same object as both arguments — a
// comparison no pair of files can fail. Every assertion below is one of the ways that
// mismatch could still reach a distance calculation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  referencePath, loadReference, referenceExists, availableProtocols, resolveProtocol,
  DEFAULT_PROTOCOL, PROTOCOL_IDS,
} from '../src/lib/reference-store.js';
import { UsageError } from '../src/lib/errors.js';
import { screenL1 } from '../src/layers/l1-screen.js';
import { calibrateL2 } from '../src/layers/l2-calibrate.js';
import { genuineScreenScores } from '../src/layers/genuine-history.js';

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'llmfp-ref-'));
  for (const p of PROTOCOL_IDS) mkdirSync(path.join(root, p), { recursive: true });
  return root;
}
function put(root, protocol, model, body) {
  writeFileSync(referencePath(model, protocol, { root }), JSON.stringify(body));
}
const ref = (protocol) => ({ model: 'm', fingerprint_protocol: protocol, fingerprint: {}, samples: [] });

test('a reference is addressed by model AND protocol, so the two wires cannot share a file', () => {
  const root = makeRoot();
  try {
    const a = referencePath('gpt-5.6-sol', 'chat', { root });
    const b = referencePath('gpt-5.6-sol', 'responses', { root });
    assert.notEqual(a, b);
    assert.equal(path.basename(a), path.basename(b));
    assert.equal(path.basename(path.dirname(a)), 'chat');
    assert.equal(path.basename(path.dirname(b)), 'responses');

    // 🔴 The regression this whole change is about: a partial refresh on one wire must
    // have nothing to inherit from the other. Before the split both of these resolved to
    // the same file, so refreshing three of eight cells over `responses` kept five chat
    // cells and stamped the merged file "responses".
    put(root, 'chat', 'gpt-5.6-sol', ref('chat'));
    assert.equal(referenceExists('gpt-5.6-sol', 'chat', { root }), true);
    assert.equal(referenceExists('gpt-5.6-sol', 'responses', { root }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('referencePath rejects a protocol that has no probe behind it', () => {
  assert.throws(() => referencePath('m', 'grpc'), UsageError);
  assert.throws(() => referencePath('m', undefined), UsageError);
});

test('a file whose declared protocol disagrees with its directory is refused', () => {
  const root = makeRoot();
  try {
    // The one way the path split can still be defeated: move a file by hand.
    put(root, 'chat', 'm', ref('responses'));
    assert.throws(() => loadReference('m', 'chat', { root }), (err) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /declares fingerprint_protocol "responses"/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('references predating the split carry no field and load as chat', () => {
  const root = makeRoot();
  try {
    put(root, 'chat', 'm', { model: 'm', fingerprint: {} });   // no fingerprint_protocol
    assert.equal(DEFAULT_PROTOCOL, 'chat');
    assert.equal(loadReference('m', 'chat', { root }).model, 'm');
    // ...and the same file is NOT usable as a responses reference just by being asked for.
    assert.throws(() => loadReference('m', 'responses', { root }), UsageError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveProtocol picks the only complete set, and refuses to guess between two', () => {
  const root = makeRoot();
  const models = ['s', 'c'];
  try {
    // Nothing collected yet.
    assert.throws(() => resolveProtocol({ models, root }), UsageError);

    // One wire complete → no reason to make the caller name the only option.
    put(root, 'chat', 's', ref('chat'));
    put(root, 'chat', 'c', ref('chat'));
    assert.deepEqual(availableProtocols(models, { root }), ['chat']);
    assert.equal(resolveProtocol({ models, root }), 'chat');

    // A HALF-complete second wire must not count — selecting cells needs both models.
    put(root, 'responses', 's', ref('responses'));
    assert.deepEqual(availableProtocols(models, { root }), ['chat']);
    assert.equal(resolveProtocol({ models, root }), 'chat');
    assert.throws(() => resolveProtocol({ models, requested: 'responses', root }), (err) => {
      assert.match(err.message, /no responses reference for c\b/);
      return true;
    });

    // Both complete → guessing would be guessing what the comparison means.
    put(root, 'responses', 'c', ref('responses'));
    assert.throws(() => resolveProtocol({ models, root }), (err) => {
      assert.match(err.message, /--fp-protocol/);
      return true;
    });
    assert.equal(resolveProtocol({ models, requested: 'responses', root }), 'responses');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a collection refuses to run without being told which wire it is on', async () => {
  // Same reasoning as applyReasoningTrace: a default here does not error, it just makes
  // the stored file claim a comparability it never had.
  await assert.rejects(() => screenL1({ probe: null, model: 'm', refSubject: {}, refControl: {} }),
    /fpProtocol must be passed explicitly/);
  await assert.rejects(() => calibrateL2({ probe: null, subject: 's', control: 'c', refSubject: {}, refControl: {} }),
    /fpProtocol must be passed explicitly/);
});

test('live genuine scores are never pooled across wires', () => {
  const runs = mkdtempSync(path.join(tmpdir(), 'llmfp-runs-'));
  const write = (name, meta, s) => writeFileSync(path.join(runs, name),
    JSON.stringify({ meta: { model: 'm', reference_version: 'v1', ...meta }, result: { s_screen: s } }));
  try {
    write('g__l1__a.json', { fingerprint_protocol: 'chat' }, 0.01);
    write('g__l1__b.json', { fingerprint_protocol: 'responses' }, 0.99);
    write('g__l1__c.json', {}, 0.02);   // predates the field → chat by construction

    const q = (fingerprintProtocol) => genuineScreenScores({
      endpointId: 'g', model: 'm', referenceVersion: 'v1', fingerprintProtocol, runsDir: runs,
    }).sort((x, y) => x - y);

    // 🔴 0.99 must not widen the chat threshold: it is not a sample of that distribution.
    assert.deepEqual(q('chat'), [0.01, 0.02]);
    assert.deepEqual(q('responses'), [0.99]);
    assert.deepEqual(q(null), [0.01, 0.02, 0.99]);   // unfiltered, for callers that mean it
  } finally { rmSync(runs, { recursive: true, force: true }); }
});
