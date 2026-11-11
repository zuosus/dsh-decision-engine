/**
 * 走势序列（`lib/stats.js` 的 pickBucket / bucketKey / bucketKeys / buildSeries）。
 *
 * 为什么这些要单独测：走势图是「数字的第二种读法」，它一旦算错，错的
 * 方式**看起来仍然合理**——气泡少一个、桶错位一小时、空桶被跳过导致
 * 折线跨过一整天，画出来都是「一条线」，只有对着表格逐点核对才发现不对。
 * 而那种核对没人会天天做。
 *
 * 这里盯住五件事：
 *   1. 分桶粒度随区间长度收敛（太长会挤成噪声，太短只有一个点）；
 *   2. 键按**本地**时区切（按 UTC 切会让东八区的「今天」错位八小时）；
 *   3. 空桶补 0（「没请求」必须在图上表现为掉到零，而不是被折线忽略）；
 *   4. 序列与既有分账**同源**（裁决三格之和必须等于 outcomes 的三格）；
 *   5. 未来段边界 `nowIndex`（区间的上界常在未来，「还没到」与「没请求」
 *      不能画成同一条实线；判定只看桶起点、严格大于 now）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregate,
  bucketKey,
  bucketKeys,
  bucketStartMs,
  buildSeries,
  futureStartIndex,
  pickBucket,
  resolveRange,
} from "../lib/stats.js";

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

// ---- nowIndex：未来段的起点（bucketStartMs / futureStartIndex） --------------------

/** 造一个「本地 2026-11-10 全天」的区间：小时粒度正好 24 个桶。 */
function todayAt20261110() {
  return {
    startMs: new Date(2026, 10, 10, 0, 0, 0, 0).getTime(),
    endMs: new Date(2026, 10, 11, 0, 0, 0, 0).getTime(),
  };
}

test("bucketStartMs 与 bucketKey 互逆：起点不晚于原时刻，且解析回同一个桶", () => {
  // nowIndex 的判定只看桶起点。起点解析差一小时，虚线边界就错一格，
  // 而图上完全看不出来——所以互逆性必须逐粒度、逐边界时刻钉死。
  const samples = [
    new Date(2026, 10, 10, 3, 30).getTime(), // 普通时刻
    new Date(2026, 10, 10, 23, 59, 59, 999).getTime(), // 23 点的最后一毫秒
    new Date(2026, 10, 30, 12, 0).getTime(), // 11 月月末的正午
    new Date(2026, 11, 31, 23, 30).getTime(), // 跨年：12 月 31 日 23:30
    new Date(2027, 0, 1, 0, 0, 0, 5).getTime(), // 跨年：元旦 00:00 刚过
  ];
  for (const ts of samples) {
    for (const bucket of ["hour", "day", "month"]) {
      const key = bucketKey(ts, bucket);
      const start = bucketStartMs(key, bucket);
      assert.ok(Number.isFinite(start), `${key}（${bucket}）应能解析回起点`);
      assert.ok(start <= ts, `${key}（${bucket}）的起点必须不晚于原时刻`);
      assert.equal(bucketKey(start, bucket), key, `${key}（${bucket}）的起点必须落回同一个桶`);
    }
  }
});

test("bucketStartMs 逐字解析：本地零点，键形与粒度不符返回 NaN", () => {
  // 刻意不用 Date.parse：`Date.parse("2026-11-10")` 按 UTC 零点解释，
  // 东八区会晚 8 小时，日桶前 8 格会被误判成未来。起点必须是本地 00:00。
  assert.equal(bucketStartMs("2026-11-10T14", "hour"), new Date(2026, 10, 10, 14, 0, 0, 0).getTime());
  assert.equal(bucketStartMs("2026-11-10", "day"), new Date(2026, 10, 10, 0, 0, 0, 0).getTime());
  assert.equal(bucketStartMs("2026-11", "month"), new Date(2026, 10, 1, 0, 0, 0, 0).getTime());
  assert.equal(bucketStartMs("2026-12", "month"), new Date(2026, 11, 1, 0, 0, 0, 0).getTime());
  // 形状与粒度不符 = 生成端与解析端版本没对齐，宁可 NaN 走退化分支。
  for (const [key, bucket] of [
    ["乱码键", "day"],
    ["2026-11-10", "month"], // 日键配月粒度
    ["2026-11", "day"], // 月键配日粒度
    ["2026-11-10", "hour"], // 缺 T 段
    ["2026-11-10T14", "day"], // 多 T 段
    ["2026-13", "month"], // 月越界（不许悄悄滚进下一年）
    ["2026-02-31", "day"], // 不存在的日期（不许悄悄滚进 3 月）
    ["2026-11-10T24", "hour"], // 时越界
  ]) {
    assert.ok(Number.isNaN(bucketStartMs(key, bucket)), `${key}（${bucket}）应解析为 NaN`);
  }
  assert.ok(Number.isNaN(bucketStartMs(undefined, "day")));
});

test("nowIndex：小时粒度「今天」，进行中的 14 时桶算过去 → 未来段从 15 时起", () => {
  // 契约的招牌用例：now=14:37 时 14 时桶已经开始、可能已有真实数据，
  // 把它划进未来等于把图上最后一段真实折线画成虚线。
  const range = todayAt20261110();
  const out = buildSeries([], range, new Date(2026, 10, 10, 14, 37));
  assert.equal(out.bucket, "hour");
  assert.equal(out.buckets.length, 24);
  assert.equal(out.nowIndex, 15);
  // now 也接受毫秒数，结果必须一致（调用方传哪种都行）。
  assert.equal(buildSeries([], range, new Date(2026, 10, 10, 14, 37).getTime()).nowIndex, 15);
});

test("nowIndex：判定是严格大于——now 恰好等于桶起点时该桶已「开始」", () => {
  // 边界两侧各钉一毫秒：14:00:00.000 整刻 14 时桶已开始 → 未来从 15 时起；
  // 13:59:59.999 时 14 时桶还差一毫秒才开始 → 未来从 14 时起。
  const range = todayAt20261110();
  assert.equal(buildSeries([], range, new Date(2026, 10, 10, 14, 0, 0, 0)).nowIndex, 15);
  assert.equal(buildSeries([], range, new Date(2026, 10, 10, 13, 59, 59, 999)).nowIndex, 14);
});

test("nowIndex：整段都在过去 → nowIndex === buckets.length（没有未来段）", () => {
  // 自定义区间指向上个月：日粒度 31 个桶全在 now 之前。前端按
  // `nowIndex === buckets.length` 判定「不画虚线」。
  const now = new Date(2026, 10, 10, 12, 0);
  const range = {
    startMs: new Date(2026, 9, 1, 0, 0, 0, 0).getTime(), // 10 月 1 日
    endMs: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(), // 11 月 1 日
  };
  const out = buildSeries([], range, now);
  assert.equal(out.bucket, "day");
  assert.equal(out.buckets.length, 31);
  assert.equal(out.nowIndex, out.buckets.length);
});

test("nowIndex：整段都在未来 → nowIndex === 0", () => {
  // 自定义区间指向下个月：桶起点全部晚于 now，序列每一个桶都还没开始。
  const now = new Date(2026, 10, 10, 12, 0);
  const range = {
    startMs: new Date(2026, 11, 1, 0, 0, 0, 0).getTime(), // 12 月 1 日
    endMs: new Date(2027, 0, 1, 0, 0, 0, 0).getTime(), // 1 月 1 日
  };
  const out = buildSeries([], range, now);
  assert.equal(out.buckets.length, 31);
  assert.equal(out.nowIndex, 0);
});

test("nowIndex：天粒度、月末 23:00 → 当天桶算过去，虚线从次日开始", () => {
  // 10-31 23:00：10 月最后一天的桶正在进行（里面可能有数据），
  // 第一个还没开始的桶是 11-01，下标 31。
  const now = new Date(2026, 9, 31, 23, 0);
  const range = {
    startMs: new Date(2026, 9, 1, 0, 0, 0, 0).getTime(),
    endMs: new Date(2026, 11, 1, 0, 0, 0, 0).getTime(),
  };
  const out = buildSeries([], range, now);
  assert.equal(out.bucket, "day");
  assert.equal(out.buckets[30], "2026-10-31");
  assert.equal(out.buckets[31], "2026-11-01");
  assert.equal(out.nowIndex, 31);
});

test("nowIndex：月粒度跨年，12 月进行中 → 虚线从次年 1 月开始", () => {
  // 2026-12-31 23:59，跨年边界的前一分钟：12 月桶（下标 11）已开始，
  // 还没开始的第一个桶是 2027-01（下标 12）。年边界的键解析最容易出错，
  // 这里连桶键本身一起钉住。
  const now = new Date(2026, 11, 31, 23, 59, 59);
  const range = {
    startMs: new Date(2026, 0, 1, 0, 0, 0, 0).getTime(),
    endMs: new Date(2028, 0, 1, 0, 0, 0, 0).getTime(),
  };
  const out = buildSeries([], range, now);
  assert.equal(out.bucket, "month");
  assert.equal(out.buckets.length, 24);
  assert.equal(out.buckets[11], "2026-12");
  assert.equal(out.buckets[12], "2027-01");
  assert.equal(out.nowIndex, 12);
});

test("nowIndex 退化：空序列 / 不认识的键 / 坏 now → 不抛异常，按「没有未来段」", () => {
  // 实现上的取舍：遇到非法键返回 buckets.length 而不是出错位置——
  // 非法键之前的桶都已确认是过去（否则早已返回），之后的无法归类；
  // 把「说不清」画成「还没发生」会让前端凭空画出假虚线。
  const now = new Date(2026, 10, 10, 12, 0).getTime();
  assert.equal(futureStartIndex([], "hour", now), 0); // 空序列：0 === buckets.length
  assert.equal(futureStartIndex(["乱码键"], "hour", now), 1);
  assert.equal(
    futureStartIndex(["2026-11-10", "乱码键", "2026-11-12"], "day", new Date(2026, 10, 11, 0, 0).getTime()),
    3,
    "非法键之前的桶都是过去 → 整段放弃",
  );
  // 桶键与粒度不符同样按非法处理（month 粒度配了日键）。
  assert.equal(futureStartIndex(["2026-11-10"], "month", now), 1);
  // now 不是有限数字 → 没有可信的「现在」→ 视为无未来段。
  assert.equal(futureStartIndex(["2026-11-10", "2026-11-11"], "day", Number.NaN), 2);
  // 找到第一个未来桶就提前返回，后面的非法键根本不会被解析（也不会拖垮 O(n)）。
  assert.equal(
    futureStartIndex(["2026-11-10T13", "2026-11-10T14", "乱码键"], "hour", new Date(2026, 10, 10, 13, 30).getTime()),
    1,
  );
  // buildSeries 的 now 坏参数退回系统时钟，而不是让整个统计接口炸掉。
  const out = buildSeries([], todayAt20261110(), "不是时间");
  assert.equal(typeof out.nowIndex, "number");
  assert.ok(out.nowIndex >= 0 && out.nowIndex <= out.buckets.length);
  assert.equal(typeof buildSeries([], todayAt20261110(), null).nowIndex, "number");
});

test("nowIndex 与桶序列口径一致：futureStartIndex 直接算 == buildSeries 下发值", () => {
  // buildSeries 内部若换了粒度判定或时钟处理，这条会先炸——它防的是
  // 「辅助函数与响应字段各自漂移」这类两文件契约对不上的错。
  const now = new Date(2026, 10, 10, 14, 37);
  const range = todayAt20261110();
  const out = buildSeries([], range, now);
  assert.equal(out.nowIndex, futureStartIndex(out.buckets, out.bucket, now.getTime()));
});

test("nowIndex 随 aggregate 响应下发，未来段必然没有数据", () => {
  // 主入口回归：`stats.series.nowIndex` 必须是 [0, buckets.length] 内的数字；
  // 且起点晚于 now 的桶不可能有记录——未来段求和必须是 0。
  const range = resolveRange({ preset: "today" });
  const result = aggregate([record(Date.now() - 2 * HOUR)], range);
  const { nowIndex, buckets } = result.series;
  assert.equal(typeof nowIndex, "number");
  assert.ok(nowIndex >= 0 && nowIndex <= buckets.length, "nowIndex 必须落在合法下标内");
  for (const field of ["requests", "inputTokens", "outputTokens", "durationMs", "allow", "ask", "reject"]) {
    const futureSum = result.series.series[field].slice(nowIndex).reduce((total, value) => total + value, 0);
    assert.equal(futureSum, 0, `series.${field} 的未来段必须全为 0`);
  }
});
