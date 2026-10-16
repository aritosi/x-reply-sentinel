#!/usr/bin/env node
/**
 * Official X API v2 provider. Uses app-only bearer for reads and, when present,
 * a user-context token for the block/unblock writes (spec §八: the skill must be
 * able to act, but acting is a separate credential from reading).
 *
 * Endpoint shapes follow the v2 reference; they were not exercised against a
 * live key on this machine (no key configured), so every parse is defensive and
 * a non-200 degrades to "no data" rather than a crash. Marked unverified in
 * docs/research.md.
 */
import type {
  ActionResult,
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

const API = "https://api.x.com/2";
const TWEET_FIELDS = "created_at,referenced_tweets,author_id,lang,public_metrics,entities";
const USER_FIELDS = "created_at,description,url,public_metrics,location";

interface V2User {
  id?: string;
  username?: string;
  name?: string;
  description?: string;
  url?: string;
  location?: string;
  created_at?: string;
  public_metrics?: { followers_count: number; following_count: number; tweet_count: number };
}

interface V2Tweet {
  id?: string;
  text?: string;
  created_at?: string;
  lang?: string;
  author_id?: string;
  public_metrics?: { reply_count?: number; retweet_count?: number; like_count?: number };
  referenced_tweets?: Array<{ type: string; id: string }>;
}

interface V2ListResponse {
  data?: V2Tweet[] | V2User[];
  includes?: { users?: V2User[]; tweets?: V2Tweet[] };
  meta?: { next_token?: string | null; result_count?: number; newest_id?: string; oldest_id?: string };
  errors?: Array<{ message?: string }>;
}

function iso(d: string | undefined): string {
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

export class ApiV2Provider implements CollectionProvider {
  name = "x-api-v2";

  private http: Http;
  private cfg: Config;

  constructor(http: Http, cfg: Config) {
    this.http = http;
    this.cfg = cfg;
  }

  private get bearer(): string {
    return process.env[this.cfg.fetch.bearerTokenEnv] ?? "";
  }

  private get userToken(): string {
    return process.env.XRS_X_USER_TOKEN ?? "";
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.bearer}`, "content-type": "application/json" };
  }

  capabilities(): ProviderCapabilities {
    return {
      rootTweet: true,
      replies: true,
      profile: true,
      timeline: true,
      block: Boolean(this.userToken),
    };
  }

  async fetchTweet(id: string): Promise<Tweet | null> {
    if (!this.bearer) return null;
    const url = `${API}/tweets/${id}?tweet.fields=${TWEET_FIELDS}&expansions=author_id&user.fields=${USER_FIELDS}`;
    const res = await this.http.request(url, { headers: this.headers() });
    if (res.status !== 200) return null;
    const json = res.json<V2ListResponse>();
    const t = (json?.data as V2Tweet[] | undefined)?.[0];
    if (!t?.id || !t.text) return null;
    const author = json?.includes?.users?.find((u) => u.id === t.author_id) ?? json?.includes?.users?.[0];
    return {
      id: t.id,
      text: t.text,
      createdAt: iso(t.created_at),
      author: { id: String(t.author_id ?? author?.id ?? ""), handle: author?.username ?? "", displayName: author?.name },
      lang: t.lang,
      conversationCount: t.public_metrics?.reply_count,
      url: author?.username ? `https://x.com/${author.username}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
      source: "x-api-v2",
    };
  }

  /**
   * Recent search scoped to one conversation. The 7-day window is a hard
   * platform limit, so an old thread legitimately returns fewer rows than
   * conversation_count suggests; the report says so instead of guessing.
   */
  async *fetchReplies(id: string, opts: FetchOptions = {}): AsyncGenerator<ReplyPage> {
    if (!this.bearer) return;
    let token = opts.startCursor ?? null;
    const maxPerCall = Math.min(100, this.cfg.fetch.maxRepliesPerPost);
    let emitted = 0;

    do {
      const params = new URLSearchParams({
        query: `conversation_id:${id} -is:self_reply`,
        max_results: String(maxPerCall),
        "tweet.fields": TWEET_FIELDS,
        expansions: "author_id,referenced_tweets.id",
        "user.fields": USER_FIELDS,
      });
      if (token) params.set("next_token", token);
      const res = await this.http.request(`${API}/tweets/search/recent?${params}`, { headers: this.headers() });
      if (res.status !== 200) {
        yield { items: [], nextCursor: null, complete: true, rateLimited: res.rateLimited };
        return;
      }
      const json = res.json<V2ListResponse>();
      const rows = (json?.data as V2Tweet[] | undefined) ?? [];
      const users = json?.includes?.users ?? [];
      const items: Tweet[] = [];
      for (const t of rows) {
        if (!t.id || !t.text || t.id === id) continue;
        const parent = t.referenced_tweets?.find((r) => r.type === "replied_to");
        const author = users.find((u) => u.id === t.author_id);
        items.push({
          id: t.id,
          text: t.text,
          createdAt: iso(t.created_at),
          author: { id: String(t.author_id ?? author?.id ?? ""), handle: author?.username ?? "", displayName: author?.name },
          inReplyToId: parent?.id ?? null,
          conversationId: id,
          lang: t.lang,
          url: author?.username ? `https://x.com/${author.username}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
          source: "x-api-v2",
        });
      }
      emitted += items.length;
      token = json?.meta?.next_token ?? null;
      const done = !token || emitted >= (opts.maxItems ?? this.cfg.fetch.maxRepliesPerPost);
      yield { items, nextCursor: done ? null : token, complete: done, rateLimited: res.rateLimited };
      if (done) return;
    } while (token);
  }

  async fetchProfile(handle: string): Promise<ProfileSnapshot | null> {
    if (!this.bearer) return null;
    const res = await this.http.request(
      `${API}/users/by/username/${encodeURIComponent(handle.replace(/^@/, ""))}?user.fields=${USER_FIELDS}`,
      { headers: this.headers() },
    );
    if (res.status !== 200) return null;
    const u = res.json<V2ListResponse>()?.data as V2User[] | undefined;
    const user = Array.isArray(u) ? u[0] : (u as unknown as V2User);
    if (!user?.id) return null;
    return {
      userId: String(user.id),
      handle: user.username ?? handle,
      displayName: user.name,
      bio: user.description ?? "",
      createdAt: user.created_at,
      followers: user.public_metrics?.followers_count,
      following: user.public_metrics?.following_count,
      statusesCount: user.public_metrics?.tweet_count,
      link: user.url,
      location: user.location,
      capturedAt: new Date().toISOString(),
    };
  }

  async fetchRecentTweets(handle: string, count: number): Promise<Tweet[]> {
    if (!this.bearer) return [];
    const who = await this.http.request(
      `${API}/users/by/username/${encodeURIComponent(handle.replace(/^@/, ""))}`,
      { headers: this.headers() },
    );
    const userId = (who.json<V2ListResponse>()?.data as V2User[] | undefined)?.[0]?.id;
    if (!userId) return [];
    const res = await this.http.request(
      `${API}/users/${userId}/tweets?max_results=${Math.min(100, Math.max(5, count))}&tweet.fields=${TWEET_FIELDS}&exclude=retypes,replies`,
      { headers: this.headers() },
    );
    const rows = (res.json<V2ListResponse>()?.data as V2Tweet[] | undefined) ?? [];
    return rows
      .filter((t) => t.id && t.text)
      .map((t) => ({
        id: t.id!,
        text: t.text!,
        createdAt: iso(t.created_at),
        author: { id: String(userId), handle: handle.replace(/^@/, "") },
        lang: t.lang,
        source: "x-api-v2",
      }));
  }

  async block(userId: string): Promise<ActionResult> {
    if (!this.userToken) return { ok: false, status: "skipped", detail: "no user-context token (XRS_X_USER_TOKEN)" };
    const res = await this.http.request(`${API}/users/${userId}/blocking`, {
      method: "POST",
      headers: { ...this.headers(), authorization: `Bearer ${this.userToken}` },
    });
    const created = res.json<{ data?: { blocking: boolean } }>()?.data?.blocking;
    return {
      ok: res.status === 200 || res.status === 201,
      status: res.status === 403 ? "already" : created ? "blocked" : "failed",
      httpStatus: res.status,
      detail: truncate(res.text, 200),
    };
  }

  async unblock(userId: string): Promise<ActionResult> {
    if (!this.userToken) return { ok: false, status: "skipped", detail: "no user-context token (XRS_X_USER_TOKEN)" };
    const res = await this.http.request(`${API}/users/${userId}/blocking`, {
      method: "DELETE",
      headers: { ...this.headers(), authorization: `Bearer ${this.userToken}` },
    });
    return {
      ok: res.status === 200 || res.status === 201,
      status: res.status === 404 ? "already" : "unblocked",
      httpStatus: res.status,
      detail: truncate(res.text, 200),
    };
  }
}
