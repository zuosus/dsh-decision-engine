/**
 * 思维链翻译门槛（cotTranslate）的定点测试。
 *
 * 只钉审计里**由代码直接证明**的三件事，别的判断逻辑仍在 spec.test.js：
 *
 *   1. observe 不得改变行为 —— 本地预筛不能在 observe 下短路返回原文；
 *   2. 裁决缓存的键必须区分「同长、同前缀、尾部不同」的文本，且含源语言；
 *   3. 付费通道的 `spec.sessionId` 必须真的写进决策明细（会话归属）。
 *
 * 全部用假 translator / 假 runner / 假 telemetry：不打网络，不碰真实翻译服务，
 * 也不写任何磁盘。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createDecisionRunner } from "../lib/engine.js";
import { POINT_SPECS } from "../lib/points/spec.js";
import { mountCotTranslatePoint } from "../lib/adapters/translate.js";

/** 配置基线（只填这个点用得到的 flooring）。 */
const baseCfg = (over = {}) => ({
  mode: "shadow",
  cotProseFloor: 0.5,
  cotSameLanguageFloor: 0.8,
  ...over,
});

/** 造一个最小的 ctx：只提供 translator 服务与 effect 收集。 */
function makeCtx(services = {}) {
  const disposers = [];
  return {
    logger: { warn() {}, info() {}, error() {} },
    get(name) {
      return services[name];
    },
    effect(body) {
      const result = typeof body === "function" ? body() : body;
      if (typeof result === "function") disposers.push(result);
      return result;
    },
    disposers,
  };
}

/** 手工 runner：把每次 ask 的参数记下来，行为由调用方决定。 */
function makeFakeRunner({ mode = "enforce", ask } = {}) {
  const calls = [];
  return {
    calls,
    runner: {
      participates: () => mode !== "off",
      enforces: () => mode === "enforce",
      async ask(id, input, extra) {
        calls.push({ id, input, extra });
        return ask === undefined ? { mode } : ask(id, input, extra);
      },
    },
  };
}

/** 假的遥测出口：只记录，不写盘。 */
function makeTelemetry() {
  const entries = [];
  return {
    entries,
    telemetry: {
      async log(entry) {
        entries.push(entry);
      },
      noteAdapterError() {},
    },
  };
}

/** 造一个只返回固定译文、并记录调用的 translator。 */
function makeTranslator(reply = "译文") {
  const seen = [];
  return {
    seen,
    translator: {
      async translate(spec) {
        seen.push(spec);
        return reply;
      },
    },
  };
}

/** 一段「本地预筛会判定为无正文」的纯代码块。 */
const CODE_ONLY = "```js\nconst x = 1;\n```";

// ------------------------------------------------------------ observe 的契约

test("observe：本地预筛判定无正文时仍走原翻译器（只记录，不改变行为）", async () => {
  // 修之前：预筛的 `return text` 跑在 enforces() 之前，observe 下也直接返回
  // 原文 —— 用户拿到没翻译的代码块说明，而遥测把这次记成 observe。
  const { translator, seen } = makeTranslator("译文");
  const { runner } = makeFakeRunner({
    mode: "observe",
    // observe 下不该问模型：预筛本身是免费判断，问一次只是白花 token。
    ask: () => {
      throw new Error("observe 下不该问模型");
    },
  });
  const { telemetry, entries } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  const out = await translator.translate({ text: CODE_ONLY, targetLanguage: "zh" });
  assert.equal(out, "译文", "observe 下用户拿到的必须是真译文，而不是原文");
  assert.equal(seen.length, 1, "observe 必须真的调用原翻译器");
  assert.equal(entries.length, 1, "仍要留一条记录，否则观察数据里看不到这个点");
  assert.equal(entries[0].action, "skip");
  assert.match(entries[0].detail, /本该跳过/, "记录要说明这次「本该跳过」但还是翻译了");
});

test("enforce：本地预筛判定无正文时返回原文且不请求", async () => {
  // 反证上一条：enforce 下预筛必须真的生效，否则「省钱」就不存在。
  const { translator, seen } = makeTranslator("译文");
  const { runner, calls } = makeFakeRunner({ mode: "enforce" });
  const { telemetry, entries } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  const out = await translator.translate({ text: CODE_ONLY, targetLanguage: "zh" });
  assert.equal(out, CODE_ONLY, "enforce 下跳过时返回原文");
  assert.equal(seen.length, 0, "预筛挡掉的文本不该走到原翻译器");
  assert.equal(calls.length, 0, "更不该问模型");
  assert.equal(entries[0].detail.includes("本该跳过"), false, "enforce 下这不是「本该跳过」，而是真的跳过");
});

test("observe：缓存里存着 enforce 期的 skip 时也不得返回原文", async () => {
  // 又一条 observe 改行为的路径：缓存是跨模式存活的，切到 observe 后
  // 命中一条 enforce 期的「不需要翻译」，旧代码会直接 return text。
  const text = "Please look at this paragraph and keep it as is.";
  const { translator, seen } = makeTranslator("译文");
  const modes = { current: "enforce" };
  const runner = {
    participates: () => true,
    enforces: () => modes.current === "enforce",
    async ask() {
      return { mode: modes.current, action: { kind: "skip", reason: "已是目标语言" } };
    },
  };
  const { telemetry } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  // 先 enforce 一次，把「跳过」写进缓存。
  assert.equal(await translator.translate({ text, targetLanguage: "en" }), text);
  // 再切 observe，同一段文本：必须走原翻译器。
  modes.current = "observe";
  assert.equal(await translator.translate({ text, targetLanguage: "en" }), "译文", "observe 下缓存不得改行为");
  assert.equal(seen.length, 1);
});

// ------------------------------------------------------------ 缓存键

test("缓存键：同长、前 64 字符相同、尾部不同的文本不得共用裁决", async () => {
  // 修之前键是 length + slice(0,64)：这两段文本会撞成同一个键，
  // 第二段直接复用第一段的「需要翻译」，于是本该跳过的文本被送去翻译。
  const shared = "A".repeat(64);
  const textA = `${shared} yes please`; // 长度相同、前缀相同
  const textB = `${shared} no thanks!`;
  assert.equal(textA.length, textB.length, "测试前提：两段等长");
  assert.equal(textA.slice(0, 64), textB.slice(0, 64), "测试前提：前 64 字符相同");

  let asked = 0;
  const { translator } = makeTranslator("译文");
  const { runner } = makeFakeRunner({
    mode: "enforce",
    ask: () => {
      asked += 1;
      // 第一次判「要翻译」，第二次判「不必翻译」——顺序固定，可断言。
      return { mode: "enforce", action: { kind: asked === 1 ? "translate" : "skip", reason: "fixture" } };
    },
  });
  const { telemetry } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  assert.equal(await translator.translate({ text: textA, targetLanguage: "zh" }), "译文");
  assert.equal(await translator.translate({ text: textB, targetLanguage: "zh" }), textB, "第二段应拿到自己的裁决");
  assert.equal(asked, 2, "两段不同文本必须各问一次；共用一个键就会只问一次");
});

test("缓存键：sourceLanguage 不同不得复用同一裁决", async () => {
  // 修之前 source 根本不在键里：同一段英文标 en 与标 zh 会命中同一条裁决，
  // 可 source 正是「是否已是目标语言」那一问的输入。
  const text = "This paragraph is written in English and stays English.";
  let asked = 0;
  const { translator } = makeTranslator("译文");
  const { runner } = makeFakeRunner({
    mode: "enforce",
    ask: () => {
      asked += 1;
      return { mode: "enforce", action: { kind: "translate", reason: "fixture" } };
    },
  });
  const { telemetry } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  await translator.translate({ text, sourceLanguage: "en", targetLanguage: "zh" });
  await translator.translate({ text, sourceLanguage: "zh", targetLanguage: "zh" });
  assert.equal(asked, 2, "源语言不同就是另一个问题，必须重新裁决");
});

test("缓存键：同一段文本、同一语言对仍然命中缓存（省钱的那一半不能丢）", async () => {
  const text = "Same text asked twice should only be decided once.";
  let asked = 0;
  const { translator } = makeTranslator("译文");
  const { runner } = makeFakeRunner({
    mode: "enforce",
    ask: () => {
      asked += 1;
      return { mode: "enforce", action: { kind: "translate", reason: "fixture" } };
    },
  });
  const { telemetry } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  const spec = { text, sourceLanguage: "en", targetLanguage: "zh" };
  await translator.translate(spec);
  await translator.translate(spec);
  assert.equal(asked, 1, "完全相同的输入必须命中缓存");
});

// ------------------------------------------------------------ 会话归属

test("会话归属：付费通道的 spec.sessionId 写进决策明细", async () => {
  // 修之前 translate 传 `{ sessionId }`，引擎只读 `extra.session` —— 字段名
  // 对不上，付费通道的翻译决策也永远归不到会话（明细 sessionId 恒为空串）。
  const details = [];
  const runner = createDecisionRunner({
    getConfig: () => baseCfg(),
    client: {
      async classify() {
        return {
          answers: { prose: { type: "noul", noul: 0.9 }, same_language: { type: "noul", noul: 0.2 } },
          model: "fixture-1",
          provider: "fixture",
          latencyMs: 3,
        };
      },
    },
    logger: { warn() {}, info() {} },
    modeOf: (cfg, id) => (id === "cotTranslate" ? "enforce" : "off"),
    log: async () => {},
    specOf: (id) => POINT_SPECS[id],
    recordDetail: (record, referenced) => details.push({ record, referenced }),
  });
  const { translator } = makeTranslator("译文");
  const { telemetry } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  await translator.translate({ text: "Please translate this sentence.", targetLanguage: "zh", sessionId: "s-paid" });
  assert.equal(details.length, 1, "enforce 下拿到裁决就该写一条明细");
  assert.equal(details[0].record.sessionId, "s-paid", "会话 id 必须来自 spec.sessionId");
  assert.equal(details[0].referenced, "s-paid", "原始会话引用（id 字符串）也要原样传下去，由存储层取名");
});

test("会话归属：匿名通道（无 sessionId）保持「不可归属」而不是编一个", async () => {
  // 免费通道没有 spec.sessionId（AnonymousTranslationSpec）。为它编造一个 id
  // 会让用户看到一条不属于自己会话的记录，比缺失更糟（DEC-022）。
  const details = [];
  const runner = createDecisionRunner({
    getConfig: () => baseCfg(),
    client: {
      async classify() {
        return {
          answers: { prose: { type: "noul", noul: 0.9 }, same_language: { type: "noul", noul: 0.2 } },
          model: "fixture-1",
          latencyMs: 3,
        };
      },
    },
    logger: { warn() {}, info() {} },
    modeOf: (cfg, id) => (id === "cotTranslate" ? "enforce" : "off"),
    log: async () => {},
    specOf: (id) => POINT_SPECS[id],
    recordDetail: (record, referenced) => details.push({ record, referenced }),
  });
  const { translator } = makeTranslator("译文");
  const { telemetry } = makeTelemetry();
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry });

  await translator.translate({ text: "Anonymous channel has no session id.", targetLanguage: "zh" });
  assert.equal(details.length, 1);
  assert.equal(details[0].record.sessionId, "", "拿不到会话就必须留空");
  assert.equal(details[0].referenced, undefined, "不能给存储层塞一个假引用");
});
