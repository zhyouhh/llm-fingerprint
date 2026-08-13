// The fingerprint path: POST {baseUrl}/chat/completions.
//
// 🔴 The request body is byte-frozen (I-1). reference/genuine-*.json was collected with
// exactly these bytes; a different body is a different shell, and a different shell
// makes the distances incomparable with the reference this whole project is judged
// against. `test/fixtures/chat-request-snapshot.json` pins it.
//
// 🔴 The probe function takes no sampling parameters. The previous adapter accepted a
// `temperature` override, which meant "byte-identical" held only while every caller
// happened not to pass one. That hole is welded shut here: there is nowhere to put it.

import { request, probeHeaders, DEFAULT_TIMEOUT_MS } from './transport.js';
import { RETRY_ATTEMPTS_DEFAULT, RETRY_BASE_DELAY_MS_DEFAULT } from '../../contracts.js';

/** Upstream's fixed parameters. Changing any of these breaks comparability. */
export const PROBE_PARAMS = Object.freeze({ max_tokens: 16, temperature: 1 });

/**
 * The frozen fingerprint body. Key order is part of the contract — the snapshot test
 * compares serialised bytes, and JSON.stringify preserves insertion order.
 */
export function buildChatProbeBody({ model, system, user }) {
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: PROBE_PARAMS.temperature,
    max_tokens: PROBE_PARAMS.max_tokens,
    reasoning: { enabled: false },   // I-3: `enabled` belongs here; effort/mode never do
  };
}

/**
 * @param {{baseUrl: string, apiKey: string, timeoutMs?: number, retry?: object}} cfg
 *   `baseUrl` already carries the version segment (".../v1") — paths are appended
 *   straight onto it.
 * @returns {(args: {model, system, user}) => Promise<object>} an outbound result whose
 *   shape satisfies contracts.assertOutboundResult
 */
export function createChatProbe({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS,
                                  retry = { attempts: RETRY_ATTEMPTS_DEFAULT, baseDelayMs: RETRY_BASE_DELAY_MS_DEFAULT } }) {
  const url = `${baseUrl}/chat/completions`;

  return async function probe({ model, system, user }) {
    const res = await request(url, {
      method: 'POST',
      headers: probeHeaders(apiKey),
      body: JSON.stringify(buildChatProbeBody({ model, system, user })),
    }, { retry, timeoutMs });

    const choice = res.body?.choices?.[0];
    return {
      // 🔴 '' on failure, never null and never the error page: downstream classifies on
      // `error` first, and a non-empty raw would otherwise look like a real completion.
      raw: res.ok ? (choice?.message?.content ?? '') : '',
      error: res.error,
      http_status: res.status,
      latency_ms: res.latency_ms,
      attempts: res.attempts,
      usage: res.body?.usage ?? null,
      // 待消解 #2: present-but-null, never absent — "the model echo changed mid-run" is
      // the sharpest account-rotation signal and this is its only producer.
      finish_reason: choice?.finish_reason ?? null,
      model_reported: res.body?.model ?? null,
      reasoning_len: res.body?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  };
}
