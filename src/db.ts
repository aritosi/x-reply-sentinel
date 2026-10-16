import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { Config } from "./config.ts";
import { dbPath, ensureDirs, redact } from "./config.ts";
import type { Evidence, EvidenceKind, RiskComponent, Tier, UserRisk } from "./types.ts";
import { clamp, dayRange, dayString, normalizeForHash, nowIso, sha1, sha256 } from "./util.ts";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    handle TEXT,
    text TEXT NOT NULL,
    created_at TEXT,
    fetched_at TEXT NOT NULL,
    conversation_count INTEGER,
    url TEXT,
    source TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    whitelisted INTEGER NOT NULL DEFAULT 0,
    ban_state TEXT NOT NULL DEFAULT 'none',
    blocked_at TEXT,
    tier TEXT NOT NULL DEFAULT 'observe',
    risk_score REAL NOT NULL DEFAULT 0,
    last_risk_score REAL,
    risk_updated_at TEXT,
    deep_scanned_at TEXT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    created_at TEXT,
    first_seen TEXT NOT NULL,
    url TEXT,
    lang TEXT,
    source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
  CREATE INDEX IF NOT EXISTS idx_comments_hash ON comments(text_hash);

  CREATE TABLE IF NOT EXISTS detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    rules_version TEXT NOT NULL,
    ai_style_score REAL NOT NULL,
    spam_risk_score REAL NOT NULL,
    local_style_score REAL NOT NULL,
    llm_style_score REAL,
    llm_spam_score REAL,
    confidence REAL NOT NULL,
    tier TEXT NOT NULL,
    llm_used INTEGER NOT NULL DEFAULT 0,
    signals_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    llm_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(comment_id, engine_version)
  );
  CREATE INDEX IF NOT EXISTS idx_detections_tier ON detections(tier, created_at);

  CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    weight REAL NOT NULL,
    dedup_key TEXT NOT NULL,
    detail TEXT,
    source TEXT NOT NULL,
    confidence REAL NOT NULL,
    comment_id TEXT,
    post_id TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE(user_id, dedup_key)
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_user ON evidence(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence(kind, status);

  CREATE TABLE IF NOT EXISTS risk_history (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    score REAL NOT NULL,
    components_json TEXT,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS llm_cache (
    key TEXT PRIMARY KEY,
    verdict_json TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cursors (
    post_id TEXT NOT NULL,
    module TEXT NOT NULL,
    cursor TEXT,
    complete INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (post_id, module)
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user_id TEXT NOT NULL,
    handle TEXT,
    action TEXT NOT NULL,
    mode TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    risk_score REAL,
    spam_score REAL,
    evidence_json TEXT,
    run_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts);

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    posts INTEGER NOT NULL DEFAULT 0,
    replies_fetched INTEGER NOT NULL DEFAULT 0,
    replies_new INTEGER NOT NULL DEFAULT 0,
    local_only INTEGER NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    llm_items INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    simulated INTEGER NOT NULL DEFAULT 0,
    errors_json TEXT,
    summary_json TEXT
  );

  CREATE TABLE IF NOT EXISTS budget (
    day TEXT PRIMARY KEY,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    fetch_requests INTEGER NOT NULL DEFAULT 0,
    actions INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracked_posts (
    post_id TEXT PRIMARY KEY,
    url TEXT,
    mode TEXT NOT NULL DEFAULT 'watch',
    mine INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    last_run_at TEXT,
    next_due_at TEXT
  );

  CREATE TABLE IF NOT EXISTS profile_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    bio TEXT,
    link TEXT,
    account_created TEXT,
    tweets_scanned INTEGER NOT NULL DEFAULT 0,
    duplicate_rate REAL,
    spam_score REAL,
    style_avg REAL,
    verdict TEXT,
    evidence_json TEXT,
    UNIQUE(user_id, day)
  );

  CREATE TABLE IF NOT EXISTS review_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT,
    decision TEXT,
    note TEXT,
    UNIQUE(user_id, comment_id)
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT
  );
  `,
];

export interface Db {
  raw: DatabaseSync;
  cfg: Config;
  close(): void;
}

export function openDb(cfg: Config): Db {
  // The data dir may not exist yet on a first run; node:sqlite will not create it.
  ensureDirs(cfg);
  const db = new DatabaseSync(dbPath(cfg));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return {
    raw: db,
    cfg,
    close() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
    },
  };
}

export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema v${current} is newer than this build (v${SCHEMA_VERSION})`);
  }
  for (let i = current; i < SCHEMA_VERSION; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(SCHEMA_VERSION));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)").run(nowIso());
}

// ---------- posts / users / comments ----------

export function upsertPost(
  db: DatabaseSync,
  p: { id: string; userId?: string; handle?: string; text: string; createdAt?: string; conversationCount?: number; url?: string; source?: string },
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO posts (id, user_id, handle, text, created_at, fetched_at, conversation_count, url, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       user_id = COALESCE(excluded.user_id, posts.user_id),
       handle = COALESCE(excluded.handle, posts.handle),
       fetched_at = excluded.fetched_at,
       conversation_count = COALESCE(excluded.conversation_count, posts.conversation_count)`,
  ).run(p.id, p.userId ?? null, p.handle ?? null, p.text, p.createdAt ?? null, ts, p.conversationCount ?? null, p.url ?? null, p.source ?? null);
}

export function touchUser(db: DatabaseSync, ref: { id: string; handle: string; displayName?: string }): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (id, handle, display_name, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       handle = excluded.handle,
       display_name = COALESCE(excluded.display_name, users.display_name),
       last_seen = excluded.last_seen`,
  ).run(ref.id, ref.handle.toLowerCase(), ref.displayName ?? null, ts, ts);
}

/**
 * Flip the whitelist by stable user id *or* by handle. Returns how many stored
 * accounts were actually touched, so the CLI can say when a name matches nobody
 * yet — a whitelist entry for an unseen account is recorded in the whitelist
 * file, not here.
 */
export function setWhitelisted(db: DatabaseSync, idsOrHandles: string[], on: boolean): number {
  const ts = nowIso();
  let touched = 0;
  for (const v of idsOrHandles) {
    const key = v.replace(/^@/, "").toLowerCase();
    const res = db
      .prepare("UPDATE users SET whitelisted = ?, notes = COALESCE(notes, '') || ? WHERE id = ? OR handle = ?")
      .run(on ? 1 : 0, ` ${on ? "whitelist" : "unwhitelist"}@${ts}`, key, key);
    touched += Number(res.changes ?? 0);
  }
  return touched;
}

export interface NewComment {
  id: string;
  postId: string;
  userId: string;
  handle: string;
  text: string;
  createdAt?: string;
  url?: string;
  lang?: string;
  source?: string;
}

/** Idempotent insert: returns isNew=false when this reply id was already stored. */
export function insertCommentIfNew(db: DatabaseSync, c: NewComment): boolean {
  const hash = sha1(normalizeForHash(c.text));
  const res = db
    .prepare(
      `INSERT INTO comments (id, post_id, user_id, handle, text, text_hash, created_at, first_seen, url, lang, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(c.id, c.postId, c.userId, c.handle.toLowerCase(), c.text, hash, c.createdAt ?? null, nowIso(), c.url ?? null, c.lang ?? null, c.source ?? null);
  return Number(res.changes) > 0;
}

export function commentExists(db: DatabaseSync, id: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM comments WHERE id = ?").get(id);
}

/** True when this comment already has a detection for the current engine version. */
export function hasDetection(db: DatabaseSync, commentId: string, engineVersion: string): boolean {
  return !!db
    .prepare("SELECT 1 AS x FROM detections WHERE comment_id = ? AND engine_version = ?")
    .get(commentId, engineVersion);
}

// ---------- detections ----------

export interface DetectionRow {
  comment_id: string;
  ai_style_score: number;
  spam_risk_score: number;
  confidence: number;
  tier: string;
  created_at: string;
  evidence_json: string;
  llm_used: number;
}

export function insertDetection(db: DatabaseSync, d: {
  commentId: string;
  engineVersion: string;
  rulesVersion: string;
  aiStyleScore: number;
  spamRiskScore: number;
  localStyleScore: number;
  llmStyleScore: number | null;
  llmSpamScore: number | null;
  confidence: number;
  tier: Tier;
  llmUsed: boolean;
  signals: unknown;
  evidence: Evidence[];
  llmReason?: string;
}): void {
  db.prepare(
    `INSERT INTO detections (comment_id, engine_version, rules_version, ai_style_score, spam_risk_score,
        local_style_score, llm_style_score, llm_spam_score, confidence, tier, llm_used,
        signals_json, evidence_json, llm_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(comment_id, engine_version) DO UPDATE SET
        ai_style_score = excluded.ai_style_score,
        spam_risk_score = excluded.spam_risk_score,
        confidence = excluded.confidence,
        tier = excluded.tier,
        llm_used = excluded.llm_used,
        signals_json = excluded.signals_json,
        evidence_json = excluded.evidence_json,
        llm_reason = excluded.llm_reason`,
  ).run(
    d.commentId, d.engineVersion, d.rulesVersion, d.aiStyleScore, d.spamRiskScore, d.localStyleScore,
    d.llmStyleScore, d.llmSpamScore, d.confidence, d.tier, d.llmUsed ? 1 : 0,
    JSON.stringify(d.signals), JSON.stringify(d.evidence), d.llmReason ?? null, nowIso(),
  );
}

// ---------- evidence ledger ----------

export function addEvidence(db: DatabaseSync, userId: string, ev: Evidence, ctx: { commentId?: string; postId?: string }): { created: boolean } {
  const ts = nowIso();
  const res = db
    .prepare(
      `INSERT INTO evidence (user_id, kind, weight, dedup_key, detail, source, confidence, comment_id, post_id, first_seen, last_seen, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id, dedup_key) DO UPDATE SET
         last_seen = excluded.last_seen,
         hit_count = hit_count + 1,
         weight = MAX(evidence.weight, excluded.weight),
         confidence = MAX(evidence.confidence, excluded.confidence),
         detail = COALESCE(excluded.detail, evidence.detail),
         status = 'active'`,
    )
    .run(userId, ev.kind, ev.weight, ev.key, ev.detail, ev.source, ev.confidence, ctx.commentId ?? null, ctx.postId ?? null, ts, ts);
  return { created: Number(res.changes) > 0 && Number(res.changes) === 1 && !isUpdate(res) };
}

// sqlite reports changes=1 for both insert and upsert; use a pre-check instead.
function isUpdate(_res: { changes: number | bigint; lastInsertRowid: number | bigint }): boolean {
  return false;
}

export function evidenceSeenBefore(db: DatabaseSync, userId: string, key: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM evidence WHERE user_id = ? AND dedup_key = ?").get(userId, key);
}

export function revokeEvidence(db: DatabaseSync, userId: string, kind: EvidenceKind, reason: string): number {
  const res = db
    .prepare("UPDATE evidence SET status = 'revoked', detail = detail || ? WHERE user_id = ? AND kind = ? AND status = 'active'")
    .run(` [revoked: ${reason}]`, userId, kind);
  return Number(res.changes);
}

export interface EvidenceRow {
  id: number;
  kind: string;
  weight: number;
  dedup_key: string;
  detail: string | null;
  source: string;
  confidence: number;
  last_seen: string;
  first_seen: string;
  hit_count: number;
  status: string;
}

export function activeEvidence(db: DatabaseSync, userId: string): EvidenceRow[] {
  return db
    .prepare("SELECT id, kind, weight, dedup_key, detail, source, confidence, last_seen, first_seen, hit_count, status FROM evidence WHERE user_id = ? AND status = 'active'")
    .all(userId) as unknown as EvidenceRow[];
}

// ---------- risk scoring ----------

export function decayFactor(lastSeenIso: string, now: Date, halfLifeDays: number, maxAgeDays: number): number {
  const last = Date.parse(normalizeDate(lastSeenIso));
  if (!Number.isFinite(last)) return 1;
  const ageDays = Math.max(0, (now.getTime() - last) / 86400000);
  if (ageDays > maxAgeDays) return 0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function normalizeDate(s: string): string {
  // stored as "YYYY-MM-DD HH:MM:SS" (UTC); make it parseable without TZ surprises
  return s.includes("T") ? s : s.replace(" ", "T") + "Z";
}

export interface RiskInput {
  userId: string;
  handle: string;
  whitelisted: boolean;
  banState: string;
  firstSeen: string;
  lastSeen: string;
  previousScore: number | null;
  tier: Tier;
}

export function computeRisk(
  db: DatabaseSync,
  cfg: Config,
  input: RiskInput,
  now = new Date(),
): { score: number; components: RiskComponent[]; independentSpamKinds: EvidenceKind[] } {
  const rows = activeEvidence(db, input.userId);
  const byKind = new Map<string, EvidenceRow[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  const components: RiskComponent[] = [];
  for (const [kind, list] of byKind) {
    let kindTotal = 0;
    for (const r of list) {
      const decay = decayFactor(r.last_seen, now, cfg.risk.halfLifeDays, cfg.risk.maxAgeDays);
      if (decay <= 0) continue;
      const extraHits = Math.max(0, r.hit_count - 1);
      // Repetition raises risk but is capped per key, so a bot ring cannot inflate without bound.
      const repeatBonus = Math.min(cfg.risk.repeatBonusCap, extraHits * cfg.risk.repeatBonusPerExtraHit);
      const conf = clamp(r.confidence, 0.2, 1);
      const raw = (r.weight + repeatBonus) * decay * conf;
      const contribution = Math.min(cfg.risk.maxContributionPerKind, raw);
      kindTotal += contribution;
      components.push({
        kind: kind as EvidenceKind,
        key: r.dedup_key,
        baseWeight: r.weight,
        repeatBonus,
        decayFactor: Number(decay.toFixed(3)),
        // The clamped value the product used, so `xrs explain` can show the arithmetic
        // that produced the score instead of just the result.
        confidence: Number(conf.toFixed(2)),
        contribution: Number(contribution.toFixed(2)),
        detail: r.detail ?? kind,
      });
    }
    // Per-kind cap applies to the summed contribution of that kind too.
    if (kindTotal > cfg.risk.maxContributionPerKind) {
      const scale = cfg.risk.maxContributionPerKind / kindTotal;
      for (const c of components) {
        if (c.kind === kind) c.contribution = Number((c.contribution * scale).toFixed(2));
      }
    }
  }
  const score = clamp(Number(components.reduce((s, c) => s + c.contribution, 0).toFixed(1)));
  const independentSpamKinds = [...new Set(
    cfg.actions.banEligibleKinds.filter((k) =>
      rows.some((r) => r.kind === k && r.source !== "local" ? true : r.kind === k),
    ),
  )] as EvidenceKind[];
  return { score, components, independentSpamKinds };
}

export function getUserRow(db: DatabaseSync, userId: string) {
  return db
    .prepare("SELECT id, handle, display_name, whitelisted, ban_state, blocked_at, tier, risk_score, last_risk_score, first_seen, last_seen, deep_scanned_at FROM users WHERE id = ?")
    .get(userId) as unknown as UserRow | undefined;
}

export interface UserRow {
  id: string;
  handle: string;
  display_name: string | null;
  whitelisted: number;
  ban_state: string;
  blocked_at: string | null;
  tier: string;
  risk_score: number;
  last_risk_score: number | null;
  first_seen: string;
  last_seen: string;
  deep_scanned_at: string | null;
}

export function recordRisk(db: DatabaseSync, cfg: Config, input: RiskInput, now = new Date()): UserRisk {
  const { score, components, independentSpamKinds } = computeRisk(db, cfg, input, now);
  const prev = input.previousScore ?? 0;
  const day = dayString(now, cfg.timezone);
  db.prepare(
    `INSERT INTO risk_history (user_id, day, score, components_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET score = excluded.score, components_json = excluded.components_json`,
  ).run(input.userId, day, score, JSON.stringify(components));
  db.prepare("UPDATE users SET risk_score = ?, last_risk_score = ?, risk_updated_at = ? WHERE id = ?")
    .run(score, prev, nowIso(), input.userId);
  return {
    userId: input.userId,
    handle: input.handle,
    riskScore: score,
    previousRiskScore: prev,
    delta: Number((score - prev).toFixed(1)),
    components,
    tier: input.tier,
    whitelisted: input.whitelisted,
    banState: input.banState as UserRisk["banState"],
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen,
    evidenceKinds: [...new Set(components.map((c) => c.kind))],
    independentSpamKinds,
  };
}

export function setUserTier(db: DatabaseSync, userId: string, tier: Tier): void {
  db.prepare("UPDATE users SET tier = ? WHERE id = ? AND tier <> ?").run(tier, userId, tier);
}

export function setBanState(db: DatabaseSync, userId: string, state: string): void {
  db.prepare("UPDATE users SET ban_state = ?, blocked_at = ? WHERE id = ?")
    .run(state, state === "blocked" ? nowIso() : null, userId);
}

export function markDeepScanned(db: DatabaseSync, userId: string, at = new Date()): void {
  db.prepare("UPDATE users SET deep_scanned_at = ? WHERE id = ?").run(nowIso(at), userId);
}

/**
 * Deep scans actually performed today, counted per account. The daily report uses
 * the same event, so the cap and the report cannot disagree.
 */
export function deepScansToday(db: DatabaseSync, cfg: Config, now = new Date()): number {
  const { from, to } = dayRange(dayString(now, cfg.timezone), cfg.timezone);
  const r = db
    .prepare("SELECT COUNT(DISTINCT json_extract(detail, '$.user')) AS n FROM scan_log WHERE event = 'deepscan_done' AND ts >= ? AND ts < ?")
    .get(from, to) as { n: number };
  return Number(r.n);
}

// ---------- llm cache ----------

export function llmCacheKey(cfg: Config, promptVersion: string, payload: string): string {
  return sha256(`${cfg.llm.model}|${promptVersion}|${normalizeForHash(payload)}`);
}

export function getLlmCached<T>(db: DatabaseSync, key: string): { verdict: T; hits: number } | null {
  const row = db.prepare("SELECT verdict_json, hits FROM llm_cache WHERE key = ?").get(key) as
    | { verdict_json: string; hits: number }
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE llm_cache SET hits = hits + 1 WHERE key = ?").run(key);
  try {
    return { verdict: JSON.parse(row.verdict_json) as T, hits: row.hits + 1 };
  } catch {
    return null;
  }
}

export function putLlmCached(db: DatabaseSync, key: string, verdict: unknown, cfg: Config, promptVersion: string, usage: { tokensIn: number; tokensOut: number; costUsd: number }): void {
  db.prepare(
    `INSERT INTO llm_cache (key, verdict_json, model, prompt_version, tokens_in, tokens_out, cost_usd, created_at, hits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET verdict_json = excluded.verdict_json`,
  ).run(key, JSON.stringify(verdict), cfg.llm.model, promptVersion, usage.tokensIn, usage.tokensOut, usage.costUsd, nowIso());
}

export function cacheStats(db: DatabaseSync): { entries: number; hits: number } {
  const r = db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM llm_cache").get() as {
    entries: number;
    hits: number;
  };
  return { entries: Number(r.entries), hits: Number(r.hits) };
}

// ---------- cursors / resume ----------

export function getCursor(db: DatabaseSync, postId: string, module: string): { cursor: string | null; complete: boolean; lastRun: string | null } {
  const row = db.prepare("SELECT cursor, complete, last_run_at FROM cursors WHERE post_id = ? AND module = ?").get(postId, module) as
    | { cursor: string | null; complete: number; last_run_at: string | null }
    | undefined;
  if (!row) return { cursor: null, complete: false, lastRun: null };
  return { cursor: row.cursor, complete: !!row.complete, lastRun: row.last_run_at };
}

export function setCursor(db: DatabaseSync, postId: string, module: string, cursor: string | null, complete: boolean): void {
  db.prepare(
    `INSERT INTO cursors (post_id, module, cursor, complete, last_run_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id, module) DO UPDATE SET cursor = excluded.cursor, complete = excluded.complete,
       last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
  ).run(postId, module, cursor, complete ? 1 : 0, nowIso(), nowIso());
}

export interface PostRow {
  id: string;
  user_id: string | null;
  handle: string | null;
  text: string;
  created_at: string | null;
  conversation_count: number | null;
  url: string | null;
}

/** A previously stored root post, used when the current transport cannot re-read it. */
export function getPost(db: DatabaseSync, id: string): PostRow | undefined {
  return db.prepare("SELECT id, user_id, handle, text, created_at, conversation_count, url FROM posts WHERE id = ?")
    .get(id) as unknown as PostRow | undefined;
}

export interface StoredReplyRow {
  id: string;
  post_id: string;
  user_id: string;
  handle: string;
  text: string;
  created_at: string | null;
  url: string | null;
  lang: string | null;
  source: string | null;
}

/**
 * Replies we already hold for a thread but never scored with the current engine.
 * A run that crashed after inserting pages must not leave them unscored forever.
 */
export function storedRepliesWithoutDetection(
  db: DatabaseSync,
  postId: string,
  engineVersion: string,
  limit = 200,
): StoredReplyRow[] {
  return db
    .prepare(
      `SELECT c.id, c.post_id, c.user_id, c.handle, c.text, c.created_at, c.url, c.lang, c.source
         FROM comments c
         WHERE c.post_id = ? AND NOT EXISTS (SELECT 1 FROM detections d WHERE d.comment_id = c.id AND d.engine_version = ?)
         ORDER BY c.first_seen LIMIT ?`,
    )
    .all(postId, engineVersion, limit) as unknown as StoredReplyRow[];
}

export function oldestUnprocessed(db: DatabaseSync): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM comments c WHERE NOT EXISTS (SELECT 1 FROM detections d WHERE d.comment_id = c.id)")
    .get() as { n: number };
  return Number(r.n);
}

// ---------- budget ----------

export function getBudget(db: DatabaseSync, cfg: Config, now = new Date()): import("./types.ts").BudgetState {
  const day = dayString(now, cfg.timezone);
  const row = db
    .prepare("SELECT day, llm_calls, tokens_in, tokens_out, cost_usd, fetch_requests, actions FROM budget WHERE day = ?")
    .get(day) as Omit<import("./types.ts").BudgetState, "tokensIn" | "tokensOut" | "costUsd" | "llmCalls" | "fetchRequests" | "actions"> & {
      llm_calls: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      fetch_requests: number;
      actions: number;
    } | undefined;
  if (!row) return { day, llmCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fetchRequests: 0, actions: 0 };
  return {
    day: row.day,
    llmCalls: Number(row.llm_calls),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    costUsd: Number(row.cost_usd),
    fetchRequests: Number(row.fetch_requests),
    actions: Number(row.actions),
  };
}

function bump(db: DatabaseSync, cfg: Config, cols: Partial<Record<keyof import("./types.ts").BudgetState, number>>): void {
  const day = dayString(new Date(), cfg.timezone);
  const keys = Object.keys(cols).filter((k) => k !== "day") as Array<keyof typeof cols>;
  const map: Record<string, string> = {
    llmCalls: "llm_calls",
    tokensIn: "tokens_in",
    tokensOut: "tokens_out",
    costUsd: "cost_usd",
    fetchRequests: "fetch_requests",
    actions: "actions",
  };
  const insertCols = ["day"];
  const insertVals: Array<string | number> = [day];
  const updates: string[] = [];
  for (const k of keys) {
    const col = map[k];
    if (!col) continue;
    insertCols.push(col);
    insertVals.push(cols[k] ?? 0);
    updates.push(`${col} = ${col} + ?`);
  }
  const conflictVals = keys.map((k) => cols[k] ?? 0);
  db.prepare(
    `INSERT INTO budget (${insertCols.join(", ")}, updated_at) VALUES (${insertCols.map(() => "?").join(", ")}, ?)
     ON CONFLICT(day) DO UPDATE SET ${updates.join(", ")}, updated_at = excluded.updated_at`,
  ).run(...insertVals, nowIso(), ...conflictVals);
}

export function addLlmUsage(db: DatabaseSync, cfg: Config, u: { calls: number; tokensIn: number; tokensOut: number; costUsd: number }): void {
  bump(db, cfg, { llmCalls: u.calls, tokensIn: u.tokensIn, tokensOut: u.tokensOut, costUsd: u.costUsd });
}

export function addRequest(db: DatabaseSync, cfg: Config, n = 1): void {
  bump(db, cfg, { fetchRequests: n });
}

export function addActionCost(db: DatabaseSync, cfg: Config): void {
  bump(db, cfg, { actions: 1 });
}

export interface BudgetVerdict {
  ok: boolean;
  reason: string | null;
}

export function checkLlmBudget(db: DatabaseSync, cfg: Config, plannedTokens: number): BudgetVerdict {
  if (!cfg.llm.enabled) return { ok: false, reason: "llm_disabled" };
  const b = getBudget(db, cfg);
  if (b.llmCalls >= cfg.llm.maxCallsPerDay) return { ok: false, reason: "daily_llm_calls" };
  if (b.tokensIn + b.tokensOut + plannedTokens > cfg.llm.maxTokensPerDay) return { ok: false, reason: "daily_tokens" };
  if (b.costUsd >= cfg.llm.maxCostPerDayUsd) return { ok: false, reason: "daily_cost" };
  return { ok: true, reason: null };
}

// ---------- actions / runs ----------

export function logAction(db: DatabaseSync, a: {
  userId: string;
  handle?: string;
  action: string;
  mode: string;
  ok: boolean;
  status: string;
  reason?: string;
  riskScore?: number;
  spamScore?: number;
  evidence?: Evidence[];
  runId?: number;
}): void {
  // Free text here can carry a provider error line, and provider error lines can
  // carry the credential that failed. Credentials never reach the database (§十二).
  db.prepare(
    `INSERT INTO actions (ts, user_id, handle, action, mode, ok, status, reason, risk_score, spam_score, evidence_json, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(nowIso(), a.userId, a.handle ?? null, a.action, a.mode, a.ok ? 1 : 0, a.status, a.reason ? redact(a.reason) : null,
    a.riskScore ?? null, a.spamScore ?? null, a.evidence ? redact(JSON.stringify(a.evidence)) : null, a.runId ?? null);
}

/**
 * Only rows that represent a real platform write. A refused or dry-run
 * simulated decision is an audit record, not a rate-limit event — counting those
 * would let a long list of *non*-actions lock the tool out of acting at all.
 */
export const EXECUTED_ACTION = "status IN ('blocked', 'already')";

export function actionsToday(db: DatabaseSync, cfg: Config, action: string): number {
  const { from, to } = dayRange(dayString(new Date(), cfg.timezone), cfg.timezone);
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM actions WHERE ts >= ? AND ts < ? AND action = ? AND ${EXECUTED_ACTION}`)
    .get(from, to, action) as { n: number };
  return Number(r.n);
}

export function lastActionAt(db: DatabaseSync, action: string): string | null {
  const r = db
    .prepare(`SELECT ts FROM actions WHERE action = ? AND ${EXECUTED_ACTION} ORDER BY id DESC LIMIT 1`)
    .get(action) as { ts: string } | undefined;
  return r ? r.ts : null;
}

export function startRun(db: DatabaseSync, kind: string): number {
  const res = db.prepare("INSERT INTO runs (kind, started_at) VALUES (?, ?)").run(kind, nowIso());
  return Number(res.lastInsertRowid);
}

export function finishRun(db: DatabaseSync, id: number, s: Record<string, unknown>): void {
  const json = redact(JSON.stringify(s));
  db.prepare(
    `UPDATE runs SET finished_at = ?, posts = ?, replies_fetched = ?, replies_new = ?, local_only = ?,
        llm_calls = ?, llm_items = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, blocked = ?, simulated = ?,
        errors_json = ?, summary_json = ? WHERE id = ?`,
  ).run(
    nowIso(),
    Number(s.posts ?? 0), Number(s.repliesFetched ?? 0), Number(s.repliesNew ?? 0), Number(s.localOnly ?? 0),
    Number(s.llmCalls ?? 0), Number(s.llmItems ?? 0), Number(s.tokensIn ?? 0), Number(s.tokensOut ?? 0),
    Number(s.costUsd ?? 0), Number(s.blocked ?? 0), Number(s.simulated ?? 0),
    JSON.stringify(s.errors ?? []), json, id,
  );
}

export function logEvent(db: DatabaseSync, level: string, event: string, detail?: unknown): void {
  db.prepare("INSERT INTO scan_log (ts, level, event, detail) VALUES (?, ?, ?, ?)")
    .run(nowIso(), level, event, detail === undefined ? null : redact(JSON.stringify(detail)).slice(0, 4000));
}

// ---------- tracked posts ----------

export function trackPost(db: DatabaseSync, postId: string, opts: { url?: string; mode?: string; mine?: boolean; nextDue?: string }): void {
  db.prepare(
    `INSERT INTO tracked_posts (post_id, url, mode, mine, active, added_at, next_due_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET url = COALESCE(excluded.url, tracked_posts.url),
        mode = excluded.mode, mine = excluded.mine, active = 1, next_due_at = COALESCE(excluded.next_due_at, tracked_posts.next_due_at)`,
  ).run(postId, opts.url ?? null, opts.mode ?? "watch", opts.mine ? 1 : 0, nowIso(), opts.nextDue ?? null);
}

export function dueTracked(db: DatabaseSync, now = new Date()): Array<{ post_id: string; url: string | null; mine: number }> {
  const ts = nowIso(now);
  return db.prepare(
    "SELECT post_id, url, mine FROM tracked_posts WHERE active = 1 AND (next_due_at IS NULL OR next_due_at <= ?) ORDER BY next_due_at IS NULL DESC, next_due_at",
  ).all(ts) as unknown as Array<{ post_id: string; url: string | null; mine: number }>;
}

export function bumpTracked(db: DatabaseSync, postId: string, nextDue: string): void {
  db.prepare("UPDATE tracked_posts SET last_run_at = ?, next_due_at = ? WHERE post_id = ?")
    .run(nowIso(), nextDue, postId);
}

// ---------- review queue ----------

export function enqueueReview(db: DatabaseSync, userId: string, commentId: string, postId: string): void {
  db.prepare(
    `INSERT INTO review_items (user_id, comment_id, post_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, comment_id) DO NOTHING`,
  ).run(userId, commentId, postId, nowIso());
}

export function decideReview(db: DatabaseSync, id: number, decision: string, note: string): void {
  db.prepare("UPDATE review_items SET status = 'decided', decided_at = ?, decision = ?, note = ? WHERE id = ?")
    .run(nowIso(), decision, note, id);
}

/**
 * Close a user's queued items when the system itself dealt with them (a real
 * block). Left open, the human queue would keep asking for a decision that has
 * already been made and the pending count would drift upward forever.
 */
export function resolveReviewForUser(db: DatabaseSync, userId: string, decision: string, note: string): number {
  const res = db
    .prepare("UPDATE review_items SET status = 'decided', decided_at = ?, decision = ?, note = ? WHERE user_id = ? AND status = 'pending'")
    .run(nowIso(), decision, note, userId);
  return Number(res.changes ?? 0);
}

export function pendingReview(db: DatabaseSync, limit = 200): Array<{
  id: number;
  user_id: string;
  handle: string;
  comment_id: string;
  post_id: string;
  created_at: string;
  ai_style_score: number | null;
  spam_risk_score: number | null;
  text: string | null;
  evidence_json: string | null;
}> {
  return db.prepare(
    `SELECT r.id, r.user_id, u.handle, r.comment_id, r.post_id, r.created_at,
            d.ai_style_score, d.spam_risk_score, c.text, d.evidence_json
       FROM review_items r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN comments c ON c.id = r.comment_id
       LEFT JOIN detections d ON d.comment_id = r.comment_id
      WHERE r.status = 'pending'
      ORDER BY COALESCE(u.risk_score, 0) DESC, COALESCE(d.ai_style_score, 0) DESC, r.id DESC LIMIT ?`,
  ).all(limit) as unknown as ReturnType<typeof pendingReview>;
}

/** The queue can be longer than what a terminal shows; the daily count needs the total. */
export function pendingReviewCount(db: DatabaseSync): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE status = 'pending'").get() as { n: number };
  return Number(r.n);
}

// ---------- duplicate-content signals ----------

export function authorRecentTexts(
  db: DatabaseSync,
  userId: string,
  limit = 40,
  excludeId?: string,
): Array<{ id: string; text: string; post_id: string }> {
  return db
    .prepare(
      `SELECT id, text, post_id FROM comments WHERE user_id = ?1 AND (?2 = '' OR id <> ?2)
        ORDER BY first_seen DESC LIMIT ?3`,
    )
    .all(userId, excludeId ?? "", limit) as unknown as Array<{ id: string; text: string; post_id: string }>;
}

export function postReplyTexts(db: DatabaseSync, postId: string, limit = 300): Array<{ id: string; text: string; user_id: string }> {
  return db
    .prepare("SELECT id, text, user_id FROM comments WHERE post_id = ? ORDER BY first_seen DESC LIMIT ?")
    .all(postId, limit) as unknown as Array<{ id: string; text: string; user_id: string }>;
}

/** Accounts that replied more than once in the same thread — a spam-ring tell. */
export function repeatAuthorsInThread(db: DatabaseSync, postId: string): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM (SELECT user_id FROM comments WHERE post_id = ? GROUP BY user_id HAVING COUNT(*) > 1)")
    .get(postId) as { n: number };
  return Number(r.n);
}

/**
 * How many of this account's replies are byte-identical (after normalisation)
 * to a reply posted by a *different* account we have stored. This is verifiable
 * coordination evidence, not style, and it is one of the few signals allowed to
 * justify a block.
 */
export function crossAccountDuplicateReplies(db: DatabaseSync, userId: string): number {
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT a.id) AS n FROM comments a
        JOIN comments b ON b.text_hash = a.text_hash AND b.user_id <> a.user_id
       WHERE a.user_id = ? AND length(a.text) >= 30`,
    )
    .get(userId) as { n: number };
  return Number(r.n);
}

// ---------- queries used by the daily report ----------

export function commentsInWindow(db: DatabaseSync, cfg: Config, day: string): number {
  const { from, to } = dayRange(day, cfg.timezone);
  const r = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE first_seen >= ? AND first_seen < ?").get(from, to) as { n: number };
  return Number(r.n);
}

export function rankedUsers(db: DatabaseSync, minScore: number, limit = 200) {
  return db.prepare(
    `SELECT id, handle, display_name, risk_score, last_risk_score, tier, ban_state, whitelisted, first_seen, last_seen
       FROM users WHERE risk_score >= ? ORDER BY risk_score DESC, last_seen DESC LIMIT ?`,
  ).all(minScore, limit) as unknown as UserRow[];
}

export function latestEvidenceFor(db: DatabaseSync, userId: string, limit = 6): EvidenceRow[] {
  return db.prepare(
    "SELECT id, kind, weight, dedup_key, detail, source, confidence, last_seen, first_seen, hit_count, status FROM evidence WHERE user_id = ? AND status = 'active' ORDER BY last_seen DESC LIMIT ?",
  ).all(userId, limit) as unknown as EvidenceRow[];
}

export function latestDetectionFor(db: DatabaseSync, userId: string) {
  return db.prepare(
    `SELECT d.* FROM detections d JOIN comments c ON c.id = d.comment_id
      WHERE c.user_id = ? ORDER BY d.created_at DESC LIMIT 1`,
  ).get(userId) as unknown as (DetectionRow & { comment_id: string }) | undefined;
}

export function previousDayScore(db: DatabaseSync, cfg: Config, userId: string, day: string): number | null {
  const d = new Date(day + "T00:00:00Z");
  const prev = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  const r = db.prepare("SELECT score FROM risk_history WHERE user_id = ? AND day = ?").get(userId, prev) as
    | { score: number }
    | undefined;
  return r ? Number(r.score) : null;
}

export function pathFor(cfg: Config, rel: string): string {
  return path.join(cfg.dataDir, rel);
}
