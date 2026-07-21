// Verification protocol: ROC / AUC / EER for "is this endpoint really model X?".
//
// Reimplements upstream `stats/R/12-verification-roc.R` in plain JS so the tool has
// no R dependency. Both functions are pinned by `test/golden/g2-verification.test.js`
// against upstream's published AUC (0.971342) and EER (0.07282).
//
// Convention: the score is a JSD, so GENUINE pairs score LOW. In pROC terms this is
// `direction = ">"` with controls (impostors) above cases (genuine).

/**
 * Area under the ROC curve, computed as the Mann-Whitney U statistic with half
 * credit for ties. Exactly equals pROC's default `auc()` and, unlike trapezoidal
 * integration over sampled thresholds, involves no discretisation choice.
 *
 * @param {Array<{score: number, genuine: boolean}>} trials
 * @returns {number} AUC in [0, 1]
 */
export function auc(trials) {
  const cases = trials.filter((t) => t.genuine).map((t) => t.score).sort((a, b) => a - b);
  const controls = trials.filter((t) => !t.genuine).map((t) => t.score).sort((a, b) => a - b);
  if (!cases.length || !controls.length) return NaN;

  // Count (control > case) pairs + 0.5 * ties, via binary search per case.
  let wins = 0;
  for (const c of cases) {
    // controls strictly greater than c  -> full credit
    // controls equal to c               -> half credit
    let lo = 0, hi = controls.length;
    while (lo < hi) { const m = (lo + hi) >> 1; controls[m] < c ? lo = m + 1 : hi = m; }
    const firstGE = lo;
    lo = 0; hi = controls.length;
    while (lo < hi) { const m = (lo + hi) >> 1; controls[m] <= c ? lo = m + 1 : hi = m; }
    const firstGT = lo;
    wins += (controls.length - firstGT) + 0.5 * (firstGT - firstGE);
  }
  return wins / (cases.length * controls.length);
}

/**
 * Equal error rate: the operating point where the false-accept and false-reject
 * rates meet.
 *
 * Threshold grid follows pROC's default: midpoints between consecutive unique
 * predictor values, bracketed by ±Infinity. A genuine verdict is issued when
 * `score < threshold`.
 *
 * @param {Array<{score: number, genuine: boolean}>} trials
 * @returns {{eer: number, threshold: number}}
 */
export function eer(trials) {
  const nCase = trials.filter((t) => t.genuine).length;
  const nControl = trials.length - nCase;
  if (!nCase || !nControl) return { eer: NaN, threshold: NaN };

  const uniq = [...new Set(trials.map((t) => t.score))].sort((a, b) => a - b);
  const thresholds = [-Infinity];
  for (let i = 1; i < uniq.length; i++) thresholds.push((uniq[i - 1] + uniq[i]) / 2);
  thresholds.push(Infinity);

  const sorted = [...trials].sort((a, b) => a.score - b.score);
  let best = { eer: NaN, threshold: NaN, gap: Infinity };
  let idx = 0, caseBelow = 0, controlBelow = 0;

  for (const t of thresholds) {
    while (idx < sorted.length && sorted[idx].score < t) {
      sorted[idx].genuine ? caseBelow++ : controlBelow++;
      idx++;
    }
    // predict genuine when score < t
    const sensitivity = caseBelow / nCase;           // true accept
    const specificity = 1 - controlBelow / nControl; // true reject
    const fpr = 1 - specificity;                     // impostor accepted
    const fnr = 1 - sensitivity;                     // genuine rejected
    const gap = Math.abs(fpr - fnr);
    // strict < keeps the FIRST minimum, matching R's which.min
    if (gap < best.gap) best = { eer: (fpr + fnr) / 2, threshold: t, gap };
  }
  return { eer: best.eer, threshold: best.threshold };
}

/**
 * Collapse per-cell scores into one trial score per (ref, probe) pair by averaging
 * over the chosen cells — upstream's `trial_scores()`.
 *
 * @param {Array<{ref: string, probe: string, task_id: string, lang: string, jsd: number, genuine: boolean}>} scores
 * @param {Set<string>|null} cellSubset cell keys `task|lang`; null = all cells
 * @returns {Array<{ref: string, probe: string, score: number, genuine: boolean}>}
 */
export function trialScores(scores, cellSubset = null) {
  const agg = new Map(); // ref|probe|genuine -> {sum, n}
  for (const s of scores) {
    if (cellSubset && !cellSubset.has(`${s.task_id}|${s.lang}`)) continue;
    const k = `${s.ref}|${s.probe}|${s.genuine}`;
    const e = agg.get(k) ?? { ref: s.ref, probe: s.probe, genuine: s.genuine, sum: 0, n: 0 };
    e.sum += s.jsd; e.n++;
    agg.set(k, e);
  }
  return [...agg.values()].map((e) => ({
    ref: e.ref, probe: e.probe, genuine: e.genuine, score: e.sum / e.n,
  }));
}
