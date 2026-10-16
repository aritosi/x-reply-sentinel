import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunMode } from "./types.ts";

export interface Config {
  /** Guardrail default: nothing destructive happens until the operator opts in. */
  mode: RunMode;
  timezone: string;
  dataDir: string;
  reportDir: string;
  auditLog: string;
  whitelistFile: string;
  fetch: {
    provider: "auto" | "api" | "syndication" | "session" | "file" | "fixture";
    /** Per-post reply ceiling for one scan. */
    maxRepliesPerPost: number;
    /** Hard ceiling on pages walked per run, so a stuck cursor cannot spin. */
    maxPagesPerRun: number;
    pageDelayMs: number;
    pageJitterMs: number;
    maxRequestsPerDay: number;
    timeoutMs: number;
    retries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    proxyUrl: string;
    userAgent: string;
    /** Import-file fallback (browser export / manual JSON). */
    importFile: string;
    fixtureFile: string;
    /** Env var names only — credentials are never stored in config or the DB. */
    bearerTokenEnv: string;
    authTokenEnv: string;
    ct0Env: string;
    /** Env var holding the operator's own handle, so "my posts" can be tagged. */
    selfHandleEnv: string;
    /** GraphQL document ids rotate; overridable so a broken build is fixable without a code change. */
    tweetDetailQueryId: string;
    userTweetsQueryId: string;
  };
  llm: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    temperature: number;
    batchSize: number;
    maxBatchChars: number;
    timeoutMs: number;
    retries: number;
    /** Only replies whose local style score falls inside this band reach the model. */
    greyZone: [number, number];
    maxCallsPerDay: number;
    maxTokensPerDay: number;
    maxCostPerDayUsd: number;
    /** USD per 1M tokens; keeps the budget ledger honest without an API quota call. */
    priceInputUsdPerMTok: number;
    priceOutputUsdPerMTok: number;
    maxOutputTokens: number;
  };
  thresholds: {
    deepScanMin: number;
    reviewMin: number;
    banMinSpamScore: number;
    banMinIndependentSignals: number;
    banMinConfidence: number;
    deepScanMaxAccountsPerDay: number;
    profileTweetCount: number;
    minConfidenceToRecord: number;
  };
  risk: {
    halfLifeDays: number;
    /** No single evidence kind may dominate the score. */
    maxContributionPerKind: number;
    repeatBonusPerExtraHit: number;
    repeatBonusCap: number;
    /** Evidence older than this is dropped from the score entirely. */
    maxAgeDays: number;
    humanCorrectionWeight: number;
  };
  actions: {
    maxPerDay: number;
    maxPerHour: number;
    minIntervalMs: number;
    jitterMs: number;
    /** Evidence kinds that, on their own, never justify a block. */
    styleOnlyKinds: string[];
    /** Kinds that count toward the independent-evidence requirement. */
    banEligibleKinds: string[];
  };
  schedule: {
    watchIntervalHours: number;
    dailyReportHour: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  mode: "dry-run",
  timezone: "Asia/Shanghai",
  dataDir: "~/.x-reply-sentinel",
  reportDir: "reports",
  auditLog: "audit/actions.jsonl",
  whitelistFile: "whitelist.json",
  fetch: {
    provider: "auto",
    maxRepliesPerPost: 300,
    maxPagesPerRun: 40,
    pageDelayMs: 2500,
    pageJitterMs: 1500,
    maxRequestsPerDay: 300,
    timeoutMs: 20000,
    retries: 3,
    backoffBaseMs: 5000,
    backoffMaxMs: 300000,
    proxyUrl: "",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    importFile: "",
    fixtureFile: "",
    bearerTokenEnv: "XRS_X_BEARER_TOKEN",
    authTokenEnv: "XRS_X_AUTH_TOKEN",
    ct0Env: "XRS_X_CT0",
    selfHandleEnv: "XRS_X_SELF_HANDLE",
    tweetDetailQueryId: "",
    userTweetsQueryId: "",
  },
  llm: {
    enabled: true,
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    apiKeyEnv: "XRS_LLM_API_KEY",
    temperature: 0,
    batchSize: 20,
    maxBatchChars: 24000,
    timeoutMs: 60000,
    retries: 2,
    greyZone: [18, 82],
    maxCallsPerDay: 20,
    maxTokensPerDay: 200000,
    maxCostPerDayUsd: 0.5,
    priceInputUsdPerMTok: 0.27,
    priceOutputUsdPerMTok: 1.1,
    maxOutputTokens: 2000,
  },
  thresholds: {
    deepScanMin: 70,
    reviewMin: 50,
    banMinSpamScore: 85,
    banMinIndependentSignals: 2,
    banMinConfidence: 0.8,
    deepScanMaxAccountsPerDay: 10,
    profileTweetCount: 30,
    minConfidenceToRecord: 0.4,
  },
  risk: {
    halfLifeDays: 30,
    maxContributionPerKind: 30,
    repeatBonusPerExtraHit: 3,
    repeatBonusCap: 12,
    maxAgeDays: 180,
    humanCorrectionWeight: -40,
  },
  actions: {
    maxPerDay: 20,
    maxPerHour: 5,
    minIntervalMs: 90000,
    jitterMs: 60000,
    styleOnlyKinds: [
      "lexicon_slop",
      "template_structure",
      "praise_opener",
      "engagement_question",
      "restatement",
      "formatting_tells",
      "low_specificity",
      "flat_rhythm",
      "chat_leak",
      "llm_semantic",
    ],
    banEligibleKinds: [
      "duplicate_content",
      "spam_ring",
      "scam_link",
      "repeat_marketing",
      "marketing_link",
      "profile_signal",
      "llm_spam_verdict",
    ],
  },
  schedule: {
    watchIntervalHours: 6,
    dailyReportHour: 9,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface RawConfig extends DeepPartial<Config> {
  env?: Record<string, string>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mergeConfig(base: Config, patch: DeepPartial<Config>): Config {
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeConfig(out[k] as unknown as Config, v as DeepPartial<Config>);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as Config;
}

export function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const ENV_MAP: Array<[string, string[], (v: string) => unknown]> = [
  ["XRS_MODE", ["mode"], (v) => v],
  ["XRS_DATA_DIR", ["dataDir"], (v) => v],
  ["XRS_PROVIDER", ["fetch", "provider"], (v) => v],
  ["XRS_PROXY_URL", ["fetch", "proxyUrl"], (v) => v],
  ["XRS_IMPORT_FILE", ["fetch", "importFile"], (v) => v],
  ["XRS_FIXTURE_FILE", ["fetch", "fixtureFile"], (v) => v],
  ["XRS_MAX_REPLIES", ["fetch", "maxRepliesPerPost"], (v) => Number(v)],
  ["XRS_MAX_REQUESTS_PER_DAY", ["fetch", "maxRequestsPerDay"], (v) => Number(v)],
  ["XRS_LLM_ENABLED", ["llm", "enabled"], (v) => v !== "0" && v.toLowerCase() !== "false"],
  ["XRS_LLM_BASE_URL", ["llm", "baseUrl"], (v) => v],
  ["XRS_LLM_MODEL", ["llm", "model"], (v) => v],
  ["XRS_LLM_API_KEY_ENV", ["llm", "apiKeyEnv"], (v) => v],
  ["XRS_LLM_BATCH_SIZE", ["llm", "batchSize"], (v) => Number(v)],
  ["XRS_LLM_MAX_CALLS_PER_DAY", ["llm", "maxCallsPerDay"], (v) => Number(v)],
  ["XRS_LLM_MAX_TOKENS_PER_DAY", ["llm", "maxTokensPerDay"], (v) => Number(v)],
  ["XRS_LLM_MAX_COST_PER_DAY_USD", ["llm", "maxCostPerDayUsd"], (v) => Number(v)],
  ["XRS_GREY_ZONE_LOW", ["llm", "greyZone", "0"], (v) => Number(v)],
  ["XRS_GREY_ZONE_HIGH", ["llm", "greyZone", "1"], (v) => Number(v)],
  ["XRS_DEEP_SCAN_MIN", ["thresholds", "deepScanMin"], (v) => Number(v)],
  ["XRS_REVIEW_MIN", ["thresholds", "reviewMin"], (v) => Number(v)],
  ["XRS_BAN_MIN_SPAM_SCORE", ["thresholds", "banMinSpamScore"], (v) => Number(v)],
  ["XRS_MAX_BLOCKS_PER_DAY", ["actions", "maxPerDay"], (v) => Number(v)],
  ["XRS_HALF_LIFE_DAYS", ["risk", "halfLifeDays"], (v) => Number(v)],
];

function setPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

export interface LoadOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveConfigPath(opts: LoadOptions, env: NodeJS.ProcessEnv): string {
  if (opts.configPath) return expandPath(opts.configPath);
  if (env.XRS_CONFIG) return expandPath(env.XRS_CONFIG);
  const cwd = opts.cwd ?? process.cwd();
  const local = path.join(cwd, "config.json");
  if (fs.existsSync(local)) return local;
  return path.join(expandPath(DEFAULT_CONFIG.dataDir), "config.json");
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  let cfg = structuredClone(DEFAULT_CONFIG);
  const file = resolveConfigPath(opts, env);
  if (file && fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawConfig;
    const { env: extraEnv, ...patch } = raw;
    cfg = mergeConfig(cfg, patch);
    for (const [k, v] of Object.entries(extraEnv ?? {})) {
      if (env[k] === undefined) env[k] = v;
    }
  }
  for (const [name, parts, cast] of ENV_MAP) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    setPath(cfg as unknown as Record<string, unknown>, parts, cast(v));
  }
  cfg.dataDir = expandPath(cfg.dataDir);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const problems: string[] = [];
  if (!["dry-run", "review", "auto"].includes(cfg.mode)) problems.push(`mode=${cfg.mode}`);
  if (cfg.thresholds.reviewMin >= cfg.thresholds.deepScanMin) problems.push("reviewMin must be < deepScanMin");
  if (cfg.llm.greyZone[0] > cfg.llm.greyZone[1]) problems.push("greyZone low > high");
  if (cfg.risk.halfLifeDays <= 0) problems.push("halfLifeDays must be > 0");
  if (cfg.actions.maxPerDay > 200) problems.push("actions.maxPerDay above 200 is refused (platform risk-control policy)");
  if (cfg.fetch.maxRepliesPerPost > 2000) problems.push("fetch.maxRepliesPerPost above 2000 is refused");
  if (problems.length) throw new Error("invalid config: " + problems.join("; "));
}

export function ensureDirs(cfg: Config): void {
  for (const dir of [cfg.dataDir, path.join(cfg.dataDir, cfg.reportDir), path.join(cfg.dataDir, path.dirname(cfg.auditLog))]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function dbPath(cfg: Config): string {
  return path.join(cfg.dataDir, "sentinel.sqlite");
}

export function loadWhitelist(cfg: Config): string[] {
  const file = path.isAbsolute(cfg.whitelistFile)
    ? cfg.whitelistFile
    : path.join(cfg.dataDir, cfg.whitelistFile);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const arr = Array.isArray(raw) ? raw : (raw as { ids?: string[] }).ids ?? [];
  return arr.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
}

const SECRET_KEYS = ["api_key", "apikey", "token", "cookie", "secret", "password", "auth_token", "ct0", "proxy"];

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  // Bearer tokens and long opaque secrets appearing after a secret-ish key.
  out = out.replace(/(authorization["'\s:=]+)(?:bearer\s+)?[A-Za-z0-9._\-]{12,}/gi, "$1[redacted]");
  for (const key of SECRET_KEYS) {
    out = out.replace(new RegExp(`(${key}["'\\s:=]+)[^"',;&\\s]{6,}`, "gi"), "$1[redacted]");
  }
  // Cookie pairs like key=value
  out = out.replace(/\b([A-Za-z0-9_\-]{3,24})=([A-Za-z0-9_%\-\.=]{16,})/g, "$1=[redacted]");
  return out;
}

export function redactError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redact(msg).slice(0, 500);
}
