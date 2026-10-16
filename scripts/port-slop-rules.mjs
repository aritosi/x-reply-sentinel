#!/usr/bin/env node
// Derives src/rules/en.ported.json from the MIT-licensed slop.json lexicon
// (github.com/Jakeschincariol/instagram-agent-skill, skills/ig-human/slop.json).
// Attribution is preserved inside the generated file. Python/PCRE-only regex bits
// are translated to JS and every pattern is compile-checked before it is emitted.
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2] ?? "/tmp/xsentinel-ref/Jakeschincariol/instagram-agent-skill/skills/ig-human/slop.json";
const OUT = process.argv[3] ?? path.resolve("src/rules/en.ported.json");

const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));

const familyWeight = { verbs: 2, adjectives: 2, nouns: 3, connectives: 3, adverbs: 2, openers: 5, closers: 4 };

const words = (raw.words ?? []).map((w) => ({
  t: String(w.find).toLowerCase(),
  w: familyWeight[w.family] ?? 2,
  f: w.family ?? "vocab",
}));

const phrases = (raw.phrases ?? []).map((p) => ({
  p: String(p.find).toLowerCase(),
  w: familyWeight[p.family] ?? 4,
  f: p.family ?? "phrase",
  pos: p.family === "openers" ? "start" : "anywhere",
}));

const dropped = [];
/**
 * Python -> JS regex translation. Three things actually break in this corpus:
 * inline `(?i)` / `(?m)` groups, `\UXXXXXXXX` astral escapes, and `(?x)`
 * verbose mode (unsupported, so those patterns are dropped instead of
 * silently mis-compiled). Everything else ports straight across.
 */
function translateRegex(input) {
  let re = String(input ?? "");
  let flags = "";
  re = re.replace(/\(\?([aiLmsux]+)\)/g, (_m, f) => {
    if (f.includes("x")) throw new Error("(?x) verbose mode is not portable");
    if (f.includes("i")) flags += "i";
    if (f.includes("m")) flags += "m";
    if (f.includes("s")) flags += "s";
    return "";
  });
  re = re.replace(/\\U([0-9a-fA-F]{8})/g, (_m, hex) => `\\u{${parseInt(hex, 16).toString(16).toUpperCase()}}`);
  // Character-class astral escapes need the u flag to mean what Python meant.
  flags += "u";
  if (flags.includes("i")) flags = "i" + flags.replace(/i/g, "");
  return { re, flags: [...new Set(flags)].join("") };
}

const structures = (raw.structures ?? [])
  .map((s) => {
    try {
      const { re, flags } = translateRegex(s.regex);
      new RegExp(re, flags);
      return { name: s.id ?? "struct", re, flags, w: 5, f: "structure", note: s.name };
    } catch (e) {
      dropped.push({ name: s.name ?? s.id, error: String(e).slice(0, 90) });
      return null;
    }
  })
  .filter(Boolean);

const out = {
  _attribution:
    "Derived from slop.json in github.com/Jakeschincariol/instagram-agent-skill (skills/ig-human), " +
    "MIT License, Copyright (c) the repository authors. Ported into this project's rule schema: " +
    "fields renamed, inline (?i)/(?m) groups and Python \\UXXXXXXXX escapes converted to JS, " +
    "weights assigned by family. See docs/research.md for the full reuse ledger.",
  lang: "en",
  version: "ported-1",
  invisible: raw.invisible ?? [],
  typographic: raw.typographic ?? [],
  words,
  phrases,
  structures,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log("wrote", OUT);
console.log("words", words.length, "phrases", phrases.length, "structures", structures.length, "dropped", dropped.length);
if (dropped.length) console.log(dropped);
