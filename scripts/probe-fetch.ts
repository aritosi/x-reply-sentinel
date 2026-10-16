#!/usr/bin/env node
/**
 * Read-only probe of the public X data paths this skill can use without a
 * paid API key. Run it again whenever a provider starts failing, and record the
 * result in docs/research.md. Nothing here writes to the database.
 *
 *   node scripts/probe-fetch.ts [tweetId]
 */
const id = process.argv[2] ?? "20";

function token(tid: string): string {
  return ((Number(tid) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function probe(name: string, url: string, opts: RequestInit = {}): Promise<unknown> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { "user-agent": UA, ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let kind = "text";
    let summary = text.replace(/\s+/g, " ").slice(0, 110);
    try {
      const json = JSON.parse(text);
      kind = "json";
      const keys = Object.keys(json).slice(0, 12).join(",");
      const arr = (json as Record<string, unknown>).timeline ?? (json as Record<string, unknown>).entries;
      summary = `keys=${keys} len=${Array.isArray(arr) ? arr.length : "-"}`;
    } catch {
      /* keep the text excerpt */
    }
    console.log(`${String(res.status).padEnd(4)} ${name.padEnd(26)} ${String(Date.now() - started).padStart(5)}ms ${kind}  ${summary}`);
    return text;
  } catch (err) {
    console.log(`ERR   ${name.padEnd(26)} ${String(Date.now() - started).padStart(5)}ms ${(err as Error).name}: ${(err as Error).message.slice(0, 90)}`);
    return null;
  }
}

console.log(`probing tweet id=${id}\n`);
await probe("syndication tweet-result", `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token(id)}&lang=en`);
await probe("syndication no-token", `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en`);
await probe("fxtwitter status", `https://api.fxtwitter.com/status/${id}`);
await probe("vxtwitter json", `https://api.vxtwitter.com/i/status/${id}`);
await probe("oembed tweet-html", `https://publish.twitter.com/oembed?url=https://twitter.com/i/status/${id}`);
await probe("syndication timeline-profile", `https://syndication.twitter.com/srv/timeline-profile/screen-name/jack`);
await probe("syndication embedded-convo", `https://cdn.syndication.twimg.com/timeline/conversation?id=${id}&lang=en&token=${token(id)}`);
await probe("x.com html", `https://x.com/i/status/${id}`);
await probe("api.x.com v2 (no auth)", `https://api.x.com/2/tweets/${id}`);
