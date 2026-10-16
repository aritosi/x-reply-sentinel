import crypto from "node:crypto";

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function sha1(s: string): string {
  return crypto.createHash("sha1").update(s, "utf8").digest("hex");
}

export function nowIso(d: Date = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Rows are stored in UTC (nowIso) so resume windows and rate limits stay
 * unambiguous across a machine in another zone. Anything a person reads is
 * converted to the configured timezone with this helper.
 */
export function displayTime(ts: string, tz = "Asia/Shanghai"): string {
  if (!ts) return ts;
  const d = new Date(ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  const local = d.toLocaleString("sv-SE", { timeZone: tz }).slice(0, 19);
  return tz === "UTC" ? `${local} UTC` : `${local} ${tz}`;
}

export function dayString(d: Date = new Date(), tz = "UTC"): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // YYYY-MM-DD
}

/** Minutes that local wall-clock time is ahead of UTC at that instant. */
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const f = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+f.year, +f.month - 1, +f.day, +(f.hour === "24" ? 0 : f.hour), +f.minute, +f.second);
  const asUtc = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds());
  return Math.round((asLocal - asUtc) / 60000);
}

/**
 * Rows are stamped in UTC (nowIso) but an operator's "today" is a local calendar
 * day, so a day bucket must become a UTC instant range or a Shanghai run at
 * 07:00 silently lands in yesterday's report.
 *
 * Both bounds are the same "YYYY-MM-DD HH:MM:SS" shape the rows use, which makes
 * the comparison a plain lexicographic range in SQL.
 */
export function dayRange(day: string, tz = "Asia/Shanghai"): { from: string; to: string } {
  const base = new Date(`${day}T00:00:00Z`);
  const first = new Date(base.getTime() - tzOffsetMinutes(base, tz) * 60000);
  const second = new Date(base.getTime() - tzOffsetMinutes(first, tz) * 60000); // DST edge
  return { from: nowIso(second), to: nowIso(new Date(second.getTime() + 86400000)) };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

export function randInt(max: number): number {
  if (max <= 0) return 0;
  return crypto.randomInt(0, max);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Normalize a reply for hashing/dedup: lowercase, strip invisible characters,
 * collapse whitespace and punctuation noise. Handles CJK (no word boundaries needed).
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u034F\u180E]/g;

export function normalizeForHash(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shingles used for near-duplicate comparison (character 5-grams work for CJK and Latin alike). */
export function shingles(text: string, k = 5): Set<string> {
  const norm = normalizeForHash(text);
  const out = new Set<string>();
  if (norm.length < k) {
    if (norm) out.add(norm);
    return out;
  }
  for (let i = 0; i + k <= norm.length; i++) out.add(norm.slice(i, i + k));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export function detectLang(text: string): "en" | "zh" | "mixed" | "other" {
  const cjk = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const total = cjk + latin;
  if (total === 0) return "other";
  const zhRatio = cjk / total;
  if (zhRatio > 0.6) return "zh";
  if (zhRatio < 0.1 && latin > 3) return "en";
  if (latin > 3 && cjk > 0) return "mixed";
  return "other";
}

export function parseTweetUrl(input: string): { id: string; handle: string | null } | null {
  if (/x\.com|twitter\.com/i.test(input)) {
    const m = input.match(/(?:x\.com|twitter\.com)\/([^/?#"'\s]+)\/status(?:es)?\/(\d{1,25})/i);
    if (m) return { id: m[2], handle: m[1].toLowerCase() === "i" ? null : m[1] };
    const idm = input.match(/\/status(?:es)?\/(\d{1,25})/i);
    if (idm) return { id: idm[1], handle: null };
  }
  const bare = input.match(/^\s*(\d{8,25})\s*$/);
  if (bare) return { id: bare[1], handle: null };
  return null;
}

export function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * Turn a literal phrase into a boundary-aware regex source.
 * Latin phrases get word boundaries (so "delve" does not match "delved" in passing
 * and never matches inside "indelve"); CJK phrases get plain substring matching
 * because `\b` is meaningless without word segmentation.
 */
export function phraseToRegexSource(phrase: string, opts: { caseInsensitive?: boolean } = {}): string {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const latin = /^[\\da-z'’-]+$/i.test(escaped);
  if (!latin) return escaped;
  const head = /^[\dA-Za-z]/.test(phrase) ? "\\b" : "";
  const tail = /[\dA-Za-z]$/.test(phrase) ? "\\b" : "";
  return head + escaped + tail;
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function pct(v: number): string {
  return (v * 100).toFixed(0) + "%";
}
