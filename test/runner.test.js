// Sampling-engine acceptance. Six cases, and the last four exist because deleting
// runner's retry loop without rewriting its failure branch would have booked transport
// failures as completions — silently, with no error anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runBattery, normaliseCells } from '../src/probe/runner.js';
import { createChatProbe } from '../src/probe/http/chat.js';
import { rates, L1_LOGICAL_SAMPLES } from '../src/contracts.js';
import { startStub, chatOk } from './helpers/stub-server.js';

const FAST_RETRY = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 };
const THREE_CELLS = [
  { task_id: 'num100-random', lang: 'en', reps: 2 },
  { task_id: 'num100-random', lang: 'zh', reps: 3 },
  { task_id: 'color-random', lang: 'en', reps: 4 },
];

async function run(script, { cells = THREE_CELLS } = {}) {
  const stub = await startStub(script);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    const out = await runBattery({ applyReasoningTrace: false, probe, model: 'stub-model', cells, concurrency: 2 });
    return { ...out, stub };
  } finally { await stub.close(); }
}

test('① per-cell reps: three cells at 2/3/4 produce nine samples in that distribution', async () => {
  const { samples, counters } = await run([{ json: chatOk('7') }]);

  assert.equal(samples.length, 9);
  assert.equal(counters.probes, 9);
  const perCell = {};
  for (const s of samples) perCell[`${s.task_id}|${s.lang}`] = (perCell[`${s.task_id}|${s.lang}`] ?? 0) + 1;
  assert.deepEqual(perCell, { 'num100-random|en': 2, 'num100-random|zh': 3, 'color-random|en': 4 });

  // rep indices must be distinct within a cell, or two samples share a key and the
  // dedupe in the normaliser silently drops one.
  const keys = new Set(samples.map((s) => s.key));
  assert.equal(keys.size, 9, 'every sample needs its own key');
});

test('② an endpoint returning empty completions is not an error, and scores zero', async () => {
  // This is the reasoning-pollution shape: HTTP is fine, the model spent its 16 tokens
  // on hidden reasoning. It must not look like a broken endpoint, and must not score.
  const { samples } = await run([{ json: chatOk('') }]);

  assert.equal(samples.length, 9);
  assert.ok(samples.every((s) => s.state === 'empty_completion'), 'all nine, no exceptions');
  const r = rates(samples, { logicalSamples: 9 });
  assert.equal(r.valid_rate, 0);
  assert.equal(r.response_rate, 1, 'the endpoint DID answer — that is what separates this from a 400');
});

test('③ a permanent 4xx yields transport failures and both rates go to zero', async () => {
  const { samples, counters } = await run([{ status: 400, json: { error: { code: 'bad_request' } } }]);

  assert.ok(samples.every((s) => s.state === 'transport_failure'));
  assert.ok(samples.every((s) => s.raw === ''), 'the error body must never masquerade as a completion');
  const r = rates(samples, { logicalSamples: 9 });
  assert.equal(r.valid_rate, 0);
  assert.equal(r.response_rate, 0);
  assert.equal(counters.http_attempts, 9, 'a permanent 4xx is not retried');
});

test('④ a retried sample reports its attempts, and the two counts diverge', async () => {
  const stub = await startStub([
    { status: 429, json: {} }, { status: 429, json: {} }, { json: chatOk('7') },
    { json: chatOk('7') },
  ]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    const { samples, counters } = await runBattery({ applyReasoningTrace: false,
      probe, model: 'stub-model', concurrency: 1,
      cells: [{ task_id: 'num100-random', lang: 'en', reps: 2 }],
    });

    assert.equal(samples[0].attempts, 3, 'two 429s then success');
    assert.equal(samples[0].state, 'valid');
    assert.equal(counters.probes, 2);
    assert.equal(counters.http_attempts, 4);
    assert.notEqual(counters.probes, counters.http_attempts,
      'merging these into one number would be wrong for one of them');
  } finally { await stub.close(); }
});

test('⑤ a network failure with no status code still counts as a transport failure', async () => {
  // The subtle one: `if (r.error.status)` is truthy for a 400 and falsy here, so an
  // implementation that keys off status alone passes case ③ and lets this one through
  // as a successful empty completion.
  const probe = createChatProbe({
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 }, timeoutMs: 2000,
  });
  const { samples, counters } = await runBattery({ applyReasoningTrace: false,
    probe, model: 'stub-model', concurrency: 2,
    cells: [{ task_id: 'num100-random', lang: 'en', reps: 2 }],
  });

  assert.ok(samples.every((s) => s.state === 'transport_failure'));
  assert.ok(samples.every((s) => s.error.status === null && s.error.code === 'network_error'));
  const r = rates(samples, { logicalSamples: 2 });
  assert.equal(r.valid_rate, 0);
  assert.equal(r.response_rate, 0);
  assert.equal(counters.http_attempts, 6, 'three attempts each, none of which reached a server');
});

test('⑥ an answered-but-unusable completion counts as a response, not as valid', async () => {
  // A refusal is non-empty text. Counting it as valid inflates valid_rate, and
  // valid_rate is the only gate standing between a polluted endpoint and a green light.
  const { samples } = await run([{ json: chatOk('I am sorry, but I cannot help with that.') }]);

  assert.ok(samples.every((s) => s.state === 'invalid_completion'), samples[0]?.state);
  const r = rates(samples, { logicalSamples: 9 });
  assert.equal(r.valid_rate, 0, 'not usable → not valid');
  assert.equal(r.response_rate, 1, 'but the endpoint did answer');
});

test('the engine itself never retries — that belongs to the client', async () => {
  // Two layers of three attempts is nine requests per probe. The stub counts the wire.
  const stub = await startStub([{ status: 429, json: {} }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 } });
    const { counters } = await runBattery({ applyReasoningTrace: false,
      probe, model: 'stub-model', concurrency: 1,
      cells: [{ task_id: 'num100-random', lang: 'en', reps: 1 }],
    });
    assert.equal(stub.count, 3, 'exactly the client\'s three, not nine');
    assert.equal(counters.http_attempts, 3);
  } finally { await stub.close(); }
});

test('cell normalisation accepts both shapes and rejects nonsense', () => {
  assert.deepEqual(normaliseCells([['a', 'en']], 5), [{ task_id: 'a', lang: 'en', reps: 5 }]);
  assert.deepEqual(normaliseCells([{ task_id: 'a', lang: 'en', reps: 2 }], 5),
    [{ task_id: 'a', lang: 'en', reps: 2 }]);
  assert.throws(() => normaliseCells([{ task_id: 'a' }], 5), /bad cell/);
  assert.throws(() => normaliseCells([{ task_id: 'a', lang: 'en', reps: 0 }], 5), /bad reps/);
});

test('L1 budget: three cells at five reps is fifteen logical samples', async () => {
  const { samples, counters } = await run([{ json: chatOk('7') }], {
    cells: [
      { task_id: 'num100-random', lang: 'zh', reps: 5 },
      { task_id: 'color-random', lang: 'en', reps: 5 },
      { task_id: 'num100-random', lang: 'en', reps: 5 },
    ],
  });
  assert.equal(samples.length, L1_LOGICAL_SAMPLES);
  assert.equal(counters.probes, L1_LOGICAL_SAMPLES);
});

test('the normalisation pass must be chosen explicitly, never defaulted', async () => {
  // 🔴 The bug this prevents cost a whole live screening round. reference/ was collected
  // WITHOUT the reasoning-trace pass; applying it against that reference marked two
  // thirds of a healthy run as post_reasoning and reported the project's own genuine
  // endpoint as inconclusive. Nothing errored — the comparison was simply void.
  const stub = await startStub([{ json: chatOk('7') }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    await assert.rejects(
      () => runBattery({ probe, model: 'm', cells: [{ task_id: 'num100-random', lang: 'en', reps: 1 }] }),
      /applyReasoningTrace must be passed explicitly/,
    );
  } finally { await stub.close(); }
});

test('reasoning_len alone triggers post_reasoning — the n>=20 threshold does not gate it', async () => {
  // The threshold in detectReasoningPairs only governs INFERRING the flag for records
  // that lack the field. Any record carrying reasoning_len > 0 is flagged outright, so a
  // 15-sample L1 run trips it immediately — the opposite of what the plan once claimed.
  const withTrace = {
    model: 'stub-model', choices: [{ message: { content: '7' }, finish_reason: 'stop' }],
    usage: { completion_tokens_details: { reasoning_tokens: 11 } },
  };
  const stub = await startStub([{ json: withTrace }]);
  try {
    const probe = createChatProbe({ baseUrl: stub.baseUrl, apiKey: 'k', retry: FAST_RETRY });
    const cells = [{ task_id: 'num100-random', lang: 'en', reps: 3 }];

    const applied = await runBattery({ probe, model: 'stub-model', cells, applyReasoningTrace: true });
    assert.ok(applied.samples.every((s) => s.state === 'post_reasoning'),
      'three samples are far below n>=20, yet every one is flagged');

    const notApplied = await runBattery({ probe, model: 'stub-model', cells, applyReasoningTrace: false });
    assert.ok(notApplied.samples.every((s) => s.state === 'valid'),
      'and with the pass off, the very same answers are perfectly usable');
  } finally { await stub.close(); }
});
