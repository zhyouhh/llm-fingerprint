// Local history. IndexedDB, no server, no account.
//
// 🔴 What may be stored: the endpoint HOST, the model names, the verdict, the samples.
// What may never be stored: the API key, the Authorization header, anything derived from
// them. `assertNoSecret` is the enforcement, not the comment — the CLI has the same check
// on its result files and it exists because "no keys on disk" is a promise that has to be
// executable to be worth making.
//
// History is not a nice-to-have here. A rotating relay is sticky (all 15 reps of a cell
// land on one backend), so a single L2 is one draw from a lottery: one endpoint measured
// an hour apart came back genuine once and substituted once. The value of the web version
// over the CLI is largely that it keeps every draw and draws them on a timeline.

const DB_NAME = 'llm-fingerprint';
const DB_VERSION = 1;
export const STORE_RUNS = 'runs';
export const STORE_ACTIVE = 'active';

const SECRET = /\b(?:sk|xai|gsk)-[A-Za-z0-9_-]{6,}/;

/** Throws rather than scrubbing: a silent scrub hides the bug that produced the key. */
export function assertNoSecret(value, where) {
  if (SECRET.test(JSON.stringify(value ?? null))) {
    throw new Error(`refusing to store ${where}: it contains something shaped like an API key`);
  }
  return value;
}

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RUNS)) {
        const runs = db.createObjectStore(STORE_RUNS, { keyPath: 'id' });
        runs.createIndex('ts', 'ts');
        runs.createIndex('host', 'host');
        runs.createIndex('host_model', ['host', 'model']);
      }
      if (!db.objectStoreNames.contains(STORE_ACTIVE)) {
        db.createObjectStore(STORE_ACTIVE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Stable, sortable, and readable in an export filename. */
export function runId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} run {id, ts, host, baseUrl, model, control, tier, protocol, result, meta, samples}
 */
export async function saveRun(run) {
  assertNoSecret(run, 'this run');
  return tx(STORE_RUNS, 'readwrite', (s) => s.put(run));
}

export async function listRuns() {
  const all = await tx(STORE_RUNS, 'readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

export async function getRun(id) {
  return tx(STORE_RUNS, 'readonly', (s) => s.get(id));
}

export async function deleteRun(id) {
  return tx(STORE_RUNS, 'readwrite', (s) => s.delete(id));
}

export async function clearRuns() {
  return tx(STORE_RUNS, 'readwrite', (s) => s.clear());
}

/* ── the in-flight run ──────────────────────────────────────────────────────── */

/**
 * Samples land here as they arrive, so a tab closed mid-L2 does not throw away seven
 * minutes of probes — the partial run is still readable, exportable, and judgeable on
 * whatever cells did complete.
 */
export async function saveActive(active) {
  assertNoSecret(active, 'the in-flight run');
  return tx(STORE_ACTIVE, 'readwrite', (s) => s.put(active));
}

export async function loadActive() {
  const all = await tx(STORE_ACTIVE, 'readonly', (s) => s.getAll());
  return (all ?? [])[0] ?? null;
}

export async function clearActive() {
  return tx(STORE_ACTIVE, 'readwrite', (s) => s.clear());
}

/* ── import / export ────────────────────────────────────────────────────────── */

export const EXPORT_FORMAT = 'llm-fingerprint/runs@1';

export async function exportAll() {
  return { format: EXPORT_FORMAT, exported_utc: new Date().toISOString(), runs: await listRuns() };
}

/**
 * Why a record is unusable, or null when it is fine.
 *
 * 🔴 Checked HERE, at the door. The format/id check alone let a file through, said "imported
 * successfully", and the damage only appeared on the next page load — where a record whose
 * samples cannot be split into sides took the whole history view down with it, so the user
 * could not reach the list to delete the thing that broke it. Refusing at import is the
 * difference between "this file is no good" and "the app is broken".
 */
function importProblem(r) {
  if (!r?.id) return 'no id';
  if (r.tier === 'l0') return null;                       // L0 carries no fingerprint samples
  if (!Array.isArray(r.samples)) return 'no samples array';
  // The same rule `distributionOf` enforces: without a model or role on every row the two
  // sides cannot be told apart, and averaging them is how the page and the CLI came to
  // disagree about one file.
  if (r.samples.length && !r.samples.every((s) => s?.model != null || s?.role != null)) {
    return '样本行没有 model / role 标签，分不出待验侧和对照侧';
  }
  return null;
}

export async function importRuns(payload) {
  if (payload?.format !== EXPORT_FORMAT) {
    throw new Error(`不认识这个文件（format=${payload?.format ?? '缺失'}），期望 ${EXPORT_FORMAT}`);
  }
  const runs = Array.isArray(payload.runs) ? payload.runs : [];
  const rejected = [];
  let imported = 0;
  for (const r of runs) {
    const problem = importProblem(r);
    if (problem) { rejected.push({ id: r?.id ?? '(无 id)', problem }); continue; }
    await saveRun(r);
    imported += 1;
  }
  return { imported, rejected, total: runs.length };
}

/** Storage pressure is real: an L2 run carries ~870 samples. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used, quota } = await navigator.storage.estimate();
  return { used, quota };
}
