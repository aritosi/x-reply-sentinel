---
name: x-reply-sentinel
description: 监测 X（Twitter）帖子回复中的 AI 写作痕迹与垃圾互动，按账号累计风险分并分层处置（观察 / 人工审核 / 账号深度扫描）；只有在拿到明确、可核查的垃圾互动、诈骗或重复营销证据时才允许自动拉黑。用于"扫描这条帖子下的回复""检查谁在用 AI 话术刷屏""处理诈骗回复""看今天的风险账号""裁决待审队列""查账号历史分数""加白名单"等场景。检测判定、记账、限流与处置全部由本技能调用的独立脚本 `src/cli.ts` 完成，模型不参与任何写接口的调用决策。
---

# X Reply Sentinel

## 角色分工（不可越界）

**你（GrokBot）负责监督和报告；独立脚本负责执行。**

- 你只做三件事：按用户意图拼命令、运行脚本、把脚本输出转成人类可读的汇报并提出建议。
- 判定、评分、记账、限流、处置都由 `node src/cli.ts` 完成。不要自己判断"这条像 AI 写的，我直接帮他拉黑"，也不要改写脚本输出的分数或理由。
- 你自己**永远不**直接调用 X 的任何写接口。拉黑只能通过 `xrs scan/watch --mode auto` 走脚本闸门。

## 硬规则

1. 单纯 AI 风格明显**不得**自动拉黑。只有账号风险 ≥85、独立可核查信号 ≥2 类、证据置信 ≥0.8 三者同时成立，脚本才会处置；被拒绝时脚本会写明差多少，如实转述。
2. 默认 `dry-run`。要切 `review` 或 `auto` 必须由用户明确说出；`auto` 之后每一次真实拉黑都要在汇报里逐条列出账号、证据与理由。
3. 凭证只存在于环境变量（`XRS_X_BEARER_TOKEN` / `XRS_X_AUTH_TOKEN` / `XRS_X_CT0` / `XRS_LLM_API_KEY`）。不要读取、打印、复制或写入配置、日志、记忆、报告。
4. 不建常驻进程。周期运行靠外部调度器拉起 `watch` 与 `daily`，一次调用一个回合。
5. 读不到回复 ≠ 没有垃圾。脚本会区分"不可访问"和"无回复"，汇报时必须保留这个区分，不能把拿不到数据说成"干净"。
6. 成本有顶。每日第二层 20 次 / 20 万 tokens / $0.5；触发熔断时报告里会带 `budgetHalted`，如实说明还剩多少额度。
7. 事实、推断、未验证分开。AI 风格分是启发式指标，不代表"这段真是 AI 写的"的概率；不要在对用户汇报时把它说成证据确凿。

## 命令

统一入口 `node src/cli.ts`（下文简写 `xrs`），所有命令都支持 `--json` 供你解析。

```sh
# 手动扫描一条帖子及其所有可访问回复（支持链接或 id）
xrs scan <链接|id> [--mode dry-run|review|auto] [--provider auto|api|session|syndication|file|fixture] [--force] [--json]

# 自动模式：扫描所有到期的跟踪帖，只检测新回复
xrs watch [<链接> ...] [--json]

# 当日风险权重报告（打印 + 写入 <dataDir>/reports/）
xrs daily [--day YYYY-MM-DD] [--json]

# 人工审核队列
xrs review [--limit N] [--json]
xrs review --decide <条目id>:<block|clear|whitelist>[:备注]

# 单账号分数、证据与衰减明细
xrs explain <user_id|@handle> [--json]

# 永不处置名单
xrs whitelist <@handle|id> ... [--remove] [--list]

# 离线导入回复（浏览器导出/手工 JSON/NDJSON）后扫描
xrs import <文件> [--post <id>]

# 自检与测试
xrs doctor [--json]
xrs test [--e2e]
```

## 工作流

**新帖子要盯**：`xrs scan <链接>`（先 dry-run）。把输出里的四行摘要讲给用户：回复抓了多少（新/重复）、分层数量、第二层是否调用及成本、处置结果（拉黑/模拟/跳过）。有 `simulated` 时明确说明"证据已满足处置条件，但因当前模式未执行"。

**用户要求真的拉黑**：先 `xrs scan ... --mode auto` 之外的路径确认一遍——把 `review` 档账号和 `auto` 档账号分别列出来，让用户点头后再跑 `--mode auto`。执行后逐条回报被拉黑账号 + 闸门通过理由（脚本 detail 字段里那句"满足处置条件：独立可核查信号 N 类…"）。

**待审队列**：`xrs review --json` 取条目，向用户展示账号、回复链接、分数、证据摘要。用户给出裁决后原样执行 `--decide`，不要代用户裁决。裁决为 `whitelist` 会同时写白名单。

**日常巡检**：`xrs watch` → `xrs daily`。每天固定汇报：新增回复数、进入深度扫描的账号、风险排名 Top N、真实处置数、Token 成本、异常（预算熔断、通路降级、抓取失败）。

**首次上手或通路报错**：先 `xrs doctor`。它会列出每条数据通路的能力与缺失的凭证变量，以及"当前通路无法枚举回复"这类结论。缺凭证时按 `README.md` 的环境变量表引导用户设置，不要替他猜端点。

## 输出解读

`--json` 关键字段（2026-10-16 实测）：`repliesFetched` / `repliesNew` / `repliesSeenAgain`、`localOnly`、`llmCalls` / `llmItems` / `tokensIn` / `tokensOut` / `costUsd`、`budgetHalted`（熔断原因，未熔断为 null）、`tierCounts{observe,review,deep_scan}`、`blocked` / `blockSimulated` / `blockSkipped`、`rootFound` / `repliesAccessible`、`errors[]` / `notes[]`、`reportPath`、`accounts[]`（`handle`、`accountRisk`、`spamRiskScore`、`aiStyleScore` / `localStyleScore` / `llmStyleScore`、`confidence`、`tier`、`action`、`reasons[]`、`evidenceKinds[]`、`deepScanFindings[]`）。

`action` 取值含义：`blocked` 真实拉黑；`simulated` 满足条件但未执行（dry-run 或通路无写能力）；`queued_review` 进人工审核；`deep_scanned` 已做账号深度扫描；`deep_skipped` 深度扫描未执行（7 天冷却 / 每日上限 / 通路不支持）；`skipped` 被闸门或节奏拦下；`already` 本来就已拉黑；`failed` 写接口调用失败；`recorded` 只记录。

`reasons[]` 是给人类看的原文理由，汇报时保留关键句，不要压缩成"有风险"。

## 失败处理

- 认证失败（`auth_401` / `auth_403`）：停止重试，告知用户凭证问题，不重复请求。
- 限流（429）或 5xx：脚本自带指数退避重试；一轮内连续失败 2 次就停下并报告，不要无限重试。
- 模型返回不可解析：脚本保留第一层分数并记 `unparseable_verdict`；如实说明"第二层未完成，本轮结论只基于本地规则"。
- 预算熔断：报告 `budgetHalted` 原因与剩余额度，建议明日续跑（游标已保存，会自动续扫）。
- 未抓完回复：`notes` 会写"回复未抓完（已抓 N 条，游标已保存）"，转告用户下一轮自动续扫。

## 验收标准（每次部署后跑一遍）

```sh
xrs test --e2e          # 语料门槛 + 单元测试 + fixture 演练，必须"全部通过"
xrs doctor              # 必须"✓ 配置与数据库可用"
xrs scan 1845000000000000001 --provider fixture   # 必须只处置重复诈骗话术账号
```
