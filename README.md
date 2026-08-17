# llm-fingerprint

判别第三方中转 API 给的模型是不是它声称的那个——用单 token 输出分布指纹，
复现自 [arXiv:2607.10252](https://arxiv.org/abs/2607.10252)。

**网页版：https://llmfingerprint.z0y0h.work** —— 输入中转 URL 和你自己的 key 就能测，
计算全在浏览器里跑（服务端只做一层无状态转发，结构上没有能存 key 的地方）。
不输入任何东西也能看[型号地图](https://llmfingerprint.z0y0h.work/map)：官方 10 个型号两两能不能分开。

命令行版是同一份判定代码。完整设计、方法、实测结论、runbook 全在 **[CLAUDE.md](./CLAUDE.md)**。

> **状态（2026-08-18）**：CLI 按 [实施 plan](./docs/plans/2026-08-11-relay-picker-plan.md) 完成阶段 0-6、8
> （唯一遗留：plan 要求删除的 `scripts/compare-baselines.js` / `calibrated-compare.js` 还在仓库里）；
> 网页版已上线（见 [`ui/CLAUDE.md`](./ui/CLAUDE.md)）。主项目 241 项 + `ui/` 34 项测试全绿。
> **唯一没做的是 reasoning 降档巡检**——下面标 🚧 的就是它。

## 它抓到过什么（2026-08-14 实测六家中转）

| 端点 | 卖的 `gpt-5.6-sol` 实为 | 卖的 `gpt-5.4` 实为 |
|---|---|---|
| relay-C / relay-D / relay-E / 自建网关 | ✅ 真 sol | ✅ 真 5.4 |
| **relay-A** | 🟠 **时真时假**——同一天相隔一小时，一次真货一次 luna | ✅ 真 5.4 |
| **relay-B** | 🔴 **`gpt-5.6-luna`** | 🔴 **也是 `gpt-5.6-luna`** |

掺的是 `gpt-5.6-luna`——sol 的**同代兄弟型号**，更便宜、行为接近但不同。判据不是"看起来不太对"，
而是：relay-B 的「sol」到官方 luna 参照的 JSD 是 **0.0237**，低于噪声地板 0.0833（= 测不出区别），
而真 sol↔真 luna 是 0.1815。**近 8 倍，没有解释空间。**

最硬的一条证据是**两家毫无关系的中转在同样的格子上换成同样的答案**
（`47→73`、`turquoise→teal`、`زرافة→فيل`）——外壳、采样参数、订阅/API 差异都解释不了它。

## 一句话原理

一个模型在固定问题上的答案分布是稳定的，且各不相同——所以把待测端点的分布，
拿去跟**十份自采的官方参照**逐一比距离，最像谁就是谁。

判据不是「离得近」而是**离最近的比离第二近的近多少倍**：绝对距离里混着网关自己的外壳
（一个自建网关离它真正在发的模型都有 0.154），比值把外壳削弱掉。
要指名道姓得同时满足五条——2 倍分离度、重抽格子时 95% 的次数仍排第一、至少 12 个格子、
有效补全率够、没有覆盖不足的候选更近。**任何一条不满足就说「不确定」，不猜。**

⚠️ 早期版本靠「对照校准法」（H/S/D）定罪，那条路**结构上抓不到最常见的掺假**：
掺成最近邻时 S≈D，比值天然落在 1.0 附近。实测 4 次已确认掺假它一次都没抓到，指认层 4 次全中。
H/S/D 保留下来管参照库以外的东西，细节见 CLAUDE.md。

## 快速开始

```bash
npm run fetch-data       # ✅ 拉论文数据集（首次，~52MB 下载 / ~500MB 解压）
npm run verify-data      # ✅ 只校验数据完整性，不下载；缺什么列什么
npm test                 # ✅ 全部测试，含复现论文 AUC 0.971342 的 golden test
npm run test:golden      # ✅ 只跑 golden test（pass 13）
```

**网页版**（同一份判定代码，跑在浏览器里）：

```bash
npm --prefix ui install
npm --prefix ui run data     # 参照 2.3MB → 157KB，并逐位自证瘦身无损
npm --prefix ui run dev      # 本地 vite + workerd
npm --prefix ui test         # 34 项：代理守卫 / 瘦身无损 / headline 优先级 / 尺度模型 / 分层可用性
npm --prefix ui run deploy   # → llmfingerprint.z0y0h.work

# 花额度前先拿假中转端到端跑通整条路
node ui/scripts/stub-relay.js --serves 'gpt-5.6-sol=gpt-5.6-luna' --port 8791
```

**端点怎么配**：候选端点写在 [`config/endpoints.json`](./config/endpoints.json)
（提交进 git，**不含 key**），每个端点用 `auth_env` 指名一个环境变量；
key 放 `.env`（已 gitignored）。示例见 `config/endpoints.example.json`。
此后所有 CLI 都是 `--endpoint <id>`，不再传 URL 和 key。

```bash
# 分层，成本逐层放大，只有前一层报警才进下一层
node scripts/profile.js      --endpoint <id>   # ✅ L0 端点画像（L0a 0 次 + L0b ~24 次）
node scripts/screen.js       --endpoint <id>   # ✅ L1 快筛（15 次）——日常就跑这个
node scripts/verify-relay.js --endpoint <id>   # ✅ L2 校准比对——L1 报警才上
#   探针数 = 活格 × 15 × (采对照?2:1)。29 活格：870，加 --no-control 则 435
#   --no-control 省一半，但外壳未测、且抓不到"两个模型名发同一个东西"。首测别用
npm run compare                                # ✅ 横评表（读已有结果，0 请求）
node scripts/rejudge.js                        # ✅ 按当前口径重判存量结果（0 请求）
node scripts/model-matrix.js                   # ✅ 型号地图：参照两两距离 + 各自噪声地板
node scripts/identify.js                       # ✅ 指认：这个端点发的到底是哪个型号
node scripts/quick-check.js  --endpoint <id>   # 🚧 reasoning 降档巡检（未实现）
```

**采参照**（只能在 config 里标了 `"genuine": true` 的端点上跑，一次性投入）：

```bash
node scripts/refresh-reference.js --endpoint <正版 id> --model <m> --cells full \
  --fp-protocol responses    # 40 格；L2 的精度主要来自格子数，不是采样数
```

已采齐 **OpenAI 官方 10 个可采型号**（`reference/responses/`，约 $1.4）。「可采」= 接受
`reasoning:{effort:'none'}`，实测而非按名字猜：官方 126 个模型里 52 个是 LLM，其中

- **10 个可采** —— 5.1 / 5.2 / 5.3-codex / 5.4 / 5.4-mini / 5.4-nano / 5.5 / 5.6-sol / 5.6-luna / 5.6-terra
- ~20 个**不支持 `effort` 参数**（gpt-4o / 3.5 等非推理款）——去掉该参数就能采，但那是第三种探针口径，暂未做
- ~16 个**不接受 `none`**（gpt-5 / o1 / o3 / 全部 `-pro`）——最低档也会把 16 token 烧在隐藏推理上，**结构上不可能**
- ~6 个 `/models` 列了但 Responses 返回 404

**这 10 个两两可分**：45 对里最近的一对（`gpt-5.3-codex ↔ gpt-5.4` = 0.143）仍是噪声地板的
4.6 倍。跑 `node scripts/model-matrix.js` 看完整地图。

⚠️ **指纹层有两条协议，参照与待测必须一致**（代码会拦）。默认 `chat`（论文口径）；
要拿 **OpenAI 官方 API** 当参照就得加 `--fp-protocol responses`——官方不接受 chat 口径
依赖的那个 OpenRouter 扩展参数。理由见 CLAUDE.md。

## 能查 / 不能查

| 能查 | 靠哪层 |
|---|---|
| 换成同厂别的模型（实测：luna 冒充 sol） | **指认层**——对全部参照排名，五道闸都过才敢命名 |
| **指认换成了哪一个**（不只是"不对"） | 同上；CLI 用 `identify.js` 看存量结果，0 请求 |
| 区分「外壳不同」与「模型不同」 | **只有 L2 能**——L1 的距离里混着外壳，实测两次误判都源于此。指认层用比值削弱它，不是消掉 |
| **粘性轮换**（某时段整段发假货） | 跨时间多次重跑 L1——**单次绿灯只代表那一次** |
| 偷偷降 reasoning 档 | reasoning 巡检 🚧 **未实现**——指纹层原理上看不见 effort |
| 谎称"官方 API 直连" | L0 端点画像 |

**不能**：
- 证明是厂商原始权重（需密码学签名，业界尚无）
- 挡住知道我们查什么的对手
- **在「参照端点与待测端点外壳相似」时给高置信结论**——H 是判据的分母，H 小则区间宽
  （实测：外壳差异大的端点区间 [0.29, 0.85]，相似的宽到 [0.16, 3.95]）
- **检出逐请求的低比例掺假**——中转只把 ≤20% 的**单个请求**路由到替换模型时，本方法功效塌到
  显著性水平（arXiv:2504.04715 / arXiv:2607.20860 两篇独立印证）。
  ⚠️ 这跟**粘性轮换**不是一回事：relay-A 是整段时间发同一个后端（一格 15 次全落同一边），
  那种抓得到，代价是**必须跨时间多测几次**——它单次跑是通过的
- **靠一次检测给端点发通行证**——见上；一次绿灯只说明**那一次**拿到的是真货
- **认出手上没有参照的型号**——`identify.js` 只认得出 `reference/` 里有的那些。分布不属于任何
  已采型号时它报「不确定」，**不会**把最近的那个说成答案
- **区分 `gpt-5.4` 与 `gpt-5.3-codex`**——地图上最难的一对（0.143）。实测两个正版端点的 5.4
  都只到 1.5× 分离度，工具照实报「不确定」

许可：MIT（见 [LICENSE](./LICENSE)）。复用的上游代码与数据署名见
[vendor/pamela/ATTRIBUTION.md](./vendor/pamela/ATTRIBUTION.md)。
