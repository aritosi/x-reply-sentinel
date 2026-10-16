#!/usr/bin/env node
/**
 * Session provider — logged-in web GraphQL. This is the only path that can walk
 * a real reply tree, and it needs the operator's own credentials in the
 * environment (never in config, never in the database):
 *
 *   XRS_X_AUTH_TOKEN  cookie auth_token
 *   XRS_X_CT0         cookie ct0   (also used as x-csrf-token)
 *   fetch.tweetDetailQueryId / fetch.userTweetsQueryId  GraphQL document ids
 *
 * The document ids rotate whenever X redeploys the web app. They are
 * configuration, not code, precisely so a stale id is a one-line fix. This
 * module was NOT exercised against a live session from this machine (no session
 * credentials are configured here) — see docs/research.md. Treat its parsers as
 * best-effort and check the scan report's "not accessible" lines on first use.
 */
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
import type { Config } from "../config.ts";
import { Http } from "./http.ts";
import { truncate } from "../util.ts";

const PUBLIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_edit_eligibility_enabled: true,
  blue_type_inline_shipping_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  long_text_not_visible_alerts_enabled_api_enabled: true,
  premium_content_tweet_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

interface LegacyUser {
  screen_name?: string;
  name?: string;
  description?: string;
  created_at?: string;
  url?: string;
  location?: string;
  followers_count?: number;
  friends_count?: number;
  statuses_count?: number;
}

interface GqlUser {
  id?: string;
  rest_id?: string;
  legacy?: LegacyUser;
}

/** The v2 block: `rest_id` + `text` (or `note_tweet`) on the node itself. */
interface GqlTweet {
  rest_id?: string;
  created_at?: string;
  lang?: string;
  text?: string;
  note_tweet?: { note_tweet_results?: { text?: string } };
  user?: GqlUser;
  in_reply_to_status_id_str?: string | null;
}

/** The legacy block that still wraps most conversation/timeline payloads. */
interface LegacyTweet {
  id_str?: string;
  full_text?: string;
  created_at?: string;
  lang?: string;
  user?: GqlUser;
  in_reply_to_status_id_str?: string | null;
}

interface TweetResultNode {
  rest_id?: string;
  created_at?: string;
  lang?: string;
  text?: string;
  note_tweet?: { note_tweet_results?: { text?: string } };
  legacy?: LegacyTweet;
  core?: { user_results?: { result?: GqlUser } };
  user?: GqlUser;
  tweet?: GqlTweet;
}

/**
 * Sub-objects that are *other* tweets attached to a tweet. Collecting them would
 * score quoted/retweeted content as if the author had replied with it.
 */
const SKIP_KEYS = new Set([
  "quoted_tweet",
  "quoted_status",
  "retweeted_status",
  "related_tweets",
  "in_reply_to_user",
  "card",
  "media",
  "promotedTweet",
  "who_to_follow",
  "trends",
]);

function authorOf(user: GqlUser | undefined): { id: string; handle: string; displayName?: string } | null {
  const id = String(user?.rest_id ?? user?.id ?? "");
  if (!id) return null;
  const handle = String(user?.legacy?.screen_name ?? "").toLowerCase();
  return { id, handle: handle || id, displayName: user?.legacy?.name };
}

function isoOrNow(value: unknown): string {
  const ts = typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : NaN;
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString();
}

/**
 * Normalise one GraphQL node into a domain Tweet, accepting both payload shapes
 * (`{rest_id, legacy:{full_text}, core.user_results}` and `{rest_id, text, user}`).
 * Returns null for anything that is not a tweet with an id and visible text.
 */
export function normalizeTweet(node: unknown, source: string, conversationId?: string): Tweet | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const n = node as TweetResultNode;
  if (n.tweet && !n.legacy && !n.rest_id) return normalizeTweet(n.tweet, source, conversationId);

  const id = String(n.rest_id ?? n.legacy?.id_str ?? n.tweet?.rest_id ?? "");
  const body =
    n.legacy?.full_text ??
    n.note_tweet?.note_tweet_results?.text ??
    n.text ??
    n.tweet?.note_tweet?.note_tweet_results?.text ??
    n.tweet?.text ??
    "";
  const text = String(body).replace(/\s*https?:\/\/t\.co\/\w+$/g, "").trim();
  if (!id || !text) return null;

  const author =
    authorOf(n.core?.user_results?.result) ?? authorOf(n.user) ?? authorOf(n.legacy?.user) ?? authorOf(n.tweet?.user);
  if (!author) return null;

  return {
    id,
    text,
    createdAt: isoOrNow(n.created_at ?? n.legacy?.created_at ?? n.tweet?.created_at),
    author,
    inReplyToId: (n.legacy?.in_reply_to_status_id_str ?? n.tweet?.in_reply_to_status_id_str ?? null) as string | null,
    conversationId,
    lang: (n.legacy?.lang ?? n.lang ?? n.tweet?.lang) as Tweet["lang"],
    url: `https://x.com/${author.handle}/status/${id}`,
    source,
  };
}

export interface CollectedTweets {
  items: Tweet[];
  nextCursor: string | null;
  done: boolean;
}

function collect(node: unknown, source: string, out: Map<string, Tweet>, cursors: string[], depth: number): void {
  if (!node || typeof node !== "object" || depth > 40) return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, source, out, cursors, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.cursorType === "Next" && typeof obj.value === "string") cursors.push(obj.value);

  const tweet = normalizeTweet(obj, source);
  if (tweet) {
    if (!out.has(tweet.id)) out.set(tweet.id, tweet);
    return; // never descend into a tweet's own nested tweets
  }
  for (const [key, value] of Object.entries(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    collect(value, source, out, cursors, depth + 1);
  }
}

/**
 * TweetDetail payload → the focus tweet, its replies and the pagination cursor.
 * The focus tweet is returned separately so `fetchTweet` can serve the root post
 * from the same request that produced the replies.
 */
export function parseTweetDetail(
  json: unknown,
  rootId: string,
): CollectedTweets & { focus: Tweet | null } {
  const out = new Map<string, Tweet>();
  const cursors: string[] = [];
  collect(json, "session", out, cursors, 0);
  const all = [...out.values()];
  const focus = all.find((t) => t.id === rootId) ?? null;
  const items = all
    .filter((t) => t.id !== rootId)
    .map((t) => ({ ...t, conversationId: rootId }));
  const nextCursor = cursors.length ? cursors[cursors.length - 1] : null;
  return { items, focus, nextCursor, done: !nextCursor };
}

/** UserTweets / any timeline payload → the tweets it renders, newest first. */
export function parseTimeline(json: unknown, source = "session-timeline"): Tweet[] {
  const out = new Map<string, Tweet>();
  collect(json, source, out, [], 0);
  return [...out.values()];
}

export class SessionProvider implements CollectionProvider {
  name = "session";

  private http: Http;
  private cfg: Config;

  constructor(http: Http, cfg: Config) {
    this.http = http;
    this.cfg = cfg;
  }

  private get auth(): string {
    return process.env[this.cfg.fetch.authTokenEnv] ?? "";
  }

  private get ct0(): string {
    return process.env[this.cfg.fetch.ct0Env] ?? "";
  }

  ready(): boolean {
    return Boolean(this.auth && this.ct0 && this.cfg.fetch.tweetDetailQueryId);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${PUBLIC_BEARER}`,
      cookie: `auth_token=${this.auth}; ct0=${this.ct0}`,
      "x-csrf-token": this.ct0,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
      "content-type": "application/json",
    };
  }

  capabilities(): ProviderCapabilities {
    const ok = Boolean(this.auth && this.ct0);
    return { rootTweet: ok, replies: ok && Boolean(this.cfg.fetch.tweetDetailQueryId), profile: ok, timeline: ok && Boolean(this.cfg.fetch.userTweetsQueryId), block: ok };
  }

  async fetchTweet(id: string): Promise<Tweet | null> {
    if (!this.ready()) return null;
    const variables = {
      tweetId: id,
      withContext: true,
      isReadableStackInView: false,
      viewCountPoint: "TWEET",
    };
    const url = `https://x.com/i/api/graphql/${this.cfg.fetch.tweetDetailQueryId}/TweetDetail?variables=${encodeURIComponent(
      JSON.stringify({ ...variables, id }),
    )}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
    const res = await this.http.request(url, { headers: this.headers() });
    if (res.status !== 200) return null;
    return parseTweetDetail(res.json(), id).focus;
  }

  async *fetchReplies(id: string, opts: FetchOptions = {}): AsyncGenerator<ReplyPage> {
    if (!this.ready()) return;
    let cursor = opts.startCursor ?? null;
    let emitted = 0;
    let pages = 0;
    const cap = opts.maxItems ?? this.cfg.fetch.maxRepliesPerPost;

    do {
      const variables: Record<string, unknown> = {
        id,
        includePromotedContent: false,
        conversationFocusTweetId: cursor ? undefined : id,
        conversationModuleIndex: cursor ? undefined : 0,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
        withV2Timeline: true,
      };
      if (cursor) variables.cursor = cursor;
      const url = `https://x.com/i/api/graphql/${this.cfg.fetch.tweetDetailQueryId}/TweetDetail?variables=${encodeURIComponent(
        JSON.stringify(variables),
      )}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
      const res = await this.http.request(url, { headers: this.headers() });
      pages++;
      if (res.status !== 200) {
        yield { items: [], nextCursor: null, complete: true, rateLimited: res.status === 429 || res.rateLimited };
        return;
      }
      const parsed = parseTweetDetail(res.json(), id);
      emitted += parsed.items.length;
      const stop = parsed.done || !parsed.nextCursor || emitted >= cap || pages >= this.cfg.fetch.maxPagesPerRun;
      yield {
        items: parsed.items,
        nextCursor: stop ? null : parsed.nextCursor,
        complete: stop,
        rateLimited: res.rateLimited,
      };
      if (stop) return;
      cursor = parsed.nextCursor;
    } while (cursor);
  }

  async fetchProfile(handle: string): Promise<ProfileSnapshot | null> {
    if (!this.auth || !this.ct0) return null;
    const url = `https://x.com/i/api/graphql/qd3cB2P09Aq7mLZULmJdCw/UserByScreenName?variables=${encodeURIComponent(
      JSON.stringify({ screen_name: handle.replace(/^@/, ""), withSafetyModeUserFields: true }),
    )}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
    const res = await this.http.request(url, { headers: this.headers() });
    if (res.status !== 200) return null;
    const user = (res.json<{ data?: { user?: GqlUser } }>()?.data?.user);
    const legacy = user?.legacy;
    if (!user?.rest_id) return null;
    return {
      userId: String(user.rest_id),
      handle: String(legacy?.screen_name ?? handle).toLowerCase(),
      displayName: legacy?.name,
      bio: legacy?.description ?? "",
      createdAt: legacy?.created_at,
      followers: legacy?.followers_count,
      following: legacy?.friends_count,
      statusesCount: legacy?.statuses_count,
      link: legacy?.url,
      location: legacy?.location,
      capturedAt: new Date().toISOString(),
    };
  }

  async fetchRecentTweets(handle: string, count: number): Promise<Tweet[]> {
    if (!this.cfg.fetch.userTweetsQueryId) return [];
    const profile = await this.fetchProfile(handle);
    if (!profile?.userId) return [];
    const url = `https://x.com/i/api/graphql/${this.cfg.fetch.userTweetsQueryId}/UserTweets?variables=${encodeURIComponent(
      JSON.stringify({ userId: profile.userId, count: Math.min(100, Math.max(5, count)), includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: false, withV2Timeline: true }),
    )}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
    const res = await this.http.request(url, { headers: this.headers() });
    if (res.status !== 200) return [];
    const tweets = parseTimeline(res.json());
    return tweets.slice(0, Math.max(1, count));
  }

  async block(userId: string): Promise<ActionResult> {
    if (!this.auth || !this.ct0) return { ok: false, status: "skipped", detail: "no session credentials" };
    const res = await this.http.request("https://x.com/i/api/1.1/blocks/create.json", {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_id: userId, include_entities: "false" }).toString(),
    });
    if (res.status === 200) return { ok: true, status: "blocked", httpStatus: 200 };
    if (res.status === 403 || /already/i.test(res.text)) return { ok: false, status: "already", httpStatus: res.status, detail: truncate(res.text, 160) };
    return { ok: false, status: "failed", httpStatus: res.status, detail: truncate(res.text, 160) };
  }

  async unblock(userId: string): Promise<ActionResult> {
    if (!this.auth || !this.ct0) return { ok: false, status: "skipped", detail: "no session credentials" };
    const res = await this.http.request("https://x.com/i/api/1.1/blocks/destroy.json", {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_id: userId, include_entities: "false" }).toString(),
    });
    return {
      ok: res.status === 200,
      status: res.status === 200 ? "unblocked" : "failed",
      httpStatus: res.status,
      detail: truncate(res.text, 160),
    };
  }
}
