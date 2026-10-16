#!/usr/bin/env node
/**
 * Second-pass probe: can any keyless path enumerate REPLIES? The root tweet is
 * already known to work (cdn.syndication.twimg.com/tweet-result). Run with
 *   node scripts/probe-replies.ts [tweetId]
 */
const id = process.argv[2] ?? "20";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const tok = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");

async function go(name: string, url: string, init: RequestInit = {}) {
  try {
    const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let note = text.replace(/\s+/g, " ").slice(0, 100);
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const arrays = Object.entries(j)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => `${k}:${(v as unknown[]).length}`)
        .join(" ");
      note = `keys=${Object.keys(j).slice(0, 10).join(",")} arrays=${arrays || "-"}`;
      if (j.code !== undefined) note += ` code=${j.code} message=${String(j.message ?? "").slice(0, 40)}`;
    } catch {
      /* not json */
    }
    console.log(`${String(res.status).padEnd(4)} ${name.padEnd(30)} ${note}`);
    return text;
  } catch (err) {
    console.log(`ERR   ${name.padEnd(30)} ${(err as Error).name}: ${(err as Error).message.slice(0, 80)}`);
    return null;
  }
}

// 1. what does the working root-tweet endpoint actually contain?
const root = await go("tweet-result", `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tok}&lang=en`);
if (root) {
  try {
    const j = JSON.parse(root);
    console.log(`\n   text=${JSON.stringify(String(j.text ?? "").slice(0, 60))} conversation_count=${j.conversation_count} user=${j.user?.screen_name}`);
    console.log(`   full keys: ${Object.keys(j).join(", ")}`);
  } catch { /* ignore */ }
}
console.log();

// 2. conversation / reply-list candidates
await go("cdn srv/conversation", `https://cdn.syndication.twimg.com/srv/conversation/${id}?lang=en&token=${tok}&rel=reply`);
await go("syndication srv/conversation", `https://syndication.twitter.com/srv/conversation/${id}?lang=en&rel=reply&token=${tok}`);
await go("cdn timeline/conversation", `https://cdn.syndication.twimg.com/timeline/conversation?id=${id}&lang=en&token=${tok}`);
await go("cdn tweet-result with rel", `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tok}&lang=en&rel=reply&include_replies=true`);
await go("fxtwitter user path", `https://api.fxtwitter.com/jack/status/${id}`);
await go("fxtwitter thread", `https://api.fxtwitter.com/status/${id}?thread=true`);

// 3. GraphQL paths without credentials (guest token flow was retired in 2023)
const bearer =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
await go("graphql guest-token/init", "https://api.x.com/1.1/guest/activate.json", {
  method: "POST",
  headers: { authorization: `Bearer ${bearer}` },
});
await go("graphql TweetDetail", `https://api.x.com/graphql/SjpUVK-Or-kMrs1Bw6e1Wg/TweetDetail?variables=${encodeURIComponent(JSON.stringify({ id, includePromotedContent: false, conversationFocusTweetId: id, conversationModuleIndex: 0 }))}`, {
  headers: { authorization: `Bearer ${bearer}` },
});
