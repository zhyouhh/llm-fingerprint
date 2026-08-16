import { h, fmt, pct, int, cellParts, LANG_LABEL, isRtl } from '../ui/dom.js';
import { verdictCard, stickinessNote, verdictPill, collapsedScaleNote } from '../components/verdict.js';
import { intervalBar, distanceBar } from '../components/interval-bar.js';
import { short } from '../components/heatmap.js';
import { identifyRun, distributionOf } from '../core/engine.js';
import { referencesFor } from '../core/references.js';
import { CONSISTENT_RATIO, SUSPECT_RATIO } from '../../../src/layers/l2-calibrate.js';
import { modeOf } from '../components/fingerprint-grid.js';

/**
 * @param {object} run   a stored run record
 * @param {{priorRuns?: number, onAgain?: Function, compact?: boolean}} opts
 */
export async function renderReport(run, { priorRuns = 0, onAgain = null } = {}) {
  const r = run.result ?? {};
  const box = h('div');

  if (run.tier === 'l0') return renderL0(run, box);

  const id = await identifyRun({ samples: run.samples, protocol: run.protocol, role: 'subject' });

  box.append(
    verdictCard({
      verdict: r.verdict, reason: r.reason, tier: run.tier,
      model: run.model, host: run.host,
      note: run.tier === 'l2' && run.sampled_control === false
        ? '这次没采对照模型：外壳没被测出来，任何外壳效应都算在了模型头上。'
        : null,
    }),
    // Order matters. A collapsed scale means the run could not calibrate at all, so it
    // outranks everything; a name from the identification layer outranks the "measure
    // again over time" advice, which would otherwise bury the actual finding.
    h('div', { style: { marginTop: 'var(--gap-2)' } },
      collapsedScaleNote(r)
        ?? namedElsewhereNote(run, r, id)
        ?? (r.verdict === 'consistent' ? stickinessNote({ priorRuns }) : null)));

  if (run.tier === 'l2') box.append(l2Numbers(run, r));
  if (run.tier === 'l1') box.append(l1Numbers(run, r));

  box.append(identification(run, id));
  box.append(await cellTable(run));
  box.append(rawStats(run, r));
  box.append(actions(run, onAgain));
  return box;
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
        title: 'S / H — 外壳能解释吗',
        subtitle: sampled
          ? '待验模型的跨端点距离，除以同一个对照模型的跨端点距离'
          : '没采对照：分母走噪声地板',
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
          : '未测量'),
        quantity('S  待验', r.s, r.s_c, `${run.model} 在两端之间的距离——被判定的就是它`),
        quantity('D  尺度', r.d, r.d_c, sampled
          ? `${short(run.model)} 与 ${short(run.control)} 在这个中转上相距多远`
          : '取自两份正版参照')),
      h('div.kv', { style: { marginTop: 'var(--gap-3)' } },
        h('dt', '噪声地板'), h('dd', fmt(r.noise_floor), h('span.faint', '  三个量都减掉了它')),
        h('dt', '分母依据'), h('dd', denominatorLabel(r.denominator_basis)),
        h('dt', '活格'), h('dd', `${r.live_cells}`),
        h('dt', '有效率'), h('dd',
          `待验 ${pct(r.subject?.valid_rate, 1)}`,
          r.control ? ` · 对照 ${pct(r.control?.valid_rate, 1)}` : ' · 对照未采')),
      r.low_confidence
        ? h('div.note.note--warn', { style: { marginTop: 'var(--gap-2)' } },
            h('div.note-title', '低置信'), h('p', '有效补全率在 20%–80% 之间，这次的分布是从残缺的样本里估的。'))
        : null),

    reasoningNote(r));
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
 * 🔴 The two layers answer different questions and can disagree, so when they do, say so
 * on the headline rather than leaving it to a reader who scrolls.
 *
 * The verdict layer must clear a deliberately conservative bar — the WHOLE S/D interval
 * above 0.7 — because the expensive mistake is accusing an honest relay. The
 * identification layer has no such bar: it just asks which of ten references the
 * distribution is shaped like, and a 9× separation from the runner-up is a strong answer
 * even when S/D's lower bound falls short of convicting.
 *
 * Measured exactly this way against a stub serving luna under the name sol: "证据不足"
 * over "最像 gpt-5.6-luna, 9.2×". Both true; showing only the first would mislead.
 */
function namedElsewhereNote(run, r, id) {
  if (!id?.named || id.best.model === run.model) return null;
  if (r.verdict === 'suspect') return null;   // the verdict already says it
  return h('div.note.note--warn',
    h('div.note-title', `判定没定罪，但这批分布明确像 ${id.best.model}`),
    h('p',
      `${run.tier.toUpperCase()} 的判定门槛是有意设保守的——定罪要求整个区间越线，`,
      '因为冤枉一家诚实中转的代价最高。指认层没有这个门槛：它只问「这批分布最像十个参照里的哪一个」。'),
    h('p',
      `这次的答案是 `, h('strong.mono', { style: { color: 'var(--brass)' } }, id.best.model),
      `（距离 ${fmt(id.best.value)}，比次近的 ${id.runnerUp.model} 近 ${fmt(id.separation, 1)} 倍）。`,
      run.model === id.runnerUp?.model
        ? `而你买的 ${run.model} 排在第二。`
        : ''),
    h('p.note-count', '两条都成立：证据不够到「指控」的强度，但分布的形状指向另一个型号。隔一段时间再测一次。'));
}

function identification(run, id) {
  if (!id.ranked.length) return null;

  const best = id.best;
  const worst = Math.max(...id.distances.map((d) => d.value).filter(Number.isFinite), 0.001);

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '指认'),
      h('h2.section-title', '这批分布，最像哪个官方型号'),
      h('p.muted', { style: { fontSize: 'var(--step--1)', maxWidth: '62ch' } },
        '判据是',
        h('strong', { style: { color: 'var(--ink)' } }, '与次近的分离度'),
        '，不是绝对距离。绝对距离里含着这个中转的外壳，而这一层没有对照可以扣——',
        '一个自建网关离它真正在发的模型都有 0.154。比值把外壳约掉了。')),

    h('div.card',
      id.named
        ? h('p', { style: { fontSize: 'var(--step-1)' } },
            '最像 ', h('strong.mono', { style: { color: 'var(--brass)' } }, best.model),
            '（', fmt(best.value), '），次近 ', h('span.mono', id.runnerUp.model),
            '（', fmt(id.runnerUp.value), '）—— 分离度 ',
            h('strong', `${fmt(id.separation, 1)}×`), '。')
        : h('p', { style: { fontSize: 'var(--step-1)' } },
            '说不准。最近的是 ', h('span.mono', best.model), '（', fmt(best.value), '），',
            id.runnerUp ? h('span', '但次近的 ', h('span.mono', id.runnerUp.model),
              '（', fmt(id.runnerUp.value), '）只差 ', h('strong', `${fmt(id.separation, 1)}×`),
              '，不够 2× 的门槛。') : '而参照库里只有这一个候选，没有可比的对象。'),
      h('p.faint', { style: { fontSize: 'var(--step--1)' } },
        `基于 ${id.cells} 个格子。`,
        id.named ? '' : ' 在最难分的一对上说「不确定」，是这个工具应该有的行为。'),
      h('div', { style: { marginTop: 'var(--gap-3)' } },
        ...id.distances
          .slice()
          .sort((a, b) => a.value - b.value)
          .map((d, i) => distanceBar({
            value: d.value, floor: 0, max: worst * 1.05,
            label: short(d.model),
            tone: i === 0 ? (id.named ? 'best' : 'same') : 'diff',
          })))));
}

/* ── per-cell detail ────────────────────────────────────────────────────── */

async function cellTable(run) {
  const refs = await referencesFor(run.protocol);
  const ref = refs.find((r) => r.model === run.model);
  if (!ref) return null;

  const measured = distributionOf(run.samples, 'subject');
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
