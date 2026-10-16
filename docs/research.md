# 调研与复用台账（需求 §二）

更新日期：2026-10-16。仓库、星数、许可证、最近推送均为 GitHub REST API 当日实测（A 级证据，未认证调用 `https://api.github.com/repos/…`）；数据通路状态为本机 `scripts/probe-fetch.ts` 当日实测（A 级）。README 的自我描述属 B 级，只作为背景，不作为实现依据。

结论先行：**六个参考仓库没有一个被"合并代码"式复用。** 只有 `Jakeschincariol/instagram-agent-skill` 的一份 MIT 词库被转换成本项目自己的规则 schema（`scripts/port-slop-rules.mjs` → `src/rules/en.ported.json`，带出处声明）；其余仓库提供的是"这件事在别人手里长什么样"的形状信息：动作闸门应该怎么做、审核队列应该给人看什么、哪些端点还能用。

## 一、仓库台账

| 仓库 | 星数 | 许可证 | 最近推送 | 语言 | 判断 |
|---|---|---|---|---|---|
| `allanta8/slop-check` | 20 | MIT | 2026-06-18 | 无代码（Markdown Skill） | 纯提示词审计清单，Tier 1 rewrite flags + 8 维打分 + PASS/NEEDS REWRITE 三态。可借鉴：分层判定与"引用原文证据"的输出纪律。不可复用：它是"发布前自查自己的稿子"，不是"对别人的回复做批量检测"，没有采集、没有账号状态、没有处置。 |
| `Valpep/wiki-ai-detector` | 5 | **无许可证** | 2026-05-17 | 无代码（Markdown + `references/word-lists.md`） | 内容即 Wikipedia「Signs of AI writing」的二次整理，含分代词表与"新模型会压制 em dash 等经典特征"的提醒。可借鉴：按模型代际分词表、cluster 权重高于单次命中。**许可证缺失 = 禁止搬运任何原文或词表**，本项目自建 `src/rules/zh.json` / `en.json`。 |
| `Jakeschincariol/instagram-agent-skill` | 1500 | MIT | 2026-09-13 | Python | 其中 `skills/ig-human/slop.json` 是结构化 AI-slop 语料（words/phrases/structures/invisible/typographic）。**已复用**：经转换脚本并入 `src/rules/en.ported.json`（96 词 / 58 短语 / 16 结构 / 18 不可见字符 / 11 排版特征）。其余 12 个技能与 Instagram 运营绑定，与 X 无关，未读未用。 |
| `madeye/x-spam-auto-block` | 4 | MIT | 2026-08-15 | TypeScript | 与需求最像的样本：抓自己帖子下的回复、用 OpenAI 兼容 LLM（默认 deepseek-v4-flash）分类、把候选账号显示成浏览器内审批浮层，只有人勾选才真的拉黑。可借鉴：默认 human-in-the-loop、广告位排除、凭证只走 `.env`。**不复用**：它靠 chrome-devtools-mcp 驱动操作者自己的 Chrome——一个常驻浏览器实例，与"不建后台常驻进程"和"独立脚本负责执行"冲突，且把检测与处置耦合在同一个 agent 回合里，无法离线审计。 |
| `kayw-geek/x-spam-cast` | 0 | MIT | 2026-05-14 | TypeScript | Chrome MV3 扩展，本地模式库 + 可选 LLM 挖新规则 + 社区包订阅，宣称"过滤 100% 本地、日成本趋近 $0"。可借鉴：本地优先、LLM 只用于增量学习、模式库一旦沉淀就不再调用模型（这正是本项目第一层/第二层分工与缓存策略的动机）。**不复用**：作用域是信息流隐藏，不是回复线程审计；无账号级风险记录，也无从审计。 |
| `nirholas/XActions` | 594 | Apache-2.0 | 2026-10-15 | HTML/TS（npm `xactions` 3.5.0） | 维护最活跃、体量最大的一个：爬虫 + MCP + CLI + 浏览器脚本 + 扩展，"No API keys"。可借鉴：它的存在证明 GraphQL 文档 id 会随前端发布轮换——因此本项目把 `fetch.tweetDetailQueryId` / `fetch.userTweetsQueryId` 做成配置项而不是常量。**不复用**：功能面太宽（发推、批量操作、MCP server），依赖其运行时等于引入第三方登录态；Apache-2.0 的专利条款与再分发声明对整块引入有额外义务，本项目没有从中取码。 |

## 二、为什么没有合并代码

需求原话："不盲目合并代码。先检查兼容性、许可证和实际可用性。"三条都在这批仓库上真实生效：

- 许可证：`Valpep/wiki-ai-detector` 无许可证，法律上不允许复制；两个 MIT 仓库要求保留版权声明，因此端口产物内嵌 `_attribution` 字段，指向原始仓库与文件路径。
- 运行时兼容性：`madeye` 依赖 Chrome DevTools MCP、`kayw-geek` 依赖 MV3 扩展宿主页、`nirholas` 是带构建步骤的多包工程；本项目要求 `node src/cli.ts` 直接跑（Node ≥ 22.18 自带 `node:sqlite`），零依赖、零构建、无常驻进程，三者的代码放进这个运行时都需要先删掉它们的宿主假设。
- 实际可用性：见下一节的端点实测。参考仓库声称可用的读取通路，今天在同城同机上有一半是坏的；照搬代码等于把坏了的通路写进主流程。

## 三、X 数据通路实测（2026-10-16，本机，`scripts/probe-fetch.ts`）

| 通路 | 结果 | 含义 |
|---|---|---|
| `cdn.syndication.twimg.com/tweet-result?id=&token=&lang=` | 200，返回正文 + 作者 + `conversation_count` | 无凭证可读**原帖** |
| 同上但不带 `token` | 200，空 JSON | 派生 token 必需，缺 token 会被静默当成"没有数据" |
| `/timeline/conversation?id=` | 200，空 body | 回复枚举不可用 |
| `/srv/conversation/<id>` | 404 | 旧路径已下线 |
| `POST /1.1/guest/activate.json` | 200 拿到 `guest_token`，但 guest GraphQL 文档 id 全部 404（`Query not found`） | **无凭证枚举回复这条路已经死了** |
| `api.x.com/2/…`（不带 auth） | 401 | 官方 API 可用，需要 bearer token |
| `x.com/<user>/status/<id>` | 200 HTML | 真实回复树只有登录态 GraphQL 能读 |
| `fxtwitter-api` status | 200 `{code,message,tweet}` | 单帖镜像，可读原帖，不含回复分页 |
| `vxtwitter` json | 403（Cloudflare 挑战页） | 不可用作稳定通路 |
| `publish.twitter.com/oembed` | 200 | 只能拿到正文 HTML，无回复、无稳定 user id |
| `cdn.syndication.twimg.com/timeline-profile` | 429 Rate limit exceeded | 他人时间线：无凭证不可靠 |

实现结论（已落到代码里）：`provider=auto` 优先官方 API（有 bearer 时），其次登录态 session（能枚举回复的唯一通路），再退到 syndication（只能读原帖 + 回复计数），最后 import/fixture。能力位 `canEnumerateReplies` / `canReadProfile` 由 provider 自己声明，**报告必须区分"读不到"和"没有回复"**，缺回复时写 `notes`，绝不把"读不到"渲染成"干净"。

## 四、可核查事实与未验证事项

已在离线演练中端到端跑通（`xrs test --e2e` + `tests/unit/`，全部零 Token）：三层检测、分层 70/50、断点游标续扫、幂等入库、每日/每小时/最小间隔限流、失败重试与降级、预算熔断、人工审核队列、审计日志、报告与权重表。

尚未验证（诚实标注，`[需验证]`）：

- 官方 API v2 的具体响应字段形状与 `usage` 计费口径：本机无 key，`src/fetch/api.ts` 的解析全部按防御式写，未真实跑过一次。
- 登录态 GraphQL 的两个文档 id 与请求头要求：本机无 `auth_token`/`ct0`，未发起过真实请求；文档 id 轮换后需要更新配置而不是改代码。
- 真实拉黑写接口（`POST /2/users/:id/blocking` 或同等的 GraphQL mutation）：从未调用过。默认 `mode=dry-run`，即使 `mode=auto` 也必须 provider 具备写能力才会发出，且永远受 `actions` 闸门与节奏限制约束。
- 深度扫描对他人时间线的稳定性：`timeline-profile` 实测 429，因此深度扫描在无凭证通路上会降级为"只用已有存量异常记录"，并把未执行原因写进报告。
