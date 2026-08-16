// Path-rewriting proxy — the pure half, so it can be tested without a runtime.
//
// The browser is the engine here; this only exists because a relay will not send CORS
// headers and because L0 needs to READ the upstream response headers, which a cross-origin
// fetch would hide. Both problems disappear if the probe URL is same-origin.
//
//   given  https://llmfingerprint.z0y0h.work/p/relay.com/v1/responses
//   fetch  https://relay.com/v1/responses
//
// 🔴 Shaped as a path rewrite rather than a "forward this JSON envelope" API on purpose:
// src/probe/http/{transport,chat,responses,get}.js then need no browser-specific branch.
// They build a URL from a baseUrl and send it, exactly as they do under Node. The frozen
// request body (I-1) stays frozen because nothing re-serialises it on the way through.

/** Only the four paths this tool actually probes. Suffix match — relays mount /v1 anywhere. */
export const ALLOWED_SUFFIXES = Object.freeze([
  '/responses',
  '/chat/completions',
  '/models',
  '/api/status',
  '/messages',          // Anthropic-shaped relays: L0 can still profile them
]);

/** Dropped from the upstream response: the body was already decoded on the way through. */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'set-cookie2', 'alt-svc',
]);

/**
 * 🔴 Request headers are allow-listed, not deny-listed. A deny list leaks whatever the
 * browser adds next (Sec-CH-UA, Cookie on a future same-site change, the visitor's
 * Referer) to a third-party relay the visitor merely wanted measured. Three headers is
 * all a probe needs.
 */
const FORWARD_REQUEST_HEADERS = new Set(['authorization', 'content-type', 'accept']);

/** Probe bodies are a few hundred bytes; the injection probe's is ~1KB. */
export const MAX_BODY_BYTES = 64 * 1024;

export class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Reject hostnames that are not a public name.
 *
 * Workers' fetch already cannot reach RFC1918 space — it egresses to the public internet —
 * so this is belt to that braces: it turns a misconfiguration into a clear 400 instead of
 * an opaque upstream failure, and it keeps the endpoint from being pointed at link-local
 * metadata addresses if that ever changes.
 */
export function assertHostAllowed(hostport, { allowLocal = false } = {}) {
  if (!hostport) throw new ProxyError(400, 'missing target host');
  if (hostport.startsWith('[')) throw new ProxyError(400, 'IPv6 literals are not accepted — use a hostname');

  const colon = hostport.lastIndexOf(':');
  const host = (colon > 0 ? hostport.slice(0, colon) : hostport).toLowerCase();
  const port = colon > 0 ? hostport.slice(colon + 1) : '';

  if (port && !/^\d{1,5}$/.test(port)) throw new ProxyError(400, `bad port in ${hostport}`);
  if (!host) throw new ProxyError(400, 'missing target host');
  if (allowLocal && (host === 'localhost' || host === '127.0.0.1')) return hostport;
  if (IPV4.test(host)) throw new ProxyError(400, 'IP literals are not accepted — use a hostname');
  if (!host.includes('.')) throw new ProxyError(400, `not a public hostname: ${host}`);
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost') ||
      host.endsWith('.home.arpa') || host === 'localhost') {
    throw new ProxyError(400, `not a public hostname: ${host}`);
  }
  return hostport;
}

/**
 * Is this Worker being served from a developer's machine?
 *
 * 🔴 Derived from the INBOUND host, not from an env var or a build flag. A flag can be set
 * in production by accident; the inbound host cannot — a request that arrived at
 * llmfingerprint.z0y0h.work was not served by `vite dev`. This is what lets the local stub
 * relay be exercised end to end (ui/scripts/stub-relay.js) without ever loosening the
 * deployed proxy, which matters because the alternative is testing the run flow by
 * spending real probes against a real relay.
 */
export function isLocalDeployment(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/**
 * Turn an inbound request URL into the upstream URL.
 *
 * @param {URL} url        the inbound request URL
 * @param {string} [selfHost]  this deployment's own hostname, refused as a target so the
 *                             proxy cannot be pointed at itself into a loop
 * @returns {URL}
 */
export function resolveTarget(url, selfHost) {
  const prefix = '/p/';
  if (!url.pathname.startsWith(prefix)) throw new ProxyError(404, 'not a proxy path');

  // Not decoded: url.pathname keeps percent-encoding, and re-encoding it here would be a
  // second chance to change the bytes the relay sees.
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new ProxyError(400, 'proxy path is /p/<host>/<path>');

  const local = isLocalDeployment(url.hostname);
  const hostport = assertHostAllowed(decodeURIComponent(rest.slice(0, slash)), { allowLocal: local });
  const upstreamPath = rest.slice(slash);

  if (selfHost && hostport.split(':')[0].toLowerCase() === selfHost.toLowerCase()
      && hostport === url.host) {
    throw new ProxyError(400, 'refusing to proxy to this deployment');
  }
  if (!ALLOWED_SUFFIXES.some((s) => upstreamPath === s || upstreamPath.endsWith(s))) {
    throw new ProxyError(403, `only ${ALLOWED_SUFFIXES.join(', ')} may be proxied — got ${upstreamPath}`);
  }

  // http only for the local stub; every deployed target is https, since the key rides on it.
  const scheme = local && /^(localhost|127\.0\.0\.1)(:|$)/.test(hostport) ? 'http' : 'https';
  const target = new URL(`${scheme}://${hostport}${upstreamPath}${url.search}`);
  // new URL() normalises ../ segments; if that moved us off the host we parsed, stop.
  if (target.host.toLowerCase() !== hostport.toLowerCase()) {
    throw new ProxyError(400, 'target path escapes its host');
  }
  return target;
}

/** @returns {Headers} the allow-listed subset to send upstream. */
export function forwardRequestHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/**
 * @returns {Headers} the upstream response headers, minus the ones that describe a
 *   transfer encoding we have already undone. Everything else passes through — the
 *   endpoint profile reads x-oneapi-request-id / x-cpa-* straight off this.
 */
export function forwardResponseHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}
