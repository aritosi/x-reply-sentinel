#!/usr/bin/env node
/**
 * Shared HTTP plumbing for every collection provider (spec §三: 断点续扫、限流、
 * 失败重试; §九 budget). One place owns the daily request cap, backoff, jitter,
 * timeouts and secret redaction so no provider can bypass them.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Config } from "../config.ts";
import { addRequest, getBudget, logEvent } from "../db.ts";
import { randInt, sleep, truncate } from "../util.ts";
import { redactError } from "../config.ts";

export interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string>;
  json<T = unknown>(): T | null;
  rateLimited: boolean;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Overrides cfg.fetch.timeoutMs for this call. */
  timeoutMs?: number;
  /** Set for endpoints that must not burn the reply-scanning budget twice. */
  countAgainstBudget?: boolean;
}

export class RequestBudgetError extends Error {
  readonly used: number;
  readonly cap: number;

  constructor(used: number, cap: number) {
    super(`daily request cap reached (${used}/${cap})`);
    this.name = "RequestBudgetError";
    this.used = used;
    this.cap = cap;
  }
}

function headerMap(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export class Http {
  private db: DatabaseSync;
  private cfg: Config;

  constructor(db: DatabaseSync, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
  }

  private remaining(): number {
    return this.cfg.fetch.maxRequestsPerDay - getBudget(this.db, this.cfg).fetchRequests;
  }

  /**
   * GET/POST with retries. Network errors, 429 and 5xx are retried with
   * exponential backoff and jitter; 4xx (other than 429) is returned as-is so
   * the caller can distinguish "gone" from "busy".
   */
  async request(url: string, opts: RequestOptions = {}): Promise<HttpResult> {
    const count = opts.countAgainstBudget !== false;
    if (count && this.remaining() <= 0) {
      const used = this.cfg.fetch.maxRequestsPerDay - this.remaining();
      logEvent(this.db, "warn", "fetch_budget_exhausted", { url: truncate(url, 120), used });
      throw new RequestBudgetError(used, this.cfg.fetch.maxRequestsPerDay);
    }

    let lastError = "";
    for (let attempt = 0; attempt <= this.cfg.fetch.retries; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.cfg.fetch.timeoutMs);
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onAbort);
      try {
        const res = await fetch(url, {
          method: opts.method ?? "GET",
          headers: { "user-agent": this.cfg.fetch.userAgent, ...opts.headers },
          body: opts.body,
          signal: controller.signal,
        });
        if (count) addRequest(this.db, this.cfg, 1);
        const text = await res.text();
        const headers = headerMap(res);
        const rateLimited = res.status === 429 || headers["x-rate-limit-remaining"] === "0";

        if ((res.status === 429 || res.status >= 500) && attempt < this.cfg.fetch.retries) {
          lastError = `http_${res.status}`;
          await this.wait(attempt, headers["retry-after"], opts.signal);
          continue;
        }
        return {
          status: res.status,
          text,
          headers,
          rateLimited,
          json: <T>() => {
            try {
              return JSON.parse(text) as T;
            } catch {
              return null;
            }
          },
        };
      } catch (err) {
        lastError = redactError(err);
        if (attempt < this.cfg.fetch.retries) {
          await this.wait(attempt, undefined, opts.signal);
          continue;
        }
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }
    return {
      status: 0,
      text: lastError,
      headers: {},
      rateLimited: false,
      json: () => null,
    };
  }

  private async wait(attempt: number, retryAfter: string | undefined, signal?: AbortSignal): Promise<void> {
    const fromHeader = Number(retryAfter);
    const backoff = Math.min(
      this.cfg.fetch.backoffMaxMs,
      this.cfg.fetch.backoffBaseMs * 2 ** attempt + randInt(1000),
    );
    const ms = Number.isFinite(fromHeader) && fromHeader > 0 ? Math.min(fromHeader * 1000, this.cfg.fetch.backoffMaxMs) : backoff;
    await sleep(ms, signal);
  }

  /** Polite delay between pages of the same conversation. */
  async pagePause(signal?: AbortSignal): Promise<void> {
    await sleep(this.cfg.fetch.pageDelayMs + randInt(this.cfg.fetch.pageJitterMs), signal);
  }
}
