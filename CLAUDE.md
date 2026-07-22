# llm-fingerprint

用**单 token 输出分布指纹**检测 API 中转商有没有偷换模型。

## 问题 / 目标用户

用户 = ZhYoU，自己买第三方中转 API 跑 Claude Code / Codex。中转链路不透明：付的是 `claude-opus-4.8` 的钱，实际后端可能是量化版、同族小模型、甚至别家开源模型，且**通常不是一开始就换，是跑一阵后悄悄降配**。

本工具用极低成本（每次探测 1 个 output token）采集端点的行为指纹并比对，回答两个问题：

1. **判定**：这个端点还是原来那个模型吗？（主用途，可靠）
2. **识别**：那它最像什么模型？（辅助，低置信 —— 论文家族准确率仅 59.5%）

## 方法来源

复现自 Bruckner, T. (2026) *One Token Is Enough: Fingerprinting and Verifying Large
Language Models from Single-Token Output Distributions*（arXiv:2607.10252）。

| 来源 | DOI | 许可 | 用途 |
|---|---|---|---|
| 论文数据集 | 10.5281/zenodo.21278557 | CC-BY-4.0 | 176 模型参考指纹 + golden test 输入 |
| 论文软件 | 10.5281/zenodo.21278793 | MIT | 探针原文、归一化、JSD 实现 |

`vendor/pamela/` 下为上游 MIT 代码，**逐字复用不改写**（改写 = 引入归一化差异 = 结果不可比）。
署名见 `vendor/pamela/ATTRIBUTION.md`。

## 核心概念

- **cell（格）** = task × lang。指纹电池 = 10 个 paper-1 任务 × 4 语言 = **40 格**。
  （上游 15 个任务里 `coord-*` / `anticoord-*` / `secret-password` 属 Study B，**不进指纹**）
- **指纹** = 每格在 T=1 下的答案经验分布（默认 30 次采样）
- **距离** = Jensen-Shannon 散度（**底数 2**，值域 [0,1]），对双方 `n_valid ≥ 10` 的格取均值
- **判定阈值** = 论文 EER 曲线：k=8 → 0.106，k=16 → 0.095，k=40 → 0.0728

## 核心方法：对照校准法（本项目的主要贡献）

**问题**：不同网关把请求包进不同外壳（注入的系统提示词长度不同、参数透传程度不同），
所以跨端点直接比指纹，差异里混着「外壳不同」和「模型不同」，**分不开**。论文没遇到这个问题，
因为它只在 OpenRouter 单一环境采集。

**解法**：**把外壳的影响测出来再扣掉。** 选一个**双方都提供、且已独立确认为正版**的
**对照模型**，它的跨端点距离就是纯外壳效应。

| 量 | 定义 | 含义 |
|---|---|---|
| **H** | 对照模型在 参照端点 vs 待测端点 的平均 JSD | 纯外壳差异（模型确定相同） |
| **S** | 待验模型在 参照端点 vs 待测端点 的平均 JSD | 待判定 |
| **D** | 待测端点上 待验模型 vs 对照模型 的平均 JSD | 真实模型差异的尺度 |

**判据**（看相对关系，不看绝对值）：

- `S ≤ 1.5 × H` → **与同一模型一致**（外壳足以解释全部差异）
- `S ≥ 0.7 × D` → **疑似替换**
- 之间 → 不确定，加格子或加采样

## 四层协议

| 层 | 内容 | 成本 | 能判定 | 要参照 |
|---|---|---|---|---|
| **0 端点画像** | 注入量、temperature/seed/logprobs/n 支持、reasoning_tokens、model 回显、特征响应头 | ~10 次 | 端点类型；**谎称"官方 API 直连"当场戳穿** | 否 |
| **1 动态推理题** | 程序化生成 + 精确求解，见下 | **~36 次** | **reasoning 降档** | 否（需校准文件） |
| **2 校准指纹** | H / S / D（上面那套） | 240 次/模型 | **模型身份** | 是 |
| **3 漂移监控** | 定期重跑第 1 层 | ~6 次/周 | 跑熟后偷偷降配 | 否 |

日常只跑 0+1；换供应商或起疑时才上第 2 层。

## 第 1 层：动态推理题库（`src/probes/reasoning.js`）

**为什么必须程序化生成**：hvoy 用固定 6 道题，按其自述已发出 100 万+ 次——中转商从访问日志里
就能读到题目并硬编码答案。生成式题库没有这个保质期问题：每次跑都是新实例，正确性用**我们自己的
求解器**校验，不依赖存储的答案表。

| 题型 | 求解方式 | 校准结果（relay-A，已验证正版，12 样本/档） | 用途 |
|---|---|---|---|
| `adaptive-pair` | **精确 minimax**（选形状 → 对手挑最坏口味 → 自适应） | **high 67% / low 33%，gap 33pt** | ✅ **区分档位** |
| `pigeonhole` | 闭式 `Σ min(cᵢ,k−1)+1` | **high 100% / low 100%，gap 0** | ❌ 无区分度，仅作可用性底线 |

**求解器已验证**：对 hvoy 那道原题算出 **8**，与两个真实端点的回答一致。

**判据必须是统计的，不能逐题判**。3 次采样下「2/3 vs 3/3」只差一个样本，全是噪声。按整批
正确率比，且需要足够题数：以当前难度（67% vs 33%）算，**每次跑约需 36 道题**才能在
95%/80% 下把两个正确率分开。难度若能调到 high≈95% / low≈50%，题数可降到 ~16。

```bash
# 一次性：在已知正版端点上校准（哪个题型在什么难度有区分度）
node scripts/calibrate-probes.js --endpoint <正版> --key <k> --n 8 --reps 3

# 日常：查某端点有没有偷偷降档（题目每次重新生成，种子取自时钟）
node scripts/quick-check.js --endpoint <url> --key <k> [--effort high] [--n 36]
```

**沉淀下来的是「家族级区分度」，不是题目**。`probes/calibration.json` 存的是各题型在两档下的
正确率，实例每次现生成——所以对手拿不到可硬编码的题面。

### 知识截止题（`src/probes/knowledge.js` + `probes/knowledge.json`）

**与推理题本质不同**：推理答案可**算**（有求解器、每次现生成），知识答案是**真实事实**、只能查
可信源，**没有求解器、无法算法生成**，因此是**策展式**（curated）。这继承了 hvoy 的弱点
（策展题库终会被从日志读走），只能缓解不能根治：每条带 `source`+`date` 可审计可刷新、从池中
随机抽子集。取材源用 Wikipedia 当代事件门户（`Portal:Current_events/January_2026` 这类）。

**校准**（2026-07-22，relay-A 已验证正版 sol，effort=low 关联网）：Jan 2026 事实答对 **4/5**，
飞镖冠军题因过于小众连正版都不稳，已剔除。→ **筛题标准**：正版模型稳定答对才留。

**局限（必须向使用者声明，别给绿灯就信）**：只能抓「换成截止日期更早的旧模型」。**区分不了
两个当代模型**（5.5 vs 5.6-sol 截止太近）。而在订阅逆向威胁模型下，中转**拿不到任意旧模型**
——所以这一层对本项目主场景是**四层里最弱的**。降 reasoning 档由推理题覆盖，模型身份由第 2 层
覆盖，知识题主要是补一个理论完备性。

## 已知无法覆盖

- **reasoning effort 降档**：答案分布看不出「同一模型跑在低推理档」。第 2 层的 verdict
  **不包含**这一项，只单独报 `reasoning_len` 比率当参考。要抓得靠第 1 层的硬推理题正确率。
- **蓄意伪造**：对手知道我们查什么就能对着调。第 2 层比"背固定答案"难得多（要匹配
  8-40 格 × 多语言的完整分布），但不是不可能。
- **不能证明是厂商原始权重**：那需要厂商对响应做密码学签名，业界尚无。

## 参考库与自建参照

| 来源 | 内容 | 何时用 | 保质期 |
|---|---|---|---|
| `data/upstream/` 论文库 | 176 模型 × 40 格，2026-07-06 快照 | 待验模型在库里时可直接排名 | 随模型更新过期 |
| `reference/genuine-*.json` | **本项目自采的正版参照** | 库里没有的新模型（如 gpt-5.6-sol） | 见下 |

`reference/` 是**一次性投入、可反复使用**的资产：以后测任何新中转，只花新中转的额度，
参照直接读本地。**模型版本更新后需重采**（厂商换了权重，旧参照就不代表正版了）。

## 硬约束

- **推理守门**：开跑前实测有效补全率（不是查模型名单）。推理模型会把 16 token 预算烧在隐藏推理上，补全为空 → 指纹无意义。<20% 中止，20-80% 警告并标低置信。
  上游踩过的坑：`gpt-5.1-chat` / `5.2-chat` / `5.3-chat` 名字像非推理款，实测在偷偷推理，被整个排除。**不能靠模型名判断。**
- **采样参数不可改**：`temperature=1.0`、`max_tokens=16`、`reasoning:{enabled:false}`、system prompt 用 `vendor/pamela/config/prompts.json` 原文。改任何一个 → 跟参考库不可比。
- **不做的事**：不逆向订阅端点（订阅不给 temperature + agent 外壳污染 → 数据无效，且撞封号风险）。

## 技术栈

Node.js ≥ 20（实测 22.14）。**零运行时依赖**，跟上游一致。原生 `fetch` + `node:test`。
不引入统计库 —— JSD / ROC / EER 自己实现，正确性由 golden test 保证。

## 命令

```bash
npm test                 # 全部测试
npm run test:golden      # 只跑 golden test（复现论文数字，最重要）
npm run fetch-data       # 从 Zenodo 拉论文数据集+代码到 data/upstream/（gitignored，~52MB）

# 【主用途】验一个新中转，只花新中转的额度，正版参照读本地 reference/
node scripts/verify-relay.js --endpoint https://xxx/v1 --key sk-xxx \
  [--subject gpt-5.6-sol] [--control gpt-5.4] [--reps 30]

# 单端点采样 + 对论文 176 模型库排名（待验模型需在库里）
node scripts/probe-endpoint.js --endpoint <url> --key <k> --model <m> [--reps 30] [--full]

# 同端点内多模型互比（检测"多个名字同一后端"）
node scripts/compare-baselines.js baselines/a.json baselines/b.json ...

# 手工指定四个文件做校准比对
node scripts/calibrated-compare.js --control-a A --control-b B --subject-a C --subject-b D
```

**采集新的正版参照**（换了模型版本、或新增待验模型时）：

```bash
node scripts/probe-endpoint.js --endpoint <已知正版端点> --key <k> --model gpt-5.6-sol
# 然后把 baselines/probe-<model>.json 脱敏（删 endpoint 字段）存进 reference/genuine-<model>.json
```

## Golden Test（本项目的正确性基石）

统计代码"看起来能跑但算错了"是本项目最大风险，且 review 看不出来。所以分三层拿论文
**已公开的输入 + 已公开的输出**对拍：

| # | 层 | 输入 | 期望输出 |
|---|---|---|---|
| G0 | 归一化 | 上游 `responses.jsonl` | 逐字段等于上游 `normalized.jsonl` |
| G1 | JSD / split-half | 上游 `normalized.jsonl` | 等于上游 `divergence-matrix.csv` + `split-scores.json` |
| G2 | 验证协议 | 上游 `split-scores.json` | AUC = 0.971342，EER = 0.07282，genuine 165 / impostor 27060 |

**G0-G2 全绿之前不写业务逻辑。** 任何一层红 = 我的实现错了，不是论文错了。

## 目录

```
src/
  normalize/     归一化（薄封装 vendor 的纯函数）
  stats/         jsd.js / verify.js（ROC·EER）/ distributions.js
  probe/         采样引擎 + adapters/{openai,anthropic}.js
  baseline/      自建基线存储与版本管理
  verdict/       三模式判定
  ui/            本地 web 界面（Express 风格但用原生 http）
  cli.js
vendor/pamela/   上游 MIT 代码，逐字复用，不改写
refdb/           构建产物：论文 176×40 参考指纹（提交进 git，~2MB）
data/upstream/   Zenodo 原始数据（gitignored，~52MB，npm run fetch-data 获取）
baselines/       用户自建基线（gitignored，含端点信息）
test/golden/     G0-G2
```

## 命名约定

- 文件 kebab-case，导出函数 camelCase
- cell 键统一 `` `${task_id}|${lang}` ``，跟上游一致
- 指纹 JSON 结构对齐上游 `distributions.json` 的 cell 记录（`model/task_id/lang/n_valid/dist/entropy_bits/mode`）

## 密钥管理

- API key **只从环境变量或 `.env` 读**，`.env` 进 `.gitignore`
- 基线文件 `baselines/` 存端点 URL 但**绝不存 key**
- GUI 的 key 输入框只在内存中用，不落盘、不写日志
- 提交前确认：`git diff --cached | grep -iE 'sk-|api[_-]?key'`

## 子代理与 review

遵循 `../CLAUDE.md`：实施派 Claude agent，**review 一律 Codex**（`gpt-5.6-sol` high，走
codex-server MCP）。本项目按 task commit 后审，不在 spec 阶段审 —— 统计正确性由
golden test 保证，比文字 review 硬。

## 实测结论存档（2026-07-21/22）

### 已验证的端点

| 端点 | 模型 | 结论 | 证据 |
|---|---|---|---|
| **relay-A** | `gpt-5.4` | ✅ **正版** | 对论文库 **rank 1/165, JSD 0.0605**，低于同模型中位数 0.075，到第 2 名差 4 倍 |
| **relay-A** | `gpt-5.6-sol` | ✅ **正版**（reasoning 档未定） | **S/H = 1.05**（混合）/ **1.08**（仅未注入层）；S≈0.18 vs D≈0.35 |
| **relay-A** | `gpt-5.5` | ⚠️ 无法判定 | 65.4% 推理污染，对库排名第 3 但前三名差距（0.027）小于同模型噪声（0.075） |
| 自建 cliproxyapi | `gpt-5.6-sol` | ✅ 正版（**供应链确认**） | 网关日志 `Registered new model gpt-5.6-sol from provider codex`，3 个 ChatGPT 订阅 OAuth 账号 → OpenAI 后端，**链路上无替换点** |

**relay-A 未发现掺假迹象。** 佐证：站内 `sol` vs `5.5`=0.3012、vs `5.4`=0.3794 → 三个名字是三个
不同模型，非改名马甲；两边 sol 对论文库都呈「平铺、最近邻 gpt-5.5≈0.34」，即"谁都不像"，
正是库中缺失的真·新模型该有的形状（若拿 5.5 冒充会紧贴 gpt-5.5）。

### reasoning effort：协议选错会得出反向结论

**必须用对协议。** Codex 系中转走 **Responses API**（用户 `~/.codex/config.toml` 里
`wire_api = "responses"`），effort 放在 **`POST /v1/responses` 的 `reasoning: {effort}`**。
CLI 侧的配置键是 `model_reasoning_effort`（不是 `reasoning_effort`）。

打 `/v1/chat/completions` 传 `reasoning_effort` **两个端点都无反应**——那是协议错了，不是不支持。

**两个端点都透传 effort。** 自建网关有日志级铁证（`debug: true` 时 `apply.go` 会打印）：

```
[apply.go:232] thinking: original config from request | provider=codex model=gpt-5.6-sol mode=level level=low
[apply.go:273] thinking: processed config to apply  | provider=codex model=gpt-5.6-sol mode=level level=low
```

| 端点 | 证据 | 透传 |
|---|---|---|
| 自建 cliproxyapi | 日志 `apply.go` 原样应用 level；**难题下 output_tokens：low 1127–2381 / high 4755–5082（2–3 倍）** | ✅ |
| relay-A | 难题正确率 low 3/6 vs high 6/6 | ✅ |

⚠️ **探针题必须够难，否则会得出反向结论。** 我们先用了「3红5蓝7绿球保证3同色」（答案 7），
两端在 low 档都 6/6，且 `reasoning_tokens` 恒 0 —— 据此曾错误结论「不透传、字段不可用」。
换成 hvoy 那道自适应糖果题后，同一端点立刻显出 2–3 倍的 token 差和 5075 的 reasoning_tokens。

**`reasoning_tokens` 的正确读法**：简单题不触发推理时确实为 0，这是真实行为不是上报缺失；
难题下自建网关报得很准（5075）。relay-A 在**相同请求**间会出现 null/数值跳变，与其
「~70% 未注入 / ~30% 注入」的路由分裂一致——**跨端点比该字段无意义，同端点内可用**。

**对 relay-A sol 正版判定的加强**：永久降档的假货在 high 档也该拉胯；relay-A 在 high 上与正版
参照表现一致，只有主动要 low 才退化——正是诚实透传的正版模型该有的行为。用户 config 里
`model_reasoning_effort = "high"`，实际使用走的就是这一档。

**留作第 1 层的探针**：「端点透不透传 effort」是廉价端点特征（low/high 各若干次，看难题
正确率或 output_tokens 是否分层）。**题目难度需先校准**——用正版参照端点确认它在 low 档
确实会退化，才能拿去测别人。

### 端点行为特征（画像层的实测样本）

| | 自建 cliproxyapi | relay-A |
|---|---|---|
| 注入量 | 恒定 ~294 token（外壳**前置拼接**在你的 system 前） | 给了 system 就**整个替换**外壳（~46 token）；不给则注入 4383 token |
| temperature | ❌ 不透传（T=0 六次给出 3 个不同值） | ❌ 不透传 |
| max_tokens / seed / n / logprobs / system_fingerprint | ❌ 全不支持 | ❌ 全不支持 |
| 特征响应头 | 无 | `x-oneapi-request-id` → 跑在 **One API / New API** 框架上 |
| 账号轮换 | 3 个 codex 账号（仅 1 个有 sol）；480 次采样期间逐格 `prompt_tokens` 恒定，本轮未轮换 | **会轮换**：~70% 未注入(40-49 tok) / ~30% 注入(4400-6600 tok) |

**结论**：订阅逆向网关一律不支持 logprobs / seed / n。这些能力的**有无**是判定端点类型的
廉价探针（~5 次请求）；**支持 = 裸 API，用 logprobs 一次请求就能验模型，比采样强得多**。

### 外部工具调研

| 工具 | 方法 | 实测评价 |
|---|---|---|
| [api-relay-audit](https://github.com/toby-bridges/api-relay-audit) | 14 步协议/篡改审计 | **最成熟**（762★）。数值探针可信（实测报注入 ~294，与手测一致）；**判定层过度触发**：把拒绝话术当成 prompt 泄漏、对非 Claude 模型必报"替换嫌疑"（硬编码 `does not contain 'claude'`） |
| [hvoy.ai](https://www.hvoy.ai) | 2 轮请求 × 5 维度 | **蜜罐实测：假端点通过 3/5**。型号特征/协议一致性/响应结构**零鉴别力**（只验协议实现）。仅知识问答 + 降智两维有力，但**题库静态**（已发出 100 万+ 次，运营者可硬编码答案） |
| [claude-detector](https://github.com/7836246/claude-detector) | 19 探针 + 6 级判定 | 仅 Claude。最强的一招 `count_tokens_match` 用官方 `/v1/messages/count_tokens` 做**计费真值核验**——OpenAI 无对应端点，但 `tiktoken` 本地可算，**这条我们能补且他们对 GPT 做不到** |

**hvoy 的题库原文**（2026-07-21 蜜罐捕获，静态、可被针对）：5 道 2026年1月时事题
（超越特斯拉的车企 / 美国退出的国际组织 / Guy Parmelin 前任瑞士总统 / 保加利亚弃用货币 /
Ciudad de la Paz 属国）+ 1 道自适应糖果组合推理题。参数 `max_completion_tokens: 10240`、
`stream: true`、`stream_options.include_usage: true`、无 system prompt。

**我们相对它的改进方向**：题库**程序化生成**（时事题按最近日期构造、推理题参数化模板），
使硬编码失效。他们做不到这点——跨站横向对比需要固定标尺。

## 开发日志

（按时间倒序，新的在上）

- **2026-07-22** 完成对照校准法（H/S/D）并实测：relay-A 的 `gpt-5.6-sol` 判定为正版。
  正版参照落盘 `reference/`（一次性投入，以后测新中转不再消耗参照端的额度）。
  新增 `verify-relay.js` 一条命令完成验证。修正两个方法错误：① `prompt_tokens` 分层最初被
  误当作账号标签，实为题目长度（须**按格子内部**判断轮换）② `probe-endpoint.js` 固定文件名
  导致覆盖了先前采集的基线，现按端点命名。
- **2026-07-21** 项目建立。G0-G2 三层 golden test 全绿：归一化 335,889 条逐字段一致、
  JSD/split-half 完全复现、AUC 0.971342 / EER 0.07282 精确复现（甩掉 R 依赖）。
  实测发现论文盲区：harness 式网关吞掉 temperature/max_tokens，论文方法在那类端点上
  不成立（论文只测了 OpenRouter）。从论文数据中读出它自己未强调的结论：**跨服务商分歧
  10 组里 9 组是开源权重模型**，闭源模型基本不掉包（唯一例外 gpt-4 Azure vs OpenAI）。
