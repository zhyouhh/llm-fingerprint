// Verdict presentation. One vocabulary, used everywhere a verdict appears.
//
// 🔴 Status is never colour alone — every verdict ships a glyph and a word (dataviz
// non-negotiable, and plain sense: the difference between "consistent" and "suspect" is
// the whole product).
//
// 🔴 `inconclusive` is not styled as a failure. It is the honest outcome when the evidence
// does not reach either line, and the tool is built to prefer it over a guess. Rendering
// it in warning amber would push readers to treat it as bad news and act on it.

import { h } from '../ui/dom.js';
import { VERDICT } from '../../../src/contracts.js';

export const VERDICT_META = Object.freeze({
  [VERDICT.CONSISTENT]: {
    tone: 'ok', glyph: '✓', label: '一致',
    gloss: '与正版参照的差距，用外壳差异和测量噪声就能解释完',
  },
  [VERDICT.SUSPECT]: {
    tone: 'bad', glyph: '✕', label: '疑似替换',
    gloss: '差距已经接近「换成另一个模型」的量级',
  },
  [VERDICT.INCONCLUSIVE]: {
    tone: 'unknown', glyph: '?', label: '证据不足',
    gloss: '差距落在两条线之间——这不是坏消息，是这次测量还不够分辨它',
  },
  [VERDICT.NOT_APPLICABLE]: {
    tone: 'na', glyph: '—', label: '方法不适用',
    gloss: '这个端点给不出单 token 补全，指纹无从谈起',
  },
});

export function verdictMeta(verdict) {
  return VERDICT_META[verdict] ?? { tone: 'na', glyph: '—', label: String(verdict ?? '未知'), gloss: '' };
}

/** The inline pill, for tables and history rows. */
export function verdictPill(verdict, { compact = false } = {}) {
  const m = verdictMeta(verdict);
  return h('span.pill', { dataset: { tone: m.tone }, title: m.gloss },
    h('span.pill-glyph', m.glyph),
    compact ? null : h('span.pill-label', m.label));
}

/**
 * The one situation that gets its own Chinese explanation rather than only the judgement
 * layer's English `reason`.
 *
 * 🔴 Keyed on `d_c < noise_floor`, which is not a tunable threshold — it is the definition
 * of "the different-model yardstick has collapsed into measurement noise", and it is the
 * assumption the whole control-calibration method rests on. Reproducing THAT condition in
 * the UI cannot drift the way re-deriving `1.5` or `0.7` here would; those stay in
 * src/layers/l2-calibrate.js and reach the reader through `reason` alone.
 *
 * It earns the special case because it is the most dangerous outcome the tool can produce:
 * both the subject and the control substituted, the two errors cancelling, and S/H sitting
 * innocently below the line. Measured on a real relay, not hypothetical.
 */
export function collapsedScaleNote(result) {
  const { d_c: d, noise_floor: floor } = result ?? {};
  if (!Number.isFinite(d) || !Number.isFinite(floor) || d >= floor) return null;
  return h('div.note.note--warn',
    h('div.note-title', '这个中转对两个模型名给出了几乎一样的答案'),
    h('p',
      `待验模型与对照模型在这里只相距 ${d.toFixed(4)}，低于测量噪声 ${floor.toFixed(4)}——`,
      '也就是说，这个端点上这两个名字',
      h('strong', { style: { color: 'var(--ink)' } }, '分不出来'),
      '，而官方 API 是把它们明确拉开的。'),
    h('p',
      '对照校准法的承重假设是「对照模型在两端都是正版」。这个假设一破，H 量到的就不是外壳，',
      '而是对照模型也被换了——这时哪怕 S/H 的区间整段在线下，「一致」也只意味着',
      h('strong', { style: { color: 'var(--ink)' } }, '两个替换互相抵消'),
      '，所以工具拒绝给出判定。'),
    h('p.note-count', '下一步：把对照模型本身当作待验模型单独筛一次，看两个名字里哪个是假的。'));
}

/**
 * The headline card. Takes the verdict's own `reason` string when there is one — the CLI
 * learned the hard way that a判定 whose explanation gets dropped on the floor teaches the
 * reader nothing (makeL2Result used to discard `reason` entirely).
 *
 * `reason` is the judgement layer's own English wording, shown verbatim and labelled as
 * such: paraphrasing it in the UI would create a second copy of the explanation that
 * drifts from the rule it describes.
 */
export function verdictCard({ verdict, reason, tier, model, host, note }) {
  const m = verdictMeta(verdict);
  return h('div.verdict', { dataset: { tone: m.tone } },
    h('div.verdict-mark', m.glyph),
    h('div.verdict-body',
      h('div.verdict-eyebrow', `${tier.toUpperCase()} 判定 · ${model}${host ? ` @ ${host}` : ''}`),
      h('h2.verdict-label', m.label),
      h('p.verdict-gloss', m.gloss),
      note && h('p.verdict-note', note),
      reason && h('details.verdict-reason',
        h('summary', { style: { cursor: 'pointer' } }, '判定层原文（英文）'),
        h('p', { style: { marginTop: '0.5rem' } }, reason))));
}

/**
 * The caveat that belongs on EVERY green verdict.
 *
 * Measured, not theoretical: one endpoint passed L2 cleanly at 09:13 and had been serving
 * a different model at 08:14 the same morning. Rotation is sticky — all 15 reps of a cell
 * land on one backend — so a single run is one draw from a lottery, and a reader who takes
 * one green light as "this relay is clean" has been misled by the tool.
 */
export function stickinessNote({ priorRuns = 0 } = {}) {
  return h('div.note.note--sticky',
    h('div.note-title', '一次绿灯 ≠ 这个端点干净'),
    h('p',
      '轮换是粘性的：一个格子的 15 次采样会整批落在同一个后端，所以单次测量等于抽一次签。',
      '实测见过同一个端点相隔一小时，一次是正版、一次掺了同代兄弟型号。'),
    priorRuns > 0
      ? h('p.note-count', `本地已存 ${priorRuns} 次该端点的测量——在「历史」页看时间线。`)
      : h('p.note-count', '隔几小时、隔几天各测一次，比一次测得更深更有用。'));
}
