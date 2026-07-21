// Pairwise model distances and split-half verification trials.
//
// Mirrors upstream `stats/03-divergence.js` (MIT).
//
// Split-half rationale: to ask "does this probe match this reference?" honestly, the
// reference and the probe must be *different samples*. Upstream splits each cell's
// repetitions by rep parity — even reps form half A (reference), odd reps form half B
// (probe). Parity is time-independent, so no drift leaks across the split.
import { jsd, toDist, MIN_N } from './jsd.js';

/**
 * Mean pairwise JSD matrix over the models' full-sample distributions.
 *
 * @param {object[]} cells distributions.json-style records
 * @param {object} opts
 * @param {Set<string>} opts.tasks   study-A task ids
 * @param {Set<string>} opts.included model ids in the curated census
 * @returns {{models: string[], matrix: (number|null)[][]}}
 */
export function meanDivergenceMatrix(cells, { tasks, included }) {
  const models = [...new Set(cells.map((d) => d.model))].filter((m) => included.has(m)).sort();

  const byCell = new Map(); // task|lang -> Map(model -> dist)
  for (const d of cells) {
    if (d.n_valid < MIN_N || !tasks.has(d.task_id)) continue;
    const k = `${d.task_id}|${d.lang}`;
    if (!byCell.has(k)) byCell.set(k, new Map());
    byCell.get(k).set(d.model, d.dist);
  }

  const sums = new Map(), cnts = new Map();
  for (const dists of byCell.values()) {
    for (const a of models) {
      const da = dists.get(a);
      if (!da) continue;
      for (const b of models) {
        if (a >= b) continue;
        const db = dists.get(b);
        if (!db) continue;
        const k = `${a}||${b}`;
        sums.set(k, (sums.get(k) ?? 0) + jsd(da, db));
        cnts.set(k, (cnts.get(k) ?? 0) + 1);
      }
    }
  }

  const matrix = models.map((a) => models.map((b) => {
    if (a === b) return 0;
    const k = a < b ? `${a}||${b}` : `${b}||${a}`;
    return cnts.get(k) ? +(sums.get(k) / cnts.get(k)).toFixed(4) : null;
  }));
  return { models, matrix };
}

/**
 * Split-half genuine / impostor trials, one score per (ref, probe, cell).
 *
 * @param {Iterable<object>} records normalised records at temperature 1
 * @param {object[]} cells distributions.json-style records (used to enumerate cells)
 * @param {object} opts
 * @param {Set<string>} opts.tasks
 * @param {Set<string>} opts.included
 * @returns {Array<{ref: string, probe: string, task_id: string, lang: string, jsd: number, genuine: boolean}>}
 */
export function splitHalfScores(records, cells, { tasks, included }) {
  const models = [...new Set(cells.map((d) => d.model))].filter((m) => included.has(m)).sort();

  const halves = new Map(); // model|task|lang|half -> counts
  for (const r of records) {
    if (r.temperature !== 1 || r.answer_class !== 'valid') continue;
    const half = r.rep % 2 === 0 ? 'A' : 'B';
    const k = `${r.model}|${r.task_id}|${r.lang}|${half}`;
    const c = halves.get(k) ?? {};
    c[r.normalized] = (c[r.normalized] ?? 0) + 1;
    halves.set(k, c);
  }
  // A half needs only MIN_N/2 samples — it holds half the reps by construction.
  const half = (model, task, lang, side) => toDist(halves.get(`${model}|${task}|${lang}|${side}`) ?? {}, MIN_N / 2);

  const cellsList = [...new Set(
    cells.filter((d) => d.n_valid >= MIN_N && tasks.has(d.task_id)).map((d) => `${d.task_id}|${d.lang}`)
  )];

  const scores = [];
  for (const cell of cellsList) {
    const [task, lang] = cell.split('|');
    for (const ref of models) {
      const refD = half(ref, task, lang, 'A');
      if (!refD) continue;
      for (const probe of models) {
        const probeD = half(probe, task, lang, 'B');
        if (!probeD) continue;
        scores.push({
          ref, probe, task_id: task, lang,
          jsd: +jsd(refD, probeD).toFixed(4),
          genuine: ref === probe,
        });
      }
    }
  }
  return scores;
}
