// Rate limiting is a MEASUREMENT-INTEGRITY problem, not a reliability one.
//
// 🔴 What it actually did, on two real runs: 102 and 137 of one side's 420 probes died on
// HTTP 429 and ZERO on the other, because the subject battery runs first and burns the
// per-minute quota. Whole cells then fell under the sample bar and were dropped — and not
// at random. The twelve cells rate limiting killed averaged S = 0.140 while the sixteen
// that survived averaged 0.211. A 17% shift in the number the verdict is computed from,
// decided by which minute the quota ran out in.
//
// The old policy could not have helped: three attempts at 1.5s then 3s spends the whole
// budget inside 4.5 seconds against a limit measured in MINUTES.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  request, rateLimitKey, retryAfterMs, resetRateLimits,
  RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_BUDGET_MS,
} from '../src/probe/http/transport.js';
import { createResponsesClient } from '../src/probe/http/responses.js';
import { createChatProbe } from '../src/probe/http/chat.js';

test('Retry-After is honoured in both forms the RFC allows', () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  assert.equal(retryAfterMs({ 'retry-after': '30' }, now), 30_000);
  assert.equal(retryAfterMs({ 'Retry-After': '30' }, now), 30_000, 'header names are case-insensitive in the wild');
  assert.equal(retryAfterMs({ 'retry-after': '0' }, now), 0);
  assert.equal(retryAfterMs({ 'retry-after': new Date(now + 45_000).toUTCString() }, now), 45_000);
  // Unparseable must fall back to our own schedule rather than to zero, which would be
  // "retry immediately" — the opposite of what the header asked for.
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }, now), null);
  assert.equal(retryAfterMs({}, now), null);
  assert.equal(retryAfterMs(undefined, now), null);
});

test('the pause is keyed per TARGET, including through the browser proxy', () => {
  // 🔴 In the browser every request goes to our own worker with the real host in the PATH.
  // Keyed on origin, one rate-limited relay would park probes aimed at a different relay.
  assert.equal(rateLimitKey('https://a.relay.com/v1/responses'), 'https://a.relay.com');
  assert.equal(rateLimitKey('https://a.relay.com:8443/v1/responses'), 'https://a.relay.com:8443');
  assert.notEqual(rateLimitKey('/p/a.relay.com/v1/responses'), rateLimitKey('/p/b.relay.com/v1/responses'));
  assert.equal(rateLimitKey('/p/a.relay.com/v1/responses'), 'proxy:a.relay.com');
});

/** A fetch stand-in: `plan` is consumed one entry per call. */
function scriptedFetch(plan) {
  const calls = [];
  const fn = async (url) => {
    calls.push({ url: String(url), at: Date.now() });
    const step = plan.shift() ?? { status: 200 };
    return {
      ok: step.status < 400,
      status: step.status,
      headers: new Map(Object.entries(step.headers ?? {})),
      text: async () => JSON.stringify(step.status === 429
        ? { error: { message: 'rate limited', code: 'rate_limit_exceeded' } }
        : { ok: true }),
    };
  };
  fn.calls = calls;
  return fn;
}

test('a 429 parks every caller for this target, not just the one that hit it', async () => {
  // 🔴 CONCURRENT and with a real, non-zero wait. The first version ran two calls in
  // sequence with `Retry-After: 0`, which passes whether or not the deadline is shared —
  // there was nothing for a second caller to be parked BY. Here one caller takes the 429
  // and five siblings, who never saw it, must all be held behind its deadline.
  resetRateLimits();
  const original = globalThis.fetch;
  const gotLimited = [];
  let firstServed = 0;
  globalThis.fetch = async (url) => {
    gotLimited.push(Date.now());
    // Only the very first request is refused; every later one succeeds. If the pause were
    // per-caller the five siblings would sail straight through with no wait at all.
    const limited = firstServed++ === 0;
    return {
      ok: !limited,
      status: limited ? 429 : 200,
      headers: new Map(limited ? [['retry-after', '0.25']] : []),
      text: async () => JSON.stringify({ ok: !limited }),
    };
  };
  try {
    const started = Date.now();
    const one = request('https://relay.example/v1/responses', {}, { timeoutMs: 2000 });
    // Let the 429 land and register before the siblings start, which is the real sequence:
    // one worker discovers the wall, the rest are already in flight behind it.
    await new Promise((r) => setTimeout(r, 20));
    const rest = Array.from({ length: 5 }, () =>
      request('https://relay.example/v1/responses', {}, { timeoutMs: 2000 }));
    const all = await Promise.all([one, ...rest]);

    assert.ok(all.every((r) => r.ok), 'everyone got through once the shared pause expired');
    assert.equal(all[0].attempts, 2, 'the caller that hit the wall retried');
    // The five siblings never saw a 429 themselves, so nothing but a SHARED deadline could
    // have delayed them — and delayed they must be, or the quota is hit six more times.
    for (const r of all.slice(1)) {
      assert.equal(r.attempts, 1, 'a sibling never had to retry — it waited instead');
      assert.ok(r.rate_limited_ms >= 200,
        `a sibling must be held by the shared deadline, waited ${r.rate_limited_ms}ms`);
      // 🔴 The endpoint's own latency must not include our penalty box, or L0's latency
      // percentiles would report the quota rather than the server.
      assert.ok(r.latency_ms < 200, `latency must exclude the pause, got ${r.latency_ms}ms`);
    }
    assert.ok(Date.now() - started >= 250);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a 429 does not also pay the ordinary backoff — the shared pause replaces it', async () => {
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 200 },
  ]);
  try {
    const started = Date.now();
    const r = await request('https://relay.example/v1/responses', {}, {
      // A backoff long enough that paying it twice would be unmistakable.
      retry: { attempts: 3, baseDelayMs: 3000 }, timeoutMs: 500,
    });
    assert.equal(r.ok, true);
    assert.ok(Date.now() - started < 2000,
      'stacking the shared pause on top of the per-request backoff is a wait nobody chose');
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a non-429 retryable failure still pays its own backoff', async () => {
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([{ status: 503 }, { status: 200 }]);
  try {
    const started = Date.now();
    const r = await request('https://relay.example/v1/responses', {}, {
      retry: { attempts: 3, baseDelayMs: 150 }, timeoutMs: 500,
    });
    assert.equal(r.ok, true);
    assert.ok(Date.now() - started >= 140, 'the 5xx path must not have lost its backoff');
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('the waiting budget is wall clock, not the sum over concurrent callers', async () => {
  // 🔴 The bug this pins, measured against a stub enforcing 40 requests/minute: summing
  // each caller's wait burned a five-minute budget in about fifty seconds with six
  // workers, so the throttling switched itself off exactly when it was needed — 80 of 120
  // probes died and 16 of 24 cells came back short. Wall clock: 120 of 120, no cell lost.
  assert.ok(RATE_LIMIT_BUDGET_MS > RATE_LIMIT_COOLDOWN_MS,
    'the budget must allow at least one full cooldown, or the mechanism never engages');

  resetRateLimits();
  const original = globalThis.fetch;
  // Six concurrent callers all limited, each asked to wait ~120ms. Summed, that is 720ms
  // of "budget"; in wall clock it is one 120ms pause they share.
  globalThis.fetch = scriptedFetch(Array.from({ length: 12 }, (_, i) =>
    (i < 6 ? { status: 429, headers: { 'retry-after': '0.12' } } : { status: 200 })));
  try {
    const started = Date.now();
    const all = await Promise.all(Array.from({ length: 6 }, () =>
      request('https://relay.example/v1/responses', {}, { timeoutMs: 500 })));
    const elapsed = Date.now() - started;
    assert.ok(all.every((r) => r.ok), 'every caller got through after the shared pause');
    assert.ok(elapsed < 700, `six shared pauses must not serialise into six waits (${elapsed}ms)`);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('the budget window restarts after a clear spell, so a long run stays protected', async () => {
  // 🔴 The first version never reset the window: five minutes after the FIRST 429 the
  // mechanism was off for good — for the rest of the battery AND for every later run in
  // the same process or tab. That reproduces the exact failure it was built for, one side
  // clean and the other shredded.
  //
  // 🔴 And this test has to CROSS the recovery window to say anything. The version before
  // it explicitly did not ("has not elapsed here"), which means deleting the reset entirely
  // left it passing — a test for a branch, written so the branch never runs. The two
  // windows are part of the retry contract precisely so a test can compress them.
  const cfg = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1, rateLimitBudgetMs: 120, rateLimitRecoveryMs: 60 };
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([
    { status: 429, headers: { 'retry-after': '0.05' } },
    { status: 200 },                                        // recovers
    { status: 429, headers: { 'retry-after': '0.05' } },     // limited again, after the spell
    { status: 200 },
  ]);
  try {
    const first = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 900 });
    assert.equal(first.ok, true);
    assert.ok(first.rate_limited_ms >= 40, 'the first episode waited');

    // Go quiet for longer than the recovery window. The next success clears the entry, so
    // the second episode gets a FULL budget rather than the remains of the first one's.
    await new Promise((r) => setTimeout(r, 90));

    const second = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 900 });
    assert.equal(second.ok, true, 'the second episode is still handled, not fast-failed');
    assert.equal(second.attempts, 2);
    // The load-bearing assertion: it WAITED. With the reset removed the 120ms budget is long
    // gone by now and this comes back at ~0ms, having retried immediately.
    assert.ok(second.rate_limited_ms >= 40,
      `the second episode must still be throttled, waited ${second.rate_limited_ms}ms`);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a Retry-After longer than the budget stops the run rather than starting a stampede', async () => {
  // 🔴 Honouring the header untruncated is only half of it. The budget still ends the WAIT,
  // and the first version then fell straight through to the next attempt — returning at the
  // budget mark, minutes before the server said it would answer, with the budget now spent
  // so every following 429 waited zero. Six workers do that together: a burst of requests
  // aimed at an endpoint that has explicitly said no, at the exact moment cells are being
  // lost. Give up instead, and let the loss show in the valid rate.
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([
    { status: 429, headers: { 'retry-after': '60' } },     // far beyond the budget below
    { status: 200 }, { status: 200 }, { status: 200 },
  ]);
  try {
    const started = Date.now();
    const r = await request('https://relay.example/v1/responses', {}, {
      retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1, rateLimitBudgetMs: 120 },
      timeoutMs: 900,
    });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false, 'it reports the loss instead of pretending');
    assert.equal(r.status, 429);
    assert.equal(globalThis.fetch.calls.length, 1,
      'not one request may be sent inside a pause the server stated and we could not sit out');
    assert.ok(elapsed >= 100, `it did spend the budget waiting first (${elapsed}ms)`);
    assert.ok(elapsed < 3000, 'and it did not sit out the full sixty seconds');
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a recovered window does not release a deadline the server has not reached', async () => {
  // 🔴 Recovery answers "has this target been quiet long enough to deserve a fresh budget",
  // and a still-running `Retry-After` answers that in the negative by definition. Expiring
  // the entry on the quiet window ALONE let any pause longer than the recovery window be
  // walked straight through by the next caller — with the defaults, `Retry-After: 300` and
  // traffic resuming at second 60, which is precisely the stampede the pause exists to stop.
  resetRateLimits();
  const original = globalThis.fetch;
  const sentAt = [];
  const t0 = Date.now();
  let served = 0;
  globalThis.fetch = async () => {
    sentAt.push(Date.now() - t0);
    const limited = served++ === 0;
    return {
      ok: !limited, status: limited ? 429 : 200,
      headers: new Map(limited ? [['retry-after', '0.3']] : []),
      text: async () => JSON.stringify({ ok: !limited }),
    };
  };
  try {
    const cfg = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1, rateLimitRecoveryMs: 60 };
    const first = request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 2000 });
    // A second caller arriving after the recovery window but well inside the server's pause.
    await new Promise((r) => setTimeout(r, 90));
    const second = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 2000 });
    await first;

    assert.equal(second.ok, true);
    assert.ok(second.rate_limited_ms >= 150,
      `the newcomer must wait out the server's deadline, waited ${second.rate_limited_ms}ms`);
    assert.ok(sentAt.every((t) => t < 50 || t >= 250),
      `nothing may be sent between the recovery window and the stated deadline: ${sentAt.join(', ')}ms`);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a success from before the 429 cannot cancel the pause it knows nothing about', async () => {
  // 🔴 The read path checks both recovery AND the stated deadline; the SUCCESS path checked
  // only recovery, and that is a different door into the same room. The request that gets
  // you is one issued BEFORE the 429: it was already in flight, it lands afterwards, it
  // succeeds, and it deletes a live cooldown a sibling had just been told to respect.
  // Measured: `Retry-After: 300ms` set at 3ms, the in-flight request completing at 100ms,
  // and the next caller sailing straight through at 124ms having waited zero.
  resetRateLimits();
  const original = globalThis.fetch;
  const t0 = Date.now();
  const sentAt = [];
  let n = 0;
  globalThis.fetch = async () => {
    const i = n++;
    sentAt.push(Date.now() - t0);
    if (i === 0) {                                    // the slow one, issued first, succeeds late
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
    }
    if (i === 1) {                                    // discovers the wall
      return {
        ok: false, status: 429, headers: new Map([['retry-after', '0.3']]),
        text: async () => JSON.stringify({ error: { message: 'slow down' } }),
      };
    }
    return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
  };
  try {
    const cfg = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1, rateLimitRecoveryMs: 60 };
    const slow = request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 3));
    const limited = request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 3000 });
    // A newcomer arriving after the slow one has succeeded, but well inside the 300ms pause.
    await new Promise((r) => setTimeout(r, 121));
    const late = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 3000 });
    await Promise.all([slow, limited]);

    assert.ok(late.rate_limited_ms >= 100,
      `the newcomer must still be held by the stated deadline, waited ${late.rate_limited_ms}ms`);
    assert.ok(sentAt.every((t) => t < 50 || t >= 250),
      `nothing may be sent between the recovery window and the stated deadline: ${sentAt.join(', ')}ms`);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a stale success does not reset the backoff tier either', async () => {
  // 🔴 The quieter half of the same mistake. Deleting the entry on a stale success was the
  // loud failure; zeroing `consecutive` is the one that survives a fix aimed only at the
  // deadline. An endpoint that keeps refusing should be asked back at 40ms, then 80, then
  // 160 — but a slow request issued BEFORE the 429, landing afterwards and succeeding, put
  // the counter back to zero, so the second refusal re-used the first tier.
  resetRateLimits();
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    const i = n++;
    if (i === 0) {                      // issued first, slow, succeeds during B's first pause
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
    }
    // No Retry-After anywhere: the pause is entirely the one we invent, so the doubling
    // schedule is the only thing under test.
    if (i <= 2) {
      return {
        ok: false, status: 429, headers: new Map(),
        text: async () => JSON.stringify({ error: { message: 'slow down' } }),
      };
    }
    return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
  };
  try {
    const cfg = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 40, rateLimitRecoveryMs: 10_000 };
    const slow = request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 2));
    const limited = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 3000 });
    await slow;

    assert.equal(limited.ok, true);
    assert.equal(limited.attempts, 3, 'two refusals then a success');
    // 40 + 80 with the escalation intact; 40 + 40 without it. The midpoint separates them
    // with room for scheduler jitter on either side.
    assert.ok(limited.rate_limited_ms >= 100,
      `consecutive refusals must keep doubling, waited ${limited.rate_limited_ms}ms (40+80 expected)`);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('attempts counts requests that were SENT, never ones we decided against', async () => {
  // 🔴 判定语义⑤ defines `attempts` as network attempts. It was incremented on the way into
  // the next iteration, so a call that parked and then bailed — budget spent, or cancelled —
  // reported two attempts against one fetch. Anything reading it to judge how hard an
  // endpoint was pushed got a number inflated exactly when it was pushed least.
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([{ status: 429, headers: { 'retry-after': '60' } }]);
  try {
    const r = await request('https://relay.example/v1/responses', {}, {
      retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1, rateLimitBudgetMs: 60 },
      timeoutMs: 900,
    });
    assert.equal(globalThis.fetch.calls.length, 1);
    assert.equal(r.attempts, 1, 'one fetch, one attempt');
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }

  resetRateLimits();
  globalThis.fetch = scriptedFetch([{ status: 503 }, { status: 503 }, { status: 200 }]);
  try {
    const r = await request('https://relay.example/v1/responses', {}, {
      retry: { attempts: 3, baseDelayMs: 1 }, timeoutMs: 900,
    });
    assert.equal(r.attempts, 3, 'and three fetches are still three attempts');
    assert.equal(r.attempts, globalThis.fetch.calls.length);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('the cap belongs to the pause we invent, never to one the server stated', async () => {
  // 🔴 The distinction that matters, and the one that stayed unpinned through two reviews
  // because reaching it meant spending ninety real seconds. Capping `Retry-After: 300` at
  // ninety means retrying at 90, 180 and 270 — three attempts knowingly spent early against
  // an explicit instruction. So the cap is part of the retry contract, and here it is set to
  // 40ms against a stated 300ms: the wait must be the SERVER's number, not ours.
  const cfg = { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1000, rateLimitCooldownMaxMs: 40 };
  resetRateLimits();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = scriptedFetch([{ status: 429, headers: { 'retry-after': '0.3' } }, { status: 200 }]);
    const stated = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 2000 });
    assert.equal(stated.ok, true);
    assert.ok(stated.rate_limited_ms >= 250,
      `a stated 300ms must not be capped to 40ms, waited ${stated.rate_limited_ms}ms`);

    // …and the cap still governs the pause we make up when the server says nothing.
    resetRateLimits();
    globalThis.fetch = scriptedFetch([{ status: 429 }, { status: 200 }]);
    const invented = await request('https://relay.example/v1/responses', {}, { retry: cfg, timeoutMs: 2000 });
    assert.equal(invented.ok, true);
    assert.ok(invented.rate_limited_ms <= 200,
      `our own 1000ms backoff must be capped to 40ms, waited ${invented.rate_limited_ms}ms`);
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('an explicit Retry-After is not truncated into an early retry', async () => {
  // 🔴 Capping the SERVER's instruction at 90s means retrying at 90, 180 and 270 against a
  // `Retry-After: 300` — three attempts knowingly spent early. The cap belongs to the wait
  // we invent, not to one we were told.
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([{ status: 429, headers: { 'retry-after': '300' } }]);
  try {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 120);
    const started = Date.now();
    const r = await request('https://relay.example/v1/responses', {}, {
      retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 }, timeoutMs: 500,
      cancelled: () => cancelled,
    });
    // It was still parked when the cancel flag flipped: it had NOT gone back at 90s, and
    // exactly ONE request was ever issued — the retry never fired because the caller had
    // said stop.
    assert.equal(r.ok, false);
    assert.equal(globalThis.fetch.calls.length, 1, 'a cancelled call must not spend another request');
    assert.ok(Date.now() - started >= 100, 'it honoured the long wait rather than retrying at 90s');
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('a parked caller notices a cancel instead of holding the run for minutes', async () => {
  // 🔴 The cooldown widened the uncancellable window from ~4.5s to minutes. Pressing Stop
  // during one left every worker parked and the run kept spending quota after the user
  // had said no.
  resetRateLimits();
  const original = globalThis.fetch;
  globalThis.fetch = scriptedFetch([{ status: 429, headers: { 'retry-after': '60' } }]);
  try {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 50);
    const started = Date.now();
    await request('https://relay.example/v1/responses', {}, {
      retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 }, timeoutMs: 500,
      cancelled: () => cancelled,
    });
    assert.ok(Date.now() - started < 4000, 'a sixty-second park must break out on cancel');
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('Stop reaches a parked worker THROUGH the real client, not just through request()', async () => {
  // 🔴 The test that used to cover this called `request(..., {cancelled})` directly and
  // passed — while the wiring it stands for did not exist. `createResponsesClient` and
  // `createChatProbe` were calling `request(url, init, { retry, timeoutMs })` with no
  // `cancelled`, so a worker already inside a shared cooldown could not hear Stop: it sat
  // out the full pause and then fired its retry, spending the user's quota after they had
  // said no. A cancellation test must therefore go through the client the UI actually
  // builds — the seam that was broken is the one between them.
  resetRateLimits();
  const original = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async () => {
    sent += 1;
    return {
      ok: false, status: 429,
      headers: new Map([['retry-after', '30']]),
      text: async () => JSON.stringify({ error: { message: 'slow down' } }),
    };
  };
  try {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 60);

    for (const [label, make] of [
      ['responses', () => createResponsesClient({
        baseUrl: 'https://relay.example/v1', apiKey: 'k', cancelled: () => cancelled,
        retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 },
      })({ model: 'm', input: 'hi' })],
      ['chat', () => createChatProbe({
        baseUrl: 'https://relay.example/v1', apiKey: 'k', cancelled: () => cancelled,
        retry: { attempts: 3, baseDelayMs: 1, rateLimitCooldownMs: 1 },
      })({ model: 'm', system: 's', user: 'u' })],
    ]) {
      sent = 0;
      cancelled = false;
      setTimeout(() => { cancelled = true; }, 60);
      const started = Date.now();
      const res = await make();
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, `${label}: a thirty-second park must break out on cancel (${elapsed}ms)`);
      assert.equal(sent, 1, `${label}: no retry may be spent after the caller said stop`);
      assert.ok(res.error, `${label}: the cancelled probe reports a failure rather than a fake answer`);
      resetRateLimits();
    }
  } finally {
    globalThis.fetch = original;
    resetRateLimits();
  }
});

test('the default port is normalised so one target is not keyed as two', () => {
  assert.equal(rateLimitKey('https://relay.com/v1'), rateLimitKey('https://relay.com:443/v1'));
  assert.equal(rateLimitKey('http://relay.com/v1'), rateLimitKey('http://relay.com:80/v1'));
  assert.notEqual(rateLimitKey('https://relay.com/v1'), rateLimitKey('https://relay.com:8443/v1'));
});
