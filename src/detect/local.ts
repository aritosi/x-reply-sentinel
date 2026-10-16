import type { Evidence, LangTag, StyleSignals } from "../types.ts";
import { bucketOf, loadRules, type Compiled, type LoadedRules, type Ruleset } from "./rules.ts";
import { detectLang, normalizeForHash, shingles, jaccard, truncate } from "../util.ts";

/**
 * Layer 1 — the zero-token rules engine (spec §四).
 *
 * Design rules that the code actually enforces:
 *  1. Every tell contributes to a *family* score, never to the final number
 *     directly. The final number is a weighted blend of families.
 *  2. A single family, however loud, cannot push a reply past the review tier
 *     (`MULTI_FAMILY_CAP`). This is the implementation of "不能单凭某个关键词
 *     直接判定 AI". The one exception is an explicit chat-artifact leak
 *     ("as an AI", "hope this helps"), which is direct evidence of generation
 *     rather than a stylistic guess — it gets its own family and is allowed to
 *     reach the deep-scan band, still never a block.
 *  3. Long reply with no concrete anchors is itself a signal (the "无实际内容的
 *     深度分析" case), so specificity is scored by absence of human anchors,
 *     scaled by length — a 15-char praise is not punished for being short.
 */

export const ENGINE_VERSION = "1.0.0";

const MULTI_FAMILY_CAP = 45;
const DENSE_SINGLE_CAP = 58;
const TWO_FAMILY_CAP = 78;
const CHAT_LEAK_FLOOR = 60;

/**
 * Calibration constants, tuned against tests/corpus (see `npm run test:eval`).
 * `SATURATION` is the weighted-family sum that means "certainly machine-ish";
 * anything above it clamps to 100. `CORROBORATION_STEP` is the multiplier each
 * additional independent family buys, which is how the engine encodes "one
 * keyword proves nothing, several independent tells prove a lot".
 */
const SATURATION = 0.85;
const CORROBORATION_STEP = 0.17;
const DIVISORS = {
  lexicon: 4.5,
  structure: 8,
  opener: 4,
  tail: 4,
  formatting: 6,
  chat_leak: 5,
  marketing: 6,
  scam: 5,
} as const;

/**
 * How diagnostic each family is on its own (1.0 = the strongest tell in the
 * set). Applied before ranking, so "flat rhythm" can never carry a verdict by
 * itself the way a template structure can.
 */
const DIAGNOSTIC: Record<keyof StyleSignals, number> = {
  lexiconDensity: 0.95,
  templateStructure: 1.0,
  praiseOpener: 0.85,
  engagementQuestion: 0.8,
  restatement: 0.85,
  formattingTells: 0.9,
  specificity: 0.5,
  rhythm: 0.35,
  marketingLink: 0,
  duplicate: 0,
};

/**
 * Positional weights over the ranked families. One saturated family lands at 48
 * (observe, never review), two land at 70, three at 84, four at 93. That is the
 * whole calibration story in one line: the *number of independent tells* moves
 * the score, their raw magnitude only fills in the shape.
 */
const POSITIONAL = [0.48, 0.22, 0.14, 0.09, 0.07];

/** Style families that may raise ai_style_score; marketing/duplicate are routed to spam risk instead. */
const STYLE_KEYS: Array<keyof StyleSignals> = [
  "lexiconDensity",
  "templateStructure",
  "praiseOpener",
  "engagementQuestion",
  "restatement",
  "formattingTells",
  "specificity",
  "rhythm",
];

const KIND_BY_BUCKET: Record<string, Evidence["kind"]> = {
  lexicon: "lexicon_slop",
  structure: "template_structure",
  opener: "praise_opener",
  tail: "engagement_question",
  formatting: "formatting_tells",
  chat_leak: "chat_leak",
};

const STYLE_WEIGHT: Record<string, number> = {
  lexicon_slop: 3,
  template_structure: 6,
  praise_opener: 3,
  engagement_question: 3,
  formatting_tells: 4,
  restatement: 4,
  low_specificity: 4,
  flat_rhythm: 2,
  chat_leak: 14,
};

const SPAM_WEIGHT: Record<string, number> = {
  marketing_link: 25,
  scam_link: 45,
  duplicate_content: 25,
};

export interface LocalInput {
  text: string;
  lang?: LangTag;
  /** Original post body — enables the restatement tell. */
  rootText?: string;
  /** Best character-shingle Jaccard against another reply in the same thread. */
  threadDuplicateMax?: number;
  /** Share of this author's stored replies that are near-duplicates of each other. */
  authorDuplicateRate?: number;
  /** Handle of the reply author, used to strip self-mentions before scoring. */
  handle?: string;
}

export interface LocalResult {
  lang: LangTag;
  signals: StyleSignals;
  evidence: Evidence[];
  aiStyleScore: number;
  spamLocalScore: number;
  confidence: number;
  families: string[];
  caps: string[];
  matched: Array<{ family: string; src: string; count: number }>;
}

let cachedRules: LoadedRules | null = null;

export function rules(): LoadedRules {
  if (!cachedRules) cachedRules = loadRules();
  return cachedRules;
}

export function resetRulesCache(): void {
  cachedRules = null;
}

function codepoints(s: string): number {
  return Array.from(s).length;
}

interface Hit {
  compiled: Compiled;
  count: number;
  samples: string[];
}

function matchAll(text: string, list: Compiled[], maxPerRule = 6): Hit[] {
  const out: Hit[] = [];
  for (const c of list) {
    c.re.lastIndex = 0;
    let count = 0;
    const samples: string[] = [];
    for (const m of text.matchAll(c.re)) {
      count++;
      if (samples.length < 3) samples.push(truncate(m[0].trim(), 40));
      if (count >= maxPerRule) break;
    }
    if (count > 0) out.push({ compiled: c, count, samples });
  }
  return out;
}

/** Aggregate raw hits into a 0..1 family score, capped so repetition cannot dominate. */
function familyScore(hits: Hit[], divisor: number): { score: number; weight: number; srcs: string[]; samples: string[] } {
  const weight = hits.reduce((s, h) => s + h.compiled.w * Math.min(h.count, 3), 0);
  const srcs = [...new Set(hits.map((h) => h.compiled.src))];
  const samples = hits.flatMap((h) => h.samples).slice(0, 4);
  return { score: Math.min(1, weight / divisor), weight, srcs, samples };
}

const RE_FIRST_PERSON = /\b(i|im|i'm|ive|my|me|we|our|us)\b/i;
const RE_ANECDOTE_EN = /\b(did|went|tried|had|have|was|were|got|spent|ran|built|tested|learned|used|last|yesterday|today|this morning|week ago|months? ago)\b/i;
const RE_NUMBERS = /\d+(?:[.,]\d+)?\s*(?:%|k|m|b|万|亿|千|百|个|天|周|月|年|次|倍)?/;
const RE_ZH_FIRST_PERSON = /我|俺|咱|自己|本人/;
const RE_ZH_ANECDOTE = /了|过|昨天|上周|上次|前天|之前|试过|亲测|刚看|刚买|踩过的坑/;
const RE_HANDLE_MENTION = /@[A-Za-z0-9_]{1,15}/;
const RE_URL = /(?:https?:\/\/|www\.)\S+|(?:\b[a-z0-9-]+\.(?:com|cn|io|ai|xyz|link|net|org|shop|top)\b(?:\/\S*)?)/i;

function specificity(text: string, lang: LangTag, humanHits: number, chars: number): { score: number; anchors: string[] } {
  const anchors: string[] = [];
  if (RE_NUMBERS.test(text)) anchors.push("数字");
  if (lang === "zh" ? RE_ZH_FIRST_PERSON.test(text) : RE_FIRST_PERSON.test(text)) anchors.push("第一人称");
  if (lang === "zh" ? RE_ZH_ANECDOTE.test(text) : RE_ANECDOTE_EN.test(text)) anchors.push("具体经历");
  if (humanHits >= 2) anchors.push("口语标记");
  if (RE_HANDLE_MENTION.test(text)) anchors.push("@提及");
  if (RE_URL.test(text)) anchors.push("外链");
  // A reply that is entirely lowercase in English reads like a person typing fast.
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (lang === "en" && letters.length > 20 && letters === letters.toLowerCase()) anchors.push("全小写");
  if (/[?？]{2,}|!{2,}|[哈嘻哇咳]{2,}/.test(text)) anchors.push("情绪标点");

  const lengthFactor = Math.min(1, Math.max(0, (chars - 30) / 150));
  const absence = Math.max(0, 1 - anchors.length / 3);
  return { score: Number((absence * lengthFactor).toFixed(3)), anchors };
}

function rhythm(text: string): number {
  const sentences = text
    .split(/(?<=[.!?。！？])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  if (sentences.length < 4) return 0;
  const lens = sentences.map((s) => codepoints(s));
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean < 4) return 0;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  const cv = Math.sqrt(variance) / mean;
  // Human prose varies; templated output tends to land on evenly-sized blocks.
  if (cv < 0.3) return 0.75;
  if (cv < 0.45) return 0.45;
  if (cv < 0.6) return 0.2;
  return 0;
}

function restatement(text: string, rootText: string, lang: LangTag): number {
  const a = shingles(normalizeForHash(text), lang === "zh" ? 3 : 6);
  const b = shingles(normalizeForHash(rootText), lang === "zh" ? 3 : 6);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const coverage = inter / a.size; // how much of the *reply* is lifted from the post
  if (coverage < 0.3) return 0;
  return Number(Math.min(1, (coverage - 0.3) / 0.45).toFixed(3));
}

function pickByBucket(hits: Hit[], bucket: string): Hit[] {
  return hits.filter((h) => bucketOf(h.compiled.f) === bucket);
}

const RE_SENT_SPLIT = /(?<=[.!?。！？])\s+|\n+/;
const RE_PRAISE_SENT =
  /(?:great|excellent|fantastic|awesome|nice|love[d]?|amazing|thank[s]?|thanks for sharing|appreciate|so true|spot on|exactly|agree|insight|helpful|clear|resonate|赞同|感谢|说得好|说得太|太好了|太对|很有理|有道理|启发|楼主|写得|好文|干货|收藏|棒)/i;
const RE_ABSTRACT_SENT =
  /(?:关键在于|核心是|最重要|真正|本质上|归根|不在于|而在于|才能|意味着|值得|需要|应该|让我们|愿你|保持|培养|建立|提升|避免|实现|走向|the key|what matters|the real|it'?s not about|it'?s about|important to|essential|crucial|vital|enables?\b|allows?\b|build(?:ing)? a|focus on|prioriti[sz]e|come[sd]? down to|balance between|at a deeper level)/i;
const RE_ADVICE_SENT =
  /(?:建议|不妨|可以尝试|应该|记得|试试|最好|不妨|start with|consider\b|you should|i'?d (?:also )?(?:suggest|recommend|start|try|look)|a practical step|actionable)/i;
const RE_QUESTION_SENT = /[？?]\s*$|\b(?:how|what|why|whether|do you|would you|any thoughts|anyone else)\b|[？?]\s*$/i;

/**
 * The "读帖 — 分析 — 提问 — 建议" assembly line from spec §四: one short
 * agreement sentence, an abstract claim that commits to nothing, then a
 * reflexive question or unsolicited advice. Detecting the *shape* of the reply
 * is language-independent and survives paraphrase, which is exactly where a
 * keyword lexicon stops working.
 */
function templateFlow(text: string): { score: number; roles: string[] } {
  const sentences = text.split(RE_SENT_SPLIT).map((s) => s.trim()).filter((s) => s.length > 1);
  if (sentences.length < 2) return { score: 0, roles: [] };
  const roles = sentences.map((s) => {
    const isQuestion = RE_QUESTION_SENT.test(s);
    if (isQuestion && s.length < 70) return "Q";
    if (RE_PRAISE_SENT.test(s) && !RE_ABSTRACT_SENT.test(s) && s.length < 55) return "P";
    if (RE_ADVICE_SENT.test(s)) return "B";
    if (RE_ABSTRACT_SENT.test(s)) return "A";
    return "-";
  });
  const hasP = roles.includes("P");
  const hasA = roles.includes("A");
  const hasB = roles.includes("B");
  const endsQ = roles[roles.length - 1] === "Q";
  if (hasP && hasA && (endsQ || hasB)) return { score: 0.9, roles };
  if (hasP && (hasA || hasB || endsQ)) return { score: 0.6, roles };
  if (hasA && (endsQ || hasB)) return { score: 0.55, roles };
  if (hasA) return { score: 0.3, roles };
  return { score: 0, roles };
}

function ruleFor(lang: LangTag, r: LoadedRules): Ruleset {
  if (lang === "zh" || lang === "mixed") return lang === "mixed" ? r.zh : r.zh;
  return r.en;
}

export function analyzeLocal(input: LocalInput): LocalResult {
  const text = input.text ?? "";
  const norm = normalizeForHash(text);
  const lang: LangTag = input.lang && input.lang !== "other" ? input.lang : detectLang(text);
  const lowercase = text.toLowerCase();
  const chars = codepoints(norm);

  const loaded = rules();
  const sets: Ruleset[] = [];
  if (lang === "en") sets.push(loaded.en);
  else if (lang === "zh") sets.push(loaded.zh);
  else if (lang === "mixed") sets.push(loaded.zh, loaded.en);
  else sets.push(loaded.en);

  // --- raw matching -------------------------------------------------------
  const wordHits: Hit[] = [];
  const phraseHits: Hit[] = [];
  const structHits: Array<{ name: string; re: RegExp; w: number; f: string; matched: string }> = [];
  for (const set of sets) {
    wordHits.push(...matchAll(lowercase, set.words));
    phraseHits.push(...matchAll(lowercase, set.phrases));
    for (const s of set.structures) {
      s.re.lastIndex = 0;
      const m = text.match(s.re);
      if (m) structHits.push({ name: s.name, re: s.re, w: s.w, f: s.f, matched: truncate(m[0].trim(), 60) });
    }
  }
  const humanHits: Hit[] = [];
  for (const set of sets) humanHits.push(...matchAll(lowercase, set.human));
  const humanCount = humanHits.reduce((s, h) => s + h.count, 0);
  const humanWeight = humanHits.reduce((s, h) => s + h.compiled.w * Math.min(h.count, 2), 0);

  // --- family scores ------------------------------------------------------
  const allHits = [...wordHits, ...phraseHits];
  const lex = familyScore(pickByBucket(allHits, "lexicon"), DIVISORS.lexicon);
  const structFromPhrases = pickByBucket(allHits, "structure");
  const structFromRe = structHits
    .filter((s) => ["template", "calque", "pseudo_analysis", "summary", "inflation", "structure"].includes(s.f))
    .map((s) => ({ compiled: { re: s.re, w: s.w, f: s.f, src: s.name, pos: "anywhere" as const }, count: 1, samples: [s.matched] })) as Hit[];
  const structAgg = familyScore([...structFromPhrases, ...structFromRe], DIVISORS.structure);
  const flow = templateFlow(text);
  const flowTag = flow.score > 0 ? `句式流水线(${flow.roles.join("")})` : "";
  const structure = {
    ...structAgg,
    score: Math.min(1, structAgg.score + flow.score * 0.55),
    srcs: flow.score > 0 ? [...structAgg.srcs, "sentence_flow"] : structAgg.srcs,
    samples: flow.score > 0 ? [...structAgg.samples, flowTag] : structAgg.samples,
  };
  const opener = familyScore(pickByBucket(allHits, "opener"), DIVISORS.opener);
  const tail = familyScore(pickByBucket(allHits, "tail"), DIVISORS.tail);
  const formattingHits = [
    ...pickByBucket(allHits, "formatting"),
    ...structHits
      .filter((s) => s.f === "formatting")
      .map((s) => ({ compiled: { re: s.re, w: s.w, f: s.f, src: s.name, pos: "anywhere" as const }, count: 1, samples: [s.matched] })) as Hit[],
  ];
  const formatting = familyScore(formattingHits, DIVISORS.formatting);
  const leakHits = [
    ...pickByBucket(allHits, "chat_leak"),
    ...structHits
      .filter((s) => s.f === "chat_leak")
      .map((s) => ({ compiled: { re: s.re, w: s.w, f: s.f, src: s.name, pos: "anywhere" as const }, count: 1, samples: [s.matched] })) as Hit[],
  ];
  const chatLeak = familyScore(leakHits, DIVISORS.chat_leak);
  const spec = specificity(text, lang, humanCount, chars);
  const rhythmScore = rhythm(text);

  const restateScore = input.rootText && codepoints(norm) >= 20 ? restatement(text, input.rootText, lang) : 0;

  const duplicate = Math.min(1, Math.max(input.threadDuplicateMax ?? 0, (input.authorDuplicateRate ?? 0) * 1.2));

  const marketingHits = structHits
    .filter((s) => s.f === "marketing")
    .map((s) => ({ compiled: { re: s.re, w: s.w, f: s.f, src: s.name, pos: "anywhere" as const }, count: 1, samples: [s.matched] })) as Hit[];
  const marketing = familyScore(marketingHits, DIVISORS.marketing);
  const scamHits = structHits
    .filter((s) => s.f === "scam")
    .map((s) => ({ compiled: { re: s.re, w: s.w, f: s.f, src: s.name, pos: "anywhere" as const }, count: 1, samples: [s.matched] })) as Hit[];
  const scam = familyScore(scamHits, DIVISORS.scam);

  const signals: StyleSignals = {
    lexiconDensity: Number(lex.score.toFixed(3)),
    templateStructure: Number(structure.score.toFixed(3)),
    praiseOpener: Number(opener.score.toFixed(3)),
    engagementQuestion: Number(tail.score.toFixed(3)),
    restatement: Number(restateScore.toFixed(3)),
    formattingTells: Number(formatting.score.toFixed(3)),
    specificity: spec.score,
    rhythm: Number(rhythmScore.toFixed(3)),
    marketingLink: Number(Math.max(marketing.score, scam.score).toFixed(3)),
    duplicate: Number(duplicate.toFixed(3)),
  };

  // --- blend + guardrails -------------------------------------------------
  const ranked = STYLE_KEYS.map((k) => signals[k] * DIAGNOSTIC[k]).sort((a, b) => b - a);
  let style = 0;
  for (let i = 0; i < ranked.length; i++) style += (POSITIONAL[i] ?? 0) * (ranked[i] ?? 0);
  const active = STYLE_KEYS.filter((k) => signals[k] >= 0.25);
  // Intra-family corroboration: three *different* tells inside one family is
  // not the "one keyword" case the cap exists for, so it is allowed a bit more.
  const distinctTop = new Set(
    [...wordHits, ...phraseHits, ...structFromRe].map((h) => `${h.compiled.f}|${h.compiled.src}`),
  ).size;
  style = style * 100 * (1 + 0.03 * Math.max(0, distinctTop - 2));
  if (chatLeak.score > 0) style = Math.max(style, CHAT_LEAK_FLOOR * Math.min(1, chatLeak.score * 1.25));

  const caps: string[] = [];
  const denseSingle = active.length < 2 && distinctTop >= 3;
  if (chatLeak.score <= 0 && active.length < 2 && !denseSingle) {
    if (style > MULTI_FAMILY_CAP) {
      style = MULTI_FAMILY_CAP;
      caps.push("single_family_cap");
    }
  } else if (denseSingle && style > DENSE_SINGLE_CAP) {
    style = DENSE_SINGLE_CAP;
    caps.push("dense_single_family_cap");
  } else if (chatLeak.score <= 0 && active.length === 2 && style > TWO_FAMILY_CAP) {
    style = TWO_FAMILY_CAP;
    caps.push("two_family_cap");
  }
  // Strong conversational anchors pull the score down, never below zero-sum.
  if (humanWeight >= 5 && style > 30) {
    style = style * 0.82;
    caps.push("human_markers_discount");
  }

  const aiStyleScore = Math.round(Math.max(0, Math.min(100, style)));
  const spamLocalScore = Math.round(Math.min(100, scam.score * 55 + marketing.score * 30 + duplicate * 25));

  // --- evidence -----------------------------------------------------------
  const evidence: Evidence[] = [];
  const conf = (s: number) => Number(Math.min(0.95, 0.45 + s * 0.5).toFixed(2));
  const push = (kind: Evidence["kind"], score: number, detail: string, srcs: string) => {
    if (score <= 0) return;
    evidence.push({
      kind,
      weight: STYLE_WEIGHT[kind] ?? 3,
      key: `${kind}:${srcs}`,
      detail: detail.slice(0, 400),
      source: "local",
      confidence: conf(score),
    });
  };

  push("lexicon_slop", lex.score, `术语/ praise 词密度 ${lex.weight}/100字：${lex.samples.join(" | ")}`, lex.srcs.slice(0, 5).join(","));
  push(
    "template_structure",
    structure.score,
    `模板结构 ${structFromPhrases.length + structFromRe.length} 项${flowTag ? " + " + flowTag : ""}：${[...structFromRe.map((x) => x.compiled.src), flowTag].filter(Boolean).join(",")}`,
    structure.srcs.slice(0, 5).join(","),
  );
  push("praise_opener", opener.score, `机械式开场赞美：${opener.samples.join(" | ")}`, opener.srcs.slice(0, 3).join(","));
  push("engagement_question", tail.score, `模板化提问收尾：${tail.samples.join(" | ")}`, tail.srcs.slice(0, 3).join(","));
  push("formatting_tells", formatting.score, `过度结构化排版：${formatting.samples.join(" | ")}`, formatting.srcs.slice(0, 4).join(","));
  push("chat_leak", chatLeak.score, `对话模型残留用语：${chatLeak.samples.join(" | ")}`, chatLeak.srcs.slice(0, 3).join(","));
  push("restatement", restateScore, `复述原帖（覆盖率折算）${restateScore}`, "root_overlap");
  push("low_specificity", spec.score, `缺少具体锚点（未出现：${["数字", "第一人称", "具体经历", "口语标记", "@提及", "外链"].filter((a) => !spec.anchors.includes(a)).join("、")}）`, "no_anchors");
  push("flat_rhythm", rhythmScore, `句长方差过低（节奏均匀）`, "flat_rhythm");

  if (marketing.score > 0)
    evidence.push({
      kind: "marketing_link",
      weight: SPAM_WEIGHT.marketing_link,
      key: `marketing_link:${marketing.srcs.slice(0, 3).join(",")}`,
      detail: `导流/外链特征：${marketing.samples.join(" | ")}`,
      source: "local",
      confidence: conf(marketing.score),
    });
  if (scam.score > 0)
    evidence.push({
      kind: "scam_link",
      weight: SPAM_WEIGHT.scam_link,
      key: `scam_link:${scam.srcs.slice(0, 3).join(",")}`,
      detail: `诈骗话术：${scam.samples.join(" | ")}`,
      source: "local",
      confidence: conf(scam.score),
    });
  if (duplicate >= 0.55)
    evidence.push({
      kind: "duplicate_content",
      weight: SPAM_WEIGHT.duplicate_content,
      key: "duplicate_content:thread_or_author_cluster",
      detail: `与同帖/同作者既有回复相似度 ${duplicate.toFixed(2)}`,
      source: "local",
      confidence: conf(duplicate),
    });

  const confidence = Number(
    Math.min(0.9, 0.3 + active.length * 0.12 + (chatLeak.score > 0 ? 0.25 : 0) + (restateScore > 0 ? 0.05 : 0)).toFixed(2),
  );

  const families = [
    lex.score > 0 ? "lexicon" : null,
    structure.score > 0 ? "structure" : null,
    opener.score > 0 ? "opener" : null,
    tail.score > 0 ? "tail" : null,
    formatting.score > 0 ? "formatting" : null,
    chatLeak.score > 0 ? "chat_leak" : null,
    restateScore > 0 ? "restatement" : null,
    spec.score > 0 ? "low_specificity" : null,
    rhythmScore > 0 ? "rhythm" : null,
  ].filter(Boolean) as string[];

  const matched = [...wordHits, ...phraseHits].map((h) => ({
    family: h.compiled.f,
    src: h.compiled.src,
    count: h.count,
  }));

  return {
    lang,
    signals,
    evidence,
    aiStyleScore,
    spamLocalScore,
    confidence,
    families,
    caps,
    matched,
  };
}
