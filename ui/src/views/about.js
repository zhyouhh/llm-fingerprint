import { h, fmt } from '../ui/dom.js';
import { referencesFor, loadMatrix, STALE_DAYS, ageInDays } from '../core/references.js';
import { ALLOWED_SUFFIXES } from '../../worker/proxy.js';

const PROTOCOL = 'responses';

export async function view() {
  const refs = await referencesFor(PROTOCOL);
  const m = (await loadMatrix())[PROTOCOL];

  return h('div.page.page--narrow',
    h('div.eyebrow', '方法'),
    h('h1', { style: { fontSize: 'var(--step-3)', fontWeight: '300', margin: 'var(--gap-2) 0 var(--gap-3)' } },
      '它测的是什么，测不了什么'),

    section('一个 token 就够', [
      h('p', '给模型一个固定的问题（「随便说一个 1 到 100 的整数」），温度设 1，只要 1 个输出 token，重复 30 次。',
        '得到的不是一个答案，是一个',
        h('strong', '分布'), '——比如 47 占 93%、57 占 7%。'),
      h('p', '这个分布对权重非常敏感，而对提示词包装相对不敏感。',
        '10 个任务 × 4 种语言 = 40 个格子，拼起来就是一个模型的指纹。'),
      h('p', '两个指纹的距离用 Jensen-Shannon 散度（底数 2，值域 [0,1]），对双方都有足够样本的格子取平均。'),
      h('p.faint', '复现自 Bruckner, T. (2026) One Token Is Enough，arXiv:2607.10252。',
        '归一化与 JSD 的实现逐字复用上游 MIT 代码，用论文公开的输入输出对拍过：',
        '归一化 335,889 条逐字段一致，AUC 0.971342 / EER 0.07282 精确复现。'),
    ]),

    section('为什么必须有对照模型', [
      h('p', '不同网关把请求包进不同外壳。跨端点直接比指纹，差异里混着「外壳不同」和「模型不同」，分不开。',
        '论文没遇到这个问题，因为它只在 OpenRouter 单一环境采集。'),
      h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', '量'), h('th', '定义'), h('th', '含义'))),
        h('tbody',
          h('tr', h('td', { class: 'answer' }, 'H'), h('td', '对照模型在两端之间的距离'), h('td', '纯外壳差异（模型确定相同）')),
          h('tr', h('td', { class: 'answer' }, 'S'), h('td', '待验模型在两端之间的距离'), h('td', '待判定')),
          h('tr', h('td', { class: 'answer' }, 'D'), h('td', '待验与对照之间的距离'), h('td', '真实模型差异的尺度'))))),
      h('p', { style: { marginTop: 'var(--gap-2)' } },
        h('strong', 'S/H 的 90% 区间整段 < 1.5 → 一致'), '；',
        h('strong', 'S/D 的 90% 区间整段 ≥ 0.7 → 疑似替换'), '；之间 → 证据不足。'),
      h('div.note',
        h('div.note-title', '两个方向都要求整个区间越线'),
        h('p', '这条对称性是硬要求。早先的版本判无罪要区间、定罪只看点估计——',
          '对一个「冤枉诚实中转」代价最高的工具，那个方向反了。',
          '实测代价：同一端点相隔一小时的两次跑，S/D 是 1.04 和 0.64，被写成「疑似替换」和「证据不足」，',
          h('strong', '差一个样本'), '。')),
    ]),

    section('最危险的假绿灯', [
      h('p', '对照校准法的承重假设是「对照模型在两端都是正版」。假设一破，H 就不是外壳测量，',
        '「外壳解释了差距」会变成「两个替换互相抵消」。'),
      h('p', '实测抓到过：某端点 H 0.33、S 0.23，S/H 区间整段在 1.5 以下，代码原本判「一致」。',
        '但它的 D 塌到 0.079——低于噪声地板 0.083——意味着这个端点上两个模型名',
        h('strong', '几乎分不出来'), '，而官方把这两个模型拉开 0.384。'),
      h('p', '所以现在 ', h('code', 'D < 噪声地板'), ' 会挡住',
        h('strong', '所有'), '判定，而不只是挡住「疑似替换」。'),
      h('p.faint', '注意：不采对照时抓不到这一类——D 那时取自两份参照，按构造就是正版模型对的距离，永远不塌。'),
    ]),

    section('已知盲区', [
      bullet('reasoning effort 降档', '答案分布看不出「同一个模型跑在低推理档」。这一层的判定不包含它，只单独报 reasoning 痕迹率当参考。'),
      bullet('低比例掺假', '掺假比例 ε ≤ 0.2 时检不出来。两篇独立论文互相印证这条边界（arXiv:2504.04715、arXiv:2607.20860）。不假装能覆盖。'),
      bullet('蓄意伪造', '对手知道我们查什么就能对着调。要匹配 40 格 × 4 语言的完整分布比背固定答案难得多，但不是不可能。'),
      bullet('厂商原始权重', '证明不了。那需要厂商对响应做密码学签名，业界尚无。能证明的是「与已知正版参照一致 / 不一致」。'),
      bullet('单次结论', '轮换是粘性的——一个格子的 15 次采样整批落在同一后端。单次 L2 等于抽一次签。'),
    ]),

    section('参照库', [
      h('p', `本站带 ${refs.length} 份正版参照，全部采自 OpenAI 官方 API 的 responses 线（40 格 × 30 次）。`,
        '官方按定义就是 ground truth，而且它的外壳只有 ~7 token，H 项拉得开。'),
      h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', '型号'), h('th', '采集时间'), h('th', { class: 'num' }, '格子'), h('th', { class: 'num' }, '噪声地板'), h('th', '状态'))),
        h('tbody', ...refs.map((r) => {
          const idx = m.models.indexOf(r.model);
          const age = ageInDays(r.collected_utc);
          const stale = age != null && age > STALE_DAYS;
          return h('tr',
            h('td', { class: 'answer' }, r.model),
            h('td', r.collected_utc?.slice(0, 10) ?? '—'),
            h('td', { class: 'num' }, Object.keys(r.fingerprint ?? {}).length),
            h('td', { class: 'num' }, idx >= 0 ? fmt(m.floors[idx]) : '—'),
            h('td', stale
              ? h('span.pill', { dataset: { tone: 'bad' } }, h('span.pill-glyph', '!'), `${Math.round(age)} 天`)
              : h('span.pill', { dataset: { tone: 'ok' } }, h('span.pill-glyph', '✓'), '新鲜')));
        })))),
      h('p.faint', { style: { marginTop: 'var(--gap-2)' } },
        `参照超过 ${STALE_DAYS} 天会标黄：厂商换过权重之后，旧参照就不代表正版了。`),
    ]),

    section('隐私：key 到底经过了什么', [
      h('p', { id: 'privacy' },
        '统计和判定全部在你的浏览器里跑——', h('code', 'src/'), ' 的代码原样打包进这个页面，',
        '跟命令行版是同一份实现。'),
      h('p', '需要服务端的只有一件事：浏览器不能直接请求你的中转（它不会给 CORS 头，',
        '而且跨源请求读不到响应头，L0 的端点识别就靠那些头）。所以有一层转发。'),
      h('div.card',
        h('div.card-title', '那层转发做的全部事情'),
        h('ul', { style: { margin: 0, paddingLeft: '1.2em', color: 'var(--ink-dim)', fontSize: 'var(--step--1)' } },
          h('li', '把 ', h('code', '/p/<host>/<path>'), ' 还原成 ', h('code', 'https://<host>/<path>'), ' 并转发'),
          h('li', '请求头只放行三个：', h('code', 'authorization'), '、', h('code', 'content-type'), '、', h('code', 'accept'),
            '——白名单不是黑名单，免得把你浏览器加的其它头也送给中转'),
          // A flex-wrap container, not a run of inline <code>: adjacent code elements with
          // no whitespace between them offer the line breaker nowhere to break, and the
          // list pushed the whole page into a horizontal scroll at 390px.
          h('li', '只转发结尾命中白名单的路径：',
            h('span.chips', ...ALLOWED_SUFFIXES.map((s) => h('code', s)))),
          h('li', '目标必须 https，不接受 IP 字面量、localhost、.internal / .local'),
          h('li', '响应头原样回传（去掉 content-encoding 这类描述传输的）'),
          h('li', h('strong', { style: { color: 'var(--ink)' } }, '不记录 URL、不记录 key、不记录请求体或响应体')))),
      h('p', { style: { marginTop: 'var(--gap-2)' } },
        '它没有 KV、没有数据库、没有 Durable Object——',
        h('strong', '结构上就没有能存 key 的地方'), '。这也是为什么计算不放在服务端跑：',
        'L2 要 7 分钟，服务端后台任务必须把 key 写进存储才能跨批次存活，那才是真落盘。'),
      h('div.note', { style: { marginTop: 'var(--gap-2)' } },
        h('div.note-title', '副作用：出口位置是 Cloudflare 的，不是你的'),
        h('p', '探针从离你最近的 Cloudflare 边缘节点发出。如果目标端点按地区封锁，你会拿到它的地区拒绝而不是探测结果——',
          '实测从香港节点访问 OpenAI 官方 API 会收到 ',
          h('code', 'unsupported_country_region_territory'),
          '。第三方中转一般不做这种限制，但直连官方 API 时可能撞上。')),
      h('p.faint', '结果存在你这台设备的 IndexedDB 里，没有账号、没有上传。写入前有一道正则拦截，',
        '任何形似 API key 的东西都会让写入直接抛错而不是被悄悄清洗。'),
    ]),

    section('来源与许可', [
      h('div.kv',
        h('dt', '论文'), h('dd', 'Bruckner, T. (2026). One Token Is Enough. arXiv:2607.10252'),
        h('dt', '数据集'), h('dd', '10.5281/zenodo.21278557 · CC-BY-4.0 · 已做子集化与重排'),
        h('dt', '上游代码'), h('dd', '10.5281/zenodo.21278793 · MIT · 逐字复用未改写'),
        h('dt', '本站'), h('dd', h('a', { href: 'https://github.com/zhyouhh/llm-fingerprint', rel: 'noopener' }, 'github.com/zhyouhh/llm-fingerprint'))),
    ]));
}

function section(title, children) {
  return h('section.section',
    h('div.section-head', h('div.eyebrow', title)),
    h('div.prose', ...children));
}

function bullet(title, body) {
  return h('div.note', { style: { marginBottom: 'var(--gap-2)' } },
    h('div.note-title', title), h('p', body));
}
