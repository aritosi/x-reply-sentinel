#!/usr/bin/env node
/**
 * Third-pass probe: is keyless reply enumeration possible at all through the
 * public web GraphQL (guest token)? Decides whether the default provider can
 * fetch replies or only the root post.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

async function req(name: string, url: string, init: RequestInit = {}) {
  try {
    const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    console.log(`${String(res.status).padEnd(4)} ${name.padEnd(34)} ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    return text;
  } catch (err) {
    console.log(`ERR   ${name.padEnd(34)} ${(err as Error).name}: ${(err as Error).message.slice(0, 80)}`);
    return null;
  }
}

const act = await req("guest/activate", "https://api.x.com/1.1/guest/activate.json", {
  method: "POST",
  headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/x-www-form-urlencoded" },
});
const guest = act ? (JSON.parse(act).guest_token as string | undefined) : undefined;
console.log(`guest_token=${guest ?? "(none)"}\n`);
if (!guest) process.exit(0);

const auth = { authorization: `Bearer ${BEARER}`, "x-guest-token": guest };
const id = "20";

// TweetResultByRestId — does a guest get a single tweet back?
await req("gql TweetResultByRestId", `https://api.x.com/graphql/ccrb651SZEB1Yb6gKpOrA/TweetResultByRestId?variables=${encodeURIComponent(
  JSON.stringify({ tweetId: id, withContext: true }),
)}&features=${encodeURIComponent(JSON.stringify({ responder_id: false, profile_colors: false }))}`, { headers: auth });

// TweetDetail — the reply-list endpoint, several query ids seen in the wild.
const features = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  topbar_birdwatch_enabled: false,
};
for (const qid of ["LmWLrpduK4_bdRRukcvRFQ", "KgIT2DNsxhMNwxYyGgy0BQ", "VWFGJ20HYwBG6scSDmJlJQ", "vFA5Qqxwx7EptBPPc2joUw"]) {
  const variables = {
    id,
    includePromotedContent: false,
    conversationFocusTweetId: id,
    conversationModuleIndex: 0,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: false,
    withV2Timeline: true,
  };
  await req(
    `gql TweetDetail ${qid.slice(0, 8)}…`,
    `https://api.twitter.com/graphql/${qid}/TweetDetail?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`,
    { headers: auth },
  );
}

// Legacy conversation JSON, still referenced by some scrapers.
await req("legacy conversation.json", `https://api.x.com/2/timeline/conversation/${id}.json`, { headers: auth });
