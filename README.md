# llm-fingerprint

判别第三方中转 API 给的模型是不是它声称的那个——用单 token 输出分布指纹，
复现自 [arXiv:2607.10252](https://arxiv.org/abs/2607.10252)。

私人自用工具。完整设计、方法、实测结论、runbook 全在 **[CLAUDE.md](./CLAUDE.md)**。

> 🚧 **正在按 [docs/plans/2026-08-11-relay-picker-plan.md](./docs/plans/2026-08-11-relay-picker-plan.md)
> 重构**：从「验一个已购中转」改成「选型时横评多家、选定后长期监控」。
> 下面标 🚧 的命令属于尚未交付的阶段，标 ✅ 的现在就能跑。

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
# 三档协议，成本逐层放大，只有前一层报警才进下一层
node scripts/profile.js      --endpoint <id>          # 🚧 阶段 4 · L0 端点画像（~26 次）
node scripts/screen.js       --endpoint <id>          # 🚧 阶段 5 · L1 快筛（15 次）
node scripts/verify-relay.js --endpoint <id>          # 🚧 阶段 6 · L2 精确校准（180 次）
node scripts/quick-check.js  --endpoint <id>          # 🚧 阶段 7 · reasoning 降档巡检
npm run compare -- --tier screen                      # 🚧 阶段 8 · 横评全部端点
```

## 能查 / 不能查

| 能查 | 靠哪层 |
|---|---|
| 换成同厂别的模型（5.5 冒充 sol） | L2 校准指纹（H/S/D 对照校准法） |
| 偷偷降 reasoning 档 | reasoning 巡检（生成式题库 + 精确求解器） |
| 谎称"官方 API 直连" | L0 端点画像 |
| 跑熟后偷偷降配 | 定期重跑 L1 + 巡检 |

**不能**：
- 证明是厂商原始权重（需密码学签名，业界尚无）
- 挡住知道我们查什么的对手
- **检出低比例掺假**——中转只把 ≤20% 请求路由到替换模型时，本方法功效塌到显著性水平
  （arXiv:2504.04715 / arXiv:2607.20860 两篇独立印证）。不假装能覆盖。

许可：MIT（见 [LICENSE](./LICENSE)）。复用的上游代码与数据署名见
[vendor/pamela/ATTRIBUTION.md](./vendor/pamela/ATTRIBUTION.md)。
