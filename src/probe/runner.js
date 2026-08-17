// Sampling engine: run the fingerprint battery against one endpoint.
//
// Records keep upstream's responses.jsonl shape so they flow straight into the vendored
// normaliser and the G0-G2-verified statistics, with the contract's sample fields
// (kind / state / attempts) layered on top.
//
// 🔴 This layer does NOT retry. Retry lives inside the outbound client (判定语义⑥);
// two layers of three attempts is nine requests per probe, which would triple the
// per-endpoint ceiling the compliance table promises.
//
// 🔴 And because the client no longer throws, the failure path had to change with it.
// The old engine reached its failure branch via an exception; a client that returns
// `{error}` instead would have sailed straight down the success path, booking transport
// failures as completions — counted in `ok`, folded into n_valid, handed to the
// normaliser with raw:''. Deleting the retry without rewriting this branch is the one
// mistake in this file that would not announce itself.

// 🔴 core.js / vendor-config.js rather than normalize/index.js: index.js pulls in
// `node:fs` for the run-directory reader, which the browser build cannot bundle. The
// normalisation itself is identical — same module, one import hop shorter.
import { studyATasks, normalizeRecords } from '../normalize/core.js';
import { loadVendorConfig } from '../normalize/vendor-config.js';
import { SAMPLE_KIND, classifySample, makeSample, countersFromSamples } from '../contracts.js';

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

/**
 * Accept either upstream's [task_id, lang] pairs or the per-cell {task_id, lang, reps}
 * form the cell selector emits. Per-cell reps is the point: a battery that spends the
 * same number of samples on a zero-signal cell as on a discriminating one wastes a
 * quarter of its budget (决策 #4).
 */
export function normaliseCells(cells, defaultReps) {
  return cells.map((cell) => {
    const [task_id, lang, reps] = Array.isArray(cell)
      ? [cell[0], cell[1], defaultReps]
      : [cell.task_id, cell.lang, cell.reps ?? defaultReps];
    if (!task_id || !lang) throw new Error(`bad cell: ${JSON.stringify(cell)}`);
    if (!Number.isInteger(reps) || reps < 1) throw new Error(`bad reps for ${task_id}|${lang}: ${reps}`);
    return { task_id, lang, reps };
  });
}

/**
 * Run the battery.
 *
 * @param {object} opts
 * @param {(a: {model, system, user}) => Promise<object>} opts.probe  outbound chat probe
 * @param {string} opts.model
 * @param {Array} opts.cells           [task_id, lang] pairs or {task_id, lang, reps}
 * @param {number} [opts.reps]         default samples per cell when a cell omits it
 * @param {number} [opts.concurrency]
 * @param {string} [opts.role]         'subject' | 'control' — L2 keeps the sides apart
 * @returns {Promise<{samples, counters, reasoningRate}>}
 *   `samples` carries both the normalised fields and the contract fields, so callers
 *   need no second pass to find out what each sample was.
 */
export async function runBattery({ probe, model, cells, reps = 30, concurrency = 6, role = 'subject',
                                   applyReasoningTrace, onProgress }) {
  // 🔴 No default. The normalisation pass has to match whatever this run will be
  // compared against (reference/ was collected without it, the paper's database with
  // it), and a default would silently pick a side. Getting it wrong does not error —
  // it just voids the comparison, which is the worst possible failure mode here.
  if (typeof applyReasoningTrace !== 'boolean') {
    throw new Error('runBattery: applyReasoningTrace must be passed explicitly — ' +
      'false when comparing against reference/, true when ranking against the paper database');
  }
  const { prompts } = loadVendorConfig();
  const taskById = Object.fromEntries(prompts.tasks.map((t) => [t.id, t]));
  const plan = normaliseCells(cells, reps);

  const jobs = [];
  for (const { task_id, lang, reps: cellReps } of plan) {
    const task = taskById[task_id];
    if (!task) throw new Error(`unknown task ${task_id}`);
    for (let rep = 0; rep < cellReps; rep++) jobs.push({ task_id, lang, rep, task });
  }

  const raw = new Array(jobs.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      const job = jobs[index];
      const system = prompts.system_prompts[job.lang];
      const user = job.task.prompts[job.lang];
      const r = await probe({ model, system, user });   // never throws for transport

      raw[index] = {
        model, task_id: job.task_id, lang: job.lang, temperature: 1, rep: job.rep,
        provider: 'probe', role,
        // 🔴 raw stays '' on failure so the normaliser cannot mistake an error page for
        // an answer; `error` is what tells the two apart (判定语义③).
        raw: r.error ? '' : r.raw,
        error: r.error, http_status: r.http_status, attempts: r.attempts,
        latency_ms: r.latency_ms, rate_limited_ms: r.rate_limited_ms ?? 0, usage: r.usage,
        finish_reason: r.finish_reason, model_reported: r.model_reported,
        reasoning_len: r.reasoning_len ?? 0,
        key: `${model}|${job.task_id}|${job.lang}|1|${job.rep}`,
      };
      done++;
      // Every sample, not every tenth. An L1 screen is 15 probes, so a stride of 10 let
      // the web UI's live cell grid update exactly once; the CLI writers read only
      // {done, total, model} and ignore the rest, and a few hundred extra \r writes cost
      // nothing next to the requests they are reporting on.
      //
      // `ok` is transport-level only — whether the answer is VALID is decided by the
      // normalisation pass below, which cannot run sample by sample.
      if (onProgress) onProgress({ done, total: jobs.length, cell: `${job.task_id}|${job.lang}`, ok: !r.error });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // Normalise the whole batch at once: the post_reasoning pre-pass is per (model,
  // provider) across all records, so it cannot be decided sample by sample.
  const normalised = normalizeRecords(raw, { applyReasoningTrace });

  const samples = normalised.map((rec) => makeSample({
    ...rec,
    kind: SAMPLE_KIND.FINGERPRINT,
    state: classifySample(SAMPLE_KIND.FINGERPRINT, { error: rec.error, answer_class: rec.answer_class }),
    attempts: rec.attempts,
  }));

  // Reasoning pollution is measured over samples that actually came back — a dead
  // endpoint has no opinion on whether the model reasons.
  const responded = samples.filter((s) => s.state !== 'transport_failure');
  const reasoningSeen = responded.filter((s) => (s.reasoning_len ?? 0) > 0).length;

  return {
    samples,
    counters: countersFromSamples(samples),
    reasoningRate: responded.length ? reasoningSeen / responded.length : 0,
  };
}
