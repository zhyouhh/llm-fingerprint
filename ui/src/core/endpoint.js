// Turning what a person typed into the two URLs the probe layer wants.
//
// The probe layer is unchanged from the CLI: it builds `${baseUrl}/responses` and
// `${origin}/api/status` and fetches them. All the browser does is hand it same-origin
// paths that the Worker rewrites back.
//
//   typed     https://api.relay.com/v1
//   baseUrl   /p/api.relay.com/v1        →  /p/api.relay.com/v1/responses
//   origin    /p/api.relay.com           →  /p/api.relay.com/api/status

/** Most OpenAI-compatible relays mount the API here; shown to the user, never silent. */
export const CONVENTIONAL_PATH = '/v1';

export class EndpointError extends Error {}

/**
 * Normalise a typed base URL.
 *
 * @returns {{url: string, host: string, path: string, addedScheme: boolean, addedPath: boolean}}
 *   `url` is the canonical form to display back. The two `added*` flags exist so the UI
 *   can SHOW what it filled in — guessing silently is how someone ends up measuring a
 *   different endpoint than they think they are.
 */
export function normaliseBaseUrl(typed) {
  const trimmed = String(typed ?? '').trim();
  if (!trimmed) throw new EndpointError('输入中转的 Base URL');

  const addedScheme = !/^https?:\/\//i.test(trimmed);
  let parsed;
  try {
    parsed = new URL(addedScheme ? `https://${trimmed}` : trimmed);
  } catch {
    throw new EndpointError(`这不像一个 URL：${trimmed}`);
  }

  // Mirrors the proxy's own rule (worker/proxy.js isLocalDeployment): a page served from
  // localhost may target localhost, so the stub relay can be driven through the real UI.
  // Anywhere else, https only — the key travels on this connection.
  const pageHost = typeof location === 'undefined' ? '' : location.hostname;
  const devHost = /^(localhost|127\.0\.0\.1)$/i.test(pageHost);
  const localTarget = devHost && /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);

  if (parsed.protocol !== 'https:' && !localTarget) {
    throw new EndpointError('只支持 https —— API key 会走这条连接');
  }
  if (!parsed.hostname.includes('.') && !localTarget) {
    throw new EndpointError(`不是公网域名：${parsed.hostname}`);
  }

  let path = parsed.pathname.replace(/\/+$/, '');
  const addedPath = path === '';
  if (addedPath) path = CONVENTIONAL_PATH;

  return {
    url: `${localTarget ? parsed.protocol : 'https:'}//${parsed.host}${path}`,
    host: parsed.host,
    path,
    addedScheme,
    addedPath,
  };
}

/**
 * @param {string} normalisedUrl output of normaliseBaseUrl().url
 * @returns {{baseUrl: string, origin: string}} same-origin paths for the probe layer
 */
export function proxyPaths(normalisedUrl) {
  const u = new URL(normalisedUrl);
  return {
    baseUrl: `/p/${u.host}${u.pathname.replace(/\/+$/, '')}`,
    origin: `/p/${u.host}`,
  };
}
