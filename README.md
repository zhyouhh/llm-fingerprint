# llm-fingerprint

判别第三方中转 API 给的模型是不是它声称的那个——用单 token 输出分布指纹，
复现自 [arXiv:2607.10252](https://arxiv.org/abs/2607.10252)。

私人自用工具。完整设计、方法、实测结论、runbook 全在 **[CLAUDE.md](./CLAUDE.md)**。

> **状态（2026-08-14）**：按 [实施 plan](./docs/plans/2026-08-11-relay-picker-plan.md) 完成阶段 0-6、8，
> 162 项测试全绿。**唯一没做的是 reasoning 降档巡检**——下面标 🚧 的就是它。

## 一句话原理

不同网关外壳不同，跨端点直接比指纹会把「外壳不同」和「模型不同」混在一起。
解法是拿一个双方都有、已知正版的**对照模型**测出纯外壳差异，再判待验模型——
详见 CLAUDE.md「对照校准法」。

## 快速开始

```bash
npm run fetch-data       # ✅ 拉论文数据集（首次，~52MB 下载 / ~500MB 解压）
npm run verify-data      # ✅ 只校验数据完整性，不下载；缺什么列什么
npm test                 # ✅ 全部测试，含复现论文 AUC 0.971342 的 golden test
npm run test:golden      # ✅ 只跑 golden test（pass 13）
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
npm run compare                                # ✅ 横评表（读已有结果，0 请求）
node scripts/rejudge.js                        # ✅ 按当前口径重判存量结果（0 请求）
node scripts/quick-check.js  --endpoint <id>   # 🚧 reasoning 降档巡检（未实现）
```

**采参照**（只能在已知正版端点上跑，一次性投入）：

```bash
node scripts/refresh-reference.js --endpoint <正版 id> --model <m> --cells full \
  --fp-protocol responses    # 40 格；L2 的精度主要来自格子数，不是采样数
```

⚠️ **指纹层有两条协议，参照与待测必须一致**（代码会拦）。默认 `chat`（论文口径）；
要拿 **OpenAI 官方 API** 当参照就得加 `--fp-protocol responses`——官方不接受 chat 口径
依赖的那个 OpenRouter 扩展参数。理由见 CLAUDE.md。

## 能查 / 不能查

| 能查 | 靠哪层 |
|---|---|
| 换成同厂别的模型（5.5 冒充 sol） | L2 校准指纹（H/S/D 对照校准法） |
| 区分「外壳不同」与「模型不同」 | **只有 L2 能**——L1 的距离里混着外壳，实测两次误判都源于此 |
| 偷偷降 reasoning 档 | reasoning 巡检 🚧 **未实现**——指纹层原理上看不见 effort |
| 谎称"官方 API 直连" | L0 端点画像 |
| 跑熟后偷偷降配 | 定期重跑 L1 + 巡检 |

**不能**：
- 证明是厂商原始权重（需密码学签名，业界尚无）
- 挡住知道我们查什么的对手
- **在「参照端点与待测端点外壳相似」时给高置信结论**——H 是判据的分母，H 小则区间宽
  （实测：外壳差异大的端点区间 [0.29, 0.85]，相似的宽到 [0.16, 3.95]）
- **检出低比例掺假**——中转只把 ≤20% 请求路由到替换模型时，本方法功效塌到显著性水平
  （arXiv:2504.04715 / arXiv:2607.20860 两篇独立印证）。不假装能覆盖。

许可：MIT（见 [LICENSE](./LICENSE)）。复用的上游代码与数据署名见
[vendor/pamela/ATTRIBUTION.md](./vendor/pamela/ATTRIBUTION.md)。
