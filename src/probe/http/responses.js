// The Responses path: POST {baseUrl}/responses.
//
// This is where `reasoning.effort` and `reasoning.mode` actually take effect. Sending
// `reasoning_effort` to /chat/completions gets no reaction from any endpoint — that is
// the wrong protocol, not an unsupported feature, and reading it as the latter produced
// a flatly inverted conclusion once already (see CLAUDE.md's 实测结论存档).
//
// Text extraction follows test/fixtures/responses-sample.json, a real captured body —
// not a description of one. The real shape has no top-level `output_text` and no
// `finish_reason` at all; a stub written from prose would have invented both and gone
// green.

import { request, probeHeaders, DEFAULT_TIMEOUT_MS } from './transport.js';
import { buildResponsesBody, RETRY_ATTEMPTS_DEFAULT, RETRY_BASE_DELAY_MS_DEFAULT } from '../../contracts.js';

/**
 * Walk output[] and concatenate the text of every message item.
 * Reasoning items live in the same array and carry no `content[].text`, so they drop
 * out naturally rather than needing to be filtered by type name.
 */
export function extractText(body) {
  const items = Array.isArray(body?.output) ? body.output : [];
  return items
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Responses has no `finish_reason`; it reports `status` plus `incomplete_details`.
 * Map it onto the same vocabulary the chat path produces so the two paths can share a
 * sample shape — 判定语义① only splits by sample KIND, not by protocol.
 */
export function mapFinishReason(body) {
  if (!body || typeof body.status !== 'string') return null;
  if (body.status === 'completed') return 'stop';
  if (body.status === 'incomplete') return body.incomplete_details?.reason ?? 'incomplete';
  return body.status;   // 'failed' | 'cancelled' | 'in_progress' | anything new
}

/**
 * @param {{baseUrl, apiKey, timeoutMs?, retry?}} cfg
 * @returns {(args: {model, input, instructions?, maxOutputTokens?, reasoning?, extra?}) => Promise<object>}
 */
export function createResponsesClient({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS,
                                        retry = { attempts: RETRY_ATTEMPTS_DEFAULT, baseDelayMs: RETRY_BASE_DELAY_MS_DEFAULT } }) {
  const url = `${baseUrl}/responses`;

  return async function ask({ model, input, instructions, maxOutputTokens = 16, reasoning, extra = {} }) {
    // 判定语义⑧ — store:false is not overridable, and a colliding `extra` key throws
    // BEFORE anything is sent. Probe questions are generated fresh on every run;
    // leaving them on the far side would hand an adversary the bank we rely on not
    // being public.
    const merged = { ...extra };
    if (instructions !== undefined) merged.instructions = instructions;
    if (reasoning !== undefined) merged.reasoning = reasoning;
    const body = buildResponsesBody({ model, input, maxOutputTokens, extra: merged });

    const res = await request(url, {
      method: 'POST',
      headers: probeHeaders(apiKey),
      body: JSON.stringify(body),
    }, { retry, timeoutMs });

    return {
      raw: res.ok ? extractText(res.body) : '',
      error: res.error,
      http_status: res.status,
      latency_ms: res.latency_ms,
      attempts: res.attempts,
      usage: res.body?.usage ?? null,
      finish_reason: mapFinishReason(res.body),
      model_reported: res.body?.model ?? null,
      reasoning_len: res.body?.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      // Echoed back by gateways that pass the flag through; null where they strip it.
      // Cheap and load-bearing: it is how "does this endpoint forward effort at all"
      // gets answered without inferring it from token counts.
      reasoning_echo: res.body?.reasoning ?? null,
    };
  };
}
