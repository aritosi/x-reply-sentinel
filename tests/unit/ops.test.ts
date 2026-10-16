#!/usr/bin/env node
/**
 * The operating loop, offline (spec §三 自动模式 / §六 长期记忆 / §七 报告 / §九 预算).
 *
 * These are the behaviours that only surface once the tool keeps running: whether a
 * tracked post is due, whether the day's ledger stops a paid call, whether an old
 * incident fades out of a score, and whether the numbers printed in the daily report
 * trace back to rows in SQLite.
 *
 * Still no network, no model, no platform write. Evidence ages are simulated by
 * passing a later clock into the scoring functions rather than by sleeping.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { Actor } from "../../src/actions.ts";
import { dispose, evaluateGate } from "../../src/actions.ts";
import { loadConfig, loadWhitelist, type Config } from "../../src/config.ts";
import {
  activeEvidence,
  addEvidence,
  addLlmUsage,
  bumpTracked,
  checkLlmBudget,
  computeRisk,
  dueTracked,
  getBudget,
  openDb,
  recordRisk,
  revokeEvidence,
  setWhitelisted,
  trackPost,
  touchUser,
} from "../../src/db.ts";
import { collectDaily, renderDaily, renderScanReport, writeScanReport } from "../../src/report.ts";
import { blockAccount, scanPost, toEvidence } from "../../src/fetch/scan.ts";
import { dayString } from "../../src/util.ts";
import type { Evidence, ScanAccountRow, ScanSummary } from "../../src/types.ts";

let seq = 0;

function freshConfig(env: Record<string, string> = {}): Config {
  const dir = path.join("/tmp/xrs-unit", `ops-${++seq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return loadConfig({
    configPath: path.join(dir, "config.json"),
    env: { XRS_DATA_DIR: dir, XRS_PROVIDER: "fixture", XRS_LLM_ENABLED: "0", ...env },
  });
}

function scam(kind: string, key: string, weight: number): Evidence {
  return { kind: kind as Evidence["kind"], weight, key, detail: `ops ${kind}`, source: "local", confidence: 0.95 };
}

const ROOT = "1845000000000000001";
const BOT = { id: "4120000000000000108", handle: "huiyuan_666" };

function recordingActor(calls: string[]): Actor {
  return {
    block: async (userId: string) => {
      calls.push(userId);
      return { ok: true, status: "blocked" };
    },
  };
}

test("自动模式只处理到期跟踪帖，扫描后按间隔推后下次时间", () => {
  const cfg = freshConfig();
  const db = openDb(cfg);
  try {
    const later = new Date(Date.now() + 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const past = new Date(Date.now() - 60_000).toISOString().replace("T", " ").slice(0, 19);
    trackPost(db.raw, "post-due", { url: "https://x.com/i/status/post-due", nextDue: past });
    trackPost(db.raw, "post-notyet", { nextDue: later });
    trackPost(db.raw, "post-open", {});

    const due = dueTracked(db.raw).map((r) => r.post_id);
    assert.deepEqual(due.sort(), ["post-due", "post-open"], "未到期的帖子不能被反复重扫");

    bumpTracked(db.raw, "post-due", later);
    assert.ok(!dueTracked(db.raw).some((r) => r.post_id === "post-due"), "推后到期时间后本轮不再到期");
    assert.ok(dueTracked(db.raw).some((r) => r.post_id === "post-open"), "没有游标的帖子始终待扫");
  } finally {
    db.close();
  }
});

test("当日账本决定第二层还能不能花钱：调用数、Token、成本三种熔断", () => {
  const cfg = freshConfig({ XRS_LLM_ENABLED: "1" });
  const db = openDb(cfg);
  try {
    assert.deepEqual(checkLlmBudget(db.raw, cfg, 100), { ok: true, reason: null }, "空账本应当放行");

    addLlmUsage(db.raw, cfg, { calls: 1, tokensIn: 1000, tokensOut: 500, costUsd: 0.01 });
    const b = getBudget(db.raw, cfg);
    assert.equal(b.llmCalls, 1);
    assert.equal(b.tokensIn + b.tokensOut, 1500, "Token 记账必须与写入量一致");

    cfg.llm.maxCallsPerDay = 1;
    assert.equal(checkLlmBudget(db.raw, cfg, 10).reason, "daily_llm_calls");

    cfg.llm.maxCallsPerDay = 1000;
    cfg.llm.maxTokensPerDay = 1000;
    assert.equal(checkLlmBudget(db.raw, cfg, 10).reason, "daily_tokens", "已用 + 预计 超上限即停");

    cfg.llm.maxTokensPerDay = 10_000_000;
    cfg.llm.maxCostPerDayUsd = 0.005;
    assert.equal(checkLlmBudget(db.raw, cfg, 10).reason, "daily_cost");

    cfg.llm.enabled = false;
    assert.equal(checkLlmBudget(db.raw, cfg, 10).reason, "llm_disabled");
  } finally {
    db.close();
  }
});

test("证据按半衰期衰减，超过最长保留期后彻底退出账号分", () => {
  const cfg = freshConfig();
  const db = openDb(cfg);
  try {
    touchUser(db.raw, { id: "u-decay", handle: "decay" });
    // marketing_link at weight 25 sits below the per-kind cap, so decay is linear and
    // the half-life assertion is exact — a capped kind (scam_link 45) would look
    // "half-strength" one half-life later only after the cap stops binding.
    addEvidence(db.raw, "u-decay", scam("marketing_link", "k-1", 25), { postId: "p1" });
    const input = {
      userId: "u-decay",
      handle: "decay",
      whitelisted: false,
      banState: "none",
      firstSeen: "2026-10-16 00:00:00",
      lastSeen: "2026-10-16 00:00:00",
      previousScore: null,
      tier: "deep_scan" as const,
    };
    const now = new Date();
    const freshScore = computeRisk(db.raw, cfg, input, now).score;
    const halfLife = new Date(now.getTime() + cfg.risk.halfLifeDays * 86400000);
    const aged = computeRisk(db.raw, cfg, input, halfLife).score;
    const expired = computeRisk(db.raw, cfg, input, new Date(now.getTime() + cfg.risk.maxAgeDays * 86400000 + 1000)).score;

    assert.equal(freshScore, 23.8, "权重 25 × 置信 0.95 = 23.75，不受单类上限 30 截断");
    assert.ok(aged < cfg.risk.maxContributionPerKind, "半衰后仍在单类上限以内，衰减才是线性的");
    assert.ok(Math.abs(aged - freshScore / 2) < 0.6, `一个半衰期后应约为原来的一半，实得 ${aged}`);
    assert.equal(expired, 0, "超过 maxAgeDays 的证据不再计入分数");
  } finally {
    db.close();
  }
});

test("人工判清：撤销证据后账号分下降，闸门随之拒绝", () => {
  const cfg = freshConfig();
  const db = openDb(cfg);
  try {
    touchUser(db.raw, { id: "u-revoke", handle: "revoke" });
    // Each kind repeats three times (same dedup key → hit_count climbs), which is what
    // pushes three independent kinds over 85: 30 + 29.45 + 29.45 = 88.9. One hit each
    // would only reach 77.5, so the revoke below would look like it changed nothing.
    for (const [kind, weight] of [["scam_link", 45], ["marketing_link", 25], ["duplicate_content", 25]] as const) {
      for (let i = 0; i < 3; i++) addEvidence(db.raw, "u-revoke", scam(kind, `k-${kind}`, weight), { postId: `p${i}` });
    }
    const input = {
      userId: "u-revoke",
      handle: "revoke",
      whitelisted: false,
      banState: "none",
      firstSeen: "2026-10-16 00:00:00",
      lastSeen: "2026-10-16 00:00:00",
      previousScore: null,
      tier: "deep_scan" as const,
    };
    const before = recordRisk(db.raw, cfg, input);
    assert.ok(before.riskScore >= cfg.thresholds.banMinSpamScore, `三类证据应已达处置线，实得 ${before.riskScore}`);
    const beforeGate = evaluateGate(cfg, {
      risk: before,
      evidence: toEvidence(activeEvidence(db.raw, "u-revoke")),
      whitelisted: false,
      banState: "none",
      confidence: 0.95,
    });
    assert.equal(beforeGate.allowed, true, "撤销前处置条件成立");

    const revoked = revokeEvidence(db.raw, "u-revoke", "scam_link", "人工核对为正常链接");
    assert.equal(revoked, 1);
    assert.deepEqual(activeEvidence(db.raw, "u-revoke").map((r) => r.kind).sort(), ["duplicate_content", "marketing_link"]);

    const after = recordRisk(db.raw, cfg, { ...input, previousScore: before.riskScore });
    assert.ok(after.riskScore < before.riskScore, `撤销后分数必须下降：${before.riskScore} → ${after.riskScore}`);
    assert.equal(after.independentSpamKinds.length, 2, "独立信号数随证据变化");

    const gate = evaluateGate(cfg, {
      risk: after,
      evidence: toEvidence(activeEvidence(db.raw, "u-revoke")),
      whitelisted: false,
      banState: "none",
      confidence: 0.95,
    });
    assert.equal(gate.allowed, false, "撤销诈骗链接后不再满足处置条件");
    assert.ok(gate.reasons.some((r) => r.startsWith("risk_score_")), gate.reasons.join(","));
  } finally {
    db.close();
  }
});

test("白名单文件是真相源，库内标记只是它的投影", async () => {
  const cfg = freshConfig({ XRS_MODE: "auto" });
  const db = openDb(cfg);
  const calls: string[] = [];
  try {
    touchUser(db.raw, { id: "42", handle: "FriendOne" });
    // Three hits per kind so the account genuinely clears the disposal line: the only
    // thing left stopping the block has to be the whitelist, not a low score.
    for (const [kind, weight] of [["scam_link", 45], ["marketing_link", 25], ["duplicate_content", 25]] as const) {
      for (let i = 0; i < 3; i++) addEvidence(db.raw, "42", scam(kind, `wl-${kind}`, weight), { postId: `p${i}` });
    }
    fs.writeFileSync(path.join(cfg.dataDir, cfg.whitelistFile), JSON.stringify(["friendone"]), "utf8");
    assert.deepEqual(loadWhitelist(cfg), ["friendone"], "读取时统一小写去 @");
    assert.equal(setWhitelisted(db.raw, ["@FriendOne"], true), 1);

    const risk = recordRisk(db.raw, cfg, {
      userId: "42",
      handle: "friendone",
      whitelisted: true,
      banState: "none",
      firstSeen: "2026-10-16 00:00:00",
      lastSeen: "2026-10-16 00:00:00",
      previousScore: null,
      tier: "deep_scan",
    });
    const res = await blockAccount(db.raw, cfg, risk, { actor: recordingActor(calls), whitelisted: true });
    assert.ok(risk.riskScore >= cfg.thresholds.banMinSpamScore, `证据本身已达处置线，实得 ${risk.riskScore}`);
    assert.equal(res.status, "skipped");
    assert.deepEqual(res.reasons, ["whitelisted"], "拦下处置的只有白名单，不是分数不够");
    assert.deepEqual(calls, [], "白名单账号不会触达写接口");
    assert.equal((db.raw.prepare("SELECT ban_state FROM users WHERE id = ?").get("42") as { ban_state: string }).ban_state, "none");

    fs.writeFileSync(path.join(cfg.dataDir, cfg.whitelistFile), JSON.stringify([]), "utf8");
    assert.equal(loadWhitelist(cfg).length, 0);
    assert.equal(setWhitelisted(db.raw, ["friendone"], false), 1, "移除白名单要同时撤销库内标记");
  } finally {
    db.close();
  }
});

test("日报里每个数字都能回查到库内行：扫描统计与账本一致", async () => {
  const cfg = freshConfig();
  const db = openDb(cfg);
  const calls: string[] = [];
  try {
    const s = await scanPost(db.raw, cfg, { target: ROOT, actor: recordingActor(calls), noReport: true });
    assert.equal(s.repliesNew, 12, "fixture 线程共 12 条新回复");
    assert.equal(s.blockSimulated, 1, "dry-run 下只有一条满足处置条件");

    const day = dayString(new Date(), cfg.timezone);
    const d = collectDaily(cfg, db.raw, day);
    assert.equal(d.date, day);
    assert.equal(d.stats.repliesNew, 12, "日报的新增回复数应等于本轮入库数");
    assert.equal(d.stats.postsScanned, 1);
    assert.equal(d.stats.autoBlocked, 0, "dry-run 不产生真实处置");
    assert.equal(d.stats.simulatedBlocks, 1);
    assert.equal(d.stats.costUsd, 0, "离线演练成本为 0");
    assert.equal(d.stats.llmCalls, 0);
    assert.equal(d.stats.reviewQueue, 9, "未达处置线的可疑账号都进了人工队列");

    const top = d.ranked[0];
    assert.equal(top.handle, BOT.handle);
    assert.ok(top.independentSpamKinds.length >= cfg.thresholds.banMinIndependentSignals);

    const md = renderDaily(d, cfg);
    assert.ok(md.includes(day), "报告标题带当日日期");
    assert.ok(md.includes("@huiyuan_666"), "报告列出风险最高的账号");
    assert.ok(md.includes("$0.0000"), "成本行存在");
    assert.ok(!md.includes("undefined") && !md.includes("NaN"), "报告不含未定义值");

    const scanMd = renderScanReport(s, cfg.timezone);
    assert.ok(scanMd.includes("第二层未调用") || scanMd.includes("模型判定 0 条"), "报告要写清第二层是否参与");
    assert.ok(scanMd.includes("仅有 AI 风格证据"), "报告要保留拒绝处置的理由");
    assert.ok(!scanMd.includes("undefined") && !scanMd.includes("NaN"), "扫描报告不含未定义值");

    const file = writeScanReport(cfg, s);
    assert.ok(fs.existsSync(file), `报告文件应落盘：${file}`);
    assert.ok(fs.readFileSync(file, "utf8").includes("# 扫描报告"));
  } finally {
    db.close();
  }
});

test("处置失败与模拟都不会把账号标成已拉黑", async () => {
  const cfg = freshConfig({ XRS_MODE: "auto" });
  const db = openDb(cfg);
  const calls: string[] = [];
  try {
    const actor: Actor = {
      block: async (userId: string) => {
        calls.push(userId);
        return { ok: false, status: "failed", detail: "平台返回 500" };
      },
    };
    const s = await scanPost(db.raw, cfg, { target: ROOT, actor, noReport: true });
    assert.deepEqual(calls, [BOT.id], "auto 模式确实尝试了一次写操作");
    assert.equal(s.blocked, 0, "写失败不能记成拉黑");
    const row = db.raw.prepare("SELECT ban_state FROM users WHERE id = ?").get(BOT.id) as { ban_state: string };
    assert.equal(row.ban_state, "none", "失败的处置不得留下已拉黑状态");

    const actions = db.raw.prepare("SELECT status FROM actions WHERE user_id = ?").all(BOT.id) as Array<{ status: string }>;
    assert.ok(actions.length > 0, "失败的处置同样要进审计");
    assert.ok(actions.every((a) => a.status !== "blocked"));
  } finally {
    db.close();
  }
});

test("平台报错里带的凭证不会进入审计文件与账本", async () => {
  const cfg = freshConfig({ XRS_MODE: "auto" });
  const db = openDb(cfg);
  // A realistic leak: the provider echoes the Authorization header it was rejected with.
  const SECRET = "AAABbbCCCdddEEEfff1122334455-token-value";
  try {
    touchUser(db.raw, { id: "u-secret", handle: "secret" });
    for (const [kind, weight] of [["scam_link", 45], ["marketing_link", 25], ["duplicate_content", 25]] as const) {
      for (let i = 0; i < 3; i++) addEvidence(db.raw, "u-secret", scam(kind, `sec-${kind}`, weight), { postId: `p${i}` });
    }
    const risk = recordRisk(db.raw, cfg, {
      userId: "u-secret",
      handle: "secret",
      whitelisted: false,
      banState: "none",
      firstSeen: "2026-10-16 00:00:00",
      lastSeen: "2026-10-16 00:00:00",
      previousScore: null,
      tier: "deep_scan",
    });
    const ledger = toEvidence(activeEvidence(db.raw, "u-secret"));
    const gate = evaluateGate(cfg, { risk, evidence: ledger, whitelisted: false, banState: "none", confidence: 0.95 });
    assert.equal(gate.allowed, true, "闸门放行，才会真的调用写接口");

    const actor: Actor = {
      block: async () => {
        throw new Error(`401 Unauthorized — Authorization: Bearer ${SECRET}`);
      },
    };
    const res = await dispose(db.raw, cfg, { userId: "u-secret", handle: "secret", action: "block", gate, risk, evidence: ledger }, actor);
    assert.equal(res.status, "failed", "抛错的处置记为失败");

    const auditFile = path.join(cfg.dataDir, cfg.auditLog);
    assert.ok(fs.existsSync(auditFile), "失败的处置同样要落审计 JSONL");
    const auditText = fs.readFileSync(auditFile, "utf8");
    const stored = db.raw
      .prepare("SELECT reason FROM actions WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .get("u-secret") as { reason: string | null };

    assert.ok(!auditText.includes(SECRET), "审计文件不得留下凭证");
    assert.ok(!(stored.reason ?? "").includes(SECRET), "账本 reason 不得留下凭证");
    assert.ok(auditText.includes("[redacted]"), "要证明是脱敏起了作用，不是消息被整条丢掉");
    assert.ok(auditText.includes("failed"), "但仍能看出发生过一次失败的处置");
  } finally {
    db.close();
  }
});

/** A summary carrying only what the renderer reads, so the assertion targets the renderer. */
function summaryWith(over: Partial<ScanSummary>): ScanSummary {
  return {
    runId: 1,
    postId: "1845000000000000009",
    postUrl: "https://x.com/i/status/1845000000000000009",
    rootText: "原帖正文",
    provider: "fixture",
    rootFound: true,
    repliesAccessible: true,
    notes: [],
    repliesFetched: 1,
    repliesNew: 1,
    repliesSeenAgain: 0,
    localOnly: 1,
    llmCalls: 0,
    llmItems: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    tierCounts: { observe: 1, review: 0, deep_scan: 0 },
    blocked: 0,
    blockSimulated: 0,
    blockSkipped: 0,
    errors: [],
    budgetHalted: null,
    accounts: [],
    startedAt: new Date().toISOString(),
    durationMs: 12,
    ...over,
  };
}

function rowWith(over: Partial<ScanAccountRow>): ScanAccountRow {
  return {
    userId: "u-render",
    handle: "render",
    commentId: "c-1",
    text: "",
    aiStyleScore: 10,
    localStyleScore: 10,
    llmStyleScore: null,
    spamRiskScore: 20,
    accountRisk: 20,
    confidence: 0.5,
    tier: "observe",
    evidenceKinds: [],
    evidenceDetail: [],
    action: "recorded",
    reasons: [],
    deepScanFindings: [],
    ...over,
  };
}

test("报告只脱敏工具生成的文本，回复原文与证据链接保持原样", () => {
  const cfg = freshConfig();
  const SECRET = "AAABbbCCCdddEEEfff1122334455-token-value";
  const LINK = "https://example.com/a/AAAAAAAAAAAAAAAAAAAA";
  const s = summaryWith({
    notes: ["第二层未调用（missing_XRS_LLM_API_KEY），本轮只用本地规则分数"],
    errors: [`fetch 401 — Authorization: Bearer ${SECRET}`],
    accounts: [
      rowWith({
        tier: "deep_scan",
        action: "deep_skipped",
        text: `点击查看 ${LINK} 领取空投`,
        evidenceDetail: [`marketing_link: ${LINK}`],
        deepScanFindings: ["profile 拉取失败 — ct0=abcdefghijklmn0123456789"],
        reasons: ["risk_score_77.5"],
      }),
    ],
  });
  const md = renderScanReport(s, cfg.timezone);
  assert.ok(!md.includes(SECRET), "错误行里的凭证必须被抹掉");
  assert.ok(!md.includes("ct0=abcdefghijklmn0123456789"), "深扫失败信息里的 cookie 值同样要抹掉");
  assert.ok(md.includes("[redacted]"), "证明是脱敏生效，而不是整行没渲染");
  assert.ok(md.includes(LINK), "营销链接是证据本身，报告里必须保持原样");
  assert.ok(md.includes("missing_XRS_LLM_API_KEY"), "备注行照常渲染");
  assert.ok(md.includes("risk_score_77.5"), "拒绝处置的原因要能回查");
});
