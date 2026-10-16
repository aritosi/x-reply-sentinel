#!/usr/bin/env node
/**
 * Import-file provider (spec §三 manual mode fallback, §十三 offline demo).
 *
 * Accepts whatever shape the operator's exporter produced and normalises it.
 * Supported: the documented envelope, a bare array of tweets, one tweet,
 * NDJSON lines, and the two public single-tweet payloads this project probed
 * (syndication tweet-result, fxtwitter {code,message,tweet}).
 *
 * A file has no cursor, so it yields exactly one complete page.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  ActionResult,
  AuthorRef,
  CollectionProvider,
  FetchOptions,
  ProfileSnapshot,
  ProviderCapabilities,
  ReplyPage,
  Tweet,
} from "../types.ts";

interface RawUser {
  id?: string | number;
  id_str?: string;
  rest_id?: string;
  screen_name?: string;
  username?: string;
  handle?: string;
  name?: string;
  displayName?: string;
  description?: string;
  bio?: string;
  created_at?: string;
  url?: string;
  location?: string;
  followers_count?: number;
  following_count?: number;
  tweets_count?: number;
  legacy?: RawUser;
}

interface RawTweet {
  id?: string | number;
  id_str?: string;
  tweet_id?: string | number;
  text?: string;
  full_text?: string;
  note_tweet?: { text?: string };
  created_at?: string;
  date?: string;
  time?: string;
  lang?: string;
  user?: RawUser;
  author?: RawUser;
  in_reply_to_status_id?: string | number | null;
  in_reply_to_status_id_str?: string | null;
  replying_to_status_id?: string | null;
  replying_to?: string | null;
  isRoot?: boolean;
  conversation_count?: number;
  __typename?: string;
}

function first(...vals: Array<string | number | undefined | null>): string {
  for (const v of vals) if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  return "";
}

function iso(d: string | undefined): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function authorOf(raw: RawTweet): AuthorRef {
  const u = raw.user?.legacy ?? raw.user ?? raw.author ?? {};
  const handle = first(u.screen_name, u.username, u.handle).toLowerCase();
  const id = first(u.id, u.id_str, u.rest_id);
  return {
    // A handle-only export still needs a stable key: prefix it so it can never
    // collide with a real numeric rest_id, and keep it stable across runs.
    id: id || `handle:${handle || "unknown"}`,
    handle: handle || id || "unknown",
    displayName: first(u.name, u.displayName) || undefined,
  };
}

export function toTweet(raw: RawTweet, source: string): Tweet | null {
  const id = first(raw.id, raw.id_str, raw.tweet_id);
  const text = first(raw.note_tweet?.text, raw.text, raw.full_text);
  if (!id || !text) return null;
  const author = authorOf(raw);
  const created = iso(first(raw.created_at, raw.date)) ?? new Date().toISOString();
  const replyTo = first(raw.in_reply_to_status_id, raw.in_reply_to_status_id_str, raw.replying_to_status_id, raw.replying_to) || null;
  return {
    id,
    text,
    createdAt: created,
    author,
    inReplyToId: replyTo,
    lang: raw.lang,
    conversationCount: typeof raw.conversation_count === "number" ? raw.conversation_count : undefined,
    url: `https://x.com/${author.handle}/status/${id}`,
    source,
  };
}

function collect(node: unknown, out: RawTweet[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const looksLikeTweet =
    (obj.id !== undefined || obj.id_str !== undefined || obj.tweet_id !== undefined) &&
    (obj.text !== undefined || obj.full_text !== undefined || obj.note_tweet !== undefined);
  if (looksLikeTweet) out.push(obj as RawTweet);
  for (const key of ["data", "tweet", "tweets", "replies", "conversation", "entries", "instructions", "items", "results", "include"]) {
    if (obj[key] !== undefined) collect(obj[key], out);
  }
}

/** Parse any supported envelope into (root, replies). */
export function parseImport(rawText: string): { root: Tweet | null; replies: Tweet[]; warnings: string[] } {
  const warnings: string[] = [];
  const trimmed = rawText.trim();
  if (!trimmed) return { root: null, replies: [], warnings: ["empty file"] };

  const nodes: RawTweet[] = [];
  const direct = tryJson(trimmed);
  if (direct !== null) {
    // Syndication/fxtwitter wrap the tweet; dig it out explicitly.
    const wrapped = direct as Record<string, unknown>;
    if (wrapped.tweet && typeof wrapped.tweet === "object") nodes.push(wrapped.tweet as RawTweet);
    else collect(direct, nodes);
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const j = tryJson(l);
      if (j === null) {
        warnings.push("skipped a non-JSON line");
        continue;
      }
      collect(j, nodes);
    }
  }

  const tweets = new Map<string, Tweet>();
  for (const n of nodes) {
    const t = toTweet(n, "import");
    if (t) tweets.set(t.id, t);
  }
  if (!tweets.size) return { root: null, replies: [], warnings: [...warnings, "no tweet-shaped objects found"] };

  const ids = new Set(tweets.keys());
  const isRootFlagged = (t: Tweet) => nodes.some((n) => n.isRoot === true && first(n.id, n.id_str, n.tweet_id) === t.id);
  const candidates = [...tweets.values()].filter((t) => !t.inReplyToId || !ids.has(t.inReplyToId));
  // Root, in order of confidence: an explicit "isRoot": true, a tweet that no
  // in-file reply links away from, then the oldest tweet in the file.
  const root =
    candidates.find(isRootFlagged) ??
    candidates[0] ??
    [...tweets.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  if (!isRootFlagged(root)) {
    warnings.push(`root inferred as ${root.id} — set "isRoot": true on the original post if that is wrong`);
  }
  if (candidates.length > 1) {
    warnings.push(`${candidates.length} tweets have no in-file parent; only ${root.id} is treated as the root`);
  }

  const replies: Tweet[] = [];
  const seen = new Set<string>();
  for (const t of tweets.values()) {
    if (t.id === root.id || seen.has(t.id)) continue;
    seen.add(t.id);
    replies.push(t);
  }
  if (replies.length && !replies.some((t) => t.inReplyToId === root.id)) {
    warnings.push("no reply links back to the inferred root; treated as a flat thread");
  }
  return { root, replies, warnings };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class ImportProvider implements CollectionProvider {
  name = "import-file";

  private root: Tweet | null = null;
  private replies: Tweet[] = [];
  readonly warnings: string[];

  constructor(file: string) {
    const abs = path.isAbsolute(file) ? file : path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`import file not found: ${abs}`);
    const parsed = parseImport(fs.readFileSync(abs, "utf8"));
    this.root = parsed.root;
    this.replies = parsed.replies;
    this.warnings = parsed.warnings;
  }

  capabilities(): ProviderCapabilities {
    return { rootTweet: true, replies: true, profile: false, timeline: false, block: false };
  }

  async fetchTweet(): Promise<Tweet | null> {
    return this.root;
  }

  async *fetchReplies(_id: string, opts: FetchOptions = {}): AsyncGenerator<ReplyPage> {
    const limit = opts.maxItems ?? this.replies.length;
    yield {
      items: this.replies.slice(0, limit),
      nextCursor: null,
      complete: true,
      rateLimited: false,
    };
  }

  async fetchProfile(): Promise<ProfileSnapshot | null> {
    return null;
  }

  async block(): Promise<ActionResult> {
    return { ok: false, status: "skipped", detail: "import-file provider cannot act on the platform" };
  }
}
