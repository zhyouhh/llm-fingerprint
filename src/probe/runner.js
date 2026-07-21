// Sampling engine: run the probe battery against one endpoint.
//
// Emits records in upstream's responses.jsonl shape so they flow straight into the
// vendored normaliser and the G0-G2-verified statistics.
import { loadVendorConfig, studyATasks } from '../normalize/index.js';

/** Default quick battery: 4 tasks × 2 languages. Diverse in answer space and script. */
export const QUICK_CELLS = [
  ['num100-random', 'en'], ['num100-random', 'zh'],
  ['num10-random', 'en'], ['num10-random', 'zh'],
  ['color-random', 'en'], ['color-random', 'zh'],
  ['animal-random', 'en'], ['animal-random', 'zh'],
];

/** Build the full 40-cell study-A battery. */
export function fullCells(prompts) {
  const tasks = [...studyATasks(prompts)];
  return tasks.flatMap((t) => prompts.languages.map((l) => [t, l]));
}

async function withRetry(fn, { maxRetries = 4, baseMs = 1500 }) {
  let last;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!e.retryable || attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(baseMs * 2 ** attempt, 30_000)));
    }
  }
  throw last;
}

/**
 * Run the battery.
 *
 * @param {object} opts
 * @param {(a: object) => Promise<object>} opts.ask   adapter from src/probe/adapters
 * @param {string} opts.model
 * @param {Array<[string,string]>} opts.cells        [task_id, lang] pairs
 * @param {number} opts.reps                          samples per cell (upstream uses 30)
 * @param {number} opts.concurrency
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{records: object[], failures: object[], reasoningRate: number}>}
 */
export async function runBattery({ ask, model, cells, reps = 30, concurrency = 6, onProgress }) {
  const { prompts } = loadVendorConfig();
  const taskById = Object.fromEntries(prompts.tasks.map((t) => [t.id, t]));

  const jobs = [];
  for (const [task_id, lang] of cells) {
    const task = taskById[task_id];
    if (!task) throw new Error(`unknown task ${task_id}`);
    for (let rep = 0; rep < reps; rep++) jobs.push({ task_id, lang, rep, task });
  }

  const records = [], failures = [];
  let done = 0, reasoningSeen = 0, ok = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const system = prompts.system_prompts[job.lang];
      const user = job.task.prompts[job.lang];
      try {
        const r = await withRetry(() => ask({ model, system, user }), {});
        records.push({
          model, task_id: job.task_id, lang: job.lang, temperature: 1, rep: job.rep,
          provider: 'probe', raw: r.raw, finish_reason: r.finish_reason,
          model_reported: r.model_reported, reasoning_len: r.reasoning_len,
          latency_ms: r.latency_ms, usage: r.usage, error: null,
          key: `${model}|${job.task_id}|${job.lang}|1|${job.rep}`,
        });
        ok++;
        if (r.reasoning_len > 0) reasoningSeen++;
      } catch (e) {
        failures.push({ ...job, task: undefined, error: String(e.message) });
      }
      done++;
      if (onProgress && done % 10 === 0) onProgress({ done, total: jobs.length, ok, failed: failures.length });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { records, failures, reasoningRate: ok ? reasoningSeen / ok : 0 };
}
