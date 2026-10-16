#!/usr/bin/env node
/**
 * Layer 2 — LLM semantic check (spec §四 Layer 2, §十 cost rules).
 *
 * This module is deliberately narrow:
 *   - it is only ever asked about replies Layer 1 could not classify (grey band);
 *   - the payload is 原帖 + 回复 + 本地命中特征, nothing else;
 *   - the model must return strict JSON, no prose;
 *   - every call is cached by content hash, budget-gated per day, and recorded.
 *
 * A missing key, a disabled flag, a cold budget or a failed call is never an
 * error: the caller simply keeps the Layer 1 verdict. Detection must degrade to
 * zero-token behaviour rather than stall.
 */
import type { DatabaseSync } from "node:sqlite";

import type { LangTag } from "../types.ts";
import type { Config } from "../config.ts";
import {
  checkLlmBudget,
  addLlmUsage,
  getLlmCached,
  llmCacheKey,
  logEvent,
  putLlmCached,
} from "../db.ts";
import { clamp, normalizeForHash, safeJsonParse, sleep, truncate } from "../util.ts";

export const PROMPT_VERSION = "1.0.0";

export interface GreyItem {
  commentId: string;
  postId: string;
  userId: string;
  handle: string;
  lang: LangTag;
  rootText: string;
  replyText: string;
  localStyleScore: number;
  localFamilies: string[];
  /** Matched rule terms, for the model to confirm or reject. */
  localHits: string[];
  /** Best near-duplicate similarity against another reply in the same thread. */
  threadDuplicateMax?: number;
}

export interface LlmVerdict {
  commentId: string;
  /** 0-100, how much this reply reads like generated filler. */
  aiStyle: number;
  /** 0-100, spam/scam/marketing intent seen in this reply. */
  spam: number;
  confidence: number;
  /** True when the model judges the reply to be a genuine human reaction. */
  humanLikely: boolean;
  reason: string;
  signals: string[];
  fromCache: boolean;
}

export interface LlmUsage {
  calls: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LlmBatchResult {
  verdicts: Map<string, LlmVerdict>;
  usage: LlmUsage;
  /** Non-null when the run stopped asking the model: budget / disabled / no key. */
  halted: string | null;
  errors: string[];
}

const SYSTEM_PROMPT = [
  "You are a detector for AI-generated filler in social-media replies.",
  "Judge only whether the REPLY reads like generated engagement bait, and whether it pushes spam/scam/marketing.",
  "Do not judge the poster. Do not explain yourself. Never invent facts.",
  "Genuine human reactions (personal anecdote, concrete number, disagreement, joke, shorthand, typos, @mentions, off-topic) are NOT AI filler even when they are short.",
  "Praise-opener + restatement of the post + vague analysis + reflexive question + generic advice IS AI filler.",
  "An honest disagreement written politely is not AI filler.",
  'Reply with JSON only: {"items":[{"id":"<id>","ai_style":0-100,"spam":0-100,"confidence":0-1,"human_like":true|false,"signals":["..."],"reason":"<= 140 chars, no quotes"}]}',
  "signals must be chosen from: praise_opener, restatement, vague_analysis, trailing_question, generic_advice, over_structured, chatbot_leak, marketing_push, scam_push, duplicate_of_other_reply, human_specificity, human_emotion, human_disagreement, off_topic.",
  "Return exactly one entry per input id, in the same order. No text outside the JSON object.",
].join("\n");

function userPrompt(items: GreyItem[]): string {
  const lines: string[] = ["ROOT POST:"];
  const root = truncate(items[0].rootText.replace(/\s+/g, " "), 600) || "(original post unavailable)";
  lines.push(root, "", "REPLIES:");
  for (const it of items) {
    const hits = it.localHits.length ? it.localHits.slice(0, 8).join(", ") : "none";
    lines.push(
      `--- id=${it.commentId} lang=${it.lang} local_ai_score=${it.localStyleScore} local_families=${it.localFamilies.join("/") || "none"} local_terms=${hits}` +
        (it.threadDuplicateMax && it.threadDuplicateMax > 0.5 ? ` thread_duplicate=${it.threadDuplicateMax.toFixed(2)}` : ""),
      truncate(it.replyText.replace(/\s+/g, " "), 700),
    );
  }
  return lines.join("\n");
}

function budgetTokens(cfg: Config, items: GreyItem[]): number {
  const chars = items.reduce((s, i) => s + Math.min(700, i.replyText.length), 0) + Math.min(600, items[0].rootText.length) + 1200;
  const plannedOut = Math.min(cfg.llm.maxOutputTokens, 80 + items.length * 70);
  return Math.ceil(chars / 3.2) + plannedOut;
}

function price(cfg: Config, tin: number, tout: number): number {
  return (tin / 1e6) * cfg.llm.priceInputUsdPerMTok + (tout / 1e6) * cfg.llm.priceOutputUsdPerMTok;
}

function cachePayload(cfg: Config, items: GreyItem[]): string {
  return JSON.stringify({
    v: PROMPT_VERSION,
    model: cfg.llm.model,
    root: normalizeForHash(items[0].rootText).slice(0, 400),
    items: items.map((i) => ({
      id: i.commentId,
      t: normalizeForHash(i.replyText),
      g: i.localStyleScore,
      f: i.localFamilies.join(","),
    })),
  });
}

function coerceNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? clamp(n) : fallback;
}

function coerceConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  // Models sometimes answer 0-100 by mistake.
  return clamp(n > 1 ? n / 100 : n, 0, 1);
}

export function parseVerdicts(raw: string, items: GreyItem[]): Map<string, LlmVerdict> | null {
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const list = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : null;
  if (!list) return null;
  const byId = new Map(items.map((i) => [i.commentId, i]));
  const out = new Map<string, LlmVerdict>();
  for (const entry of list as Array<Record<string, unknown>>) {
    const id = String(entry.id ?? entry.commentId ?? "").trim();
    if (!byId.has(id)) continue;
    const signals = Array.isArray(entry.signals) ? entry.signals.map(String).slice(0, 8) : [];
    out.set(id, {
      commentId: id,
      aiStyle: coerceNumber(entry.ai_style ?? entry.aiStyle, byId.get(id)!.localStyleScore),
      spam: coerceNumber(entry.spam, 0),
      confidence: coerceConfidence(entry.confidence),
      humanLikely: entry.human_like === true || entry.humanLikely === true,
      reason: truncate(String(entry.reason ?? "").replace(/\s+/g, " "), 140),
      signals,
      fromCache: false,
    });
  }
  return out.size ? out : null;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?/i, (m) => (m.includes("```") ? "" : m))
    .trim();
  const direct = safeJsonParse<Record<string, unknown>>(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return safeJsonParse<Record<string, unknown>>(cleaned.slice(start, end + 1));
  return null;
}

export interface LlmCheckerDeps {
  db: DatabaseSync;
  cfg: Config;
  /** Injectable for tests. */
  post?: (url: string, init: Record<string, unknown>) => Promise<{ status: number; text: string }>;
}

export class LlmChecker {
  private db: DatabaseSync;
  private cfg: Config;
  private post: NonNullable<LlmCheckerDeps["post"]>;
  readonly unavailable: string | null;

  constructor(deps: LlmCheckerDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.post = deps.post ?? defaultPost;
    this.unavailable = this.checkAvailability();
  }

  private checkAvailability(): string | null {
    if (!this.cfg.llm.enabled) return "llm_disabled";
    if (!process.env[this.cfg.llm.apiKeyEnv]) return `missing_${this.cfg.llm.apiKeyEnv}`;
    if (!this.cfg.llm.baseUrl || !this.cfg.llm.model) return "llm_unconfigured";
    return null;
  }

  /**
   * Score grey-band replies. Anything the model cannot be asked about returns
   * without a verdict, and the caller keeps the Layer 1 number.
   */
  async check(items: GreyItem[], signal?: AbortSignal): Promise<LlmBatchResult> {
    const result: LlmBatchResult = {
      verdicts: new Map(),
      usage: { calls: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      halted: null,
      errors: [],
    };
    if (!items.length) return result;
    if (this.unavailable) {
      result.halted = this.unavailable;
      return result;
    }

    // Per-item cache: a re-scan of the same thread costs zero requests.
    const uncached: GreyItem[] = [];
    for (const item of items) {
      const hit = getLlmCached<Record<string, unknown>>(
        this.db,
        llmCacheKey(this.cfg, `item:${PROMPT_VERSION}`, cachePayload(this.cfg, [item])),
      );
      const verdict = hit ? parseVerdicts(JSON.stringify({ items: [hit.verdict] }), [item])?.get(item.commentId) : null;
      if (verdict) {
        verdict.fromCache = true;
        result.verdicts.set(item.commentId, verdict);
        result.usage.cacheHits++;
      } else {
        uncached.push(item);
      }
    }

    // Batches are capped by both item count and payload size; the root post is
    // repeated in every request, so it counts against the first item only.
    const batches: GreyItem[][] = [];
    let current: GreyItem[] = [];
    let chars = 0;
    for (const item of uncached) {
      const size = Math.min(700, item.replyText.length) + (current.length ? 0 : Math.min(600, item.rootText.length) + 1200);
      if (current.length && (current.length >= this.cfg.llm.batchSize || chars + size > this.cfg.llm.maxBatchChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += size;
    }
    if (current.length) batches.push(current);

    for (const batch of batches) {
      if (signal?.aborted) {
        result.halted = "aborted";
        break;
      }
      if (!batch.length) continue;
      const planned = budgetTokens(this.cfg, batch);
      const budget = checkLlmBudget(this.db, this.cfg, planned);
      if (!budget.ok) {
        result.halted = budget.reason;
        logEvent(this.db, "warn", "llm_budget_halted", { reason: budget.reason, remaining: batch.length });
        break;
      }

      const attempt = await this.callOnce(batch, planned, signal, result);
      if (!attempt) continue;
      if (attempt.verdicts) {
        for (const verdict of attempt.verdicts.values()) result.verdicts.set(verdict.commentId, verdict);
        for (const item of batch) {
          const v = attempt.verdicts.get(item.commentId);
          if (!v) continue;
          putLlmCached(
            this.db,
            llmCacheKey(this.cfg, `item:${PROMPT_VERSION}`, cachePayload(this.cfg, [item])),
            { id: v.commentId, ai_style: v.aiStyle, spam: v.spam, confidence: v.confidence, human_like: v.humanLikely, signals: v.signals, reason: v.reason },
            this.cfg,
            `item:${PROMPT_VERSION}`,
            { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          );
        }
      } else if (attempt.error) {
        result.errors.push(attempt.error);
      }
    }

    return result;
  }

  private async callOnce(
    batch: GreyItem[],
    planned: number,
    signal: AbortSignal | undefined,
    result: LlmBatchResult,
  ): Promise<{ verdicts?: Map<string, LlmVerdict>; error?: string; tokensIn: number; tokensOut: number; costUsd: number } | null> {
    const url = `${this.cfg.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.cfg.llm.model,
      temperature: this.cfg.llm.temperature,
      max_tokens: Math.min(this.cfg.llm.maxOutputTokens, 80 + batch.length * 70),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(batch) },
      ],
    };
    const key = process.env[this.cfg.llm.apiKeyEnv] ?? "";

    for (let attempt = 0; attempt <= this.cfg.llm.retries; attempt++) {
      if (signal?.aborted) return { error: "aborted", tokensIn: 0, tokensOut: 0, costUsd: 0 };
      let text = "";
      let status = 0;
      try {
        const res = await this.post(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            "user-agent": this.cfg.fetch.userAgent,
          },
          body: JSON.stringify(body),
          signal,
        });
        status = res.status;
        text = res.text;
      } catch (err) {
        const msg = `${err instanceof Error ? err.name : "http_error"}: ${truncate(String((err as Error)?.message ?? err), 120)}`;
        if (attempt < this.cfg.llm.retries) {
          await sleep(Math.min(8000, 1000 * 2 ** attempt), signal);
          continue;
        }
        return { error: truncate(msg, 160), tokensIn: 0, tokensOut: 0, costUsd: 0 };
      }

      if (status === 429 || status >= 500) {
        if (attempt < this.cfg.llm.retries) {
          await sleep(Math.min(30000, this.cfg.llm.timeoutMs / 2 * (attempt + 1)), signal);
          continue;
        }
        return { error: `http_${status}`, tokensIn: 0, tokensOut: 0, costUsd: 0 };
      }
      if (status === 401 || status === 403) return { error: `auth_${status}`, tokensIn: 0, tokensOut: 0, costUsd: 0 };
      if (status < 200 || status >= 300) return { error: `http_${status}: ${truncate(text, 120)}`, tokensIn: 0, tokensOut: 0, costUsd: 0 };

      const json = safeJsonParse<{
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>(text);
      if (!json) return { error: "malformed_response", tokensIn: 0, tokensOut: 0, costUsd: 0 };
      const content = json.choices?.[0]?.message?.content ?? "";
      const tokensIn = Number(json.usage?.prompt_tokens ?? Math.ceil(planned * 0.8));
      const tokensOut = Number(json.usage?.completion_tokens ?? Math.ceil(content.length / 3.5));
      const costUsd = Number(price(this.cfg, tokensIn, tokensOut).toFixed(6));
      const verdicts = parseVerdicts(content, batch);
      if (!verdicts) {
        if (attempt < this.cfg.llm.retries) {
          await sleep(500, signal);
          continue;
        }
        return { error: "unparseable_verdict", tokensIn, tokensOut, costUsd };
      }
      addLlmUsage(this.db, this.cfg, { calls: 1, tokensIn, tokensOut, costUsd });
      result.usage.calls++;
      result.usage.tokensIn += tokensIn;
      result.usage.tokensOut += tokensOut;
      result.usage.costUsd = Number((result.usage.costUsd + costUsd).toFixed(6));
      return { verdicts, tokensIn, tokensOut, costUsd };
    }
    return null;
  }
}

async function defaultPost(url: string, init: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, init as RequestInit);
  return { status: res.status, text: await res.text() };
}

/**
 * Layer 3 combination (spec §四 Layer 3). The LLM is trusted in the grey band
 * because that band is exactly where Layer 1 said "I don't know"; outside it the
 * cheap layer keeps authority so a model hiccup cannot move a verdict.
 */
export function combineScores(
  localScore: number,
  localFamilies: string[],
  verdict: LlmVerdict | null,
  cfg: Config,
): { aiStyleScore: number; confidence: number; llmUsed: boolean } {
  if (!verdict) return { aiStyleScore: localScore, confidence: 0, llmUsed: false };
  const [lo, hi] = cfg.llm.greyZone;
  const inGrey = localScore >= lo && localScore < hi;
  const w = inGrey ? 0.65 : 0.4;
  let combined = localScore * (1 - w) + verdict.aiStyle * w;

  // Two or more independent local families are corroborating evidence; a single
  // model opinion should not be able to erase them.
  if (localFamilies.length >= 2 && verdict.aiStyle < 40) combined = Math.max(combined, (localScore + verdict.aiStyle) / 2);
  // A chat-leak phrase is factual, not stylistic — keep the floor.
  if (localFamilies.includes("chat_leak")) combined = Math.max(combined, 60);
  // Explicit human judgement from the model overrides a weak local sniff.
  if (verdict.humanLikely && verdict.confidence >= 0.7 && localScore < cfg.thresholds.deepScanMin) {
    combined = Math.min(combined, Math.max(lo - 1, verdict.aiStyle));
  }
  const agree = Math.abs(localScore - verdict.aiStyle) <= 20;
  const confidence = clamp(verdict.confidence * (agree ? 1 : 0.75) + (agree ? 0.1 : 0), 0, 1);
  return { aiStyleScore: Math.round(clamp(combined)), confidence: Number(confidence.toFixed(3)), llmUsed: true };
}
