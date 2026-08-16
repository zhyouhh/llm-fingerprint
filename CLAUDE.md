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
| **D** | 待验模型 vs 对照模型 的平均 JSD（采对照时在待测端点上算，`--no-control` 时从两份参照算） | 真实模型差异的尺度 |

**判据**（看相对关系，不看绝对值。**两个方向都要求整个区间越线**）：

- `S/H` 的 90% 区间**整体** < 1.5 → **与同一模型一致**（外壳足以解释全部差异）
- `S/D` 的 90% 区间**整体** ≥ 0.7 → **疑似替换**
- 之间 → 不确定，加格子或加采样

🔴 **对称性是硬要求，不是洁癖**。曾经只有 consistent 要求区间、suspect 看点估计就定罪——
对一个「冤枉诚实中转」代价最高的工具，这个方向反了。实测代价：同一端点相隔一小时两次
`S/D` = 1.04 与 0.64，被写成「suspect」和「inconclusive」，**差一个样本**。

🔴 **分母有下限 `max(H_c, 噪声地板)`**。H_c 低于噪声地板不是「没测出东西」，恰恰是对照模型
能给出的**最好结果**（两端无法区分 → 外壳无影响）。塌掉的是比值不是证据，所以改成
「外壳与测量噪声，取更宽松的那个来解释这个差距」。旧代码在这种情况下直接放弃整轮，
把 relay-C 的 `S_c/D_c = 0.07` 当作不可判定丢掉了。

**精度来自格子数，不是采样数**：区间是对**格子**做 cluster bootstrap，6 个格子无论每格采多少
次都是粗的、重尾的。`--cells full` 采论文 paper-1 全部 40 格（10 任务 × 4 语言），
官方 responses 参照实测得到 **29 个活格**（死格 10 个：`num10-random` 全语言、
`color-favorite`、`num-favorite` 几个——待验与对照答案相同，本来就没鉴别力）。

## 🔴 指纹层的两条协议——不可混用

同一道题在两条线上**分布不同**（自建网关 `num100-random|en`：chat 下 `47` 恒定，
Responses + `effort:none` 下 47/57/57）。所以参照与待测**必须同协议**，代码会拦。

| 协议 | 靠什么关推理 | 谁能用 | 何时选它 |
|---|---|---|---|
| `chat` | `reasoning:{enabled:false}` | 中转可以，**官方 API 不行** | 默认；与论文 176 模型库同口径 |
| `responses` | `reasoning:{effort:'none'}` | **五家全通，含官方**（实测 3/3） | 要拿官方 API 当参照时**唯一可行** |

**为什么官方采不了 chat 参照**：`reasoning:{enabled:false}` 是 **OpenRouter 扩展**（论文数据
就是在 OpenRouter 上采的），官方 400 `Unknown parameter`；去掉它并改用 `max_completion_tokens`
后能通，但推理模型会把 16 token 预算**全烧在隐藏推理上**，补全为空（实测 240/240 空）。
中转采得到，正是因为它们接受那个参数、真把推理关了。

**机制**：参照文件记 `fingerprint_protocol`；`screen.js` / `verify-relay.js` **从参照读协议**
并 `assertSameProtocol`，不匹配直接抛错。没有该字段的老文件按 `chat` 处理（它们本来就是）。

## 分层协议

| 层 | 内容 | 成本 | 能判定 | 要参照 |
|---|---|---|---|---|
| **L0a 零请求画像** | `/api/status` 开放接口、`GET /models`、响应头特征、端点类型推断 | **0 次** | 端点类型；**谎称"官方 API 直连"当场戳穿** | 否 |
| **L0b 能力探测** | 参数接受度矩阵 14 项（effort 8 档 + reasoning.mode 2 + logprobs/seed/n/temperature）、juice 探针、注入量截距 | ~24 次 | 端点类型；透不透传 effort | 否 |
| **L1 快筛** | 3 格 × 5 次，与本地参照比 `S_screen`，对离线标定的 `T_pass`/`T_fail` | **15 次** | 「还是不是它」（绿 / 需精确确认） | 是（读本地 `reference/`） |
| **L2 精确校准** | H / S / D（对照校准法）+ 偏置校正 + bootstrap 置信区间 | **活格×15×(采对照?2:1)**；29 活格 = 870 / `--no-control` 435 | **模型身份**（最硬）；配多份参照可**指认型号** | 是 |
| **reasoning 巡检**（旁挂） | 生成式难题六档标定 + 日常比对，见下 | ~36 次 | **reasoning 降档** | 否（需 `probes/calibration.json`） |

日常只跑 L0+L1；换供应商或起疑时才上 L2。降档嫌疑走 reasoning 巡检。

> ⚠️ **术语对照**（下面「实测结论存档」是当时的记录，**不改写**，但两套编号别混着读）：
> 历史行文里的「第 1 层 = 推理题 / 第 2 层 = 指纹 / 第 0 层 = 画像 / 第 3 层 = 漂移监控」，
> 对应现在的「reasoning 巡检 / L2 / L0 / 定期重跑 L1+巡检」。
> 重构方案见 [`docs/plans/2026-08-11-relay-picker-plan.md`](docs/plans/2026-08-11-relay-picker-plan.md)。

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
node scripts/calibrate-probes.js --endpoint <正版端点 id> --n 8 --reps 3

# 日常：查某端点有没有偷偷降档（题目每次重新生成，种子取自时钟）
node scripts/quick-check.js --endpoint <id> [--effort high] [--n 36]
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
| `reference/<protocol>/genuine-*.json` | **本项目自采的正版参照** | 库里没有的新模型（如 gpt-5.6-sol） | 见下 |

`reference/` 是**一次性投入、可反复使用**的资产：以后测任何新中转，只花新中转的额度，
参照直接读本地。**模型版本更新后需重采**（厂商换了权重，旧参照就不代表正版了）。

**多采几个候选型号的参照 = 从「判定」升级到「指认」**：只有 sol 的参照时，异常端点只能报
「不是 sol」；补了 luna 的参照之后，同一批数据直接算出「是 luna」。候选从 `GET /models`
里挑同代/同族型号（sol 的邻居是 `gpt-5.6-luna` / `gpt-5.6-terra`）——**同代兄弟是最合理的
掺假对象**：名字像、更便宜、行为接近但不同。

## 硬约束

- **推理守门**：开跑前实测有效补全率（不是查模型名单）。推理模型会把 16 token 预算烧在隐藏推理上，补全为空 → 指纹无意义。<20% 中止，20-80% 警告并标低置信。
  上游踩过的坑：`gpt-5.1-chat` / `5.2-chat` / `5.3-chat` 名字像非推理款，实测在偷偷推理，被整个排除。**不能靠模型名判断。**
- **采样参数不可改**：`temperature=1.0`、`max_tokens=16`、`reasoning:{enabled:false}`、system prompt 用 `vendor/pamela/config/prompts.json` 原文。改任何一个 → 跟参考库不可比。
- **不做的事**：不逆向订阅端点（订阅不给 temperature + agent 外壳污染 → 数据无效，且撞封号风险）。

## 技术栈

Node.js ≥ 24（实测 v26.3.0；`package.json` 的 `engines.node` 即 `">=24"`）。
下界取 24 的理由：`node:sqlite`（里程碑 2 的存储层）在 22.x 需要 `--experimental-sqlite` flag，
而本项目不给代码加 flag（部署时 Docker / CLI / 测试三处都要带，是三个新的失败点）。
**`src/` 与 `scripts/` 零运行时依赖**（golden test 覆盖的正确性承重部分，跟上游一致）；
**`ui/`（里程碑 2）允许引入依赖，引入时须在本节登记**。当前全项目依赖数为 0。
原生 `fetch` + `node:test`。
不引入统计库 —— JSD / ROC / EER 自己实现，正确性由 golden test 保证。

## 命令

🔴 **端点与 key 的传法**：候选端点写在 `config/endpoints.json`（提交进 git，**绝不含 key**），
每个端点用 `auth_env` 指名一个环境变量，key 放 `.env`（gitignored）。
所有 CLI 一律 `--endpoint <id>`，**不再传 URL 和 `--key`**。
解析由 `src/lib/config.js` 统一负责，各脚本不得自己读配置文件或拼环境变量名。

```bash
npm test                 # 全部测试
npm run test:golden      # 只跑 golden test（复现论文数字，最重要）
npm run fetch-data       # 从 Zenodo 拉论文数据集+代码到 data/upstream/（gitignored，~52MB/解压~500MB）
npm run verify-data      # 只校验数据完整性，不下载；缺什么列什么，缺失时退出码 1

# 分层协议，成本逐层放大
node scripts/profile.js      --endpoint <id>              # L0 画像（L0a 0 次 + L0b ~24 次）
node scripts/screen.js       --endpoint <id> [--fp-protocol chat|responses]   # L1 快筛（15 次）
node scripts/verify-relay.js --endpoint <id> [--fp-protocol P] [--no-control]  # L2 精确校准（最硬）
   # L2 探针数 = 活格数 × 15 × (采对照? 2 : 1)。29 活格：带对照 870，--no-control 435
node scripts/quick-check.js  --endpoint <id> [--effort high] [--n 36]   # reasoning 降档巡检
npm run compare -- --tier screen|full [--only a,b] [--sort <列名>]      # 横评全部端点

npm run compare -- --sort latency_p50   # 换排序键；不带则按真实性排

# 0 请求：按**当前**口径重判存量结果（改了阈值 / 参照 / 归一化之后必跑）
node scripts/rejudge.js

# 0 请求：型号地图——参照两两距离 + 各自噪声地板，看哪些型号本方法分不出来
node scripts/model-matrix.js [--fp-protocol responses] [--json var/model-matrix.json]

# 采 / 刷新正版参照（只能在已知正版端点上跑）
node scripts/refresh-reference.js --endpoint <正版 id> --model <m> \
  [--cells l1|all|full] [--fp-protocol chat|responses]
  # l1=3 格 90 次 / all=快筛 8 格 240 次 / full=论文全部 40 格 1200 次（L2 精度靠这个）
  # 🔴 只能在 config 里标了 "genuine": true 的端点上跑，代码会拦

# 运维工具（不进主流程）：单端点采样 + 对论文 176 模型库排名
node scripts/probe-endpoint.js --endpoint <id> --model <m> [--reps 30] [--full]
```

**采集新的正版参照**（换了模型版本、或新增待验模型时）：

```bash
node scripts/probe-endpoint.js --endpoint <已知正版端点 id> --model gpt-5.6-sol
# 然后把 baselines/probe-<endpoint>-<model>.json 脱敏（删 endpoint 字段）
# 存进 reference/genuine-<model>.json
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
config/
  endpoints.json        候选端点清单（提交进 git，**不含 key**，key 走 auth_env 指名的环境变量）
  endpoints.example.json  脱敏示例
docs/plans/             实施 plan（当前：2026-08-11-relay-picker-plan.md）
src/
  contracts.js          🔴 契约代码：判定语义八条的唯一事实源（样本分类 / 两个率 / 两个计数
                        / 重试校验 / 采集信封 / L1·L2 产物）。**所有层 import 它，不许自带字段副本**
  lib/config.js         端点配置加载器——**唯一**读 endpoints.json 与取 key 的地方
  lib/reference-store.js 🔴 参照按 **(model, protocol)** 寻址——**唯一**拼参照路径的地方。
                        协议进目录名而非文件名，局部刷新在结构上就不可能跨线路继承格子
  lib/cli.js            共享 CLI：参数解析、--help（退出 0）、端点解析、退出码语义
  lib/errors.js         UsageError（退出码 2）
  lib/rng.js            mulberry32 + 有放回抽样 + 经验分布 + nearest-rank 分位数（确定性）
  lib/jsonl.js          流式 JSONL 读取（上游文件 ~160MB）
  normalize/index.js    归一化管线；`normalizeRecords(recs, {applyReasoningTrace})` 是内存版
  stats/
    jsd.js verify.js distributions.js divergence.js   （不动，golden test 管辖）
    noise.js            噪声地板（split-half 有放回重抽样）+ 偏置校正
    bootstrap.js        S/H 比值的 90% 置信区间（对**格子**重抽样）
    guards.js           逐层守门；`usableCells` 的 minN **无默认值**
  probe/
    runner.js           采样引擎（自己不重试；`applyReasoningTrace` 必须显式传）
    cells.js            格子选择（SNR 排序、剔死格）+ L1 阈值标定（模拟 + 实测合并）
    http/               🔴 **唯一出站目录（I-4）**
      transport.js      重试 + 错误分类 + 超时（**非 2xx 不抛，返回值**）
      chat.js           指纹路径（论文口径，请求体字节冻结）
      responses.js      Responses 客户端（effort / mode / store:false）
      fingerprint-probe.js  🔴 指纹层双协议 + **跨协议比较拦截**（见下节）
      get.js            L0a 的两个 GET
  layers/
    l0-profile.js       L0a 零请求画像 + L0b 能力探测（接受度四态）
    l1-screen.js        L1 快筛：`evaluateL1`（纯函数）+ `screenL1`（采集）
    l2-calibrate.js     L2 校准：H/S/D + 偏置校正 + bootstrap 区间 + H_c 定义域守卫
    rejudge.js          🔴 按**当前**口径重判存量结果文件（0 请求）——`rejudgeL1` + `rejudgeL2`
    result-file.js      结果文件写入 + L0a/L0b 合并（两个计数求和）
    genuine-history.js  从结果文件收集正版端点实测 S（用于实测标定 T_pass）
    compare-table.js    横评表：L2 优先于 L1、排序序、逐层计数求和
    model-matrix.js     参照两两距离矩阵。🔴 **对角线放各模型自己的噪声地板**，
                        不是 0——没有它，读者无从判断 0.18 是大还是小
  probes/               reasoning.js（生成式+求解器）/ knowledge.js（策展）/ juice.js
scripts/
  fetch-upstream-data.js    从 Zenodo 拉数据（`--verify` 只校验不下载）
  profile.js                【L0 主入口】端点画像
  screen.js                 【L1 主入口】快筛（15 次）
  verify-relay.js           【L2 主入口】校准比对（180 次）
  compare.js                【横评主入口】读 var/runs/ 出表，**不发新请求**
  rejudge.js                【重判】按当前口径重算存量 L1 结果，0 请求
  refresh-reference.js      【采参照】`--cells l1|all|full` `--fp-protocol chat|responses`
  probe-endpoint.js         运维：单端点采样 + 对论文 176 模型库排名
  calibrate-probes.js       在正版端点上校准推理题区分度（六档）
  quick-check.js            【reasoning 巡检主入口】查降档
  model-matrix.js           【型号地图】参照两两距离热力图，0 请求；`--json` 出 UI 用数据
  compare-baselines.js      ⚠️ 已弃用，阶段 6 删除（功能并入横评聚合层）
  calibrated-compare.js     ⚠️ 已弃用，阶段 6 删除（同上）
vendor/pamela/       上游 MIT 代码，逐字复用，不改写（含 ATTRIBUTION.md）
reference/<protocol>/  正版参照指纹（提交进 git，脱敏无端点URL）。
                     `chat/`      采自自建网关：gpt-5.6-sol / gpt-5.4（8 格）
                     `responses/` 采自 OpenAI 官方 API：**sol / 5.4 / luna**，各 40 格 × 30 次。
                     🔴 luna 那份是**指认掺假型号**用的——有它之后 15 探针的 L1 就能认出 luna
probes/              knowledge.json（知识题库）+ calibration.json（推理题校准）
data/upstream/       Zenodo 原始数据（gitignored，~500MB 解压，npm run fetch-data 获取）
baselines/           采样产物（gitignored，含端点URL）
var/runs/            结果文件 `<id>__<tier>__<ts>.json`（gitignored，绝不含 key）
test/                17 个 suite / **168 项全绿**：golden G0-G2、contract（判定语义 + I-N）、
                     runner / l0-profile / l1-screen / l2-verdict / cells / noise / guards /
                     bootstrap / config / golden-guard / fingerprint-protocol /
                     reference-store / model-matrix / probes
test/fixtures/       🔴 **冻结快照**：reference/（口径回归测试的输入，与活的 reference/ 解耦）、
                     chat-request-snapshot.json（I-1 字节锚点）、responses-sample.json（真实响应体）
```

**没有 CLI 统一入口**（曾设想 `cli.js`，未做）：各脚本单一职责、按需组合，加 wrapper 不划算（奥卡姆）。
横评用 `compare.js` 遍历，那不是 wrapper 而是聚合层。**Web UI 属里程碑 2**，见 plan。
验新中转的标准顺序见「## Runbook」。

## 命名约定

- 文件 kebab-case，导出函数 camelCase
- cell 键统一 `` `${task_id}|${lang}` ``，跟上游一致
- 指纹 JSON 结构对齐上游 `distributions.json` 的 cell 记录（`model/task_id/lang/n_valid/dist/entropy_bits/mode`）

## Runbook：验一个新中转（按顺序）

**前提**：中转是 Codex 系（走 Responses API）。`reference/` 里已有对应模型的正版参照，
否则先在已知正版端点采一份（见「采集新的正版参照」）。

**第 0 步**：把候选写进 `config/endpoints.json`（`id` / `base_url` / `protocol` / `auth_env`），
key 写进 `.env` 里 `auth_env` 指名的那个变量。此后只用 `id`。

```bash
# 1. 画像（L0a 0 次 + L0b ~24 次）——端点类型、是不是谎称官方直连、透不透传 effort
node scripts/profile.js --endpoint <id>

# 2. 快筛（15 次）——「还是不是原来那个模型」，绿灯就到此为止
node scripts/screen.js --endpoint <id>

# 3. reasoning 降档（~36 次）——查有没有偷偷降 effort
node scripts/quick-check.js --endpoint <id>

# 4. 模型身份（870 次，最贵，L1 报警或换供应商时才跑）
#    🔴 首测必须带对照：没采对照就测不出外壳，也抓不到"两个模型名发同一个东西"
node scripts/verify-relay.js --endpoint <id> --fp-protocol responses
#    确认该端点 H_c 远低于噪声地板之后，复测才好用 --no-control 省一半

# 5. 指认掺的是哪个型号（0 新请求，前提是已采好候选型号的官方参照）
#    对 reference/responses/ 下每份参照量距离，落到地板以下的那个就是它

# 横评多家：一条命令跑完 config 里全部端点
npm run compare -- --tier screen        # 每端点 41 次；决赛选手再单独跑 --tier full
```

🔴 **一次绿灯 ≠ 该端点干净**。relay-A 单次 L2 通过（S_c 0.0364），一小时前那次却是 luna。
轮换是**粘性**的（一格 15 次全落同一后端），所以单次 L2 等于抽一次签。
要有把握必须**跨时间多测几次**——有了 luna 参照之后，15 探针的 L1 快筛就足以认出它。

## 密钥管理

- API key **只从环境变量或 `.env` 读**，`.env` 进 `.gitignore`
- 基线文件 `baselines/` 存端点 URL 但**绝不存 key**
- GUI 的 key 输入框只在内存中用，不落盘、不写日志
- 提交前确认：`git diff --cached | grep -iE 'sk-|api[_-]?key'`

## 子代理与 review

遵循 `../CLAUDE.md`：实施派 Claude agent，**review 一律 Codex**（`gpt-5.6-sol` high，走
codex-server MCP）。本项目按 task commit 后审，不在 spec 阶段审 —— 统计正确性由
golden test 保证，比文字 review 硬。

## 实测结论存档（2026-08-14 下午 · 官方参照 + 40 格电池）

### 三家中转对官方 API（responses 线，29 活格，各 435 次，`--no-control`）

| 端点 | S_c | S/H 90% CI | 相对 1.5 线 | S/D 90% CI | 判定 |
|---|---|---|---|---|---|
| **relay-C** | 0.047 | **[0.10, 1.09]** | 整个区间在**线下** | 0.12 [0.02, 0.23] | ✅ **consistent** |
| **relay-A** | 0.222 | **[1.70, 3.60]** | 整个区间在**线上** | 0.58 [0.40, 0.78] | ⚠️ |
| **relay-B** | 0.285 | **[2.45, 4.38]** | 整个区间在**线上** | 0.74 [0.55, 0.93] | ⚠️ |

**读法**：`S/H` 区间整体在 1.5 线之下 = 与官方一致；整体在线之上 = 差距**超出测量噪声**，
这一条对 relay-A / relay-B 是确定结论，不是「分辨不了」。但两家的 `S/D` 都够不上 0.7 的指控线
（relay-B 点估计 0.74 越线、区间下界 0.55 没越）——**差距真实存在，但不到「换成另一个模型」的量级**。

符合量化版 / 不同 build 快照 / 不同服务配置 / 部分请求分流这几种情况。工具能把这一档**单独指出来**，
是这轮的主要收获——旧判据下 relay-B 会被点估计直接定罪成 🔴。

### 六家横评总表（2026-08-14，responses 线，29 活格，对三份官方参照）

| 端点 | 卖的 `gpt-5.6-sol` 实为 | 卖的 `gpt-5.4` 实为 | 注入 tok | 结论 |
|---|---|---|---|---|
| **relay-C** | sol（0.0473） | — | 48 | ✅ 真 |
| **relay-D** | sol（0.0441） | 5.4（0.0054） | 6581 | ✅ 真 |
| **relay-E** | sol（0.0598） | 5.4（0.0000） | 7 | ✅ 真 |
| **selfhosted**（自建） | sol（0.0707） | 5.4（0.0896） | 294 | ✅ 真 |
| **relay-A** | **时真时假** | 5.4（0.0553） | 48 | 🟠 间歇掺 luna |
| **relay-B** | **luna（0.0237）** | **luna（0.0422）** | 48 | 🔴 两个名字都冒名 |

噪声地板 0.0833。真 sol↔luna = 0.1815，真 sol↔5.4 = 0.2641（40 格口径）。

🔴 **除 relay-A 外都是单次结论**。relay-A 正是**单次跑通过、第二次才暴露**的——所以「一次绿灯」
不等于该端点干净，只等于**那一次**拿到的是真货。轮换是粘性的（一格 15 次全落同一后端）。

⚠️ **注入量与外壳效应无关，再次印证**：relay-D 注入 6581 token（六家最重）而 H_c 仅 0.0055；
relay-E 注入 7 token 而 H_c 为 0。**H 要靠采对照量，不能从注入量推**。

### 🔴🔴🔴 指名道姓：掺的是 `gpt-5.6-luna`（同代兄弟型号）

采一份官方 `gpt-5.6-luna` 参照（40 格 × 30 次，responses 线）后，全部对上：

| 待测分布 | 对官方 sol | 对官方 5.4 | **对官方 luna** | 判定 |
|---|---|---|---|---|
| **relay-B 的 `gpt-5.6-sol`** | 0.2325 | 0.3755 | **0.0237** | = **luna** |
| **relay-B 的 `gpt-5.4`** | 0.2646 | 0.3286 | **0.0422** | = **luna** |
| **relay-A 08:14 的 sol** | 0.2217 | 0.4144 | **0.0463** | = **luna** |
| relay-A 09:13 的 sol | **0.0364** | 0.4190 | 0.3011 | = sol ✅ |
| relay-C 的 sol | **0.0473** | 0.4306 | 0.2743 | = sol ✅ |
| selfhosted 的 sol | **0.0707** | 0.4891 | 0.3248 | = sol ✅ |

噪声地板 0.0833；真 sol ↔ 真 luna = **0.1815**。relay-B 的「sol」离 luna 比 luna 离 sol **近 8 倍**。

- **relay-B**：`gpt-5.6-sol` 和 `gpt-5.4` **两个名字都发 luna**。两处冒名。
- **relay-A**：平时发真 sol，某些时段发 luna。**间歇性**。
- **relay-C / selfhosted**：真 sol。

**为什么是 luna**：`gpt-5.6-luna` / `gpt-5.6-terra` 是 sol 的同代兄弟（`GET /models` 可见）。
同代兄弟正是最合理的掺假对象——名字像、更便宜、行为接近但不同。实测 terra 与 5.5 都不匹配。

**指认只花了 6 个探针的线索 + 1200 探针的确认**：`num100-random|en` 47→**73**、
`animal-random|ar` زرافة→**فيل** 这两个特征格，luna 在头 3 次采样就命中。

### ⚠️ 论文库比对失败：跑之前必须查该端点在 **chat 线**上的注入量

先试的是「拿 B 对论文 176 模型库排名」，**废了**：relay-B 在 chat 线注入 **~4692 token**
（responses 线只有 48），指纹被外壳淹没。

| relay-B **chat 线**实采 vs | JSD |
|---|---|
| 正版 sol | **0.4727** |
| 正版 gpt-5.4 | 0.2641 |
| *（参考：正版 sol ↔ 正版 5.4 = 0.4441）* |

它离正版 sol 比两个真模型之间还远；同端点同模型在 responses 线只有 0.233。
排名平铺（第 1 名 0.4029、第 2 名 0.4044，差 0.0015）**分不清「不在库里」和「外壳淹了」**。
1200 探针白花。

**教训**：论文库是 chat 口径、且在低外壳环境（OpenRouter）采的。拿它比对前必须先确认
**该端点在 chat 线上的注入量**——注入量随线路变，L0 画像量的是当时那条线。
又是「两侧口径不一致」，这次不匹配的是**测量环境与库**。

**替代路径更干净**：全程留在 responses 线，采候选模型的官方参照来指认。厂商 API 外壳仅 48 token，
不用碰论文库的 chat 口径，且参照可复用。

### 🔴🔴🔴 确认掺假：两家中转共用同一个非官方上游

把所有实采分布两两求距离（0 请求，偏置校正后；噪声地板 **0.0833**，官方 sol↔5.4 = **0.3839**）：

|  | 官方sol | relay-A坏 | relay-A好 | relay-B-sol | relay-B-5.4 | relay-C |
|---|---|---|---|---|---|---|
| **官方 sol** | — | 0.222 | **0.036** | 0.233 | 0.265 | **0.047** |
| **relay-A 08:14（坏）** | 0.222 | — | 0.254 | **0.058** | **0.085** | 0.255 |
| **relay-A 09:13（好）** | **0.036** | 0.254 | — | 0.257 | 0.299 | **0.071** |
| **relay-B sol** | 0.233 | **0.058** | 0.257 | — | **0.079** | 0.252 |
| **relay-B 5.4** | 0.265 | **0.085** | 0.299 | **0.079** | — | 0.276 |
| **relay-C sol** | **0.047** | 0.255 | **0.071** | 0.252 | 0.276 | — |

**数据里只有两个后端**（粗体 = 在噪声地板之下 = 测不出区别）：

- **A = 官方 sol**：official / relay-C / relay-A 大部分时候 / 自建网关
- **B = 某个非官方模型**：relay-B 的**两个模型名**、relay-A 的 08:14 时段
- **A ↔ B = 0.22–0.30**，是官方 sol↔5.4 距离的 6–8 成

**两家毫无关系的中转，在同样的格子上换成同样的答案**：

| 格子 | 官方 sol | relay-A 08:14 | relay-B |
|---|---|---|---|
| `num100-random\|ar` | 47 | **73** | **73** |
| `color-random\|en` | turquoise | **teal** | **teal** |
| `animal-random\|ar` | زرافة | **فيل** | **فيل** |
| `letter-random\|zh` | 鹤 | **澜** | **澜** |
| `word-random\|ar` | مجرة | **موز** | **موز** |

**结论**：

- **relay-B 掺假，确定**。两个模型名发同一个东西（互相 0.079 < 地板），而官方把这两个模型拉开
  0.384——**同一个东西不可能同时是两个相距 0.384 的模型**，所以至少一个名字是假的；实测两个
  都不匹配（离官方 sol 0.233、离官方 5.4 0.265–0.329）。**它的 `gpt-5.4` 铁定不是 gpt-5.4。**
- **relay-A 间歇性掺假，确定**。平时是真 sol（0.036，测不出区别），08:14 那一小时是 B
  （离 relay-B 常态 0.058 < 地板）。**不是降级到 5.4**（离官方 5.4 有 0.414），是第三个东西。

### 三个替代解释怎么排除的（都靠已有数据，0 请求）

| 替代解释 | 排除依据 |
|---|---|
| 网关强注入压平了分布 | 四组实采**输入 tok/探针全是 48**，无大注入 |
| 网关压低了温度 | 平均熵 relay-B 1.13/1.20、relay-A坏 1.06，对比官方 sol 1.42 / 5.4 1.12——**没塌**；更关键：**降温只让分布变尖，改不了 argmax**，而 13–16/29 格的**众数换了** |
| 订阅后端天生≠API后端 | relay-C 与自建网关都是订阅后端，都与官方判 consistent（自建还带最重外壳） |

**方法学收获**：**「两个独立端点收敛到同一个非官方分布」是最强的掺假证据**——外壳、采样参数、
订阅/API 差异都解释不了它。比单端点对参照的距离硬得多。

### 🔴🔴 最危险的假绿灯：对照模型也被换掉时，两个替换会互相抵消

`relay-B` 带对照跑 29 格，**代码原本判 ✅ consistent**：

```
H  外壳   0.4119 → H_c 0.3286   ← 巨大
S  待验   0.3158 → S_c 0.2325
D  尺度   0.1623 → D_c 0.0791   ← 塌到噪声地板 0.0833 以下
S/H = 0.71  90% CI [0.48, 1.00] → 整个区间在 1.5 之下 → "外壳解释了差距"
```

**但那个 H 不是外壳。** D_c 0.0791 意味着在 relay-B 上 `gpt-5.6-sol` 与 `gpt-5.4`
**几乎分不出来**——而官方把这两个模型拉开 0.3839（relay-A 0.391、自建 0.426）。
所以 relay-B 两个模型名发的是同一个东西，且那东西两个官方模型都不是。
S 和 H 一样大，只是因为**两边都被换了**。

**对照校准法的承重假设是「对照模型在两端都是正版」**。假设一破，H 就不是外壳测量，
「外壳解释了差距」变成「两个替换互相抵消」。

**修复**：`d_c >= 噪声地板` 的守卫从「只挡 suspect」改成**挡所有判定**。代码里原本就有这个
守卫，但放在 consistent 分支**之后**，所以从没被执行到。

⚠️ **`--no-control` 抓不到这一类**：D 那时取自两份参照，按构造就是正版模型对的距离，永远不塌。
所以「省探针」省掉的不只是外壳测量，还有这个。

### 🔴 relay-A 单次测量不可复现——轮换端点需要多次采样

同一端点、同一份参照、同一条线路、29 格，相隔一小时：

| 时间 | S_c | 判定 | 众数与参照不符的格子 |
|---|---|---|---|
| 08:14 | **0.2218** | ⚠️ | 11 / 29 |
| 09:13 | **0.0364** | ✅ | ~0 |

08:14 那次多个格子**整格塌成一个确定答案、且不是参照的那个**
（`animal-random|ar` فيل 100% vs 参照 زرافة 87%；`letter-random|ar` م 100% vs س 40%；
`num100-random|ar` 73 80% vs 47 97%），09:13 又全贴回参照。两次注入量都是 48 tok，
**不是外壳差异，是后端换了**。轮换是**粘性的**（一格 15 次全落同一后端），
所以**单次 L2 等于抽一次签**。

存档里「~70% 未注入 / ~30% 注入」的账号轮换，实际影响远大于注入量——**答案分布本身在换**。

**方法结论**：对已知轮换的端点，单次 L2 不足以定论，需要**跨时间多次重跑看分布**。
这是当前工具的已知缺口（`compare.js` 只取每端点最新一次）。

### 🔴 对照校准法的决定性验证：外壳最重的端点，扣掉外壳后模型是对的

`selfhosted`（自建 cliproxyapi，注入 ~294 token，四家里外壳最重）带对照跑 29 格：

```
H  外壳    0.1729 → H_c 0.0896   ← 高于噪声地板 0.0833，denominator: harness
S  待验    0.1540 → S_c 0.0707   ← 比外壳本身还小
D  尺度    0.5095 → D_c 0.4262
S/H = 0.79  90% CI [0.29, 1.28] → ✅ consistent
```

**四家里唯一一个 `denominator_basis: 'harness'`**——其余三家的 H_c 都低于噪声地板，分母走的是地板。
这是对照校准法第一次在「外壳确实很大」的端点上完成它的本职工作：量出外壳、扣掉、剩下的模型差距
比外壳还小。

**推翻了「订阅后端天生就跟官方 API 不一样」**：relay-C 与 selfhosted 都是订阅逆向后端，
都与官方 API 判 consistent（selfhosted 还带着最重的外壳）。所以 relay-A / relay-B 的差距
**不能**归因于「你拿到的是订阅版而不是 API 版」。

⚠️ **附带发现：自建网关不听 `effort:'none'`**。同样的请求，官方 reasoning-trace 率 **0%**，
自建网关 **46.2%**——与 cliproxyapi `apply.go` 会重写 thinking 配置吻合。不影响判定
（指纹层看不见 effort），但反过来加强了这个 ✅：推理档被网关改掉了，答案分布仍然对得上。

⚠️ **`--no-control` 用错地方会正好测成「网关处理水平」**：它把外壳项扔掉，外壳全算到模型头上。
外壳大的端点（如 selfhosted）必须带对照。判断依据是该端点的 H_c 有没有超过噪声地板，
而这件事只有采了对照才知道——所以**第一次测一个端点应当带对照**，确认外壳可忽略之后才好省。

### 🔴 「加格子」是精度的主要杠杆，不是加采样

| relay-C | 活格 | S/H 点估计 | S/H 90% CI | 判定 |
|---|---|---|---|---|
| 8 格电池 | 6 | 1.04 | [0.02, **2.19**] | ⚠️ |
| **40 格电池** | **29** | 0.57 | [0.10, **1.09**] | ✅ |

同样 15 次/格，只是格子从 6 变 29，区间上界从 2.19 收到 1.09 → 判定落地。
因为区间是对**格子**做 cluster bootstrap：6 个格子的重抽样天然粗糙、重尾，
每格再多采样也补不上。

⚠️ **别拿 6 格的数跟 29 格的数直接比**：选格按 SNR 排序取头部，格子少时方差大，
relay-A 的 `S_c` 从 6 格的 0.369 掉到 29 格的 0.222。

### 🔴 更正：「官方外壳只有 ~7 token → H 拉得开」是错的推理

上午那条推理把**注入 token 数**当成了**外壳对答案分布的影响**。两者不是一回事——
网关可以塞 4400 token 系统提示词而单 token 答案分布纹丝不动。实测：

| 参照 ↔ 待测 | H_c |
|---|---|
| 自建网关 ↔ relay-A（chat 线） | **0.328** |
| 官方 ↔ relay-A（responses 线） | **0.025** |
| 官方 ↔ relay-C（responses 线） | **0.002** |

官方与中转的**行为外壳几乎一样**，所以 H 很小。H 是判 consistent 的分母，分母小 → 判据变严。
**这不是缺点是变严格**：chat 线上那个 0.328 的 H 里混的是「两个中转互相比」，
它让 relay-A 轻松过关（S/H 0.42）。换成官方参照后同一个端点是 [1.70, 3.60]。

### 本轮修掉的判定层缺陷（此前 `evaluateL2` 零测试）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 定罪只看点估计、判无罪要区间 | 方向反了：冤枉诚实中转的代价最高。同端点相隔一小时的两次跑写成 suspect / inconclusive，**差一个样本** |
| 2 | H_c 低于噪声地板 → 放弃整轮 | 那恰恰是对照能给的**最好结果**。relay-C 的 `S_c/D_c=0.07` 被当作不可判定丢掉 |
| 3 | 打印的 S/H ≠ 判据用的 S/H | 一次跑打印 1.94，实际在判 20.8 |
| 4 | `makeL2Result` 丢掉 `reason` | 所有解释从未到达读者（L1 早修过，L2 漏了） |
| 5 | bootstrap 用 `(a,b)=>a-b` 排序 | `Inf-Inf=NaN` → `Array.sort` 未定义行为 → 区间算成 `[0,0]` → **6 格里 4 格答案完全不同会判 ✅** |
| 6 | `L2_LOGICAL_SAMPLES_PER_SIDE=90` 写死 | 电池一扩到 40 格，每次 L2 抛 `435 samples exceed the declared denominator 90` |
| 7 | `rejudgeL2` 把「没采对照」读成「对照 0% valid」 | `--no-control` 的存量结果全部重判成 `not_applicable` |

**共同形态**：④⑤⑦ 都是「不报错、只是让结果失去意义或悄悄反向」，与
[[silent-comparison-mismatch]] 同源。⑤ 是本轮最险的一个——出在一个减号上。

## 实测结论存档（2026-08-14 上午）

### 四家横评（L1 15 次/家 + L2 180 次/家）

| 端点 | 判定 | 距离 | 层 |
|---|---|---|---|
| **relay-A** | ✅ consistent | **S/H 0.479**，CI [0.294, 0.845] | L2 |
| **relay-C** | ✅ consistent | S 0.0178 | L1 |
| **selfhosted** | ✅ consistent | S 0.0544 | L1（正版基准） |
| **relay-B** | ⚠️ inconclusive | S/H 1.284，CI [0.476, **2.798**] | L2 |

### 🔴 L2 把 L1 的两个判定都翻掉了——对照校准法的第一次实战验证

| 端点 | L1 说 | L2 说 | 该端点的外壳项 `H_c` |
|---|---|---|---|
| relay-A | ⚠️ inconclusive（S=0.175） | ✅ **consistent**（S/H 0.48） | **0.328** |
| relay-B | 🔴 **suspect**（S=0.763） | ⚠️ inconclusive | 0.151 |

两次同一个原因：**L1 直接比 S，而 S 里混着外壳差异**。relay-A 的 `H_c` = 0.328 意味着
**同一个 gpt-5.4 在它与自建网关之间就已经差这么多**，L1 把这些全记到了模型头上。
「跨端点直接比指纹分不开外壳与模型」这句话，现在有两个自己的实测样本。

**读表规则**：L1 的距离**不能**当作模型差异读，它含外壳；只有 L2 的 S/H 去掉了外壳。

### L1 阈值必须用实测标定，模拟标定会误杀正版

参照刷新后两格变成「30 次全同一个答案」，模拟标定（从参照池重抽样）算出的
T_pass 塌到 **0.0178**——恰好等于「完美采样」的分数。而正版端点 5 次实测是
**0.0056 / 0.0178 / 0.0178 / 0.0416 / 0.0544**，**5 次里 2 次被自己的参照拒了**。

根因：**重抽样只能抽出池子里已有的答案**。参照说 `{47: 1.0}` 即其他答案概率为零，
JSD 对零概率惩罚极重（一个异常答案让该格跳到 0.108）——而模拟恰恰造不出那个事件。
现在 `T_pass = max(模拟 p99, 实测上界)`；不足 20 次时用「实测最大值 × 1.3」并标 provisional。

### 归一化口径必须与比对目标一致（一次静默的整轮作废）

`reference/genuine-*.json` 是**不带** reasoning-trace pass 采的（240 条里 154 条
`reasoning_len>0` 却全标 `valid`）。新采样路径带了 → 健康端点三分之二样本被打成
`post_reasoning` → 正版端点判 inconclusive。**不报错，比较直接失效。**

⚠️ **一个曾写错的说法**：`detectReasoningPairs` 的 `n >= 20` 门槛**不管**这件事，
它只管「字段缺失时的推断」；`emittedTrace` 对任何 `reasoning_len > 0` 直接判定。
15 个样本的 L1 一跑就触发。

### 🔴 更正：「支持 logprobs = 裸 API」这条判据在 Responses 协议下不成立

旧存档写过「支持 = 裸 API，用 logprobs 一次请求就能验模型」。**2026-08-14 在 OpenAI 官方 API
上实测：官方同样拒绝 `top_logprobs` / `seed` / `n`。**

原因是这三个是 `/chat/completions` 的参数，而 Codex 系走 **Responses API**，推理模型在这条
协议下本来就不提供 logprobs。所以拒绝它们**说明不了端点是不是转售裸 key**——那是协议差异，
不是能力差异。（与「打 chat 传 `reasoning_effort` 两端都无反应」是同一类错误：**把协议不匹配
读成了能力缺失**。）

**真正拉得开的是注入量**（L0b 的截距）：

| 端点 | 注入 token | 端点类型 |
|---|---|---|
| **官方 API** | **~7** | 裸 API，几乎无外壳 |
| 自建 cliproxyapi | ~294 | 订阅逆向网关 |
| relay-A | 4400–6600（注入时） | One API/New API 转发 |

官方还接受 `mode:pro` 与 `temperature`（自建网关两个都拒），也是有用的区分位。

### 参照来源：2026-08-14 起改为 OpenAI 官方 API

`config/endpoints.json` 的 `genuine` 标记从自建网关移到 `official`。三个理由：

1. **身份无需推断**——官方按定义就是 ground truth，而「供应链确认」是靠论证得来的，弱一档；
2. **外壳几乎为零（7 token）→ L2 的 H 项拉得开**。H 是判据的分母，H 大则比值稳：实测
   relay-A（H_c 0.328）区间 [0.29, 0.85] 干净利落，relay-C（H_c 0.099）区间宽到 [0.16, 3.95] 判不了。
   **拿一个「外壳与待测很像」的端点当参照，等于自己把分母压小**；
3. 合规表里那条「订阅逆向与 ToU 明文冲突」的采参照用途随之消失。

⚠️ **换参照会作废 L1 的实测阈值**——`T_pass` 是从「正版端点实测 S」标定的，基准换了就得重标。
代码按 `reference_version` 过滤历史分数，旧数据会自动排除，但那几次实测要重跑。
**自建网关从此是待测对象之一，不再是参照。**

### 端点画像（L0，实测）

| | selfhosted | relay-A | relay-C | relay-B |
|---|---|---|---|---|
| 框架 | openai-compatible | **One API/New API** | **One API/New API** | openai-compatible |
| `/api/status` | 无 | 开放 | 开放 | 无 |
| 模型数 | 19 | 13 | 8 | 19 |
| p50 延迟 | 3056ms | **1726ms** | 2088ms | 5810ms |

自建网关实测：effort 接受 none/low/medium/high/xhigh/max，**拒绝 minimal 与 ultra**；
`mode:standard` 接受、`pro` 拒绝；**logprobs / seed / n / temperature 全拒绝**（订阅逆向网关特征）。
juice 随档位变（none=8、max=960）。

🔴 **画像的接受度有四种取值，`null` ≠ `false`**：2xx=支持、**4xx=不支持**、
**5xx/网络失败=`null`（探过但没测出来）**、未探=`not_probed`。
把 5xx 记成「不支持」会把端点抖动的一分钟冻成永久结论——实测中一次 503 潮曾让画像
报告「该网关不支持 seed / n / temperature」，而它们只是当时没答上来。

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

- **2026-08-14 下午** 判定层大修 + 实测确认掺假。**163 测试全绿**，16 个变异全杀。

  **抓到了真东西**：relay-B 的 `gpt-5.6-sol` 与 `gpt-5.4` **两个名字发的都是 `gpt-5.6-luna`**；
  relay-A **间歇性**掺 luna（同一天相隔一小时，一次真一次假）。relay-C / relay-D / relay-E /
  自建网关都是真货。详见「指名道姓」与「六家横评总表」。

  🔴 **本轮修掉的缺陷有一个共同形态：守卫写了，但永远不可能触发。**
  ① `screen.js` 把 `refSubject` 当两个参数传给 `assertSameProtocol`——任何一对文件都不可能让它失败；
  ② D 塌陷守卫放在 consistent 分支**之后**，只挡得住 suspect（relay-B 的假绿灯就是从这里漏的）；
  ③ `consistentPoint` 在数学上被 `ci.hi < 1.5` 蕴含，是死代码；
  ④ `makeL2Result` 只挑命名字段，把算好的 `reason` 整个丢掉。
  **全靠变异检验暴露**——第一轮 5 个变异活下来 3 个，说明测试本身是空的。

  另外两个真 bug：`(a,b)=>a-b` 排序遇 `Infinity` → `Array.sort` 未定义行为 → 区间算成 `[0,0]` →
  **6 格里 4 格答案完全不同会判 ✅**；`L2_LOGICAL_SAMPLES_PER_SIDE=90` 写死，电池扩到 40 格即抛错。

  **两次花钱买的教训**：变量名手滑（`sampledControl` vs `sampleControl`）白烧 435 探针；
  没查 relay-B 在 chat 线的注入量（4692 tok）就去对论文库排名，白烧 1200 探针。
  **凡要花额度的路径，先用 stub probe 端到端跑通再发真请求。**
- **2026-08-14 上午** 按 plan 实施阶段 0-6、8（reasoning 巡检那层留着没做）。141 测试全绿。
  四家端点实测横评见「实测结论存档」。**L2 把 L1 的两个判定都翻掉了**，验证了对照校准法的价值。

  🔴 **本轮踩到同一个失效模式三次，都不报错、只是让比较悄悄失去意义**：
  ① **归一化口径**不匹配（参照不带 reasoning-trace pass，新采样带了）→ 正版端点判 inconclusive；
  ② 横评表**直读结果文件里存的 verdict**，而那是采集当天的口径算的 → 表和 rejudge 自相矛盾；
  ③ **指纹层协议**混用（chat vs Responses 分布不同）→ 已加 `assertSameProtocol` 拦截。
  **三次都靠跑真实数据才暴露，静态读代码一次都看不出来。** 凡是"比较两侧"的地方，
  两侧是怎么测出来的必须记在数据里并在比较时校验——这是本项目最贵的一条经验。

  其他修正：**L1 阈值必须实测标定**（模拟标定在确定性参照上误杀正版，5 次里 2 次）；
  L0b 接受度**四态**（5xx ≠ 不支持）；reasoning gap 告警**要报方向**（多≠降档）；
  口径回归测试改用 `test/fixtures/reference/` 冻结快照（活参照一刷新就红 = 会被静音的测试）。
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
