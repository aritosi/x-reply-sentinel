import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LangTag } from "../types.ts";
import { phraseToRegexSource, sha1 } from "../util.ts";

/**
 * Rule files are plain JSON shipped next to the source, so the engine has no
 * build-time asset handling and works when run straight from TypeScript.
 */
export interface WordRule {
  /** literal term, matched with boundary logic for latin / substring for CJK */
  t: string;
  /** weight, small integers; see docs/detection.md for the scale */
  w: number;
  /** family: vocab | praise | advice | connectives | ... */
  f: string;
}

export interface PhraseRule {
  p: string;
  w: number;
  f: string;
  pos?: "start" | "end" | "anywhere";
}

export interface StructureRule {
  name: string;
  re: string;
  flags?: string;
  w: number;
  f: string;
  note?: string;
}

export interface HumanMarker {
  t: string;
  w: number;
}

export interface RawRules {
  lang: "en" | "zh";
  version: string;
  note?: string;
  words?: WordRule[];
  phrases?: PhraseRule[];
  structures?: StructureRule[];
  human_markers?: HumanMarker[];
  invisible?: string[];
  typographic?: Array<{ find?: string; note?: string }>;
  _attribution?: string;
}

export interface Compiled {
  re: RegExp;
  w: number;
  f: string;
  /** original literal, for evidence detail strings */
  src: string;
  pos: "start" | "end" | "anywhere";
}

export interface CompiledStructure extends Compiled {
  name: string;
}

export interface Ruleset {
  lang: LangTag;
  version: string;
  words: Compiled[];
  phrases: Compiled[];
  structures: CompiledStructure[];
  human: Compiled[];
}

export interface LoadedRules {
  en: Ruleset;
  zh: Ruleset;
  version: string;
  sources: Array<{ file: string; version: string; attribution?: string }>;
}

const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rules");

const BUILTIN_FILES: Record<"en" | "zh", string[]> = {
  en: ["en.json", "en.ported.json"],
  zh: ["zh.json"],
};

function readJson(file: string): RawRules {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawRules;
  if (raw.lang !== "en" && raw.lang !== "zh") throw new Error(`${file}: unsupported lang ${String(raw.lang)}`);
  return raw;
}

/**
 * Anchor handling: a "start" phrase may still appear after an opening quote,
 * an emoji or a line break; an "end" phrase may be followed by punctuation.
 * X replies rarely begin at column 0 of a clean sentence, so anchoring has to
 * be loose enough not to miss them and tight enough not to fire mid-paragraph.
 */
function anchor(source: string, pos: "start" | "end" | "anywhere", whole: string): RegExp {
  const prefix = pos === "start" ? "(?:^|[\\n。！？!?～~\"'“”])\\s*(?:[-*•·]\\s*)?" : "";
  const suffix = pos === "end" ? "[!?！？。.…~〜\"'“”’\\)]*\\s*[?？!！.]?\\s*$" : "";
  const body = prefix + source + suffix;
  return new RegExp(body, "gmu");
}

function compileLiteral(lang: "en" | "zh", literal: string, w: number, f: string, pos: "start" | "end" | "anywhere"): Compiled {
  const src = phraseToRegexSource(literal);
  void lang;
  return { re: anchor(src, pos, literal), w, f, src: literal, pos };
}

function compileStructure(s: StructureRule): CompiledStructure {
  const flags = [...new Set((s.flags ?? "") + "mu")].join("");
  return {
    re: new RegExp(s.re, flags),
    w: s.w,
    f: s.f,
    src: s.name,
    name: s.name,
    pos: "anywhere",
  };
}

function compileFile(raw: RawRules): {
  words: Compiled[];
  phrases: Compiled[];
  structures: CompiledStructure[];
  human: Compiled[];
} {
  const words = (raw.words ?? []).map((r) => compileLiteral(raw.lang, r.t.toLowerCase(), r.w, r.f, "anywhere"));
  const phrases = (raw.phrases ?? []).map((r) =>
    compileLiteral(raw.lang, r.p.toLowerCase(), r.w, r.f, r.pos ?? "anywhere"),
  );
  // A bad operator-supplied rule file must not brick the engine: skip the
  // offending pattern and say so once, loudly, at load time.
  const structures: CompiledStructure[] = [];
  for (const s of raw.structures ?? []) {
    try {
      structures.push(compileStructure(s));
    } catch (e) {
      console.error(`[rules] ${raw.lang}@${raw.version}: skipping pattern "${s.name}" — ${(e as Error).message}`);
    }
  }
  const human = (raw.human_markers ?? []).map((r) => compileLiteral(raw.lang, r.t.toLowerCase(), r.w, "human", "anywhere"));
  return { words, phrases, structures, human };
}

function merge(lang: "en" | "zh", files: RawRules[]): Omit<Ruleset, "lang"> {
  const acc = { words: [], phrases: [], structures: [], human: [] } as ReturnType<typeof compileFile>;
  const seen = new Set<string>();
  for (const f of files) {
    const c = compileFile(f);
    // De-duplicate on (pattern, family): the MIT-ported lexicon overlaps the
    // authored one, and double-counting the same tell would inflate the score.
    const push = <T extends { src: string; f: string; name?: string }>(list: T[], item: T) => {
      const key = `${item.f}|${item.src}|${item.name ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(item);
    };
    for (const w of c.words) push(acc.words, w);
    for (const p of c.phrases) push(acc.phrases, p);
    for (const s of c.structures) push(acc.structures, s);
    for (const h of c.human) push(acc.human, h);
  }
  const version = [...files].map((f) => f.version).sort().join("+");
  return { version, ...acc };
}

export interface LoadOptions {
  rulesDir?: string;
  /** extra rule files to layer on top, e.g. an operator-maintained local.json */
  extra?: string[];
}

export function loadRules(opts: LoadOptions = {}): LoadedRules {
  const dir = opts.rulesDir ?? RULES_DIR;
  const read = (lang: "en" | "zh") =>
    BUILTIN_FILES[lang].map((name) => path.join(dir, name)).filter((f) => fs.existsSync(f)).map(readJson);
  const enFiles = read("en");
  const zhFiles = read("zh");
  for (const extra of opts.extra ?? []) {
    const raw = readJson(path.resolve(extra));
    (raw.lang === "en" ? enFiles : zhFiles).push(raw);
  }
  if (!enFiles.length || !zhFiles.length) throw new Error(`rule files missing under ${dir}`);
  const en = { lang: "en" as LangTag, ...merge("en", enFiles) };
  const zh = { lang: "zh" as LangTag, ...merge("zh", zhFiles) };
  const fingerprint = sha1(
    [en, zh].map((r) => `${r.version}:${r.words.length}:${r.phrases.length}:${r.structures.length}:${r.human.length}`).join("|"),
  ).slice(0, 12);
  return {
    en,
    zh,
    version: `${en.version}+${zh.version}#${fingerprint}`,
    sources: [...enFiles, ...zhFiles].map((f) => ({
      file: `${f.lang}@${f.version}`,
      version: f.version,
      attribution: f._attribution,
    })),
  };
}

/** Family buckets the scorer reasons about. Anything unmapped falls through to "lexicon". */
export const FAMILY_BUCKET: Record<string, string> = {
  vocab: "lexicon",
  praise: "lexicon",
  advice: "lexicon",
  connectives: "lexicon",
  adverbs: "lexicon",
  adjectives: "lexicon",
  nouns: "lexicon",
  verbs: "lexicon",
  phrase: "lexicon",
  structure: "structure",
  pseudo_analysis: "structure",
  template: "structure",
  calque: "structure",
  summary: "structure",
  inflation: "structure",
  praise_opener: "opener",
  engagement_tail: "tail",
  chat_leak: "chat_leak",
  formatting: "formatting",
  marketing: "marketing",
  scam: "scam",
  human: "human",
};

export function bucketOf(family: string): string {
  return FAMILY_BUCKET[family] ?? "lexicon";
}
