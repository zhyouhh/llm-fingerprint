// L0a's two GETs. They live here because I-4 puts every probe-path outbound request in
// this directory — a lint keeps new ones from sprouting elsewhere.
//
// 🔴 L0a issues no completions. Its findings are profile display only: whether /models
// answers says nothing about whether /chat/completions works (some compatible endpoints
// serve chat without implementing /models, and vice versa), so it must never gate
// L1/L2. The only real answer to "can this endpoint be fingerprinted" is L1's first
// sampling run.

import { request, DEFAULT_TIMEOUT_MS } from './transport.js';
import { RETRY_ATTEMPTS_DEFAULT, RETRY_BASE_DELAY_MS_DEFAULT } from '../../contracts.js';

/**
 * @returns {(args: {url: string, apiKey?: string}) => Promise<object>} outbound result
 *   plus `headers` — response headers are a cheap endpoint fingerprint of their own
 *   (x-oneapi-request-id ⇒ One API / New API; x-cpa-* ⇒ cliproxyapi).
 */
export function createGetProbe({ timeoutMs = DEFAULT_TIMEOUT_MS,
                                 retry = { attempts: RETRY_ATTEMPTS_DEFAULT, baseDelayMs: RETRY_BASE_DELAY_MS_DEFAULT } } = {}) {
  return async function get({ url, apiKey }) {
    // /api/status is an open endpoint that wants no auth; sending a key there is
    // pointless and, on some frameworks, changes the response.
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await request(url, { method: 'GET', headers }, { retry, timeoutMs });

    return {
      raw: res.ok ? res.raw_text : '',
      body: res.body,
      headers: res.headers,
      error: res.error,
      http_status: res.status,
      latency_ms: res.latency_ms,
      attempts: res.attempts,
      usage: null,
      finish_reason: null,
      model_reported: null,
    };
  };
}
