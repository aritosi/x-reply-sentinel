#!/usr/bin/env node
/**
 * xrs — the command surface from spec §十.
 *
 *   xrs scan <帖子链接|id>      手动扫描一条推文及其可访问回复
 *   xrs watch                  自动模式：扫所有到期的跟踪帖
 *   xrs daily                  输出并归档当日风险权重报告
 *   xrs review                 查看/裁决人工审核队列
 *   xrs explain <账号>          单账号的分数、证据与衰减明细
 *   xrs whitelist <账号>        永不处置名单（写入 whitelist.json 并同步库内标记）
 *   xrs import <文件>           离线导入回复 JSON 后扫描
 *   xrs doctor                 自检：配置、通路、凭证变量、预算、数据库
 *   xrs test                   语料门槛 + 单元测试
 *
 * Design constraints this file has to respect:
 *   - 默认 dry-run：本文件不绕过 actions.ts 的闸门，只调用它；
 *   - 凭证只以环境变量名出现，永远不打印值（§十二 成本与安全）；
 *   - 没有常驻进程：定时由外部调度器（GrokBot / cron）拉起 watch 与 daily；
 *   - 每个命令都可被脚本消费：--json 走 stdout，人类可读输出也走 stdout，
 *     失败返回非零退出码。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Config } from "./config.ts";
import type { Evidence, ScanSummary, UserRisk } from "./types.ts";

import {
  dbPath,
  ensureDirs,
  expandPath,
  loadConfig,
  loadWhitelist,
  redactError,
  validateConfig,
} from "./config.ts";
import {
  addEvidence,
  activeEvidence,
  authorRecentTexts,
  cacheStats,
  computeRisk,
  decideReview,
  dueTracked,
  getBudget,
  getUserRow,
  latestDetectionFor,
  logEvent,
  openDb,
  pendingReview,
  pendingReviewCount,
  recordRisk,
  resolveReviewForUser,
  revokeEvidence,
  setUserTier,
  setWhitelisted,
  trackPost,
  type Db,
  type EvidenceRow,
} from "./db.ts";
import { ENGINE_VERSION } from "./detect/local.ts";
import { loadRules } from "./detect/rules.ts";
import { createProviders } from "./fetch/provider.ts";
import { blockAccount, scanDuePosts, scanPost, type ScanOptions } from "./fetch/scan.ts";
import { accountSummary, collectDaily, groupAccounts, renderDaily, writeDaily } from "./report.ts";
import { dayString, displayTime, nowIso, parseTweetUrl, truncate } from "./util.ts";

const HELP = `xrs — X Reply Sentinel（AI 味回复监测与垃圾互动处置）

用法：
  xrs scan <链接|id> [选项]      扫描一条帖子及其所有可访问的回复
  xrs watch [链接...] [选项]      扫描到期跟踪帖；带链接时先登记再扫描
  xrs daily [--day 2026-10-16]   当日风险权重报告（打印 + 写入 reports/）
  xrs review [--limit N]         人工审核队列
  xrs review --decide <条目id>:<block|clear|whitelist>[:备注]
  xrs explain <user_id|@handle>  单账号分数与证据明细
  xrs whitelist <@handle|id>...  [--remove] [--list]
  xrs import <文件> [--post id]  离线导入回复后扫描
  xrs doctor                     自检
  xrs test [--e2e]               语料门槛 + 单元测试；--e2e 追加 fixture 离线演练

常用选项：
  --config <文件>       指定 config.json
  --data-dir <目录>     数据目录（SQLite/报告/审计日志）
  --mode <dry-run|review|auto>   auto 才会真的拉黑，默认取配置
  --provider <auto|api|session|syndication|file|fixture>  数据通路
  --force               重新评分已见过的回复
  --json                机器可读输出
  -h, --help            本帮助

示例：
  xrs scan https://x.com/yuyan_lab/status/1845000000000000001
  xrs scan 1845000000000000001 --provider fixture --mode dry-run
  xrs import ./replies.json --post 1845000000000000001
  xrs watch https://x.com/me/status/1845000000000000001
  xrs daily && xrs review --limit 20
`;

interface Parsed {
  cmd: string;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `scan --force <id>` cannot eat the id. */
const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "verbose",
  "force",
  "stored",
  "list",
  "remove",
  "daily",
  "unit",
  "e2e",
  "version",
]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    positional.push(a);
  }
  return { cmd: positional.shift() ?? "", positional, flags };
}

function str(flags: Parsed["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.length ? v : undefined;
}

function has(flags: Parsed["flags"], key: string): boolean {
  return flags[key] !== undefined;
}

/** Flags override env override config file — the precedence the spec assumes. */
function applyFlagEnv(flags: Parsed["flags"]): void {
  const map: Array<[string, string]> = [
    ["config", "XRS_CONFIG"],
    ["data-dir", "XRS_DATA_DIR"],
    ["mode", "XRS_MODE"],
    ["provider", "XRS_PROVIDER"],
    ["import", "XRS_IMPORT_FILE"],
  ];
  for (const [flag, env] of map) {
    const v = str(flags, flag);
    if (v) process.env[env] = v;
  }
}

function load(flags: Parsed["flags"]): Config {
  const cfg = loadConfig({ configPath: str(flags, "config") });
  const file = str(flags, "fixture");
  if (file) cfg.fetch.fixtureFile = expandPath(file);
  const imp = str(flags, "import");
  if (imp) cfg.fetch.importFile = expandPath(imp);
  validateConfig(cfg);
  ensureDirs(cfg);
  return cfg;
}

function open(cfg: Config): Db {
  const db = openDb(cfg);
  // The whitelist file is the source of truth; the users row is its projection,
  // so an entry added before the account was ever seen still takes effect.
  const list = loadWhitelist(cfg);
  if (list.length) setWhitelisted(db.raw, list, true);
  return db;
}

function out(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function pad(text: string | number, n: number): string {
  const s = String(text);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ---------- scan ----------

function printScanSummary(s: ScanSummary, cfg: Config, verbose: boolean): void {
  out(`帖子 ${s.postId}  通路 ${s.provider}  模式 ${cfg.mode}  用时 ${(s.durationMs / 1000).toFixed(1)}s`);
  out(`  原帖 ${s.rootFound ? "已取到" : "未取到"}｜回复 ${s.repliesFetched} 条（新 ${s.repliesNew}，重复 ${s.repliesSeenAgain}）｜可枚举 ${s.repliesAccessible ? "是" : "否"}`);
  out(`  分层：观察 ${s.tierCounts.observe}｜人工审核 ${s.tierCounts.review}｜深度扫描 ${s.tierCounts.deep_scan}`);
  out(`  第二层：调用 ${s.llmCalls} 次 / ${s.llmItems} 条，仅本地规则 ${s.localOnly} 条，成本 $${s.costUsd.toFixed(4)}${s.budgetHalted ? `｜中断原因 ${s.budgetHalted}` : ""}`);
  out(`  处置：拉黑 ${s.blocked}｜模拟 ${s.blockSimulated}｜拒绝/跳过 ${s.blockSkipped}`);

  const notable = groupAccounts(s.accounts).filter((a) => a.tier !== "observe" || a.action !== "recorded");
  if (notable.length) {
    out("");
    out("  账号  回复  AI风格  回复垃圾  账号风险  检测置信  处置");
    for (const a of notable) {
      out(
        `  @${pad(a.handle, 18)} ${pad(a.replies, 4)} ${pad(a.aiStyleScore, 6)} ${pad(a.spamRiskScore, 8)} ${pad(a.accountRisk.toFixed(1), 9)} ${pad(a.confidence.toFixed(2), 5)} ${a.action}`,
      );
      if (verbose || a.action !== "recorded") out(`      ${a.reasons.join("；")}`);
      if (verbose) out(`      ${truncate(a.evidenceKinds.join("、") || "无证据", 120)}`);
    }
  }
  if (s.notes.length) {
    out("");
    for (const n of s.notes) out(`  说明：${n}`);
  }
  if (s.errors.length) {
    out("");
    for (const e of s.errors) out(`  错误：${e}`);
  }
  if (s.reportPath) out("");
  if (s.reportPath) out(`  报告：${s.reportPath}`);
}

async function cmdScan(a: Parsed, cfg: Config): Promise<number> {
  const target = a.positional[0] ?? str(a.flags, "post");
  if (!target) {
    out("缺少目标：xrs scan <帖子链接|id>");
    return 2;
  }
  const db = open(cfg);
  try {
    const opts: ScanOptions = {
      target,
      kind: "manual",
      force: has(a.flags, "force"),
      includeStored: has(a.flags, "stored"),
    };
    const summary = await scanPost(db.raw, cfg, opts);
    if (has(a.flags, "json")) json(summary);
    else printScanSummary(summary, cfg, has(a.flags, "verbose"));
    // "Nothing to do" and "could not read anything" must not look the same to a
    // scheduler: only the second one is a failure.
    const didWork = summary.repliesFetched > 0 || summary.repliesSeenAgain > 0 || summary.rootFound;
    return summary.errors.length && !didWork ? 1 : 0;
  } finally {
    db.close();
  }
}

// ---------- watch ----------

async function cmdWatch(a: Parsed, cfg: Config): Promise<number> {
  const db = open(cfg);
  try {
    for (const target of a.positional) {
      const parsed = parseTweetUrl(target);
      if (!parsed) {
        out(`跳过无法解析的链接：${truncate(target, 60)}`);
        continue;
      }
      trackPost(db.raw, parsed.id, {
        url: `https://x.com/${parsed.handle ?? "i"}/status/${parsed.id}`,
        mode: cfg.mode,
        mine: false,
      });
      out(`已登记跟踪帖 ${parsed.id}${parsed.handle ? ` (@${parsed.handle})` : ""}`);
    }
    const due = dueTracked(db.raw);
    if (!due.length) {
      out("没有到期的跟踪帖。用 `xrs watch <链接>` 登记，或 `xrs scan <链接>` 立即扫描。");
      return 0;
    }
    out(`到期 ${due.length} 条跟踪帖，通路 ${cfg.fetch.provider}，模式 ${cfg.mode}`);
    const summaries = await scanDuePosts(db.raw, cfg);
    for (const s of summaries) {
      out("");
      printScanSummary(s, cfg, false);
    }
    if (has(a.flags, "daily")) {
      const d = collectDaily(cfg, db.raw);
      const file = writeDaily(cfg, d);
      out(`\n当日报告：${file}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// ---------- daily ----------

function cmdDaily(a: Parsed, cfg: Config): number {
  const db = open(cfg);
  try {
    const day = str(a.flags, "day") ?? dayString(new Date(), cfg.timezone);
    const data = collectDaily(cfg, db.raw, day);
    const file = writeDaily(cfg, data);
    if (has(a.flags, "json")) json(data);
    else out(renderDaily(data, cfg));
    out(`\n报告文件：${file}`);
    return 0;
  } finally {
    db.close();
  }
}

// ---------- review ----------

function evidenceToLedger(rows: EvidenceRow[]): Evidence[] {
  return rows.map((r) => ({
    kind: r.kind as Evidence["kind"],
    weight: Number(r.weight),
    key: r.dedup_key,
    detail: r.detail ?? r.kind,
    source: r.source as Evidence["source"],
    confidence: Number(r.confidence),
  }));
}

function printReviewList(a: Parsed, cfg: Config, db: Db): number {
  const limit = Number(str(a.flags, "limit") ?? 50);
  const rows = pendingReview(db.raw, limit);
  if (!rows.length) {
    out("人工审核队列为空。");
    return 0;
  }
  if (has(a.flags, "json")) {
    json(rows);
    return 0;
  }
  const total = pendingReviewCount(db.raw);
  const shown = rows.length < total ? `（按账号风险显示前 ${rows.length} 条）` : "";
  out(`待人工审核 ${total} 条${shown}（模式 ${cfg.mode}，不会自动处置）：`);
  out("");
  for (const r of rows) {
    out(`  #${r.id}  @${r.handle}  AI风格 ${r.ai_style_score ?? "-"}｜垃圾 ${r.spam_risk_score ?? "-"}`);
    out(`      回复：${truncate(r.text ?? "", 150)}`);
    out(`      帖子 https://x.com/i/status/${r.post_id}｜回复 https://x.com/i/status/${r.comment_id}`);
    const kinds = (() => {
      try {
        const arr = JSON.parse(String(r.evidence_json ?? "[]")) as Array<{ kind: string }>;
        return [...new Set(arr.map((e) => e.kind))].join(",");
      } catch {
        return "-";
      }
    })();
    out(`      证据：${kinds || "-"}`);
    for (const line of accountSummary(cfg, db.raw, r.user_id).slice(0, 4)) out(`      ${line}`);
    out("");
  }
  out(`裁决：xrs review --decide <条目id>:block|clear|whitelist[:备注]`);
  return 0;
}

async function cmdReview(a: Parsed, cfg: Config): Promise<number> {
  const db = open(cfg);
  try {
    const decide = str(a.flags, "decide");
    if (!decide) return printReviewList(a, cfg, db);

    const [idRaw, verdictRaw, ...noteParts] = decide.split(":");
    const id = Number(idRaw);
    const verdict = (verdictRaw ?? "").trim().toLowerCase();
    const note = [noteParts.join(":"), `by xrs@${nowIso()}`].filter(Boolean).join(" ");
    const row = pendingReview(db.raw, 500).find((r) => r.id === id);
    if (!row) {
      out(`找不到待审核条目 #${idRaw}（先运行 xrs review 查看队列）`);
      return 1;
    }
    if (!["block", "clear", "whitelist", "skip"].includes(verdict)) {
      out(`裁决只能是 block / clear / whitelist / skip，收到：${verdictRaw ?? "(空)"}`);
      return 2;
    }

    const user = getUserRow(db.raw, row.user_id);
    if (!user) {
      out(`条目 #${id} 对应的账号已不在库中`);
      return 1;
    }

    if (verdict === "clear" || verdict === "skip") {
      // 误判纠正：撤销在案证据并重算风险，账号回到观察档。
      const kinds = [...new Set(activeEvidence(db.raw, row.user_id).map((e) => e.kind))] as Array<Evidence["kind"]>;
      let revoked = 0;
      for (const kind of kinds) revoked += revokeEvidence(db.raw, row.user_id, kind, ` human_correction ${truncate(note, 120)}`);
      setUserTier(db.raw, row.user_id, "observe");
      const risk = recordRisk(db.raw, cfg, {
        userId: row.user_id,
        handle: user.handle,
        whitelisted: !!user.whitelisted,
        banState: user.ban_state,
        firstSeen: user.first_seen,
        lastSeen: user.last_seen,
        previousScore: user.risk_score,
        tier: "observe",
      });
      decideReview(db.raw, id, verdict, note);
      out(`#${id} @${user.handle}：撤销 ${revoked} 条证据，账号风险 ${risk.riskScore.toFixed(1)}，已回到观察档`);
      return 0;
    }

    if (verdict === "whitelist") {
      setWhitelisted(db.raw, [row.user_id], true);
      const list = loadWhitelist(cfg);
      if (!list.includes(user.handle)) {
        const file = path.isAbsolute(cfg.whitelistFile) ? cfg.whitelistFile : path.join(cfg.dataDir, cfg.whitelistFile);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify([...list, user.handle], null, 2)}\n`, "utf8");
      }
      decideReview(db.raw, id, "whitelist", note);
      out(`#${id} @${user.handle} 已加入白名单（永不处置），文件：${cfg.whitelistFile}`);
      return 0;
    }

    // block: a human decision still walks the same gate, so the audit trail
    // shows *why* it happened. The confirm itself raises risk but is not a
    // ban-eligible kind — a person agreeing cannot manufacture evidence.
    addEvidence(db.raw, row.user_id, {
      kind: "human_confirm",
      weight: 30,
      key: `human_confirm:review-${id}`,
      detail: `人工确认处置：${truncate(note, 200)}`,
      source: "human",
      confidence: 1,
    }, { commentId: row.comment_id, postId: row.post_id });
    const risk = recordRisk(db.raw, cfg, {
      userId: row.user_id,
      handle: user.handle,
      whitelisted: !!user.whitelisted,
      banState: user.ban_state,
      firstSeen: user.first_seen,
      lastSeen: user.last_seen,
      previousScore: user.risk_score,
      tier: (row.ai_style_score ?? 0) >= cfg.thresholds.deepScanMin ? "deep_scan" : "review",
    });
    const bundle = createProviders(db.raw, cfg);
    const res = await blockAccount(db.raw, cfg, risk, {
      actor: bundle.capabilities.block ? bundle.primary : {},
      whitelisted: !!user.whitelisted,
      banState: user.ban_state,
    });
    decideReview(db.raw, id, res.status === "blocked" ? "block" : `block:${res.status}`, note);
    // The verdict is about the account, not about one reply: leaving its other
    // pending items open would keep asking a question that has been answered.
    const closed = res.ok ? resolveReviewForUser(db.raw, row.user_id, `block:${res.status}`, `随 #${id} 一并裁决`) : 0;
    out(`#${id} @${user.handle} → ${res.status}｜账号风险 ${risk.riskScore.toFixed(1)}`);
    for (const d of res.detail) out(`  · ${d}`);
    if (res.status !== "blocked") out(`  闸门理由：${res.reasons.join("，")}`);
    if (closed) out(`  同一账号另有 ${closed} 条待审项一并标记为已裁决`);
    if (cfg.mode !== "auto") out(`  模式为 ${cfg.mode}：只记录，不触碰平台。`);
    return 0;
  } finally {
    db.close();
  }
}

// ---------- explain ----------

function cmdExplain(a: Parsed, cfg: Config): number {
  const key = (a.positional[0] ?? "").replace(/^@/, "").toLowerCase();
  if (!key) {
    out("用法：xrs explain <user_id|@handle>");
    return 2;
  }
  const db = open(cfg);
  try {
    const row = db.raw
      .prepare("SELECT id, handle, display_name, whitelisted, ban_state, tier, risk_score, first_seen, last_seen, deep_scanned_at FROM users WHERE id = ? OR handle = ? LIMIT 1")
      .get(key, key) as
      | { id: string; handle: string; display_name: string | null; whitelisted: number; ban_state: string; tier: string; risk_score: number; first_seen: string; last_seen: string; deep_scanned_at: string | null }
      | undefined;
    if (!row) {
      out(`库内没有这个账号：${key}`);
      return 1;
    }
    const ledger = activeEvidence(db.raw, row.id);
    const { components, independentSpamKinds } = computeRisk(db.raw, cfg, {
      userId: row.id,
      handle: row.handle,
      whitelisted: !!row.whitelisted,
      banState: row.ban_state,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      previousScore: null,
      tier: row.tier as UserRisk["tier"],
    });
    const last = latestDetectionFor(db.raw, row.id);
    if (has(a.flags, "json")) {
      json({ user: row, risk: { score: row.risk_score, components, independentSpamKinds }, evidence: ledger, lastDetection: last ?? null, recent: authorRecentTexts(db.raw, row.id, 10) });
      return 0;
    }
    out(`@${row.handle}（user id ${row.id}）`);
    out(`  档位 ${row.tier}｜账号风险 ${Number(row.risk_score).toFixed(1)}｜白名单 ${row.whitelisted ? "是" : "否"}｜处置状态 ${row.ban_state}｜首次 ${displayTime(row.first_seen, cfg.timezone)}｜最近 ${displayTime(row.last_seen, cfg.timezone)}`);
    out(`  最近一次检测：AI风格 ${last?.ai_style_score ?? "-"}｜垃圾 ${last?.spam_risk_score ?? "-"}｜置信 ${(last?.confidence ?? Number.NaN).toFixed(2)}｜${last?.tier ?? "-"}`);
    out(`  可核查垃圾信号：${independentSpamKinds.join(", ") || "无"}`);
    out("");
    out("  风险构成（权重 × 衰减 × 置信，单类上限 " + cfg.risk.maxContributionPerKind + "）：");
    for (const c of components.sort((x, y) => y.contribution - x.contribution)) {
      // Print the whole product so the number is reproducible from the ledger alone.
      const conf = Number.isFinite(c.confidence) ? Number(c.confidence).toFixed(2) : "—";
      const raw = (c.baseWeight + c.repeatBonus) * c.decayFactor * (Number.isFinite(c.confidence) ? Number(c.confidence) : 1);
      const cap = raw > cfg.risk.maxContributionPerKind ? " ←已截断" : "";
      out(
        `    ${pad(c.kind, 22)} ${pad(c.contribution.toFixed(2), 7)}  = (${c.baseWeight}+${c.repeatBonus})×${c.decayFactor}×${conf}${cap}  ← ${truncate(c.detail, 90)}`,
      );
    }
    if (!components.length) out("    （无在案证据）");
    out("");
    out("  证据台账：");
    for (const line of accountSummary(cfg, db.raw, row.id)) out(`    ${line}`);
    const recent = authorRecentTexts(db.raw, row.id, 8);
    if (recent.length) {
      out("");
      out("  库内最近回复：");
      for (const r of recent) out(`    · ${truncate(r.text, 130)}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// ---------- whitelist ----------

function cmdWhitelist(a: Parsed, cfg: Config): number {
  const file = path.isAbsolute(cfg.whitelistFile) ? cfg.whitelistFile : path.join(cfg.dataDir, cfg.whitelistFile);
  const read = (): string[] => {
    if (!fs.existsSync(file)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return Array.isArray(raw) ? raw.map(String) : ((raw as { ids?: string[] }).ids ?? []).map(String);
    } catch {
      return [];
    }
  };
  if (has(a.flags, "list")) {
    const list = read();
    out(list.length ? `白名单 ${list.length} 项：${list.join(", ")}` : "白名单为空");
    out(`文件：${file}`);
    return 0;
  }
  const names = a.positional.map((v) => v.replace(/^@/, "").toLowerCase());
  if (!names.length) {
    out("用法：xrs whitelist <@handle|user_id> [--remove]");
    return 2;
  }
  const remove = has(a.flags, "remove");
  const db = open(cfg);
  let touched = 0;
  try {
    touched = setWhitelisted(db.raw, names, !remove);
  } finally {
    db.close();
  }
  const list = read().filter((v) => v && !names.includes(v.replace(/^@/, "").toLowerCase()));
  if (!remove) list.push(...names);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  out(`${remove ? "移出" : "加入"}白名单：${names.join(", ")}`);
  out(`  文件 ${file}（共 ${list.length} 项）；库内已存在的账号标记 ${touched} 个`);
  if (!remove && touched === 0) out("  这些名字库里还没有记录——扫描到它们时会自动跳过处置。");
  return 0;
}

// ---------- import ----------

async function cmdImport(a: Parsed, cfg: Config): Promise<number> {
  const file = a.positional[0] ?? str(a.flags, "file");
  if (!file) {
    out("用法：xrs import <回复.json> [--post <id>]");
    return 2;
  }
  const abs = path.isAbsolute(file) ? file : path.resolve(file);
  if (!fs.existsSync(abs)) {
    out(`文件不存在：${abs}`);
    return 1;
  }
  cfg.fetch.importFile = abs;
  cfg.fetch.provider = "file";
  const db = open(cfg);
  try {
    const target = a.positional[1] ?? str(a.flags, "post") ?? "";
    const summary = await scanPost(db.raw, cfg, { target: target || peekRootId(abs), kind: "manual", force: has(a.flags, "force") });
    if (has(a.flags, "json")) json(summary);
    else printScanSummary(summary, cfg, has(a.flags, "verbose"));
    return 0;
  } finally {
    db.close();
  }
}

/** When the operator does not name the root post, take the one the file marks. */
function peekRootId(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    const firstLine = text.split(/\r?\n/)[0];
    const nodes = JSON.parse(text.startsWith("[") || text.startsWith("{") ? text : firstLine) as unknown;
    const flat: Array<Record<string, unknown>> = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (o.id || o.id_str || o.tweet_id) flat.push(o);
        for (const k of ["data", "tweets", "replies", "entries", "items", "results", "conversation"]) if (o[k] !== undefined) walk(o[k]);
      }
    };
    walk(nodes);
    const root = flat.find((o) => o.isRoot === true) ?? flat.find((o) => !o.in_reply_to_status_id && !o.in_reply_to_status_id_str);
    return String(root?.id ?? root?.id_str ?? root?.tweet_id ?? "");
  } catch {
    return "";
  }
}

// ---------- doctor ----------

function envState(name: string): string {
  return process.env[name] ? "已设置" : "缺失";
}

function cmdDoctor(a: Parsed, cfg: Config): number {
  const problems: string[] = [];
  const db = open(cfg);
  try {
    const count = (sql: string): number => Number((db.raw.prepare(sql).get() as { n: number }).n);
    const budget = getBudget(db.raw, cfg);
    const cache = cacheStats(db.raw);
    out(`xrs 自检  ${displayTime(nowIso(), cfg.timezone)}  数据库时间戳为 UTC`);
    out("");
    out(`  模式        ${cfg.mode}${cfg.mode === "auto" ? "（会真的拉黑）" : "（不会触碰平台）"}`);
    out(`  数据目录    ${cfg.dataDir}`);
    out(`  数据库      ${dbPath(cfg)}${fs.existsSync(dbPath(cfg)) ? "" : " （尚未创建）"}`);
    out(`  报告目录    ${path.join(cfg.dataDir, cfg.reportDir)}`);
    out(`  审计日志    ${path.isAbsolute(cfg.auditLog) ? cfg.auditLog : path.join(cfg.dataDir, cfg.auditLog)}`);
    out(`  引擎/规则   ${ENGINE_VERSION} / ${rulesVersion()}`);
    out("");
    out("  阈值：审核起 " + cfg.thresholds.reviewMin + "｜深度扫描起 " + cfg.thresholds.deepScanMin +
      `｜拉黑需垃圾风险 ≥${cfg.thresholds.banMinSpamScore} 且独立信号 ≥${cfg.thresholds.banMinIndependentSignals} 且置信 ≥${cfg.thresholds.banMinConfidence}`);
    out(`  仅 AI 风格不拉黑：闸门只认 ${cfg.actions.banEligibleKinds.join("/")}`);
    out(`  节奏：每日最多拉黑 ${cfg.actions.maxPerDay}，每小时 ${cfg.actions.maxPerHour}，最小间隔 ${Math.round(cfg.actions.minIntervalMs / 1000)}s`);
    out(`  LLM：灰区 ${cfg.llm.greyZone[0]}-${cfg.llm.greyZone[1]}｜每日上限 ${cfg.llm.maxCallsPerDay} 次 / ${cfg.llm.maxTokensPerDay} tokens / $${cfg.llm.maxCostPerDayUsd}`);
    out(`  风险衰减：半衰期 ${cfg.risk.halfLifeDays} 天，超过 ${cfg.risk.maxAgeDays} 天不计`);
    out("");
    out("  凭证变量（只看是否设置，不读取值）：");
    for (const [label, name] of [
      ["X API bearer", cfg.fetch.bearerTokenEnv],
      ["会话 auth_token", cfg.fetch.authTokenEnv],
      ["会话 ct0", cfg.fetch.ct0Env],
      ["本人 handle", cfg.fetch.selfHandleEnv],
      ["LLM key", cfg.llm.apiKeyEnv],
    ] as Array<[string, string]>) {
      out(`    ${pad(label, 18)} ${pad(name, 24)} ${envState(name)}`);
    }
    out("");
    let bundleNotes: string[] = [];
    let caps: string[] = [];
    try {
      const bundle = createProviders(db.raw, cfg);
      bundleNotes = [...bundle.notes];
      caps = Object.entries(bundle.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k);
      out(`  数据通路      ${bundle.name}｜能力 ${caps.join(",") || "无"}｜可枚举回复 ${bundle.canEnumerateReplies ? "是" : "否"}`);
      for (const n of bundleNotes) out(`    · ${n}`);
    } catch (err) {
      problems.push(`数据通路初始化失败：${redactError(err)}`);
    }
    out("");
    out(`  今日预算    LLM ${budget.llmCalls}/${cfg.llm.maxCallsPerDay} 次｜tokens ${budget.tokensIn + budget.tokensOut}/${cfg.llm.maxTokensPerDay}｜$${budget.costUsd.toFixed(4)}/$${cfg.llm.maxCostPerDayUsd}｜请求 ${budget.fetchRequests}/${cfg.fetch.maxRequestsPerDay}｜处置 ${budget.actions}/${cfg.actions.maxPerDay}`);
    out(`  数据量      账号 ${count("SELECT COUNT(*) AS n FROM users")}｜回复 ${count("SELECT COUNT(*) AS n FROM comments")}｜检测 ${count("SELECT COUNT(*) AS n FROM detections")}｜证据 ${count("SELECT COUNT(*) AS n FROM evidence WHERE status='active'")}｜待审 ${count("SELECT COUNT(*) AS n FROM review_items WHERE status='pending'")}｜跟踪帖 ${count("SELECT COUNT(*) AS n FROM tracked_posts WHERE active=1")}｜运行 ${count("SELECT COUNT(*) AS n FROM runs")}`);
    out(`  LLM 缓存    ${cache.entries} 条，命中 ${cache.hits} 次`);
    const fixture = cfg.fetch.fixtureFile || path.join(projectRoot(), "fixtures", "demo-thread.json");
    out(`  演示语料    ${fixture}${fs.existsSync(fixture) ? "" : " （缺失）"}`);
    out("");
    if (problems.length) {
      for (const p of problems) out(`  ✗ ${p}`);
      return 1;
    }
    out("  ✓ 配置与数据库可用");
    if (!caps.includes("replies")) out("  ！当前通路无法枚举回复：设置 bearer token / 会话 cookie，或用 xrs import 导入回复");
    if (!process.env[cfg.llm.apiKeyEnv]) out("  ！未设置 LLM key：第二层不会调用，灰区回复将只按本地规则分数处理");
    out("");
    out("  下一步：xrs scan <帖子链接> --provider fixture 先做一次离线演练；xrs daily 看报告。");
    if (has(a.flags, "json")) {
      json({ mode: cfg.mode, provider: cfg.fetch.provider, capabilities: caps, notes: bundleNotes, budget, cache });
    }
    return 0;
  } finally {
    db.close();
  }
}

function rulesVersion(): string {
  try {
    return loadRules().version;
  } catch (err) {
    return `规则加载失败：${redactError(err)}`;
  }
}

function projectRoot(): string {
  // .../src/cli.ts → the package root holding src/, tests/, fixtures/, package.json.
  // decodeURIComponent alone is not enough on a non-ASCII install path (this project
  // sits in a Chinese-named folder), so go through fileURLToPath instead of .pathname.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

// ---------- test ----------

function cmdTest(a: Parsed, cfg: Config): number {
  const here = projectRoot();
  let code = 0;
  const run = (args: string[], label: string): void => {
    out(`\n=== ${label}`);
    const res = spawnSync(process.execPath, args, { cwd: here, stdio: "inherit", env: { ...process.env, XRS_DATA_DIR: process.env.XRS_DATA_DIR ?? cfg.dataDir } });
    if (res.error) {
      // Without this a bad cwd or a missing entry point looks like a silent zero-output pass.
      out(`  无法启动 ${args[0]}：${redactError(res.error)}`);
      code = 1;
      return;
    }
    if (res.status !== 0) code = res.status ?? 1;
  };
  run(["tests/eval_corpus.ts"], "语料门槛（255 条标注样本，Layer 1）");
  // `node --test <dir>` does not resolve a directory in this runtime, so list the files.
  const unitDir = path.join(here, "tests", "unit");
  const unitFiles = fs.existsSync(unitDir) ? fs.readdirSync(unitDir).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `tests/unit/${f}`) : [];
  if (unitFiles.length) run(["--test", ...unitFiles], `单元测试（${unitFiles.length} 个文件）`);
  else out("\n（tests/unit 尚不存在，跳过单元测试）");
  if (has(a.flags, "e2e")) {
    const e2eDir = process.env.XRS_E2E_DIR ?? "/tmp/xrs-e2e";
    // The rehearsal must read the same every run. A leftover ledger makes the second
    // run report "新 0 重复 12" and lifts risk scores through the repeat bonus, which
    // looks like a resume bug rather than a warm cache — and the README quotes these
    // numbers. Idempotent storage is asserted in tests/unit/scan.test.ts instead.
    fs.rmSync(e2eDir, { recursive: true, force: true });
    process.env.XRS_DATA_DIR = e2eDir;
    run(["src/cli.ts", "scan", "1845000000000000001", "--provider", "fixture", "--force"], "离线端到端演练（fixture）");
  }
  out(code === 0 ? "\n全部通过" : `\n失败，退出码 ${code}`);
  return code;
}

// ---------- entry ----------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  if (has(a.flags, "help") || (!a.cmd && !Object.keys(a.flags).length)) {
    out(HELP);
    return a.cmd ? 0 : 2;
  }
  if (a.cmd === "version" || has(a.flags, "version")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot(), "package.json"), "utf8")) as { version?: string };
      out(`xrs ${pkg.version ?? "0.0.0"}｜引擎 ${ENGINE_VERSION}`);
    } catch {
      out(`xrs｜引擎 ${ENGINE_VERSION}`);
    }
    return 0;
  }

  applyFlagEnv(a.flags);
  let cfg: Config;
  try {
    cfg = load(a.flags);
  } catch (err) {
    out(`配置错误：${redactError(err)}`);
    return 1;
  }

  try {
    switch (a.cmd) {
      case "scan":
        return await cmdScan(a, cfg);
      case "watch":
        return await cmdWatch(a, cfg);
      case "daily":
        return cmdDaily(a, cfg);
      case "review":
        return await cmdReview(a, cfg);
      case "explain":
        return cmdExplain(a, cfg);
      case "whitelist":
        return cmdWhitelist(a, cfg);
      case "import":
        return await cmdImport(a, cfg);
      case "doctor":
        return cmdDoctor(a, cfg);
      case "test":
        return cmdTest(a, cfg);
      default:
        out(`未知命令：${a.cmd || "(空)"}`);
        out(HELP);
        return 2;
    }
  } catch (err) {
    logEventBestEffort(cfg, a.cmd, err);
    out(`执行失败：${redactError(err)}`);
    return 1;
  }
}

function logEventBestEffort(cfg: Config, cmd: string, err: unknown): void {
  try {
    const db = openDb(cfg);
    logEvent(db.raw, "error", `cli_${cmd || "unknown"}`, { error: redactError(err) });
    db.close();
  } catch {
    /* the error already reaches the operator on stdout */
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      out(`致命错误：${redactError(err)}`);
      process.exit(1);
    },
  );
}
