#!/usr/bin/env node
/**
 * Disposal (spec §五 tiering rules, §八 actions).
 *
 * The rule this file exists to enforce, verbatim from the requirement:
 *   只有发现明确、可核查的垃圾互动、诈骗或重复营销证据，满足高风险处置规则后，
 *   才允许自动拉黑。单纯 AI 风格明显，不得自动拉黑。
 *
 * So: style evidence can raise *visibility* (review queue, deep scan) but is
 * structurally excluded from the block gate — the gate only counts kinds listed
 * in cfg.actions.banEligibleKinds, and requires several independent ones. Every
 * decision, including refusals, is written to the audit log.
 */
import fs from "node:fs";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { AuthorRef, Evidence, UserRisk } from "./types.ts";
import type { Config } from "./config.ts";
import { redact } from "./config.ts";
import { addActionCost, actionsToday, EXECUTED_ACTION, lastActionAt, logAction, setBanState } from "./db.ts";
import { displayTime, nowIso, randInt, sleep, truncate } from "./util.ts";

export interface GateInput {
  risk: UserRisk;
  evidence: Evidence[];
  whitelisted: boolean;
  banState: string;
  /** Confidence of the strongest ban-eligible evidence. */
  confidence: number;
}

export interface GateResult {
  /**
   * The evidence itself clears every substantive rule. This is deliberately
   * independent of cfg.mode: a dry-run report has to be able to say "this
   * account *would* have been blocked" without pretending the mode check is a
   * lack of evidence.
   */
  allowed: boolean;
  /** Machine-readable refusals, e.g. "style_only_evidence". */
  reasons: string[];
  /** Human-readable Chinese lines for the report. */
  detail: string[];
  eligibleKinds: string[];
  /** mode ≠ auto: allowed is moot until the operator turns the mode on. */
  modeBlocked: boolean;
}

export function evaluateGate(cfg: Config, input: GateInput): GateResult {
  const reasons: string[] = [];
  const detail: string[] = [];
  const t = cfg.thresholds;

  const eligible = new Set(cfg.actions.banEligibleKinds);
  const eligibleEvidence = input.evidence.filter((e) => eligible.has(e.kind));
  const distinctKinds = [...new Set(eligibleEvidence.map((e) => e.kind))];

  if (input.whitelisted) reasons.push("whitelisted");
  if (input.banState === "blocked") reasons.push("already_blocked");
  if (!distinctKinds.length) {
    reasons.push("style_only_evidence");
    detail.push("仅有 AI 风格证据，不构成可核查的垃圾互动，不拉黑");
  }
  if (distinctKinds.length < t.banMinIndependentSignals) {
    reasons.push(`independent_signals_${distinctKinds.length}`);
    detail.push(`可核查的独立垃圾信号 ${distinctKinds.length} 类，要求 ≥${t.banMinIndependentSignals} 类`);
  }
  if (input.risk.riskScore < t.banMinSpamScore) {
    reasons.push(`risk_score_${input.risk.riskScore.toFixed(1)}`);
    detail.push(`账号垃圾风险 ${input.risk.riskScore.toFixed(1)}，要求 ≥${t.banMinSpamScore}`);
  }
  if (input.confidence < t.banMinConfidence) {
    reasons.push(`confidence_${input.confidence.toFixed(2)}`);
    detail.push(`证据置信度 ${input.confidence.toFixed(2)}，要求 ≥${t.banMinConfidence}`);
  }

  const allowed = reasons.length === 0;
  if (allowed) {
    // Say out loud *which* numbers justified the block. The report shows a reply's
    // detection confidence elsewhere, so without this line a reader can't tell that
    // the gate ran on the evidence confidence rather than the style score.
    detail.push(
      `满足处置条件：独立可核查信号 ${distinctKinds.length} 类（${distinctKinds.join("、")}）、账号风险 ${input.risk.riskScore.toFixed(1)} ≥${t.banMinSpamScore}、证据置信 ${input.confidence.toFixed(2)} ≥${t.banMinConfidence}`,
    );
  }

  return {
    allowed,
    reasons,
    detail,
    eligibleKinds: distinctKinds,
    modeBlocked: cfg.mode !== "auto",
  };
}

export interface ThrottleResult {
  ok: boolean;
  reason: string | null;
  waitMs: number;
}

export function throttle(cfg: Config, db: DatabaseSync, now = new Date()): ThrottleResult {
  const used = actionsToday(db, cfg, "block");
  if (used >= cfg.actions.maxPerDay) {
    return { ok: false, reason: `daily_action_cap (${used}/${cfg.actions.maxPerDay})`, waitMs: 0 };
  }
  const hourAgo = new Date(now.getTime() - 3600000).toISOString().slice(0, 19).replace("T", " ");
  const recent = db
    .prepare(`SELECT COUNT(*) AS n FROM actions WHERE action = 'block' AND ${EXECUTED_ACTION} AND ts > ?`)
    .get(hourAgo) as { n: number };
  if (Number(recent.n) >= cfg.actions.maxPerHour) {
    return { ok: false, reason: `hourly_action_cap (${recent.n}/${cfg.actions.maxPerHour})`, waitMs: 0 };
  }
  const last = lastActionAt(db, "block");
  if (last) {
    const gap = now.getTime() - Date.parse(last.includes("T") ? last : last.replace(" ", "T") + "Z");
    const min = cfg.actions.minIntervalMs + randInt(cfg.actions.jitterMs);
    if (Number.isFinite(gap) && gap < min) return { ok: false, reason: `min_interval (${Math.round(gap / 1000)}s < ${Math.round(min / 1000)}s)`, waitMs: min - gap };
  }
  return { ok: true, reason: null, waitMs: 0 };
}

export interface BlockAttempt {
  userId: string;
  handle: string;
  action: "block" | "unblock";
  gate: GateResult;
  risk: UserRisk;
  evidence: Evidence[];
}

export interface BlockOutcome {
  status: "blocked" | "unblocked" | "simulated" | "already" | "skipped" | "failed";
  ok: boolean;
  reasons: string[];
  detail: string;
}

export interface Actor {
  block?(userId: string, handle: string): Promise<{ ok: boolean; status: string; detail?: string }>;
  unblock?(userId: string, handle: string): Promise<{ ok: boolean; status: string; detail?: string }>;
}

/**
 * The only path to a real block. dry-run and review modes never reach the
 * platform: they log what *would* have happened, which is also what makes the
 * gate testable.
 */
export async function dispose(
  db: DatabaseSync,
  cfg: Config,
  attempt: BlockAttempt,
  actor: Actor,
  runId?: number,
): Promise<BlockOutcome> {
  const { gate, risk } = attempt;
  const audit = (status: string, ok: boolean, reason: string, detail: string) => {
    logAction(db, {
      userId: attempt.userId,
      handle: attempt.handle,
      action: attempt.action,
      mode: cfg.mode,
      ok,
      status,
      reason: truncate(`${reason} | ${detail}`, 500),
      riskScore: risk.riskScore,
      spamScore: risk.riskScore,
      evidence: attempt.evidence,
      runId,
    });
    // `nowIso()` is a UTC instant, so the field that names the timezone has to say UTC;
    // the operator's wall clock goes in `local` (spec §八 wants the audit readable).
    appendAuditLine(cfg, { ts: nowIso(), tz: "UTC", local: displayTime(nowIso(), cfg.timezone), userId: attempt.userId, handle: attempt.handle, action: attempt.action, mode: cfg.mode, status, ok, reasons: [...new Set([reason, ...gate.reasons])], detail, risk: risk.riskScore, evidenceKinds: [...new Set(attempt.evidence.map((e) => e.kind))] });
  };

  if (attempt.action === "unblock") {
    if (!actor.unblock) {
      audit("skipped", false, "no_actor", "当前 provider 不支持解除拉黑");
      return { status: "skipped", ok: false, reasons: ["no_actor"], detail: "当前 provider 不支持解除拉黑" };
    }
    const res = await actor.unblock(attempt.userId, attempt.handle).catch((e) => ({ ok: false, status: "failed", detail: truncate(String((e as Error)?.message ?? e), 120) }));
    audit(res.status, res.ok, "manual_unblock", res.detail ?? "");
    if (res.ok) setBanState(db, attempt.userId, "unblocked");
    return { status: res.ok ? "unblocked" : "failed", ok: res.ok, reasons: [], detail: res.detail ?? "" };
  }

  if (!gate.allowed) {
    const primary = gate.reasons[0] ?? "gate_refused";
    audit("skipped", false, primary, gate.detail.join("；") || "未满足高风险处置规则");
    return { status: "skipped", ok: false, reasons: gate.reasons, detail: gate.detail.join("；") };
  }

  // Whether anything actually happens is a mode question, and it is answered
  // before the rate limiter: a dry-run must report "this account would have been
  // blocked" rather than hiding that behind a throttle refusal, and a dry-run
  // consumes no write budget so it has no reason to wait.
  if (gate.modeBlocked || !actor.block) {
    const why = gate.modeBlocked ? `mode=${cfg.mode}，证据已满足处置条件，仅记录不执行` : "provider 不支持写操作";
    audit("simulated", true, "simulated", why);
    return { status: "simulated", ok: true, reasons: ["simulated"], detail: why };
  }

  const t = throttle(cfg, db);
  if (!t.ok) {
    audit("skipped", false, t.reason ?? "throttled", "处置节奏限制，本条留待下一轮");
    if (t.waitMs > 0) await sleep(Math.min(t.waitMs, 5000));
    return { status: "skipped", ok: false, reasons: [t.reason ?? "throttled"], detail: "处置节奏限制" };
  }

  const res = await actor.block(attempt.userId, attempt.handle).catch((e) => ({ ok: false, status: "failed", detail: truncate(String((e as Error)?.message ?? e), 120) }));
  const status = res.status === "already" ? "already" : res.ok ? "blocked" : "failed";
  addActionCost(db, cfg);
  audit(status, res.ok, "gate_passed", res.detail ?? "");
  if (res.ok) setBanState(db, attempt.userId, "blocked");
  return { status, ok: res.ok, reasons: [], detail: res.detail ?? "" };
}

function appendAuditLine(cfg: Config, line: Record<string, unknown>): void {
  try {
    const file = path.isAbsolute(cfg.auditLog) ? cfg.auditLog : path.join(cfg.dataDir, cfg.auditLog);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Same rule as the database: a provider error string that reached the audit
    // trail must not still carry the credential that failed.
    fs.appendFileSync(file, redact(JSON.stringify(line)) + "\n", "utf8");
  } catch {
    // The DB row is the source of truth; the JSONL mirror is convenience.
  }
}
