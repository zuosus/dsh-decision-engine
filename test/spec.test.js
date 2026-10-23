/**
 * 决策点规格的纯函数测试。
 *
 * 这一层的价值在于：每个决策点的「问题 / 解析 / 处置」都可以脱离 DSH、
 * 脱离网络单独验证。端点上一次真实调用的代价是 ~1.9k token 与 ~2 秒，
 * 因此把阈值与边界全部压到这里测，比反复打端点快三个数量级。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { POINT_SPECS, findSpec, readChoice, readNoul, readScore } from "../lib/points/spec.js";

/** 一份覆盖全部阈值的配置（与 index.js 的 DEFAULTS 对齐）。 */
const CFG = {
  routeCheapProvider: "deepseek-official",
  routeCheapModel: "deepseek-flash",
  routeMaxScore: 0.4,
  routeMechanicalFloor: 0.6,
  routeRiskFloor: 0.3,
  delegateConfidenceFloor: 0.5,
  delegateBlockingFloor: 0.6,
  delegateParallelFloor: 0.5,
  compactDistilledFloor: 0.6,
  compactVerbatinFloor: 0.6,
  turnStopMaxSteers: 1,
  turnStopClosedFloor: 0.6,
  turnStopUnfinishedFloor: 0.6,
  turnStopValueFloor: 0.35,
  retrievalCoveredFloor: 0.5,
  retrievalWouldAddCeiling: 0.8,
  skillPickConfidenceFloor: 0.5,
  cotProseFloor: 0.5,
  cotSameLanguageFloor: 0.7,
};

/** 构造一条 choice 答案。 */
const choice = (value, confidence = 0.9) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: {},
});

/** 构造一条 noul 答案。 */
const noul = (value) => ({ type: "noul", noul: value });

/** 构造一条 score 答案（档位未归一，模拟端点原样返回）。 */
const score = (value, levels = 5) => ({ type: "score", score: value, confidence: 0 });

// ---------------------------------------------------------------- 注册完整性

test("每个注册的决策点都有规格实现", () => {
  const expected = [
    "route",
    "delegate",
    "compact",
    "turnStop",
    "retrieval",
    "skillPick",
    "cotTranslate",
  ];
  for (const id of expected) {
    const spec = findSpec(id);
    assert.ok(spec !== undefined, `${id} 缺少规格`);
    assert.equal(typeof spec.build, "function", `${id}.build 必须是函数`);
    assert.equal(typeof spec.parse, "function", `${id}.parse 必须是函数`);
    assert.equal(typeof spec.decide, "function", `${id}.decide 必须是函数`);
  }
  assert.deepEqual(Object.keys(POINT_SPECS).sort(), [...expected].sort());
});

test("每个规格的 build 产出 state 与非空 questions", () => {
  const inputs = {
    route: { turn: 1, step: 1, current: { provider: "p", model: "m" }, recent: "" },
    delegate: { turn: 1, step: 1, incoming: "帮我重构这个模块", recent: "" },
    compact: { totalTokens: 150000, triggerTokens: 100000, oversized: 3, nodes: 40, recent: "" },
    turnStop: { turn: 1, last: "已完成", pendingTools: 0, steered: 0 },
    retrieval: { tool: "web_search", query: "dsh hooks", recent: "" },
    skillPick: { requested: "x", candidates: [{ name: "a", description: "da" }, { name: "b", description: "db" }], recent: "" },
    cotTranslate: { text: "Hello world, this is prose.", targetLanguage: "zh", head: "Hello world" },
  };
  for (const [id, input] of Object.entries(inputs)) {
    const built = POINT_SPECS[id].build(input);
    assert.equal(typeof built.state, "object", `${id}.build 必须返回 state`);
    assert.ok(built.questions !== undefined, `${id}.build 必须返回 questions`);
    const keys = Object.keys(built.questions);
    assert.ok(keys.length > 0, `${id} 至少要有一个问题`);
    for (const key of keys) {
      const question = built.questions[key];
      assert.ok(
        question.type === "choice" || question.type === "score" || question.type === "noul",
        `${id}.${key} 的题型 ${question.type} 不是端点接受的三选一`,
      );
      assert.equal(typeof question.instructions, "string", `${id}.${key} 缺少 instructions`);
      // choice 必须有 criteria，score 必须有 2–10 档，这是端点的硬校验。
      if (question.type === "choice") {
        assert.ok(
          question.criteria !== undefined && Object.keys(question.criteria).length > 0,
          `${id}.${key} 是 choice 但没有 criteria`,
        );
      }
      if (question.type === "score") {
        assert.ok(
          Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10,
          `${id}.${key} 是 score 但档位数不在 2–10`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------- 答案读取器

test("readChoice 拒绝畸形形状", () => {
  assert.equal(readChoice(undefined, "q"), undefined);
  assert.equal(readChoice({ q: { type: "noul", noul: 0.5 } }, "q"), undefined, "题型不符必须拒绝");
  assert.equal(readChoice({ q: { type: "choice", choice: "", confidence: 0.5 } }, "q"), undefined, "空 choice 必须拒绝");
  assert.equal(readChoice({ q: { type: "choice", choice: "a", confidence: 2 } }, "q"), undefined, "越界置信必须拒绝");
  const ok = readChoice({ q: choice("a", 0.75) }, "q");
  assert.equal(ok.choice, "a");
  assert.equal(ok.confidence, 0.75);
});

test("readNoul 拒绝畸形形状", () => {
  assert.equal(readNoul(undefined, "q"), undefined);
  assert.equal(readNoul({ q: { type: "choice" } }, "q"), undefined);
  assert.equal(readNoul({ q: { type: "noul", noul: Number.NaN } }, "q"), undefined, "NaN 必须拒绝");
  assert.equal(readNoul({ q: noul(0.42) }, "q"), 0.42);
});

test("readScore 把档位归一化到 0–1", () => {
  // 5 档：0 → 0，4 → 1，2 → 0.5
  assert.equal(readScore({ q: score(0) }, "q", 5), 0);
  assert.equal(readScore({ q: score(4) }, "q", 5), 1);
  assert.equal(readScore({ q: score(2) }, "q", 5), 0.5);
  assert.equal(readScore({ q: { type: "noul", noul: 1 } }, "q", 5), undefined);
});

// ---------------------------------------------------------------- 模型路由

test("路由：机械低需求步骤下沉到便宜模型", () => {
  const parsed = POINT_SPECS.route.parse({
    capability: score(1), // 0.25
    mechanical: noul(0.9),
    risky: noul(0.05),
  });
  assert.ok(parsed !== undefined);
  const action = POINT_SPECS.route.decide(parsed, CFG);
  assert.equal(action.kind, "switch");
  assert.equal(action.provider, "deepseek-official");
  assert.equal(action.model, "deepseek-flash");
});

test("路由：能力需求高则保留强模型", () => {
  const parsed = POINT_SPECS.route.parse({
    capability: score(4), // 1.0
    mechanical: noul(0.9),
    risky: noul(0.05),
  });
  assert.equal(POINT_SPECS.route.decide(parsed, CFG).kind, "keep");
});

test("路由：风险高则保留强模型，即使很机械", () => {
  const parsed = POINT_SPECS.route.parse({
    capability: score(0),
    mechanical: noul(0.99),
    risky: noul(0.9),
  });
  assert.equal(POINT_SPECS.route.decide(parsed, CFG).kind, "keep");
});

test("路由：不机械则保留强模型", () => {
  const parsed = POINT_SPECS.route.parse({
    capability: score(1),
    mechanical: noul(0.1),
    risky: noul(0.05),
  });
  assert.equal(POINT_SPECS.route.decide(parsed, CFG).kind, "keep");
});

test("路由：答案缺字段即视为形状不合格", () => {
  assert.equal(POINT_SPECS.route.parse({ capability: score(1), mechanical: noul(0.9) }), undefined);
});

// ---------------------------------------------------------------- 子任务分派

test("分派：明确的子任务建议开 subagent", () => {
  const parsed = POINT_SPECS.delegate.parse({
    scope: choice("subagent", 0.9),
    parallel: noul(0.1),
    blocking: noul(0.2),
  });
  const action = POINT_SPECS.delegate.decide(parsed, CFG);
  assert.equal(action.kind, "advise");
  assert.equal(action.target, "subagent");
});

test("分派：并行需求高时建议组队", () => {
  const parsed = POINT_SPECS.delegate.parse({
    scope: choice("team", 0.9),
    parallel: noul(0.8),
    blocking: noul(0.1),
  });
  const action = POINT_SPECS.delegate.decide(parsed, CFG);
  assert.equal(action.kind, "advise");
  assert.equal(action.target, "team");
});

test("分派：置信不足时继续内联", () => {
  // 实测「需要先看代码」这类模糊输入给出 inline=0.69/conf=0.53 附近，
  // 低于 0.5 的门槛即视为无倾向。
  const parsed = POINT_SPECS.delegate.parse({
    scope: choice("subagent", 0.3),
    parallel: noul(0.1),
    blocking: noul(0.1),
  });
  assert.equal(POINT_SPECS.delegate.decide(parsed, CFG).kind, "inline");
});

test("分派：被本地事实阻塞时继续内联", () => {
  const parsed = POINT_SPECS.delegate.parse({
    scope: choice("subagent", 0.9),
    parallel: noul(0.1),
    blocking: noul(0.85),
  });
  assert.equal(POINT_SPECS.delegate.decide(parsed, CFG).kind, "inline");
});

test("分派：建议组队但并行度低时退回内联", () => {
  // 串行工作组队只是多付上下文，没有收益。
  const parsed = POINT_SPECS.delegate.parse({
    scope: choice("team", 0.9),
    parallel: noul(0.1),
    blocking: noul(0.1),
  });
  assert.equal(POINT_SPECS.delegate.decide(parsed, CFG).kind, "inline");
});

test("分派：非法 scope 视为形状不合格", () => {
  assert.equal(
    POINT_SPECS.delegate.parse({ scope: choice("bogus"), parallel: noul(0.1), blocking: noul(0.1) }),
    undefined,
  );
});

// ---------------------------------------------------------------- 上下文压缩

test("压缩：结论已落地时只裁剪不摘要", () => {
  // 实测：distilled 达 0.81 即「信息已落地」，中间段可丢。
  const parsed = POINT_SPECS.compact.parse({ distilled: noul(0.81), verbatim_needed: noul(0.26) });
  assert.equal(POINT_SPECS.compact.decide(parsed, CFG).kind, "prune");
});

test("压缩：结论未落地时改走摘要", () => {
  const parsed = POINT_SPECS.compact.parse({ distilled: noul(0.41), verbatim_needed: noul(0.26) });
  assert.equal(POINT_SPECS.compact.decide(parsed, CFG).kind, "summarize");
});

test("压缩：仍需逐字原文时一律摘要（安全否决优先于 distilled）", () => {
  const parsed = POINT_SPECS.compact.parse({ distilled: noul(0.95), verbatim_needed: noul(0.9) });
  assert.equal(POINT_SPECS.compact.decide(parsed, CFG).kind, "summarize");
});

test("压缩：缺函数字段即视为形状不合格", () => {
  assert.equal(POINT_SPECS.compact.parse({ distilled: noul(0.9) }), undefined);
});

// ---------------------------------------------------------------- 轮次延续

test("轮次：仍有未完成且续一轮有价值则继续", () => {
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.85),
    value: noul(0.8),
    closed: noul(0.1),
  });
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "continue");
});

test("轮次：请求已完成则收束", () => {
  // 实测「已完成」：closed 0.74 / unfin 0.09 / value 0.09
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.09),
    value: noul(0.09),
    closed: noul(0.74),
  });
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "stop");
});

test("轮次：unfinished 高时优先续轮（判据顺序不可颠倒）", () => {
  // 若先看 closed，这条（closed 不达线）会掉进默认 stop —— 而它该续轮。
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.83),
    value: noul(0.39),
    closed: noul(0.28),
  });
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "continue");
});

test("轮次：没增量价值则收束", () => {
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.5),
    value: noul(0.1),
    closed: noul(0.3),
  });
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "stop");
});

// ---------------------------------------------------------------- 检索必要性

test("检索：上下文已覆盖且再搜无新信息时跳过", () => {
  // 实测值：covered 0.92 / would_add 0.63
  const parsed = POINT_SPECS.retrieval.parse({ covered: noul(0.92), would_add: noul(0.63) });
  assert.equal(POINT_SPECS.retrieval.decide(parsed, CFG).kind, "skip");
});

test("检索：未覆盖时放行", () => {
  // 实测值：covered 0.01 / would_add 0.98
  const parsed = POINT_SPECS.retrieval.parse({ covered: noul(0.01), would_add: noul(0.98) });
  assert.equal(POINT_SPECS.retrieval.decide(parsed, CFG).kind, "allow");
});

test("检索：已覆盖但再搜有新信息时不跳过", () => {
  const parsed = POINT_SPECS.retrieval.parse({ covered: noul(0.9), would_add: noul(0.95) });
  assert.equal(POINT_SPECS.retrieval.decide(parsed, CFG).kind, "allow");
});

test("检索：缺字段即视为形状不合格", () => {
  assert.equal(POINT_SPECS.retrieval.parse({ covered: noul(0.9) }), undefined);
});

// ---------------------------------------------------------------- 技能选择

test("技能：高置信给出更匹配的技能", () => {
  const parsed = POINT_SPECS.skillPick.parse({ best: choice("dsh-hooks", 0.85) });
  const action = POINT_SPECS.skillPick.decide(parsed, CFG);
  assert.equal(action.kind, "redirect");
  assert.equal(action.suggest, "dsh-hooks");
});

test("技能：低置信放行，不打断", () => {
  const parsed = POINT_SPECS.skillPick.parse({ best: choice("dsh-hooks", 0.2) });
  assert.equal(POINT_SPECS.skillPick.decide(parsed, CFG).kind, "allow");
});

test("技能：模型选 none 时放行", () => {
  const parsed = POINT_SPECS.skillPick.parse({ best: choice("none", 0.95) });
  assert.equal(POINT_SPECS.skillPick.decide(parsed, CFG).kind, "allow");
});

test("技能：候选清单里必须有 none 这个出口", () => {
  const built = POINT_SPECS.skillPick.build({
    requested: "x",
    candidates: [{ name: "a", description: "da" }, { name: "b", description: "db" }],
  });
  assert.ok(Object.hasOwn(built.questions.best.criteria, "none"));
});

// ---------------------------------------------------------------- 证据串

test("处置结果都带可核对的 reason", () => {
  const cases = [
    ["route", { capability: score(0), mechanical: noul(0.9), risky: noul(0) }],
    ["delegate", { scope: choice("inline", 0.9), parallel: noul(0.1), blocking: noul(0.1) }],
    ["compact", { distilled: noul(0.5), verbatim_needed: noul(0.5) }],
    ["turnStop", { unfinished: noul(0.2), value: noul(0.2), closed: noul(0.8) }],
    ["retrieval", { covered: noul(0.1), would_add: noul(0.9) }],
    ["skillPick", { best: choice("none", 0.9) }],
    ["cotTranslate", { prose: noul(0.9), same_language: noul(0.1) }],
  ];
  for (const [id, answers] of cases) {
    const parsed = POINT_SPECS[id].parse(answers);
    assert.ok(parsed !== undefined, `${id} 解析失败`);
    const action = POINT_SPECS[id].decide(parsed, CFG, { candidates: ["候选"] });
    assert.equal(typeof action.kind, "string", `${id} 缺少 kind`);
    assert.equal(typeof action.reason, "string", `${id} 缺少 reason`);
    assert.ok(action.reason.length > 0, `${id} 的 reason 为空`);
    assert.ok(action.reason.startsWith("startlux-"), `${id} 的 reason 缺少来源前缀：${action.reason}`);
  }
});
