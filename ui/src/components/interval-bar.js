// The confidence interval, as the primary reading — not a number with an error bar
// bolted on.
//
// 🔴 This is a deliberate design position, and it is the project's position. L2 does not
// ask "is the ratio above the line", it asks "is the WHOLE interval above the line", in
// both directions. That rule exists because the old asymmetric one — convict on a point
// estimate, acquit only on an interval — wrote up two runs of the same endpoint an hour
// apart as "suspect" and "inconclusive" when they differed by one sample.
//
// A big number in the middle of the page would undo that in the reader's head. So the bar
// IS the reading: a span, two lines, and whether the span clears them.

import { h, s, fmt } from '../ui/dom.js';

/**
 * @param {object} o
 * @param {number} o.lo,o.hi,o.point   the 90% interval and its point estimate
 * @param {number} o.threshold         the line this test is judged against
 * @param {'below'|'above'} o.direction  which side the WHOLE interval must be on to pass
 * @param {boolean} o.passed
 * @param {string} o.title,o.thresholdLabel,o.passLabel
 */
export function intervalBar({ lo, hi, point, threshold, direction, passed, title, subtitle,
                              thresholdLabel, tone = 'ok' }) {
  const finite = [lo, hi, point, threshold].every(Number.isFinite);
  if (!finite) {
    return h('div.ci', h('div.ci-title', title), h('div.ci-empty', '这一项没有算出区间'));
  }

  // Leave the threshold visibly inside the axis even when the interval sits far from it —
  // an interval drawn hard against the edge reads as "off the chart", which is a different
  // claim from "comfortably clear".
  const hiEnd = Math.max(hi, threshold, point) * 1.18;
  const max = Math.max(hiEnd, threshold * 1.45);
  const x = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const width = `${Math.max(0.8, Math.min(100, ((hi - lo) / max) * 100))}%`;

  const state = passed ? tone : 'idle';

  return h('div.ci', { dataset: { state } },
    h('div.ci-head',
      h('div.ci-title', title),
      subtitle && h('div.ci-sub', subtitle)),
    h('div.ci-track',
      h('div.ci-axis'),
      // The pass region, so "which side is good" is visible without reading the caption.
      h('div.ci-region', {
        style: direction === 'below'
          ? { left: '0%', width: x(threshold) }
          : { left: x(threshold), right: '0' },
      }),
      h('div.ci-line', { style: { left: x(threshold) } }),
      h('div.ci-span', { style: { left: x(lo), width } }),
      h('div.ci-point', { style: { left: x(point) } })),
    // 🔴 The axis ends are labelled with the AXIS, not with the interval. Putting `lo` at
    // x=0 and `hi` at x=100% reads as "the axis runs 2.64 to 4.90", which is a different
    // and much less alarming picture than an interval sitting far up a 0-based scale. The
    // interval's own numbers are in the readout below, where they cannot be mistaken for
    // the scale.
    h('div.ci-scale',
      h('span.ci-lo', '0'),
      h('span.ci-mid', { style: { left: x(threshold) } },
        h('span.ci-mid-num', fmt(threshold, 1)),
        h('span.ci-mid-label', thresholdLabel)),
      h('span.ci-hi', fmt(max, 1))),
    h('div.ci-read',
      h('strong', `90% 区间 [${fmt(lo, 2)}, ${fmt(hi, 2)}]`),
      ' · 点估计 ', fmt(point, 2), ' · ',
      passed
        ? h('span.ci-verdict', `整段${direction === 'below' ? '在线下' : '在线上'}`)
        : h('span.ci-verdict.is-idle', `${direction === 'below' ? '上界越过了线' : '下界够不到线'}`)));
}

/**
 * A one-dimensional distance readout with the noise floor marked — used wherever a raw
 * JSD is shown without a control to calibrate it.
 *
 * 🔴 A distance with no floor beside it is unreadable: 0.18 is enormous or trivial
 * depending on how noisy the measurement was, and nothing on screen says which.
 */
export function distanceBar({ value, floor, max = 0.5, label, tone }) {
  const w = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const inside = Number.isFinite(value) && Number.isFinite(floor) && value <= floor;
  return h('div.dbar', { dataset: { tone: tone ?? (inside ? 'same' : 'diff') } },
    label && h('div.dbar-label', label),
    h('div.dbar-track',
      h('div.dbar-floor', { style: { width: w(floor) }, title: `噪声地板 ${fmt(floor)}` }),
      h('div.dbar-fill', { style: { width: w(value) } })),
    h('div.dbar-value', fmt(value), inside ? h('span.dbar-tag', '地板内') : null));
}

/** Small inline SVG sparkline of one endpoint's distance over time. */
export function sparkline(points, { width = 180, height = 34, threshold = null } = {}) {
  const vals = points.map((p) => p.value).filter(Number.isFinite);
  if (vals.length < 2) return h('div.spark-empty', '需要至少两次测量');
  const max = Math.max(...vals, threshold ?? 0) * 1.15 || 1;
  const step = width / (points.length - 1);
  const y = (v) => height - (v / max) * height;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  return s('svg.spark', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' },
    threshold != null && Number.isFinite(threshold) &&
      s('line', { x1: 0, x2: width, y1: y(threshold), y2: y(threshold), class: 'spark-threshold' }),
    s('path', { d, class: 'spark-line' }),
    ...points.map((p, i) => s('circle', {
      cx: (i * step).toFixed(1), cy: y(p.value).toFixed(1), r: 2.5,
      class: `spark-dot is-${p.verdict ?? 'na'}`,
    })));
}
