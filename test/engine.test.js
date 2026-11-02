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
