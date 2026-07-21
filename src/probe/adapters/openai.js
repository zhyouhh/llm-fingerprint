// OpenAI-compatible chat adapter.
//
// Request shape is pinned to upstream's `run/lib.js`: temperature, max_tokens=16 and
// `reasoning:{enabled:false}` must match the reference collection or our fingerprints
// are not comparable with the published database. Do not "improve" these defaults.
//
// `reasoning:{enabled:false}` is a request, not a guarantee — several gateways ignore
// it. The returned `reasoning_tokens` is therefore reported upward so the caller can
// gate on it (see src/probe/runner.js).

/** Upstream's fixed request parameters. Changing these breaks comparability. */
export const PROBE_PARAMS = { max_tokens: 16, temperature: 1 };

/**
 * @param {object} cfg
 * @param {string} cfg.endpoint base URL, e.g. https://host/v1
 * @param {string} cfg.apiKey
 * @param {number} [cfg.timeoutMs]
 * @returns {(args: {model: string, system: string, user: string, temperature?: number}) => Promise<object>}
 */
export function createOpenAIAdapter({ endpoint, apiKey, timeoutMs = 90_000 }) {
  const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;

  return async function ask({ model, system, user, temperature = PROBE_PARAMS.temperature }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature,
          max_tokens: PROBE_PARAMS.max_tokens,
          reasoning: { enabled: false },
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        // 4xx other than 429 are permanent for this cell; retrying wastes quota.
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      const j = JSON.parse(text);
      const choice = j.choices?.[0];
      return {
        raw: choice?.message?.content ?? '',
        finish_reason: choice?.finish_reason ?? null,
        model_reported: j.model ?? null,
        reasoning_len: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        usage: j.usage ?? null,
        latency_ms: Date.now() - t0,
      };
    } catch (e) {
      if (e.name === 'AbortError') { const x = new Error('timeout'); x.retryable = true; throw x; }
      if (e.retryable === undefined) e.retryable = true; // network/parse → transient
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}
