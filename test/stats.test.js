/**
 * 统计与对比的单元测试。
 *
 * 这里覆盖的是**最容易算错**的三处：
 *
 *   1. **时间边界**：预设范围（当日/本周/本月/本年）与自定义范围必须
 *      精确到分钟，且区间是左闭右开（边界不重复计入）。
 *   2. **基线口径**：「省了多少」是相对基线算的，不是相对实际值；
 *      没有可归因的优化时节省量必须是 0，而不是某个假想的数。
 *   3. **聚合维度**：provider × model 的组合键不能撞（"ab"+"c" 与
 *      "a"+"bc" 必须分开统计）。
 *
 * 另外覆盖 tokenizer 的估算精度、统计文件的异步写入与坏行容错。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RANGE_LABELS,
  RANGE_PRESETS,
  aggregate,
  buildRecord,
  isInRange,
  parseLocalDateTime,
  resolveRange,
  sortRows,
} from "../lib/stats.js";
import { StatsStore, backfillFromTelemetry, legacyModeOf, inferLegacyProvider, providerOfTelemetryEntry, providerByEndpoint, defaultModelOf, inferLegacyPoint } from "../lib/stats-store.js";
import { estimateRequestTokens, estimateTextTokens, scaleTokensByChars } from "../lib/tokenizer.js";

/** 本地时间的一天（用于构造固定「现在」）。 */
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

/**
 * 造一条统计记录。
 *
 * 默认时间戳落在测试用的自定义区间（2026-10-20）内——用别的日期会让
 * 每条记录都被区间过滤掉，测试却仍然「通过」（断言 0 条也算对）。
 *
 * 基线字段默认跟随实际值（`buildRecord` 的语义）：只有显式覆盖时才不同。
 * 这样「基线 ≠ 实际」的用例才写得清楚。
 *
 * **默认 mode 为 observe**：节省量只由观察模式的记录贡献（见 lib/stats.js
 * 顶部说明），而这个 helper 服务的大多是「节省量」相关的用例。默认成
 * observe 让它们读起来仍是在讲同一件事；讲「非观察模式不计入」的用例
 * 显式覆盖 `mode` 即可。
 */
const rec = (over = {}) =>
  buildRecord({
    ts: "2026-10-20T10:00:00.000Z",
    provider: "bamboonode",
    model: "startlux-decision-27b-autothink",
    point: "authorize",
    mode: "observe",
    action: "delegate",
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 500,
    inputSource: "api",
    outputSource: "api",
    ...over,
  });

// ------------------------------------------------------------------ 时间范围

test("预设范围：当日为今天 00:00 到明天 00:00（左闭右开）", () => {
  const now = at(2026, 10, 27, 14, 30);
  const range = resolveRange({ preset: "today" }, now);
  assert.equal(range.valid, true);
  assert.equal(range.label, RANGE_LABELS.today);
  assert.equal(range.start.getHours(), 0);
  assert.equal(range.start.getMinutes(), 0);
  assert.equal(range.start.getDate(), 27);
  assert.equal(range.end.getDate(), 28);
  assert.equal(range.end.getHours(), 0);
  // 区间跨度正好一天（本地时区）。
  assert.equal(range.endMs - range.startMs, 24 * 60 * 60 * 1000);
});

test("预设范围：本周为周一 00:00 到下周一 00:00（含周日整天）", () => {
  // 2026-10-27 是周二。
  const now = at(2026, 10, 27, 14, 30);
  const range = resolveRange({ preset: "week" }, now);
  assert.equal(range.start.getDay(), 1, "应从周一开始");
  assert.equal(range.start.getDate(), 26);
  assert.equal(range.end.getDay(), 1);
  assert.equal(range.end.getDate(), 2, "周日整天都在区间内，结束是下周一");
  assert.equal(range.endMs - range.startMs, 7 * 24 * 60 * 60 * 1000);
});

test("预设范围：周日的「本周」仍然从上一个周一开始", () => {
  // 2026-11-01 是周日。
  const range = resolveRange({ preset: "week" }, at(2026, 11, 1, 9, 0));
  assert.equal(range.start.getDay(), 1);
  assert.equal(range.start.getDate(), 26, "10 月最后一个周一是 26 日");
  assert.equal(range.start.getMonth(), 9);
});

test("预设范围：本月为 1 日 00:00 到下月 1 日 00:00", () => {
  const range = resolveRange({ preset: "month" }, at(2026, 2, 14, 8, 0));
  assert.equal(range.start.getDate(), 1);
  assert.equal(range.start.getMonth(), 1);
  assert.equal(range.end.getMonth(), 2, "2 月的结束是 3 月 1 日");
  assert.equal(range.end.getDate(), 1);
});

test("预设范围：本年为 1 月 1 日到次年 1 月 1 日", () => {
  const range = resolveRange({ preset: "year" }, at(2026, 7, 4, 8, 0));
  assert.equal(range.start.getFullYear(), 2026);
  assert.equal(range.start.getMonth(), 0);
  assert.equal(range.start.getDate(), 1);
  assert.equal(range.end.getFullYear(), 2027);
  assert.equal(range.end.getMonth(), 0);
  assert.equal(range.end.getDate(), 1);
});

test("预设范围：非法 preset 退回「当日」而不是抛错", () => {
  const range = resolveRange({ preset: "nonsense" }, at(2026, 10, 27, 12, 0));
  assert.equal(range.preset, "today");
  assert.equal(range.valid, true);
});

test("自定义范围：精确到分钟，结束含该整分钟", () => {
  const range = resolveRange({
    preset: "custom",
    start: "2026-10-20T08:30",
    end: "2026-10-20T17:45",
  });
  assert.equal(range.valid, true);
  assert.equal(range.start.getHours(), 8);
  assert.equal(range.start.getMinutes(), 30);
  // 结束按「含该整分钟」处理 → 17:46 是排他上界。
  assert.equal(range.end.getHours(), 17);
  assert.equal(range.end.getMinutes(), 46);
});

test("自定义范围：非法输入被拒并给出原因，不抛异常", () => {
  for (const bad of [
    { preset: "custom", start: "not-a-date", end: "2026-10-20T17:45" },
    { preset: "custom", start: "2026-10-20T08:30", end: "garbage" },
    // 结束早于开始：非法。
    { preset: "custom", start: "2026-10-20T09:00", end: "2026-10-20T08:00" },
    // 2 月 31 日不存在：Date 会静默进位成 3 月 3 日，必须被挡住。
    { preset: "custom", start: "2026-02-31T08:00", end: "2026-02-31T09:00" },
    // 月份越界。
    { preset: "custom", start: "2026-13-01T08:00", end: "2026-13-01T09:00" },
    // 小时越界。
    { preset: "custom", start: "2026-10-20T25:00", end: "2026-10-20T26:00" },
  ]) {
    const range = resolveRange(bad);
    assert.equal(range.valid, false, `应拒绝：${JSON.stringify(bad)}`);
    assert.ok(range.error.length > 0, "应给出可展示的原因");
  }
});

test("自定义范围：起止相同是合法的一分钟区间", () => {
  // 结束按「含该整分钟」处理，因此 08:30→08:30 覆盖 08:30 这一分钟。
  const range = resolveRange({
    preset: "custom",
    start: "2026-10-20T08:30",
    end: "2026-10-20T08:30",
  });
  assert.equal(range.valid, true);
  assert.equal(range.endMs - range.startMs, 60 * 1000);
});

test("parseLocalDateTime：按本地时间解析，不受 UTC 解析规则影响", () => {
  const parsed = parseLocalDateTime("2026-10-27T00:00");
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 27);
  assert.equal(parsed.getHours(), 0);
  assert.equal(parsed.getMinutes(), 0);
  // 关键：00:00 是**本地**的零点，不是 UTC 零点。
  assert.equal(parsed.getTime(), new Date(2026, 9, 27, 0, 0, 0).getTime());
});

test("区间是左闭右开：边界时刻只计入一次", () => {
  const range = resolveRange({
    preset: "custom",
    start: "2026-10-20T08:00",
    end: "2026-10-20T09:00",
  });
  const atStart = rec({ ts: new Date(range.startMs).toISOString() });
  const justBefore = rec({ ts: new Date(range.startMs - 1).toISOString() });
  const justAfter = rec({ ts: new Date(range.endMs).toISOString() });
  assert.equal(isInRange(atStart, range), true, "起点应计入");
  assert.equal(isInRange(justBefore, range), false, "起点前应排除");
  assert.equal(isInRange(justAfter, range), false, "上界应排除");
});

// ------------------------------------------------------------------ 聚合

test("聚合：按 provider × model 分组，各自独立统计", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({ provider: "bamboonode", model: "m1", inputTokens: 100, outputTokens: 10, durationMs: 100 }),
      rec({ provider: "bamboonode", model: "m1", inputTokens: 200, outputTokens: 20, durationMs: 200 }),
      rec({ provider: "siliconflow", model: "m1", inputTokens: 50, outputTokens: 5, durationMs: 50 }),
      rec({ provider: "bamboonode", model: "m2", inputTokens: 7, outputTokens: 1, durationMs: 7 }),
    ],
    range,
  );
  assert.equal(result.recordCount, 4);
  assert.equal(result.rows.length, 3);
  const bambooM1 = result.rows.find((row) => row.provider === "bamboonode" && row.model === "m1");
  assert.equal(bambooM1.inputTokens, 300);
  assert.equal(bambooM1.outputTokens, 30);
  assert.equal(bambooM1.durationMs, 300);
  assert.equal(bambooM1.avgDurationMs, 150);
  assert.equal(result.totals.inputTokens, 357);
});

test("聚合：组合键不因 id 拼接而相撞", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({ provider: "ab", model: "c", inputTokens: 10 }),
      rec({ provider: "a", model: "bc", inputTokens: 100 }),
    ],
    range,
  );
  assert.equal(result.rows.length, 2, "两组必须分开，不能合并成一组");
  const ab = result.rows.find((row) => row.provider === "ab");
  const a = result.rows.find((row) => row.provider === "a");
  assert.equal(ab.inputTokens, 10);
  assert.equal(a.inputTokens, 100);
});

test("节省量：相对基线算，而不是相对实际值", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({
        inputTokens: 100,
        outputTokens: 20,
        durationMs: 100,
        baseInputTokens: 500,
        baseOutputTokens: 100,
        baseDurationMs: 900,
      }),
    ],
    range,
  );
  const row = result.rows[0];
  assert.equal(row.savedInputTokens, 400);
  assert.equal(row.savedOutputTokens, 80);
  assert.equal(row.savedTotalTokens, 480);
  assert.equal(row.savedDurationMs, 800);
  // 比例的分母是基线：基线 600 token，实际 120 → 省 480/600 = 80%。
  assert.equal(row.savedRatio, 0.8);
});

test("节省量：没有可归因的优化时是 0，而不是负数或假想值", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [rec({ inputTokens: 100, outputTokens: 20, durationMs: 100 })],
    range,
  );
  const row = result.rows[0];
  assert.equal(row.savedInputTokens, 0);
  assert.equal(row.savedOutputTokens, 0);
  assert.equal(row.savedDurationMs, 0);
  assert.equal(row.savedRatio, 0);
});

// ------------------------------------------------ 节省量只认「观察」模式

test("节省量：只统计观察模式的记录，生效模式不计入", () => {
  // 这是本次改动最核心的一条口径。
  //
  // 节省量是**反事实**数字（普通 LLM vs 决策模型）。它只有在两种路径跑在
  // 同一批工作上时才成立——而这只发生在观察模式：决策模型只记录、不改变
  // 行为，所以同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么
  // 跑」的结果。
  //
  // 生效模式下普通 LLM 路径根本没发生，「省了多少」只能是事后估算。把两
  // 种模式的数字混在一张表里，读者看到的是一个漂亮的节省量，却不知道它
  // 是实测对比还是估算模型算出来的。
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      // 观察模式：基线 500，实际 100 → 省 400。
      rec({ mode: "observe", inputTokens: 100, baseInputTokens: 500, baseDurationMs: 900, durationMs: 100 }),
      // 生效模式：同样有基线差 400，但它**不计入**。
      rec({ mode: "enforce", inputTokens: 100, baseInputTokens: 500, baseDurationMs: 900, durationMs: 100 }),
    ],
    range,
  );
  assert.equal(result.totals.savedInputTokens, 400, "只算观察模式那 400");
  assert.equal(result.totals.savedDurationMs, 800, "只算观察模式那 800");
  // 实际消耗照常统计全部记录：模式不影响「花了多少」。
  assert.equal(result.totals.inputTokens, 200, "实际消耗统计全部模式");
  assert.equal(result.totals.requests, 2);
  // 样本量必须露出来：节省量是 0 时，读者要能分辨「没省」与「没样本」。
  assert.equal(result.totals.observeRequests, 1);
  assert.equal(result.savings.observeRequests, 1);
  assert.equal(result.savings.totalRequests, 2);
  assert.equal(result.savings.byMode.observe, 1);
  assert.equal(result.savings.byMode.enforce, 1);
});

test("节省量：没有观察模式的记录时标为不可用（而不是显示 0）", () => {
  // 「省了 0」与「没有可比对的数据」是两件完全不同的事：
  // 前者说明插件在观察模式下确实没省，后者说明这段时间根本没在观察
  // 模式跑。界面上必须能区分，所以聚合层要把这件事标出来。
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [rec({ mode: "enforce", inputTokens: 100, baseInputTokens: 500 })],
    range,
  );
  assert.equal(result.totals.savedInputTokens, 0);
  assert.equal(result.savings.unavailable, true, "应标为节省量不可用");
  assert.equal(result.savings.observeRequests, 0);
  assert.equal(result.savings.totalRequests, 1);
});

test("节省量：老记录（无 mode 字段）不计入，模式归为 unknown", () => {
  // 老记录没有 mode → unknown → 不计入节省量。
  // 无法证明它是在观察模式下产生的，就不能把它的「省下的量」当成实测。
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      { ts: "2026-10-20T10:00:00.000Z", inputTokens: 100, baseInputTokens: 500, durationMs: 100, baseDurationMs: 900 },
    ],
    range,
  );
  assert.equal(result.totals.savedInputTokens, 0, "未知模式不计入节省量");
  assert.equal(result.savings.byMode.unknown, 1);
  assert.equal(result.savings.unavailable, true);
});

test("记录：非法 mode 归一化为 unknown，而不是猜一个", () => {
  // 猜错会让「生效模式下的估算」被当成「观察模式下的实测」——那正是
  // 要避免的事，所以非法值一律降级成 unknown。
  const record = buildRecord({ mode: "weird", inputTokens: 10 });
  assert.equal(record.mode, "unknown");
  assert.equal(buildRecord({}).mode, "unknown", "缺省也是 unknown");
  assert.equal(buildRecord({ mode: "observe" }).mode, "observe");
  assert.equal(buildRecord({ mode: "enforce" }).mode, "enforce");
});

test("节省量：缓存命中按「替掉的那次请求」计基线", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      // 一次真实请求
      rec({ inputTokens: 1000, outputTokens: 100, durationMs: 800 }),
      // 一次缓存命中：没发请求，0 token 0 毫秒，但基线是那次完整请求
      rec({
        cached: true,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        baseInputTokens: 1000,
        baseOutputTokens: 100,
        baseDurationMs: 800,
      }),
    ],
    range,
  );
  const row = result.rows[0];
  assert.equal(row.requests, 2);
  assert.equal(row.cached, 1);
  assert.equal(row.inputTokens, 1000, "命中那次不计入实际消耗");
  // 基线是**观察模式**那一部分的基线（两条记录都是 observe）。
  assert.equal(row.observeBaseInputTokens, 2000);
  assert.equal(row.savedInputTokens, 1000);
  assert.equal(row.savedDurationMs, 800);
});

test("节省量：历史记录（无基线字段）的缓存命中用同组平均耗时补基线", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({ durationMs: 600, inputTokens: 500, outputTokens: 50 }),
      rec({ durationMs: 800, inputTokens: 500, outputTokens: 50 }),
      // 老遥测回填的命中记录：没有基线字段
      rec({ cached: true, durationMs: 0, inputTokens: 0, outputTokens: 0, baseInputTokens: 0, baseDurationMs: 0 }),
    ],
    range,
  );
  const row = result.rows[0];
  // 基线耗时 = 实际 1400 + 平均 700（两次真实请求的均值）。
  assert.equal(row.observeBaseDurationMs, 2100);
  assert.equal(row.savedDurationMs, 700);
  // token 基线同样补齐：真实请求平均 input 500、output 50。
  assert.equal(row.observeBaseInputTokens, 1500);
  assert.equal(row.savedInputTokens, 500);
  assert.equal(row.observeBaseOutputTokens, 150);
  assert.equal(row.savedOutputTokens, 50);
});

test("聚合：区间外的记录被排除", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-21T00:00" });
  // 时间戳一律用**本地时间**构造：区间是本地时间的「10-20 整天」，
  // 而 UTC 的 10-20 12:00 落在本地 10-20 20:00，确实在区间内——
  // 但 UTC 的 10-19 23:59 却落在本地 10-20 07:59（区间内），
  // 用 UTC 串来断言「区间外」会得到与直觉相反的结果。
  const before = rec({ ts: new Date(range.startMs - 1).toISOString() });
  const inside = rec({ ts: new Date(range.startMs + 3600_000).toISOString() });
  const after = rec({ ts: new Date(range.endMs).toISOString() });
  const result = aggregate([before, inside, after], range);
  assert.equal(result.recordCount, 1);
  assert.equal(result.totals.inputTokens, inside.inputTokens);
});

test("聚合：坏记录不产生 NaN", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      { ts: "2026-10-20T12:00:00.000Z", inputTokens: "not a number", durationMs: null },
      { ts: "not a timestamp", inputTokens: 5 },
      rec(),
    ],
    range,
  );
  assert.equal(result.recordCount, 2, "时间戳非法的记录应被排除");
  assert.ok(Number.isFinite(result.totals.savedRatio));
  assert.ok(Number.isFinite(result.totals.avgDurationMs));
});

test("按决策点分账可用", () => {
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({ point: "authorize", inputTokens: 100 }),
      rec({ point: "route", inputTokens: 200 }),
      rec({ point: "authorize", inputTokens: 300 }),
    ],
    range,
  );
  const authorize = result.byPoint.find((row) => row.point === "authorize");
  assert.equal(authorize.inputTokens, 400);
  assert.equal(authorize.requests, 2);
});

// ------------------------------------------------------------------ 排序

test("排序：按指标排序，且同值时顺序稳定", () => {
  const rows = [
    { provider: "b", model: "m", inputTokens: 10, durationMs: 300 },
    { provider: "a", model: "m", inputTokens: 10, durationMs: 100 },
    { provider: "c", model: "m", inputTokens: 50, durationMs: 200 },
  ];
  const byInput = sortRows(rows, "inputTokens", "desc");
  assert.equal(byInput[0].provider, "c");
  // 同值按 provider 名字排，保证顺序稳定。
  assert.deepEqual(
    byInput.slice(1).map((row) => row.provider),
    ["a", "b"],
  );
  const byDuration = sortRows(rows, "durationMs", "asc");
  assert.equal(byDuration[0].provider, "a");
  // 未知字段退回按 input 排序，而不是整表乱序。
  const unknown = sortRows(rows, "noSuchField", "desc");
  assert.equal(unknown[0].provider, "c");
  // 不改原数组。
  assert.equal(rows[0].provider, "b");
});

// ------------------------------------------------------------------ tokenizer

test("tokenizer：中文一字一 token，英文约四字符一 token", () => {
  assert.equal(estimateTextTokens("中文中文"), 4);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens(""), 0);
});

test("tokenizer：请求体估算包含固定结构开销", () => {
  const short = estimateRequestTokens("{}");
  const long = estimateRequestTokens("a".repeat(300));
  assert.ok(short > 0, "空请求体也应计结构开销");
  assert.ok(long > short);
});

test("tokenizer：按字符比例放大时固定开销不翻倍", () => {
  const scaled = scaleTokensByChars(200, 1000, 2000);
  // 200 = 90 固定 + 110 变量 → 放大后 = 90 + 220 = 310。
  assert.equal(scaled, 310);
  // 目标不更大时原样返回。
  assert.equal(scaleTokensByChars(200, 1000, 500), 200);
  assert.equal(scaleTokensByChars(0, 1000, 2000), 0);
});

// ------------------------------------------------------------------ 持久化

test("统计存储：异步写入，不阻塞调用方", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    const store = new StatsStore({ dir });
    store.record(rec({ provider: "a", model: "m" }));
    store.record(rec({ provider: "b", model: "m" }));
    // 不 await：调用方立刻返回。
    await store.flush();
    const records = await store.read();
    assert.equal(records.length, 2);
    assert.equal(records[0].provider, "a");
    assert.equal(records[1].provider, "b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("统计存储：坏行被跳过，不影响其它行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "stats.jsonl"),
      '{"ts":"2026-10-27T10:00:00.000Z","provider":"a"}\n{坏行\n{"ts":"2026-10-27T10:01:00.000Z","provider":"b"}\n',
      "utf8",
    );
    const store = new StatsStore({ dir });
    const records = await store.read();
    assert.equal(records.length, 2);
    assert.equal(records[0].provider, "a");
    assert.equal(records[1].provider, "b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("统计存储：文件不存在时返回空数组", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    const store = new StatsStore({ dir });
    assert.deepEqual(await store.read(), []);
    assert.equal(await store.exists(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("统计存储：写盘失败不影响调用方（不抛）", async () => {
  // 目录指向一个不可写的路径：appendFile 会失败，但 record() 不许抛。
  const store = new StatsStore({ dir: "/proc/definitely-not-writable" });
  store.record(rec());
  await store.flush();
  assert.ok(store.failed > 0, "应记录失败条数");
});

test("回填：从旧遥测推算历史统计，并标明是推算值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({
          ts: "2026-10-27T10:00:00.000Z",
          point: "authorize",
          model: "startlux-decision-27b-autothink",
          action: "delegate",
          latencyMs: 640,
          inputTokens: 2000,
        }),
        JSON.stringify({
          ts: "2026-10-27T10:01:00.000Z",
          point: "authorize",
          action: "degraded",
          detail: "timeout",
          latencyMs: 8000,
        }),
      ].join("\n"),
      "utf8",
    );
    const records = await backfillFromTelemetry({ dir });
    // 降级记录**也要**回填：以前这里直接跳过，于是历史上所有降级都从
    // 统计里消失了——用户看到「这段时间零降级」，而当时端点连着超时。
    assert.equal(records.length, 2, "降级记录也要回填（否则历史降级凭空消失）");
    assert.equal(records[0].estimated, true);
    assert.equal(records[0].provider, "bamboonode", "老遥测的 startlux 模型按模型名反推为 bamboonode");
    assert.equal(records[0].model, "startlux-decision-27b-autothink");
    assert.equal(records[0].inputTokens, 2000);
    assert.equal(records[0].durationMs, 640);
    assert.equal(records[0].outputTokens, 0, "老遥测没有 output token");
    // 降级那条：没有 token、没有裁决，但耗时是真的等掉了。
    assert.equal(records[1].degraded, true);
    assert.equal(records[1].inputTokens, 0, "降级没拿到答案，不该有 token");
    assert.equal(records[1].baseInputTokens, 0, "降级没有基线可言");
    assert.equal(records[1].durationMs, 8000, "降级的等待耗时是真实成本，要留着");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("回填保留裁决词，历史裁决仍能按 allow/ask/reject 分账", async () => {
  // 回填不是为了「补点 token 数字」——它还带着**裁决**。老遥测里记的
  // 就是裁决本身（delegate / ask / deny / skip …），回填时必须原样保留，
  // 否则历史裁决全部变成「未裁决」，按裁决分账只剩最近的数据。
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({
          ts: "2026-10-27T10:00:00.000Z",
          point: "authorize",
          model: "m1",
          action: "delegate",
          latencyMs: 100,
          inputTokens: 500,
        }),
        JSON.stringify({
          ts: "2026-10-27T10:01:00.000Z",
          point: "authorize",
          model: "m1",
          action: "ask",
          latencyMs: 100,
          inputTokens: 500,
        }),
        JSON.stringify({
          ts: "2026-10-27T10:02:00.000Z",
          point: "authorize",
          model: "m1",
          action: "deny",
          latencyMs: 100,
          inputTokens: 500,
        }),
      ].join("\n"),
      "utf8",
    );
    const records = await backfillFromTelemetry({ dir });
    assert.deepEqual(
      records.map((row) => row.action),
      ["delegate", "ask", "deny"],
      "裁决词必须原样保留",
    );
    const range = resolveRange({
      preset: "custom",
      start: "2026-10-27T00:00",
      end: "2026-10-27T23:59",
    });
    const result = aggregate(records, range);
    assert.equal(result.outcomes.allow, 1, "delegate → 放行");
    assert.equal(result.outcomes.ask, 1, "ask → 询问");
    assert.equal(result.outcomes.reject, 1, "deny → 拦截");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("范围预设清单完整且标签齐备", () => {
  assert.deepEqual(RANGE_PRESETS, ["today", "week", "month", "year", "custom"]);
  for (const preset of RANGE_PRESETS) {
    assert.equal(typeof RANGE_LABELS[preset], "string");
  }
});

// ------------------------------------------------------- 遥测与统计的分工

test("遥测只记 API 报的数字，估算值只进统计", async () => {
  // 背景：曾经把估算值也写进 result.inputTokens，结果遥测（审计记录）里
  // 出现了「服务端其实没报、由本插件推算」的 token 数。遥测的用途是
  // 「服务端到底说了什么」，混入推算值就失去审计意义。
  // 统计有独立的来源标记（inputSource / outputSource），推算值放在那里
  // 才有出处。
  const { StartluxClient } = await import("../lib/index.js");
  const { createDecisionRunner } = await import("../lib/engine.js");
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    // 服务方**不返回 usage**：只有估算值可用。
    const client = new StartluxClient({
      getConfig: () => ({
        provider: "bamboonode",
        bamboonodeApiKey: "test-key",
        cacheSize: 256,
        cacheTtlMs: 600000,
        timeoutMs: 5000,
        thinkMode: "never",
        mode: "shadow",
      }),
      telemetryDir: dir,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ answers: { x: { type: "noul", noul: 0.5 } }, model: "m" }),
        text: async () => "{}",
      }),
    });
    // 遥测里的那条记录是**引擎**写的（engine.js 的 ask()），不是客户端。
    const written = [];
    const runner = createDecisionRunner({
      getConfig: () => ({ mode: "shadow" }),
      client,
      modeOf: () => "observe",
      log: async (entry) => {
        written.push(entry);
      },
      specOf: () => ({
        build: () => ({ state: { tool: "bash" }, questions: { x: { type: "noul", instructions: "?" } } }),
        parse: () => ({ value: 0.5 }),
        decide: () => ({ kind: "delegate", reason: "ok" }),
      }),
    });
    await runner.ask("authorize", { tool: "bash" });
    assert.equal(written.length, 1);
    // 引擎写的那条里不该有 inputTokens（服务端没报，客户端也就没给）。
    assert.equal(
      Object.hasOwn(written[0], "inputTokens"),
      false,
      `遥测不应含估算的 inputTokens，实际：${JSON.stringify(written[0])}`,
    );
    // 但**必须**带 provider：回填历史统计时它是唯一可靠的归因来源。
    assert.equal(written[0].provider, "bamboonode", "遥测必须自带 provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("降级时遥测也带 provider 与 model：失败也要归因到发起失败的服务商", async () => {
  // 降级记录没有拿到任何答案，本就没有 model——但服务商是知道的。
  // 遥测若不记 provider，回填时这批记录只能整块记成 unknown，
  // 统计页上便是「未知（历史）」。
  const { StartluxClient } = await import("../lib/index.js");
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    const client = new StartluxClient({
      getConfig: () => ({
        provider: "bamboonode",
        bamboonodeApiKey: "test-key",
        cacheSize: 256,
        cacheTtlMs: 600000,
        timeoutMs: 5000,
        thinkMode: "never",
        mode: "shadow",
      }),
      telemetryDir: dir,
      // 端点不可用 → 降级。
      fetchFn: async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }),
    });
    const result = await client.classify({
      point: "authorize",
      state: { tool: "bash" },
      questions: { x: { type: "noul", instructions: "?" } },
    });
    assert.equal(result, null, "端点报错时应降级");
    const telemetry = await readFile(join(dir, "telemetry.jsonl"), "utf8");
    const entry = JSON.parse(telemetry.split("\n").find((l) => l.trim().length > 0));
    assert.equal(entry.action, "degraded");
    assert.equal(entry.provider, "bamboonode", "降级遥测必须带 provider");
    assert.equal(
      typeof entry.model === "string" && entry.model.length > 0,
      true,
      "降级遥测必须带 model（本来会用的那个）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("平均耗时按真实请求算，不被缓存命中稀释", () => {
  // 缓存命中的那次没发请求：token 0、耗时 0。算进分母会让「平均耗时」
  // 随命中率升高而变好看——那说的就不是「一次请求多快」了。
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({ durationMs: 1000, inputTokens: 500 }),
      rec({ durationMs: 2000, inputTokens: 700 }),
      // 三次缓存命中：耗时 0
      rec({ cached: true, durationMs: 0, inputTokens: 0, baseInputTokens: 600, baseDurationMs: 1500 }),
      rec({ cached: true, durationMs: 0, inputTokens: 0, baseInputTokens: 600, baseDurationMs: 1500 }),
      rec({ cached: true, durationMs: 0, inputTokens: 0, baseInputTokens: 600, baseDurationMs: 1500 }),
    ],
    range,
  );
  const row = result.rows[0];
  assert.equal(row.requests, 5);
  assert.equal(row.realRequests, 2, "真实请求只有两次");
  assert.equal(row.avgDurationMs, 1500, "平均耗时应是 (1000+2000)/2");
  assert.equal(row.avgInputTokens, 600, "平均 input 同理按真实请求算");
});

// ------------------------------------------------ 缓存命中的映射方向（回归）

test("回填：缓存命中记的是「省下的一次请求」，不是实际消耗", async () => {
  // 这是真实踩过的坑：老遥测在缓存命中时把**上一次真实请求**的 token 数
  // 一起记了下来（classify 直接返回缓存对象）。按字面当成实际消耗，
  // 就会算出 base(0) - actual(473) = **-473 的负节省**。
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      JSON.stringify({
        ts: "2026-10-27T10:00:00.000Z",
        point: "authorize",
        model: "startlux-decision-27b-autothink",
        action: "delegate",
        latencyMs: 0,
        cached: true,
        inputTokens: 473,
      }),
      "utf8",
    );
    const [row] = await backfillFromTelemetry({ dir });
    assert.equal(row.cached, true);
    assert.equal(row.inputTokens, 0, "命中那次没发请求，实际消耗是 0");
    assert.equal(row.durationMs, 0, "命中那次没等网络");
    assert.equal(row.baseInputTokens, 473, "基线 = 被替掉的那次请求");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("聚合：节省量永远不为负", () => {
  // 混合一批：真实请求 + 回填的命中记录（有 input 基线、没有耗时基线）。
  const range = resolveRange({ preset: "custom", start: "2026-10-20T00:00", end: "2026-10-20T23:59" });
  const result = aggregate(
    [
      rec({ durationMs: 900, inputTokens: 500, outputTokens: 20 }),
      rec({ durationMs: 1100, inputTokens: 700, outputTokens: 30 }),
      // 回填来的命中：input 基线有、耗时基线没有
      rec({ cached: true, durationMs: 0, inputTokens: 0, outputTokens: 0, baseInputTokens: 600, baseOutputTokens: 0, baseDurationMs: 0 }),
    ],
    range,
  );
  const t = result.totals;
  for (const [name, value] of [
    ["savedInputTokens", t.savedInputTokens],
    ["savedOutputTokens", t.savedOutputTokens],
    ["savedDurationMs", t.savedDurationMs],
  ]) {
    assert.ok(value >= 0, `${name} 不该为负，实际 ${value}`);
  }
  // 缺的耗时基线被同组均值（1000ms）补上，而不是留成 0。
  assert.equal(t.savedDurationMs, 1000);
  assert.equal(t.observeBaseDurationMs, 900 + 1100 + 1000);
});

test("回填只做一次，且落盘后与新记录同处一个文件", async () => {
  // 落盘的意义：历史与新记录在同一个文件里，随时间范围一起被统计到。
  // 若只在查询时现算，统计文件被第一笔新请求创建后，历史就消失了。
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({
          ts: "2026-10-27T10:00:00.000Z",
          point: "authorize",
          model: "m1",
          action: "delegate",
          latencyMs: 640,
          inputTokens: 2000,
        }),
        JSON.stringify({
          ts: "2026-10-27T10:01:00.000Z",
          point: "authorize",
          model: "m1",
          action: "delegate",
          latencyMs: 0,
          cached: true,
          inputTokens: 2000,
        }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    // 第一次：回填并落盘。
    const first = await store.backfillOnce();
    assert.equal(first, 2, "应回填两条遥测");
    const afterFirst = await store.read();
    assert.equal(afterFirst.length, 2);
    // 再加一条新记录。
    store.record(rec({ ts: "2026-10-27T10:05:00.000Z", inputTokens: 100 }));
    await store.flush();
    const merged = await store.read();
    assert.equal(merged.length, 3, "历史与新记录应在同一个文件里");
    // 第二次：不再回填（否则历史会重复）。
    const second = await store.backfillOnce();
    assert.equal(second, 0, "回填只能做一次");
    assert.equal((await store.read()).length, 3, "重复回填会让统计翻倍");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("回填后统计里的节省量不为负（老遥测的缓存命中映射）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({
          ts: "2026-10-27T10:00:00.000Z",
          point: "authorize",
          model: "m1",
          action: "delegate",
          latencyMs: 1000,
          inputTokens: 2000,
        }),
        JSON.stringify({
          ts: "2026-10-27T10:01:00.000Z",
          point: "authorize",
          model: "m1",
          action: "delegate",
          latencyMs: 0,
          cached: true,
          inputTokens: 2000,
        }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    await store.backfillOnce();
    const records = await store.read();
    const range = resolveRange({
      preset: "custom",
      start: "2026-10-27T00:00",
      end: "2026-10-27T23:59",
    });
    const result = aggregate(records, range);
    assert.ok(result.totals.savedInputTokens >= 0, "节省量不该为负");
    assert.ok(result.totals.savedDurationMs >= 0, "节省的耗时不该为负");
    /**
     * 这批老遥测**没有 mode 字段** → 回填成 `unknown` → 不计入节省量。
     *
     * 这正是期望的行为：无法证明一条历史记录是在观察模式下产生的，
     * 就不能把它的「省下的量」当成实测展示。宁可少算，不可把不确定的
     * 数字当成实测——那是最难自查也最难解释的一类偏差。
     *
     * （如果老遥测带 `mode: shadow`，它会被映射成 observe 并计入，见下一个用例。）
     */
    assert.equal(result.totals.savedInputTokens, 0, "未知模式的记录不计入节省量");
    assert.equal(result.totals.observeRequests, 0, "没有观察模式的记录");
    assert.equal(result.savings.unavailable, true, "节省量应当标为不可用");
    // 实际消耗照常统计：模式不影响「花了多少」。
    assert.equal(result.totals.inputTokens, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("回填：老遥测的 shadow 映射成 observe，计入节省量", async () => {
  // 老遥测只有 shadow（只记录）与 enforce（真正生效）两值。shadow 就是
  // 现在的 observe——它是唯一有实测意义的观察样本，丢掉它等于把历史里
  // 唯一可信的节省量一并抹掉。
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({
          ts: "2026-10-27T10:00:00.000Z",
          point: "authorize",
          model: "m1",
          mode: "shadow",
          action: "delegate",
          latencyMs: 1000,
          inputTokens: 2000,
        }),
        JSON.stringify({
          ts: "2026-10-27T10:01:00.000Z",
          point: "authorize",
          model: "m1",
          mode: "shadow",
          action: "delegate",
          latencyMs: 0,
          cached: true,
          inputTokens: 2000,
        }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    await store.backfillOnce();
    const records = await store.read();
    assert.equal(records[0].mode, "observe", "shadow 应映射成 observe");
    const range = resolveRange({
      preset: "custom",
      start: "2026-10-27T00:00",
      end: "2026-10-27T23:59",
    });
    const result = aggregate(records, range);
    assert.equal(result.totals.observeRequests, 2, "两条都是观察模式");
    assert.equal(result.totals.savedInputTokens, 2000, "命中省下了一次 2000 token 的请求");
    assert.equal(result.savings.unavailable, false, "有观察模式的记录，节省量可用");
    assert.equal(result.savings.byMode.observe, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- 历史记录补模式（一次性迁移）

test("模式映射：老遥测的 shadow→observe、enforce→enforce、缺失→unknown", () => {
  // 映射错了的后果：老遥测里那 205 条 shadow 是唯一有实测意义的观察
  // 样本，映射丢错等于把历史里唯一可信的节省量一并抹掉。
  assert.equal(legacyModeOf("shadow"), "observe");
  assert.equal(legacyModeOf("observe"), "observe");
  assert.equal(legacyModeOf("enforce"), "enforce");
  assert.equal(legacyModeOf("off"), "off");
  assert.equal(legacyModeOf(undefined), "unknown");
  assert.equal(legacyModeOf("garbage"), "unknown");
});

test("迁移：给已有统计记录补上 mode（按时间戳匹配老遥测）", async () => {
  // 场景：升级前写的 stats.jsonl 没有 mode 字段。升级后若不补，这些
  // 记录会被归为「未知模式」而全部不计入节省量——用户会看到历史节省量
  // 凭空变成 0。
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    // 老遥测：两条 shadow、一条 enforce。
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", tag: "guard", mode: "shadow", action: "delegate", latencyMs: 640, inputTokens: 2565 }),
        JSON.stringify({ ts: "2026-10-23T06:30:47.166Z", tag: "guard", mode: "shadow", action: "delegate", latencyMs: 471, inputTokens: 2201 }),
        JSON.stringify({ ts: "2026-10-23T06:31:00.000Z", tag: "guard", mode: "enforce", action: "delegate", latencyMs: 500, inputTokens: 2000 }),
      ].join("\n"),
      "utf8",
    );
    // 已有统计：没有 mode 字段（升级前写的）。
    await writeFile(
      join(dir, "stats.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", provider: "unknown", model: "m1", point: "unknown", action: "delegate", cached: false, inputTokens: 2565, outputTokens: 0, durationMs: 640, baseInputTokens: 2565, baseOutputTokens: 0, baseDurationMs: 640, inputSource: "api", outputSource: "unknown", estimated: true }),
        JSON.stringify({ ts: "2026-10-23T06:30:47.166Z", provider: "unknown", model: "m1", point: "unknown", action: "delegate", cached: false, inputTokens: 2201, outputTokens: 0, durationMs: 471, baseInputTokens: 2201, baseOutputTokens: 0, baseDurationMs: 471, inputSource: "api", outputSource: "unknown", estimated: true }),
        JSON.stringify({ ts: "2026-10-23T06:31:00.000Z", provider: "unknown", model: "m1", point: "unknown", action: "delegate", cached: false, inputTokens: 2000, outputTokens: 0, durationMs: 500, baseInputTokens: 2000, baseOutputTokens: 0, baseDurationMs: 500, inputSource: "api", outputSource: "unknown", estimated: true }),
        // 匹配不上的：保留未知模式，不猜。时刻在区间内，这样它会被
        // 统计到（模式分账里的 unknown），只是不参与节省量。
        JSON.stringify({ ts: "2026-10-23T06:32:00.000Z", provider: "unknown", model: "m1", point: "unknown", action: "delegate", cached: false, inputTokens: 999, outputTokens: 0, durationMs: 100, baseInputTokens: 999, baseOutputTokens: 0, baseDurationMs: 100, inputSource: "api", outputSource: "unknown", estimated: true }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    const filled = await store.fillMissingModesOnce();
    assert.equal(filled, 3, "三条能匹配上的应被补上");
    const records = await store.read();
    assert.equal(records[0].mode, "observe");
    assert.equal(records[1].mode, "observe");
    assert.equal(records[2].mode, "enforce");
    assert.equal(records[3].mode, undefined, "匹配不上的不该被猜一个模式");
    // 补完后的统计：两条观察记录参与节省量。
    const range = resolveRange({ preset: "custom", start: "2026-10-23T00:00", end: "2026-10-23T23:59" });
    const result = aggregate(records, range);
    assert.equal(result.totals.observeRequests, 2);
    assert.equal(result.savings.byMode.observe, 2);
    assert.equal(result.savings.byMode.enforce, 1);
    assert.equal(result.savings.byMode.unknown, 1);
    // 只做一次。
    assert.equal(await store.fillMissingModesOnce(), 0, "迁移只能做一次");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移：已经有 mode 的记录不被覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", tag: "guard", mode: "shadow", action: "delegate" })].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "stats.jsonl"),
      [JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", provider: "p", model: "m1", point: "authorize", mode: "enforce", action: "delegate", inputTokens: 10, outputTokens: 0, durationMs: 100, baseInputTokens: 10, baseOutputTokens: 0, baseDurationMs: 100, inputSource: "api", outputSource: "unknown" })].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    assert.equal(await store.fillMissingModesOnce(), 0, "没有缺 mode 的记录就不该改");
    const records = await store.read();
    assert.equal(records[0].mode, "enforce", "已有 mode 不能被覆盖");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- 老遥测按模型名反推 provider

test("inferLegacyProvider：startlux→bamboonode、Kev/SemIf→硅基流动，其余 unknown", () => {
  assert.equal(inferLegacyProvider("startlux-decision-27b-autothink"), "bamboonode");
  assert.equal(inferLegacyProvider("STARTLUX-XYZ"), "bamboonode", "大小写不敏感");
  assert.equal(inferLegacyProvider("Kev-4B"), "siliconflow");
  assert.equal(inferLegacyProvider("kev-4b"), "siliconflow", "大小写不敏感");
  assert.equal(inferLegacyProvider("SemIf"), "siliconflow");
  assert.equal(inferLegacyProvider(""), "unknown", "空模型退回 unknown");
  assert.equal(inferLegacyProvider(undefined), "unknown");
  assert.equal(inferLegacyProvider("gpt-4o"), "unknown", "匹配不上退回 unknown，绝不瞎猜");
});

test("回填：startlux 模型的记录反推为 bamboonode，不再 unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-27T10:00:00.000Z", point: "authorize", model: "startlux-decision-27b-autothink", action: "delegate", latencyMs: 640, inputTokens: 2000 }),
        JSON.stringify({ ts: "2026-10-27T10:01:00.000Z", point: "authorize", model: "Kev-4B", action: "delegate", latencyMs: 471, inputTokens: 2201 }),
        JSON.stringify({ ts: "2026-10-27T10:02:00.000Z", point: "authorize", model: "gpt-4o", action: "delegate", latencyMs: 500, inputTokens: 2000 }),
      ].join("\n"),
      "utf8",
    );
    const records = await backfillFromTelemetry({ dir });
    assert.equal(records[0].provider, "bamboonode", "startlux 系 → bamboonode");
    assert.equal(records[1].provider, "siliconflow", "Kev 系 → 硅基流动");
    assert.equal(records[2].provider, "unknown", "匹配不上仍是 unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移：把已落盘的 estimated 记录按模型名补回 provider（只碰 estimated，不动真实 unknown）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "stats.jsonl"),
      [
        // 历史回填记录：startlux → bamboonode。
        JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", provider: "unknown", model: "startlux-decision-27b-autothink", point: "authorize", action: "delegate", inputTokens: 2565, outputTokens: 0, durationMs: 640, baseInputTokens: 2565, baseOutputTokens: 0, baseDurationMs: 640, inputSource: "api", outputSource: "unknown", estimated: true }),
        // 历史回填记录：Kev → siliconflow。
        JSON.stringify({ ts: "2026-10-23T06:30:47.166Z", provider: "unknown", model: "Kev-4B", point: "authorize", action: "delegate", inputTokens: 2201, outputTokens: 0, durationMs: 471, baseInputTokens: 2201, baseOutputTokens: 0, baseDurationMs: 471, inputSource: "api", outputSource: "unknown", estimated: true }),
        // 历史回填记录：匹配不上 → 保持 unknown。
        JSON.stringify({ ts: "2026-10-23T06:31:00.000Z", provider: "unknown", model: "gpt-4o", point: "authorize", action: "delegate", inputTokens: 2000, outputTokens: 0, durationMs: 500, baseInputTokens: 2000, baseOutputTokens: 0, baseDurationMs: 500, inputSource: "api", outputSource: "unknown", estimated: true }),
        // 真实记录（降级时确实没解析到 provider）：不是 estimated，绝不能改。
        JSON.stringify({ ts: "2026-10-27T08:00:00.000Z", provider: "unknown", model: "siliconflow-7b", point: "authorize", action: "degraded", inputTokens: 0, outputTokens: 0, durationMs: 8000, degraded: true, inputSource: "unknown", outputSource: "unknown" }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    const repaired = await store.repairLegacyProviderOnce();
    assert.equal(repaired, 2, "两条能反推的历史记录应被补回");
    const records = await store.read();
    assert.equal(records[0].provider, "bamboonode");
    assert.equal(records[1].provider, "siliconflow");
    assert.equal(records[2].provider, "unknown", "匹配不上的保持 unknown");
    assert.equal(records[3].provider, "unknown", "真实的非 estimated 记录不能被误改");
    // 只做一次。
    assert.equal(await store.repairLegacyProviderOnce(), 0, "迁移只能做一次");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移：降级记录的 unknown model 回落到 provider 默认模型（不动非降级的 unknown）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "stats.jsonl"),
      [
        // 降级记录：bamboonode 且 model 空 → 回落 startlux-decision-27b-autothink。
        JSON.stringify({ ts: "2026-10-27T08:00:00.000Z", provider: "bamboonode", model: "unknown", point: "authorize", action: "degraded", inputTokens: 0, outputTokens: 0, durationMs: 8000, degraded: true, inputSource: "unknown", outputSource: "unknown" }),
        // 降级记录：siliconflow 且 model 空 → 回落 Kev-4B。
        JSON.stringify({ ts: "2026-10-27T08:01:00.000Z", provider: "siliconflow", model: "unknown", point: "authorize", action: "degraded", inputTokens: 0, outputTokens: 0, durationMs: 8000, degraded: true, inputSource: "unknown", outputSource: "unknown" }),
        // 降级记录：model 已正常，不该被覆盖。
        JSON.stringify({ ts: "2026-10-27T08:02:00.000Z", provider: "siliconflow", model: "Kev-4B", point: "authorize", action: "degraded", inputTokens: 0, outputTokens: 0, durationMs: 8000, degraded: true, inputSource: "unknown", outputSource: "unknown" }),
        // 非降级的 model=unknown 记录：不在本迁移范围（交给反推或其它逻辑）。
        JSON.stringify({ ts: "2026-10-27T08:03:00.000Z", provider: "bamboonode", model: "unknown", point: "authorize", action: "delegate", inputTokens: 10, outputTokens: 0, durationMs: 100, degraded: false }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    const repaired = await store.repairLegacyProviderOnce();
    assert.equal(repaired, 2, "两条降级空 model 应被补回默认模型");
    const records = await store.read();
    assert.equal(records[0].model, "startlux-decision-27b-autothink", "bamboonode 降级回落到默认模型");
    assert.equal(records[1].model, "Kev-4B", "siliconflow 降级回落到默认模型");
    assert.equal(records[2].model, "Kev-4B", "已正常的 model 不被覆盖");
    assert.equal(records[3].model, "unknown", "非降级的空 model 不动");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- 机制：遥测自带 provider

test("providerOfTelemetryEntry：按可靠度取 provider（字段→extra→endpoint→模型名）", () => {
  // 1. 遥测直接带 provider —— 最高可靠度。
  assert.equal(providerOfTelemetryEntry({ provider: "bamboonode" }, "unknown"), "bamboonode");
  // 2. 降级记录的 extra.provider。
  assert.equal(providerOfTelemetryEntry({ extra: { provider: "siliconflow" } }, "unknown"), "siliconflow");
  // 3. 降级记录的 extra.endpoint 主机名。
  assert.equal(
    providerOfTelemetryEntry({ extra: { endpoint: "https://api.bamboonode.dev/v1/decisions" } }, "unknown"),
    "bamboonode",
  );
  assert.equal(
    providerOfTelemetryEntry({ extra: { endpoint: "https://api.siliconflow.cn/v1/systemone" } }, "unknown"),
    "siliconflow",
  );
  // 4. 老遥测最后的手段：按模型名反推。
  assert.equal(providerOfTelemetryEntry({}, "startlux-decision-27b-autothink"), "bamboonode");
  // 全无线索 → unknown（绝不猜）。
  assert.equal(providerOfTelemetryEntry({}, "unknown"), "unknown");
  assert.equal(providerOfTelemetryEntry({ extra: { endpoint: "https://my-own.box/v1" } }, "unknown"), "unknown");
});

test("providerByEndpoint：只认内置预设的主机名，自建地址不猜", () => {
  assert.equal(providerByEndpoint("https://api.typesafe.ai/v1"), "systemone");
  assert.equal(providerByEndpoint("https://api.bamboonode.dev/v1"), "bamboonode");
  assert.equal(providerByEndpoint("https://api.siliconflow.cn/v1"), "siliconflow");
  assert.equal(providerByEndpoint("https://api.siliconflow.com/v1"), "siliconflow-intl");
  assert.equal(providerByEndpoint("https://10.255.255.1/v1"), "unknown", "内网自建地址不猜");
  assert.equal(providerByEndpoint("not a url"), "unknown");
  assert.equal(providerByEndpoint(""), "unknown");
});

test("defaultModelOf：取 provider 的默认模型，没有则 unknown", () => {
  assert.equal(defaultModelOf("bamboonode"), "startlux-decision-27b-autothink");
  assert.equal(defaultModelOf("siliconflow"), "Kev-4B");
  assert.equal(defaultModelOf("custom"), "unknown", "custom 没有默认模型");
  assert.equal(defaultModelOf("unknown"), "unknown");
});

test("回填：遥测自带 provider 时直接采用，不再靠模型名猜", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        // 遥测直接带 provider：即便模型名不认识，也能归因。
        JSON.stringify({ ts: "2026-10-27T10:00:00.000Z", point: "authorize", model: "some-vendor-model", provider: "bamboonode", action: "delegate", latencyMs: 500, inputTokens: 100 }),
        // 遥测没带，但 extra.endpoint 能定位：降级记录（没拿到答案，没有 model）。
        JSON.stringify({ ts: "2026-10-27T10:01:00.000Z", point: "authorize", action: "degraded", detail: "timeout", extra: { endpoint: "https://api.siliconflow.cn/v1/systemone" }, latencyMs: 8000 }),
        // 三条线索全无：只能是 unknown。
        JSON.stringify({ ts: "2026-10-27T10:02:00.000Z", point: "authorize", action: "degraded", detail: "cooldown", latencyMs: 0 }),
      ].join("\n"),
      "utf8",
    );
    const rows = await backfillFromTelemetry({ dir });
    assert.equal(rows[0].provider, "bamboonode", "遥测带 provider 时直接采用");
    assert.equal(rows[0].model, "some-vendor-model");
    assert.equal(rows[1].provider, "siliconflow", "extra.endpoint 能定位服务商");
    assert.equal(rows[1].model, "Kev-4B", "降级记录回落到该服务商的默认模型");
    assert.equal(rows[2].provider, "unknown", "无线索只能是 unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("回填：降级记录落到服务商的默认模型，不自成「provider / unknown」零数据行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-27T10:00:00.000Z", point: "authorize", provider: "bamboonode", model: "startlux-decision-27b-autothink", action: "delegate", latencyMs: 500, inputTokens: 100 }),
        JSON.stringify({ ts: "2026-10-27T10:01:00.000Z", point: "authorize", provider: "bamboonode", action: "degraded", detail: "timeout", latencyMs: 8000 }),
      ].join("\n"),
      "utf8",
    );
    const rows = await backfillFromTelemetry({ dir });
    assert.equal(rows[0].model, "startlux-decision-27b-autothink");
    assert.equal(rows[1].model, "startlux-decision-27b-autothink", "降级记录用同一个模型名");
    assert.equal(rows[0].model, rows[1].model, "同一服务商的两条记录并到同一行");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移：按时间戳与遥测对上，补回真实记录里 unknown 的 provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-27T08:00:00.000Z", point: "authorize", action: "degraded", detail: "timeout", extra: { endpoint: "https://api.bamboonode.dev/v1/decisions" }, latencyMs: 8000 }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "stats.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-27T08:00:00.000Z", provider: "unknown", model: "unknown", point: "authorize", action: "degraded", detail: "timeout", inputTokens: 0, outputTokens: 0, durationMs: 8000, degraded: true, inputSource: "unknown", outputSource: "unknown" }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    const repaired = await store.repairLegacyProviderOnce();
    assert.equal(repaired, 2, "补回 provider 与 model 各算一次改动");
    const records = await store.read();
    assert.equal(records[0].provider, "bamboonode");
    assert.equal(records[0].model, "startlux-decision-27b-autothink", "补回 provider 后落到默认模型");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- 决策点（point）归因

test("inferLegacyPoint：tag 与决策点是一对一，不是猜", () => {
  // 新遥测自带 point：直接用，tag 不参与。
  assert.equal(inferLegacyPoint("guard", "retrieval"), "retrieval");
  // 老遥测没有 point：guard 是授权守卫专用 tag。
  assert.equal(inferLegacyPoint("guard"), "authorize");
  // 适配器异常出口统一用 adapter/点id。
  assert.equal(inferLegacyPoint("adapter/title"), "title");
  // 引擎写的 tag 就是决策点 id 本身。
  assert.equal(inferLegacyPoint("delegate"), "delegate");
  assert.equal(inferLegacyPoint("turnStop"), "turnStop");
  assert.equal(inferLegacyPoint("retrieval"), "retrieval");
  // 未登记的 tag 不能想当然当成决策点。
  assert.equal(inferLegacyPoint("mystery"), "unknown");
  assert.equal(inferLegacyPoint(""), "unknown");
  assert.equal(inferLegacyPoint(undefined), "unknown");
});

test("回填：老遥测没有 point 时按 tag 反推，不再落进「决策点 unknown」", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        // 老遥测：只有 tag=guard，没有 point。
        JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", tag: "guard", mode: "shadow", action: "delegate", detail: "delegate", latencyMs: 640, inputTokens: 2000 }),
        // 新遥测：自带 point。
        JSON.stringify({ ts: "2026-10-23T06:31:00.000Z", point: "retrieval", tag: "retrieval", mode: "observe", action: "delegate", detail: "delegate", latencyMs: 100, inputTokens: 50 }),
      ].join("\n"),
      "utf8",
    );
    const rows = await backfillFromTelemetry({ dir });
    assert.equal(rows[0].point, "authorize", "老遥测按 tag=guard 反推为 authorize");
    assert.equal(rows[1].point, "retrieval", "新遥测直接用自带 point");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移：老回填行的 point=unknown 按时间戳与遥测对上后补回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "de-stats-"));
  try {
    await writeFile(
      join(dir, "telemetry.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", tag: "guard", mode: "shadow", action: "delegate", detail: "delegate", latencyMs: 640 }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "stats.jsonl"),
      [
        JSON.stringify({ ts: "2026-10-23T06:30:46.613Z", provider: "bamboonode", model: "startlux-decision-27b-autothink", point: "unknown", action: "delegate", detail: "delegate", inputTokens: 2000, outputTokens: 0, durationMs: 640, baseInputTokens: 2000, baseOutputTokens: 0, baseDurationMs: 640, inputSource: "api", outputSource: "unknown", estimated: true }),
      ].join("\n"),
      "utf8",
    );
    const store = new StatsStore({ dir });
    const repaired = await store.repairLegacyProviderOnce();
    assert.equal(repaired, 1, "补回 point 算一次改动");
    const records = await store.read();
    assert.equal(records[0].point, "authorize", "老回填行的 point 补回为 authorize");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
