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

    section('结论是怎么下的', [
      h('p', '两步。先问「这批分布最像十个官方参照里的哪一个」。要指名道姓，',
        h('strong', '五条同时成立'), '：',
        h('strong', '离最近的比离第二近的近 2 倍以上'), '；',
        h('strong', { style: { color: 'var(--ink)' } }, '重抽格子 1000 次，最近的那个至少 95% 的次数还是它'),
        '（每次都对全部候选重新排名，不是只比固定的两个）；至少 12 个格子；',
        '这次跑回来的有效补全够多（丢格不随机，幸存的格子能一致地指向一个错的型号）；',
        '以及没有哪个覆盖不足的候选，在双方共有的格子上比它更近。',
        '还有一条前提：参照库得带够样本，算得出这次比较的分辨极限——算不出就不命名，而不是当作 0。',
        '不看绝对距离：绝对距离里含着这个网关的外壳，而分离度做比值时把它削弱掉——',
        '等量的加性外壳会把比值推向 1，也就是更难命名，方向是安全的。',
        h('strong', { style: { color: 'var(--ink)' } }, '但这不是「消掉」'),
        '：随模型或格子而异的扭曲能直接改变排名，这一层看不出来。'),
      h('p', '命名的结果不是你买的那个型号，就直接报出来。命名不了，才回落到下面这组区间，',
        '它只回答「差距有多大」，不回答「是什么」。'),
      h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', '量'), h('th', '定义'), h('th', '含义'))),
        h('tbody',
          h('tr', h('td', { class: 'answer' }, 'S'), h('td', '待验模型与正版参照的距离'), h('td', '被判定的就是它')),
          h('tr', h('td', { class: 'answer' }, 'H'), h('td', '网关外壳造成的差异'), h('td', '网页版不采对照，按 0 算，分母走噪声地板')),
          h('tr', h('td', { class: 'answer' }, 'D'), h('td', '两份正版参照之间的距离'), h('td', '真实模型差异的尺度'))))),
      h('p', { style: { marginTop: 'var(--gap-2)' } },
        h('strong', 'S/H 的 90% 区间整段 < 1.5 → 一致'), '；',
        h('strong', 'S/D 的 90% 区间整段 ≥ 0.7 → 疑似替换'), '；之间 → 证据不足。'),
      h('div.note',
        h('div.note-title', '两个方向都要求整个区间越线'),
        h('p', '这条对称性是硬要求。早先的版本判无罪要区间、定罪只看点估计——',
          '对一个「冤枉诚实中转」代价最高的工具，那个方向反了。',
          '实测代价：同一端点相隔一小时的两次跑，S/D 是 1.04 和 0.64，被写成「疑似替换」和「证据不足」，',
          h('strong', '差一个样本'), '。')),
      h('div.note',
        h('div.note-title', '为什么定罪主要靠指认，而不靠 S/D'),
        h('p', 'S/D 的分母是「另一个型号有多远」，而掺假一定掺',
          h('strong', '最近的邻居'), '——更便宜、名字像、行为接近。',
          '拿一个远型号当尺度，等于要求掺假必须掺得比最离谱的还离谱：十个参照里有八个，',
          '「换成最近邻」在零外壳、无限探针下也够不到 0.7 那条线。'),
        h('p', '指认层问的是形状而不是距离，所以不受这个限制。实测四次已确认的掺假：',
          'S/D 一次都没定罪，指认层四次全部定罪并指名；五次已确认的正版，两条路都没有冤枉。')),
      h('div.note',
        h('div.note-title', '参照会过期，但过期只是警告，不是免罪'),
        h('p', '厂商基本是发新的 model id，很少把旧 id 背后的权重悄悄换掉——所以参照超过 90 天时，',
          '判定照常给出，只是会明确告诉你「参与排名的最旧参照是多少天前采的」，',
          '并提醒：万一厂商真在这期间动过手，一家诚实的中转也会长成这样。'),
        h('p.faint', '年龄取的是参与排名的',
          h('strong', '所有'), '参照里最旧的那一份，不只是你买的那个型号。')),
      h('div.note',
        h('div.note-title', '这些门槛是 in-sample 的，别当成已验证'),
        h('p', '2 倍分离度、12 格下限，都是对着这十来次存量测量定的，然后用同一批数据"验证"。',
          '诚实的说法是「在我们手上这些数据上它没出过错」——比听起来弱得多：',
          '没有留出集，没有第二个采集时期，没有带区间的误报率。'),
        h('p', '所以定罪的每一条都设得保守：分离度要过 2 倍、重抽格子时那个名字要在 95% 的抽样里',
          '仍然排第一、格子不少于 12 个、分母以噪声地板兜底、',
          '没有哪个覆盖不足的候选比它更近。有效率不达标时只报告不定罪。宁可说「测不出来」。')),
    ]),

    section('为什么网页版不采对照模型', [
      h('p', '原本有第三个测量：再采一个「双方都提供、且确定是正版」的对照模型，它的跨端点距离就是纯外壳，',
        '量出来再从 S 里扣掉。网页版把它去掉了，三个理由。'),
      h('p', h('strong', '一、它的前提正好是你要查的东西。'),
        '实测抓到过：某端点 H 0.33、S 0.23，S/H 区间整段在 1.5 以下，判「一致」。',
        '但它的 D 塌到 0.079（低于噪声地板 0.083），意味着这个端点上两个模型名',
        h('strong', '几乎分不出来'), '，而官方把这两个模型拉开 0.384——',
        '两个名字都被换了，两个错误互相抵消。这是这个工具能产生的最危险的结果。'),
      h('p', h('strong', '二、选哪个对照会改变判决。'),
        '同一批样本，换一个对照就在「疑似替换」和「证据不足」之间翻面。',
        '而正确的选择取决于对方掺的是什么——那正是待查的问题。'),
      h('p', h('strong', '三、实测它基本量不到东西。'),
        '在这条线上，八次可信的测量里有六次外壳低于噪声地板，第七次也只有 1.08 倍。',
        '它却要花掉一倍探针。把存量结果全部按「不采对照」重判，没有一个正版端点掉出绿灯，',
        '倒是上面那个假绿灯翻成了「证据不足」。'),
      h('p.faint', '代价说清楚：如果一家网关真的把答案分布改动很大，那部分现在会算到模型头上。',
        '要单独量外壳，用命令行版带对照跑。'),
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
