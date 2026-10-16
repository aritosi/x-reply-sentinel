#!/usr/bin/env node
/**
 * Layer 3 — the composite scorer (spec §四 Layer 3, §五 tiering, §六 memory).
 *
 * Nothing here decides policy: it turns a reply into a DetectionOutcome and
 * writes the outcome plus its evidence into the ledger. Tiering, deep scans and
 * blocks are the dispatcher's job, so the thresholds stay in one auditable place.
 */
import type { DatabaseSync } from "node:sqlite";

import type { DetectionOutcome, Evidence, LangTag, Tier, Tweet, UserRisk } from "../types.ts";
import type { Config } from "../config.ts";
import {
  addEvidence,
  authorRecentTexts,
  insertDetection,
  postReplyTexts,
  recordRisk,
  setUserTier,
} from "../db.ts";
import { jaccard, shingles, truncate } from "../util.ts";
import { analyzeLocal, ENGINE_VERSION, rules, type LocalResult } from "./local.ts";
import { combineScores, LlmChecker, PROMPT_VERSION, type GreyItem, type LlmVerdict } from "./llm.ts";

export interface ReplyCandidate {
  tweet: Tweet;
  postId: string;
  rootText: string;
}

export interface PreparedReply {
  tweet: Tweet;
  postId: string;
  rootText: string;
  lang: LangTag;
  local: LocalResult;
  threadDuplicateMax: number;
  authorDuplicateRate: number;
  grey: boolean;
}

const DUP_FLOOR = 0.55;

function similarity(a: string, b: string): number {
  if (a.length < 24 || b.length < 24) return 0;
  return jaccard(shingles(a, 6), shingles(b, 6));
}

/**
 * Duplicate tells are computed against the thread and the author's own history,
 * because "same sentence posted 20 times" is verifiable fact, not style.
 */
export function prepareReplies(db: DatabaseSync, cfg: Config, candidates: ReplyCandidate[]): PreparedReply[] {
  const prepared: PreparedReply[] = [];
  const seenByText = new Map<string, string[]>();

  for (const c of candidates) {
    const text = c.tweet.text;
    // Similarity to other replies already stored in this thread (different authors).
    let threadDuplicateMax = 0;
    for (const sibling of postReplyTexts(db, c.postId, cfg.fetch.maxRepliesPerPost)) {
      if (sibling.user_id === c.tweet.author.id) continue;
      threadDuplicateMax = Math.max(threadDuplicateMax, similarity(text, sibling.text));
    }
    // ...and to replies from this same batch that were scored a moment ago.
    for (const pending of seenByText.get(c.postId) ?? []) {
      threadDuplicateMax = Math.max(threadDuplicateMax, similarity(text, pending));
    }

    // How much of this author's stored backlog looks like this reply.
    const history = authorRecentTexts(db, c.tweet.author.id, 40, c.tweet.id);
    let dupCount = 0;
    for (const h of history) if (similarity(text, h.text) >= DUP_FLOOR) dupCount++;
    const authorDuplicateRate = history.length ? Number((dupCount / Math.min(history.length, 20)).toFixed(3)) : 0;

    const local = analyzeLocal({
      text,
      lang: c.tweet.lang as LangTag | undefined,
      rootText: c.rootText,
      handle: c.tweet.author.handle,
      threadDuplicateMax,
      authorDuplicateRate,
    });
    const [lo, hi] = cfg.llm.greyZone;
    const grey = local.aiStyleScore >= lo && local.aiStyleScore < hi;
    prepared.push({
      tweet: c.tweet,
      postId: c.postId,
      rootText: c.rootText,
      lang: local.lang,
      local,
      threadDuplicateMax: Number(threadDuplicateMax.toFixed(3)),
      authorDuplicateRate,
      grey,
    });
    const bucket = seenByText.get(c.postId) ?? [];
    bucket.push(text);
    seenByText.set(c.postId, bucket);
  }
  return prepared;
}

function toGreyItem(p: PreparedReply): GreyItem {
  return {
    commentId: p.tweet.id,
    postId: p.postId,
    userId: p.tweet.author.id,
    handle: p.tweet.author.handle,
    lang: p.lang,
    rootText: p.rootText,
    replyText: p.tweet.text,
    localStyleScore: p.local.aiStyleScore,
    localFamilies: p.local.families,
    localHits: p.local.matched.flatMap((m) => m.src.split("+")).slice(0, 10),
    threadDuplicateMax: p.threadDuplicateMax,
  };
}

/** Run Layer 2 over the grey band and fold every verdict back into Layer 3. */
export async function scoreReplies(
  db: DatabaseSync,
  cfg: Config,
  checker: LlmChecker,
  prepared: PreparedReply[],
  signal?: AbortSignal,
): Promise<{ outcomes: DetectionOutcome[]; llmItems: number; halted: string | null; errors: string[] }> {
  const grey = prepared.filter((p) => p.grey);
  const verdicts = grey.length ? await checker.check(grey.map(toGreyItem), signal) : null;
  const outcomes: DetectionOutcome[] = [];

  for (const p of prepared) {
    const verdict: LlmVerdict | null = verdicts?.verdicts.get(p.tweet.id) ?? null;
    const combined = combineScores(p.local.aiStyleScore, p.local.families, verdict, cfg);
    const llmSpam = verdict ? verdict.spam : 0;
    const spamRisk = Math.round(Math.max(p.local.spamLocalScore, llmSpam * 0.85));

    const evidence: Evidence[] = [...p.local.evidence];
    if (verdict) {
      if (combined.aiStyleScore >= cfg.thresholds.reviewMin) {
        evidence.push({
          kind: "llm_semantic",
          weight: 8,
          key: `llm_semantic:${PROMPT_VERSION}`,
          detail: `模型判断：${truncate(verdict.reason, 200)}${verdict.signals.length ? ` [${verdict.signals.join(",")}]` : ""}`,
          source: "llm",
          confidence: verdict.confidence,
        });
      }
      if (verdict.spam >= 45) {
        evidence.push({
          kind: "llm_spam_verdict",
          weight: Math.round(10 + verdict.spam * 0.2),
          key: `llm_spam:${PROMPT_VERSION}:${verdict.signals.slice(0, 2).join(",") || "generic"}`,
          detail: `模型判定垃圾意图 ${verdict.spam}：${truncate(verdict.reason, 160)}`,
          source: "llm",
          confidence: verdict.confidence,
        });
      }
    }

    const localConf = p.local.confidence;
    const confidence = verdict
      ? Number(Math.max(localConf, combined.confidence).toFixed(2))
      : localConf;

    outcomes.push({
      commentId: p.tweet.id,
      userId: p.tweet.author.id,
      handle: p.tweet.author.handle,
      postId: p.postId,
      text: p.tweet.text,
      createdAt: p.tweet.createdAt,
      lang: p.lang,
      aiStyleScore: combined.aiStyleScore,
      spamRiskScore: spamRisk,
      localStyleScore: p.local.aiStyleScore,
      llmStyleScore: verdict?.aiStyle ?? null,
      llmSpamScore: verdict?.spam ?? null,
      confidence,
      tier: tierFor(combined.aiStyleScore, cfg),
      signals: { ...p.local.signals },
      evidence,
      llmUsed: Boolean(verdict && !verdict.fromCache),
      llmReason: verdict?.reason,
      engineVersion: ENGINE_VERSION,
      rulesVersion: rules().version,
    });
  }

  return {
    outcomes,
    llmItems: verdicts?.verdicts.size ?? 0,
    halted: verdicts?.halted ?? null,
    errors: verdicts?.errors ?? [],
  };
}

export function tierFor(aiStyleScore: number, cfg: Config): Tier {
  if (aiStyleScore >= cfg.thresholds.deepScanMin) return "deep_scan";
  if (aiStyleScore >= cfg.thresholds.reviewMin) return "review";
  return "observe";
}

export interface PersistContext {
  whitelisted: boolean;
  banState: string;
  firstSeen: string;
  lastSeen: string;
  previousScore: number | null;
  previousTier: Tier;
}

/**
 * Persist one outcome and return the account-level risk it produced. Evidence
 * below the confidence floor is recorded in the detection row (for audit) but
 * never added to the risk ledger.
 */
export function persistDetection(db: DatabaseSync, cfg: Config, o: DetectionOutcome, ctx: PersistContext): UserRisk {
  insertDetection(db, {
    commentId: o.commentId,
    engineVersion: o.engineVersion,
    rulesVersion: o.rulesVersion,
    aiStyleScore: o.aiStyleScore,
    spamRiskScore: o.spamRiskScore,
    localStyleScore: o.localStyleScore,
    llmStyleScore: o.llmStyleScore,
    llmSpamScore: o.llmSpamScore,
    confidence: o.confidence,
    tier: o.tier,
    llmUsed: o.llmUsed,
    signals: o.signals,
    evidence: o.evidence,
    llmReason: o.llmReason,
  });

  if (!ctx.whitelisted) {
    for (const ev of o.evidence) {
      if (ev.confidence < cfg.thresholds.minConfidenceToRecord) continue;
      if (ev.weight <= 0) continue;
      addEvidence(db, o.userId, ev, { commentId: o.commentId, postId: o.postId });
    }
  }

  const risk = recordRisk(db, cfg, {
    userId: o.userId,
    handle: o.handle,
    whitelisted: ctx.whitelisted,
    banState: ctx.banState,
    firstSeen: ctx.firstSeen,
    lastSeen: ctx.lastSeen,
    previousScore: ctx.previousScore,
    tier: o.tier,
  });

  // Tier is a high-water mark per account: one deep-scan reply is enough to
  // deserve a look, and silently downgrading would erase the reason it was
  // flagged in the first place.
  if (!ctx.whitelisted && rank(o.tier) > rank(ctx.previousTier)) setUserTier(db, o.userId, o.tier);
  return risk;
}

export function rank(tier: Tier): number {
  return tier === "deep_scan" ? 2 : tier === "review" ? 1 : 0;
}
