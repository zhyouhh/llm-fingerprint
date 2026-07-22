# llm-fingerprint

判别第三方中转 API 给的模型是不是它声称的那个——用单 token 输出分布指纹，
复现自 [arXiv:2607.10252](https://arxiv.org/abs/2607.10252)。

私人自用工具。完整设计、方法、实测结论、runbook 全在 **[CLAUDE.md](./CLAUDE.md)**。

## 一句话原理

不同网关外壳不同，跨端点直接比指纹会把「外壳不同」和「模型不同」混在一起。
解法是拿一个双方都有、已知正版的**对照模型**测出纯外壳差异，再判待验模型——
详见 CLAUDE.md「对照校准法」。

## 快速开始

```bash
npm run fetch-data      # 拉论文数据集（首次，~52MB）
npm test                # 26 tests，含复现论文 AUC 0.971342 的 golden test

# 验一个新中转（按顺序，见 CLAUDE.md「Runbook」）
node scripts/probe-endpoint.js --endpoint <url> --key <k> --model gpt-5.5   # 画像+排名
node scripts/quick-check.js    --endpoint <url> --key <k>                   # reasoning 降档
node scripts/verify-relay.js   --endpoint <url> --key <k>                   # 模型身份（最硬）
```

## 能查 / 不能查

| 能查 | 靠哪层 |
|---|---|
| 换成同厂别的模型（5.5 冒充 sol） | 第 2 层校准指纹 |
| 偷偷降 reasoning 档 | 第 1 层推理题（生成式+精确求解器） |
| 谎称"官方 API 直连" | 第 0 层画像 |
| 跑熟后偷偷降配 | 第 3 层漂移监控 |

**不能**：证明是厂商原始权重（需密码学签名，业界尚无）；挡不住知道我们查什么的对手。

许可：MIT。复用的上游代码与数据署名见 [vendor/pamela/ATTRIBUTION.md](./vendor/pamela/ATTRIBUTION.md)。
