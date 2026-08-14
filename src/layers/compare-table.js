// Cross-endpoint comparison table.
//
// 决策 #14 — separate columns, no weighted total. A single "score" would need weights,
// and the only person those weights could come from is the one reading the table. So the
// dimensions stay apart and the sort key is switchable.
//
// 🔴 Authenticity sorts first by default, and the order below is total: every value a
// row can hold has a position, including the two that are not verdicts at all.

import { COMPARE_SORT_ORDER, ROW_STATE, VERDICT } from '../contracts.js';

export const COLUMNS = Object.freeze([
  'endpoint', 'authenticity', 'distance', 'reasoning', 'latency_p50',
  'response_rate', 'injection', 'kind', 'low_conf', 'probes', 'attempts',
]);

const rank = (v) => {
  const i = COMPARE_SORT_ORDER.indexOf(v);
  return i === -1 ? COMPARE_SORT_ORDER.length : i;
};

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * Fold every result file for one endpoint into one row.
 *
 * @param {{endpointId, l0?, l1?, l2?, reasoning?, skipped?, reason?}} args
 */
export function buildRow({ endpointId, l0 = null, l1 = null, l2 = null, reasoning = null, skipped = false, reason = null }) {
  if (skipped) {
    return {
      endpoint: endpointId, authenticity: ROW_STATE.SKIPPED, note: reason,
      distance: null, reasoning: 'not_run', latency_p50: null, response_rate: null,
      injection: null, kind: null, low_conf: false, probes: 0, attempts: 0,
    };
  }

  // 🔴 L2 wins when present — it is the only layer that separates harness from model.
  // L1's verdict is a screen, and a screen that has been superseded must not outrank
  // the calibrated answer it triggered.
  const top = l2 ?? l1;
  let authenticity = top?.result?.verdict ?? null;
  // fingerprint_unavailable comes ONLY from the fingerprint layers actually failing, never
  // inferred from L0 profiling (I-16: /models says nothing about /chat/completions).
  if (authenticity === VERDICT.NOT_APPLICABLE) authenticity = ROW_STATE.FINGERPRINT_UNAVAILABLE;

  const distance = l2
    ? (Number.isFinite(l2.result.ratio) ? `S/H ${l2.result.ratio.toFixed(2)}` : null)
    : (Number.isFinite(l1?.result?.s_screen) ? `S ${l1.result.s_screen.toFixed(4)}` : null);

  // 🔴 Summed across every layer this endpoint actually ran, not read off the top one:
  // reading l1 alone shows 15 where 41 were spent.
  const parts = [l0, l1, l2, reasoning].filter(Boolean);
  const probes = parts.reduce((s, p) => s + (p.meta?.probes ?? 0), 0);
  const attempts = parts.reduce((s, p) => s + (p.meta?.http_attempts ?? 0), 0);

  const latencySource = top ?? l0;
  const rates = l2 ? l2.result.subject : l1?.result;

  return {
    endpoint: endpointId,
    authenticity: authenticity ?? ROW_STATE.SKIPPED,
    distance,
    // Blank would read as "fine"; the two tiers never run reasoning probes, so say so.
    reasoning: reasoning?.result?.verdict ?? 'not_run',
    latency_p50: median((latencySource?.samples ?? []).map((s) => s.latency_ms)),
    response_rate: rates?.response_rate ?? null,
    injection: l0?.result?.l0b?.injection_tokens ?? null,
    kind: l0?.result?.l0a?.endpoint_kind ?? null,
    low_conf: l2?.result?.low_confidence === true,
    probes, attempts,
    source: l2 ? 'l2' : (l1 ? 'l1' : 'l0'),
  };
}

/** @param {string} [sortBy] column name; defaults to authenticity */
export function sortRows(rows, sortBy = 'authenticity') {
  const copy = [...rows];
  if (sortBy === 'authenticity') {
    // low_confidence never changes position — it is an annotation, not a verdict.
    return copy.sort((a, b) => rank(a.authenticity) - rank(b.authenticity) || a.endpoint.localeCompare(b.endpoint));
  }
  return copy.sort((a, b) => {
    const [x, y] = [a[sortBy], b[sortBy]];
    if (x == null && y == null) return a.endpoint.localeCompare(b.endpoint);
    if (x == null) return 1;
    if (y == null) return -1;
    return typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
  });
}

export function renderTable(rows) {
  const mark = {
    [VERDICT.CONSISTENT]: '✅', [VERDICT.SUSPECT]: '🔴',
    [VERDICT.INCONCLUSIVE]: '⚠️ ', [VERDICT.NOT_APPLICABLE]: '✗ ',
    [ROW_STATE.FINGERPRINT_UNAVAILABLE]: '✗ ', [ROW_STATE.SKIPPED]: '– ',
  };
  const head = ['endpoint', 'authenticity', 'distance', 'reasoning', 'p50', 'resp', 'inject', 'kind', 'probes'];
  const body = rows.map((r) => [
    r.endpoint,
    `${mark[r.authenticity] ?? '? '}${r.authenticity}${r.low_conf ? '†' : ''} (${r.source})`,
    r.distance ?? '—',
    r.reasoning,
    r.latency_p50 != null ? `${Math.round(r.latency_p50)}ms` : '—',
    r.response_rate != null ? `${(r.response_rate * 100).toFixed(0)}%` : '—',
    r.injection != null ? `~${r.injection}` : '—',
    r.kind ?? '—',
    `${r.probes}/${r.attempts}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(head), widths.map((w) => '─'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
