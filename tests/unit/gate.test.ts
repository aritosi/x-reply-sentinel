#!/usr/bin/env node
/**
 * The disposal contract (spec §五 / §八 / §十二).
 *
 * These tests exist for one sentence of the requirement:
 *   只有发现明确、可核查的垃圾互动、诈骗或重复营销证据，满足高风险处置规则后，
 *   才允许自动拉黑。单纯 AI 风格明显，不得自动拉黑。
 *
 * Everything runs against a throwaway SQLite file and a stub actor, so the
 * platform is never touched. The stub also proves the negative: in dry-run the
 * actor must not be called at all.
 *
 * The numbers are the same ledger math the scanner runs in production, so a
 * change to a weight or a threshold shows up here instead of in a live thread.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { dispose, evaluateGate, throttle, type Actor, type GateResult } from "../../src/actions.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import {
  actionsToday,
  addEvidence,
  computeRisk,
  getUserRow,
  lastActionAt,
  openDb,
  recordRisk,
  setWhitelisted,
  touchUser,
} from "../../src/db.ts";
import type { Evidence, UserRisk } from "../../src/types.ts";

let seq = 0;

/** An isolated data dir with no config.json, so nothing outside /tmp is read. */
function freshConfig(env: Record<string, string> = {}): Config {
  const dir = path.join("/tmp/xrs-unit", `case-${++seq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return loadConfig({
    configPath: path.join(dir, "config.json"),
    env: { XRS_DATA_DIR: dir, XRS_LLM_ENABLED: "0", ...env },
  });
}

function botEvidence(): Evidence[] {
  // Three *independent*, verifiable spam signals: the shape the gate is built for.
  return [
    { kind: "scam_link", weight: 45, key: "scam_link:free-money", detail: "诈骗话术：免费领", source: "local", confidence: 0.95 },
    { kind: "marketing_link", weight: 25, key: "marketing_link:example", detail: "导流外链", source: "local", confidence: 0.95 },
    { kind: "duplicate_content", weight: 25, key: "duplicate_content:hash", detail: "与既有回复相似度 1.00", source: "local", confidence: 0.95 },
  ];
}

function styleEvidence(): Evidence[] {
  // The highest style weights the local engine can produce — still never ban-eligible.
  return [
    { kind: "lexicon_slop", weight: 30, key: "lexicon_slop:v1", detail: "术语密度", source: "local", confidence: 0.95 },
    { kind: "template_structure", weight: 30, key: "template_structure:v1", detail: "模板结构", source: "local", confidence: 0.95 },
    { kind: "llm_semantic", weight: 30, key: "llm_semantic:v1", detail: "模型判定为 AI 生成", source: "llm", confidence: 0.95 },
  ];
}

interface Seeded {
  db: DatabaseSync;
  cfg: Config;
  risk: UserRisk;
  close(): void;
}

/**
 * A user with a real ledger. `hits` repeats the same evidence key, which is what
 * the scanner does when one account posts the same scam in several replies — the
 * dedup rule means repetition raises the score through the repeat bonus, never by
 * writing a second row.
 */
function seed(userId: string, evidence: Evidence[], env: Record<string, string> = {}, hits = 1): Seeded {
  const cfg = freshConfig(env);
  const handle = openDb(cfg);
  touchUser(handle.raw, { id: userId, handle: "spammer" });
  for (let i = 0; i < hits; i++) {
    for (const e of evidence) addEvidence(handle.raw, userId, e, { commentId: `c${i}`, postId: "p1" });
  }
  const risk = recordRisk(handle.raw, cfg, {
    userId,
    handle: "spammer",
    whitelisted: false,
    banState: "none",
    firstSeen: "2026-10-16 00:00:00",
    lastSeen: "2026-10-16 00:00:00",
    previousScore: null,
    tier: "deep_scan",
  });
  return { db: handle.raw, cfg, risk, close: handle.close };
}

function gateFor(cfg: Config, risk: UserRisk, evidence: Evidence[], over: Partial<{ whitelisted: boolean; banState: string; confidence: number }> = {}): GateResult {
  return evaluateGate(cfg, {
    risk,
    evidence,
    whitelisted: over.whitelisted ?? false,
    banState: over.banState ?? "none",
    confidence: over.confidence ?? Math.max(...evidence.map((e) => e.confidence)),
  });
}

function banState(db: DatabaseSync, userId: string): string {
  return getUserRow(db, userId)?.ban_state ?? "none";
}

function blockingActor(seen: string[]): Actor {
  return {
    block: async (userId: string) => {
      seen.push(userId);
      return { ok: true, status: "blocked" };
    },
  };
}

test("AI 风格证据永远不构成处置依据，哪怕每一类都打满", async () => {
  const s = seed("u-style", styleEvidence());
  const styleOnly = styleEvidence();
  const gate = gateFor(s.cfg, s.risk, styleOnly);
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.includes("style_only_evidence"), gate.reasons.join(","));
  assert.equal(gate.eligibleKinds.length, 0);
  assert.ok(s.risk.riskScore >= s.cfg.thresholds.banMinSpamScore, "这一条要成立，风格分本身必须已经很高");

  const calls: string[] = [];
  const out = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: styleOnly }, blockingActor(calls));
  assert.equal(out.status, "skipped");
  assert.equal(out.ok, false);
  assert.deepEqual(calls, [], "风格分再高也不能调用平台写接口");
  assert.equal(banState(s.db, s.risk.userId), "none");
  s.close();
});

test("三类可核查信号只出现一次时风险不足 85，处置被拒并说明差多少", () => {
  const s = seed("u-once", botEvidence());
  const gate = gateFor(s.cfg, s.risk, botEvidence());
  assert.equal(s.risk.riskScore, 77.5);
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.includes("risk_score_77.5"), gate.reasons.join(","));
  assert.ok(gate.detail.some((d) => d.includes("要求 ≥85")), gate.detail.join("；"));
  s.close();
});

test("同一份垃圾证据反复出现（重复营销）才把风险推过阈值，dry-run 记为 simulated 且不调用写接口", async () => {
  const s = seed("u-bot", botEvidence(), { XRS_MODE: "dry-run" }, 3);
  const ev = botEvidence();
  const gate = gateFor(s.cfg, s.risk, ev);
  assert.ok(s.risk.riskScore >= s.cfg.thresholds.banMinSpamScore, `风险应 ≥85，实际 ${s.risk.riskScore}`);
  assert.equal(gate.allowed, true, `闸门应放行：${gate.reasons.join(",")}`);
  assert.equal(gate.modeBlocked, true);
  assert.equal(gate.eligibleKinds.length, 3);

  const calls: string[] = [];
  const out = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: ev }, blockingActor(calls));
  assert.equal(out.status, "simulated");
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [], "dry-run 绝不能调用平台写接口");
  assert.equal(banState(s.db, s.risk.userId), "none");
  assert.equal(actionsToday(s.db, s.cfg, "block"), 0, "模拟不是真实动作，不占用每日额度");
  assert.equal(lastActionAt(s.db, "block"), null, "模拟不构成节奏事件");
  s.close();
});

test("auto 模式 + 有写能力的 actor 才会真的拉黑", async () => {
  const s = seed("u-auto", botEvidence(), { XRS_MODE: "auto" }, 3);
  const ev = botEvidence();
  const gate = gateFor(s.cfg, s.risk, ev);
  assert.equal(gate.allowed, true);
  assert.equal(gate.modeBlocked, false);

  const calls: string[] = [];
  const out = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: ev }, blockingActor(calls));
  assert.equal(out.status, "blocked");
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [s.risk.userId]);
  assert.equal(banState(s.db, s.risk.userId), "blocked");
  assert.equal(actionsToday(s.db, s.cfg, "block"), 1);
  s.close();
});

test("provider 没有写能力时只记录，不把它算成失败", async () => {
  const s = seed("u-nocap", botEvidence(), { XRS_MODE: "auto" }, 3);
  const ev = botEvidence();
  const gate = gateFor(s.cfg, s.risk, ev);
  const out = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: ev }, {});
  assert.equal(out.status, "simulated");
  assert.equal(out.ok, true);
  assert.equal(banState(s.db, s.risk.userId), "none");
  s.close();
});

test("节奏限制：真实动作之后，最小间隔与每小时上限都会拦下下一次处置", async () => {
  const s = seed("u-pace", botEvidence(), { XRS_MODE: "auto" }, 3);
  const ev = botEvidence();
  const gate = gateFor(s.cfg, s.risk, ev);
  const actor = blockingActor([]);
  const first = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: ev }, actor);
  assert.equal(first.status, "blocked");

  // The default window is 90s + jitter, which is far longer than this test runs,
  // so the pacing rule is checked on throttle() rather than by waiting it out.
  const t = throttle(s.cfg, s.db);
  assert.equal(t.ok, false);
  assert.ok(t.reason?.startsWith("min_interval"), String(t.reason));
  assert.ok(t.waitMs > 0);

  // dispose() honours the same limiter: with the hourly cap already met it records
  // a refusal instead of writing again (and does not wait, since waitMs is 0).
  s.cfg.actions.maxPerHour = 1;
  const second = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: ev }, actor);
  assert.equal(second.status, "skipped");
  assert.ok(second.reasons.some((r) => r.startsWith("hourly_action_cap")), second.reasons.join(","));
  assert.equal(actionsToday(s.db, s.cfg, "block"), 1, "被限流的第二次不是真实动作");
  s.close();
});

test("白名单与已拉黑状态都不会再次处置", async () => {
  const s = seed("u-white", botEvidence(), { XRS_MODE: "auto" }, 3);
  const ev = botEvidence();
  setWhitelisted(s.db, [s.risk.userId], true);
  const w = gateFor(s.cfg, s.risk, ev, { whitelisted: true });
  assert.equal(w.allowed, false);
  assert.ok(w.reasons.includes("whitelisted"));

  const b = gateFor(s.cfg, s.risk, ev, { banState: "blocked" });
  assert.equal(b.allowed, false);
  assert.ok(b.reasons.includes("already_blocked"));

  const calls: string[] = [];
  const out = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate: w, risk: s.risk, evidence: ev }, blockingActor(calls));
  assert.equal(out.status, "skipped");
  assert.deepEqual(calls, []);
  s.close();
});

test("闸门只看证据置信，不看单条回复的风格置信", () => {
  const s = seed("u-conf", botEvidence(), {}, 3);
  const weak = gateFor(s.cfg, s.risk, botEvidence(), { confidence: 0.5 });
  assert.equal(weak.allowed, false);
  assert.ok(weak.reasons.some((r) => r.startsWith("confidence_")), weak.reasons.join(","));
  s.close();
});

test("独立信号不足两类时即使风险很高也不处置", () => {
  const one = [{ kind: "scam_link", weight: 45, key: "scam_link:only", detail: "诈骗话术", source: "local", confidence: 0.95 }] as Evidence[];
  const s = seed("u-single", one, {}, 5);
  const gate = gateFor(s.cfg, s.risk, one);
  assert.ok(s.risk.riskScore > 0);
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.includes("independent_signals_1"), gate.reasons.join(","));
  s.close();
});

test("computeRisk 对同一份证据可复现，且单类证据有上限", () => {
  const s = seed("u-math", botEvidence(), {}, 3);
  const again = computeRisk(s.db, s.cfg, {
    userId: s.risk.userId,
    handle: s.risk.handle,
    whitelisted: false,
    banState: "none",
    firstSeen: "2026-10-16 00:00:00",
    lastSeen: "2026-10-16 00:00:00",
    previousScore: s.risk.riskScore,
    tier: "deep_scan",
  });
  assert.equal(again.score, s.risk.riskScore);
  assert.equal(again.independentSpamKinds.length, 3);
  for (const c of again.components) {
    assert.ok(c.contribution <= s.cfg.risk.maxContributionPerKind + 1e-9, `${c.kind} 超过单类上限 ${s.cfg.risk.maxContributionPerKind}`);
  }
  s.close();
});

test("throttle 的每日额度只统计真实动作，超了就停", async () => {
  const s = seed("u-cap", botEvidence(), { XRS_MODE: "auto", XRS_MAX_BLOCKS_PER_DAY: "1" }, 3);
  const ev = botEvidence();
  const gate = gateFor(s.cfg, s.risk, ev);
  const actor = blockingActor([]);
  const first = await dispose(s.db, s.cfg, { userId: s.risk.userId, handle: s.risk.handle, action: "block", gate, risk: s.risk, evidence: ev }, actor);
  assert.equal(first.status, "blocked");
  const t = throttle(s.cfg, s.db);
  assert.equal(t.ok, false);
  assert.equal(t.reason, "daily_action_cap (1/1)");

  const empty = seed("u-empty", [], { XRS_MODE: "auto", XRS_MAX_BLOCKS_PER_DAY: "1" });
  assert.equal(throttle(empty.cfg, empty.db).ok, true, "空库不应被限流");
  s.close();
  empty.close();
});
