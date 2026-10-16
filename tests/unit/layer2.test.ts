#!/usr/bin/env node
/**
 * Layer 2 (spec §四 Layer 2, §九 成本, §十一 异常恢复) — offline.
 *
 * The model is never asked anything here: every case injects a stub HTTP hook, so
 * these tests assert the contract around the call (only grey-zone items, strict
 * JSON, per-item cache, budget stop, degrade-to-local) without a key, a network
 * stack or a bill.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadConfig, type Config } from "../../src/config.ts";
import { openDb, getBudget } from "../../src/db.ts";
import { LlmChecker, PROMPT_VERSION, combineScores, parseVerdicts, type GreyItem, type LlmVerdict } from "../../src/detect/llm.ts";

let seq = 0;

function freshConfig(env: Record<string, string> = {}): Config {
  const dir = path.join("/tmp/xrs-unit", `llm-${++seq}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfg = loadConfig({
    configPath: path.join(dir, "config.json"),
    env: {
      XRS_DATA_DIR: dir,
      XRS_LLM_ENABLED: "1",
      XRS_LLM_BASE_URL: "http://stub.invalid/v1",
      XRS_LLM_MODEL: "stub-model",
      XRS_LLM_API_KEY_ENV: "XRS_UNIT_TEST_KEY",
      ...env,
    },
  });
  cfg.llm.retries = 0;
  return cfg;
}

function item(over: Partial<GreyItem> = {}): GreyItem {
  return {
    commentId: "c1",
    postId: "p1",
    userId: "u1",
    handle: "one",
    lang: "zh",
    rootText: "原文：用大模型练语言的人越来越多。",
    replyText: "值得注意的是，学习语言的本质不仅仅是掌握词汇。",
    localStyleScore: 55,
    localFamilies: ["lexicon_slop", "restatement"],
    localHits: ["值得注意的是", "不仅仅是"],
    ...over,
  };
}

/** A fake OpenAI-compatible body carrying exactly the verdicts we ask for. */
function reply(items: Array<Record<string, unknown> & { id: string }>): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ items: items.map((i) => ({ human_like: false, signals: [], reason: "stub", ...i })) }) } }],
    usage: { prompt_tokens: 900, completion_tokens: 120 },
  });
}

function withKey<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.XRS_UNIT_TEST_KEY;
  process.env.XRS_UNIT_TEST_KEY = "unit-test-value";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.XRS_UNIT_TEST_KEY;
      else process.env.XRS_UNIT_TEST_KEY = previous;
    });
}

test("没有密钥时不调用模型，保留第一层分数", async () => {
  const cfg = freshConfig({ XRS_LLM_API_KEY_ENV: "XRS_UNIT_DEFINITELY_UNSET" });
  const handle = openDb(cfg);
  let posts = 0;
  const checker = new LlmChecker({ db: handle.raw, cfg, post: async () => { posts++; return { status: 200, text: "{}" }; } });
  assert.equal(checker.unavailable, "missing_XRS_UNIT_DEFINITELY_UNSET");
  const res = await checker.check([item()]);
  assert.equal(res.halted, "missing_XRS_UNIT_DEFINITELY_UNSET");
  assert.equal(res.verdicts.size, 0);
  assert.equal(res.usage.calls, 0);
  assert.equal(posts, 0, "不可用时连请求都不该发出");
  assert.equal(res.errors.length, 0);
  handle.close();
});

test("严格 JSON：按 id 取回判决，未知 id 与垃圾输出都被丢弃", async () => {
  const cfg = freshConfig();
  const handle = openDb(cfg);
  const items = [item({ commentId: "c1" }), item({ commentId: "c2" })];
  let seenBody = "";
  const res = await withKey(async () => {
    const checker = new LlmChecker({
      db: handle.raw,
      cfg,
      post: async (_url, init) => {
        seenBody = String((init.body as string) ?? "");
        return { status: 200, text: reply([{ id: "c1", ai_style: 91, spam: 5, confidence: 0.82 }, { id: "ghost", ai_style: 3 }]) };
      },
    });
    return checker.check(items);
  });
  assert.equal(res.halted, null);
  assert.equal(res.usage.calls, 1);
  assert.equal(res.verdicts.size, 1, "只接受输入里存在的 id");
  const v = res.verdicts.get("c1")!;
  assert.equal(v.aiStyle, 91);
  assert.equal(v.confidence, 0.82);
  assert.equal(v.fromCache, false);
  assert.equal(res.verdicts.has("c2"), false);
  assert.equal(getBudget(handle.raw, cfg).llmCalls, 1, "一次调用要记账");

  const parsed = parseVerdicts("这不是 JSON", items);
  assert.equal(parsed, null);
  assert.equal(seenBody.includes("c1"), true, "提示词里要带上待判定的 id");
  handle.close();
});

test("模型返回不可解析或 5xx 时记为错误，不编造判决", async () => {
  const cfg = freshConfig();
  const handle = openDb(cfg);
  // Valid envelope, prose where the JSON object should be.
  const junk = await withKey(async () => {
    const checker = new LlmChecker({
      db: handle.raw,
      cfg,
      post: async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "好的，以下是我的分析：……" } }] }) }),
    });
    return checker.check([item()]);
  });
  assert.equal(junk.verdicts.size, 0);
  assert.ok(junk.errors.some((e) => e.includes("unparseable_verdict")), junk.errors.join(","));

  // The body is not even JSON.
  const broken = await withKey(async () => {
    const checker = new LlmChecker({ db: handle.raw, cfg, post: async () => ({ status: 200, text: "<html>bad gateway</html>" }) });
    return checker.check([item({ commentId: "c-broken" })]);
  });
  assert.ok(broken.errors.some((e) => e.includes("malformed_response")), broken.errors.join(","));

  const http500 = await withKey(async () => {
    const checker = new LlmChecker({ db: handle.raw, cfg, post: async () => ({ status: 503, text: "upstream down" }) });
    return checker.check([item({ commentId: "c-503" })]);
  });
  assert.equal(http500.verdicts.size, 0);
  assert.ok(http500.errors.some((e) => e.includes("http_503")), http500.errors.join(","));
  assert.equal(getBudget(handle.raw, cfg).llmCalls, 0, "失败的调用不该计费");
  handle.close();
});

test("同一批灰区回复第二次直接命中缓存，零请求零 Token", async () => {
  const cfg = freshConfig();
  const handle = openDb(cfg);
  let posts = 0;
  const make = () =>
    new LlmChecker({
      db: handle.raw,
      cfg,
      post: async () => {
        posts++;
        return { status: 200, text: reply([{ id: "c1", ai_style: 88, spam: 2, confidence: 0.9 }]) };
      },
    });
  const first = await withKey(() => make().check([item()]));
  assert.equal(first.usage.calls, 1);
  assert.equal(posts, 1);
  const second = await withKey(() => make().check([item()]));
  assert.equal(posts, 1, "重复扫描同一回复不能再次请求模型");
  assert.equal(second.usage.calls, 0);
  assert.equal(second.usage.cacheHits, 1);
  assert.equal(second.verdicts.get("c1")?.fromCache, true);
  assert.equal(second.verdicts.get("c1")?.aiStyle, 88);
  assert.equal(getBudget(handle.raw, cfg).llmCalls, 1);
  assert.ok(PROMPT_VERSION.length > 0);
  handle.close();
});

test("预算用尽即停：达到每日调用上限后不再请求", async () => {
  const cfg = freshConfig({ XRS_LLM_MAX_CALLS_PER_DAY: "1" });
  const handle = openDb(cfg);
  let posts = 0;
  const make = () =>
    new LlmChecker({
      db: handle.raw,
      cfg,
      post: async () => {
        posts++;
        return { status: 200, text: reply([{ id: "c1", ai_style: 70 }]) };
      },
    });
  const first = await withKey(() => make().check([item({ commentId: "c1" })]));
  assert.equal(first.halted, null);
  const second = await withKey(() => make().check([item({ commentId: "c2", localHits: ["别的"] })]));
  assert.equal(second.halted, "daily_llm_calls", "超预算要停下并说明原因");
  assert.equal(second.verdicts.size, 0);
  assert.equal(posts, 1);
  handle.close();
});

test("批量上限：batchSize=1 时两条灰区拆成两次请求", async () => {
  const cfg = freshConfig({ XRS_LLM_BATCH_SIZE: "1" });
  const handle = openDb(cfg);
  let posts = 0;
  const res = await withKey(async () => {
    const checker = new LlmChecker({
      db: handle.raw,
      cfg,
      post: async () => {
        posts++;
        return { status: 200, text: reply([{ id: posts === 1 ? "c1" : "c2", ai_style: 60 }]) };
      },
    });
    return checker.check([item({ commentId: "c1" }), item({ commentId: "c2" })]);
  });
  assert.equal(posts, 2);
  assert.equal(res.usage.calls, 2);
  assert.equal(res.verdicts.size, 2);
  handle.close();
});

test("第三层合成：灰区里模型占主导，但本地多类证据与聊天泄漏不会被一句话抹掉", () => {
  const cfg = freshConfig();
  const [lo] = cfg.llm.greyZone;
  const verdict = (over: Partial<LlmVerdict>): LlmVerdict => ({
    commentId: "c1",
    aiStyle: 10,
    spam: 0,
    confidence: 0.9,
    humanLikely: false,
    reason: "",
    signals: [],
    fromCache: false,
    ...over,
  });

  const grey = combineScores(55, ["lexicon_slop", "restatement"], verdict({ aiStyle: 20 }), cfg);
  assert.equal(grey.llmUsed, true);
  assert.ok(grey.aiStyleScore < 55 && grey.aiStyleScore > 20, `灰区应折中：${grey.aiStyleScore}`);

  // Two independent local families + a chat-leak phrase keep floors the model cannot cross.
  const corroborated = combineScores(78, ["lexicon_slop", "template_structure", "chat_leak"], verdict({ aiStyle: 5 }), cfg);
  assert.ok(corroborated.aiStyleScore >= 60, `聊天泄漏应有底线：${corroborated.aiStyleScore}`);

  // An explicit, confident human verdict pulls a mid-band reply below the grey floor.
  const human = combineScores(55, ["lexicon_slop"], verdict({ aiStyle: 5, humanLikely: true, confidence: 0.9 }), cfg);
  assert.ok(human.aiStyleScore < lo, `应降到灰区下沿 ${lo} 以下：${human.aiStyleScore}`);

  // Outside the grey band Layer 1 keeps the majority weight (0.6): a model opinion
  // can soften a certain local verdict, it cannot retire it.
  const certain = combineScores(95, ["lexicon_slop"], verdict({ aiStyle: 5, humanLikely: true, confidence: 0.95 }), cfg);
  assert.ok(certain.aiStyleScore > cfg.thresholds.reviewMin, `高分回复不该被一句话洗出人工队列：${certain.aiStyleScore}`);
  assert.ok(certain.aiStyleScore < 95, `模型意见仍要起作用：${certain.aiStyleScore}`);

  // No verdict at all means the Layer 1 number survives untouched.
  const none = combineScores(42, ["lexicon_slop"], null, cfg);
  assert.deepEqual(none, { aiStyleScore: 42, confidence: 0, llmUsed: false });
});
