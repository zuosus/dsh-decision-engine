/**
 * 裁决统计（allow / ask / reject）的单元测试。
 *
 * 这里覆盖的是**最容易算错**的三处：
 *
 *   1. **同一个 kind 在不同点上含义不同**：`retrieval.skip` 拦下了一次
 *      检索，`cotTranslate.skip` 只是没翻译一句话。按 kind 统一映射会把
 *      「不翻译」算成「拦截」，得到的「拦截次数」毫无意义。
 *   2. **降级不是第四种裁决**：降级时插件根本没改变任何行为，算成「放行」
 *      会虚增放行次数，算成「拦截」会虚增拦截次数。
 *   3. **漏登记必须可见**：新增裁决词忘了登记时，数字只会**偏小**——
 *      看着仍然合理，是最难自查的一类错。所以要显式列出来。
 *
 * 另外覆盖写入路径：裁决必须在**拿到裁决之后**才写进统计记录，
 * 否则统计里永远缺这一维（真实踩过的坑，见 DEC-008）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OUTCOME_LABELS, OUTCOME_MATRIX, OUTCOMES, outcomeOf } from "../lib/outcomes.js";
import { aggregate, buildRecord, resolveRange } from "../lib/stats.js";
import { StatsStore } from "../lib/stats-store.js";

/** 落在测试区间内的一条统计记录。 */
const rec = (over = {}) =>
  buildRecord({
    ts: "2026-10-20T10:00:00.000Z",
    provider: "bamboonode",
    model: "startlux-decision-27b-autothink",
    point: "authorize",
    action: "delegate",
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 500,
    inputSource: "api",
    outputSource: "api",
    ...over,
  });

/** 测试用的自定义区间（覆盖 2026-10-20 全天）。 */
const range = () =>
  resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });

// ------------------------------------------------------------ 映射矩阵本身

test("裁决矩阵覆盖九个决策点的全部裁决词", () => {
  // 映射表是「漏登记」的防线。少登记一个 kind，那一格的计数就静默偏小。
  const expected = {
    authorize: ["delegate", "ask", "deny"],
    route: ["keep", "switch"],
    delegate: ["inline", "advise"],
    compact: ["summarize", "prune"],
    turnStop: ["continue", "stop"],
    retrieval: ["allow", "skip"],
    skillPick: ["allow", "redirect"],
    cotTranslate: ["translate", "skip"],
  };
  for (const [point, kinds] of Object.entries(expected)) {
    assert.ok(OUTCOME_MATRIX[point] !== undefined, `矩阵缺少决策点 ${point}`);
    for (const kind of kinds) {
      assert.ok(
        OUTCOME_MATRIX[point][kind] !== undefined,
        `矩阵缺少 ${point}/${kind}（新增裁决词必须登记，否则统计会静默少算）`,
      );
      assert.ok(
        OUTCOMES.includes(OUTCOME_MATRIX[point][kind]),
        `${point}/${kind} 的分类必须是三格之一`,
      );
    }
  }
});

test("每个 kind 都只能映射到三格之一", () => {
  for (const [point, bucket] of Object.entries(OUTCOME_MATRIX)) {
    for (const [kind, outcome] of Object.entries(bucket)) {
      assert.ok(
        outcome === "allow" || outcome === "ask" || outcome === "reject",
        `${point}/${kind} 的分类非法：${outcome}`,
      );
    }
  }
});

test("查不到的裁决返回 none，绝不猜成放行", () => {
  // 猜一个默认分类会让未知裁决看起来像「放行」，而放行是三格里看起来
  // 最无害、实则最能掩盖问题的一格。
  assert.equal(outcomeOf("authorize", "brandNewKind"), "none");
  assert.equal(outcomeOf("brandNewPoint", "delegate"), "none");
  assert.equal(outcomeOf("", ""), "none");
  assert.equal(outcomeOf(undefined, undefined), "none");
});

test("同一个 kind 在不同点上分类不同", () => {
  // 这是整件事的核心：skip 在检索点是「拦下这次搜索」，
  // 在翻译点只是「这句话不翻译」——两者混在一起算「拦截次数」没有意义。
  assert.equal(outcomeOf("retrieval", "skip"), "reject");
  assert.equal(outcomeOf("cotTranslate", "skip"), "allow");
  assert.equal(outcomeOf("skillPick", "redirect"), "reject");
});

test("老遥测回填的 unknown point 只认授权的三个裁决词", () => {
  // 老遥测里有一批记录没有 point 字段（授权守卫早于 point 字段）。
  // 它们只可能来自授权守卫，因此只认 delegate / ask / deny；
  // 其它词一律不猜——同一个词在不同点上含义可能相反。
  assert.equal(outcomeOf("unknown", "delegate"), "allow");
  assert.equal(outcomeOf("unknown", "ask"), "ask");
  assert.equal(outcomeOf("unknown", "deny"), "reject");
  assert.equal(outcomeOf("unknown", "skip"), "none");
  assert.equal(outcomeOf("unknown", "redirect"), "none");
});

test("三个分类都有中文显示名，none 单列", () => {
  for (const outcome of OUTCOMES) {
    assert.equal(typeof OUTCOME_LABELS[outcome], "string");
  }
  assert.equal(typeof OUTCOME_LABELS.none, "string");
});

// ------------------------------------------------------------ 聚合口径

test("聚合：按 allow / ask / reject 三格分账", () => {
  const result = aggregate(
    [
      rec({ action: "delegate" }),
      rec({ action: "delegate" }),
      rec({ action: "ask" }),
      rec({ action: "deny" }),
    ],
    range(),
  );
  assert.equal(result.outcomes.allow, 2);
  assert.equal(result.outcomes.ask, 1);
  assert.equal(result.outcomes.reject, 1);
  assert.equal(result.outcomes.decided, 4, "裁决次数 = 三格之和");
  assert.equal(result.outcomes.none, 0);
});

test("聚合：降级计入「未裁决」，不算放行也不算拦截", () => {
  const result = aggregate(
    [
      rec({ action: "delegate" }),
      rec({ action: "degraded", degraded: true }),
      rec({ action: "", degraded: true }),
    ],
    range(),
  );
  assert.equal(result.outcomes.allow, 1, "只有真裁决才算放行");
  assert.equal(result.outcomes.ask, 0);
  assert.equal(result.outcomes.reject, 0);
  assert.equal(result.outcomes.none, 2, "降级与无裁决都归「未裁决」");
  assert.equal(result.outcomes.decided, 1);
  assert.equal(result.outcomes.total, 3);
});

test("聚合：未登记的裁决词被单独列出，而不是静默丢弃", () => {
  const result = aggregate(
    [rec({ action: "delegate" }), rec({ action: "brandNew" }), rec({ action: "brandNew" })],
    range(),
  );
  assert.equal(result.outcomes.otherVerdictCount, 2);
  assert.equal(result.outcomes.otherVerdicts.length, 1);
  assert.equal(result.outcomes.otherVerdicts[0].verdict, "authorize/brandNew");
  assert.equal(result.outcomes.otherVerdicts[0].count, 2);
  // 未登记的仍计入「未裁决」——它**有**裁决，只是没归类，
  // 不能悄悄消失，但也不能假装成放行。
  assert.equal(result.outcomes.allow, 1);
  assert.equal(result.outcomes.none, 2);
});

test("聚合：按决策点分账也能拆三格", () => {
  const result = aggregate(
    [
      rec({ point: "authorize", action: "delegate" }),
      rec({ point: "authorize", action: "deny" }),
      rec({ point: "retrieval", action: "skip" }),
      rec({ point: "retrieval", action: "allow" }),
    ],
    range(),
  );
  const authorize = result.outcomes.byPoint.find((row) => row.point === "authorize");
  assert.equal(authorize.allow, 1);
  assert.equal(authorize.reject, 1);
  const retrieval = result.outcomes.byPoint.find((row) => row.point === "retrieval");
  assert.equal(retrieval.allow, 1);
  assert.equal(retrieval.reject, 1, "检索的 skip 是真的拦下了一次搜索");
});

test("聚合：降级记录不进用量口径（均耗时不被稀释）", () => {
  // 降级没有拿到任何答案：它不是「一次模型请求」，
  // 混进 requests 会让「均耗时」的分母多出一批没得到回答的请求。
  const result = aggregate(
    [
      rec({ durationMs: 1000 }),
      rec({ durationMs: 3000, action: "degraded", degraded: true, inputTokens: 0 }),
    ],
    range(),
  );
  assert.equal(result.totals.requests, 1, "降级不算一次请求");
  assert.equal(result.totals.degraded, 1);
  assert.equal(result.totals.avgDurationMs, 1000, "均耗时按真实请求算");
  assert.equal(result.totals.degradedDurationMs, 3000, "降级耗时单列，是真实成本");
});

test("聚合：区间外的记录不计入裁决数", () => {
  const result = aggregate(
    [rec({ ts: "2026-10-25T10:00:00.000Z", action: "deny" }), rec({ action: "delegate" })],
    range(),
  );
  assert.equal(result.outcomes.allow, 1);
  assert.equal(result.outcomes.reject, 0, "区间外的记录不该被计入");
});

// ------------------------------------------------------------ 写入路径

test("写入路径：裁决在拿到裁决之后才写进统计记录", async () => {
  // 这是真实踩过的坑：统计原来写在 classify() 里，而裁决是
  // spec.decide() 的产物——写进去的记录必然没有裁决。
  // 实测 stats.jsonl 里 132 条实时记录的 action 是空串。
  const dir = await mkdtemp(join(tmpdir(), "de-outcome-"));
  try {
    const { StartluxClient } = await import("../lib/index.js");
    const { createDecisionRunner } = await import("../lib/engine.js");
    const store = new StatsStore({ dir });
    const client = new StartluxClient({
      getConfig: () => ({
        provider: "bamboonode",
        bamboonodeApiKey: "k",
        cacheSize: 256,
        cacheTtlMs: 600000,
        timeoutMs: 5000,
        thinkMode: "never",
        mode: "shadow",
      }),
      telemetryDir: dir,
      statsStore: store,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { x: { type: "noul", noul: 0.5 } }, model: "m" }),
        text: async () => "{}",
      }),
    });
    const runner = createDecisionRunner({
      getConfig: () => ({ mode: "shadow" }),
      client,
      modeOf: () => "observe",
      log: async () => {},
      specOf: () => ({
        build: () => ({ state: {}, questions: { x: { type: "noul", instructions: "?" } } }),
        parse: () => ({ v: 0.5 }),
        decide: () => ({ kind: "ask", reason: "r" }),
      }),
      recordDecision: (options) => client.recordDecision(options),
    });
    await runner.ask("authorize", { tool: "bash" });
    await store.flush();
    const records = await store.read();
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "ask", "裁决必须落进统计记录");
    assert.equal(records[0].point, "authorize");
    assert.ok(records[0].inputTokens > 0, "消耗那一半也要记");
    // 写出来的记录能被聚合认出来。
    // 区间要盖住「现在」——记录是刚写的，时间戳就是当前时刻。
    const result = aggregate(
      records,
      resolveRange({ preset: "custom", start: "2020-01-01T00:00", end: "2030-01-01T00:00" }),
    );
    assert.equal(result.outcomes.ask, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("写入路径：答案形状不符时记「未裁决」，不记成放行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-outcome-"));
  try {
    const { StartluxClient } = await import("../lib/index.js");
    const { createDecisionRunner } = await import("../lib/engine.js");
    const store = new StatsStore({ dir });
    const client = new StartluxClient({
      getConfig: () => ({
        provider: "bamboonode",
        bamboonodeApiKey: "k",
        cacheSize: 256,
        cacheTtlMs: 600000,
        timeoutMs: 5000,
        thinkMode: "never",
        mode: "shadow",
      }),
      telemetryDir: dir,
      statsStore: store,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { x: { type: "noul", noul: 0.5 } }, model: "m" }),
        text: async () => "{}",
      }),
    });
    const runner = createDecisionRunner({
      getConfig: () => ({ mode: "shadow" }),
      client,
      modeOf: () => "observe",
      log: async () => {},
      specOf: () => ({
        build: () => ({ state: {}, questions: { x: { type: "noul", instructions: "?" } } }),
        parse: () => undefined, // 形状不符
        decide: () => ({ kind: "delegate" }),
      }),
      recordDecision: (options) => client.recordDecision(options),
    });
    const result = await runner.ask("authorize", { tool: "bash" });
    assert.equal(result.degraded, "answer-shape-mismatch");
    await store.flush();
    const records = await store.read();
    assert.equal(records.length, 1, "消耗仍要记：这次决策确实花过时间");
    assert.equal(records[0].degraded, true);
    assert.equal(records[0].action, "degraded", "没有裁决时不能伪造成一个裁决");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("写入路径：降级也记统计（否则历史降级会凭空消失）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-outcome-"));
  try {
    const { StartluxClient } = await import("../lib/index.js");
    const store = new StatsStore({ dir });
    const client = new StartluxClient({
      getConfig: () => ({
        provider: "bamboonode",
        bamboonodeApiKey: "k",
        cacheSize: 256,
        cacheTtlMs: 600000,
        timeoutMs: 5000,
        thinkMode: "never",
        mode: "shadow",
      }),
      telemetryDir: dir,
      statsStore: store,
      fetchFn: async () => ({ ok: false, status: 500, text: async () => "boom" }),
    });
    const result = await client.classify({
      point: "authorize",
      tag: "guard",
      mode: "shadow",
      state: {},
      questions: {},
    });
    assert.equal(result, null, "失败时降级");
    await store.flush();
    const records = await store.read();
    assert.equal(records.length, 1, "降级也要留下痕迹");
    assert.equal(records[0].degraded, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
