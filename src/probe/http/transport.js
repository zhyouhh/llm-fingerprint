// The one place that actually issues probe HTTP, retries it, and turns whatever comes
// back into a structured value.
//
// 🔴 Retry lives HERE, inside the client (判定语义⑥). No caller may add a second layer:
// two layers of three attempts is nine requests per probe, and the per-endpoint ceiling
// the compliance table promises would quietly triple.
//
// 🔴 Nothing throws for a transport-level outcome (I-5/I-6). A non-2xx, a malformed
// body, a timeout and a DNS failure all come back as `error`, because the layers above
// have to record them as samples — a thrown error is a sample that never existed, and a
// sample that never existed shrinks the denominator (判定语义④).

import {
  assertRetryConfig, RETRY_ATTEMPTS_DEFAULT, RETRY_BASE_DELAY_MS_DEFAULT,
  RATE_LIMIT_COOLDOWN_MS_DEFAULT,
  RATE_LIMIT_BUDGET_MS_DEFAULT,
  RATE_LIMIT_RECOVERY_MS_DEFAULT,
  RATE_LIMIT_COOLDOWN_MAX_MS_DEFAULT,
} from '../../contracts.js';

export const DEFAULT_TIMEOUT_MS = 90_000;

/** Error codes that mean "try again": transient by nature, not a statement about us. */
const RETRYABLE_CODES = new Set(['network_error', 'timeout', 'malformed_json']);

/**
 * 🔴 Judged on code AND status, never status alone. A network failure has no status at
 * all, so `if (err.status)` is falsy for it — the exact bug that would let a dead
 * endpoint read as a successful empty completion.
 */
export function isRetryable(error) {
  if (!error) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  if (!Number.isInteger(error.status)) return false;
  return error.status === 429 || error.status >= 500;
}

/**
 * I-5's fallback order for the error code: body `error.code`, then `error.type`, then a
 * synthetic `http_<status>`. Gateways differ on which one they populate; taking the
 * first that exists keeps the profile comparable across them.
 */
export function classifyHttpError(status, body) {
  const fromBody = body?.error?.code ?? body?.error?.type ?? null;
  return {
    status,
    code: fromBody ?? `http_${status}`,
    message: String(body?.error?.message ?? '').slice(0, 300),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════════════════════
 * Rate limiting — a SHARED, per-target pause, not a per-request retry
 *
 * 🔴 Measured, on two real runs: 102 and 137 of one side's 420 probes died on HTTP 429,
 * and ZERO on the other side. The subject battery runs first and burns the per-minute
 * quota; by the control battery every worker is hitting the wall at once. The damage is
 * not "some probes failed" — it is that whole CELLS fell under the sample bar and were
 * dropped, and the survivors were not a random subset: the twelve cells rate limiting
 * killed averaged S = 0.140 while the sixteen that lived averaged 0.211. A 17% shift in
 * the number the verdict is computed from, caused entirely by which minute the quota ran
 * out in.
 *
 * The old policy could not have helped: three attempts at 1.5s then 3s spends the whole
 * budget inside 4.5 seconds, against a limit measured in MINUTES. More attempts would
 * only have hammered harder.
 *
 * So the fix is about WHEN, not how many, and it is shared: one 429 parks every request
 * to that target until the deadline. Six workers wait once instead of six times, and the
 * run's throughput drops to whatever the endpoint will actually take.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Fallback pause when the server does not say how long to wait; see 判定语义⑥. */
export const RATE_LIMIT_COOLDOWN_MS = RATE_LIMIT_COOLDOWN_MS_DEFAULT;
/** Consecutive limits double the wait, up to here. */
export const RATE_LIMIT_COOLDOWN_MAX_MS = RATE_LIMIT_COOLDOWN_MAX_MS_DEFAULT;
/**
 * Total time one target may hold the whole run waiting. Past it the run stops waiting and
 * reports the loss — a permanently rate-limited endpoint must not turn a 7-minute run into
 * an open-ended one, and an honest "we could not measure this" beats waiting forever.
 */
export const RATE_LIMIT_BUDGET_MS = RATE_LIMIT_BUDGET_MS_DEFAULT;
/**
 * A target that has gone this long without a 429 is treated as recovered, and its budget
 * window starts fresh. Long enough that an endpoint limiting us every few seconds cannot
 * keep buying more waiting; short enough that the second half of a battery is protected.
 */
export const RATE_LIMIT_RECOVERY_MS = RATE_LIMIT_RECOVERY_MS_DEFAULT;
/** Longest a parked worker goes without checking the deadline or the cancel flag. */
export const RATE_LIMIT_TICK_MS = 1_000;

/** target → {until, consecutive, firstLimitedAt}. Shared across every concurrent caller. */
const cooldowns = new Map();

/**
 * Which target a URL is for. In Node that is the origin; in the browser the request goes
 * to our own worker with the real host in the PATH (`/p/relay.com/v1/...`), so the origin
 * would lump every relay together into one shared pause.
 */
export function rateLimitKey(url) {
  const s = String(url);
  const absolute = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)/i.exec(s);
  if (absolute) {
    const [, scheme, authority] = absolute;
    // `https://relay.com` and `https://relay.com:443` are one target; keyed apart, one
    // form's cooldown would not pause the other and the quota would be hit twice.
    const withoutDefaultPort = authority
      .replace(/:443$/, scheme.toLowerCase() === 'https' ? '' : ':443')
      .replace(/:80$/, scheme.toLowerCase() === 'http' ? '' : ':80');
    return `${scheme.toLowerCase()}://${withoutDefaultPort.toLowerCase()}`;
  }
  const proxied = /^\/p\/([^/]+)/.exec(s);
  return proxied ? `proxy:${proxied[1].toLowerCase()}` : 'default';
}

/**
 * `Retry-After`, in ms. RFC 9110 allows delta-seconds or an HTTP-date; both appear in the
 * wild. Anything unparseable returns null so the caller falls back to its own schedule.
 */
export function retryAfterMs(headers, now = Date.now()) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null) return null;
  const seconds = Number(String(raw).trim());
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : 0;
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Tests and long-lived processes need to be able to forget a target's pause. */
export function resetRateLimits() { cooldowns.clear(); }

function noteRateLimit(key, serverAskedMs, cooldownMs, capMs = RATE_LIMIT_COOLDOWN_MAX_MS) {
  const now = Date.now();
  const state = cooldowns.get(key) ?? { until: 0, consecutive: 0, windowStart: now, lastLimitedAt: now };
  state.consecutive += 1;
  state.lastLimitedAt = now;
  // 🔴 The cap belongs to the wait we invent, NOT to one the server stated. Truncating
  // `Retry-After: 300` to 90 seconds means retrying at 90, 180 and 270 — three attempts
  // spent knowingly early, against an instruction the server was explicit about. If the
  // server asks for longer than the budget allows, the budget stops the waiting; it does
  // not license going back sooner.
  const invented = Math.min(cooldownMs * 2 ** (state.consecutive - 1), capMs);
  state.until = Math.max(state.until, now + (serverAskedMs ?? invented));
  cooldowns.set(key, state);
}

/**
 * 🔴 The budget window resets only after a sustained clear spell.
 *
 * The first version never reset it, and that made the whole mechanism self-disabling on
 * exactly the runs it was built for: five minutes after the FIRST 429 the budget was gone
 * for good, so the second half of a long battery — and every later run in the same
 * process or tab — took its 429s with no waiting at all. That reproduces the original
 * failure precisely: one side clean, the other side shredded.
 *
 * A clear spell, not any single success, because an endpoint alternating 429 and 200 would
 * otherwise refresh the budget forever and the run would never end.
 */
function clearRateLimit(key, recoveryMs = RATE_LIMIT_RECOVERY_MS) {
  const state = cooldowns.get(key);
  if (!state) return;
  // 🔴 ONE condition, and the escalation counter dies with the entry rather than separately.
  //
  // A success cannot be trusted to describe the present, because the request behind it may
  // have been issued BEFORE the 429 — we do not know, and nothing in a fetch response says.
  // Three versions of this were wrong in three ways, each quieter than the last:
  //   1. delete on recovery alone → a stale success released a deadline a sibling had just
  //      been told to respect (`Retry-After: 300ms`, next caller through at 124ms, zero wait);
  //   2. guard the delete but reset `consecutive` anyway → the next 429 re-used the FIRST
  //      backoff tier, so an endpoint still refusing was asked back at 40ms not 80ms;
  //   3. guard both on `until` → a success landing after the deadline but before the
  //      recovery window STILL reset the tier, and that success can predate the 429 too.
  // So the counter resets exactly when the target is declared recovered, and never
  // otherwise. A clear spell is the only evidence that is about the present.
  if (Date.now() - state.lastLimitedAt < recoveryMs || Date.now() < state.until) return;
  cooldowns.delete(key);
}

/**
 * Park until this target's pause expires. Returns the ms actually waited.
 *
 * 🔴 The budget is WALL CLOCK since the first 429, not the sum of what each caller waited.
 * Summing was the first version and it was wrong by a factor of the concurrency: six
 * workers parking sixty seconds together spend sixty seconds of a run's life, not three
 * hundred and sixty. Measured — it burned a five-minute budget in about fifty seconds and
 * the throttling switched itself off exactly when it was needed, leaving 80 of 120 probes
 * dead and 16 of 24 cells short.
 */
async function waitOutRateLimit(key, cancelled, budgetMs = RATE_LIMIT_BUDGET_MS,
                                recoveryMs = RATE_LIMIT_RECOVERY_MS) {
  // 🔴 Recovery is a matter of TIME, so it has to be judged when the entry is read, not only
  // when a success happens to land. Expiring it on the success path alone meant a target
  // that went quiet — the run moved to the other side of the battery, the user paused —
  // came back to a window that had started minutes ago and a budget already spent, and its
  // 429s were then answered with no waiting at all. That is the self-disabling failure this
  // whole mechanism exists to prevent, reintroduced through the door marked "recovered".
  //
  // ⚠️ …and only once the stated deadline has ALSO passed. Recovery answers "has this target
  // been quiet long enough to deserve a fresh budget", which a still-running `Retry-After`
  // answers in the negative by definition. Dropping the entry on the recovery window alone
  // let any pause longer than 60 seconds be walked straight through by the next caller: with
  // `Retry-After: 300`, requests resume at second 60 against a server that said 300.
  const existing = cooldowns.get(key);
  if (existing && Date.now() - existing.lastLimitedAt >= recoveryMs && existing.until <= Date.now()) {
    cooldowns.delete(key);
  }
  const state = cooldowns.get(key);
  if (!state) return { waited: 0, cutShort: false };
  const overBudget = () => Date.now() - state.windowStart >= budgetMs;
  let waited = 0;
  // A loop, not one sleep: another worker may extend the deadline while this one waits,
  // and the caller may ask to stop. Sliced so both are noticed within a second rather
  // than after the full cooldown — a parked worker used to be uncancellable for minutes.
  while (state.until > Date.now() && !overBudget() && !cancelled?.()) {
    const slice = Math.min(state.until - Date.now(),
      budgetMs - (Date.now() - state.windowStart), RATE_LIMIT_TICK_MS);
    if (slice <= 0) break;
    await sleep(slice);
    waited += slice;
  }
  // 🔴 Left the pause while the deadline is still ahead — the budget ran out, not the wait.
  // The caller must NOT simply proceed: a `Retry-After: 600` against a five-minute budget
  // would otherwise return here at 300s and fire, five minutes before the server said it
  // would answer, and with the budget now spent every following 429 waits zero. Six workers
  // do that together. Reported so `request` can stop instead of joining the stampede.
  return { waited, cutShort: state.until > Date.now() && overBudget() };
}

/**
 * One attempt. Returns {ok:true, body, status} or {ok:false, error, status}.
 * Never throws for anything the network or the peer did.
 */
async function attemptOnce(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();

    let body = null;
    let parseFailed = false;
    if (text.length > 0) {
      try { body = JSON.parse(text); } catch { parseFailed = true; }
    }

    // Response headers are a cheap endpoint fingerprint in their own right
    // (x-oneapi-request-id ⇒ One API / New API, x-cpa-* ⇒ cliproxyapi), so they ride
    // along on every outcome rather than only on success.
    const headers = Object.fromEntries(res.headers);

    if (!res.ok) {
      // A non-2xx whose body is not JSON still has a status, and the status is the
      // information that matters. Do not upgrade it to malformed_json.
      return { ok: false, status: res.status, error: classifyHttpError(res.status, body), raw_text: text, headers };
    }
    if (parseFailed) {
      // I-6: a 200 carrying an HTML error page is a real relay behaviour. It is treated
      // exactly like a 5xx, retry included — the previous adapter did retry it, and
      // dropping that would be a regression.
      return {
        ok: false,
        status: res.status,
        error: { status: res.status, code: 'malformed_json', message: text.slice(0, 300) },
        raw_text: text,
        headers,
      };
    }
    return { ok: true, status: res.status, body: body ?? {}, raw_text: text, headers };
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : 'network_error';
    // 🔴 status is null: there is no HTTP response to take a status from. DNS failures
    // never reached a server at all, yet they still cost an attempt.
    return { ok: false, status: null, error: { status: null, code, message: String(err?.message ?? err).slice(0, 300) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issue a request, retrying transient failures with exponential backoff.
 *
 * @returns {Promise<{ok, status, body, error, attempts, latency_ms, rate_limited_ms, raw_text}>}
 *   `attempts` counts NETWORK ATTEMPTS (a DNS failure counts, though no request
 *   arrived); `latency_ms` is how long the ENDPOINT took, excluding any shared
 *   rate-limit pause — that pause is our own penalty box, not the endpoint's speed, and
 *   folding it in would poison the latency percentiles L0 reports.
 *   `rate_limited_ms` is that pause, reported separately.
 */
export async function request(url, init = {}, {
  retry = { attempts: RETRY_ATTEMPTS_DEFAULT, baseDelayMs: RETRY_BASE_DELAY_MS_DEFAULT },
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // Lets a caller break out of a shared pause. Without it, pressing Stop during a cooldown
  // left every worker parked for the full wait and the run kept spending quota after the
  // user had said no.
  cancelled = null,
} = {}) {
  const cfg = assertRetryConfig(retry);   // 判定语义⑥ — before anything goes out
  const key = rateLimitKey(url);
  const started = Date.now();
  // 🔴 Counts requests that were actually SENT. It used to be incremented on the way into
  // the next iteration, so a call that parked and then bailed out — budget spent, or the
  // caller cancelled — reported two attempts against one fetch, and `attempts` is the field
  // 判定语义⑤ defines as network attempts. Anything reading it to gauge how hard we pushed
  // an endpoint was reading a number inflated exactly when we pushed it least.
  let fetches = 0;
  let parked = 0;
  let last;

  for (let i = 0; i < cfg.attempts; i++) {
    // Before EVERY attempt, including the first: a worker that has not personally been
    // limited yet must still not walk into a wall its siblings already found.
    const park = await waitOutRateLimit(key, cancelled, cfg.rateLimitBudgetMs, cfg.rateLimitRecoveryMs);
    parked += park.waited;
    // 🔴 And once the caller has said stop, STOP — do not spend one more request. Breaking
    // out of the pause only to fire the retry anyway would keep burning the user's quota
    // after they pressed the button, which is worse than the wait it was meant to shorten.
    if (cancelled?.()) {
      last = last ?? { ok: false, status: null, error: { status: null, code: 'cancelled', message: 'cancelled by caller' } };
      break;
    }
    // Budget gone with the target still inside its stated pause: fail this probe rather than
    // send a request we have been told will be refused. The loss is visible — it lands in
    // the run's valid rate, which now blocks a conviction on a thinned sample — whereas a
    // stampede is invisible except as the cells it costs.
    if (park.cutShort) {
      last = last ?? {
        ok: false,
        status: 429,
        error: { status: 429, code: 'rate_limited', message: 'still rate limited when the waiting budget ran out' },
      };
      break;
    }
    fetches += 1;
    last = await attemptOnce(url, init, timeoutMs);

    if (last.error?.status === 429) {
      noteRateLimit(key, retryAfterMs(last.headers), cfg.rateLimitCooldownMs, cfg.rateLimitCooldownMaxMs);
    } else if (last.ok) {
      clearRateLimit(key, cfg.rateLimitRecoveryMs);
    }

    if (last.ok || !isRetryable(last.error)) break;
    // A 429 is answered by the shared pause above, not by this per-request backoff — the
    // two would otherwise stack into a wait nobody chose.
    if (i < cfg.attempts - 1 && last.error?.status !== 429) await sleep(cfg.baseDelayMs * 2 ** i);
  }

  return {
    ok: last.ok === true,
    status: last.status ?? null,
    body: last.body ?? null,
    error: last.error ?? null,
    raw_text: last.raw_text ?? '',
    headers: last.headers ?? {},
    // 判定语义⑤ — a sample that exists was attempted, so never below 1 even when the caller
    // cancelled before anything went out.
    attempts: Math.max(1, fetches),
    latency_ms: Date.now() - started - parked,
    rate_limited_ms: parked,
  };
}

/** Auth + content-type, in one place so no route can forget them. */
export function probeHeaders(apiKey, extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extra };
}
