#!/usr/bin/env node
/**
 * The scan pipeline end to end, offline (spec §三 / §五 / §六 / §十二).
 *
 * Runs the real scanner against fixtures/demo-thread.json — a thread with three
 * genuine replies, four AI-style replies and one scam account posting the same
 * message three times — and asserts who gets acted on and who does not. The
 * transport is the fixture provider, so nothing here can reach the platform, and
 * the only "write" is a stub actor that records what it was asked to do.
 *
 * Layer 2 stays off (XRS_LLM_ENABLED=0): these tests cover routing and the ledger,
 * and the zero-token path is the one that has to work with no key present.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { Actor } from "../../src/actions.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import {
  actionsToday,
  addEvidence,
  commentExists,
  decideReview,
  enqueueReview,
  getCursor,
  getUserRow,
  insertCommentIfNew,
  openDb,
  pendingReview,
  pendingReviewCount,
  recordRisk,
  setCursor,
  touchUser,
} from "../../src/db.ts";
import { tierFor } from "../../src/detect/engine.ts";
import { blockAccount, scanPost } from "../../src/fetch/scan.ts";
import type { Evidence } from "../../src/types.ts";

let seq = 0;

function freshConfig(env: Record<string, string> = {}): Config {
  const dir = path.join("/tmp/xrs-unit", `scan-${++seq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return loadConfig({
    configPath: path.join(dir, "config.json"),
    env: { XRS_DATA_DIR: dir, XRS_PROVIDER: "fixture", XRS_LLM_ENABLED: "0", ...env },
  });
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

test("auto 模式：只有重复发诈骗话术的账号被拉黑，AI 风格账号一个都不碰", async () => {
  const cfg = freshConfig({ XRS_MODE: "auto" });
  const handle = openDb(cfg);
  const calls: string[] = [];
  const s = await scanPost(handle.raw, cfg, { target: ROOT, actor: recordingActor(calls), noReport: true });

  assert.equal(s.rootFound, true);
  assert.equal(s.repliesFetched, 12, "fixture 的 12 条回复应全部进入检测");
  assert.deepEqual(calls, [BOT.id], "本轮唯一该被拉黑的是重复诈骗账号");
  assert.equal(s.blocked, 1);
  assert.equal(s.blockSimulated, 0);
  assert.equal(s.llmItems, 0, "第二层未开启时不应有语义判定");
  assert.equal(s.costUsd, 0, "离线演练必须零 Token");

  const byHandle = new Map(s.accounts.map((a) => [a.handle, a]));

  for (const h of ["achen_tea", "danaruns", "laozhou_shu"]) {
    assert.equal(byHandle.get(h)!.tier, "observe", `${h} 不该被升级`);
    assert.equal(byHandle.get(h)!.action, "recorded");
  }

  // High AI style, no verifiable spam: visible, never disposed.
  for (const h of ["amara_notes", "victor_growth", "qing_reader", "marcus_builds"]) {
    const a = byHandle.get(h)!;
    assert.ok(a.aiStyleScore >= cfg.thresholds.reviewMin, `${h} 要成立，风格分本身必须不低（实际 ${a.aiStyleScore}）`);
    assert.ok(!["blocked", "simulated"].includes(a.action), `${h} 被处置了：${a.action}`);
    assert.ok(a.reasons.some((r) => r.includes("仅有 AI 风格证据")), `${h}：${a.reasons.join("；")}`);
  }

  // The bot crossed the line through repetition, and the report says which numbers.
  const bot = byHandle.get(BOT.handle)!;
  assert.ok(bot.accountRisk >= cfg.thresholds.banMinSpamScore, `账号风险应 ≥${cfg.thresholds.banMinSpamScore}，实际 ${bot.accountRisk}`);
  assert.ok(bot.reasons.some((r) => r.includes("满足处置条件")), bot.reasons.join("；"));
  assert.equal(getUserRow(handle.raw, BOT.id)?.ban_state, "blocked");

  // Second pass, no --force: everything is already stored, so nothing is re-decided.
  const second = await scanPost(handle.raw, cfg, { target: ROOT, actor: recordingActor(calls), noReport: true });
  assert.equal(second.repliesNew, 0);
  assert.equal(second.repliesSeenAgain, 12);
  assert.equal(second.blocked, 0);
  assert.equal(second.notes.some((n) => n.includes("重新检测")), false, "普通续扫不该重复检测");
  assert.equal(calls.length, 1, "断点续扫不能把同一次处置再做一遍");

  // --force re-walks the thread; the account is already blocked, so the gate refuses.
  const forced = await scanPost(handle.raw, cfg, { target: ROOT, actor: recordingActor(calls), noReport: true, force: true });
  assert.equal(forced.repliesNew, 0, "重检的不是新回复");
  assert.ok(forced.notes.some((n) => n.includes("重新检测 12 条")), forced.notes.join("；"));
  assert.equal(calls.length, 1, "已拉黑的账号不该再写一次");
  const again = new Map(forced.accounts.map((a) => [a.handle, a])).get(BOT.handle)!;
  assert.equal(again.action, "skipped");
  assert.ok(again.reasons.includes("already_blocked"), again.reasons.join("；"));

  handle.close();
});

test("dry-run：满足处置条件也只记模拟，绝不调用平台写接口", async () => {
  const cfg = freshConfig({ XRS_MODE: "dry-run" });
  const handle = openDb(cfg);
  const calls: string[] = [];
  const s = await scanPost(handle.raw, cfg, { target: ROOT, actor: recordingActor(calls), noReport: true });
  assert.equal(s.blocked, 0);
  assert.equal(s.blockSimulated, 1, "报告要写明这一条本来会被拉黑");
  assert.deepEqual(calls, []);
  assert.equal(getUserRow(handle.raw, BOT.id)?.ban_state, "none");
  assert.equal(actionsToday(handle.raw, cfg, "block"), 0, "模拟不占用每日处置额度");
  const bot = new Map(s.accounts.map((a) => [a.handle, a])).get(BOT.handle)!;
  assert.equal(bot.action, "simulated");
  assert.ok(bot.reasons.some((r) => r.includes("仅记录不执行")), bot.reasons.join("；"));
  assert.ok(pendingReviewCount(handle.raw) > 0, "人工审核队列应有待处理条目");
  handle.close();
});

test("分层阈值按 70/50 切，边界值归属明确", () => {
  const cfg = freshConfig();
  assert.equal(tierFor(49, cfg), "observe");
  assert.equal(tierFor(50, cfg), "review");
  assert.equal(tierFor(69, cfg), "review");
  assert.equal(tierFor(70, cfg), "deep_scan");
  assert.equal(cfg.thresholds.reviewMin, 50);
  assert.equal(cfg.thresholds.deepScanMin, 70);
});

test("断点游标与幂等写入：同一回复重复入库只算一条", () => {
  const cfg = freshConfig();
  const handle = openDb(cfg);
  const db = handle.raw;
  touchUser(db, { id: "u1", handle: "One" });
  assert.equal(insertCommentIfNew(db, { id: "c1", postId: "p1", userId: "u1", handle: "one", text: "第一条" }), true);
  assert.equal(insertCommentIfNew(db, { id: "c1", postId: "p1", userId: "u1", handle: "one", text: "第一条" }), false);
  assert.equal(commentExists(db, "c1"), true);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n, 1);

  setCursor(db, "p1", "replies", "cursor-abc", false);
  const mid = getCursor(db, "p1", "replies");
  assert.equal(mid.cursor, "cursor-abc");
  assert.equal(mid.complete, false, "未扫完时游标必须留在断点");
  setCursor(db, "p1", "replies", null, true);
  const done = getCursor(db, "p1", "replies");
  assert.equal(done.cursor, null);
  assert.equal(done.complete, true, "扫到末尾要落盘，下一轮从头看新回复");

  handle.close();
});

test("人工审核队列：不重复入队，人工判决后出队", () => {
  const cfg = freshConfig();
  const handle = openDb(cfg);
  const db = handle.raw;
  touchUser(db, { id: "u1", handle: "one" });
  touchUser(db, { id: "u2", handle: "two" });
  insertCommentIfNew(db, { id: "c1", postId: "p1", userId: "u1", handle: "one", text: "A" });
  insertCommentIfNew(db, { id: "c2", postId: "p1", userId: "u2", handle: "two", text: "B" });
  enqueueReview(db, "u1", "c1", "p1");
  enqueueReview(db, "u1", "c1", "p1");
  enqueueReview(db, "u2", "c2", "p1");
  assert.equal(pendingReviewCount(db), 2);

  const row = pendingReview(db, 10).find((r) => r.user_id === "u1")!;
  decideReview(db, row.id, "clear", "人工确认是真人");
  assert.equal(pendingReviewCount(db), 1);
  assert.equal(pendingReview(db, 10).some((r) => r.user_id === "u1"), false);

  handle.close();
});

test("blockAccount 是唯一处置入口：只有风格证据的账本连处置环节都不进", async () => {
  const cfg = freshConfig({ XRS_MODE: "auto" });
  const handle = openDb(cfg);
  const db = handle.raw;
  touchUser(db, { id: "u-style", handle: "styler" });
  const style: Evidence[] = [
    { kind: "lexicon_slop", weight: 40, key: "lexicon_slop:a", detail: "术语密度", source: "local", confidence: 0.95 },
    { kind: "template_structure", weight: 40, key: "template_structure:a", detail: "模板结构", source: "local", confidence: 0.95 },
    { kind: "llm_semantic", weight: 40, key: "llm_semantic:a", detail: "模型判定", source: "llm", confidence: 0.95 },
  ];
  for (const e of style) addEvidence(db, "u-style", e, { commentId: "c1", postId: "p1" });
  const risk = recordRisk(db, cfg, {
    userId: "u-style",
    handle: "styler",
    whitelisted: false,
    banState: "none",
    firstSeen: "2026-10-16 00:00:00",
    lastSeen: "2026-10-16 00:00:00",
    previousScore: null,
    tier: "deep_scan",
  });
  assert.ok(risk.riskScore >= cfg.thresholds.banMinSpamScore, `风格分要打满：实际 ${risk.riskScore}`);

  const calls: string[] = [];
  const res = await blockAccount(db, cfg, risk, { actor: recordingActor(calls) });
  assert.equal(res.attempted, false);
  assert.equal(res.ok, false);
  assert.equal(res.status, "no_verifiable_evidence");
  assert.deepEqual(res.reasons, ["style_only_evidence"]);
  assert.deepEqual(calls, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0, "风格证据不进审计动作表");

  handle.close();
});

test("深度扫描没读到内容时不占用 7 天冷却，下一轮仍然重试", async () => {
  const cfg = freshConfig();
  const handle = openDb(cfg);
  const db = handle.raw;
  try {
    const first = await scanPost(db, cfg, { target: ROOT, noReport: true });
    // The fixture transport cannot read a profile, so every deep-scan tier account in
    // this run comes back "未执行" rather than with a result.
    const skipped = first.accounts.filter((a) => a.reasons.some((r) => r.includes("深度扫描未执行")));
    assert.ok(skipped.length > 0, "本轮应有一次未执行的深度扫描");
    for (const a of skipped) {
      assert.equal(getUserRow(db, a.userId)?.deep_scanned_at, null, `@${a.handle}：没读到东西不该记成已深扫`);
    }

    const second = await scanPost(db, cfg, { target: ROOT, noReport: true, force: true });
    for (const a of skipped) {
      const again = second.accounts.find((r) => r.userId === a.userId);
      assert.ok(again, `@${a.handle} 第二轮仍在`);
      assert.ok(
        again.reasons.some((r) => r.includes("深度扫描未执行")),
        `@${a.handle}：第二轮要重试，而不是被冷却挡下：${again.reasons.join("；")}`,
      );
      assert.ok(!again.reasons.some((r) => r.includes("天内深度扫描过")), `@${a.handle} 不该进入冷却`);
    }
  } finally {
    handle.close();
  }
});
