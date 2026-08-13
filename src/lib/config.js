// Endpoint configuration loader — the ONLY place that reads config/endpoints.json
// and turns an `auth_env` name into an actual key.
//
// Every CLI takes `--endpoint <id>`; without a single loader each script would carry
// its own copy of "parse the file / look up the id / build the env var name / decide
// what missing key means", and those copies drift.
//
// 🔴 The endpoint objects handed out here NEVER carry the key. Keys come back from
// resolveKey() separately, so an endpoint object can be serialised into a result file
// without leaking anything.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, usageError } from './errors.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'endpoints.json');
const DEFAULT_ENV_PATH = path.join(REPO_ROOT, '.env');

const PROTOCOLS = Object.freeze(['responses', 'chat']);
const REQUIRED_FIELDS = Object.freeze(['id', 'name', 'base_url', 'protocol', 'auth_env']);

let envLoaded = false;

/**
 * Load `.env` into process.env if present. Idempotent, and never overwrites a variable
 * that is already set (an explicit `export` beats the file).
 *
 * Node's built-in loader, so this stays dependency-free.
 */
export function loadEnv({ envPath = DEFAULT_ENV_PATH, force = false } = {}) {
  if (envLoaded && !force) return false;
  envLoaded = true;
  if (!existsSync(envPath)) return false;
  process.loadEnvFile(envPath);
  return true;
}

function validate(ep, index, seen) {
  const where = `endpoints[${index}]`;
  for (const field of REQUIRED_FIELDS) {
    if (typeof ep?.[field] !== 'string' || ep[field].trim() === '') {
      usageError(`${where}: "${field}" is required and must be a non-empty string`);
    }
  }
  if (!PROTOCOLS.includes(ep.protocol)) {
    usageError(`${where}: protocol must be one of ${PROTOCOLS.join(' | ')}, got ${JSON.stringify(ep.protocol)}`);
  }
  if (seen.has(ep.id)) usageError(`duplicate endpoint id: ${JSON.stringify(ep.id)}`);
  seen.add(ep.id);

  // baseUrl carries the version segment (".../v1"); everything is joined straight onto
  // it, so a trailing slash would produce "//chat/completions".
  if (ep.base_url.endsWith('/')) {
    usageError(`${where}: base_url must not end with "/" (got ${ep.base_url})`);
  }
  if (!/^https?:\/\//.test(ep.base_url)) {
    usageError(`${where}: base_url must be an absolute http(s) URL (got ${ep.base_url})`);
  }
  for (const role of ['subject', 'control']) {
    const model = ep.models?.[role];
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
      usageError(`${where}: models.${role} must be a non-empty string when present`);
    }
  }
  // A key that made it into the config file instead of the environment is exactly the
  // mistake this whole indirection exists to prevent — fail loudly rather than run.
  for (const [k, v] of Object.entries(ep)) {
    if (typeof v === 'string' && /^sk-|^Bearer\s/i.test(v)) {
      usageError(`${where}: field "${k}" looks like an API key. Keys belong in the environment; ` +
                 `config/endpoints.json only names the variable via "auth_env"`);
    }
  }
}

/** Freeze an endpoint into the shape handed to callers. Deliberately key-free. */
function normalise(ep) {
  return Object.freeze({
    id: ep.id,
    name: ep.name,
    base_url: ep.base_url,
    origin: new URL(ep.base_url).origin,
    protocol: ep.protocol,
    auth_env: ep.auth_env,
    models: Object.freeze({ subject: ep.models?.subject ?? null, control: ep.models?.control ?? null }),
    notes: ep.notes ?? '',
  });
}

/** @returns {ReadonlyArray<object>} all configured endpoints, in file order. */
export function loadEndpoints({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  if (!existsSync(configPath)) {
    usageError(`endpoint config not found: ${configPath}\n` +
               `Copy config/endpoints.example.json to config/endpoints.json and fill it in.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    usageError(`endpoint config is not valid JSON (${configPath}): ${err.message}`);
  }
  if (!Array.isArray(parsed?.endpoints)) {
    usageError(`endpoint config must have an "endpoints" array (${configPath})`);
  }
  const seen = new Set();
  parsed.endpoints.forEach((ep, i) => validate(ep, i, seen));
  return Object.freeze(parsed.endpoints.map(normalise));
}

/** Look one up by id. Unknown id is a usage error (exit code 2), not a crash. */
export function getEndpoint(id, opts = {}) {
  if (typeof id !== 'string' || id.trim() === '') {
    usageError('--endpoint <id> is required');
  }
  const all = loadEndpoints(opts);
  const found = all.find((e) => e.id === id);
  if (!found) {
    usageError(`unknown endpoint id: ${JSON.stringify(id)}. Known ids: ${all.map((e) => e.id).join(', ') || '(none)'}`);
  }
  return found;
}

/**
 * Resolve the key for an endpoint.
 *
 * 🔴 A missing key is NOT an error — `compare.js` must be able to skip that row and
 * keep going (acceptance scenario 4). The caller decides what to do with `available`.
 *
 * @returns {{available: boolean, key?: string, auth_env: string, reason?: string}}
 */
export function resolveKey(endpoint, env = null) {
  const source = env ?? (loadEnv(), process.env);
  const value = source[endpoint.auth_env];
  if (typeof value !== 'string' || value.trim() === '') {
    return Object.freeze({
      available: false,
      auth_env: endpoint.auth_env,
      reason: `environment variable ${endpoint.auth_env} is not set`,
    });
  }
  return Object.freeze({ available: true, key: value, auth_env: endpoint.auth_env });
}

/**
 * Endpoints paired with key availability, for `compare.js`-style batch runs.
 * @returns {Array<{endpoint: object, key: string|null, skipped: boolean, reason?: string}>}
 */
export function listWithKeys(opts = {}) {
  return loadEndpoints(opts).map((endpoint) => {
    const k = resolveKey(endpoint, opts.env ?? null);
    return k.available
      ? { endpoint, key: k.key, skipped: false }
      : { endpoint, key: null, skipped: true, reason: k.reason };
  });
}

export { UsageError, DEFAULT_CONFIG_PATH, PROTOCOLS };
