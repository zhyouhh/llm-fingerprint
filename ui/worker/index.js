// The entire server side of this project.
//
// It proxies probe requests and serves static files. It does not judge, does not store,
// and — the point of the whole architecture — has nowhere to put an API key even if it
// wanted one: no KV, no D1, no Durable Object, no cache of request bodies. The visitor's
// key exists in their tab and in the Authorization header of one in-flight request.
//
// 🔴 Nothing here may start logging URLs, bodies or headers. `console.log` output goes to
// Workers observability, which is storage. Status code and duration only.

import { resolveTarget, forwardRequestHeaders, forwardResponseHeaders, ProxyError, MAX_BODY_BYTES } from './proxy.js';

/** Probes are slow by nature (a reasoning model at effort:none still thinks a little). */
const UPSTREAM_TIMEOUT_MS = 100_000;

function errorResponse(status, message) {
  // Shaped like an OpenAI error so src/probe/http/transport.js classifies it through the
  // same path as a real upstream refusal, instead of falling back to `http_<status>`.
  return Response.json({ error: { message, type: 'llmfp_proxy_error', code: `proxy_${status}` } },
    { status, headers: { 'cache-control': 'no-store' } });
}

async function proxy(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorResponse(405, 'only GET and POST are proxied');
  }

  const target = resolveTarget(url, url.hostname);

  let body;
  if (request.method === 'POST') {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, `probe bodies are capped at ${MAX_BODY_BYTES} bytes`);
    }
  }

  // Optional: present only when the ratelimit binding is configured. Keyed on the client
  // IP so one visitor cannot spend the whole deployment's budget. A visitor running a full
  // L2 issues ~870 requests over several minutes, so the limit has to sit well above a
  // per-minute reading of that.
  if (env.PROXY_LIMIT) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.PROXY_LIMIT.limit({ key: ip });
    if (!success) return errorResponse(429, 'too many probe requests from this address — slow down and retry');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: forwardRequestHeaders(request.headers),
      body,
      signal: controller.signal,
      redirect: 'manual',   // a relay redirecting us elsewhere is not a relay we measured
    });
    const headers = forwardResponseHeaders(upstream.headers);
    headers.set('cache-control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (err) {
    // 502/504 rather than a thrown exception: transport.js retries these, and a Worker
    // exception would surface as an opaque 1101 the classifier cannot read.
    const timedOut = err?.name === 'AbortError';
    return errorResponse(timedOut ? 504 : 502,
      timedOut ? `upstream did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s` : `could not reach upstream: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/p/')) {
      try {
        return await proxy(request, env, url);
      } catch (err) {
        if (err instanceof ProxyError) return errorResponse(err.status, err.message);
        return errorResponse(500, 'proxy failure');
      }
    }

    // Everything else is the single-page app. run_worker_first pins /p/* to this Worker,
    // so reaching here means the asset router already declined it.
    return env.ASSETS.fetch(request);
  },
};
