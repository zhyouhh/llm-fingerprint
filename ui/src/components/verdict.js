// Verdict presentation. One vocabulary, used everywhere a verdict appears.
//
// 🔴 Status is never colour alone — every verdict ships a glyph and a word (dataviz
// non-negotiable, and plain sense: the difference between "consistent" and "suspect" is
// the whole product).
//
// 🔴 `inconclusive` is not styled as a failure. It is the honest outcome when the evidence
// does not reach either line, and the tool is built to prefer it over a guess. Rendering
// it in warning amber would push readers to treat it as bad news and act on it.

import { h, fmt } from '../ui/dom.js';
import { VERDICT } from '../../../src/contracts.js';
import { SEPARATION, RANKING_STABILITY, MIN_ID_CELLS } from '../../../src/layers/model-matrix.js';

/**
 * The number the separation was actually divided by: the distance, or the resolution floor
 * when the match is closer than this many samples can resolve.
 *
 * 🔴 Exported reading of one rule in `identification()`, not a second copy of it — the
 * ratio is computed there and only rendered here. What this fixes is a sentence quoting a
 * multiple that could not be reproduced from the two numbers printed beside it.
 */
export const scaleOf = (id) => Math.max(id.distance, id.floor);

/**
 * Say which bar actually held the name back.
 *
 * 🔴 It used to describe the separation regardless, which produced sentences that contradict
 * their own numbers: a run refused for a 57% valid rate, with separation 3.5 and stability
 * 1.0, was told "只有 3.5 倍，要 2 倍". Reading `withheld` is the difference between an
 * explanation and a number picked because it was to hand.
 */
export function withheldGloss(id) {
  const near = `离 ${id.nearest} ${fmt(id.distance)}，离第二近的 ${id.runner_up ?? '—'} ` +
    `${fmt(id.runner_up_distance)}——是 ${fmt(scaleOf(id))} 的 ${fmt(id.separation, 1)} 倍。`;
  switch (id.withheld) {
    case 'valid_rate':
      // 🔴 Says "too few came back", not "rate limiting ate them". A low valid rate also
      // comes from empty completions (a reasoning model burning the 16-token budget),
      // refusals, network failures or a run that was stopped — and telling someone with
      // 25% empty completions that they were throttled sends them to fix the wrong thing.
      return '但这次跑回来的有效补全太少，不能凭它指名道姓——探针丢失通常不是随机的' +
             '（限流、空补全、拒答都各有偏好），活下来的那些能一致地指向一个错的型号。' +
             '看下面的有效率，然后重跑一次。';
    case 'cells':
      return `但只比对上了 ${id.cells} 个格子，指名道姓要 ${MIN_ID_CELLS} 个。` +
             '同一个端点在 3 格、6 格、29 格上被指认成三个不同型号——格子少的时候这个排名会翻。';
    case 'floor':
      return '但参照库没带够样本，算不出这次比较的分辨极限——没有它，比值除以的是一个未知数。';
    case 'stability':
      return `${near}差距够大，但重抽格子时它只有 ` +
             `${fmt((id.rank_stability ?? 0) * 100, 0)}% 的次数还排第一（要 ` +
             `${fmt(RANKING_STABILITY * 100, 0)}%）——换一批格子就可能是别人。`;
    case 'refuted':
      return `${near}但 ${id.refuted_by.map((c) => c.model).join('、')} 覆盖的格子不够多、` +
             '在共有的那些格子上却更近——所以这个名字不是唯一的答案。';
    default:
      return `${near}要指名道姓得到 ${SEPARATION} 倍以上。隔几小时再测一次，看它稳不稳。`;
  }
}

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

/* ── the headline ───────────────────────────────────────────────────────── */

/**
 * What the page leads with, chosen from two things `src/` already decided: `evaluateL2`'s
 * verdict and the identification layer's `impostor` flag. This invents no number and
 * applies no threshold — the separation bar and the cell floor both live in
 * src/layers/model-matrix.js, where the CLI and the golden tests can see them. All this
 * does is fix which of the two answers the reader's actual question first.
 *
 * 🔴 The name outranks the verdict when they disagree, and that ordering is the whole
 * point of this function. Measured: a relay serving luna under the name sol came back
 * `inconclusive` — the S/D rule cannot convict a swap to a near neighbour at all — while
 * the identification layer had already named luna at 3.55× separation. The page led with
 * "证据不足" in calm blue and buried the name three screens down. Both true; leading with
 * the weaker one misled. `evaluateL2` now returns `suspect` for that case, so the two
 * normally agree; this ordering still holds for stored runs judged before that change.
 *
 * @param {{verdict: string, model: string, identification: object|null}} args
 *   `identification` is the src/ object: {model, impostor, distance, separation, ...}.
 * @returns {{tone, glyph, title, gloss, named: boolean}}
 */
export function headline({ verdict, model, identification: id }) {
  // 🔴 The name is checked BEFORE `not_applicable`, and that ordering matters for stored
  // runs. `not_applicable` used to imply the subject side was too thin to say anything —
  // it no longer does: evaluateL2 now returns it when the CONTROL side dies, on runs whose
  // subject side is strong enough to identify. Files saved before that change carry the
  // old verdict, and a `not_applicable` early return here silently threw their name away
  // while the CLI's rejudge reported it. `identification` is recomputed from the samples
  // with the same cell bar, so an impostor here already means a solid subject side.
  if (id?.impostor) {
    return {
      tone: 'bad', glyph: '✕', named: true,
      title: `你买的 ${model}，实际发的是 ${id.model}`,
      // 🔴 The multiple is against `scaleOf`, never against the raw distance above it. The
      // separation divides by `max(distance, floor)`, so on a close match — the normal case
      // for a real substitution — a reader dividing the two printed numbers gets 8.5 where
      // the sentence says 3.2 and cannot tell which is wrong. Naming the denominator is the
      // difference between a checkable claim and one that has to be taken on faith.
      gloss: `这批答案落在 ${id.model} 的位置上：离它 ${fmt(id.distance)}，` +
             `而离第二近的 ${id.runner_up} 有 ${fmt(id.runner_up_distance)}` +
             `——是 ${fmt(scaleOf(id))} 的 ${fmt(id.separation, 1)} 倍。`,
    };
  }

  if (verdict === VERDICT.NOT_APPLICABLE) {
    const m = VERDICT_META[VERDICT.NOT_APPLICABLE];
    return { tone: m.tone, glyph: m.glyph, title: m.label, gloss: m.gloss, named: false };
  }

  if (verdict === VERDICT.SUSPECT) {
    return {
      tone: 'bad', glyph: '✕', named: false,
      title: '疑似换了模型',
      // 🔴 Only claim the library was consulted when it was. L1 never ranks anything, and
      // an L1 report saying "none of the ten matched" describes a check that did not run.
      gloss: id
        ? '差距已经到了「换成另一个模型」的量级。换成了哪个说不上来——参照库里的型号没有一个对得上。'
        : '差距已经到了「换成另一个模型」的量级。这一层不回答「换成了哪个」——那要跑 L2。',
    };
  }

  if (verdict === VERDICT.CONSISTENT) {
    return {
      tone: 'ok', glyph: '✓', named: false,
      title: '看起来是真的',
      gloss: '与正版参照的差距，用网关包装的差异和测量噪声就能解释完。',
    };
  }

  // 🔴 A distinct state, not a shade of "测不出来". The distribution's nearest match is a
  // model you did not buy — that is a finding — but the 90% interval on the separation does
  // not reach the bar, so it is not an accusation. Both halves have to be on screen: the
  // first version of the conservative rule put exactly this case back under a calm blue
  // headline, which is the burial this layer was built to undo.
  if (id?.leaning && id.nearest) {
    return {
      tone: 'unknown', glyph: '?', named: false,
      title: `最像的不是 ${model}，是 ${id.nearest}`,
      gloss: withheldGloss(id),
    };
  }

  return {
    tone: 'unknown', glyph: '?', named: false,
    title: '这次测不出来',
    gloss: '差距落在「包装能解释」和「换了模型」两条线之间。这不是坏消息，是这次测量还不够分辨它——' +
           '隔几小时再测一次，看它稳不稳。',
  };
}

/**
 * The inline pill, for tables and history rows.
 *
 * 🔴 One vocabulary or none — so this takes a HEADLINE, not a raw verdict. A timeline row
 * saying 证据不足 next to a report that opens with "实际发的是 gpt-5.6-luna" reproduces, one
 * page over, exactly the confusion the headline exists to remove.
 */
export function headlinePill(head, { compact = false } = {}) {
  const label = head.named ? '冒名' : verdictMeta(headVerdictKey(head)).label;
  return h('span.pill', { dataset: { tone: head.tone }, title: head.title },
    h('span.pill-glyph', head.glyph),
    compact ? null : h('span.pill-label', label));
}

const TONE_TO_VERDICT = { ok: VERDICT.CONSISTENT, bad: VERDICT.SUSPECT, unknown: VERDICT.INCONCLUSIVE };
const headVerdictKey = (head) => TONE_TO_VERDICT[head.tone] ?? VERDICT.NOT_APPLICABLE;

/** Sparkline dot class, so the timeline is coloured by the same rule as the rows. */
export const headlineDotClass = (head) => (head.named ? 'suspect' : headVerdictKey(head));

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
 * drifts from the rule it describes. When the name has overruled it, the label says so
 * rather than hiding it — a reader who scrolls must be able to see both answers.
 */
export function verdictCard({ head, verdict, reason, tier, model, host, note }) {
  const m = verdictMeta(verdict);
  return h('div.verdict', { dataset: { tone: head.tone } },
    h('div.verdict-mark', head.glyph),
    h('div.verdict-body',
      h('div.verdict-eyebrow', `${tier.toUpperCase()} · ${model}${host ? ` @ ${host}` : ''}`),
      h('h2.verdict-label', head.title),
      h('p.verdict-gloss', head.gloss),
      note && h('p.verdict-note', note),
      reason && h('details.verdict-reason',
        h('summary', { style: { cursor: 'pointer' } },
          // Only say the two disagree when they actually do. Since evaluateL2 gained the
          // identification route they normally agree, and this line survives for runs
          // stored before that — claiming a disagreement that is not there is its own
          // small lie.
          head.named && verdict !== VERDICT.SUSPECT
            ? `⚠️ 这次跑存下来时，判定层只到「${m.label}」——那一版还没有指认这条路，原文（英文）`
            : '判定层原文（英文）'),
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
