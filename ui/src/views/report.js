import { h, fmt, pct, int, cellParts, LANG_LABEL, isRtl } from '../ui/dom.js';
import { verdictCard, stickinessNote, collapsedScaleNote, headline, scaleOf } from '../components/verdict.js';
import { MIN_ID_CELLS } from '../../../src/layers/model-matrix.js';
import { intervalBar, distanceBar } from '../components/interval-bar.js';
import { short } from '../components/heatmap.js';
import { identifyRun, distributionOf } from '../core/engine.js';
import { referencesFor } from '../core/references.js';
import { CONSISTENT_RATIO, SUSPECT_RATIO } from '../../../src/layers/l2-calibrate.js';
import { modeOf } from '../components/fingerprint-grid.js';

/** ∞ is an answer (an exact match), not a missing number — `fmt` would print an em dash. */
/** ∞ is only ever +Infinity; NaN means there was no runner-up to separate from. */
const sepText = (sep) => (Number.isFinite(sep) ? `${fmt(sep, 1)}×` : (Number.isNaN(sep) ? 'n/a' : '∞×'));

/**
 * 🔴 Reading order is the design here, not decoration.
 *
 * The page used to open with the judgement layer's vocabulary — 一致 / 疑似替换 / 证据不足 —
 * and then spend three screens on H, S, D, two intervals, a noise floor and a denominator
 * basis before reaching the one line a reader actually came for. On the run that mattered
 * most that opening read "证据不足" in calm blue while the name (gpt-5.6-luna, 3.55×) sat
 * far below the fold.
 *
 * So: the answer, the evidence for it, the raw answers themselves — and only then, folded
 * away, how it was computed. Nothing was deleted; the method moved behind a disclosure.
 *
 * @param {object} run   a stored run record
 * @param {{priorRuns?: number, onAgain?: Function, compact?: boolean}} opts
 */
export async function renderReport(run, { priorRuns = 0, onAgain = null } = {}) {
  const r = run.result ?? {};
  const box = h('div');

  if (run.tier === 'l0') return renderL0(run, box);

  const id = await identifyRun({
    samples: run.samples, protocol: run.protocol, role: 'subject',
    sold: run.model,
    // 🔴 The rate as MEASURED at collection time, under the contract's denominator. Null when
    // the record predates it — unknown, so no name.
    validRate: r.subject?.valid_rate ?? null,
  });
  const head = headline({ verdict: r.verdict, model: run.model, identification: id.identification });

  box.append(
    verdictCard({ head, verdict: r.verdict, reason: r.reason, tier: run.tier, model: run.model, host: run.host }),
    // A collapsed scale means the run could not calibrate at all, so it outranks the
    // "measure again over time" advice. The name no longer competes for this slot — it is
    // the headline now.
    h('div', { style: { marginTop: 'var(--gap-2)' } },
      collapsedScaleNote(r) ?? (head.tone === 'ok' ? stickinessNote({ priorRuns }) : null)));

  box.append(identificationSection(run, id));
  box.append(await cellTable(run));
  box.append(workings(run, r));
  box.append(actions(run, onAgain));
  return box;
}

/**
 * Everything the judgement rests on, folded. Open by default would put the method back in
 * front of the answer; leaving it out would make the verdict unauditable.
 */
function workings(run, r) {
  return h('details.fold', { style: { marginTop: 'var(--gap-5)' } },
    h('summary.fold-summary', '怎么算出来的 —— 判据、区间与原始计数'),
    h('div.fold-body',
      run.tier === 'l2' ? l2Numbers(run, r) : null,
      run.tier === 'l1' ? l1Numbers(run, r) : null,
      rawStats(run, r)));
}

/* ── L2: the interval is the reading ────────────────────────────────────── */

function l2Numbers(run, r) {
  const sampled = run.sampled_control !== false;

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '判据'),
      h('h2.section-title', '两条线，两个区间，都要整段越过'),
      h('p.muted', { style: { fontSize: 'var(--step--1)', maxWidth: '62ch' } },
        '这不是「分数高于某个值就报警」。一个判定要成立，90% 区间必须',
        h('strong', { style: { color: 'var(--ink)' } }, '整段'),
        '落在线的正确一侧——两个方向都是。点估计越线而区间没越，只说明这次测量还不够分辨它。')),

    h('div.grid-2',
      intervalBar({
        lo: r.ratio_ci_lo, hi: r.ratio_ci_hi, point: r.ratio,
        threshold: CONSISTENT_RATIO, direction: 'below',
        passed: Number.isFinite(r.ratio_ci_hi) && r.ratio_ci_hi < CONSISTENT_RATIO,
        tone: 'ok',
        title: 'S / H — 包装与噪声能解释吗',
        subtitle: sampled
          ? '待验模型的跨端点距离，除以同一个对照模型的跨端点距离'
          : '没采对照，外壳按 0 算：分母是噪声地板',
        thresholdLabel: '整段在此线下 = 一致',
      }),
      intervalBar({
        lo: r.sd_ci_lo, hi: r.sd_ci_hi, point: r.sd_ratio,
        threshold: SUSPECT_RATIO, direction: 'above',
        passed: Number.isFinite(r.sd_ci_lo) && r.sd_ci_lo >= SUSPECT_RATIO,
        tone: 'bad',
        title: 'S / D — 到「换了模型」的量级了吗',
        subtitle: sampled
          ? '除以待验与对照在这个中转上的实测距离'
          : '除以两份正版参照之间的距离',
        thresholdLabel: '整段在此线上 = 疑似替换',
      })),

    h('div.card', { style: { marginTop: 'var(--gap-2)' } },
      h('div.card-title', '三个量，扣掉噪声地板之后'),
      h('div.grid-3',
        quantity('H  外壳', r.h, r.h_c, sampled
          ? `${run.control} 在两端之间的距离——模型确定相同，剩下的就是外壳`
          : '没测：网页版不采对照模型'),
        quantity('S  待验', r.s, r.s_c, `${run.model} 在两端之间的距离——被判定的就是它`),
        quantity('D  尺度', r.d, r.d_c, sampled
          ? `${short(run.model)} 与 ${short(run.control)} 在这个中转上相距多远`
          : `正版 ${short(run.model)} 与正版 ${short(run.control)} 之间的距离`)),
      h('div.kv', { style: { marginTop: 'var(--gap-3)' } },
        // 🔴 Three floors, three comparisons — the page must not still teach one. S and H
        // are same-model comparisons (their whole measured distance is sampling noise, so
        // the noise floor IS the correction); D is cross-model, where the true distance is
        // large and only a small bias sits on top. Using a same-model floor there
        // over-subtracts by more than tenfold, and D is a denominator.
        h('dt', '地板 · S'), h('dd', fmt(r.noise_floor), h('span.faint', '  待验侧对参照，同模型噪声')),
        h('dt', '地板 · H'), h('dd', r.noise_floor_h == null ? '—' : fmt(r.noise_floor_h),
          h('span.faint', '  对照侧对参照')),
        h('dt', '地板 · D'), h('dd', r.noise_floor_d == null ? '—' : fmt(r.noise_floor_d),
          h('span.faint', '  跨模型比较的采样偏差，比同模型地板小得多')),
        h('dt', '分母依据'), h('dd', denominatorLabel(r.denominator_basis)),
        h('dt', '活格'), h('dd', `${r.live_cells}`),
        h('dt', '有效率'), h('dd',
          `待验 ${pct(r.subject?.valid_rate, 1)}`,
          sampled ? ` · 对照 ${pct(r.control?.valid_rate, 1)}` : ' · 对照未采')),
      r.low_confidence
        ? h('div.note.note--warn', { style: { marginTop: 'var(--gap-2)' } },
            h('div.note-title', '低置信'), h('p', '有效补全率在 20%–80% 之间，这次的分布是从残缺的样本里估的。'))
        : null,
      sampled ? null : noControlNote()),

    reasoningNote(r));
}

/**
 * 🔴 The one thing not sampling a control actually costs, stated where the number it
 * affects is.
 *
 * It is a smaller cost than it looks, and the archive says so: of eight credible runs on
 * this wire, six measured the harness BELOW the noise floor and the seventh at 1.08× it.
 * Re-judging every stored run without its control moved no genuine endpoint off green —
 * including the self-hosted gateway with the heaviest harness on file.
 *
 * It also removes a trap. The harness term is what a substituted control inflates, and an
 * inflated H is what once swallowed an equally large S and printed CONSISTENT over a relay
 * serving luna under two names. With no control, H is zero by construction and the
 * denominator is the noise floor — that failure mode cannot occur.
 */
function noControlNote() {
  return h('div.note', { style: { marginTop: 'var(--gap-2)' } },
    h('div.note-title', '这次没量外壳，分母走的是噪声地板'),
    h('p', '对照模型的作用是量出「这家网关的包装」有多厚再扣掉。网页版不采它——',
      '实测八次里有六次外壳低于噪声地板，第七次也只有 1.08 倍，',
      '而它要花掉一倍探针、并且它自己也可能被换掉（那会让判定反向出错）。'),
    h('p.note-count', '代价：如果这家网关真的把答案分布改动很大，那部分会算到模型头上。',
      '要单独量它，用 CLI 的 verify-relay.js 带对照跑。'));
}

function quantity(label, raw, corrected, gloss) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', fmt(corrected)),
    h('div.stat-note', h('span.faint', `原始 ${fmt(raw)} → 扣地板`)),
    h('div.stat-note', gloss));
}

function denominatorLabel(basis) {
  if (basis === 'harness') return '外壳（H 高于噪声地板，对照真的测出了东西）';
  if (basis === 'noise floor') return '噪声地板（H 低于地板——两端的对照模型分不出区别，这是对照能给的最好结果）';
  if (basis === 'noise floor (control not sampled)') return '噪声地板（没采对照，H 按 0 算）';
  if (basis) return basis;
  return '—';
}

/** Effort is a separate axis; the fingerprint cannot see it, so it is reported not folded in. */
function reasoningNote(r) {
  const subject = r.reasoning_rate?.subject ?? r.reasoning_rate;
  if (!Number.isFinite(subject)) return null;
  return h('div.note', { style: { marginTop: 'var(--gap-2)' } },
    h('div.note-title', 'reasoning 痕迹率 ' + pct(subject, 1) + '（不在上面的判定里）'),
    h('p', '「同一个模型跑在更低的推理档」看不出来——答案分布对 effort 不敏感。',
      '这个数字只是参考：它比参照高不代表降档，比参照低也只是「与更低推理档一致」，不是证据。'));
}

/* ── L1 ─────────────────────────────────────────────────────────────────── */

function l1Numbers(run, r) {
  const { t_pass: pass, t_fail: fail, s_screen: s } = r;
  const max = Math.max(fail ?? 0, s ?? 0, 0.001) * 1.2;
  const x = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '判据'),
      h('h2.section-title', 'S_screen 落在哪一段')),
    h('div.card',
      Number.isFinite(s)
        ? h('div',
            h('div.ci-track', { style: { height: '40px' } },
              h('div.ci-region', { style: { left: '0%', width: x(pass), background: 'var(--ok-wash)' } }),
              h('div.ci-region', { style: { left: x(fail), right: '0', background: 'var(--bad-wash)' } }),
              h('div.ci-axis'),
              h('div.ci-line', { style: { left: x(pass) } }),
              h('div.ci-line', { style: { left: x(fail) } }),
              h('div.ci-point', { style: { left: x(s) } })),
            h('div.ci-scale',
              h('span.ci-lo', '0'),
              h('span.ci-mid', { style: { left: x(pass) } },
                h('span.ci-mid-num', fmt(pass, 3)), h('span.ci-mid-label', 'T_pass')),
              h('span.ci-hi', fmt(max, 2))),
            h('div.ci-read',
              h('strong', `S_screen = ${fmt(s)}`), ' · T_pass ', fmt(pass, 3), ' · T_fail ', fmt(fail, 3)))
        : h('p.muted', '这次没有算出 S_screen —— 见上面的判定说明。'),
      h('div.kv', { style: { marginTop: 'var(--gap-3)' } },
        h('dt', '活格'), h('dd', `${r.live_cells}`),
        h('dt', '有效率'), h('dd', pct(r.valid_rate, 1)),
        h('dt', '噪声地板'), h('dd', fmt(r.noise_floor))),
      h('div.note', { style: { marginTop: 'var(--gap-3)' } },
        h('div.note-title', 'L1 的距离里混着外壳，不能当模型差异读'),
        h('p', 'S_screen 是「这个端点」与「采参照的那个端点」之间的原始距离，',
          '两者的网关外壳不同也会贡献。实测中 L2 把 L1 的判定翻掉过两次——',
          '一次是被外壳冤枉的正版，一次是被外壳掩护的替换。黄灯或红灯都应该上 L2 确认。'))));
}

/* ── identification: which reference is this shaped like ────────────────── */

/**
 * The evidence behind the headline, so a reader can check the claim rather than take it.
 * Ten bars, one per reference — a name is only believable next to what it beat.
 */
function identificationSection(run, id) {
  // 🔴 No early return on an empty ranking. There used to be one right here, three lines
  // above the branch written to handle exactly that case — so the "asked, and nothing was
  // comparable" panel could never render and a run with no usable cells showed nothing at
  // all, which is the state the contract work went to the trouble of separating from
  // "never asked". [[guards-that-cannot-fail]], in its dead-code form.
  //
  // 🔴 Everything shown here reads off `id.identification` — the same object the verdict
  // used. Rendering `id.named` instead let this section announce a confident match that the
  // decision had already refused, with the caveat three lines below contradicting it.
  const d = id.identification;
  if (!d) return null;
  // 🔴 "Asked, and nothing was comparable" is a finding and has to be on the page. Keyed on
  // the ranking being empty, this section used to render nothing at all — which is exactly
  // the shape the contract work went to the trouble of distinguishing from "not asked".
  if (!id.ranked.length || d.cells === 0) {
    return h('section.section',
      h('div.section-head',
        h('div.eyebrow', '证据'),
        h('h2.section-title', '这批分布，最像哪个官方型号')),
      h('div.card',
        h('p', { style: { fontSize: 'var(--step-1)' } }, '比不了。'),
        // 🔴 An empty ranking has more than one cause, and naming the wrong one sends the
        // reader to fix something that is not broken. `id.ranked` empty with cells measured
        // means the LIBRARY could not line up — every candidate covering fewer than the
        // naming floor, or no cell that all of them answer — not that the probes failed.
        // 🔴 Keyed on how many cells the MEASUREMENT produced, which is the only thing that
        // separates the two causes. Both arrive here with an empty ranking and `cells === 0`,
        // so keying on either of those always printed the sampling explanation — and told a
        // reader whose probes were fine to go and look at their valid rate.
        h('p.muted', { style: { fontSize: 'var(--step--1)' } },
          id.measuredCells > 0
            ? `这次采到了 ${id.measuredCells} 个够格的格子，但参照库对不上：没有哪个格子是所有候选` +
              '都答过、且两边都攒够 10 个有效样本的。这不是「都不像」，是「没得比」——问题在参照库，不在这次采样。'
            : '这次没有任何一个格子攒够 10 个有效样本，参照库因此无从比对——这不是「都不像」，是「没得比」。看下面的有效率。')));
  }
  const named = d.model != null;
  const worst = Math.max(...id.distances.map((x) => x.value).filter(Number.isFinite), 0.001);
  const thin = d.cells < MIN_ID_CELLS;

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '证据'),
      h('h2.section-title', '这批分布，最像哪个官方型号'),
      h('p.muted', { style: { fontSize: 'var(--step--1)', maxWidth: '62ch' } },
        '判据是',
        h('strong', { style: { color: 'var(--ink)' } }, '与次近的分离度'),
        '，不是绝对距离。绝对距离里含着这个中转的外壳，而这一层没有对照可以扣——',
        '一个自建网关离它真正在发的模型都有 0.154。比值把外壳削弱掉——等量的加性外壳把比值推向 1，',
        '更难命名、方向安全；但随模型而异的扭曲能改排名，这一层看不出来。')),

    h('div.card',
      named
        ? h('p', { style: { fontSize: 'var(--step-1)' } },
            '落在 ', h('strong.mono', { style: { color: 'var(--brass)' } }, d.model), ' 的位置上。')
        // 🔴 Say which bar withheld the name. "落在 A 和 B 之间，离哪个更近说不准" is only
        // true when the SEPARATION is what failed; on a run refused for its valid rate or
        // its ranking stability it describes a different run than the one on screen.
        : h('p', { style: { fontSize: 'var(--step-1)' } },
            !d.runner_up
              ? h('span', '参照库里只有 ', h('span.mono', d.nearest), ' 一个候选，没有可比的对象。')
              : d.withheld === 'separation'
                ? h('span', '落在 ', h('span.mono', d.nearest), ' 和 ', h('span.mono', d.runner_up),
                    ' 之间，离哪个更近说不准。')
                : h('span', '最近的是 ', h('span.mono', d.nearest), '，但这次不能凭它指名道姓。')),
      // 🔴 The scale, in the same three numbers a person can hold at once — this replaces
      // the interval as the READING. The interval still decides, and still shows, but a
      // reader should not need "90% cluster-bootstrap lower bound" to understand where
      // their endpoint landed.
      ladder(d),
      // ⚠️ The one way this layer accuses without a substitution: a reference collected
      // before the vendor updated that model's weights.
      named && d.impostor && d.reference_age_days != null && d.reference_age_days >= 90
        ? h('div.note.note--warn', { style: { marginTop: 'var(--gap-3)' } },
            h('div.note-title', `这个指认建立在一份 ${d.reference_age_days} 天前的参照上`),
            h('p', `如果厂商在这期间更新过 ${run.model} 的权重，一家诚实的中转也会给出同样的结果——`,
              '数据本身分不开这两种情况。行动之前先重采一份参照。'))
        : null,
      // 🔴 Not a formality. The same endpoint has been named three different models at 3,
      // 6 and 29 cells — so below the floor the ranking is shown but never promoted.
      thin
        ? h('div.note', { style: { marginTop: 'var(--gap-3)' } },
            h('div.note-title', `${d.cells} 个格子，指认不算数`),
            h('p', `指名道姓要至少 ${MIN_ID_CELLS} 个格子。实测同一个端点在 3 格、6 格、29 格上`,
              '被指认成三个不同型号——格子少的时候，这个排名会翻。',
              run.tier === 'l1' ? 'L1 回答的是「还是不是它」，「那是什么」要跑 L2。' : '这次多数格子没采到足够样本。'))
        : null,
      h('div', { style: { marginTop: 'var(--gap-3)' } },
        ...id.distances
          .slice()
          .sort((a, b) => a.value - b.value)
          .map((row, i) => distanceBar({
            value: row.value, floor: 0, max: worst * 1.05,
            label: short(row.model),
            tone: i !== 0 ? 'diff'
              : !named ? 'same'
                : d.model === run.model ? 'best' : 'impostor',
          })))));
}

/**
 * Where this measurement sits, said in distances rather than in ratios.
 *
 * 🔴 The three numbers are chosen so the reading is COMPARATIVE, never absolute. An
 * absolute distance carries the gateway's own distortion — a self-hosted proxy measures
 * 0.154 from the model it genuinely serves — so "0.107 away" means nothing on its own.
 * Next to "the runner-up is 0.316 away" and "two real models sit 0.14–0.47 apart" it means
 * a great deal, and none of it requires the word "interval".
 */
function ladder(d) {
  const line = (label, value, note) => h('div.kv-row',
    h('span.kv-row-label', label),
    h('span.kv-row-value.mono', fmt(value)),
    h('span.kv-row-note', note));
  // 🔴 Name the number the ratio was actually taken against. The separation divides by
  // `max(distance, floor)`, and when the floor binds — which is the normal case for a close
  // match — the printed "3.3×" cannot be reproduced from the two distances above it: a
  // reader divides 0.4132 by 0.0465, gets 8.9, and has no way to tell which of the two is
  // wrong. Same defect as the run that printed S/H 1.94 while judging on 20.8: not a wrong
  // number, an unverifiable one.
  const floored = Number.isFinite(d.floor) && d.floor > d.distance;
  const denom = scaleOf(d);   // one definition, shared with the headline
  return h('div', { style: { marginTop: 'var(--gap-3)' } },
    line(`离 ${d.nearest}`, d.distance, '最近的那个'),
    d.runner_up ? line(`离 ${d.runner_up}`, d.runner_up_distance,
      `第二近 —— 是 ${fmt(denom)} 的 ${sepText(d.separation)}`) : null,
    h('div.kv-row.kv-row--scale',
      h('span.kv-row-label', '作为尺度'),
      h('span.kv-row-value.mono', fmt(d.floor)),
      h('span.kv-row-note', floored
        ? '同一个模型测两次就有这么大差别（噪声地板）。离得比它还近，就按它当分母——测不出来的差别不该被当成确信'
        : '同一个模型测两次就有这么大差别（噪声地板）')),
    h('div.kv-row.kv-row--scale',
      h('span.kv-row-label', ''),
      h('span.kv-row-value.mono', '0.14–0.47'),
      h('span.kv-row-note', '两个真实型号之间的距离，从最像的一对到最不像的一对')));
}

/* ── per-cell detail ────────────────────────────────────────────────────── */

async function cellTable(run) {
  const refs = await referencesFor(run.protocol);
  const ref = refs.find((r) => r.model === run.model);
  if (!ref) return null;

  // 🔴 minN = 1: this table SHOWS what came back, it does not decide anything. The
  // decision bar (L2_MIN_N = 10) belongs to identification and to evaluateL2 — applied
  // here it emptied every L1 report, because L1 collects five samples per cell by design.
  const { dist: measured } = distributionOf(run.samples, { model: run.model, role: 'subject' }, 1);
  const perCell = run.result?.per_cell?.s ?? run.result?.per_cell ?? {};
  const rows = Object.keys(measured).sort((a, b) => (perCell[b] ?? 0) - (perCell[a] ?? 0));
  if (!rows.length) return null;

  const mismatches = rows.filter((c) => modeOf(measured[c]).answer !== modeOf(ref.fingerprint[c]).answer);

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '逐格'),
      h('h2.section-title', `${mismatches.length} / ${rows.length} 个格子的众数与参照不符`),
      h('p.muted', { style: { fontSize: 'var(--step--1)' } },
        '众数换了，比距离变大更硬——降温只让分布变尖，改不了 argmax。')),
    h('div.table-wrap',
      h('table.table',
        h('thead', h('tr',
          h('th', '格子'), h('th', '语言'),
          h('th', '这个端点'), h('th', '正版参照'), h('th', { class: 'num' }, 'JSD'))),
        h('tbody', ...rows.map((cell) => {
          const { lang, task } = cellParts(cell);
          const mine = modeOf(measured[cell]);
          const theirs = modeOf(ref.fingerprint[cell]);
          const bad = mine.answer !== theirs.answer;
          return h('tr', { class: bad ? 'is-mismatch' : '' },
            h('td', task.replace(/-random$/, '')),
            h('td', LANG_LABEL[lang] ?? lang),
            h('td', { class: 'answer', dir: isRtl(lang) ? 'rtl' : 'ltr' },
              mine.answer ?? '—', h('span.faint', `  ${pct(mine.p)}`)),
            h('td', { class: 'answer', dir: isRtl(lang) ? 'rtl' : 'ltr' },
              theirs.answer ?? '—', h('span.faint', `  ${pct(theirs.p)}`)),
            h('td', { class: 'num' }, fmt(perCell[cell])));
        })))));
}

/* ── L0 ─────────────────────────────────────────────────────────────────── */

function renderL0(run, box) {
  const a = run.result?.l0a ?? {};
  const b = run.result?.l0b ?? {};
  const acc = b.acceptance ?? {};

  const KIND_LABEL = {
    'oneapi-newapi': 'One API / New API 转发框架',
    cliproxyapi: 'cliproxyapi（订阅逆向网关）',
    'oneapi-like': '开放 /api/status，像 One API 系',
    'openai-direct-or-passthrough': '官方 API 直连或透传',
    'openai-compatible': 'OpenAI 兼容端点',
    unknown: '认不出来',
  };

  box.append(
    h('div.card',
      h('div.eyebrow', 'L0 画像'),
      h('h2', { style: { fontSize: 'var(--step-2)', fontWeight: '400', margin: 'var(--gap-2) 0' } },
        KIND_LABEL[a.endpoint_kind] ?? a.endpoint_kind ?? '—'),
      h('div.kv',
        h('dt', '端点'), h('dd', run.host),
        h('dt', '模型数'), h('dd', a.model_count ?? '—'),
        h('dt', '/api/status'), h('dd', a.status_endpoint ? '开放（One API 系的特征）' : '无'),
        h('dt', '/models'), h('dd', a.models_endpoint_reachable ? '可达' : '不可达'),
        h('dt', '注入 token'), h('dd',
          Number.isFinite(b.injection_tokens) ? String(b.injection_tokens) : '—',
          h('span.faint', '  官方约 7 · 订阅网关约 294 · 有的转发商上千')),
        h('dt', '模型回显'), h('dd', b.model_reported ?? '—')),
      a.endpoint_kind === 'oneapi-newapi'
        ? h('div.note.note--warn', { style: { marginTop: 'var(--gap-3)' } },
            h('div.note-title', '这不是官方直连'),
            h('p', '响应头里有 x-oneapi-request-id —— 它跑在 One API / New API 转发框架上。',
              '如果卖家宣称「官方 API 直连」，这一条就已经对不上了。'))
        : null),

    h('section.section',
      h('div.section-head',
        h('div.eyebrow', '参数接受度'),
        h('h2.section-title', '它收哪些参数'),
        h('p.muted', { style: { fontSize: 'var(--step--1)', maxWidth: '62ch' } },
          '🔴 四种取值，', h('code', 'null'), ' 不等于「不支持」：2xx 是支持，4xx 是它明确拒绝，',
          '5xx / 网络失败是',
          h('strong', { style: { color: 'var(--ink)' } }, '探过但没测出来'),
          '。把一次 503 记成「不支持」，等于把端点抖动的那一分钟冻成永久结论。')),
      h('div.table-wrap',
        h('table.table',
          h('thead', h('tr', h('th', '参数'), h('th', '结果'))),
          h('tbody', ...Object.entries(acc).map(([k, v]) => h('tr',
            h('td', { class: 'answer' }, k),
            h('td', acceptanceCell(v)))))))),

    b.juice_by_effort
      ? h('section.section',
          h('div.section-head', h('div.eyebrow', 'juice 探针'), h('h2.section-title', '各档位的 juice 值')),
          h('div.table-wrap', h('table.table',
            h('thead', h('tr', h('th', 'effort'), h('th', { class: 'num' }, 'juice'))),
            h('tbody', ...Object.entries(b.juice_by_effort).map(([k, v]) => h('tr',
              h('td', { class: 'answer' }, k),
              h('td', { class: 'num' }, v ?? '—')))))))
      : null,

    h('div.note', { style: { marginTop: 'var(--gap-3)' } },
      h('div.note-title', 'L0 不判定模型身份'),
      h('p', '画像回答的是「这是个什么东西」和「它收什么参数」。',
        '「还是不是那个模型」要跑 L1，「是不是换了模型」要跑 L2。',
        h('a', { href: '/run' }, ' 回去选层级 →'))),

    actions(run, null));

  return box;
}

function acceptanceCell(v) {
  if (v === true) return h('span.pill', { dataset: { tone: 'ok' } }, h('span.pill-glyph', '✓'), '接受');
  if (v === false) return h('span.pill', { dataset: { tone: 'bad' } }, h('span.pill-glyph', '✕'), '拒绝');
  if (v === 'not_probed') return h('span.pill', { dataset: { tone: 'na' } }, h('span.pill-glyph', '—'), '未探');
  return h('span.pill', { dataset: { tone: 'unknown' } }, h('span.pill-glyph', '?'), '探过没测出来');
}

/* ── footer bits ────────────────────────────────────────────────────────── */

function rawStats(run, r) {
  return h('details.card', { style: { marginTop: 'var(--gap-3)' } },
    h('summary', { style: { cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 'var(--step--1)' } },
      '原始计数与重跑边界'),
    h('div.kv', { style: { marginTop: 'var(--gap-3)' } },
      h('dt', '逻辑探针'), h('dd', int(run.meta?.probes)),
      h('dt', 'HTTP 尝试'), h('dd', int(run.meta?.http_attempts), h('span.faint', '  含重试')),
      h('dt', '指纹协议'), h('dd', run.meta?.fingerprint_protocol ?? run.protocol),
      h('dt', '参照版本'), h('dd', run.meta?.reference_version ?? '—'),
      h('dt', '每格采样'), h('dd', run.meta?.reps_per_cell ?? '—'),
      h('dt', '时间'), h('dd', run.ts)));
}

function actions(run, onAgain) {
  return h('div', { style: { marginTop: 'var(--gap-4)', display: 'flex', gap: 'var(--gap-2)', flexWrap: 'wrap' } },
    onAgain && h('button.btn.btn--primary', { type: 'button', onclick: onAgain }, '再测一次'),
    h('a.btn', { href: '/history' }, '看历史时间线'),
    h('button.btn', {
      type: 'button',
      onclick: () => {
        // The endpoint URL rides along (it is not a secret and the file is useless
        // without it); the key never existed in this object to begin with.
        const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `${run.host}__${run.tier}__${run.id}.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      },
    }, '导出 JSON'));
}
