// Empirical answer distributions per model × task × language — the fingerprint itself.
//
// Mirrors upstream `stats/02-distributions.js` (MIT). The rounding is load-bearing:
// upstream stores `dist` probabilities at 4 decimals and entropy at 3, and the
// published reference database carries those rounded values. Reproducing them
// bit-for-bit is what lets our probes be compared against that database.

const entropy = (probs) => -probs.reduce((s, p) => s + (p > 0 ? p * Math.log2(p) : 0), 0);

/**
 * Aggregate normalised records into per-cell distributions.
 *
 * Only `answer_class === 'valid'` answers enter a distribution; everything else is
 * counted in `n_off_format` so validity stays visible.
 *
 * @param {Iterable<object>} records normalised records (see src/normalize)
 * @param {object} opts
 * @param {number} opts.temperature which sampling temperature to aggregate (default 1)
 * @returns {object[]} cell records shaped like upstream's distributions.json entries
 */
export function buildDistributions(records, { temperature = 1 } = {}) {
  const cells = new Map(); // model|task|lang -> accumulator
  for (const r of records) {
    if (r.temperature !== temperature) continue;
    const k = `${r.model}|${r.task_id}|${r.lang}`;
    let c = cells.get(k);
    if (!c) {
      c = { model: r.model, task_id: r.task_id, lang: r.lang, temperature: r.temperature, counts: {}, n: 0, off: 0 };
      cells.set(k, c);
    }
    if (r.answer_class === 'valid') {
      c.counts[r.normalized] = (c.counts[r.normalized] ?? 0) + 1;
      c.n++;
    } else c.off++;
  }

  const out = [];
  for (const c of cells.values()) {
    const entries = Object.entries(c.counts).sort((a, b) => b[1] - a[1]);
    const probs = entries.map(([, n]) => n / c.n);
    out.push({
      model: c.model, task_id: c.task_id, lang: c.lang, temperature: c.temperature,
      n_valid: c.n, n_off_format: c.off,
      validity_rate: +(c.n / (c.n + c.off)).toFixed(3),
      dist: Object.fromEntries(entries.map(([v, n]) => [v, +(n / c.n).toFixed(4)])),
      entropy_bits: +entropy(probs).toFixed(3),
      mode: entries[0]?.[0] ?? null,
      mode_share: entries[0] ? +(entries[0][1] / c.n).toFixed(3) : null,
    });
  }
  return out;
}

/**
 * Reshape a flat list of cell records into a fingerprint: cell key -> distribution.
 *
 * @param {object[]} cells
 * @param {object} opts
 * @param {Set<string>|null} opts.tasks restrict to these task ids (e.g. studyATasks)
 * @param {number} opts.minN drop cells with fewer valid samples
 * @returns {Record<string, Record<string, number>>}
 */
export function toFingerprint(cells, { tasks = null, minN = 10 } = {}) {
  const fp = {};
  for (const c of cells) {
    if (c.n_valid < minN) continue;
    if (tasks && !tasks.has(c.task_id)) continue;
    fp[`${c.task_id}|${c.lang}`] = c.dist;
  }
  return fp;
}
