# X Reply Sentinel（xrs）

监测 X 帖子回复里的 AI 写作痕迹，给账号累计风险分，按分层处置；只有在拿到**明确、可核查**的垃圾互动证据时才允许自动拉黑。

需求总纲的一句话分工在本项目里是硬结构：**GrokBot 负责监督和报告，独立脚本负责执行。** `SKILL.md` 是给 GrokBot 读的调用与汇报规约；判定、记账、限流、处置全在这个 CLI 里，模型不参与写接口的调用决策。

## 快速开始（零 Token、零凭证）

```sh
git clone https://github.com/aritosi/x-reply-sentinel.git && cd x-reply-sentinel
node src/cli.ts test --e2e                 # 语料门槛 + 单元测试 + fixture 离线演练
node src/cli.ts doctor                     # 自检：通路能力、凭证是否设置、今日预算、数据量
node src/cli.ts scan 1845000000000000001 --provider fixture --data-dir /tmp/xrs-demo
node src/cli.ts daily --data-dir /tmp/xrs-demo
```

演练用的是 `fixtures/demo-thread.json`（1 条原帖 + 12 条回复：重复发诈骗话术的账号、单次投放垃圾链接的账号、只有 AI 文风的账号、正常人类账号）。这条链路不联网、不调模型、不触碰平台，输出形如：

```
处置：拉黑 0｜模拟 1｜拒绝/跳过 4
@huiyuan_666   3 条回复  账号风险 88.9   simulated   满足处置条件：独立可核查信号 3 类…
@amara_notes   1 条回复  AI 风格 97      deep_skipped  仅有 AI 风格证据，不构成可核查的垃圾互动：不进入处置环节
```

## 安装为 GrokBot Skill

仓库根目录的 `SKILL.md` 即技能入口（含 name/description 与调用规约）。整目录放到技能目录即可，没有依赖安装步骤：

```sh
git clone https://github.com/aritosi/x-reply-sentinel.git
cp -R x-reply-sentinel ~/your-agent-skills/x-reply-sentinel
```

要求 Node ≥ 22.18（用到内置 `node:sqlite`），TypeScript 由 Node 直接执行，不需要构建。

## 三层检测

| 层 | 成本 | 输入 | 作用 |
|---|---|---|---|
| 第一层 本地规则 | 0 Token | 单条回复正文 + 原帖 | 模板化表达、机械赞美、"读帖—分析—提问—建议"结构、空泛术语、过度结构化、机械转折、无实际内容、常见 AI 句式、机械化建议疑问 |
| 第二层 LLM 语义 | 只给灰区 | 原帖 + 回复 + 第一层命中特征 | 严格 JSON 判决（`ai_style` / `spam` / `confidence` / `human_like` / `signals` / `reason`），不输出长篇解释 |
| 第三层 合成 | 0 Token | 前两层 + 账号历史 | `ai_style_score`（风格启发式，**不代表真实 AI 生成概率**）、`spam_risk_score`（可核查垃圾风险）、`evidence`、`confidence`、`action` |

第一层的关键约束写在代码里而不是文档里：每个特征只累加到**族**分数，单一族再响也推不进审核档（`MULTI_FAMILY_CAP`），所以"不能单凭某个关键词直接判定 AI"。第二层只在本地分落在灰区（默认 18–82）时触发，批量、带缓存、受当日预算约束，模型失败即退回第一层分数。

规则文件是纯 JSON：`src/rules/zh.json`（114 词 / 107 短语 / 30 结构）、`src/rules/en.json`（83 / 88 / 24）、`src/rules/en.ported.json`（MIT 端口词库，96 / 58 / 16 + 不可见字符与排版特征）。改词表不用改代码。

## 分层处置（§五）

| 账号风险 | 档位 | 动作 |
|---|---|---|
| 70–100 | `deep_scan` | 读 bio、近期可访问帖子、外链、历史重复、存量异常 → 产出**独立的账号垃圾风险分** |
| 50–69 | `review` | 入库账号 + 回复链接 + 分数 + 证据，进当日人工审核队列，等待人工裁决 |
| 0–49 | `observe` | 只记录 |

自动拉黑的闸门（`src/actions.ts`），三个条件必须同时成立，缺一个就拒绝并写明差多少：

1. 独立可核查信号 ≥ `banMinIndependentSignals`（默认 2 类），且只算 `actions.banEligibleKinds`（`duplicate_content` / `spam_ring` / `scam_link` / `repeat_marketing` / `marketing_link` / `profile_signal` / `llm_spam_verdict`）；
2. 账号垃圾风险 ≥ `banMinSpamScore`（默认 85）；
3. 证据置信 ≥ `banMinConfidence`（默认 0.8）。

`styleOnlyKinds`（含 `llm_semantic`）在结构上被排除在闸门之外：**分数再高、AI 味再重，只要证据全是风格类，就进不了处置环节**——这条被单元测试钉住。此外白名单、已拉黑状态、每日/每小时额度、最小间隔 + 抖动都会拦下动作。

## 模式与写能力

```sh
node src/cli.ts scan <链接|id> --mode dry-run    # 默认：判定、记账、报告，绝不调用写接口
node src/cli.ts scan <链接|id> --mode review     # dry-run + 审核队列可见
node src/cli.ts scan <链接|id> --mode auto       # 满足闸门才真的拉黑
```

`--mode auto` 只是必要条件之一。provider 没有写能力时（例如 `syndication` / `import` / `fixture`），动作记为 `simulated` 而不是失败，`actions` 表也只留模拟记录，不计入真实额度。

## CLI

```
xrs scan <链接|id> [选项]              手动扫描一条帖子及其所有可访问回复
xrs watch [链接...] [选项]             扫描到期跟踪帖；带链接时先登记再扫描
xrs daily [--day YYYY-MM-DD]           当日风险权重报告（打印 + 写入 reports/）
xrs review [--limit N]                 人工审核队列
xrs review --decide <条目id>:<block|clear|whitelist>[:备注]
xrs explain <user_id|@handle>          单账号分数与证据明细（含衰减）
xrs whitelist <@handle|id>...  [--remove] [--list]
xrs import <文件> [--post id]          离线导入回复后扫描
xrs doctor                             自检
xrs test [--e2e]                       语料门槛 + 单元测试（--e2e 追加 fixture 演练）
```

通用选项：`--config`、`--data-dir`、`--mode`、`--provider`、`--force`、`--json`、`-h`。所有命令失败返回非零退出码，`--json` 输出可被脚本直接消费。

## 凭证与环境变量

凭证只以**环境变量名**出现在配置里，代码、日志、数据库、报告都不写入值；`doctor` 只报"是否设置"。

平台报错是最容易漏的出口（一个 401 正文可能把刚被拒绝的 `Authorization` 头原样带回来），所以工具生成的文本在**三个落点统一脱敏**：SQLite 的 `actions.reason` / `runs.summary_json`、审计 JSONL、报告 Markdown 的备注/错误/处置理由/深扫结论。回复原文与证据明细保持逐字——那是证据本身，脱敏规则会破坏里面的长链接。两条都有单元测试钉住。

| 变量 | 用途 |
|---|---|
| `XRS_X_BEARER_TOKEN` | 官方 API v2 应用级读取 |
| `XRS_X_AUTH_TOKEN` / `XRS_X_CT0` | 登录态 GraphQL，唯一能枚举回复树的通路 |
| `XRS_X_SELF_HANDLE` | 标记本人账号，永不处置 |
| `XRS_LLM_API_KEY`（变量名可改） | 第二层模型 |
| `XRS_MODE` / `XRS_PROVIDER` / `XRS_DATA_DIR` / `XRS_CONFIG` / `XRS_FIXTURE_FILE` / `XRS_IMPORT_FILE` / `XRS_PROXY_URL` | 运行时覆盖 |
| `XRS_LLM_ENABLED=0`、`XRS_LLM_MAX_CALLS_PER_DAY`、`XRS_LLM_MAX_TOKENS_PER_DAY`、`XRS_LLM_MAX_COST_PER_DAY_USD` | 成本闸门 |
| `XRS_MAX_BLOCKS_PER_DAY`、`XRS_REVIEW_MIN`、`XRS_DEEP_SCAN_MIN`、`XRS_BAN_MIN_SPAM_SCORE`、`XRS_HALF_LIFE_DAYS`、`XRS_GREY_ZONE_LOW/HIGH`、`XRS_MAX_REPLIES`、`XRS_MAX_REQUESTS_PER_DAY` | 阈值与规模闸门 |

`cp config.example.json ~/.x-reply-sentinel/config.json` 后按需修改；`config.example.json` 与内置默认值逐字段一致，可以直接 diff。

## 成本

默认预算：第二层每日 20 次调用 / 20 万 tokens / $0.5，超任何一项即停并写 `llm_budget_halted` 事件；请求侧每日 300 次；处置侧每日 20 次、每小时 5 次、最小间隔 90s + 60s 抖动。

省钱的结构性设计：第一层先跑完全部回复，只有灰区进模型；灰区外的分数不进第二层；同一内容再判走 SQLite 缓存（`tests/unit/layer2.test.ts` 断言第二次运行 0 请求 0 Token）；深度扫描每日最多 10 个账号，读到内容后才进入 7 天冷却（空手而归的尝试不占用冷却，下一轮仍会重试）；`--provider fixture` 与无 key 时全程零 Token 也能跑完主流程。

## 断点续扫与失败重试

游标按 `(post_id, module)` 存于 `cursors` 表，回复分页走到上限也会保存续扫游标并在报告里写"回复未抓完，下一轮自动续扫"。`comments` 以回复 id 唯一约束，重复入库只算一条；已见过的回复默认不重复检测，`--force` 才重评，且报告里区分"新 X 条"和"重新检测 X 条"。HTTP 层 429/5xx 指数退避重试，401/403 直接标记 `auth_*` 不再重试；模型返回不可解析 JSON 记为 `unparseable_verdict` / `malformed_response`，保留第一层分数，绝不编造判决。

## 记忆与审计

SQLite（`<dataDir>/sentinel.sqlite`）以**稳定 user id** 为键，`handle` 只是显示字段（改名不影响风险累计）。账号风险随证据累计、随时间衰减（默认半衰期 30 天，超过 180 天不再计入），人工纠错权重为负（`humanCorrectionWeight: -40`）。单类贡献 = `min(30, (权重 + 重复加成) × 衰减 × clamp(置信, 0.2, 1))`，重复加成每多命中一次 +3、封顶 +12；`xrs explain` 把这个乘式原样打出来，分数可以从台账自己复算。深度扫描有每日上限与 7 天冷却，但**冷却只在真的读到账号内容时开始**——通路不支持或拉取失败的尝试不占用冷却，下一轮仍会重试。每一次处置尝试——包括被拒绝的——都写入 `audit/actions.jsonl` 与 `actions` 表，字段含闸门理由、证据摘要、模式、模拟与否。

## 报告

`scan-<日期>-<帖子id>.md`：通路能力、原帖是否读到、回复是否可枚举、抓取/新增/重复计数、分层结果、第二层调用与成本、每个账号的分数与处置理由。
`daily-<日期>.md`：风险权重排名、量与成本、异常与预算中断。报告里的每个数字都能回查到库内某一行。

## 定时运行

本项目**不建常驻进程**，调度交给外部（GrokBot / cron / launchd）：

```cron
0 3,9,15,21 * * * cd /path/to/x-reply-sentinel && node src/cli.ts watch >> /tmp/xrs-watch.log 2>&1
30 9 * * *    cd /path/to/x-reply-sentinel && node src/cli.ts daily  >> /tmp/xrs-daily.log  2>&1
```

间隔与报告时刻对应 `schedule.watchIntervalHours`（默认 6）与 `schedule.dailyReportHour`（默认 9）。`watch` 只处理到期跟踪帖且只检测新回复。

## 测试

```sh
node src/cli.ts test --e2e             # 语料门槛 + 单元测试 + fixture 演练（每次重置演练目录，输出可复现）
node --test tests/unit/*.test.ts      # 34 个离线单元测试
XRS_DATA_DIR=/tmp/xrs-eval node tests/eval_corpus.ts   # 255 条标注语料门槛
```

语料门槛当前 7 项全过（2026-10-16 实测）：人类样本 150 条中 0 条进审核档（上限 6）、0 条仅凭风格进深度扫描档、简单 AI 样本 59/75 达审核档（下限 60%）、灰区路由 75/75（下限 92%）、人类样本进付费第二层的比例 11/150（上限 12）、spam/scam 样本 20/20 带本地可核查信号（下限 80%）、0 条 spam/scam 在无垃圾证据时落在深度档。单元测试覆盖闸门拒绝、节奏限制、白名单、断点续扫、幂等入库、审核队列、缓存、预算熔断、降级路径，以及运行期行为：到期跟踪、三种成本熔断、证据半衰期衰减与过期、人工撤销证据后闸门翻转、日报数字可回查到库内行、写失败不留"已拉黑"状态、平台报错里的凭证不进审计与账本、深度扫描空手而归时不占用 7 天冷却。

## 已知限制

- 无凭证时只能读原帖与回复计数，读不到回复树；报告一律写"不可访问"，不写"干净"。
- 官方 API 与登录态两条通路的响应形状在本机**未经真实调用验证**（无 key/cookie），解析全部按防御式实现。`[需验证]`
- 真实拉黑写接口从未在本机发出过；上线前需要先用一个小号验证一次。`[需验证]`
- 端点与 GraphQL 文档 id 会随 X 前端发布轮换；轮换后改配置项，不用改代码。数据通路坏了先跑 `node scripts/probe-fetch.ts` 并把结果补进 `docs/research.md`。
- AI 风格分是启发式指标，**不是**"这段是 AI 写的"的概率陈述；它只影响可见度（审核/深度扫描），永远不影响处置。
