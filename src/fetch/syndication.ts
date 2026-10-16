#!/usr/bin/env node
/**
 * Syndication provider — the keyless path (cdn.syndication.twimg.com).
 *
 * Verified on 2026-10-16 from this machine (scripts/probe-fetch.ts):
 *   GET /tweet-result?id=&token=&lang=  -> 200, single tweet + author + conversation_count
 *   GET /tweet-result?id= (no token)    -> 200, empty JSON object
 *   GET /timeline/conversation?id=      -> 200, empty body
 *   GET /srv/conversation/<id>          -> 404
 *   POST /1.1/guest/activate.json       -> 200 guest_token, but every guest
 *                                          GraphQL document id now 404s
 *                                          ("Query not found"), so keyless
 *                                          reply enumeration is dead.
 *
 * Consequence, stated plainly: this provider can read the original post and its
 * reply *count*, but not the replies themselves. A scan that finds zero replies
 * through this provider must report "not accessible", never "clean".
 */
import type { CollectionProvider, ProfileSnapshot, ProviderCapabilities, ReplyPage, Tweet } from "../types.ts";
import type { Config } from "../config.ts";
import { Http } from "./http.ts";

/** Syndication requires a derived token; same formula the embed script uses. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

const BASE = "https://cdn.syndication.twimg.com";

interface SyndicationUser {
  id_str?: string;
  rest_id?: string;
  legacy?: { screen_name?: string; name?: string; profile_image_url?: string };
  screen_name?: string;
  name?: string;
  is_blue_verified?: boolean;
  verified?: boolean;
}

interface SyndicationTweet {
  id_str?: string;
  text?: string;
  created_at?: string;
  lang?: string;
  conversation_count?: number;
  in_reply_to_status_id_str?: string | null;
  parent?: { id_str?: string };
  user?: SyndicationUser;
  news_action_type?: string;
}

function handleOf(user: SyndicationUser | undefined): string {
  return (user?.legacy?.screen_name ?? user?.screen_name ?? "").toLowerCase();
}

function userIdOf(user: SyndicationUser | undefined, fallbackHandle: string): string {
  return String(user?.id_str ?? user?.rest_id ?? user?.legacy?.screen_name ?? fallbackHandle).trim();
}

export function toTweet(raw: SyndicationTweet): Tweet | null {
  const id = String(raw.id_str ?? "").trim();
  const text = String(raw.text ?? "");
  if (!id || !text) return null;
  const handle = handleOf(raw.user);
  return {
    id,
    text,
    createdAt: raw.created_at ? new Date(raw.created_at).toISOString() : new Date().toISOString(),
    author: {
      id: userIdOf(raw.user, handle),
      handle,
      displayName: raw.user?.legacy?.name ?? raw.user?.name,
    },
    inReplyToId: raw.in_reply_to_status_id_str ?? raw.parent?.id_str ?? null,
    lang: raw.lang,
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    source: "syndication",
  };
}

export class SyndicationProvider implements CollectionProvider {
  name = "syndication";

  private http: Http;
  private cfg: Config;

  constructor(http: Http, cfg: Config) {
    this.http = http;
    this.cfg = cfg;
  }

  capabilities(): ProviderCapabilities {
    return { rootTweet: true, replies: false, profile: false, timeline: false, block: false };
  }

  async fetchTweet(id: string): Promise<Tweet | null> {
    const url = `${BASE}/tweet-result?id=${encodeURIComponent(id)}&token=${syndicationToken(id)}&lang=en`;
    const res = await this.http.request(url);
    if (res.status !== 200) return null;
    const json = res.json<SyndicationTweet>();
    if (!json || !json.id_str) return null;
    const tweet = toTweet(json);
    if (tweet) tweet.conversationCount = json.conversation_count;
    return tweet;
  }

  /**
   * Yields nothing, on purpose. Callers check capabilities().replies first and
   * surface the limitation in the report instead of treating zero rows as clean.
   */
  async *fetchReplies(): AsyncGenerator<ReplyPage> {
    yield { items: [], nextCursor: null, complete: true, rateLimited: false };
  }

  async fetchProfile(): Promise<ProfileSnapshot | null> {
    return null;
  }
}
