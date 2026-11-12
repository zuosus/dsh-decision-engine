/**
 * 引擎与适配器的集成测试。
 *
 * 这里验证的是「接线正确」而不是「判断正确」（后者在 spec.test.js 里测）：
 *
 *   - off 模式绝不发请求
 *   - 端点降级时按原生行为继续（fail-open）
 *   - 答案形状不符时按原生行为继续，并留一条 degraded 遥测
 *   - observe 有裁决但不改变行为，enforce 才改变
 *   - 路由的三道闸真的挡住了重复判断
 *   - 每个适配器在缺少宿主服务时安静退出，不抛
 *
 * 全部用假的 client / cfg / ctx，不打网络。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createDecisionRunner } from "../lib/engine.js";
import { POINT_SPECS } from "../lib/points/spec.js";
import { mountRoutePoint } from "../lib/adapters/route.js";
import { mountToolPoints, isRetrievalTool, retrievalQuery, DEFAULT_RETRIEVAL_TOOLS } from "../lib/adapters/tools.js";
import { mountAgentPoints } from "../lib/adapters/agent.js";
import { mountCotTranslatePoint } from "../lib/adapters/translate.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


/** 配置基线。 */
const baseCfg = (over = {}) => ({
  mode: "shadow",
  recentMessages: 0,
  recentMessageChars: 240,
  routeCheapProvider: "cheap",
  routeCheapModel: "cheap-1",
  routeMaxStepsPerTurn: 2,
  routeMaxScore: 0.4,
  routeMechanicalFloor: 0.6,
  routeRiskFloor: 0.3,
  delegateConfidenceFloor: 0.5,
  delegateBlockingFloor: 0.6,
  delegateParallelFloor: 0.5,
  compactContextWindow: 100000,
  compactThresholdRatio: 0.7,
  compactTriggerTokens: 100000,
  compactToolResultChars: 8192,
  compactDistilledFloor: 0.6,
  compactVerbatinFloor: 0.6,
  turnStopMaxSteers: 1,
  turnStopClosedFloor: 0.6,
  turnStopUnfinishedFloor: 0.6,
  turnStopValueFloor: 0.35,
  turnStopAwaitingUserFloor: 0.5,
  retrievalCoveredFloor: 0.5,
  retrievalWouldAddCeiling: 0.8,
  skillPickCandidates: 8,
  skillPickConfidenceFloor: 0.5,
  cotProseFloor: 0.5,
  cotSameLanguageFloor: 0.8,
  ...over,
});

/**
 * 造一个 runner。
 * @param modes - id → 模式。
 * @param classify - 替换 client.classify 的实现。
 */
function makeRunner({ modes = {}, classify, cfg = baseCfg() } = {}) {
  const entries = [];
  const calls = [];
  /** 引擎交给统计层的裁决记录。 */
  const decisions = [];
  const client = {
    async classify(call) {
      calls.push(call);
      if (classify === undefined) return null;
      return classify(call);
    },
  };
  const runner = createDecisionRunner({
    getConfig: () => cfg,
    client,
    logger: { warn() {}, info() {} },
    modeOf: (current, id) => modes[id] ?? "off",
    log: async (entry) => entries.push(entry),
    specOf: (id) => POINT_SPECS[id],
    // 裁决统计：引擎在拿到裁决后把它交给这里（见 DEC-008）。
    recordDecision: (options) => decisions.push(options),
  });
  return { runner, entries, calls, client, cfg, decisions };
}

/** 造一个最小的 ctx，记录注册的监听器。 */
function makeCtx(services = {}) {
  const hooks = new Map();
  const disposers = [];
  return {
    logger: { warn() {}, info() {}, error() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    /**
     * 照 cordis 的语义：**立即执行** body，把它的返回值当作 disposer 收集。
     * 若 body 是 generator，只跑到第一个 yield（本插件的 generator 只在
     * 客户端 bundle 里用，服务端全部是普通函数返回 disposer）。
     */
    effect(body) {
      const result = typeof body === "function" ? body() : body;
      if (typeof result === "function") disposers.push(result);
      return result;
    },
    get(name) {
      return services[name];
    },
    hooks,
    disposers,
    /** 取第一个注册的监听器。 */
    listener(name) {
      return (hooks.get(name) ?? [])[0];
    },
  };
}

/** 造一个最小的、带 events/surface 的 session。 */
function makeSession({ events = [], nodes = [] } = {}) {
  return {
    events,
    surface: { nodes },
    eventAt(seq) {
      return events[seq];
    },
    header: { cwd: "/tmp" },
  };
}

const allowNext = () => Promise.resolve({ kind: "allow" });

// ---------------------------------------------------------------- 引擎基本语义

test("off 模式连请求都不发", async () => {
  const { runner, calls } = makeRunner({ modes: { route: "off" } });
  const result = await runner.ask("route", { turn: 1, step: 1, current: {} });
  assert.equal(result.mode, "off");
  assert.equal(result.action, undefined);
  assert.equal(calls.length, 0, "off 时不得调用 classify");
});

test("observe 会发请求并返回 action（供只记录）", async () => {
  const { runner, calls, entries } = makeRunner({
    modes: { retrieval: "observe" },
    classify: () => ({
      answers: { covered: { type: "noul", noul: 0.95 }, would_add: { type: "noul", noul: 0.05 } },
      model: "m",
      latencyMs: 12,
      cached: false,
    }),
  });
  const result = await runner.ask("retrieval", { tool: "web_search", query: "x" });
  assert.equal(calls.length, 1);
  assert.equal(result.mode, "observe");
  assert.equal(result.action.kind, "skip");
  assert.equal(runner.enforces("retrieval"), false, "observe 不允许改变行为");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "skip");
});

test("enforce 才允许改变行为", () => {
  const { runner } = makeRunner({ modes: { retrieval: "enforce" } });
  assert.equal(runner.enforces("retrieval"), true);
  assert.equal(runner.participates("retrieval"), true);
});

test("classify 返回 null（已降级）时不再重复记遥测", async () => {
  const { runner, entries } = makeRunner({ modes: { route: "enforce" }, classify: () => null });
  const result = await runner.ask("route", { turn: 1, step: 1, current: {} });
  assert.equal(result.degraded, "classify");
  assert.equal(entries.length, 0, "降级遥测由 client 自己记，不能记两遍");
});

test("答案形状不符时降级且不改行为，并留痕", async () => {
  const { runner, entries } = makeRunner({
    modes: { retrieval: "enforce" },
    // 缺 would_add 字段 —— 形状不合格
    classify: () => ({ answers: { covered: { type: "noul", noul: 0.9 } }, model: "m", latencyMs: 3, cached: false }),
  });
  const result = await runner.ask("retrieval", { tool: "web_search", query: "x" });
  assert.equal(result.degraded, "answer-shape-mismatch");
  assert.equal(result.action, undefined);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail, "answer-shape-mismatch");
});

test("遥测带 provider：它是回填历史统计时唯一可靠的归因来源", async () => {
  // 遥测若不带 provider，回填时只能按模型名猜——猜不上就是「未知（历史）」。
  const { runner, entries } = makeRunner({
    modes: { retrieval: "observe" },
    classify: () => ({
      answers: { covered: { type: "noul", noul: 0.95 }, would_add: { type: "noul", noul: 0.05 } },
      model: "startlux-decision-27b-autothink",
      provider: "bamboonode",
      latencyMs: 12,
      cached: false,
    }),
  });
  await runner.ask("retrieval", { tool: "web_search", query: "x" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, "bamboonode", "遥测必须自带 provider");
});

test("遥测带 provider：答案形状不符的降级记录也带", async () => {
  const { runner, entries } = makeRunner({
    modes: { retrieval: "enforce" },
    classify: () => ({
      answers: { covered: { type: "noul", noul: 0.9 } },
      model: "startlux-decision-27b-autothink",
      provider: "bamboonode",
      latencyMs: 3,
      cached: false,
    }),
  });
  await runner.ask("retrieval", { tool: "web_search", query: "x" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail, "answer-shape-mismatch");
  assert.equal(entries[0].provider, "bamboonode", "降级遥测也要带 provider");
});

test("缺少规格实现时按不介入处理，不抛", async () => {
  const { runner } = makeRunner({ modes: { unknownPoint: "enforce" } });
  const result = await runner.ask("unknownPoint", {});
  assert.equal(result.degraded, "no-spec");
});

// ------------------------------------------------------------ 裁决统计

test("引擎把裁决交给统计层（否则统计里永远没有 allow/ask/reject）", async () => {
  // 裁决是 spec.decide() 的产物，而 decide() 要等答案回来才跑得出来。
  // 因此统计**不能**在 classify() 里写——必须由拿到裁决的一方写。
  // （真实踩过的坑：stats.jsonl 里 132 条实时记录的 action 是空串。）
  const { runner, decisions } = makeRunner({
    modes: { retrieval: "enforce" },
    classify: () => ({
      answers: { covered: { type: "noul", noul: 0.95 }, would_add: { type: "noul", noul: 0.05 } },
      model: "m",
      latencyMs: 12,
      cached: false,
      statsFacts: { point: "retrieval", provider: "p", model: "m", inputTokens: 100, durationMs: 12 },
    }),
  });
  await runner.ask("retrieval", { tool: "web_search", query: "x" });
  assert.equal(decisions.length, 1, "裁决必须交给统计层");
  assert.equal(decisions[0].action, "skip", "裁决词要原样传下去");
  assert.equal(decisions[0].facts.inputTokens, 100, "消耗那一半也要一起传");
  assert.equal(decisions[0].degraded, undefined, "这不是降级");
});

test("答案形状不符时统计记「未裁决」，不伪造成放行", async () => {
  const { runner, decisions } = makeRunner({
    modes: { retrieval: "enforce" },
    classify: () => ({ answers: { covered: { type: "noul", noul: 0.9 } }, model: "m", latencyMs: 3, cached: false }),
  });
  await runner.ask("retrieval", { tool: "web_search", query: "x" });
  assert.equal(decisions.length, 1, "消耗仍要记：这次决策确实花过时间");
  assert.equal(decisions[0].degraded, true);
  assert.equal(decisions[0].action, "degraded");
});

test("build 抛异常时按不介入处理", async () => {
  const runner = createDecisionRunner({
    getConfig: () => baseCfg(),
    client: { async classify() { throw new Error("不该被调用"); } },
    logger: { warn() {} },
    modeOf: () => "enforce",
    log: async () => {},
    specOf: () => ({
      build() {
        throw new Error("boom");
      },
      parse: () => undefined,
      decide: () => ({ kind: "x" }),
    }),
  });
  const result = await runner.ask("any", {});
  assert.equal(result.degraded, "build-error");
});

// ---------------------------------------------------------------- 检索 / 技能

test("检索工具识别与查询提取", () => {
  const tools = new Set(DEFAULT_RETRIEVAL_TOOLS);
  assert.equal(isRetrievalTool("web_search", tools), true);
  assert.equal(isRetrievalTool("bash", tools), false);
  assert.equal(retrievalQuery({ queries: ["a", "b"] }), "a | b");
  assert.equal(retrievalQuery({ url: "https://x" }), "https://x");
  assert.equal(retrievalQuery({ question: "为什么" }), "为什么");
  assert.equal(retrievalQuery({}), "{}");
});

test("非检索工具不触发检索判断", async () => {
  const { runner, calls } = makeRunner({ modes: { retrieval: "enforce" } });
  const ctx = makeCtx();
  mountToolPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { log: async () => {}, noteAdapterError() {} },
    retrievalTools: () => new Set(DEFAULT_RETRIEVAL_TOOLS),
  });
  const listener = ctx.listener("tools/pre-execute");
  let nexted = false;
  const decision = await listener(
    { name: "bash", arguments: { command: "ls" }, agent: { session: makeSession() } },
    () => {
      nexted = true;
      return allowNext();
    },
  );
  assert.equal(decision.kind, "allow");
  assert.equal(nexted, true);
  assert.equal(calls.length, 0, "bash 不该触发检索判断");
});

test("检索判为 skip 时 enforce 会拦下", async () => {
  const { runner } = makeRunner({
    modes: { retrieval: "enforce" },
    classify: () => ({
      answers: { covered: { type: "noul", noul: 0.95 }, would_add: { type: "noul", noul: 0.05 } },
      model: "m",
      latencyMs: 5,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountToolPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { log: async () => {}, noteAdapterError() {} },
    retrievalTools: () => new Set(DEFAULT_RETRIEVAL_TOOLS),
  });
  const decision = await ctx.listener("tools/pre-execute")(
    { name: "web_search", arguments: { query: "x" }, agent: { session: makeSession() } },
    allowNext,
  );
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "STARTLUX_RETRIEVAL_SKIP");
});

test("检索判为 skip 但处于 observe 时放行", async () => {
  const { runner } = makeRunner({
    modes: { retrieval: "observe" },
    classify: () => ({
      answers: { covered: { type: "noul", noul: 0.95 }, would_add: { type: "noul", noul: 0.05 } },
      model: "m",
      latencyMs: 5,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountToolPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { log: async () => {}, noteAdapterError() {} },
    retrievalTools: () => new Set(DEFAULT_RETRIEVAL_TOOLS),
  });
  const decision = await ctx.listener("tools/pre-execute")(
    { name: "web_search", arguments: { query: "x" }, agent: { session: makeSession() } },
    allowNext,
  );
  assert.equal(decision.kind, "allow", "observe 只记录，不拦截");
});

test("技能候选少于两个时不询问", async () => {
  const { runner, calls } = makeRunner({ modes: { skillPick: "enforce" } });
  const ctx = makeCtx({
    skills: {
      async list() {
        return [{ name: "only", description: "d" }];
      },
    },
  });
  mountToolPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { log: async () => {}, noteAdapterError() {} },
    retrievalTools: () => new Set(DEFAULT_RETRIEVAL_TOOLS),
  });
  await ctx.listener("tools/pre-execute")(
    { name: "skill", arguments: { name: "only" }, agent: { session: makeSession() } },
    allowNext,
  );
  assert.equal(calls.length, 0, "只有一个候选时挑选没有意义");
});

test("技能判出更匹配项时拦下并指路", async () => {
  const { runner } = makeRunner({
    modes: { skillPick: "enforce" },
    classify: () => ({
      answers: { best: { type: "choice", choice: "right", confidence: 0.9 } },
      model: "m",
      latencyMs: 5,
      cached: false,
    }),
  });
  const ctx = makeCtx({
    skills: {
      async list() {
        return [
          { name: "wrong", description: "d1" },
          { name: "right", description: "d2" },
        ];
      },
    },
  });
  mountToolPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { log: async () => {}, noteAdapterError() {} },
    retrievalTools: () => new Set(DEFAULT_RETRIEVAL_TOOLS),
  });
  const decision = await ctx.listener("tools/pre-execute")(
    { name: "skill", arguments: { name: "wrong" }, agent: { session: makeSession() } },
    allowNext,
  );
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "STARTLUX_SKILLPICK_REDIRECT");
  assert.equal(decision.info.suggest, "right");
  assert.match(decision.reason, /right/);
});

// ---------------------------------------------------------------- 模型路由

test("路由：机械步骤被换成便宜模型（enforce）", async () => {
  const { runner } = makeRunner({
    modes: { route: "enforce" },
    classify: () => ({
      answers: {
        capability: { type: "score", score: 0, confidence: 0 },
        mechanical: { type: "noul", noul: 0.95 },
        risky: { type: "noul", noul: 0.02 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountRoutePoint(ctx, { runner, getConfig: () => baseCfg(), digestRecent: () => "", telemetry: { noteAdapterError() {} } });
  const replaced = await ctx.listener("agent/request")({ turn: 1, step: 1, agent: { session: makeSession() } }, () =>
    Promise.resolve({ provider: "strong", model: "strong-1", maxTokens: 1000 }),
  );
  assert.equal(replaced.provider, "cheap");
  assert.equal(replaced.model, "cheap-1");
  assert.equal(replaced.maxTokens, 1000, "其余字段必须原样保留");
});

test("路由：observe 不换模型", async () => {
  const { runner } = makeRunner({
    modes: { route: "observe" },
    classify: () => ({
      answers: {
        capability: { type: "score", score: 0, confidence: 0 },
        mechanical: { type: "noul", noul: 0.95 },
        risky: { type: "noul", noul: 0.02 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountRoutePoint(ctx, { runner, getConfig: () => baseCfg(), digestRecent: () => "", telemetry: { noteAdapterError() {} } });
  const kept = await ctx.listener("agent/request")({ turn: 1, step: 1, agent: { session: makeSession() } }, () =>
    Promise.resolve({ provider: "strong", model: "strong-1" }),
  );
  assert.equal(kept.provider, "strong");
});

test("路由：每轮只问 routeMaxStepsPerTurn 步", async () => {
  const { runner, calls } = makeRunner({
    modes: { route: "enforce" },
    classify: () => ({
      answers: {
        capability: { type: "score", score: 4, confidence: 0 },
        mechanical: { type: "noul", noul: 0.1 },
        risky: { type: "noul", noul: 0.9 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  const cfg = baseCfg({ routeMaxStepsPerTurn: 2 });
  mountRoutePoint(ctx, { runner, getConfig: () => cfg, digestRecent: () => "", telemetry: { noteAdapterError() {} } });
  const listener = ctx.listener("agent/request");
  const session = makeSession();
  for (let step = 1; step <= 5; step += 1) {
    await listener({ turn: 1, step, agent: { session } }, () => Promise.resolve({ provider: `p${step}`, model: `m${step}` }));
  }
  assert.equal(calls.length, 2, `应只问 2 次，实际 ${calls.length}`);
});

test("路由：换轮后重新开始判断", async () => {
  const { runner, calls } = makeRunner({
    modes: { route: "enforce" },
    classify: () => ({
      answers: {
        capability: { type: "score", score: 4, confidence: 0 },
        mechanical: { type: "noul", noul: 0.1 },
        risky: { type: "noul", noul: 0.9 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  const cfg = baseCfg({ routeMaxStepsPerTurn: 1 });
  mountRoutePoint(ctx, { runner, getConfig: () => cfg, digestRecent: () => "", telemetry: { noteAdapterError() {} } });
  const listener = ctx.listener("agent/request");
  const session = makeSession();
  await listener({ turn: 1, step: 1, agent: { session } }, () => Promise.resolve({ provider: "a", model: "a" }));
  await listener({ turn: 1, step: 2, agent: { session } }, () => Promise.resolve({ provider: "b", model: "b" }));
  await listener({ turn: 2, step: 1, agent: { session } }, () => Promise.resolve({ provider: "c", model: "c" }));
  assert.equal(calls.length, 2, "第 2 轮应重新开始计步");
});

test("路由：目标未配置时不路由", async () => {
  const { runner } = makeRunner({
    modes: { route: "enforce" },
    classify: () => ({
      answers: {
        capability: { type: "score", score: 0, confidence: 0 },
        mechanical: { type: "noul", noul: 0.95 },
        risky: { type: "noul", noul: 0.02 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  const cfg = baseCfg({ routeCheapProvider: "", routeCheapModel: "" });
  mountRoutePoint(ctx, { runner, getConfig: () => cfg, digestRecent: () => "", telemetry: { noteAdapterError() {} } });
  const kept = await ctx.listener("agent/request")({ turn: 1, step: 1, agent: { session: makeSession() } }, () =>
    Promise.resolve({ provider: "strong", model: "s" }),
  );
  assert.equal(kept.provider, "strong", "空目标不得触发路由");
});

test("路由：适配器异常时保留原 config", async () => {
  const { runner } = makeRunner({
    modes: { route: "enforce" },
    classify: () => {
      throw new Error("endpoint down");
    },
  });
  const ctx = makeCtx();
  mountRoutePoint(ctx, { runner, getConfig: () => baseCfg(), digestRecent: () => "", telemetry: { noteAdapterError() {} } });
  const kept = await ctx.listener("agent/request")({ turn: 1, step: 1, agent: { session: makeSession() } }, () =>
    Promise.resolve({ provider: "strong", model: "s" }),
  );
  assert.equal(kept.provider, "strong");
});

// ---------------------------------------------------------------- 分派 / 轮次

test("分派：enforce 且建议分派时注入提示消息", async () => {
  const { runner } = makeRunner({
    modes: { delegate: "enforce" },
    classify: () => ({
      answers: {
        scope: { type: "choice", choice: "subagent", confidence: 0.9 },
        parallel: { type: "noul", noul: 0.1 },
        blocking: { type: "noul", noul: 0.1 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg({ recentMessages: 0 }),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", content: [{ type: "text", text }], source: { kind } }),
  });
  const decision = await ctx.listener("agent/pre-step")(
    {
      turn: 1,
      step: 1,
      agent: { session: makeSession() },
      messages: [{ role: "user", content: [{ type: "text", text: "帮我重构这个模块" }] }],
    },
    () => Promise.resolve({ kind: "enter", messages: [] }),
  );
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.messages[0].source.kind, "delegate");
});

test("分派：非第一步不判断", async () => {
  const { runner, calls } = makeRunner({ modes: { delegate: "enforce" } });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", source: { kind } }),
  });
  await ctx.listener("agent/pre-step")(
    { turn: 1, step: 3, agent: { session: makeSession() }, messages: [{ role: "user", content: [] }] },
    () => Promise.resolve({ kind: "enter", messages: [] }),
  );
  assert.equal(calls.length, 0);
});

test("分派：reject 的决策不被改动", async () => {
  const { runner } = makeRunner({ modes: { delegate: "enforce" } });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", source: { kind } }),
  });
  const decision = await ctx.listener("agent/pre-step")(
    { turn: 1, step: 1, agent: { session: makeSession() }, messages: [{ role: "user", content: [] }] },
    () => Promise.resolve({ kind: "reject" }),
  );
  assert.equal(decision.kind, "reject");
});

test("轮次：判 continue 时 steer 一次，且不再续第二次", async () => {
  const { runner, calls } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: () => ({
      answers: {
        unfinished: { type: "noul", noul: 0.9 },
        value: { type: "noul", noul: 0.9 },
        closed: { type: "noul", noul: 0.1 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg({ turnStopMaxSteers: 1 }),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", content: [{ type: "text", text }], source: { kind } }),
  });
  const steered = [];
  const agent = { session: makeSession(), steer: (message) => steered.push(message) };
  const listener = ctx.listener("agent/turn-stopping");
  await listener({ turn: 1, agent });
  await listener({ turn: 1, agent });
  assert.equal(steered.length, 1, "每轮最多续一次");
  assert.equal(steered[0].source.kind, "turnStop");
  assert.equal(calls.length, 1, "已达上限后不再询问");
});

test("轮次：模型判出在等用户时**不 steer**（让位给用户，DEC-045）", async () => {
  // 「你选 A 还是 B？」这一轮：unfinished 高、value 高——若不设边界，
  // 插件会续一轮，等于替用户把选择顶掉。
  const { runner } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: () => ({
      answers: {
        unfinished: { type: "noul", noul: 0.9 },
        value: { type: "noul", noul: 0.9 },
        closed: { type: "noul", noul: 0.05 },
        awaiting_user: { type: "noul", noul: 0.95 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg({ turnStopMaxSteers: 1 }),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", content: [{ type: "text", text }], source: { kind } }),
  });
  const steered = [];
  const agent = { session: makeSession(), steer: (message) => steered.push(message) };
  await ctx.listener("agent/turn-stopping")({ turn: 1, agent });
  assert.equal(steered.length, 0, "在等用户时绝不续轮");
});

test("轮次：新宿主形状（只有 snapshotEvents）也能读到助手最后一句话", async () => {
  // 宿主把公开的 events 数组换成了 snapshotEvents()；插件原来的写法
  // `session.events ?? []` 会静默拿到空数组（DEC-045 的两个真 bug 之一）。
  const events = [
    {
      type: "assistant/message",
      seq: 0,
      data: { message: { role: "assistant", content: [{ type: "text", text: "你要选 A 还是 B？" }] } },
    },
  ];
  const modernSession = {
    snapshotEvents: () => events,
    surface: { nodes: [] },
    header: { cwd: "/tmp" },
  };
  let seenState;
  const { runner } = makeRunner({
    modes: { turnStop: "enforce" },
    classify: (call) => {
      seenState = call.state;
      return {
        answers: {
          unfinished: { type: "noul", noul: 0.2 },
          value: { type: "noul", noul: 0.2 },
          closed: { type: "noul", noul: 0.9 },
        },
        model: "m",
        latencyMs: 8,
        cached: false,
      };
    },
  });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: (text, kind) => ({ role: "user", content: [{ type: "text", text }], source: { kind } }),
  });
  const agent = { session: modernSession, steer: () => {} };
  await ctx.listener("agent/turn-stopping")({ turn: 1, agent });
  assert.ok(seenState !== undefined, "应当发过一次判断");
  assert.equal(seenState.last, "你要选 A 还是 B？", "新宿主上必须读得到助手最后一句话");
});

test("轮次：observe 不 steer", async () => {
  const { runner } = makeRunner({
    modes: { turnStop: "observe" },
    classify: () => ({
      answers: {
        unfinished: { type: "noul", noul: 0.9 },
        value: { type: "noul", noul: 0.9 },
        closed: { type: "noul", noul: 0.1 },
      },
      model: "m",
      latencyMs: 8,
      cached: false,
    }),
  });
  const ctx = makeCtx();
  mountAgentPoints(ctx, {
    runner,
    getConfig: () => baseCfg(),
    digestRecent: () => "",
    telemetry: { noteAdapterError() {} },
    makeUserMessage: () => ({ role: "user" }),
  });
  const steered = [];
  await ctx.listener("agent/turn-stopping")({ turn: 1, agent: { session: makeSession(), steer: (m) => steered.push(m) } });
  assert.equal(steered.length, 0);
});

// ---------------------------------------------------------------- 翻译门槛

test("翻译：没有 translator 服务时安静退出", () => {
  const ctx = makeCtx({});
  const mounted = mountCotTranslatePoint(ctx, {
    runner: { participates: () => true, enforces: () => true, ask: async () => ({}) },
    getConfig: () => baseCfg(),
    telemetry: { log: async () => {}, noteAdapterError() {} },
  });
  assert.equal(mounted, false);
});

test("翻译：点关闭时完全透明（原样调用原方法）", async () => {
  const calls = [];
  const translator = {
    async translate(spec) {
      calls.push(spec);
      return "译文";
    },
  };
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, {
    runner: { participates: () => false, enforces: () => false, ask: async () => ({}) },
    getConfig: () => baseCfg(),
    telemetry: { log: async () => {}, noteAdapterError() {} },
  });
  const out = await translator.translate({ text: "hello prose here", targetLanguage: "zh" });
  assert.equal(out, "译文");
  assert.equal(calls.length, 1);
});

test("翻译：本地预筛判定无正文时跳过且不请求", async () => {
  const calls = [];
  const translator = {
    async translate(spec) {
      calls.push(spec);
      return "译文";
    },
  };
  const ctx = makeCtx({ translator });
  const { runner, calls: modelCalls } = makeRunner({ modes: { cotTranslate: "enforce" } });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry: { log: async () => {}, noteAdapterError() {} } });
  const out = await translator.translate({ text: "```js\nconst x = 1;\n```", targetLanguage: "zh" });
  assert.equal(out, "```js\nconst x = 1;\n```", "跳过时返回原文");
  assert.equal(calls.length, 0, "预筛就该挡掉，不必问模型");
  assert.equal(modelCalls.length, 0);
});

test("翻译：enforce 判 skip 时返回原文", async () => {
  const translator = {
    async translate() {
      throw new Error("不该调用");
    },
  };
  const ctx = makeCtx({ translator });
  const { runner } = makeRunner({
    modes: { cotTranslate: "enforce" },
    classify: () => ({
      answers: {
        prose: { type: "noul", noul: 0.9 },
        same_language: { type: "noul", noul: 0.95 },
      },
      model: "m",
      latencyMs: 5,
      cached: false,
    }),
  });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry: { log: async () => {}, noteAdapterError() {} } });
  const text = "This is already English prose.";
  assert.equal(await translator.translate({ text, targetLanguage: "en" }), text);
});

test("翻译：enforce 判 translate 时走原方法", async () => {
  const translator = {
    async translate() {
      return "译文";
    },
  };
  const ctx = makeCtx({ translator });
  const { runner } = makeRunner({
    modes: { cotTranslate: "enforce" },
    classify: () => ({
      answers: {
        prose: { type: "noul", noul: 0.95 },
        same_language: { type: "noul", noul: 0.05 },
      },
      model: "m",
      latencyMs: 5,
      cached: false,
    }),
  });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry: { log: async () => {}, noteAdapterError() {} } });
  assert.equal(await translator.translate({ text: "Hello world, real prose.", targetLanguage: "zh" }), "译文");
});

test("翻译：原方法抛错时异常原样传播，不被吞掉", async () => {
  const translator = {
    async translate() {
      throw new Error("provider down");
    },
  };
  const ctx = makeCtx({ translator });
  const { runner } = makeRunner({
    modes: { cotTranslate: "enforce" },
    classify: () => ({
      answers: { prose: { type: "noul", noul: 0.95 }, same_language: { type: "noul", noul: 0.05 } },
      model: "m",
      latencyMs: 5,
      cached: false,
    }),
  });
  mountCotTranslatePoint(ctx, { runner, getConfig: () => baseCfg(), telemetry: { log: async () => {}, noteAdapterError() {} } });
  await assert.rejects(() => translator.translate({ text: "Hello real prose.", targetLanguage: "zh" }), /provider down/);
});

test("翻译：卸载时恢复原方法", async () => {
  const original = async () => "原";
  const translator = { translate: original };
  const ctx = makeCtx({ translator });
  mountCotTranslatePoint(ctx, {
    runner: { participates: () => true, enforces: () => false, ask: async () => ({}) },
    getConfig: () => baseCfg(),
    telemetry: { log: async () => {}, noteAdapterError() {} },
  });
  assert.notEqual(translator.translate, original, "挂载后应是包装版");
  // 执行卸载回调
  const disposer = ctx.disposers[ctx.disposers.length - 1];
  assert.equal(typeof disposer, "function");
  disposer();
  assert.equal(translator.translate, original, "卸载后必须恢复原方法");
});

// ============================================================================
// 以下为韧性改造（重试 / 半开冷却 / 测试按钮）新增的用例，只追加，未改动上面任何用例。
//
// 这些用例走**真实的 StartluxClient**（而不是本文件上面的假 client）：要验证的
// 正是「失败之后客户端怎么处理」——那是它内部的时序逻辑，用假 client 替换掉
// 就等于把被测对象换掉了。全部注入假 fetchFn，不打网络；遥测目录指向临时目录，
// 不污染 ~/.dsh。
// ============================================================================

/**
 * 取真实模块。
 *
 * lib/index.js 依赖宿主的 peer 依赖 `@deepseek-ai/schemastery`（仓库里刻意
 * 不装 node_modules）。裸仓库里这一层解析不到，此时**跳过而不是失败**：
 * 本文件上半部分（引擎与适配器接线）本来就不需要那个依赖，不该被这几项拖红。
 */
async function loadIndexModule(t) {
  try {
    return await import("../lib/index.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("缺少宿主 peer 依赖 @deepseek-ai/schemastery，跳过客户端集成用例");
      return undefined;
    }
    throw error;
  }
}

/** 韧性用例的配置基线：缓存关掉，避免第二次调用直接命中缓存而绕过网络。 */
function resilienceCfg(over = {}) {
  return {
    provider: "bamboonode",
    bamboonodeApiKey: "test-key",
    cacheSize: 0,
    cacheTtlMs: 0,
    timeoutMs: 5000,
    thinkMode: "never",
    mode: "shadow",
    cooldownMs: 60000,
    cooldownProbeMs: 10000,
    failureThreshold: 3,
    retryAttempts: 1,
    ...over,
  };
}

/** 造一个真的 StartluxClient；`fetchFn` 收到的每次调用都记进 calls。 */
function makeResilientClient(StartluxClient, { cfg: cfgOver = {}, fetchFn, dir }) {
  const cfg = resilienceCfg(cfgOver);
  const calls = [];
  const client = new StartluxClient({
    getConfig: () => cfg,
    logger: { warn() {}, info() {} },
    telemetryDir: dir,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return fetchFn(url, init, calls.length);
    },
  });
  return { client, calls, cfg };
}

/** 一次与 guardListener 同构的授权调用。 */
const resilienceCall = () => ({
  point: "authorize",
  tag: "guard",
  mode: "shadow",
  tool: "bash",
  state: { tool: "bash", args_preview: "{}" },
  questions: { alive: { type: "noul", instructions: "?" } },
});

/** 一个成功的决策响应（只实现 classify 用到的字段）。 */
const okResponse = (answers = { alive: { type: "noul", noul: 0.9 } }) => ({
  ok: true,
  status: 200,
  headers: { get: () => undefined },
  async json() {
    return { answers, model: "test-model" };
  },
  async text() {
    return "{}";
  },
});

/** 模拟 AbortSignal.timeout 掐断时 fetch 抛出的错误。 */
const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("韧性：超时重试一次并成功（冷启动首发被掐断后第二发必中）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-retry-timeout-"));
  try {
    let count = 0;
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      fetchFn: async () => {
        count += 1;
        if (count === 1) throw abortError();
        return okResponse();
      },
    });
    const result = await client.classify(resilienceCall());
    assert.equal(calls.length, 2, "超时后应重试一次（首发被掐断已把服务端焐热）");
    assert.equal(result?.degraded, undefined, `重试成功后不该降级：${JSON.stringify(result)}`);
    assert.equal(typeof result?.answers, "object", "应拿到裁决答案");
    // 每次尝试各自一份 timer：若复用已 abort 的 signal，第二发会立刻超时，
    // 于是这里会看到两次都是 timeout。断言拿到答案即证明 timer 是新的。
    assert.equal(client.failures, 0, "成功后失败计数应归零");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：网络错误也重试（连接层抖动重发一次常常就通）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-retry-network-"));
  try {
    let count = 0;
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      fetchFn: async () => {
        count += 1;
        if (count === 1) throw new TypeError("fetch failed");
        return okResponse();
      },
    });
    const result = await client.classify(resilienceCall());
    assert.equal(calls.length, 2, "network-error 也应重试一次");
    assert.equal(result?.degraded, undefined, `重试成功后不该降级：${JSON.stringify(result)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：HTTP 500 不重试（服务端故障，重发只多烧一次额度）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-no-retry-500-"));
  try {
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      fetchFn: async () => ({ ok: false, status: 500, headers: { get: () => undefined }, async text() { return "boom"; }, async json() { return {}; } }),
    });
    const result = await client.classify(resilienceCall());
    assert.equal(calls.length, 1, "5xx 绝不能重试：断言 fetchFn 只被调用一次");
    assert.equal(result?.degraded, "http-500", "detail 取值不变（遥测与统计里都有既有断言）");
    assert.equal(client.failures, 1, "5xx 计入失败阈值，且只记一次");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：重试总预算封顶——已耗时超过预算就不再发第二发", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-retry-budget-"));
  try {
    // timeoutMs=1000 → 总预算 min(2×1000, 30000) = 2000ms。
    // 首发耗时 2050ms 才失败：预算已用满，重试只会更慢地失败。
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      cfg: { timeoutMs: 1000, retryAttempts: 3 },
      fetchFn: async () => {
        await sleep(2050);
        throw abortError();
      },
    });
    const result = await client.classify(resilienceCall());
    assert.equal(calls.length, 1, "预算耗尽后不得再发第二发（即便 retryAttempts=3）");
    assert.equal(result?.degraded, "timeout");
    // 只有**最终**失败才记一次失败：重试的中间那次不该累计，
    // 否则失败阈值会提前触发，冷却反而更容易被点着。
    assert.equal(client.failures, 1, "重试失败只能累加一次失败计数");
    const telemetry = await readFile(join(dir, "telemetry.jsonl"), "utf8");
    const entry = JSON.parse(telemetry.split("\n").find((line) => line.trim().length > 0));
    assert.equal(entry.detail, "timeout", "detail 仍是既有取值");
    assert.equal(entry.extra?.attempts, 1, "最终失败的 extra 要能看出试了几次");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：冷却期内请求被拦（0 毫秒快速降级），试探窗口到点后放行一次", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-half-open-"));
  try {
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      cfg: { failureThreshold: 1, cooldownMs: 60000, cooldownProbeMs: 10000 },
      fetchFn: async () => okResponse(),
    });
    client.noteFailure();
    assert.ok(client.cooldownUntil > Date.now(), "达到阈值后应进入冷却");
    const first = await client.classify(resilienceCall());
    const second = await client.classify(resilienceCall());
    assert.equal(first?.degraded, "cooldown", "冷却期内的请求应被拦下");
    assert.equal(second?.degraded, "cooldown", "第二次也必须被拦下（还没到试探窗口）");
    assert.equal(calls.length, 0, "被拦下的请求一个字节都不该发出去");

    // 模拟「试探窗口到点」：把下一个允许试探的时刻拨到现在。
    client.cooldownNextProbe = 0;
    const probeResult = await client.classify(resilienceCall());
    assert.equal(calls.length, 1, "试探窗口到点后应放行一次");
    assert.equal(probeResult?.degraded, undefined, "这次试探真的发出去了，而不是又一次快速降级");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：试探成功彻底解除冷却（cooldownUntil 与 streak 一起归零）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-half-open-ok-"));
  try {
    const { client } = makeResilientClient(mod.StartluxClient, {
      dir,
      cfg: { failureThreshold: 1, cooldownMs: 60000, cooldownProbeMs: 10000 },
      fetchFn: async () => okResponse(),
    });
    client.noteFailure();
    assert.equal(client.cooldownStreak, 1, "首轮冷却 streak 从 1 起");
    client.cooldownNextProbe = 0;
    const result = await client.classify(resilienceCall());
    assert.equal(result?.degraded, undefined);
    assert.equal(client.cooldownUntil, 0, "试探成功必须彻底清空冷却，而不是等它自然过期");
    assert.equal(client.cooldownStreak, 0, "streak 也要归零，否则下一轮会接着翻倍");
    assert.equal(client.failures, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：试探失败按指数退避延长冷却，并重新封锁试探窗口", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-half-open-fail-"));
  try {
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      cfg: { failureThreshold: 1, cooldownMs: 60000, cooldownProbeMs: 10000, retryAttempts: 0 },
      fetchFn: async () => {
        throw new TypeError("fetch failed");
      },
    });
    client.noteFailure();
    const firstUntil = client.cooldownUntil;
    assert.equal(client.cooldownStreak, 1);
    client.cooldownNextProbe = 0;
    const result = await client.classify(resilienceCall());
    assert.equal(result?.degraded, "network-error");
    assert.equal(client.cooldownStreak, 2, "连续进入冷却的轮次要递增");
    assert.ok(
      client.cooldownUntil > firstUntil,
      `第二轮冷却应更长（指数退避）：first=${firstUntil} now=${client.cooldownUntil}`,
    );
    // 试探失败后窗口被推后：紧接着的请求必须又被拦下。
    const before = calls.length;
    const blocked = await client.classify(resilienceCall());
    assert.equal(blocked?.degraded, "cooldown");
    assert.equal(calls.length, before, "试探失败后应立刻重新封锁");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("测试按钮：走注入的 fetchFn、网络错误重试一次，并给出「失败原因 / 建议」", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const home = mkdtempSync(join(tmpdir(), "de-probe-"));
  const originalHome = process.env.DSH_HOME;
  const originalKey = process.env.BAMBOO_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  process.env.BAMBOO_API_KEY = "probe-test-key";
  let pinned = 0;
  let bare = 0;
  // 决策端点的桩：一律抛网络错误（模拟本机链路不通）。
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/decisions") || target.includes("/systemone")) {
      pinned += 1;
      throw new TypeError("fetch failed");
    }
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } };
  };
  try {
    const routes = {};
    const connection = { fetch: { register(entry) { routes[entry.path] = entry; } } };
    const ctx = {
      logger: { info() {}, warn() {}, debug() {} },
      on() {},
      get(name) {
        return name === "connection" ? connection : undefined;
      },
      inject(_names, fn) { fn(); },
      plugin() {},
      effect() {},
    };
    mod.apply(ctx, {});
    // 关键：apply 之后再换掉 globalThis.fetch。客户端在构造时就固化了
    // fetchFn（this.fetchFn = options.fetchFn ?? globalThis.fetch），
    // 若 probe 用裸 fetch，它会落到这个桩上被计数——这正是
    // 「测试通过但实跑不同」的假象来源。
    globalThis.fetch = async () => {
      bare += 1;
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } };
    };
    const res = await routes["/api/decision-engine/test"].fetch({
      method: "POST",
      url: "http://localhost/api/decision-engine/test",
    });
    const data = await res.json();
    assert.equal(bare, 0, "probe 不得绕过 client.fetchFn 去用裸 fetch");
    assert.equal(pinned, 2, "probe 应对网络错误重试一次（共两发）");
    assert.match(data.text, /失败原因: 网络连接失败/, `应给出可读的失败原因，实际：${data.text}`);
    assert.match(data.text, /建议: /, "应给出一句可执行的下一步");
    assert.match(data.text, /provider: /, "既有输出结构要保留");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    if (originalKey === undefined) delete process.env.BAMBOO_API_KEY;
    else process.env.BAMBOO_API_KEY = originalKey;
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 造一套隔离环境并走真实 `apply()`，用来验证「测试」按钮（probe）。
 *
 * @param options.decisionFetch - 决策端点用的桩；收不到响应就抛错即为失败。
 * @param options.before - apply 之后、点测试之前要做的准备（如制造冷却）。
 */
async function probeSetup(mod, { decisionFetch, before } = {}) {
  const home = mkdtempSync(join(tmpdir(), "de-probe-"));
  const originalHome = process.env.DSH_HOME;
  const originalKey = process.env.BAMBOO_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  process.env.BAMBOO_API_KEY = "probe-test-key";
  const calls = [];
  // 桩必须在 apply 之前装好：客户端在构造时就固化了 fetchFn。
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("/decisions") || target.includes("/systemone")) {
      calls.push({ url: target, init });
      return decisionFetch(target, init, calls.length);
    }
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } };
  };
  const routes = {};
  const hooks = new Map();
  const connection = { fetch: { register(entry) { routes[entry.path] = entry; } } };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    get(name) { return name === "connection" ? connection : undefined; },
    inject(_names, fn) { fn(); },
    plugin() {},
    effect() {},
  };
  mod.apply(ctx, {});
  // before 拿到已注册的守卫监听器：要制造真实状态（如冷却）就得走真路径。
  if (typeof before === "function") {
    await before({ listener: (hooks.get("tools/pre-execute") ?? [])[0] });
  }
  return {
    calls,
    /** 触发一次真实的守卫调用（用来制造冷却等状态）。 */
    listener: (hooks.get("tools/pre-execute") ?? [])[0],
    async click() {
      const res = await routes["/api/decision-engine/test"].fetch({
        method: "POST",
        url: "http://localhost/api/decision-engine/test",
      });
      return res.json();
    },
    restore() {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = originalHome;
      if (originalKey === undefined) delete process.env.BAMBOO_API_KEY;
      else process.env.BAMBOO_API_KEY = originalKey;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("测试按钮：超时也重试一次，第二发成功即报告成功（诊断不该一次定生死）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const env = await probeSetup(mod, {
    decisionFetch: async (_url, _init, index) => {
      if (index === 1) throw abortError();
      return okResponse();
    },
  });
  try {
    const data = await env.click();
    assert.equal(env.calls.length, 2, "probe 应对超时重试一次");
    assert.equal(data.ok, true, `第二发成功即应报告成功，实际：${data.text}`);
    assert.match(data.text, /HTTP 200/, "成功时应保留既有的状态行结构");
    assert.doesNotMatch(data.text, /失败原因:/, "成功时不该出现失败说明");
  } finally {
    env.restore();
  }
});

test("测试按钮：冷却中仍然照常发请求，但明确写出「本次为试探请求」", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const { writeFileSync, mkdirSync } = await import("node:fs");
  // 决策桩的行为可切换：先失败（制造冷却），再成功（供 probe 使用）。
  // 注意客户端在 apply 时就固化了 fetchFn，所以只能改**桩内部**的状态，
  // 换 globalThis.fetch 是无效的——这本身就是被验证的那条性质。
  let mode = "fail";
  const env = await probeSetup(mod, {
    decisionFetch: async () => {
      if (mode === "fail") throw new TypeError("fetch failed");
      return okResponse();
    },
    before: async ({ listener }) => {
      // 造出真实冷却：写一份「一败即冷却」的配置，再由守卫真的失败一次。
      // 直接改内部字段不算数——要验证的是 probe 读到的**真实**状态。
      const configPath = join(process.env.DSH_HOME, "dsh-decision-engine", "config.yml");
      mkdirSync(join(configPath, ".."), { recursive: true });
      writeFileSync(
        configPath,
        [
          "enabled: true",
          "mode: enforce",
          "pointAuthorize: enforce",
          "provider: bamboonode",
          "bamboonodeApiKey: sk-test-key-000000",
          "timeoutMs: 5000",
          "retryAttempts: 0",
          "failureThreshold: 1",
          "cooldownMs: 60000",
          "cooldownProbeMs: 60000",
          "",
        ].join("\n"),
        "utf8",
      );
      await listener(
        {
          name: "write",
          arguments: { file_path: "src/a.ts", content: "x" },
          agent: { session: { id: "s1", header: { cwd: "/work/repo" } } },
          signal: new AbortController().signal,
        },
        () => ({ kind: "allow" }),
      );
      mode = "ok";
    },
  });
  try {
    const data = await env.click();
    assert.match(
      data.text,
      /当前处于冷却中，距冷却结束还有 \d+ 秒；本次为试探请求/,
      `冷却中应明确说明这是一次试探，实际：${data.text}`,
    );
    assert.match(data.text, /HTTP 200/, "冷却中也要照常发请求（用户点测试就是想验证端点）");
  } finally {
    env.restore();
  }
});

test("测试按钮：不在冷却中时不该出现试探提示（反证上一条不是恒真）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const env = await probeSetup(mod, { decisionFetch: async () => okResponse() });
  try {
    const data = await env.click();
    assert.doesNotMatch(data.text, /本次为试探请求/, `不在冷却中时不该出现试探提示：${data.text}`);
    assert.match(data.text, /HTTP 200/);
  } finally {
    env.restore();
  }
});

test("韧性：retryAttempts=0 时连超时也不重试（配置是硬开关）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-retry-off-"));
  try {
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      cfg: { retryAttempts: 0 },
      fetchFn: async () => {
        throw abortError();
      },
    });
    const result = await client.classify(resilienceCall());
    assert.equal(calls.length, 1, "retryAttempts=0 必须逐字回到「只发一次」的旧行为");
    assert.equal(result?.degraded, "timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：caller 主动取消时不重试（用户已经不等了）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-retry-cancel-"));
  try {
    const controller = new AbortController();
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      fetchFn: async () => {
        controller.abort();
        throw abortError();
      },
    });
    const result = await client.classify({ ...resilienceCall(), signal: controller.signal });
    assert.equal(calls.length, 1, "调用方已取消，重试没有意义");
    assert.equal(result?.degraded, "caller-aborted", "detail 仍是既有取值");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：降级遥测的 detail 取值集合没变，只是最终失败多了 attempts", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-retry-telemetry-"));
  try {
    let count = 0;
    const { client } = makeResilientClient(mod.StartluxClient, {
      dir,
      fetchFn: async () => {
        count += 1;
        if (count === 1) throw abortError();
        throw new TypeError("fetch failed");
      },
    });
    const result = await client.classify(resilienceCall());
    assert.equal(result?.degraded, "network-error", "两次都失败时报告最终那次的原因");
    const lines = (await readFile(join(dir, "telemetry.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const entry = JSON.parse(lines[0]);
    // 记录形状不变：既有字段一个不少，detail 仍是既有取值。
    assert.equal(entry.action, "degraded");
    assert.equal(entry.detail, "network-error");
    assert.equal(typeof entry.provider, "string");
    assert.equal(entry.extra?.attempts, 2, "extra 里能看出试了两次");
    assert.equal(entry.extra?.message, "fetch failed", "最后一次的底层错误要保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("韧性：冷却期内缓存命中不受影响（冷却只拦要出网的请求）", async (t) => {
  const mod = await loadIndexModule(t);
  if (mod === undefined) return;
  const dir = await mkdtemp(join(tmpdir(), "de-cooldown-cache-"));
  try {
    const { client, calls } = makeResilientClient(mod.StartluxClient, {
      dir,
      // cacheSize 必须显式打开：resilienceCfg 默认 0 = 禁用缓存，
      // 那样这条测试测的就不是「冷却与缓存的先后关系」了。
      cfg: { failureThreshold: 1, cooldownMs: 60000, cooldownProbeMs: 10000, cacheSize: 8 },
      fetchFn: async () => okResponse(),
    });
    // 先成功一次把结果写进缓存，再人为进入冷却。
    const warm = await client.classify(resilienceCall());
    assert.equal(warm?.degraded, undefined, "预热请求应成功");
    assert.equal(calls.length, 1);
    client.noteFailure();
    assert.ok(client.cooldownUntil > Date.now(), "应已进入冷却");

    // 同一个 state 再问一次：冷却期里也必须由缓存作答，而不是降级。
    const cached = await client.classify(resilienceCall());
    assert.equal(cached?.degraded, undefined, "冷却期内的缓存命中不该被降级");
    assert.equal(cached?.cached, true, "这次应当明确是缓存命中");
    assert.equal(calls.length, 1, "缓存命中不该再发请求");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
