import { h, fmt } from '../ui/dom.js';
import { loadMatrix, referencesFor } from '../core/references.js';
import { heatmap, short } from '../components/heatmap.js';
import { fingerprintGrid, displayCells } from '../components/fingerprint-grid.js';
import { classifyPair } from '../../../src/layers/model-matrix.js';

const PROTOCOL = 'responses';

/**
 * The model map answers the question that has to be settled before any verdict means
 * anything: can this method tell these models apart at all?
 *
 * It costs zero requests — everything here was measured once against the official API and
 * shipped with the page — so it doubles as the thing a visitor can look at before deciding
 * whether to hand the site a key.
 */
export async function view() {
  const matrices = await loadMatrix();
  const m = matrices[PROTOCOL];
  const refs = await referencesFor(PROTOCOL);

  const pairs = [];
  for (let i = 0; i < m.models.length; i += 1) {
    for (let j = i + 1; j < m.models.length; j += 1) {
      pairs.push({
        a: m.models[i], b: m.models[j], d: m.matrix[i][j],
        bar: Math.max(m.floors[i], m.floors[j]),
        klass: classifyPair(m.matrix[i][j], m.floors[i], m.floors[j]),
      });
    }
  }
  pairs.sort((x, y) => (x.d / x.bar) - (y.d / y.bar));
  const closest = pairs[0];
  const unresolvable = pairs.filter((p) => p.klass === 'indistinguishable');

  return h('div.page',
    h('div.eyebrow', '型号地图 · 0 请求'),
    h('h1', { style: { fontSize: 'var(--step-3)', fontWeight: '300', margin: 'var(--gap-2) 0 var(--gap-2)' } },
      '这个方法分得开哪些型号'),
    h('p.muted.prose',
      '官方 API 上能采到指纹的 ', h('strong', String(m.models.length)), ' 个现代型号，两两之间的距离。',
      '判定一个中转「不是 sol」之前，得先知道 sol 和它的邻居本来隔多远——这张表就是那个尺度。'),

    h('div.grid-3', { style: { marginTop: 'var(--gap-4)' } },
      h('div.card', h('div.stat',
        h('div.stat-label', '最难分的一对'),
        h('div.stat-value', `${fmt(closest.d / closest.bar, 1)}×`),
        h('div.stat-note', `${short(closest.a)} ↔ ${short(closest.b)}`),
        h('div.stat-note.faint', `JSD ${fmt(closest.d)}，地板 ${fmt(closest.bar)}`))),
      h('div.card', h('div.stat',
        h('div.stat-label', '落进噪声地板的对'),
        h('div.stat-value', String(unresolvable.length)),
        h('div.stat-note', unresolvable.length
          ? unresolvable.map((p) => `${short(p.a)}↔${short(p.b)}`).join('、')
          : `${pairs.length} 对全部可分`))),
      h('div.card', h('div.stat',
        h('div.stat-label', '地板跨度'),
        h('div.stat-value', `${fmt(Math.min(...m.floors), 3)}–${fmt(Math.max(...m.floors), 3)}`),
        h('div.stat-note', '各模型自己的噪声差 3 倍'),
        h('div.stat-note.faint', '所以不能共用一个绝对阈值')))),

    h('section.section', heatmap(m)),

    h('div.note', { style: { marginTop: 'var(--gap-4)' } },
      h('div.note-title', '为什么对角线不是 0'),
      h('p', '同一个模型采两次，结果也不会完全一样——有限次采样本身就有散布。',
        '这个散布就是噪声地板，放在对角线上，读者不需要知道本项目的任何阈值也能读这张表：',
        h('br'),
        '某个格子 ≈ 它所在行的对角线 → 分不出来；远大于两条对角线 → 真的是不同模型。')),

    await examples(refs, m));
}

/**
 * Show the closest pair as answers, not numbers. "0.14 apart" means nothing until you see
 * that they agree on 34 cells and disagree on 5.
 */
async function examples(refs, m) {
  const models = m.models;
  const cells = displayCells(refs, { total: 16, stable: 4 });
  const grid = fingerprintGrid({ cells, refs, model: models[0] });
  const diff = h('div.demo-diff');

  const picker = h('select.select', {
    style: { width: 'auto' },
    'aria-label': '选择模型',
    onchange: (e) => {
      const changed = grid.setModel(e.target.value);
      diff.replaceChildren(changed.length
        ? h('span', h('strong', `${changed.length} 格`), ' 换了答案')
        : h('span', '这 16 格全部相同'));
    },
  }, ...models.map((mm) => h('option', { value: mm }, mm)));

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '同一张表，换个读法'),
      h('h2.section-title', '距离长什么样'),
      h('p.muted', { style: { fontSize: 'var(--step--1)', maxWidth: '62ch' } },
        '12 个有区分度的格子，加 4 个所有型号都给同一个答案的。挨个切模型看：',
        '后面那 4 格从头到尾不动——它们对这批模型没有鉴别力，L2 会自动把这类死格剔掉，',
        '把采样预算全花在会动的格子上。'),
      h('p.muted', { style: { fontSize: 'var(--step--1)', maxWidth: '62ch' } },
        '也说明伪造为什么难：要冒充一个型号，得同时匹配 40 格 × 4 种语言的完整分布，',
        '包括在哪些格子上应该跟别人一样。')),
    h('div.hero-demo', { style: { marginTop: 0 } },
      h('div.demo-bar', h('span.demo-label', '模型'), picker, diff),
      grid.el));
}
