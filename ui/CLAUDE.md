# ui/ — 网页版（里程碑 2）

把 CLI 的 L0 / L1 / L2 搬上网页，部署在 `llmfingerprint.z0y0h.work`。
**公开访问**，任何人可以拿自己的中转 URL + key 测。

## 🔴 一句话架构：计算在浏览器，Worker 只转发

```
浏览器（真正的引擎）                    Cloudflare Worker（薄代理）        中转端点
  ├ import ../src/**  统计与判定  ──►   GET/POST /p/<host>/<path>  ──►   真实 API
  ├ IndexedDB  样本 / 历史 / 断点
  └ key 只在内存与请求头里
```

三条理由，按重要性排：

1. **key 不落任何盘**。L2 要 ~420 次请求跑 ~3 分钟。放服务端后台任务（Durable Object）
   就必须把 key 写进 DO storage 才能跨批次存活——那是真落盘。放浏览器跑，Worker 是
   无状态转发，**结构上没有能存 key 的地方**。
2. **免费版够用**。Workers 免费版每请求 10ms CPU，跑不动 bootstrap 的 1000 次重抽样；
   纯转发绰绰有余。$0/月。
3. **零副本复用 `src/`**。统计层是零依赖纯 ESM，Vite 直接打包进来，判定逻辑只有一份。

代价：**关掉标签页任务就断**。缓解而不是消除：采样过程中样本持续落 IndexedDB，
中断后回来能看到、导出、并按已采部分判定；离开页面前有拦截提示。

🔴 **没有做格子级断点续跑**，这是有意的。要做得干净必须让 `runBattery` 认识「已采样本」，
否则就得在 `ui/` 里重写一遍 `calibrateL2` 的编排——而那 30 行编排正是
「`makeL2Result` 把算好的 `reason` 整个丢掉」那类 bug 的产地。少一个功能，
比多一份会漂移的副本便宜。

## 🔴 代理的形状：路径改写，不是请求转发

Worker 不接受「把这个 URL 帮我请求一下」这种 body——那种形状要前端拼 JSON、Worker 解 JSON，
两边都要改，而且 `src/probe/http/` 一行都不能复用。

改成**把目标写进路径**，出站层完全不知道代理存在：

| | 值 |
|---|---|
| 真实端点 | `https://relay.com/v1` |
| 传给 `createResponsesClient` 的 `baseUrl` | `https://llmfingerprint.z0y0h.work/p/relay.com/v1` |
| 出站层拼出 | `.../p/relay.com/v1/responses` |
| Worker 还原 | `https://relay.com/v1/responses` |

于是 **`src/probe/http/{transport,chat,responses,get}.js` 零改动**：
- `Authorization` 头是同源请求，浏览器自动带上，Worker 原样转发
- 响应头因为同源而能被前端**完整读到**（L0 认 `x-oneapi-request-id` 靠它），
  Worker 必须原样透传响应头，只剔除 `content-encoding` / `content-length` / `transfer-encoding` / `set-cookie`
- 目标只允许 `https`，端口写在 host 段（`/p/relay.com:8443/v1/...`）

## 🔴 参照瘦身：只能去掉 samples 的字段，不能改顺序

`reference/responses/*.json` 每份 ~220KB，95% 是 `samples`（1200 条完整记录）。
构建时压成 ~15KB：

```json
{ "fingerprint": {cell: {answer: prob}},        // 判定直接用
  "answers":     {cell: ["47","47","57", ...]}  // 重建 samples 用
}
```

`answers` 是**按原顺序**的 valid 答案数组。顺序是硬要求：`noiseFloor` 里
`drawWithReplacement(pool, reps, rng)` 按索引抽，换序会让噪声地板漂移——而噪声地板是
L2 判据的分母之一。**排序 / 去重 / 计数压缩都不行。**

`scripts/build-data.js` 跑完必须自证：瘦身参照与原参照算出的
`selectCells` / `noiseFloor` / `evaluateL2` **逐位相同**，不同就退出码 1。
这是本目录唯一的正确性承重测试，对应 [[silent-comparison-mismatch]] 那一类失效。

🔴 `evaluateL2` 那一项要把**整个参照库**两侧都喂进去（`refs: fulls` vs `refs: leans`）：
指认路径对全部十份参照排名，只证一对无损，说明不了一个要排十份的判定。

## 🔴 网页版不采对照模型，且判定以「指认」为准

两条与 CLI 有意不同的地方。**统计与判定代码仍然只有一份**——这里改的是「采什么」和
「先说哪一句」，不是怎么算。

**① `sampleControl` 默认 `false`，界面上没有对照相关的任何控件。**
对照校准法的承重假设是「对照模型在两端都是正版」，而那正是这次跑要查的东西：实测有中转把
`gpt-5.6-sol` 和 `gpt-5.6-terra` 两个名字都发成 luna，选 terra 当对照就把一个被换掉的模型
放进了分母。更糟的是**选哪个对照会改判决**——同一批 840 个样本，换个对照就在「疑似替换」和
「证据不足」之间翻面。一个没人答得对的下拉框不该决定一家中转有没有被定罪。

去掉它同时去掉了那个陷阱：H 被替换掉的对照顶高，才会出现「两个替换互相抵消 → 假绿灯」。
不采对照时 H 按构造为 0、分母走噪声地板，这个失效模式不存在。
把存量结果全部按不采对照重判：**没有一个正版端点掉出绿灯**（含外壳最重的自建网关），
而那个假绿灯翻成了 inconclusive。代价是外壳没被量出来，会算到模型头上——
实测八次可信测量里六次外壳低于噪声地板、第七次 1.08 倍，所以这个代价很小但**必须写在报告里**
（`noControlNote`）。要真的量外壳，用 CLI 带对照跑。

`pickControl` 因此变成纯离线的「尺度模型」，两个职责都不发请求：`selectCells` 的配对、
以及 `evaluateL2` 里 D 的取值。它不再按端点在售的型号过滤——只卖一个有参照的模型的端点
以前跑不了 L2，那个限制没有理由。
⚠️ 它仍取**最远**的型号，这对选格子是对的，对 D 是错的：掺假掺的是最近邻，而拿最远的当尺度
会让十个参照里的八个在结构上够不到 0.7 那条定罪线。**这条没有被修，是被绕过去了**——
定罪路径已经换成指认层（见主 CLAUDE.md「定罪靠指认」），S/D 只管参照库以外的东西，
所以「D 的尺度取最远」不再决定任何一次真实定罪。要真修它得重新定义 D 该拿谁当尺度。

🔴 **`identifyRun` 必须把和 `evaluateL2` 一样的输入喂给 `identification()`**，不只是同一个函数。
它曾经传一个扁平的 `repsPerCell`、且**根本不传有效率**——于是一次被 `evaluateL2` 压成
inconclusive 的跑，**有人一打开报告就自己把自己重新定罪了**。现在 `distributionOf` 返回
`{dist, reps}`（逐格实际样本数），而**有效率必传、且来自存下来的 `result.subject.valid_rate`**
——它的分母按契约是**计划的**逻辑样本数，从 `samples.length` 反推会漏掉「压根没进数组的失败」，
一份中途保存的记录于是读成 100% 有效。同理 `clientsFor` 的 `cancelled` 必传（可显式 `null`）：
L2 的 preflight 曾经漏传，而漏传和「本来就没有取消路径」长得一模一样。
🔴 `distributionOf` 还必须**按 `model` 分侧**（`rejudge` 就是这么分的），且要求**每一行**都带
`model`/`role`——`role` 不是契约字段，一份完全没标签的存档曾被整个算进 subject，
15 个 A 和 15 个 B 合成一格 30 样本的 50/50 分布。

🔴 **每个 tier 有自己的尺度模型，门槛不一样**。L1 只要 3 个**有区分度**的格子，
指认要 12 个。一个布尔量管两个 tier 时，只够 L1 的对照照样让页面开出 L2 并承诺
「告诉你是哪个型号」——花 150 次探针换一个注定 `withheld: 'cells'` 的结果。
判定在 `engine.js` 的 `tierAvailability()`（**它自己调两次 `pickControl`**，
门槛数字在被测函数内部；曾经把它们留在 view 闭包里，改回 3 也没有测试会红）。
⚠️ 数的是**活格**不是共有格：`matrix.cells` 是「两边都能比」，而 `selectCells` 之后还会丢掉
双方答案相同的死格——40 个共有格里只有 2 个有区分度的候选能过共有格门槛，然后 L1 和 L2 双双拒跑。

**② headline 来自指认层，判据区间退到折叠区。**
`headline()` 在 `components/verdict.js`，它**不算任何数、不套任何门槛**——分离度和格子下限
都在 `src/layers/model-matrix.js` 的 `identification()` 里，CLI 和 golden test 看得见同一份。
它只在 `evaluateL2` 的 verdict 和 `identification.impostor` 之间排先后。

⚠️ 2026-08-17 傍晚起 `evaluateL2` 自己也认这条路（`impostor → suspect`），所以两者通常一致；
排先后的逻辑保留，是为了**那之前存下来的历史结果**——`identifyRun` 对存量样本**重算**而不是
读存下来的 verdict，理由和 `rejudge` 一样：存下来的是当天的口径，参照库后来还长了。

🔴 **凡是印「N 倍」的地方，都得点名分母。** 分离度除的是 `max(distance, floor)`，而真掺假
恰好是近距离匹配、地板必然生效——于是 headline 写着「离它 0.0460，离第二近的 0.3918——远 3.2 倍」，
读者一除得 8.5，没法判断哪个错。分母（地板 0.1234）明明就印在下一行，只是没连起来。
定义只有一份：`scaleOf(id)` 在 `components/verdict.js`，headline 与 `report.js` 的阶梯共用，
`ui/test/smoke.test.js` 有一条钉着「屏幕上每个倍数，除的两个数也在屏幕上」。

判定词汇**只有一套**：`history.js` 的行也走 `headlinePill()`，否则时间线上写「证据不足」、
点开的报告写「实际发的是 luna」，等于把要修的困惑挪到隔壁页。

## 🔴 `src/` 的解耦规则：拆文件，不许复制

浏览器唯一跑不了的是 `src/normalize/index.js` 的 `node:fs`。解法是**拆**：

| 文件 | 内容 | 谁能 import |
|---|---|---|
| `src/normalize/core.js` | `studyATasks` / `normalizeRecords`（纯，`vendorConfig` 显式传入） | 两边 |
| `src/normalize/index.js` | `loadVendorConfig` / `normalizeRuns` / `selectRuns` + re-export core | 仅 Node |

**绝不允许**在 `ui/` 下重写一份归一化、判定或距离计算。归一化口径漂移是本项目最贵的
一类 bug（CLAUDE.md 开发日志 2026-08-14），复制一份就是给它开第二个入口。
`ui/src/core/` 只做三件事：喂数据、接线、存结果。

`runBattery` / `screenL1` / `calibrateL2` 的 `vendorConfig` **必传，无默认值**——
理由跟 `applyReasoningTrace` 必传一样：prompts 属于「采样参数不可改」，
一个默认值就是替调用方悄悄选了一边。

## 目录

```
ui/
  package.json        devDeps 仅 vite + wrangler；**运行时依赖恒为 0**，加要在这登记
  vite.config.js
  wrangler.jsonc      Worker + assets 绑定
  index.html
  scripts/build-data.js   生成 src/data/*.json（含上面那条自证），构建前必跑
  worker/index.js     全部服务端代码。只做：路径改写代理 + 限流 + 静态资源
  src/
    core/             接线层：参照加载 / 代理 probe 工厂 / 引擎编排 / IndexedDB / 成本预估
    views/            setup · running · report · matrix · history · about
    components/       heatmap · interval-bar · cell-grid · verdict-card · ...
    styles/           tokens.css（设计变量）+ app.css
    data/             ← 构建产物，gitignored
```

## 命令

```bash
npm --prefix ui install
npm --prefix ui run data     # 生成参照与型号地图，含口径自证
npm --prefix ui run dev      # 本地 vite（代理走 wrangler dev）
npm --prefix ui run build    # data + vite build → ui/dist
npm --prefix ui run deploy   # build + wrangler deploy
```

## 防滥用（公开站的最低配置）

| 层 | 做法 |
|---|---|
| 目标限制 | 只允许 https；hostname 不能是 IP 字面量 / localhost / `.internal` / `.local` |
| 路径限制 | 只转发结尾命中白名单的路径（`/responses` `/chat/completions` `/models` `/api/status`） |
| 限流 | Workers 原生 rate-limit binding，按 IP |
| 请求体上限 | 64KB——指纹探针最大也就几 KB |
| 不做的事 | **不记录 URL、不记录 key、不记录响应体**。日志只留状态码与耗时 |

转发的是**用户自己的 key**，所以「白嫖 LLM」不是威胁模型；真正要防的是被当成匿名跳板，
上面几层针对的是这个。

## 能力声明（必须显示在页面上，不是脚注）

- 参照库目前只有 **OpenAI / Codex 系 10 个型号**（`responses` 线）。测 Claude 或其他家
  只能跑 L0，L1/L2 无参照可比。
- **一次绿灯 ≠ 该端点干净**。轮换是粘性的，单次 L2 等于抽一次签。UI 要主动引导重复测量
  并把历次结果画成时间线——这是网页能比 CLI 做得更好的地方，不是可选功能。
- 抓不到 reasoning effort 降档（那要 `quick-check.js` 那层）。
- 参照有保质期：`collected_utc` 超过 90 天标黄。
