#!/usr/bin/env node
/**
 * The scan orchestrator — spec §三 (手动模式 / 自动模式) end to end.
 *
 *   抓取原帖以及所有可访问的回复 … 必须支持断点续扫、限流、失败重试
 *
 * Responsibilities, in order:
 *   1. resolve the target and pick a transport (provider.ts states honestly
 *      whether replies can be enumerated at all — a zero-reply scan is reported as
 *      "replies unreadable", never as "the thread is clean");
 *   2. walk reply pages, persisting the cursor after *every* page so an aborted or
 *      failed run resumes where it stopped (断点续扫);
 *   3. store replies idempotently, then score only what is genuinely new (or was
 *      stored but never scored), so re-checking a thread costs zero tokens;
 *   4. Layer 1 → 2 → 3 via detect/engine.ts;
 *   5. tier dispatch (§五): observe = store, review = human queue, deep_scan =
 *      account scan, capped per day and cooled down per account;
 *   6. disposal (§八): only through actions.ts, which structurally refuses
 *      style-only evidence — 单纯 AI 风格明显不得自动拉黑;
 *   7. the scan report (§七).
 *
 * Pace/retry live in fetch/http.ts (per-request) and in the page loop here
 * (between pages). Nothing here decides thresholds.
 */
import type { DatabaseSync } from "node:sqlite";

import type {
  DetectionOutcome,
  Evidence,
  EvidenceKind,
  ScanAccountRow,
  ScanSummary,
  Tier,
  Tweet,
  UserRisk,
} from "../types.ts";
import type { Config } from "../config.ts";

import {
  activeEvidence,
  bumpTracked,
  deepScansToday,
  dueTracked,
  enqueueReview,
  resolveReviewForUser,
  finishRun,
  getBudget,
  getCursor,
  getPost,
  getUserRow,
  hasDetection,
  insertCommentIfNew,
  logEvent,
  markDeepScanned,
  recordRisk,
  setCursor,
  startRun,
  storedRepliesWithoutDetection,
  touchUser,
  trackPost,
  upsertPost,
  type EvidenceRow,
  type StoredReplyRow,
} from "../db.ts";
import { ENGINE_VERSION } from "../detect/local.ts";
import { LlmChecker } from "../detect/llm.ts";
import { persistDetection, prepareReplies, scoreReplies, type PersistContext } from "../detect/engine.ts";
import { deepScan, type DeepScanResult } from "../deepscan.ts";
import { dispose, evaluateGate, type Actor } from "../actions.ts";
import { writeScanReport } from "../report.ts";
import { nowIso, parseTweetUrl, randInt, sleep, truncate } from "../util.ts";
import { RequestBudgetError } from "./http.ts";
import { createProviders, fetchRootTweet, type ProviderBundle } from "./provider.ts";

/** A scanned account is not re-scanned within this window, whatever the run does. */
const DEEP_SCAN_COOLDOWN_DAYS = 7;

export interface ScanOptions {
  /** `https://x.com/<user>/status/<id>`, a bare tweet id, or a tracked post id. */
  target: string;
  kind?: "manual" | "watch";
  /** Re-walk and re-score everything instead of only new replies. */
  force?: boolean;
  /** Also score stored replies this thread has but the engine has never seen. */
  includeStored?: boolean;
  signal?: AbortSignal;
  /** Injectable so tests can assert what a block attempt would have done. */
  actor?: Actor;
  /** Skip report writing (used by the test harness). */
  noReport?: boolean;
}

interface WalkResult {
  tweets: Tweet[];
  pages: number;
  complete: boolean;
  halted: string | null;
  errors: string[];
}

/** Exported so a caller can feed the gate straight from ledger rows. */
export function toEvidence(rows: EvidenceRow[]): Evidence[] {
  return rows.map((r) => ({
    kind: r.kind as EvidenceKind,
    weight: Number(r.weight),
    key: r.dedup_key,
    detail: r.detail ?? r.kind,
    source: r.source as Evidence["source"],
    confidence: Number(r.confidence),
  }));
}

function tweetFromStored(row: StoredReplyRow): Tweet {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at ?? "",
    author: { id: row.user_id, handle: row.handle },
    url: row.url ?? undefined,
    lang: row.lang ?? undefined,
    source: row.source ?? undefined,
  };
}

/**
 * Page through replies. The cursor is written after each page, so an abort, a
 * crash or a daily request cap all leave a resumable position.
 */
async function walkReplies(
  db: DatabaseSync,
  cfg: Config,
  bundle: ProviderBundle,
  postId: string,
  opts: ScanOptions,
): Promise<WalkResult> {
  const out: WalkResult = { tweets: [], pages: 0, complete: false, halted: null, errors: [] };
  if (!bundle.canEnumerateReplies) {
    out.halted = "replies_not_accessible";
    return out;
  }

  // Only transports with real pagination tokens can resume mid-thread; an import
  // file is re-read wholesale, which is cheap and idempotent.
  const resumable = bundle.name === "api" || bundle.name === "session";
  // Local transports read a file from disk; pacing them would only make a demo run slow.
  const offline = bundle.name === "file" || bundle.name === "fixture";
  const stored = resumable ? getCursor(db, postId, "replies") : { cursor: null, complete: false, lastRun: null };
  // A walk that reached the end still has to be re-checked — that is how new
  // replies are found. Idempotent inserts make the re-walk cost zero scoring.
  const startCursor = opts.force || stored.complete ? null : stored.cursor;

  const maxItems = cfg.fetch.maxRepliesPerPost;
  const collected = new Map<string, Tweet>();
  let pages = 0;

  try {
    for await (const page of bundle.primary.fetchReplies(postId, {
      maxItems,
      startCursor,
      signal: opts.signal,
    })) {
      pages++;
      out.pages = pages;
      for (const t of page.items) {
        if (!t?.id || t.id === postId || collected.has(t.id)) continue;
        collected.set(t.id, t);
      }
      if (page.rateLimited) out.errors.push(`第 ${pages} 页返回限流信号，已按退避策略重试`);

      if (page.complete || !page.nextCursor) {
        setCursor(db, postId, "replies", null, true);
        out.complete = true;
        break;
      }
      if (collected.size >= maxItems) {
        setCursor(db, postId, "replies", page.nextCursor, false);
        out.halted = `max_replies (${collected.size})`;
        break;
      }
      if (pages >= cfg.fetch.maxPagesPerRun) {
        setCursor(db, postId, "replies", page.nextCursor, false);
        out.halted = `max_pages (${pages})`;
        break;
      }
      setCursor(db, postId, "replies", page.nextCursor, false);
      // Pace between pages: bursting page requests is how an account gets capped.
      if (!offline) await sleep(cfg.fetch.pageDelayMs + randInt(cfg.fetch.pageJitterMs), opts.signal);
    }
  } catch (err) {
    if (err instanceof RequestBudgetError) {
      out.halted = `daily_request_cap (${err.message})`;
    } else if (opts.signal?.aborted || (err as Error)?.message === "aborted") {
      out.halted = "aborted";
    } else {
      out.errors.push(`回复抓取中断：${truncate(String((err as Error)?.message ?? err), 160)}`);
    }
  }

  out.tweets = [...collected.values()];
  return out;
}

interface DispatchState {
  deepScans: number;
  deepResults: Map<string, DeepScanResult>;
}

/**
 * §五 tiering + §八 disposal for one scored reply. Returns the action label the
 * report shows, the reasons behind it, and the risk record (deep scans change it).
 */
async function dispatch(
  db: DatabaseSync,
  cfg: Config,
  bundle: ProviderBundle,
  runId: number,
  risk: UserRisk,
  ctx: PersistContext,
  opts: ScanOptions,
  state: DispatchState,
): Promise<{ action: string; reasons: string[]; findings: string[]; risk: UserRisk }> {
  const reasons: string[] = [];
  const findings: string[] = [];
  let current = risk;
  let action = "recorded";

  if (ctx.whitelisted) {
    return { action: "recorded", reasons: ["白名单账号：只记录，不处置"], findings, risk: current };
  }
  if (current.tier === "review" || current.tier === "deep_scan") action = "queued_review";

  if (current.tier === "deep_scan") {
    const last = getUserRow(db, current.userId)?.deep_scanned_at;
    const ageMs = last ? Date.now() - Date.parse(isoish(last)) : Infinity;
    if (Number.isFinite(ageMs) && ageMs < DEEP_SCAN_COOLDOWN_DAYS * 86400000) {
      action = "deep_skipped";
      reasons.push(`已在 ${DEEP_SCAN_COOLDOWN_DAYS} 天内深度扫描过，本轮跳过`);
    } else if (state.deepScans >= cfg.thresholds.deepScanMaxAccountsPerDay) {
      action = "deep_skipped";
      reasons.push(`每日深度扫描上限 ${cfg.thresholds.deepScanMaxAccountsPerDay} 已达，留待下一轮`);
      logEvent(db, "warn", "deepscan_capped", { user: current.handle });
    } else {
      state.deepScans++;
      const scan = await deepScan(db, cfg, bundle.primary, { id: current.userId, handle: current.handle });
      state.deepResults.set(current.userId, scan);
      findings.push(...scan.findings);
      // The cooldown is only earned by a scan that actually read something. Marking a
      // skipped attempt would freeze the account out of deep scanning for a week after
      // a provider that answered nothing, and the operator would have no way to see
      // that the block decision was made without the account-level evidence.
      if (!scan.skipped) markDeepScanned(db, current.userId);
      action = scan.skipped ? "deep_skipped" : "deep_scanned";
      if (scan.skipped) reasons.push(`深度扫描未执行：${scan.skipped}`);
      else reasons.push(`账号垃圾风险 ${scan.accountSpamRisk}（独立于回复风格分）`);

      // Fold the account-level evidence into the ledger before the gate looks at it.
      current = recordRisk(
        db,
        cfg,
        {
          userId: current.userId,
          handle: current.handle,
          whitelisted: ctx.whitelisted,
          banState: ctx.banState,
          firstSeen: ctx.firstSeen,
          lastSeen: ctx.lastSeen,
          previousScore: current.riskScore,
          tier: current.tier,
        },
        new Date(),
      );
    }
  }

  // Disposal goes through the one path that can produce a block, so the manual
  // review queue and the automatic tier can never drift apart.
  const res = await blockAccount(db, cfg, current, {
    // Capability decides who may write, not whether a method exists: an offline
    // transport can expose a block() that only refuses, and calling it would log
    // a platform failure where there was never a platform to fail.
    actor: opts.actor ?? (bundle.capabilities.block ? bundle.primary : {}),
    runId,
    whitelisted: ctx.whitelisted,
    banState: ctx.banState,
  });
  if (!res.attempted) {
    reasons.push(...res.detail);
    return { action, reasons, findings, risk: current };
  }
  reasons.push(...res.reasons);
  reasons.push(...res.detail);
  if (res.status === "blocked" || res.status === "already") {
    resolveReviewForUser(db, current.userId, res.status, "系统已完成处置，无需人工确认");
  }
  return { action: res.status, reasons, findings, risk: current };
}

export interface BlockAttemptResult {
  status: string;
  /** false when the ledger holds style evidence only — nothing was decided. */
  attempted: boolean;
  /** The gate allowed a disposal: true for blocked / already / simulated. */
  ok: boolean;
  reasons: string[];
  detail: string[];
}

/**
 * The single path from an evidence ledger to a block decision (§八).
 *
 * Style-only accounts never reach the actions table, so the audit log stays a
 * record of real decisions rather than a list of refused blocks. Everything
 * else is decided by evaluateGate: ban-eligible kinds only, several independent
 * signals, the account-level spam risk and the evidence confidence.
 */
export async function blockAccount(
  db: DatabaseSync,
  cfg: Config,
  risk: UserRisk,
  opts: { actor?: Actor; runId?: number; whitelisted?: boolean; banState?: string } = {},
): Promise<BlockAttemptResult> {
  const eligible = new Set(cfg.actions.banEligibleKinds);
  const ledger = toEvidence(activeEvidence(db, risk.userId));
  const banEligible = ledger.filter((e) => eligible.has(e.kind));
  if (!banEligible.length) {
    // "style only" and "nothing at all" are different facts. An account whose reply
    // fell below the recording threshold has no evidence of any kind, and telling the
    // operator it was refused for AI style would imply we saw style evidence we do not
    // have. The machine reason stays one token so the audit stays greppable.
    const why = ledger.length
      ? "仅有 AI 风格证据，不构成可核查的垃圾互动：不进入处置环节"
      : "没有记录到任何证据（分数未达记录阈值）：不进入处置环节";
    return {
      status: "no_verifiable_evidence",
      attempted: false,
      ok: false,
      reasons: ["style_only_evidence"],
      detail: [why],
    };
  }

  const gate = evaluateGate(cfg, {
    risk,
    evidence: ledger,
    whitelisted: opts.whitelisted ?? risk.whitelisted,
    banState: opts.banState ?? risk.banState,
    confidence: Math.max(...banEligible.map((e) => e.confidence)),
  });
  const outcome = await dispose(
    db,
    cfg,
    { userId: risk.userId, handle: risk.handle, action: "block", gate, risk, evidence: banEligible },
    opts.actor ?? {},
    opts.runId,
  );
  return {
    status: outcome.status,
    attempted: true,
    ok: outcome.ok,
    reasons: outcome.reasons.length ? outcome.reasons : [outcome.status],
    // gate.detail carries refusals; for an approved-but-dry-run decision the
    // wording only exists in outcome.detail, so both end up in the report.
    detail: [...gate.detail, ...(outcome.detail && !gate.detail.includes(outcome.detail) ? [outcome.detail] : [])],
  };
}

/** SQLite stores some timestamps as "YYYY-MM-DD HH:MM:SS"; make both parseable. */
function isoish(ts: string): string {
  if (ts.includes("T")) return ts;
  return `${ts.replace(" ", "T")}Z`;
}

/**
 * §五 bands are written against the composite score, but a reply that is plain
 * scam or repeat marketing can score 0 on AI style and still be the exact thing
 * the tool exists to catch. Spam risk therefore promotes a band; it never
 * demotes one, and the promotion is stated in the report so an "AI 风格 0"
 * account sitting in deep scan is not mysterious.
 */
function effectiveTier(o: DetectionOutcome, cfg: Config): { tier: Tier; promoted: boolean } {
  if (o.tier !== "deep_scan" && o.spamRiskScore >= cfg.thresholds.deepScanMin) return { tier: "deep_scan", promoted: true };
  return { tier: o.tier, promoted: false };
}

export async function scanPost(db: DatabaseSync, cfg: Config, opts: ScanOptions): Promise<ScanSummary> {
  const kind = opts.kind ?? "manual";
  const t0 = Date.now();
  const runId = startRun(db, kind);
  const budget0 = getBudget(db, cfg);

  const notes: string[] = [];
  const errors: string[] = [];
  const summary: ScanSummary = {
    runId,
    postId: "",
    postUrl: "",
    rootText: "",
    provider: "-",
    rootFound: false,
    repliesAccessible: false,
    notes,
    repliesFetched: 0,
    repliesNew: 0,
    repliesSeenAgain: 0,
    localOnly: 0,
    llmCalls: 0,
    llmItems: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    tierCounts: { observe: 0, review: 0, deep_scan: 0 },
    blocked: 0,
    blockSimulated: 0,
    blockSkipped: 0,
    errors,
    budgetHalted: null,
    accounts: [],
    startedAt: nowIso(new Date(t0)),
    durationMs: 0,
  };

  const parsed = parseTweetUrl(opts.target);
  const bare = opts.target.trim();
  const postId = parsed?.id ?? (/^\d{5,}$/.test(bare) ? bare : "");
  if (!postId) {
    errors.push(`无法从输入中解析帖子 id：${truncate(opts.target, 80)}`);
    return closeOut(db, cfg, summary, opts, runId, t0);
  }
  summary.postId = postId;
  summary.postUrl = `https://x.com/${parsed?.handle ?? "i"}/status/${postId}`;

  let bundle: ProviderBundle;
  try {
    bundle = createProviders(db, cfg);
  } catch (err) {
    errors.push(`数据通路初始化失败：${truncate(String((err as Error)?.message ?? err), 160)}`);
    return closeOut(db, cfg, summary, opts, runId, t0);
  }
  summary.provider = bundle.name;
  notes.push(...bundle.notes);
  summary.repliesAccessible = bundle.canEnumerateReplies;

  // 1. root post: needed as Layer 2 context and for the report header.
  const root = await fetchRootTweet(bundle, postId).catch((err) => {
    errors.push(`原帖抓取失败：${truncate(String((err as Error)?.message ?? err), 160)}`);
    return null;
  });
  let rootText = "";
  let missingRoot = false;
  if (root?.text) {
    summary.rootFound = true;
    rootText = root.text;
    summary.postUrl = root.url ?? summary.postUrl;
    if (root.author?.id) touchUser(db, root.author);
    upsertPost(db, {
      id: root.id || postId,
      userId: root.author?.id,
      handle: root.author?.handle,
      text: root.text,
      createdAt: root.createdAt,
      conversationCount: root.conversationCount,
      url: summary.postUrl,
      source: root.source ?? bundle.name,
    });
  } else {
    const stored = getPost(db, postId);
    if (stored?.text) {
      rootText = stored.text;
      notes.push("原帖本轮未取到，使用库内缓存文本");
    } else {
      missingRoot = true;
      notes.push("未取得原帖正文：模型语义判定将缺少原帖上下文");
    }
  }
  summary.rootText = rootText;

  // 2. walk replies with resume + pacing; per-request retry lives in fetch/http.ts.
  const walk = await walkReplies(db, cfg, bundle, postId, opts);
  if (walk.halted) summary.budgetHalted = walk.halted;
  errors.push(...walk.errors);
  summary.repliesFetched = walk.tweets.length;
  // Nothing at all came back: the target is unreachable through this transport.
  // A scheduled run must be able to tell that apart from "thread has no replies".
  if (missingRoot && walk.tweets.length === 0) {
    errors.push(`原帖与回复均未取到（通路 ${bundle.name} 读不到 ${postId}）：本轮没有可检测内容`);
  }

  // 3. idempotent storage; only new (or never-scored) replies become candidates.
  const candidates: Tweet[] = [];
  let seenAgain = 0;
  let fresh = 0;
  let unusable = 0;
  for (const t of walk.tweets) {
    if (!t.author?.id || !t.text) {
      unusable++;
      continue;
    }
    touchUser(db, { id: t.author.id, handle: t.author.handle, displayName: t.author.displayName });
    const isNew = insertCommentIfNew(db, {
      id: t.id,
      postId,
      userId: t.author.id,
      handle: t.author.handle,
      text: t.text,
      createdAt: t.createdAt,
      url: t.url,
      lang: t.lang,
      source: t.source ?? bundle.name,
    });
    if (!isNew) {
      seenAgain++;
      if (opts.force || !hasDetection(db, t.id, ENGINE_VERSION)) candidates.push(t);
      continue;
    }
    fresh++;
    candidates.push(t);
  }
  // "新" means first time seen, which is what §三 promises the auto mode saves
  // work on. A --force run re-scores replies it has already stored, so those are
  // counted separately instead of being reported as new replies.
  summary.repliesNew = fresh;
  summary.repliesSeenAgain = seenAgain;
  const rechecked = candidates.length - fresh;
  if (rechecked > 0) notes.push(`重新检测 ${rechecked} 条已入库回复（--force 或该回复尚无检测结果）`);
  if (unusable) notes.push(`跳过 ${unusable} 条缺少稳定 user id 或正文的回复`);

  if (opts.includeStored) {
    for (const row of storedRepliesWithoutDetection(db, postId, ENGINE_VERSION, cfg.fetch.maxRepliesPerPost)) {
      if (candidates.some((c) => c.id === row.id)) continue;
      candidates.push(tweetFromStored(row));
    }
  }

  if (bundle.canEnumerateReplies && !walk.complete) {
    notes.push(`回复未抓完（已抓 ${walk.tweets.length} 条，游标已保存），下一轮自动续扫`);
  }

  // 4. Layer 1 → 2 → 3.
  const prepared = prepareReplies(
    db,
    cfg,
    candidates.map((t) => ({ tweet: t, postId, rootText })),
  );
  const checker = new LlmChecker({ db, cfg });
  const scored = await scoreReplies(db, cfg, checker, prepared, opts.signal);
  if (scored.halted) {
    summary.budgetHalted = scored.halted;
    notes.push(`第二层未调用（${scored.halted}），本轮只用本地规则分数`);
  }
  errors.push(...scored.errors);

  // 5./6. persist, dispatch tiers, dispose through the gate.
  const byId = new Map(candidates.map((t) => [t.id, t]));
  const state: DispatchState = { deepScans: deepScansToday(db, cfg), deepResults: new Map() };
  for (const o of scored.outcomes) {
    const row = getUserRow(db, o.userId);
    const ctx: PersistContext = {
      whitelisted: !!row?.whitelisted,
      banState: row?.ban_state ?? "none",
      firstSeen: row?.first_seen ?? o.createdAt,
      lastSeen: row?.last_seen ?? o.createdAt,
      previousScore: row?.risk_score ?? null,
      previousTier: (row?.tier as Tier) ?? "observe",
    };
    const { tier, promoted } = effectiveTier(o, cfg);
    const risk = persistDetection(db, cfg, promoted ? { ...o, tier } : o, ctx);
    if (risk.tier !== "observe" && !ctx.whitelisted) enqueueReview(db, o.userId, o.commentId, postId);

    const done = await dispatch(db, cfg, bundle, runId, risk, ctx, opts, state);
    if (promoted) {
      done.reasons.unshift(`垃圾风险 ${o.spamRiskScore} ≥ ${cfg.thresholds.deepScanMin}：按账号风险提升为深度扫描档`);
    }
    summary.tierCounts[risk.tier] = (summary.tierCounts[risk.tier] ?? 0) + 1;
    if (done.action === "blocked") summary.blocked++;
    else if (done.action === "simulated") summary.blockSimulated++;
    else if (done.action === "skipped") summary.blockSkipped++;

    const scan = state.deepResults.get(o.userId);
    const account: ScanAccountRow = {
      userId: o.userId,
      handle: o.handle,
      commentId: o.commentId,
      text: o.text,
      aiStyleScore: o.aiStyleScore,
      localStyleScore: o.localStyleScore,
      llmStyleScore: o.llmStyleScore,
      spamRiskScore: o.spamRiskScore,
      accountRisk: done.risk.riskScore,
      confidence: o.confidence,
      tier: risk.tier,
      evidenceKinds: [...new Set(o.evidence.map((e) => e.kind))],
      evidenceDetail: o.evidence.map(
        (e) => `${e.kind} +${e.weight}（置信 ${e.confidence.toFixed(2)}）：${truncate(e.detail, 180)}`,
      ),
      action: done.action,
      reasons: done.reasons,
      deepScanFindings: scan ? scan.findings.map((f) => `${f}｜账号垃圾风险 ${scan.accountSpamRisk}`) : [],
    };
    const url = byId.get(o.commentId)?.url;
    if (url) account.commentUrl = url;
    summary.accounts.push(account);
  }
  summary.localOnly = scored.outcomes.filter((o) => !o.llmUsed).length;
  summary.llmItems = scored.llmItems;

  // 7. bookkeeping: tracking for auto mode, run cost delta, run row, report.
  if (bundle.name !== "fixture" && bundle.name !== "file") {
    trackPost(db, postId, { url: summary.postUrl, mode: cfg.mode, mine: isSelfHandle(cfg, parsed?.handle) });
    bumpTracked(db, postId, nextDue(cfg));
  }

  const budget1 = getBudget(db, cfg);
  summary.llmCalls = Math.max(0, budget1.llmCalls - budget0.llmCalls);
  summary.tokensIn = Math.max(0, budget1.tokensIn - budget0.tokensIn);
  summary.tokensOut = Math.max(0, budget1.tokensOut - budget0.tokensOut);
  summary.costUsd = Number(Math.max(0, budget1.costUsd - budget0.costUsd).toFixed(6));

  return closeOut(db, cfg, summary, opts, runId, t0);
}

function isSelfHandle(cfg: Config, handle?: string | null): boolean {
  if (!handle) return false;
  const self = (process.env[cfg.fetch.selfHandleEnv] ?? "").replace(/^@/, "").toLowerCase();
  return !!self && self === handle.replace(/^@/, "").toLowerCase();
}

function nextDue(cfg: Config): string {
  return new Date(Date.now() + cfg.schedule.watchIntervalHours * 3600000).toISOString();
}

function closeOut(
  db: DatabaseSync,
  cfg: Config,
  summary: ScanSummary,
  opts: ScanOptions,
  runId: number,
  t0: number,
): ScanSummary {
  summary.durationMs = Date.now() - t0;
  finishRun(db, runId, {
    kind: opts.kind ?? "manual",
    postId: summary.postId,
    posts: 1,
    repliesFetched: summary.repliesFetched,
    repliesNew: summary.repliesNew,
    localOnly: summary.localOnly,
    llmCalls: summary.llmCalls,
    llmItems: summary.llmItems,
    tokensIn: summary.tokensIn,
    tokensOut: summary.tokensOut,
    costUsd: summary.costUsd,
    blocked: summary.blocked,
    simulated: summary.blockSimulated,
    errors: summary.errors,
    tierCounts: summary.tierCounts,
    provider: summary.provider,
    repliesAccessible: summary.repliesAccessible,
    notes: summary.notes,
  });
  logEvent(db, "info", "scan_done", {
    run: runId,
    post: summary.postId,
    fetched: summary.repliesFetched,
    new: summary.repliesNew,
    tiers: summary.tierCounts,
    blocked: summary.blocked,
    simulated: summary.blockSimulated,
    halted: summary.budgetHalted,
  });

  if (!opts.noReport) {
    try {
      summary.reportPath = writeScanReport(cfg, summary);
    } catch (err) {
      summary.errors.push(`报告写入失败：${truncate(String((err as Error)?.message ?? err), 120)}`);
    }
  }
  return summary;
}

/**
 * Auto mode (spec §三): every tracked post that is due, new replies only. A daily
 * request cap or an aborted signal stops the loop with cursors preserved.
 */
export async function scanDuePosts(db: DatabaseSync, cfg: Config, signal?: AbortSignal): Promise<ScanSummary[]> {
  const out: ScanSummary[] = [];
  for (const p of dueTracked(db)) {
    if (signal?.aborted) break;
    const summary = await scanPost(db, cfg, {
      target: p.url || p.post_id,
      kind: "watch",
      signal,
      includeStored: true,
    });
    out.push(summary);
    bumpTracked(db, p.post_id, nextDue(cfg));
    if (summary.budgetHalted?.startsWith("daily_request_cap")) break;
  }
  return out;
}
