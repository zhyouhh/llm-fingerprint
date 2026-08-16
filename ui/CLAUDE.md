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

1. **key 不落任何盘**。L2 要 870 次请求跑 ~7 分钟。放服务端后台任务（Durable Object）
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
