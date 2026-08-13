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

import { assertRetryConfig, RETRY_ATTEMPTS_DEFAULT, RETRY_BASE_DELAY_MS_DEFAULT } from '../../contracts.js';

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
 * @returns {Promise<{ok, status, body, error, attempts, latency_ms, raw_text}>}
 *   `attempts` counts NETWORK ATTEMPTS (a DNS failure counts, though no request
 *   arrived); `latency_ms` is total wall clock including every retry and backoff.
 */
export async function request(url, init = {}, {
  retry = { attempts: RETRY_ATTEMPTS_DEFAULT, baseDelayMs: RETRY_BASE_DELAY_MS_DEFAULT },
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cfg = assertRetryConfig(retry);   // 判定语义⑥ — before anything goes out
  const started = Date.now();
  let attempts = 0;
  let last;

  for (let i = 0; i < cfg.attempts; i++) {
    attempts++;
    last = await attemptOnce(url, init, timeoutMs);
    if (last.ok || !isRetryable(last.error)) break;
    if (i < cfg.attempts - 1) await sleep(cfg.baseDelayMs * 2 ** i);
  }

  return {
    ok: last.ok === true,
    status: last.status ?? null,
    body: last.body ?? null,
    error: last.error ?? null,
    raw_text: last.raw_text ?? '',
    headers: last.headers ?? {},
    attempts,
    latency_ms: Date.now() - started,
  };
}

/** Auth + content-type, in one place so no route can forget them. */
export function probeHeaders(apiKey, extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extra };
}
