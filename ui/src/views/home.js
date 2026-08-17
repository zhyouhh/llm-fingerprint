import { h } from '../ui/dom.js';
import { referencesFor } from '../core/references.js';
import { fingerprintGrid, displayCells } from '../components/fingerprint-grid.js';
import { short } from '../components/heatmap.js';

const HERO_PROTOCOL = 'responses';
const HERO_CELLS = 16;

export async function view() {
  const refs = await referencesFor(HERO_PROTOCOL);

  return h('div.page',
    hero(refs),
    how(),
    limits());
}

/**
 * The hero is the fingerprint itself.
 *
 * Not a headline over a gradient: the reader picks a model and watches which of sixteen
 * one-token answers change. That single interaction carries the entire method — a model's
 * fingerprint is the words it keeps choosing, and a substituted model chooses differently
 * in a handful of cells while agreeing everywhere else. No paragraph does that job as
 * quickly, and every value on screen is real collected data.
 */
function hero(refs) {
  // Ordered so the two the project actually caught swapping sit next to each other.
  const preferred = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.4', 'gpt-5.5', 'gpt-5.3-codex'];
  const models = [...preferred.filter((m) => refs.some((r) => r.model === m)),
                  ...refs.map((r) => r.model).filter((m) => !preferred.includes(m))];

  if (!models.length) {
    return h('section.hero', h('h1.hero-title', '指纹核验'),
      h('p.hero-lede', '参照库还没构建——先跑 `npm --prefix ui run data`。'));
  }

  const cells = displayCells(refs, { total: HERO_CELLS, stable: 4 });
  const grid = fingerprintGrid({ cells, refs, model: models[0] });
  const diff = h('div.demo-diff');

  const picker = h('select.select', {
    style: { width: 'auto', minWidth: '13ch' },
    'aria-label': '选择要显示指纹的模型',
    onchange: (e) => {
      const changed = grid.setModel(e.target.value);
      diff.replaceChildren(changed.length
        ? h('span', h('strong', `${changed.length} 格`), ' 换了答案')
        : h('span', '这 16 格全部相同'));
    },
  }, ...models.map((m) => h('option', { value: m }, m)));

  return h('section.hero',
    h('div.eyebrow', '单 token 指纹'),
    h('h1.hero-title', '你的中转，还是', h('em', '它说的那个模型'), '吗'),
    h('p.hero-lede',
      '付的是旗舰款的钱，后端可能是量化版、同族小模型，甚至别家的开源权重——而且通常不是一开始就换，',
      '是跑一阵后悄悄降配。每次探测只花 1 个 output token。'),

    h('div.hero-actions',
      h('a.btn.btn--primary', { href: '/run' }, '检测我的中转 →'),
      h('a.btn', { href: '/map' }, '先看看型号地图'),
      h('span.faint', { style: { fontSize: 'var(--step--1)' } },
        'key 只在你的浏览器里，服务端没有能存它的地方')),

    h('div.hero-demo',
      h('div.demo-bar',
        h('span.demo-label', '模型'),
        picker,
        h('span.demo-label', { style: { marginLeft: 'var(--gap-2)' } }, '在 T=1 下最常给出的答案'),
        diff),
      grid.el),

    h('p.faint', { style: { marginTop: 'var(--gap-2)', fontSize: 'var(--step--1)' } },
      '官方 API 实采的真实分布（40 格 × 30 次，这里取 12 个有区分度的 + 4 个所有型号都一样的）。',
      '换成 ', h('code', short('gpt-5.6-luna')), ' 试试：它是 ', h('code', short('gpt-5.6-sol')),
      ' 的同代兄弟，也正是实测中被两家中转拿来冒名的那个。',
      h('br'),
      // 🔴 <bdi> around each Arabic word. Without it the bidi algorithm reorders the whole
      // run and "زرافة→فيل" renders as "فيل→زرافة" — the arrow appears to point the wrong
      // way, which is exactly backwards for an example about which answer replaced which.
      h('bdi', 'زرافة'), '→', h('bdi', 'فيل'), '、turquoise→teal、鹤→澜、47→73',
      ' —— 这几格就是当时认出它的线索。'));
}

function how() {
  const steps = [
    ['L0', '画像', '0 + ~24 次',
     '端点类型、注入了多少 token 的外壳、透不透传 reasoning effort。谎称「官方 API 直连」当场戳穿，不需要任何参照。'],
    ['L1', '快筛', '15 次',
     '拿 3 个最有区分力的格子对本地正版参照。绿灯就到此为止——这一层便宜到可以天天跑。'],
    // Deliberately a range, not a figure: the probe count is 活格数 × 15, and how many
    // cells are live depends on the model. The run page computes the real number before
    // anything is sent.
    ['L2', '精确校准', '约 400 次',
     '把每个有区分力的格子都采满，然后问「这批分布最像十个官方型号里的哪一个」。掺假的话，它会指名道姓。'],
  ];

  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '三层，成本逐层放大'),
      h('h2.section-title', '先花 15 次问「还是不是它」，不行再上重的')),
    h('div.grid-3',
      ...steps.map(([tier, name, cost, what]) => h('div.card',
        h('div.tier-cost', `${tier} · ${cost}`),
        h('div.card-title', name),
        h('p.muted', { style: { fontSize: 'var(--step--1)' } }, what)))),

    h('div.card', { style: { marginTop: 'var(--gap-3)' } },
      h('div.card-title', '为什么答案是「像哪个型号」，而不是一个分数'),
      h('p.muted',
        '不同网关把请求包进不同外壳——注入的系统提示词长度不同、参数透传程度不同。',
        '所以跨端点直接比指纹，一个绝对距离里混着「外壳不同」和「模型不同」，分不开。'),
      h('p.muted',
        '解法是不看绝对距离，看',
        h('strong', { style: { color: 'var(--ink)' } }, '与次近型号的分离度'),
        '：外壳把所有候选等量推远，做比值时就约掉了。剩下的是这批分布真正的形状。'),
      h('p.faint', { style: { fontSize: 'var(--step--1)' } },
        '实测：一家中转把 gpt-5.6-sol 和 gpt-5.4 两个名字都发成 gpt-5.6-luna，',
        '两次都被指名道姓认了出来——而按分数判，它只到「证据不足」。')));
}

function limits() {
  return h('section.section',
    h('div.section-head',
      h('div.eyebrow', '这个工具做不到什么'),
      h('h2.section-title', '先说清楚边界')),
    h('div.grid-2',
      h('div.note.note--warn',
        h('div.note-title', '一次绿灯 ≠ 这个端点干净'),
        h('p', '轮换是粘性的：一个格子的 15 次采样整批落在同一个后端，单次测量等于抽一次签。',
          '实测见过同一端点相隔一小时，一次真、一次假。跨时间多测几次才有把握。')),
      h('div.note',
        h('div.note-title', '看不见 reasoning 降档'),
        h('p', '「同一个模型跑在更低推理档」不会改变单 token 答案分布。要抓这个得靠硬推理题的正确率，不在本站范围内。')),
      h('div.note',
        h('div.note-title', '目前只覆盖 OpenAI / Codex 系'),
        h('p', '参照库是 10 个官方型号（responses 线）。测 Claude 或其他家只能跑 L0 画像，L1/L2 没有参照可比。')),
      h('div.note',
        h('div.note-title', '不能证明是厂商原始权重'),
        h('p', '那需要厂商对响应做密码学签名，业界尚无。本方法能证明的是「与已知正版参照一致 / 不一致」。'))),
    h('p.faint', { style: { marginTop: 'var(--gap-3)', fontSize: 'var(--step--1)' } },
      h('a', { href: '/about' }, '完整的方法说明与已知盲区 →')));
}
