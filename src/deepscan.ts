#!/usr/bin/env node
/**
 * Layer: account deep scan (spec §五, band 70-100).
 *
 * Style scores a *reply*. A deep scan scores the *account*, and only from
 * verifiable, public, account-level facts: the bio, the recent public posts, the
 * links it pushes, duplicates against other accounts, and the anomaly records we
 * already hold. Nothing in here reads like "it used em-dashes, therefore block".
 *
 * The output is an independent spam-risk number plus the evidence rows that
 * produced it. Disposal policy lives in actions.ts.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AuthorRef, CollectionProvider, Evidence, ProfileSnapshot, Tweet } from "./types.ts";
import type { Config } from "./config.ts";
import {
  activeEvidence,
  addEvidence,
  crossAccountDuplicateReplies,
  logEvent,
  setUserTier,
} from "./db.ts";
import { analyzeLocal } from "./detect/local.ts";
import { jaccard, normalizeForHash, shingles, truncate } from "./util.ts";

export interface DeepScanResult {
  userId: string;
  handle: string;
  scannedAt: string;
  profileFound: boolean;
  tweetsSampled: number;
  accountSpamRisk: number;
  marketingLinks: string[];
  duplicateClusters: number;
  crossAccountDuplicates: number;
  findings: string[];
  evidence: Evidence[];
  /** Set when the provider could not reach profile/timeline data at all. */
  skipped: string | null;
}

const LINK_RE = /(?:https?:\/\/|www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'）)、，,]*)?|(?:t\.me|wa\.me|discord\.gg|linktr\.ee|bio\.link)\/[a-z0-9_\-]+/gi;

function linksOf(text: string): string[] {
  return [...new Set((text.match(LINK_RE) ?? []).map((l) => l.toLowerCase().replace(/[.,;:]+$/, "")))];
}

/** Links that are the account's own content vs. cross-site funnels. */
const OWN_HOSTS = ["x.com", "twitter.com"];

function foreignLinks(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const l of linksOf(t)) {
      const host = (l.replace(/^https?:\/\//, "").split("/")[0] ?? "").replace(/^www\./, "");
      if (OWN_HOSTS.includes(host)) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return counts;
}

function clusterDuplicates(texts: string[]): { clusters: number; largest: number } {
  const groups: Array<Array<{ hash: string; text: string }>> = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const n = normalizeForHash(t);
    if (n.length < 24) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    const sh = shingles(n, 8);
    let placed = false;
    for (const g of groups) {
      const head = g[0];
      if (head && jaccard(sh, shingles(head.text, 8)) >= 0.7) {
        g.push({ hash: n, text: t });
        placed = true;
        break;
      }
      // Exact repeats are the strongest form of the same signal.
      if (head && head.hash === n) {
        g.push({ hash: n, text: t });
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([{ hash: n, text: t }]);
  }
  const repeating = groups.filter((g) => g.length >= 3);
  return { clusters: repeating.length, largest: Math.max(0, ...repeating.map((g) => g.length)) };
}

export async function deepScan(
  db: DatabaseSync,
  cfg: Config,
  provider: CollectionProvider,
  user: AuthorRef,
  now = new Date(),
): Promise<DeepScanResult> {
  const base: DeepScanResult = {
    userId: user.id,
    handle: user.handle,
    scannedAt: now.toISOString(),
    profileFound: false,
    tweetsSampled: 0,
    accountSpamRisk: 0,
    marketingLinks: [],
    duplicateClusters: 0,
    crossAccountDuplicates: 0,
    findings: [],
    evidence: [],
    skipped: null,
  };

  const caps = provider.capabilities();
  if (!caps.profile && !caps.timeline) {
    // Without a transport that can read accounts, a deep scan would be pure
    // speculation. Record that it was attempted and skipped, never a score.
    base.skipped = `provider ${provider.name} cannot read profiles or timelines`;
    logEvent(db, "warn", "deepscan_skipped", { user: user.handle, reason: base.skipped });
    return base;
  }

  const wanted = cfg.thresholds.profileTweetCount;
  const count = Math.min(50, Math.max(20, wanted));
  let profile: ProfileSnapshot | null = null;
  let tweets: Tweet[] = [];
  const errors: string[] = [];

  if (caps.profile && provider.fetchProfile) {
    try {
      profile = await provider.fetchProfile(user.handle);
    } catch (err) {
      errors.push(`profile: ${truncate(String((err as Error)?.message ?? err), 80)}`);
    }
  }
  if (caps.timeline && provider.fetchRecentTweets) {
    try {
      tweets = (await provider.fetchRecentTweets(user.handle, count)) ?? [];
    } catch (err) {
      errors.push(`timeline: ${truncate(String((err as Error)?.message ?? err), 80)}`);
    }
  }
  if (profile) base.profileFound = true;
  base.tweetsSampled = tweets.length;

  const texts = tweets.map((t) => t.text);
  const evidence: Evidence[] = [];
  const findings: string[] = [];
  let risk = 0;

  // 1. Scam or marketing language in the account's own public output.
  const scored = texts.map((t) => analyzeLocal({ text: t }));
  const scamHits = scored.filter((s) => s.spamLocalScore >= 45);
  const marketingHits = scored.filter((s) => s.spamLocalScore >= 25);
  if (scamHits.length) {
    const share = scamHits.length / Math.max(1, scored.length);
    risk += Math.min(60, 40 + scamHits.length * 4 + share * 20);
    findings.push(`${scamHits.length}/${scored.length} 条公开帖子含诈骗话术`);
    evidence.push({
      kind: "scam_link",
      weight: 45,
      key: `scam:account:${scamHits.length}`,
      detail: `账号公开内容中出现诈骗话术 ${scamHits.length} 次，示例：${truncate(scamHits[0].caps.join(",") || "", 80)}`,
      source: "deepscan",
      confidence: Math.min(0.95, 0.6 + share),
    });
  } else if (marketingHits.length >= 3) {
    risk += Math.min(35, 15 + marketingHits.length * 3);
    findings.push(`${marketingHits.length} 条帖子含导流/营销话术`);
    evidence.push({
      kind: "repeat_marketing",
      weight: 25,
      key: `repeat_marketing:${marketingHits.length}`,
      detail: `营销话术在账号近期公开内容中重复 ${marketingHits.length} 次`,
      source: "deepscan",
      confidence: 0.7,
    });
  }

  // 2. External links: in the bio, and repeated across posts.
  const bioLinks = profile ? linksOf(`${profile.bio ?? ""} ${profile.link ?? ""}`) : [];
  const postLinks = foreignLinks(texts);
  const repeated = [...postLinks.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  base.marketingLinks = [...new Set([...bioLinks, ...[...postLinks.keys()]])].slice(0, 12);
  if (repeated.length) {
    risk += Math.min(30, 12 + repeated.length * 6);
    findings.push(`外链在 ${repeated.length} 个站点上重复出现：${repeated.map(([h, n]) => `${h}×${n}`).slice(0, 4).join(", ")}`);
    evidence.push({
      kind: "marketing_link",
      weight: 20,
      key: `marketing_link:repeat:${repeated.map(([h]) => h).join(",")}`.slice(0, 120),
      detail: `同一批外链被反复发布：${repeated.map(([h, n]) => `${h}×${n}`).slice(0, 6).join(", ")}`,
      source: "deepscan",
      confidence: 0.75,
    });
  }
  if (bioLinks.length && profile) {
    risk += 8;
    findings.push(`简介含外链：${bioLinks.slice(0, 3).join(", ")}`);
    evidence.push({
      kind: "profile_signal",
      weight: 8,
      key: `profile_signal:link:${bioLinks[0]}`.slice(0, 120),
      detail: `公开简介包含导流链接 ${bioLinks.slice(0, 3).join(", ")}`,
      source: "deepscan",
      confidence: 0.5,
    });
  }

  // 3. Self-duplication: the same pitch pasted over and over.
  const dup = clusterDuplicates(texts);
  base.duplicateClusters = dup.clusters;
  if (dup.clusters) {
    risk += Math.min(30, 10 + dup.largest * 3);
    findings.push(`${dup.clusters} 组高度相似的公开帖子（最大一组 ${dup.largest} 条）`);
    evidence.push({
      kind: "duplicate_content",
      weight: 20,
      key: `duplicate_content:self:${dup.clusters}`,
      detail: `账号自身内容重复：${dup.clusters} 组，最大簇 ${dup.largest} 条`,
      source: "deepscan",
      confidence: Math.min(0.9, 0.5 + dup.largest / 10),
    });
  }

  // 4. Coordination: identical replies also posted by other accounts.
  const cross = crossAccountDuplicateReplies(db, user.id);
  base.crossAccountDuplicates = cross;
  if (cross >= 2) {
    risk += Math.min(40, 20 + cross * 4);
    findings.push(`${cross} 条回复与其他账号文本完全一致`);
    evidence.push({
      kind: "spam_ring",
      weight: 35,
      key: `spam_ring:identical:${cross}`,
      detail: `本账号有 ${cross} 条回复与不同账号的回复逐字相同`,
      source: "deepscan",
      confidence: Math.min(0.95, 0.6 + cross * 0.05),
    });
  }

  // 5. Freshness alone is weak evidence, so it can only ever add a little.
  if (profile?.createdAt) {
    const ageDays = (now.getTime() - Date.parse(profile.createdAt)) / 86400000;
    if (Number.isFinite(ageDays) && ageDays < 21) {
      risk += 5;
      findings.push(`账号存在仅 ${Math.max(0, Math.round(ageDays))} 天`);
      evidence.push({
        kind: "profile_signal",
        weight: 5,
        key: "profile_signal:new_account",
        detail: `注册时间短（${Math.round(ageDays)} 天）`,
        source: "deepscan",
        confidence: 0.4,
      });
    }
  }

  // 6. Anomalies already on file (accumulated, deduped, decayed elsewhere).
  const prior = activeEvidence(db, user.id).filter((e) => e.kind !== "profile_signal" && e.weight >= 15);
  if (prior.length >= 2) {
    risk += Math.min(15, prior.length * 4);
    findings.push(`已存有 ${prior.length} 条高权重异常记录`);
  }

  if (errors.length) findings.push(`采集失败：${errors.join("；")}`);

  base.accountSpamRisk = Math.round(Math.min(100, Math.max(0, risk)));
  base.evidence = evidence;
  base.findings = findings;

  for (const ev of evidence) {
    if (ev.confidence < cfg.thresholds.minConfidenceToRecord) continue;
    addEvidence(db, user.id, ev, {});
  }
  if (base.accountSpamRisk >= cfg.thresholds.deepScanMin) setUserTier(db, user.id, "deep_scan");
  logEvent(db, "info", "deepscan_done", {
    user: user.handle,
    sampled: base.tweetsSampled,
    risk: base.accountSpamRisk,
    evidence: evidence.map((e) => e.kind),
  });
  return base;
}
