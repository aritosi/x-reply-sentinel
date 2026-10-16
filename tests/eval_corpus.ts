#!/usr/bin/env node
/**
 * Corpus gate (spec §十二 验收). Loads tests/corpus/labeled-replies.json, runs
 * Layer 1 only, and fails the build when the false-positive or recall numbers
 * drift past the agreed floors. Layer 2 is deliberately excluded: it needs a
 * network call, and the whole point of this file is that the zero-token layer
 * is measurable on its own.
 *
 * Two metrics are kept apart on purpose:
 *   conviction  — Layer 1 alone puts a reply in the 50-69 / 70-100 bands.
 *   routing     — Layer 1 hands the reply to Layer 2 (grey band) instead of
 *                 quietly passing it. Layer 1 is a cheap filter, not a judge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeLocal, type LocalResult } from "../src/detect/local.ts";
import { loadConfig } from "../src/config.ts";

interface Row {
  id: string;
  text: string;
  lang: string;
  label: string;
  bucket: string;
  note?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(here, "corpus", "labeled-replies.json"), "utf8")) as Row[];
const cfg = loadConfig({ env: { XRS_DATA_DIR: process.env.XRS_DATA_DIR ?? "/tmp/xrs-eval" } });
const REVIEW = cfg.thresholds.reviewMin;
const DEEP = cfg.thresholds.deepScanMin;
const GREY_LOW = cfg.llm.greyZone[0];
const GREY_HIGH = cfg.llm.greyZone[1];

// One analyzeLocal() call per row, everything else reads this map.
const scored: Array<{ r: Row, res: LocalResult }> = corpus.map((r) => ({
  r,
  res: analyzeLocal({ text: r.text, lang: r.lang as never }),
}));
const byId = new Map(scored.map((x) => [x.r.id, x]));

interface Stats {
  n: number;
  styleAvg: number;
  atLeastReview: number;
  atLeastDeep: number;
  routed: number;
  spamFlagged: number;
}

const byLabel = new Map<string, Stats>();
for (const { r, res } of scored) {
  const s = byLabel.get(r.label) ?? { n: 0, styleAvg: 0, atLeastReview: 0, atLeastDeep: 0, routed: 0, spamFlagged: 0 };
  s.n++;
  s.styleAvg += res.aiStyleScore;
  if (res.aiStyleScore >= REVIEW) s.atLeastReview++;
  if (res.aiStyleScore >= DEEP) s.atLeastDeep++;
  if (res.aiStyleScore >= GREY_LOW) s.routed++;
  if (res.spamLocalScore >= 30) s.spamFlagged++;
  byLabel.set(r.label, s);
}

function fmt(label: string): string {
  const s = byLabel.get(label);
  if (!s) return `${label.padEnd(15)} (absent)`;
  const pct = (n: number) => `${((n / s.n) * 100).toFixed(0).padStart(3)}%`;
  return `${label.padEnd(15)} n=${String(s.n).padStart(3)}  avg=${(s.styleAvg / s.n).toFixed(1).padStart(5)}` +
    `  >=${REVIEW}: ${String(s.atLeastReview).padStart(3)} ${pct(s.atLeastReview)}` +
    `  >=${DEEP}: ${String(s.atLeastDeep).padStart(3)} ${pct(s.atLeastDeep)}` +
    `  routed>=${GREY_LOW}: ${String(s.routed).padStart(3)} ${pct(s.routed)}` +
    `  spam>=30: ${String(s.spamFlagged).padStart(3)}`;
}

console.log(`corpus rows: ${corpus.length}   bands: review>=${REVIEW} deep>=${DEEP}   grey=[${GREY_LOW},${GREY_HIGH}]`);
for (const label of ["human", "ai_slop", "spam_marketing", "scam"]) console.log(fmt(label));

// Hard buckets get their own readout: they are the cases the whole design
// revolves around (AI-looking humans, and human-looking AI).
for (const bucket of ["hard_negative", "hard_positive"]) {
  const rows = scored.filter((x) => x.r.bucket === bucket);
  const over = rows.filter((x) => x.res.aiStyleScore >= DEEP);
  console.log(`\n${bucket} (n=${rows.length}): >=${DEEP} -> ${over.length}, >=${REVIEW} -> ${rows.filter((x) => x.res.aiStyleScore >= REVIEW).length}`);
  for (const f of over) console.log(`   ! ${f.r.id} ${f.res.aiStyleScore} [${f.r.label}] ${f.r.text.replace(/\s+/g, " ").slice(0, 70)}`);
}

const human = byLabel.get("human")!;
const slop = byLabel.get("ai_slop")!;
const spamRows = scored.filter((x) => x.r.label === "spam_marketing" || x.r.label === "scam");
const humanEasy = scored.filter((x) => x.r.label === "human" && x.r.bucket === "easy");
const slopEasy = scored.filter((x) => x.r.label === "ai_slop" && x.r.bucket === "easy");

const humanFpReview = scored.filter((x) => x.r.label === "human" && x.res.aiStyleScore >= REVIEW);
const humanDeep = scored.filter((x) => x.r.label === "human" && x.res.aiStyleScore >= DEEP);
const humanQueued = scored.filter((x) => x.r.label === "human" && x.res.aiStyleScore >= GREY_LOW && x.res.aiStyleScore < GREY_HIGH);
const slopHit = slopEasy.filter((x) => x.res.aiStyleScore >= REVIEW);
const slopRouted = slopEasy.filter((x) => x.res.aiStyleScore >= GREY_LOW);
const spamSignal = spamRows.filter((x) => x.res.spamLocalScore >= 15);
const styleOnlyDeep = spamRows.filter((x) => x.res.aiStyleScore >= DEEP && x.res.spamLocalScore < 15);
const deepNoSpam = scored.filter((x) => x.res.aiStyleScore >= DEEP && (x.r.label === "spam_marketing" || x.r.label === "scam") && x.res.spamLocalScore < 15);

const checks: Array<{ name: string; ok: boolean; got: string; want: string }> = [
  {
    name: "human rows convicted at review band",
    ok: humanFpReview.length <= Math.floor(human.n * 0.04),
    got: `${humanFpReview.length}/${human.n}`,
    want: `<= ${Math.floor(human.n * 0.04)} (4%)`,
  },
  {
    name: "human rows never reach the deep-scan band on style alone",
    ok: humanDeep.length === 0,
    got: `${humanDeep.length}`,
    want: `0`,
  },
  {
    name: "easy ai_slop convicted at review band",
    ok: slopHit.length / Math.max(1, slopEasy.length) >= 0.6,
    got: `${slopHit.length}/${slopEasy.length}`,
    want: `>= 60%`,
  },
  {
    name: "easy ai_slop routed (convicted or handed to Layer 2)",
    ok: slopRouted.length / Math.max(1, slopEasy.length) >= 0.92,
    got: `${slopRouted.length}/${slopEasy.length}`,
    want: `>= 92%`,
  },
  {
    name: "human rows kept out of the paid Layer 2 queue",
    ok: humanQueued.length <= Math.max(4, Math.floor(human.n * 0.08)),
    got: `${humanQueued.length}/${human.n}`,
    want: `<= ${Math.max(4, Math.floor(human.n * 0.08))} (8%, token cost guard)`,
  },
  {
    name: "spam/scam rows carry a local verifiable signal",
    ok: spamSignal.length / Math.max(1, spamRows.length) >= 0.8,
    got: `${spamSignal.length}/${spamRows.length}`,
    want: `>= 80%`,
  },
  {
    name: "no spam/scam row sits at deep band without spam evidence",
    ok: deepNoSpam.length === 0,
    got: `${deepNoSpam.length}`,
    want: `0 (style alone must not imply blocking)`,
  },
];

const missed = slopEasy.filter((x) => x.res.aiStyleScore < GREY_LOW).sort((a, b) => a.res.aiStyleScore - b.res.aiStyleScore).slice(0, 8);
if (missed.length) {
  console.log(`\nquietly-missed easy ai_slop (first ${missed.length}):`);
  for (const m of missed) console.log(`   - ${m.r.id} ${m.res.aiStyleScore} ${m.r.text.replace(/\s+/g, " ").slice(0, 78)}`);
}
if (humanFpReview.length) {
  console.log(`\nhuman rows at >=${REVIEW}:`);
  for (const f of humanFpReview) console.log(`   x ${f.r.id} ${f.res.aiStyleScore} [${f.r.bucket}] caps=${f.res.caps.join(",") || "-"} ${f.r.text.replace(/\s+/g, " ").slice(0, 64)}`);
}
const weakSpam = spamRows.filter((x) => x.res.spamLocalScore < 15);
if (weakSpam.length) {
  console.log(`\nspam/scam rows with no local signal (${weakSpam.length}):`);
  for (const x of weakSpam) console.log(`   ? ${x.r.id} spam=${x.res.spamLocalScore} style=${x.res.aiStyleScore} ${x.r.text.replace(/\s+/g, " ").slice(0, 68)}`);
}

console.log("\nchecks:");
let failed = 0;
for (const c of checks) {
  console.log(` ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.got} (want ${c.want})`);
  if (!c.ok) failed++;
}
console.log(`\nhuman avg ${(human.styleAvg / human.n).toFixed(1)} | ai_slop avg ${(slop.styleAvg / slop.n).toFixed(1)} | style-only deep (excl. spam labels): ${styleOnlyDeep.length}`);
console.log(`\n${failed ? `${failed} CHECK(S) FAILED` : "all corpus checks passed"}`);
void byId;
process.exit(failed ? 1 : 0);
