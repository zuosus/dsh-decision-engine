/**
 * 走势序列（`lib/stats.js` 的 pickBucket / bucketKey / bucketKeys / buildSeries）。
 *
 * 为什么这些要单独测：走势图是「数字的第二种读法」，它一旦算错，错的
 * 方式**看起来仍然合理**——气泡少一个、桶错位一小时、空桶被跳过导致
 * 折线跨过一整天，画出来都是「一条线」，只有对着表格逐点核对才发现不对。
 * 而那种核对没人会天天做。
 *
 * 这里盯住四件事：
 *   1. 分桶粒度随区间长度收敛（太长会挤成噪声，太短只有一个点）；
 *   2. 键按**本地**时区切（按 UTC 切会让东八区的「今天」错位八小时）；
 *   3. 空桶补 0（「没请求」必须在图上表现为掉到零，而不是被折线忽略）；
 *   4. 序列与既有分账**同源**（裁决三格之和必须等于 outcomes 的三格）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { aggregate, bucketKey, bucketKeys, buildSeries, pickBucket, resolveRange } from "../lib/stats.js";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 造一条记录（形状照抄 normalizeRecord 能接受的原始输入）。 */
function record(ts, over = {}) {
  return {
    ts: new Date(ts).toISOString(),
    provider: "bamboonode",
    model: "m1",
    point: "authorize",
    action: "allow",
    cached: false,
    degraded: false,
    mode: "observe",
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 100,
    baseInputTokens: 20,
    baseOutputTokens: 10,
    baseDurationMs: 200,
    ...over,
  };
}

test("分桶粒度随区间长度收敛：短区间按小时，长区间按月", () => {
  // 「当日」若按天分桶只有一个点，画出来是直线；「本年」若按小时分桶
  // 有 8760 个点，挤成一片噪声。粒度必须跟着区间走。
  assert.equal(pickBucket(6 * HOUR), "hour");
  assert.equal(pickBucket(1 * DAY), "hour");
  assert.equal(pickBucket(2 * DAY), "hour");
  assert.equal(pickBucket(3 * DAY), "day");
  assert.equal(pickBucket(30 * DAY), "day");
  assert.equal(pickBucket(62 * DAY), "day");
  assert.equal(pickBucket(63 * DAY), "month");
  assert.equal(pickBucket(365 * DAY), "month");
});

test("分桶键按本地时区切，不按 UTC", () => {
  // 用本地时间构造一个时刻，再取它的键：键里的日期/小时必须与本地一致。
  // 若实现用了 toISOString（UTC），东八区在早上 8 点之前会落到前一天。
  const local = new Date(2026, 10, 10, 3, 30, 0); // 本地 2026-11-10 03:30
  assert.equal(bucketKey(local.getTime(), "hour"), "2026-11-10T03");
  assert.equal(bucketKey(local.getTime(), "day"), "2026-11-10");
  assert.equal(bucketKey(local.getTime(), "month"), "2026-11");
});

test("分桶键可排序：月补零，字符串序与时间序一致", () => {
  // 键既要当 Map 键，也要能直接排序给界面用。三月不补零会排在十二月后面。
  const march = new Date(2026, 2, 15, 12).getTime();
  const december = new Date(2026, 11, 15, 12).getTime();
  assert.equal(bucketKey(march, "month"), "2026-03");
  assert.equal(bucketKey(december, "month"), "2026-12");
  assert.ok(bucketKey(march, "month") < bucketKey(december, "month"));
});

test("空桶补 0：没请求的那几格必须留在序列里", () => {
  // 这是走势图最容易骗人的地方：只返回「有记录的桶」，折线会把周一
  // 直接连到周五，看起来像一直在稳定请求——而中间三天其实一条都没有。
  const range = { startMs: new Date(2026, 10, 2, 0).getTime(), endMs: new Date(2026, 10, 6, 0).getTime() };
  const keys = bucketKeys(range, "day");
  assert.deepEqual(keys, ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);

  const series = buildSeries(
    [record(new Date(2026, 10, 2, 9).getTime()), record(new Date(2026, 10, 5, 9).getTime())],
    range,
  );
  assert.equal(series.buckets.length, 4);
  // 中间两天必须是 0，而不是被跳过。
  assert.deepEqual(series.series.requests, [1, 0, 0, 1]);
});

test("序列与表格同源：各桶之和等于 totals", () => {
  // 图上看到的与表里写下的必须是同一份数。这里用聚合结果自证：
  // 序列求和 == totals 的字段。
  const now = Date.now();
  const range = resolveRange({ preset: "today" });
  const records = [
    record(now - 5 * HOUR, { inputTokens: 100, outputTokens: 50, durationMs: 1000 }),
    record(now - 3 * HOUR, { inputTokens: 200, outputTokens: 60, durationMs: 2000 }),
    record(now - 1 * HOUR, { inputTokens: 300, outputTokens: 70, durationMs: 3000 }),
  ];
  const result = aggregate(records, range);
  const sum = (values) => values.reduce((total, value) => total + value, 0);

  assert.equal(sum(result.series.series.requests), result.totals.requests);
  assert.equal(sum(result.series.series.inputTokens), result.totals.inputTokens);
  assert.equal(sum(result.series.series.outputTokens), result.totals.outputTokens);
  assert.equal(sum(result.series.series.durationMs), result.totals.durationMs);
});

test("裁决序列与 outcomes 分账一致（allow/ask/reject/none）", () => {
  // 两条路径算的是同一件事，数字必须逐格相等；不等就说明 outcomeOf 的
  // 口径在两处被写成了两份（这类漂移不会报错，只会让图与表互相矛盾）。
  const now = Date.now();
  const range = resolveRange({ preset: "today" });
  const records = [
    record(now - 5 * HOUR, { point: "authorize", action: "allow" }),
    record(now - 4 * HOUR, { point: "authorize", action: "reject" }),
    record(now - 3 * HOUR, { point: "retrieval", action: "skip" }),
    record(now - 2 * HOUR, { point: "compaction", action: "" }),
  ];
  const result = aggregate(records, range);
  const sum = (values) => values.reduce((total, value) => total + value, 0);

  assert.equal(sum(result.series.series.allow), result.outcomes.allow);
  assert.equal(sum(result.series.series.ask), result.outcomes.ask);
  assert.equal(sum(result.series.series.reject), result.outcomes.reject);
  assert.equal(sum(result.series.series.none), result.outcomes.none);
});

test("记录落在区间外时进不了任何桶（宁少一点，不塞错桶）", () => {
  // 把昨天的一条记录塞进「今天」的序列，会让图上多出一个不合理的高点，
  // 而表格里没有它——图与表对不上比图少一个点更糟。
  const now = new Date(2026, 10, 10, 12).getTime();
  const range = {
    startMs: new Date(2026, 10, 10, 0).getTime(),
    endMs: new Date(2026, 10, 11, 0).getTime(),
  };
  const series = buildSeries(
    [record(new Date(2026, 10, 10, 6).getTime()), record(new Date(2026, 10, 9, 6).getTime())],
    range,
  );
  assert.equal(
    series.series.requests.reduce((total, value) => total + value, 0),
    1,
    "区间外的那条不该被算进来",
  );
});

test("异常长区间不会无限制生成桶（有上限兜底）", () => {
  // 自定义范围可以手填一个横跨十年的区间：按小时分桶会是 8 万多个键，
  // 服务端不该为此分配一个巨型数组。上限兜底后返回空序列，界面显示
  // 「没有数据」而不是把进程拖垮。
  const range = {
    startMs: new Date(2000, 0, 1).getTime(),
    endMs: new Date(2010, 0, 1).getTime(),
  };
  const keys = bucketKeys(range, "hour");
  assert.ok(keys.length <= 400, `桶数应被兜底限制，实际 ${keys.length}`);
});

test("序列随 /stats 响应下发，形状稳定", () => {
  // 前端按 `stats.series.buckets` 与 `stats.series.series[字段]` 消费，
  // 形状变了会让图静默空白（读 undefined 不报错）。
  const result = aggregate([record(Date.now() - HOUR)], resolveRange({ preset: "today" }));
  assert.ok(result.series !== undefined, "响应里必须有 series");
  assert.equal(typeof result.series.bucket, "string");
  assert.ok(Array.isArray(result.series.buckets));
  for (const field of ["requests", "inputTokens", "outputTokens", "durationMs", "allow", "ask", "reject", "none"]) {
    assert.ok(Array.isArray(result.series.series[field]), `series.${field} 必须是数组`);
    assert.equal(
      result.series.series[field].length,
      result.series.buckets.length,
      `series.${field} 必须与 buckets 等长`,
    );
  }
  assert.equal(result.series.total, result.series.buckets.length);
});
