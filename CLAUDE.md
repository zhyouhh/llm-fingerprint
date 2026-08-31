# llm-fingerprint

用**单 token 输出分布指纹**检测 API 中转商有没有偷换模型。

## 问题 / 目标用户

用户 = ZhYoU，自己买第三方中转 API 跑 Claude Code / Codex。中转链路不透明：付的是 `claude-opus-4.8` 的钱，实际后端可能是量化版、同族小模型、甚至别家开源模型，且**通常不是一开始就换，是跑一阵后悄悄降配**。

本工具用极低成本（每次探测 1 个 output token）采集端点的行为指纹并比对，回答两个问题：

1. **判定**：这个端点还是原来那个模型吗？（主用途，可靠）
2. **识别**：那它最像什么模型？（**定罪主力**，见下节）

> ⚠️ 论文报的"家族准确率 59.5%"是**另一个问题**的数字：176 个跨厂商模型、无分离度门槛、
> 只问"最近的是谁"。本项目的指认是 **同厂商 10 份自采参照 + 2× 分离度 + 12 格下限**，
> 是个窄得多也严得多的问题。两个数不可比——但也别把这理解成"所以我们更准"：
> 我们的记录是 in-sample 的（见下节），论文那个至少是在一个大得多的集合上量的。

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

## 🔴 定罪靠指认，不靠 S/D —— S/D 对「换成最近邻」结构上无能为力

`S/D ≥ 0.7` 这条定罪线**抓不到最常见的掺假**，而且不是调参能解决的。掺成最近邻时
`S ≈ D`，比值天然落在 1.0 附近，而区间是对**格子**做 cluster bootstrap、宽约 ±30%，
要求整段过 0.7 就在刀尖上。**加采样没用**——重抽样抽的是格子，而电池已经把活格全用上了。

实测（同一批样本，只改 D 的取法，对全部存量 L2）：

| D 取自 | 4 次已确认掺假中定罪 | 5 次已确认正版中冤枉 |
|---|---|---|
| 最远的参照（`pickControl` 的选法） | **0** | 0 |
| 最近邻参照 | 1（一次漏的下界是 0.69，差 0.01） | 0 |
| **指认层** | **4** | **0** |

⚠️ **这张表是 in-sample 的**：`MIN_ID_CELLS` 和判据都是对着这十来次跑定的，用同一批数据
"验证"它自己。诚实的说法是「在我们手上这些数据上它没错过」，比听起来弱得多——
没有留出集、没有第二个采集时期、没有带区间的误报率。要变成真证据，得先把阈值定死，
再收一批完全没参与定阈值的正版跑（跨网关、跨型号对、跨采集时期）来量误报率。

所以**换分母是错的解法**，正确的解法是让指认层成为一条独立的定罪路径：

```
verdict = suspect  if  identification.impostor      ← 指认出一个你没买的型号
                   or  S/D 区间整段 ≥ 0.7           ← 保留，管参照库外的东西
```

- 规则在 `src/layers/model-matrix.js` 的 `identification()`，**只有一份**：`evaluateL2`、
  `rejudge`、CLI、网页报告全都调它，谁也不许自己套门槛
- **五道闸，每道挡的是一种不同的错法**：
  | 闸 | 值 | 挡什么 |
  |---|---|---|
  | `SEPARATION` | 2.0 | 差距够不够大到能算一个主张 |
  | `RANKING_STABILITY` | 0.95 | **重抽格子时那个名字还是不是第一**——不是同一件事 |
  | `MIN_ID_CELLS` | 12 | 格子太少时排名会翻（同端点 3/6/29 格给出三个不同答案） |
  | `refuted_by` | — | 没有哪个覆盖不足的候选，在**共有格上**比赢家更近 |
  | `validRate` | ≥ 0.80 | 丢格不随机，幸存格能稳定指向一个错的型号 |
  加上**分母兜底在噪声地板**（否则距离恰好为 0 时比值爆成 ∞——两份近似重复的参照、一次运气好的
  采样就能"无限确信"地冤枉人）
- 🔴 **五道闸全在 `identification()` 里，一道都不许放在调用方**。有效率那道原本放在
  `evaluateL2`，结果它只挡住了**那一个函数的 verdict**——而 `headline()` 先读 `impostor`
  再读 verdict，报告页和 CLI 又各自拿存量样本**重跑**一遍 `identification()`。于是一次
  57% 有效率、被压成 inconclusive 的跑，**在所有人真正会看的地方照样是红色指名指控**。
  **闸不在它守的那个对象里，就不是闸。**
  `validRate` 因此是**必传**（可显式 `null` = 不详，同样不定罪）——默认值等于替调用方
  选了「定罪」那一边。结果里的 `withheld` 说明是哪道闸拦的（`refuted`/`cells`/`valid_rate`/
  `separation`/`stability`），好让报告能解释而不是沉默。
- 🔴 **噪声地板要按每格实际拿到的样本数算，不是按计划的 reps**。一格丢了 5 个探针，它的重复
  测量散布就比没丢的宽，而 `selection.repsPerCell` 对两者都说 15。低估地板 = 抬高**每一个**
  以它为分母的比值，方向是**倾向定罪**——而被限流薅掉样本的正是那些格子。
  `noiseFloor` 现在收「一个数」或「逐格的 map」（传数时逐位行为不变）。
- 🔴 **`rank_stability` 不是 `separation_lo` 的换个说法**。区间下界只描述「全量数据上排前二的
  那一对」，第三个候选可以在十次重抽里抢走一次第一而那个数纹丝不动。稳定度是对**全部**候选
  每次重抽都重排一遍，报「最近的那个有多少比例的次数还是它」。
  ⚠️ 曾经用 `separation_lo > 1` 当闸，而 `impostorReason` 的文案说它「必须保持在 1 以上」——
  实际那条从不被检查，一次 `separation_lo = 0` 的定罪照样发出，解释它的句子还写着这不可能。
- 🔴 **重抽时并列不算谁赢**。排名用型号名破并列，bootstrap 却保留数组顺序、把并列算给靠前的
  那个——于是**判决取决于参照文件的加载顺序**。实测反例：11 个格子无区分力 + 1 个有，
  `[cand, sold]` 给出稳定度 1.000 并定罪，`[sold, cand]` 给出 0.638 不定罪，**同一批指纹、
  同一批样本**。现在并列的那一抽对谁都不算数。
- 🔴 **噪声地板按「正在相除的那一对 × 那一抽的格子」取**。三个错法都踩过：
  ① 用全量前二的地板去除第三名——每次重抽都重排，那一抽相除的可能是任意一对；
  ② 改成全库取最大——等于让库里最抖的那份参照（`gpt-5.4-nano`）去决定 sol 和 luna 分不分
  得开，实测把一次已确认的掺假从 3.6× 压到 2.2×；
  ③ 每个型号存一个标量——可 bootstrap 重抽的是**格子**，分子按抽到的格子平均，分母却按全部
  格子平均，两边不同权重。做法：`modelFloors()` 一次算出每个型号的 `{overall, byCell}`，
  点估计用 `comparisonFloor(floors, [sold, best, runnerUp])`，每一抽用那一抽抽到的格子重新平均。
  ⚠️ 修完 `separation_lo` 是**变小**的，且这才是对的：5% 尾巴由「噪声格抽了好几次」的抽样
  构成，它们真实的分辨极限是那格的 ~0.5 而不是全局平均 ~0.04——标量恰好在**信息最少**的
  那些抽样上给出了虚高的信心。
- **所有候选在同一批格子上排名**。`meanJsd` 是逐对取交集的，照那样排，一份只覆盖一半格子的
  参照可以在那一半上完美命中、拿 0 分打败覆盖全部格子的参照——没答的那一半根本不计入
- 🔴 **veto 也必须是同一批格子上的对比**。覆盖不足的候选**不能赢但能否决**，可它的均值算在
  它自己的格子上，而赢家的均值算在全部共有格上——两个不同东西的平均数中间放个 `<=`，
  正是 [[silent-comparison-mismatch]] 的形状。失效方向要命：赢家 18 格上均值 0.33、
  候选 6 格上 0.61 → 不否决；而在那 6 格上赢家其实是 1.0，候选明明更近。
  现在存 `value_vs_best` / `best_value_here`，两个都在**双方都答的格子**上算。
- **顺序在所有门之前**。指认只用待验侧，所以：控制侧被 429 打死（`not_applicable`）不该埋掉它
  ——实测两次真实跑分别丢了 102 / 137 个探针；D 塌陷说的是「H/S/D 这套算不了」，也与它无关。
- 🔴 **但待验侧有效率不达标就只报告、不定罪**（上表第五道闸）。理由是丢格**不随机**：
  429 打死的 12 格平均 S 0.140、活下来的 16 格 0.211。29 格 × 15 次里只要**头 12 格**活下来
  就同时过得了 20% 有效率线和 12 格线，而对幸存格重抽只会报出接近 1.0 的稳定度
  ——**它看不见死掉的那些正是不同意它的**。这一档 `impostor: false` + `withheld: 'valid_rate'`，
  但 `nearest` / `leaning` 照常带着结论，reason 也写明（埋掉它是这个项目已经犯过的错）
- ⚠️ `assertL2Result` 里 `impostor + consistent` 那条断言**从 `evaluateL2` 走不到**
  （指认分支先 return）。它守的是**契约边界**——任何别的地方手工拼一个 L2 结果时——
  所以只能直接调 `assertL2Result` 来测，变异检验也是这么验的。不要写成「两条路打架会报错」
- `evaluateL2({refs})` **必传**（可显式 `null`）。少传 = 悄悄丢掉唯一能抓同代掺假的路，
  是 [[silent-comparison-mismatch]] 的形状，所以按 `applyReasoningTrace` 的先例强制显式
- 结果里的 `identification: null` 意思是**没查**（没给参照库），不是「查了没匹配」

⚠️ **能力边界**：这条路只认得出参照库里有的型号。掺了库外的东西（开源模型、量化版）
它报「说不准」，那时只能回落到 S/D —— 而 S/D 就是上面那个抓不住的东西。**这是工具的
真实上限，不是这次改动造成的。**

🔴 **顺带修掉一个潜伏的判定 bug**：`identify()` 用 `Number.isFinite(sep)` 当闸，
而距离恰好为 0 时 `sep = Infinity` —— **完美匹配反而永远不能命名**，2.1× 能过、∞ 不能过。
改成拒 `NaN`（`0/0` 才是真的分不开）。这是 [[guards-that-cannot-fail]] 的镜像：
闸没有永不触发，而是**恰好把最强的证据挡在门外**。

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
| **L2 精确校准** | 指认（对全部参照排名，定罪主力）+ H / S / D（对照校准法）+ 偏置校正 + bootstrap 置信区间 | **活格×15×(采对照?2:1)**；29 活格 = 870 / `--no-control` 435 | **模型身份**（最硬）；配多份参照可**指认型号** | 是 |
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
**`ui/` 允许引入依赖，引入时须在本节登记**。原生 `fetch` + `node:test`。
不引入统计库 —— JSD / ROC / EER 自己实现，正确性由 golden test 保证。

**已登记的依赖（全部是 `ui/` 的 devDependencies，运行时依然为 0）**：

| 包 | 用途 | 为什么不能没有 |
|---|---|---|
| `vite` | 打包 + dev server | 浏览器要把 `src/` 的 ESM 与两个 vendor JSON 打成一份产物 |
| `wrangler` | 部署 Worker | Cloudflare 官方 CLI |
| `@cloudflare/vite-plugin` | dev 时在 workerd 里真跑 Worker | 否则代理逻辑得写第二遍给 dev server 用 |

网页产物本身**不含任何第三方运行时代码**：热力图、区间条、DOM 构造全是手写（`ui/src/ui/dom.js`
是 40 行的 `h()`）。不上前端框架的理由是奥卡姆——三个视图、单向数据流，reconciler 不划算。

⚠️ **`ui/wrangler.jsonc` 的 `compatibility_date` 钉在本地 workerd 支持的日期**（当前 2026-08-11）。
写成今天会让 `vite dev` 直接拒绝启动（`ERR_FUTURE_COMPATIBILITY_DATE`），于是本地与线上跑的
不再是同一个运行时。升级 wrangler 时才跟着抬。

## 命令

🔴 **端点与 key 的传法**：候选端点写在 `config/endpoints.json`（**gitignored**——不含 key，但含每家的 base_url；仓库里提交的是 `config/endpoints.example.json` 模板），
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

# 0 请求：指认——把存量实采分布放到地图上，回答"那它到底是哪个型号"
node scripts/identify.js [--fp-protocol responses] [--endpoint a,b]

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

## 🔴 三个地板，三种比较——一个数校准不了三个量

H、S、D 比的是三对不同的东西，样本数也可能不同，所以各带各的校正：

| 量 | 比什么 | 校正 | 为什么 |
|---|---|---|---|
| **S** | 本次待验 vs **存储的**待验参照 | `noiseFloor(subjPools, subjReps, against:'pool')` | 零假设是「还是同一个模型」→ 整个距离都是采样噪声 |
| **H** | 本次对照 vs **存储的**对照参照 | 同上，但用**对照侧**的池和计数 | 同上，且它是自己那次比较 |
| **D** | 本次待验 vs 本次对照（采了对照）<br>两份**参照**互比（`--no-control`） | `pairBias(...)` | **跨模型**：真值很大，上面只叠一点偏差 |

🔴 **D 不能用噪声地板当代理，差一个数量级**。实测 P={a:1} vs Q={a:25/30,b:5/30}、30 样本：
真值 0.0888、真实偏差 0.00098、同模型地板 0.0134 —— **多扣 13.7 倍**。
而且**方向不安全**：D 是分母，多扣 → 分母变小 → S/D 变大 → 更容易定罪。
「取两个地板里较大的那个」这条推理在 `comparisonFloor` 里是保守的，**在这里正好相反**。

`pairBias(poolsA, poolsB, repsA, repsB)` = 各格 `E[jsd(抽A,抽B)] − jsd(A,B)` 的均值，clamp 到 0。
两边同池时真值为 0，它**逐位退化成 `noiseFloor`**（有测试钉住）。
⚠️ clamp 的理由要说准：单次有限抽样**确实可能**让两个分布看起来更近（{0.6,0.4} 与 {0.4,0.6}
各抽一次都抽到 a 就是 0）；非负的是**期望**偏差（JSD 的联合凸性）。clamp 截的是蒙特卡洛误差。
⚠️ `pairBias` 必须**结构上**对称：一个 RNG 流会给两侧不同的随机数段，同一对模型换个方向
偏差差 2.3 倍。每格按 `JSON.stringify([n, pool])` 定序后再抽——**不能用分隔符拼键**，
任何单字符分隔符都会碰撞（`["z","a\u0001b"]` 与 `["z","a","b"]`）。

🔴 **「这个量是不是格子的属性」是唯一该问的问题**。同一个缺陷在四处各犯一次：
`rankingBootstrap` 的地板、`ratioCI` 的 `correctBy`/`correctDen`、`ratioCI` 的 `denomFloor`、
矩阵的对角线 vs `pairFloors`。最后一处我还专门为「它是分辨极限不是偏差」辩护过一轮——
**分辨极限也是格子的属性**。所有校正现在都收「一个数或逐格 map」，重抽时按抽到的格子取均值；
map 必须覆盖每一个参与比较的格子，**缺键报错而不是补 0**。

🔴 **算不出的地板 ≠ 0**。`noiseFloor({})` 按构造返回 0，`ratioCI` 缺键补 0，两者一叠加
= 「这次比较完全没有噪声」——**用最少的证据说出最有把握的话**，构造出来能把正版端点
以 S/D 下界 1.0 定罪。参照在参与比较的格子上不足 `REFERENCE_MIN_N` 就整轮 `inconclusive`，
且**不可校准的那几个量报 NaN 而不是那个池算出来的数**（它们在页面上看起来跟正常值一样，
而 verdict 不用它们，所以没人会去质疑）。⚠️ 新跑会在选格时过滤薄格子，但 **`rejudge` 沿用
存量跑的格子**，薄格子原样回来——这条路才是它可达的原因。

## 🔴 429 会系统性地改判定——这是测量完整性问题，不是可靠性问题

实测两次真跑：一侧 420 个探针里 **102 / 137 个死于 HTTP 429，另一侧 0 个**（待验电池先跑，
把每分钟配额烧光）。整格因此掉到样本线以下被丢掉，**而且不随机**：被打死的 12 格平均 S
**0.140**，活下来的 16 格 **0.211**——判定所依据的那个数被系统性抬高 17%，取决于配额在哪一分钟耗尽。

旧策略结构上不可能有用：3 次尝试、1.5s→3s，**4.5 秒就把预算花完**，而限流是按**分钟**算的。
所以修的是**什么时候发**，不是发几次，而且是**共享**的：一次 429 把打向该目标的**所有**请求
一起停住，六个 worker 等一次而不是六次。

| 常量 | 值 | 说明 |
|---|---|---|
| `rateLimitCooldownMs` | 20s | 服务器没给 `Retry-After` 时的兜底，连续限流翻倍，上限 90s |
| `rateLimitBudgetMs` | 5min | **墙钟**，不是各 worker 等待时间之和 |
| `rateLimitRecoveryMs` | 60s | 清净**且服务器期限已过**才重开预算窗口 |
| `rateLimitCooldownMaxMs` | 90s | 只封顶**我们自己编的**退避，绝不封顶服务器说的 `Retry-After` |

四条都在**重试契约**里（`assertRetryConfig`），理由和 `baseDelayMs` 一样：要花五分钟真等才能
走到的分支，测试就不会写，那个分支就永远没人钉。`rateLimitCooldownMaxMs` 就是这么来的
——「不截断服务器说的期限」这条硬是活过了两轮 review 的变异检验，因为要观察到差别得真等 90 秒。

🔴 **踩过的六个坑，每个都让机制在最需要的时候失效**：

1. **预算按各 worker 求和** → 并发 6 时五分钟预算约 50 秒烧光，限流自己关掉；实测 120 个探针
   死 80 个、24 格里 16 格没采满。改成墙钟。
2. **窗口从不重置** → 第一次 429 之后五分钟，节流对该端点**永久关闭**，后半个电池以及同进程/
   同标签页之后所有的跑都不再等待——**精确复现它本来要修的那个偏差**。改成滚动窗口。
3. **恢复只在「后续有一次成功」时判定** → 跑安静了（换到另一侧、用户暂停）再回来，
   `windowStart` 还是几分钟前的、预算已经花光。改成**读取时**就判过期。
4. **过期只看清净时长，不看服务器期限** → `Retry-After: 300` 比恢复窗口长，于是第 60 秒来的
   调用方直接把它作废、开始撞服务器。过期要**两个条件同时成立**。
5. **把 `Retry-After: 300` 截断成 90s** → 在服务器明说的期限前抢跑三次。上限只管**我们自己
   编的**退避。而且预算耗尽时若期限仍未到，**必须放弃这个探针而不是继续发**——否则六个 worker
   会在预算线上同时发一批注定被拒的请求，正好在丢格最严重的时候。
6. **`attempts` 在真正发请求之前就加了** → 停在预算线上或被取消时，一次 fetch 报成两次。
   而 `attempts` 按判定语义⑤就是**网络尝试次数**，谁拿它衡量「我们把端点压得多狠」，
   拿到的都是**压得最轻时被抬得最高**的数。

🔴 **取消要一路传到 `request()`**。包一层 probe 只拦得住**还没开始**的探针；已经进到共享冷却里
的 worker 是自己在等，`createResponsesClient` / `createChatProbe` 不把 `cancelled` 传下去，
按了 Stop 它照样等满再重试，继续花你的额度。
⚠️ 这条曾经「有测试且全绿」——因为测试直接调 `request(..., {cancelled})`，**正好绕开了断掉的
那截接线**。测取消必须走 UI 真正构造的那个客户端。
⚠️ 而且**漏传和「本来就没有」长得一模一样**：`clientsFor` 原本给 `cancelled` 一个 `null` 默认值，
于是 L2 的 preflight 忘了传，看起来跟 L0（真的没有取消路径）没区别。现在必传、可显式 `null`
——跟 `applyReasoningTrace` / `refs` 同一个先例。

## 目录

```
config/
  endpoints.json        候选端点清单（**gitignored**：无 key，但有各家 base_url。key 走 auth_env 指名的环境变量）
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
    noise.js            噪声地板（same-model，`against:'self'|'pool'|n` 决定另一侧抽多少）
                        + `pairBias()`（**cross-model 偏差**，同池时逐位退化成噪声地板）
                        + `comparableCells()` / `REFERENCE_MIN_N`（参照侧每格样本下限，**唯一一份**）
    bootstrap.js        比值的 90% 置信区间（对**格子**重抽样）。
                        🔴 `correctBy` / `correctDen` / `denomFloor` 都收「一个数或逐格 map」，
                        重抽时按抽到的格子取均值；map **必须覆盖每个参与格，缺键报错不补 0**
    guards.js           逐层守门；`usableCells` 的 minN **无默认值**
  probe/
    runner.js           采样引擎（自己不重试；`applyReasoningTrace` 必须显式传）
    cells.js            格子选择（SNR 排序、剔死格）+ L1 阈值标定（模拟 + 实测合并）。
                        🔴 参照侧同样过 `comparableCells`；地板缺失记 NaN 而不是 0
                        （否则采得最少的格子 SNR 无穷、被快筛优先选走）
    http/               🔴 **唯一出站目录（I-4）**
      transport.js      重试 + 错误分类 + 超时（**非 2xx 不抛，返回值**）
      chat.js           指纹路径（论文口径，请求体字节冻结）
      responses.js      Responses 客户端（effort / mode / store:false）
      fingerprint-probe.js  🔴 指纹层双协议 + **跨协议比较拦截**（见下节）
      get.js            L0a 的两个 GET
  layers/
    l0-profile.js       L0a 零请求画像 + L0b 能力探测（接受度四态）
    l1-screen.js        L1 快筛：`evaluateL1`（纯函数）+ `screenL1`（采集）
    l2-calibrate.js     L2 校准：H/S/D + **三个各自的地板** + bootstrap 区间 + H_c 定义域守卫。
                        参照薄到算不出地板时整轮 inconclusive，且不可校准的量报 NaN
    rejudge.js          🔴 按**当前**口径重判存量结果文件（0 请求）——`rejudgeL1` + `rejudgeL2`
    result-file.js      结果文件写入 + L0a/L0b 合并（两个计数求和）
    genuine-history.js  从结果文件收集正版端点实测 S（用于实测标定 T_pass）
    compare-table.js    横评表：L2 优先于 L1、排序序、逐层计数求和
    model-matrix.js     参照两两距离矩阵 + `identify()` / `identification()`。
                        🔴 **对角线放各模型自己的噪声地板**，不是 0——没有它读者
                        无从判断 0.18 是大还是小。但**对角线只供阅读**：
                        判定用 `pairFloors[i][j]`（只在该对共有的格子上量），
                        `classifyPair(distance, bar)` 只收一个已配对的门槛，
                        让「传错一对地板」在结构上不可能；
                        `live[i][j]` = 该对有区分度的格子数，`pickControl` 数的是它
                        🔴 **指认看「与次近的分离度」，不看绝对距离**——绝对距离含外壳
                        （自建网关离它真发的模型也有 0.154），比值把外壳削弱（不是消掉）
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
  identify.js               【指认】把存量实采分布放到地图上，报"这到底是哪个型号"，0 请求
  compare-baselines.js      ⚠️ **已弃用但仍在仓库里**（功能并入横评聚合层）
  calibrated-compare.js     ⚠️ 同上。plan 的收尾清单里「删除这两个」那一项**还没打勾**，
                            而 README 声称阶段 0-6 已完成——两句话对不上，以这里为准。
                            🔴 留着的代价是 plan 当初写的那条：**两套并存的判定路径**。
                            这次 16 轮 review 的绝大多数缺陷正是「同一个判据在两处不一致」，
                            所以这不是洁癖，是同一族风险。删之前先确认没人在用。
vendor/pamela/       上游 MIT 代码，逐字复用，不改写（含 ATTRIBUTION.md）
reference/<protocol>/  正版参照指纹（提交进 git，脱敏无端点URL）。
                     `chat/`      采自自建网关：gpt-5.6-sol / gpt-5.4（8 格）
                     `responses/` 采自 OpenAI 官方 API：**sol / 5.4 / luna**，各 40 格 × 30 次。
                     🔴 luna 那份是**指认掺假型号**用的。⚠️ 早先写过「15 探针的 L1 就能认出 luna」，
                     那条已作废：`MIN_ID_CELLS = 12` 之后 L1 的 3 格永远不指名——L1 只答
                     「还是不是它」，「那是什么」要跑 L2
probes/              knowledge.json（知识题库）+ calibration.json（推理题校准）
data/upstream/       Zenodo 原始数据（gitignored，~500MB 解压，npm run fetch-data 获取）
baselines/           采样产物（gitignored，含端点URL）
var/runs/            结果文件 `<id>__<tier>__<ts>.json`（gitignored，绝不含 key）
test/                **19 个文件 / 241 项全绿**（`npm test` 跑 `test/**/*.test.js`）：
                     golden/g0-normalize · g1-jsd · g2-verification（复现论文数字）+
                     contract（判定语义 + I-N）/ runner / l0-profile / l1-screen /
                     l2-verdict / cells / noise / guards / bootstrap / config /
                     golden-guard / fingerprint-protocol / reference-store /
                     model-matrix / probes / **rate-limit**（429 是**测量完整性**问题，
                     不是可靠性问题——见「429 会系统性地改判定」一节）
test/fixtures/       🔴 **冻结快照**：reference/（口径回归测试的输入，与活的 reference/ 解耦）、
                     chat-request-snapshot.json（I-1 字节锚点）、responses-sample.json（真实响应体）
ui/                  **网页版**（已上线 llmfingerprint.z0y0h.work）。自带 CLAUDE.md，
                     devDeps 仅 vite / wrangler / @cloudflare/vite-plugin，**运行时依赖仍为 0**。
                     🔴 默认不采对照、headline 走指认层——见下节的对比表
```

**没有 CLI 统一入口**（曾设想 `cli.js`，未做）：各脚本单一职责、按需组合，加 wrapper 不划算（奥卡姆）。
横评用 `compare.js` 遍历，那不是 wrapper 而是聚合层。
验新中转的标准顺序见「## Runbook」。

## 网页版（`ui/`）—— 计算在浏览器，Worker 只转发

上线于 **https://llmfingerprint.z0y0h.work**，公开访问，任何人可以拿自己的中转 URL + key 测。
完整约定见 [`ui/CLAUDE.md`](ui/CLAUDE.md)；这里只记与主项目耦合的三条。

**🔴 判定代码只有一份。** `ui/` 把 `src/` 直接打包进浏览器——归一化、JSD、噪声地板、
`evaluateL1` / `evaluateL2` / `identify` 全部是 CLI 和 golden test 跑的同一份实现。
`ui/src/core/` 只做接线（喂数据、构造 probe、存结果），**不许重写任何统计或判定**。

**🔴 网页版与 CLI 有意不同的两处，都在「采什么 / 先说哪句」，不在怎么算**（2026-08-17）：

| | CLI | 网页版 | 为什么 |
|---|---|---|---|
| `sampleControl` | 默认 `true` | **默认 `false`，界面上没有对照相关控件** | 对照的前提正好是待查的事（relay-B 的 terra 也是 luna）；选哪个对照会翻判决；实测八次可信测量里六次外壳低于噪声地板 |
| headline | verdict 原文 | **指认层优先**：命名了你没买的型号 → 红，指名道姓 | 一次 inconclusive 的跑，指认层早已以 3.55× 认出 luna，页面却用蓝色写「证据不足」 |

存量结果全部按不采对照重判：**没有正版端点掉出绿灯**（含外壳最重的自建网关），
而 2026-08-14 那个假绿灯翻成 inconclusive——因为「两个替换互相抵消」需要一个被顶高的 H，
不采对照时 H 按构造为 0，那个失效模式不存在。

⚠️ 由此暴露出判定层的一个结构性缺陷，**已修，但修法与第一直觉相反**——见下节。

**为此对 `src/` 做了三处解耦**（Node 侧签名与行为完全不变，172 项测试全绿）：

| 改动 | 为什么 |
|---|---|
| `normalize/index.js` 拆出 `core.js`（纯）+ `vendor-config.js`（读两个 JSON） | 浏览器唯一跑不了的就是那两次 `readFileSync`。拆文件而不是复制一份浏览器版归一化 |
| `mergeCollections` 从 `layers/result-file.js` 移到 `contracts.js` | 前者 import `node:fs`，浏览器够不着；它决定 L0 产物形状，两边必须一致 |
| `runner.js` 的 `onProgress` 改成**逐样本**回调并带 `cell` / `ok` | L1 只有 15 个探针，10 步节流让网页的实时格子只更新一次 |

构建时只换掉 `vendor-config.js` 一个模块（`ui/vite.config.js` 的 resolveId 钩子，比对**解析后的绝对路径**，
不是 import 字符串——同一模块被两种相对路径 import，能同时命中的模式也能命中别的文件）。

**参照瘦身是可证明无损的。** `ui/scripts/build-data.js` 把 2.3MB 参照压成 157KB
（丢掉 `samples`，保留每格**按原顺序**的 valid 答案），然后对**每一个有序对**重跑
`selectCells` / `noiseFloor` / `calibrateL1Thresholds` / `evaluateL1` / `evaluateL2` / `modelMatrix`，
逐位不等就退出码 1、不写文件。顺序是硬要求：`drawWithReplacement` 按索引抽，重排会让噪声地板漂移。

```bash
npm --prefix ui install
npm --prefix ui run data     # 生成参照 + 型号地图（含上面那条自证）
npm --prefix ui run dev      # vite + workerd
npm --prefix ui test         # 34 项：代理守卫 / URL 规范化 / 瘦身无损 / 色带 / headline 优先级 /
                             #        尺度模型 / 屏幕上的倍数必须能被屏幕上的两个数除出来
npm --prefix ui run deploy   # build + wrangler deploy

# 🔴 花额度前先用假中转端到端跑通（[[dry-run-before-spending]] 的常备工具）
node ui/scripts/stub-relay.js --serves 'gpt-5.6-sol=gpt-5.6-luna' --port 8791 --oneapi
node ui/scripts/stub-relay.js --serves gpt-5.6-luna        # 两个模型名都换 → D 塌陷
```

**stub 复现了两个真实场景，都验证通过**：① 只换 subject → S/D 点估计 0.72 越线但下界 0.57
没越，判「证据不足」（对称性规则生效，旧逻辑会冤枉）；② subject 与 control 都换 → `D_c = 0.0000`，
D 塌陷守卫在 consistent 分支**之前**拦下本会通过的 S/H 区间 [0.59, 0.94]。
两次指认层都独立报出 `gpt-5.6-luna`（分离度 9.2× / 8.3×）。

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

### 型号地图：官方 10 个可采型号两两可分（2026-08-17）

官方 API 共 126 个模型，去掉生图/语音/嵌入等 44 个，LLM 82 个（含 30 个日期快照别名），
**去重后 52 个**。实测「能不能采」而非按名字猜（硬约束要求），结果：

| 结果 | 数量 | 原因 |
|---|---|---|
| ✅ **可采** | **10** | 接受 `reasoning:{effort:'none'}`，全是现代型号 |
| ❌ `effort` 参数整个不支持 | ~20 | 非推理模型（gpt-4o / 4-turbo / 3.5-*）。**去掉 `reasoning` 就能采**，需第三种探针变体 |
| ❌ 支持 `effort` 但不收 `none` | ~16 | gpt-5 / o1 / o3 / o4-mini / 所有 `-pro`。最低档也会把 16 token 烧在隐藏推理上，**结构上不可能** |
| ❌ 404 | ~6 | `/models` 列了但 Responses 不服务，幽灵条目 |

`gpt-5-pro` 只接受 `effort:'high'`——永远采不了。

**10 个全部采齐**（40 格 × 30 次，`reference/responses/`），两两距离见 `model-matrix.js`：

**最近的一对是 `gpt-5.3-codex ↔ gpt-5.4` = 0.1427**，而它们的噪声地板是 0.031 / 0.027
——仍是地板的 **4.6 倍**。**45 对无一落入噪声地板 → 本方法能区分官方全部现代型号。**

各模型地板差异很大（terra 0.019、5.4 0.027、sol 0.046、nano 0.059），**不能共用一个阈值**，
所以 `classifyPair` 取两者中较大的。

⚠️ **指认的判据是「与次近的分离度」，不是绝对距离**。绝对距离含外壳而指认层没有对照可减
——自建网关离它**真正在发**的模型也有 0.154。第一版按噪声地板判，把 12 行实采**全部**标成
「都不像」，其中 4 个是 L2 已证明的正版。改用比值后 10/12 正确命名，剩 2 行标「不确定」，
而那 2 行恰好都是 `gpt-5.4 vs gpt-5.3-codex`——地图上最难分的一对。**工具在最难处说不确定，
是对的行为。**

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

### 🔴🔴🔴 两家中转的分布收敛到同一个非官方上游

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

- **relay-B**：本方法在这批测量上判定**两个模型名发的是同一个东西**（互相 0.079 < 地板），
  而官方把这两个模型拉开 0.384——**同一个东西不可能同时是两个相距 0.384 的模型**，所以在
  本方法的口径下至少一个名字与其所售型号不符；实测两个都不匹配（离官方 sol 0.233、
  离官方 5.4 0.265–0.329）。这是**单个采集时期**的测量结果。
- **relay-A**：跨时间不一致。多数时候是真 sol（0.036，测不出区别），08:14 那一小时的分布
  落在 B 上（离 relay-B 常态 0.058 < 地板）。**不是降级到 5.4**（离官方 5.4 有 0.414），
  是第三个东西。⚠️ 单次 L2 等于抽一次签，这条结论靠的是两次跑之间的差异，不是任一次的绝对值。

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

- **2026-08-17 夜** 判定层加固 + 429 治理 + 统计校正大修。**主项目 241 项 + `ui/` 34 项全绿，
  57 个变异全杀，16 轮 Codex review 共 62 个 BLOCKER，最终 APPROVED。**
  存量记录全程不变：4 次已确认掺假全部定罪并指名，5 次已确认正版零冤枉。

  🔴 **最有价值的一条是我自己不会发现的统计学错误**：D 的采样偏差我拿「同模型 split-half
  噪声地板」当代理，而 **D 是跨模型比较**。同模型地板问的是「同一分布抽两次能差多远」，
  真值为 0，整个量都是偏差；跨模型距离真值很大，上面只叠一点点偏差。实测
  P={a:1} vs Q={a:25/30,b:5/30}、30 样本：真值 0.0888，真实偏差 0.00098，我用的代理 0.0134
  ——**多扣 13.7 倍**。而且方向不安全：D 是分母，多扣 = 分母变小 = S/D 变大 = 更容易定罪。
  「取两个地板里较大的」这条推理在 `comparisonFloor` 里保守，**在这里正好相反**。
  修法是 `pairBias()`（见「三个地板」一节），它在两边同池时逐位退化成噪声地板。

  🔴 **同一个缺陷在四个地方各犯一次，我每次都以为修完了**：
  「全组标量 vs 逐格/逐抽样」——`rankingBootstrap` 的地板（第 5 轮修）、`ratioCI` 的
  `correctBy`/`correctDen`（第 13 轮）、`ratioCI` 的 `denomFloor`（第 14 轮，我还专门为
  「它是分辨极限不是偏差」辩护过一轮）、以及矩阵的对角线 vs `pairFloors`（第 9 轮）。
  **「这个量是不是格子的属性」是唯一该问的问题**，分辨极限也是。

  其余按类归：**闸放错层**（有效率闸只在 `evaluateL2`，而 headline/报告/CLI 各自重跑指认）、
  **口径不随数据走**（参照侧没有逐格样本下限、地板按计划 reps 而非实际 n、按 `min(两侧)`
  而非各自计数）、**算不出被当成 0**（`noiseFloor({})` 返回 0 + `ratioCI` 缺键补 0 =
  「这次比较完全没有噪声」）、**有限次抽样下不对称**（`pairBias` 同一对模型换个方向差 2.3 倍）。

  ⚠️ **我在这轮里犯过、并被记下来的三个错**：说 `importRuns` 没有调用方（`grep -r` 静默跳过了
  含 NUL 字节的 `history.js`，而 git diffstat 里 `Bin 6678 -> 7805` 我看到了却没追问）；
  说单地板问题「只是保留了旧问题」（实际让 D 变得更错）；为了让一个变异体语法成立而往生产代码
  里加死代码（`numMean`/`denMean`）。

  🔴 **第五轮暴露的核心问题，一句话：闸放错了地方。** 有效率那道闸原本在 `evaluateL2` 里，
  它只挡住了那一个函数的 verdict——而 `headline()` 先读 `impostor` 再读 verdict，报告页和 CLI
  又各自拿存量样本**重跑**一遍 `identification()`。一次 57% 有效率、被压成 inconclusive 的跑，
  **在所有人真正会看的地方照样是红色指名指控**。现在五道闸全在 `identification()` 里，
  `validRate` 必传。

  另外三条是同一类「口径没跟着数据走」：**噪声地板按计划的 15 次算而不是每格实际拿到的次数**
  （丢了探针的格子散布更宽，低估地板 = 抬高每个比值，方向倾向定罪，而被薅掉样本的正是那些格子）；
  **每个型号的地板存成标量**，可 bootstrap 重抽的是格子，分子按抽到的格子平均、分母按全部格子
  平均；**`attempts` 在发请求之前就加**。

  🔴 **又一次「按 review 改反了方向」**：修完逐格地板后我断言 `separation_lo` 应该变大，
  实测是**变小**——5% 尾巴由「噪声格抽了好几次」的抽样构成，它们真实的分辨极限是那格的 ~0.5,
  不是全局平均 ~0.04。标量恰好在**信息最少**的那些抽样上给出虚高的信心。断言按实际机制改了。

  🔴 **这轮最值得记的不是修了什么，是「全绿的测试可以什么都没钉住」**。第四轮 Codex 的九条里，
  有三条针对的代码**当时正被一条通过的测试覆盖着**：
  ① 取消测试直接调 `request(..., {cancelled})`，而断掉的正是它和真实客户端之间那截接线；
  ② 「共享停车」测试是**顺序**调两次且 `Retry-After: 0`，没有第二个 caller 可被停住；
  ③ 「窗口在清净后重置」测试注释里明写「这里还没跨过恢复窗口」——把重置逻辑整个删掉它照样过。
  按它的要求重写之后，**第三条当场挖出一个真 bug**：恢复只在「后续有一次成功」时判定，
  跑安静一段再回来，窗口还是旧的、预算已花光。

  另外两条是我自己的说法站不住：
  - **`rank_stability` 曾经名不副实**——先在全量数据上固定前两名再只对这一对重抽，测的是
    「这一对的差距稳不稳」而不是「排名稳不稳」。改成每次重抽对**全部**候选重排。
  - **`impostorReason` 声称 `separation_lo` 必须过 1**，而没有任何分支检查它；一次
    `separation_lo = 0` 的定罪照样发出，解释它的句子还写着这不可能。

  以及两个**顺序/口径**类的老熟人：并列在 bootstrap 里按数组顺序判胜（→ 判决取决于文件加载
  顺序，反例给出稳定度 1.000 vs 0.638）、veto 拿两个不同格子集上的均值相比。

  🔴 **一次「按 review 意见改，结果改坏了」，靠跑存量数据才发现**：Codex 指出 floor 只由全量
  前两名标定而 bootstrap 会重排全部候选，我第一反应是把 floor 改成**全库取最大**——语义上
  确实覆盖了，但那让库里最抖的那份参照（`gpt-5.4-nano`）去决定 sol 和 luna 分不分得开，
  一次已确认的掺假从 3.6× 被压到 2.2×。正确解法是 `modelFloors()` 一次算好每个型号自己的地板，
  **每个用处取那一对的最大值**。[[reapply-the-core-principle]]：审阅意见指出的「不一致」是真的，
  但消除不一致有好几种改法，**挑哪种得拿数据量**。

  用户口径的两条：**厂商很少静默换权重**，所以参照过期保留定罪 + 告警（但年龄要取**参与排名的
  所有参照里最旧的**，且有一份没日期就报「不详」而不是「其余里最旧的」）；
  **「区间」太难懂**，报告改成落到型号地图上的位置。

  🔴 **顺带自己在浏览器里逮到一条**：headline 写「离它 0.0460，离第二近的 0.3918——远 3.2 倍」，
  读者一除是 8.5。3.2 的分母是噪声地板 0.1234，就印在下一行却没连起来。不是数字错，是
  **读者验不了**——跟「打印的 S/H 1.94、实际在判 20.8」同一类。现在凡是印倍数的地方都点名分母。

- **2026-08-17 傍晚** 指认层升格成判定路径。**主项目 194 项 + `ui/` 24 项全绿，两轮 Codex review。**

  存量 L2 全部重判：**4 次已确认掺假全部定罪并指名 luna，5 次已确认正版全部保持 ✅**，
  零冤枉。其中 08-14 那次 `relay-B` 的假绿灯（S/H 区间 [0.48, 1.00] 整段在线下）现在是
  `suspect`。

  **先试了直觉解法「把 S/D 的分母从最远型号换成最近邻」，用存量数据跑完发现不行**：
  4 次掺假只定罪 1 次，漏掉的一次下界 0.69、差 0.01。根因是结构性的——掺成最近邻时
  `S ≈ D`，比值落在 1.0 附近而区间宽 ±30%，且**加采样无效**（bootstrap 抽的是格子，
  活格已经全用上）。所以改成让指认层独立定罪，判据、门槛、失败数据见「定罪靠指认」一节。

  🔴 **写测试时挖出一个潜伏的判定 bug**：`identify()` 拿 `Number.isFinite(sep)` 当闸，
  而距离为 0 时 `sep = Infinity` —— **完美匹配永远不能命名**。2.1× 能过、∞ 不能过。
  真实测量不会恰好为 0，所以它一直没发作；合成测试第一下就撞上了。
  与 [[guards-that-cannot-fail]] 同源，但方向相反：不是闸永不触发，是**闸恰好挡住了最强的证据**。

- **2026-08-17 下午** 网页版删掉「对照模型」这个用户选项，headline 改由指认层来说。
  主项目 172 项 + `ui/` 24 项全绿。

  **起因是两次真实测量都报「证据不足」**，其中一次是已经确认掺假的 relay-B。查下来两件事：

  ① **不是没测出来**——D 塌陷守卫正常触发了，指认层也早已以 3.55× 分离度认出 luna
  （它的 `gpt-5.6-sol` 和作为对照的 `gpt-5.6-terra` **两个名字都发 luna**，20 个共有格里
  18 格众数相同，熵没塌）。**问题在于页面用平静的蓝色 headline 写着「证据不足」**，
  而那个把结论翻译成指控的红框，恰好被 `collapsedScaleNote(r) ?? namedElsewhereNote(...)`
  的 `??` 吞掉了。两句都是真的，先说弱的那句就是误导。

  ② **对照模型这个设计在 responses 线上已经不划算了**。它是给 chat 线做的（那时参照是
  自建网关，H 是地板的 8.25 倍）；换成官方参照后，**八次可信测量里六次外壳低于噪声地板**，
  第七次 1.08 倍。它却花掉一半探针，而且它的承重假设「对照在两端都是正版」正是待查的事。
  更要命的是**选哪个对照会翻判决**——一个没人答得对的下拉框在决定一家中转有没有被定罪。

  所以：网页版默认 `sampleControl: false`、界面上删掉下拉框和开关（L2 从 840 次 7 分钟
  降到 ~420 次 3 分钟），headline 走 `headline()`——它**不算任何数**，只在 verdict 和
  指认之间排先后。存量结果全部重判验证过：**没有正版端点掉出绿灯**，而 08-14 那个假绿灯
  翻成了 inconclusive（那个失效模式需要一个被顶高的 H，不采对照时 H 按构造为 0）。

  🔴 **顺带暴露一个还没修的判定层缺陷**：`S/D` 的分母取最远的型号，而掺假掺最近邻。
  10 份参照测算下来 **8 个型号的「换成最近邻」在零外壳、无限探针下都够不到 0.7 定罪线**。
  relay-B 就卡在这里：同一批样本，luna 当对照定罪 [0.813, 1.017]，terra 当对照只到
  [0.468, 0.842]。这次靠 headline 绕过去了，但 `S/D` 该改成对最近邻取尺度。
  又一次 [[reapply-the-core-principle]]——「用比值不用绝对值」做对了，
  「比值的分母该取哪一端」没想。

  另外两条：`MIN_ID_CELLS = 12`（同一端点在 3 / 6 / 29 格上被指认成三个不同型号，
  所以 L1 永远不指名）；判定词汇必须**只有一套**——`history.js` 的行也改走 `headlinePill()`，
  否则时间线写「证据不足」、点开的报告写「实际发的是 luna」，等于把要修的困惑挪到隔壁页。

  ⚠️ **两份实测里还有一个测量完整性问题没修**：420 次对照探针里 102 / 137 次是 HTTP 429，
  **subject 侧 0 次**（subject 先跑完把每分钟配额烧掉）。活格从 28 塌到 16 / 20，
  而且被打掉的 12 格平均 S 是 0.140、活下来的 16 格是 0.211——**429 把 S 系统性抬高了 17%**。
  `transport.js` 重试 3 次退避 1.5s→3s，对「每分钟配额」这个量级结构上就不够。

- **2026-08-17** 里程碑 2 上线：**https://llmfingerprint.z0y0h.work**（公开、免费版 Cloudflare、$0/月）。
  主项目 172 项 + `ui/` 16 项全绿。

  **架构与 plan 里设想的不同，而且是更好的**：plan 写的是 `node:http` + SQLite + VPS + Tunnel + Access。
  实际做成**计算全在浏览器、Worker 只做路径改写代理**。三个理由，按重要性：
  ① **key 不落任何盘**——L2 要 870 次请求跑 7 分钟，放服务端后台任务（DO）就必须把 key 写进
  DO storage 才能跨批次存活，那是真落盘；浏览器跑，服务端结构上没有能存 key 的地方。
  ② 免费版 Workers 每请求只给 10ms CPU，跑不动 bootstrap，但纯转发绰绰有余。
  ③ `src/` 是零依赖纯 ESM，Vite 直接打包，**判定逻辑只有一份**。
  代价是关标签页任务就断，用 IndexedDB 存中间样本 + 离开拦截缓解，**没有做格子级断点续跑**
  （要做干净必须让 `runBattery` 认识已采样本，否则就得在 `ui/` 重写一遍 `calibrateL2` 的编排）。

  🔴 **本轮最贵的一个 bug 是 40 行 DOM helper 里的参数分派**：`h(spec, props, ...children)` 无条件把
  第二个参数当 props，于是 `h('div', someNode)` 和 `h('span', '文字')` 的那个参数**被静默丢弃**——
  `Object.entries()` 遍历 DOM 节点是空的，不报错。首屏因此丢了整个 header 和整个 hero，
  控制台一片干净。与 [[silent-comparison-mismatch]] 同源：**不报错、只是让东西悄悄消失**。
  修法是只把「原型为 `Object.prototype` 的纯对象」当 props，并补了 `ui/test/smoke.test.js`。

  **stub 中转（`ui/scripts/stub-relay.js`）值得单独记一笔**——它让整个 run 流程可以零成本端到端跑，
  并复现了存档里两个真实场景：只换 subject 时判「证据不足」（S/D 点估计 0.72 越线、下界 0.57 没越，
  对称性规则生效），两个名字都换时 `D_c = 0.0000` 触发 D 塌陷守卫拦下本会通过的 S/H 区间。
  这是 [[dry-run-before-spending]] 从「记得先跑一遍」升级成「仓库里有个现成的假中转」。

  其它几条：**参照瘦身 2.3MB → 157KB 且可证明无损**（构建脚本对每个有序对重跑六条判定路径逐位比对，
  不等就退出码 1）；热力图**编码分离度而非绝对距离**，色带边界按真实数据重排过一次
  （原来 6 档里 3 档永远空着，整张图一个颜色）；`inconclusive` 用**蓝色不用琥珀**——
  琥珀读作「出问题了」，而这个工具的立场是「证据不足是正当结论」，配色验证器随后也确认蓝色
  才让三色在两种主题下都 CVD-safe。

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
