#!/usr/bin/env node
/**
 * Reports (spec §七). Everything an operator reads is generated here, and every
 * number printed here is traceable to a row in SQLite. Two documents:
 *
 *   scan-<post>.md    — one manual/auto scan: what was fetched, what hit, what was done.
 *   daily-<day>.md    — the weighted account ranking, volume, cost and anomalies.
 */
import fs from "node:fs";
import path from "node:path";

import type { DailyReportData, ScanAccountRow, ScanSummary, Tier, UserRisk } from "./types.ts";
import { redact, type Config } from "./config.ts";
import {
  activeEvidence,
  cacheStats,
  commentsInWindow,
  getBudget,
  pathFor,
  pendingReviewCount,
  previousDayScore,
  rankedUsers,
} from "./db.ts";
import { dayRange, dayString, displayTime, pct, truncate } from "./util.ts";

function slug(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60);
}

/**
 * Tool-generated prose — provider failures, gate verdicts, deep-scan notes — is the
 * text that can carry a credential (a 401 body quoting the Authorization header it
 * just rejected), so it is redacted before it reaches a report file. Reply text and
 * evidence detail stay verbatim: they are user content, and the redactor's cookie
 * rule would mangle the long URLs that *are* the spam evidence.
 */
function safe(text: string): string {
  return redact(text ?? "");
}

export function ensureReportDir(cfg: Config): string {
  const dir = path.join(cfg.dataDir, cfg.reportDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TIER_LABEL: Record<string, string> = {
  observe: "观察",
  review: "人工审核",
  deep_scan: "深度扫描",
};

const ACTION_LABEL: Record<string, string> = {
  recorded: "已记录",
  queued_review: "进入人工审核队列",
  deep_scanned: "已深度扫描",
  deep_skipped: "深度扫描未执行",
  blocked: "已拉黑",
  simulated: "模拟拉黑（未执行）",
  skipped: "拒绝执行",
  failed: "执行失败",
  already: "此前已拉黑",
};

/**
 * One account can answer the same post three times, and its ledger risk climbs
 * with each reply. Listing those rows side by side makes the table unreadable and
 * hides the fact that it is one account; the per-reply detail below still shows
 * every row and the climb that led to a decision.
 */
export interface AccountRollup {
  userId: string;
  handle: string;
  replies: number;
  aiStyleScore: number;
  localStyleScore: number;
  llmStyleScore: number | null;
  spamRiskScore: number;
  accountRisk: number;
  confidence: number;
  tier: Tier;
  action: string;
  reasons: string[];
  evidenceKinds: string[];
}

const TIER_RANK: Record<Tier, number> = { observe: 0, review: 1, deep_scan: 2 };
/** A real disposal outcome outranks a bookkeeping one when rolled up. */
const ACTION_RANK = ["recorded", "queued_review", "deep_skipped", "deep_scanned", "skipped", "simulated", "already", "failed", "blocked"];

export function groupAccounts(rows: ScanAccountRow[]): AccountRollup[] {
  const byUser = new Map<string, AccountRollup>();
  for (const r of rows) {
    const key = r.userId || r.handle;
    const cur = byUser.get(key);
    if (!cur) {
      byUser.set(key, {
        userId: r.userId,
        handle: r.handle,
        replies: 1,
        aiStyleScore: r.aiStyleScore,
        localStyleScore: r.localStyleScore,
        llmStyleScore: r.llmStyleScore,
        spamRiskScore: r.spamRiskScore,
        accountRisk: r.accountRisk,
        confidence: r.confidence,
        tier: r.tier,
        action: r.action,
        reasons: [...r.reasons],
        evidenceKinds: [...r.evidenceKinds],
      });
      continue;
    }
    cur.replies++;
    // Keep the local/model split of the reply that actually scored highest, so
    // "97（本地 97/模型 88）" describes one real reply instead of mixing rows.
    if (r.aiStyleScore >= cur.aiStyleScore) {
      cur.aiStyleScore = r.aiStyleScore;
      cur.localStyleScore = r.localStyleScore;
      cur.llmStyleScore = r.llmStyleScore;
    }
    cur.spamRiskScore = Math.max(cur.spamRiskScore, r.spamRiskScore);
    cur.confidence = Math.max(cur.confidence, r.confidence);
    // The ledger value only ever goes up inside a run, so the last row holds it.
    cur.accountRisk = Math.max(cur.accountRisk, r.accountRisk);
    if (TIER_RANK[r.tier] > TIER_RANK[cur.tier]) cur.tier = r.tier;
    if (ACTION_RANK.indexOf(r.action) > ACTION_RANK.indexOf(cur.action)) {
      cur.action = r.action;
      cur.reasons = [...r.reasons];
    }
    for (const k of r.evidenceKinds) if (!cur.evidenceKinds.includes(k)) cur.evidenceKinds.push(k);
  }
  return [...byUser.values()].sort(
    (a, b) => b.accountRisk - a.accountRisk || b.aiStyleScore - a.aiStyleScore || b.replies - a.replies,
  );
}

export function renderScanReport(s: ScanSummary, tz = "Asia/Shanghai"): string {
  const lines: string[] = [];
  lines.push(`# 扫描报告 · ${s.postId}`);
  lines.push("");
  lines.push(`- 时间：${displayTime(s.startedAt, tz)}（用时 ${(s.durationMs / 1000).toFixed(1)}s，run #${s.runId}）`);
  lines.push(`- 数据通路：${s.provider}`);
  lines.push(`- 原帖：${s.postUrl}`);
  lines.push(`- 原帖正文：${s.rootText ? truncate(s.rootText.replace(/\s+/g, " "), 160) : "（未取得）"}`);
  lines.push(
    `- 回复：抓取 ${s.repliesFetched} 条 / 新 ${s.repliesNew} 条 / 已存在 ${s.repliesSeenAgain} 条${
      s.repliesAccessible ? "" : "（该通路无法枚举回复，数字为 0 不代表没有回复）"
    }`,
  );
  lines.push(
    `- 分层：观察 ${s.tierCounts.observe} · 人工审核 ${s.tierCounts.review} · 深度扫描 ${s.tierCounts.deep_scan}`,
  );
  lines.push(
    `- 成本：本地过滤 ${s.localOnly} 条零 Token，模型判定 ${s.llmItems} 条 / ${s.llmCalls} 次调用，${s.tokensIn}+${s.tokensOut} tokens ≈ $${s.costUsd.toFixed(4)}`,
  );
  lines.push(
    `- 处置：真实拉黑 ${s.blocked} · 模拟 ${s.blockSimulated} · 拒绝 ${s.blockSkipped}`,
  );
  if (s.budgetHalted) lines.push(`- 预算中断：${safe(s.budgetHalted)}`);
  for (const n of s.notes) lines.push(`- 备注：${safe(n)}`);
  for (const e of s.errors) lines.push(`- 错误：${safe(e)}`);

  lines.push("");
  lines.push("## 命中账号与证据");
  lines.push("");
  const accounts = groupAccounts(s.accounts);
  const rows = [...s.accounts].sort(
    (a, b) => b.accountRisk - a.accountRisk || b.spamRiskScore - a.spamRiskScore || b.aiStyleScore - a.aiStyleScore,
  );
  if (!accounts.length) {
    lines.push("（本次没有达到记录阈值的回复）");
  } else {
    lines.push("| 账号 | 回复数 | AI 风格分 | 回复垃圾风险 | 账号风险 | 置信度 | 分层 | 处置 | 证据 |");
    lines.push("|---|---:|---:|---:|---:|---:|---|---|---|");
    for (const r of accounts) {
      const style = `${r.aiStyleScore}（本地 ${r.localStyleScore}${r.llmStyleScore !== null ? `/模型 ${r.llmStyleScore}` : ""}）`;
      lines.push(
        `| @${r.handle} | ${r.replies} | ${style} | ${r.spamRiskScore} | ${r.accountRisk.toFixed(1)} | ${r.confidence.toFixed(2)} | ${TIER_LABEL[r.tier]} | ${ACTION_LABEL[r.action] ?? r.action} | ${r.evidenceKinds.join("、") || "—"} |`,
      );
    }
    lines.push("");
    lines.push("## 逐条明细");
    lines.push("");
    for (const r of rows) {
      lines.push(`### @${r.handle} · 回复 ${r.commentId}`);
      lines.push("");
      lines.push(`- 链接：${r.commentUrl ?? "（未知）"}`);
      lines.push(`- 回复内容：${truncate(r.text.replace(/\s+/g, " "), 220)}`);
      lines.push(
        `- 评分：AI 风格 ${r.aiStyleScore}（0-100，启发式指标，不等于 AI 生成概率）· 回复垃圾风险 ${r.spamRiskScore} · 账号风险 ${r.accountRisk.toFixed(1)}`,
      );
      if (r.llmStyleScore !== null) lines.push(`- 模型判断：风格 ${r.llmStyleScore}，语义证据见下`);
      for (const d of r.evidenceDetail) lines.push(`  - ${d}`);
      for (const f of r.deepScanFindings) lines.push(`  - 深扫：${safe(f)}`);
      if (r.reasons.length) lines.push(`- 处置理由：${safe(r.reasons.join("；"))}`);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("AI 风格分只用于排序与提醒，拉黑只依据可核查的垃圾互动证据。");
  return lines.join("\n");
}

export function writeScanReport(cfg: Config, s: ScanSummary): string {
  const dir = ensureReportDir(cfg);
  const file = path.join(dir, `scan-${dayString(new Date(), cfg.timezone)}-${slug(s.postId) || "no-post"}.md`);
  fs.writeFileSync(file, renderScanReport(s, cfg.timezone) + "\n", "utf8");
  return file;
}

export interface DailyInput {
  cfg: Config;
  db: Parameters<typeof rankedUsers>[0];
  day: string;
}

export function collectDaily(cfg: Config, db: DailyInput["db"], day = dayString(new Date(), cfg.timezone)): DailyReportData {
  const budget = getBudget(db, cfg);
  const stats = {
    postsScanned: 0,
    repliesNew: commentsInWindow(db, cfg, day),
    localFiltered: 0,
    llmCalls: budget.llmCalls,
    llmItems: 0,
    highRiskAccounts: 0,
    reviewQueue: pendingReviewCount(db),
    deepScans: 0,
    autoBlocked: 0,
    simulatedBlocks: 0,
    tokensIn: budget.tokensIn,
    tokensOut: budget.tokensOut,
    costUsd: budget.costUsd,
  };
  const dayWindow = dayRange(day, cfg.timezone);
  const runs = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(posts),0) AS posts, COALESCE(SUM(llm_items),0) AS llm_items,
              COALESCE(SUM(local_only),0) AS local_only, COALESCE(SUM(blocked),0) AS blocks,
              COALESCE(SUM(simulated),0) AS simulated
         FROM runs WHERE started_at >= ? AND started_at < ?`,
    )
    .get(dayWindow.from, dayWindow.to) as Record<string, number>;
  stats.postsScanned = Number(runs.posts ?? 0);
  stats.llmItems = Number(runs.llm_items ?? 0);
  stats.localFiltered = Number(runs.local_only ?? 0);
  stats.autoBlocked = Number(runs.blocks ?? 0);
  stats.simulatedBlocks = Number(runs.simulated ?? 0);
  stats.deepScans = Number(
    (db
      .prepare("SELECT COUNT(DISTINCT json_extract(detail, '$.user')) AS n FROM scan_log WHERE event = 'deepscan_done' AND ts >= ? AND ts < ?")
      .get(dayWindow.from, dayWindow.to) as { n: number })?.n ?? 0,
  );

  const ranked: UserRisk[] = rankedUsers(db, 10, 40).map((u) => {
    const comps = db
      .prepare("SELECT components_json FROM risk_history WHERE user_id = ? ORDER BY day DESC LIMIT 1")
      .get(u.id) as { components_json: string } | undefined;
    let components: UserRisk["components"] = [];
    try {
      components = comps?.components_json ? (JSON.parse(comps.components_json) as UserRisk["components"]) : [];
    } catch {
      components = [];
    }
    const kinds = [...new Set(components.map((c) => c.kind))];
    const independent = kinds.filter((k) => cfg.actions.banEligibleKinds.includes(k));
    stats.highRiskAccounts += Number(u.risk_score >= cfg.thresholds.banMinSpamScore);
    return {
      userId: u.id,
      handle: u.handle,
      riskScore: Number(u.risk_score),
      previousRiskScore: previousDayScore(db, cfg, u.id, day) ?? Number(u.last_risk_score ?? 0),
      delta: Number((Number(u.risk_score) - (previousDayScore(db, cfg, u.id, day) ?? 0)).toFixed(1)),
      components,
      tier: (u.tier as UserRisk["tier"]) ?? "observe",
      whitelisted: Boolean(u.whitelisted),
      banState: (u.ban_state as UserRisk["banState"]) ?? "none",
      firstSeen: u.first_seen,
      lastSeen: u.last_seen,
      evidenceKinds: kinds,
      independentSpamKinds: independent,
    };
  });

  const anomalies: string[] = [];
  const cache = cacheStats(db);
  anomalies.push(`LLM 缓存 ${cache.entries} 条，命中 ${cache.hits} 次`);
  const errors = db
    .prepare("SELECT event, COUNT(*) AS n FROM scan_log WHERE level IN ('warn','error') AND ts >= ? AND ts < ? GROUP BY event ORDER BY n DESC LIMIT 8")
    .all(dayWindow.from, dayWindow.to) as Array<{ event: string; n: number }>;
  for (const e of errors) anomalies.push(`${e.event} × ${e.n}`);
  const revokes = db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE status = 'revoked'").get() as { n: number };
  if (Number(revokes.n)) anomalies.push(`人工纠错撤销过 ${revokes.n} 组证据`);

  return { date: day, stats, ranked, anomalies, mode: cfg.mode };
}

export function renderDaily(d: DailyReportData, cfg: Config): string {
  const s = d.stats;
  const lines: string[] = [];
  lines.push(`# X Reply Sentinel 风险权重日报 · ${d.date}`);
  lines.push("");
  lines.push(`运行模式：**${d.mode}**（${d.mode === "auto" ? "满足闸门条件时会真实拉黑" : "只记录，不改动账号关系"}）`);
  lines.push("");
  lines.push("## 一、量与成本");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("|---|---:|");
  lines.push(`| 扫描帖子 | ${s.postsScanned} |`);
  lines.push(`| 新增回复 | ${s.repliesNew} |`);
  lines.push(`| 零 Token 本地过滤 | ${s.localFiltered} |`);
  lines.push(`| 进入模型判定 | ${s.llmItems}（${s.llmCalls} 次调用） |`);
  lines.push(`| Token | 入 ${s.tokensIn} / 出 ${s.tokensOut} |`);
  lines.push(`| 估算成本 | $${s.costUsd.toFixed(4)} / 上限 $${cfg.llm.maxCostPerDayUsd} |`);
  lines.push(`| 深度扫描账号 | ${s.deepScans} / 上限 ${cfg.thresholds.deepScanMaxAccountsPerDay} |`);
  lines.push(`| 人工审核队列 | ${s.reviewQueue} |`);
  lines.push(`| 处置动作 | 真实 ${s.autoBlocked} · 模拟 ${s.simulatedBlocks} |`);
  const localShare = s.repliesNew ? pct((s.repliesNew - s.llmItems) / s.repliesNew) : "—";
  lines.push(`| 未花 Token 的回复占比 | ${localShare} |`);

  lines.push("");
  lines.push("## 二、风险权重排序");
  lines.push("");
  if (!d.ranked.length) {
    lines.push("（今日没有风险分 ≥10 的账号）");
  } else {
    lines.push("| # | 账号 | 风险分 | 较昨日 | 分层 | 证据构成 | 独立垃圾信号 | 处置状态 |");
    lines.push("|---:|---|---:|---:|---|---|---|---|");
    d.ranked.forEach((u, i) => {
      const comp = u.components
        .slice(0, 4)
        .map((c) => `${c.kind}(${c.contribution.toFixed(1)})`)
        .join(" ");
      lines.push(
        `| ${i + 1} | @${u.handle} | ${u.riskScore.toFixed(1)} | ${u.delta >= 0 ? "+" : ""}${u.delta.toFixed(1)} | ${TIER_LABEL[u.tier]} | ${comp || "—"} | ${u.independentSpamKinds.length} | ${u.whitelisted ? "白名单" : u.banState === "blocked" ? "已拉黑" : "未处置"} |`,
      );
    });
    lines.push("");
    lines.push("风险分 = 各类证据按衰减、置信度与单类上限累加，超过阈值的组合才可能触发处置。");
  }

  lines.push("");
  lines.push("## 三、异常与备注");
  lines.push("");
  for (const a of d.anomalies) lines.push(`- ${a}`);

  lines.push("");
  lines.push("## 四、待人工确认");
  lines.push("");
  if (!d.stats.reviewQueue) {
    lines.push("（队列为空）");
  } else {
    lines.push(`- ${d.stats.reviewQueue} 条处于 50-69 分区间，等待人工判断：\`xrs review list\``);
  }
  lines.push("");
  lines.push("---");
  lines.push("AI 风格分只用于排序与提醒；只有可核查的垃圾互动、诈骗或重复营销证据才会触发拉黑。");
  return lines.join("\n");
}

export function writeDaily(cfg: Config, d: DailyReportData): string {
  const dir = ensureReportDir(cfg);
  const file = path.join(dir, `daily-${d.date}.md`);
  fs.writeFileSync(file, renderDaily(d, cfg) + "\n", "utf8");
  return file;
}

/** Per-account evidence recap used by `xrs explain`. */
export function accountSummary(cfg: Config, db: Parameters<typeof activeEvidence>[0], userId: string): string[] {
  const rows = activeEvidence(db, userId);
  const now = new Date();
  return rows
    .map((r) => {
      const age = (now.getTime() - Date.parse(r.last_seen.includes("T") ? r.last_seen : r.last_seen.replace(" ", "T") + "Z")) / 86400000;
      return `· ${r.kind} w=${r.weight} ×${r.hit_count} conf=${r.confidence.toFixed(2)} ${Number.isFinite(age) ? `${age.toFixed(1)}天前` : ""} — ${truncate(r.detail ?? "", 140)}`;
    })
    .sort();
}
