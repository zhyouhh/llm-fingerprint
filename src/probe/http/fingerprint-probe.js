// Fingerprint probes, one per wire protocol.
//
// 🔴 A fingerprint is only comparable with another fingerprint collected the SAME way.
// Protocol is part of "the same way" — the identical question over chat/completions and
// over Responses produces measurably different distributions (the self-hosted gateway
// answers num100-random|en with 47 at probability 1 over chat, and 47/57/57 over
// Responses at effort:none). Mixing them silently voids every comparison, exactly like
// the normalisation mismatch did.
//
// So the protocol travels with the data, and the comparison checks it.

import { createChatProbe, PROBE_PARAMS } from './chat.js';
import { createResponsesClient } from './responses.js';

/**
 * Why a second protocol exists at all:
 *
 * The chat body carries `reasoning:{enabled:false}` — an OpenRouter extension, since the
 * paper's data was collected there — which is what keeps a reasoning model from spending
 * the whole 16-token budget on hidden reasoning. Relays accept it. The official API does
 * not, and without it the model reasons and returns nothing, so the official API cannot
 * supply a chat-protocol reference at all (measured: 240/240 empty).
 *
 * Responses reaches the same state through a parameter the official API does support:
 * `reasoning: {effort: 'none'}`. Measured 3/3 valid on all five endpoints including the
 * official one — which is what makes an untainted, harness-free reference possible.
 */
export const FINGERPRINT_PROTOCOLS = Object.freeze({
  chat: {
    id: 'chat',
    params: { max_tokens: PROBE_PARAMS.max_tokens, temperature: PROBE_PARAMS.temperature, reasoning: { enabled: false } },
    note: 'paper-compatible; needs the OpenRouter reasoning extension, so the official API cannot serve it',
  },
  responses: {
    id: 'responses',
    params: { max_output_tokens: 16, reasoning: { effort: 'none' }, store: false },
    note: 'official-API-compatible; reasoning is disabled through effort:none instead',
  },
});

/** Wrap a Responses client in the fingerprint probe interface ({model, system, user}). */
export function createResponsesFingerprintProbe(cfg) {
  const client = createResponsesClient(cfg);
  return async function probe({ model, system, user }) {
    // Frozen exactly like I-1 freezes the chat body: same fields, same values, every
    // time. `instructions` carries what `messages[0]` carries over chat.
    return client({
      model,
      instructions: system,
      input: user,
      maxOutputTokens: FINGERPRINT_PROTOCOLS.responses.params.max_output_tokens,
      reasoning: FINGERPRINT_PROTOCOLS.responses.params.reasoning,
    });
  };
}

/**
 * @param {'chat'|'responses'} protocol
 * @returns {(cfg: object) => Function}
 */
export function fingerprintProbeFactory(protocol) {
  if (protocol === 'chat') return createChatProbe;
  if (protocol === 'responses') return createResponsesFingerprintProbe;
  throw new Error(`unknown fingerprint protocol: ${protocol}`);
}

/**
 * 🔴 Refuse to compare across protocols. This is the same class of failure as the
 * normalisation mismatch — no error, no symptom, just a distance that means nothing.
 */
export function assertSameProtocol(referenceProtocol, runProtocol) {
  const ref = referenceProtocol ?? 'chat';   // files written before this field existed
  if (ref !== runProtocol) {
    throw new Error(
      `fingerprint protocol mismatch: the reference was collected over "${ref}" but this run ` +
      `used "${runProtocol}". The same question produces different distributions on the two ` +
      `wires, so the comparison would be meaningless. Re-collect the reference over ` +
      `"${runProtocol}", or run this endpoint over "${ref}".`);
  }
  return runProtocol;
}
