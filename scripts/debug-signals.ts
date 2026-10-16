#!/usr/bin/env node
// Ad-hoc inspector: prints the Layer-1 family breakdown for corpus rows.
// Usage: node scripts/debug-signals.ts [id-substring ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLocal } from "../src/detect/local.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "tests/corpus/labeled-replies.json"), "utf8")) as Array<{
  id: string;
  text: string;
  lang: string;
  label: string;
  note?: string;
}>;

const needles = process.argv.slice(2);
const rows = needles.length ? corpus.filter((r) => needles.some((n) => r.id.includes(n))) : corpus.filter((r) => r.label !== "human").slice(0, 12);
for (const r of rows) {
  const a = analyzeLocal({ text: r.text, lang: r.lang as never });
  console.log(`\n### ${r.id} [${r.label}] style=${a.aiStyleScore} spam=${a.spamLocalScore} conf=${a.confidence}`);
  console.log(`    fams: ${a.families.join(",") || "-"}   caps: ${a.caps.join(",") || "-"}`);
  console.log(`    sig : ${Object.entries(a.signals).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`);
  console.log(`    hits: ${a.matched.map((m) => `${m.src}(${m.family})`).join(", ") || "-"}`);
  console.log(`    note: ${r.note ?? ""}`);
  console.log(`    txt : ${r.text.replace(/\n/g, " ").slice(0, 120)}`);
}
