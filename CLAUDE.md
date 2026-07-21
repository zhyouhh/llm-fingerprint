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

## 三种工作模式

| 模式 | 说明 | 要可信基线 |
|---|---|---|
| **漂移监控**（主线） | 给端点建基线，之后定期复检；漂出 genuine 区间 = 供应商动过手脚 | 否 |
| **交叉比对** | 多家中转号称同一模型，两两比；离群者可疑 | 否 |
| **论文库比对** | 跟 176 个已知指纹比，报"最像谁" | 否，但库会随模型更新过期 |

参考库是 **2026-07-06 快照**，越久越不准。自建基线是主线，论文库是可选参照。

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
npm run build-refdb      # 从论文数据集抽出 176×40 参考指纹 → refdb/fingerprints.json

npx llmfp check --endpoint <url> --model <name> [--quick|--full]
npx llmfp enroll --endpoint <url> --model <name>    # 建自己的基线
npx llmfp ui                                        # 本地 web 界面
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

## 开发日志

（按时间倒序，新的在上）

- **2026-07-21** 项目建立。方法调研完成，上游数据集+代码已分析。设计定案：自建基线为主线、
  论文库为可选参照、守门用实测而非名单。下一步 G0-G2。
