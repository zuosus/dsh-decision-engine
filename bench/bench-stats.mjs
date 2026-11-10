#!/usr/bin/env node
/**
 * stats.aggregate 基准（20k 记录）+ 周边：normalizeRecord/isInRange/resolveRange/sortRows。
 *
 * 用法：node bench/bench-stats.mjs [treeRoot] [--json=out.json]
 *
 * 关注点（task-4 点名）：aggregate 单趟扫描里对**每条记录**做 normalizeRecord
 * 与 isInRange（后者内部又 normalizeRecord 一次 ⇒ 每条记录规范化两次），
 * 并为每个新键建 bucket；还有「同一数组排好几次序」。这里的 B/op 列就是给
 * 这些重复分配现形的。
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { bench, parseArgs, printTable, emit, sink } from "./lib/harness.mjs";
import { makeStatsRecords } from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), import.meta.url);
const st = await import(pathToFileURL(join(args.tree, "lib/stats.js")).href);

const records = makeStatsRecords(20000);
const now = new Date("2026-11-09T12:00:00");
const rangeAll = st.resolveRange({ preset: "year" }, now);
const rangeToday = st.resolveRange({ preset: "today" }, now);
const custom = { preset: "custom", start: "2026-01-01T00:00", end: "2026-12-31T23:59" };

const rows = [];
rows.push(bench("aggregate(20k, year range=all)", () => sink.o = st.aggregate(records, rangeAll), {
  iterations: 40, rounds: 7, warmup: 3,
}));
rows.push(bench("aggregate(20k, today range=few)", () => sink.o = st.aggregate(records, rangeToday), {
  iterations: 40, rounds: 7, warmup: 3,
}));
rows.push(bench("aggregate(20k, custom range)", () => {
  sink.o = st.aggregate(records, st.resolveRange(custom, now));
}, { iterations: 30, rounds: 7, warmup: 2 }));
rows.push(bench("aggregate(5k slice)", () => {
  sink.o = st.aggregate(records.slice(0, 5000), rangeAll);
}, { iterations: 150, rounds: 7, warmup: 3 }));

// 组件成本拆解（判断 aggregate 的钱花在哪）
rows.push(bench("resolveRange(year)", () => sink.o = st.resolveRange({ preset: "year" }, now), {
  iterations: 50000, rounds: 5, warmup: 3,
}));
rows.push(bench("resolveRange(custom, 解析两个时间串)", () => sink.o = st.resolveRange(custom, now), {
  iterations: 20000, rounds: 5, warmup: 3,
}));
rows.push(bench("isInRange(rotate 20k)", (i) => sink.n += st.isInRange(records[i % records.length], rangeAll) ? 1 : 0, {
  iterations: 200000, rounds: 5, warmup: 3,
}));
rows.push(bench("buildRecord(fresh)", () => sink.o = st.buildRecord({
  provider: "bamboonode", model: "kev-4b", point: "tool_authorize", mode: "observe",
  inputTokens: 1200, outputTokens: 60, durationMs: 240, inputSource: "api", outputSource: "api",
}), { iterations: 100000, rounds: 5, warmup: 3 }));
rows.push(bench("normalizeMode(rotate)", (i) => sink.s += st.normalizeMode(["observe", "enforce", "off", null, 7][i % 5]), {
  iterations: 200000, rounds: 5, warmup: 3,
}));
const agg = st.aggregate(records, rangeAll);
rows.push(bench("sortRows(rows,'savedTokens',desc)", () => {
  sink.n += st.sortRows(agg.rows, "savedTokens", "desc").length;
}, { iterations: 2000, rounds: 5, warmup: 2 }));
rows.push(bench("JSON.stringify(aggregate result)", () => sink.n += JSON.stringify(agg).length, {
  iterations: 2000, rounds: 5, warmup: 2,
}));

printTable(`stats @ ${args.tree}`, rows);

const semantic = {
  totals: agg.totals,
  rowCount: agg.rows.length,
  byProvider: Object.fromEntries([...(agg.byProvider instanceof Map ? agg.byProvider : Object.entries(agg.byProvider))].slice(0, 2)),
  firstRow: agg.rows[0],
  keys: Object.keys(agg).sort(),
  modeCounts: agg.modeCounts,
  otherVerdicts: agg.otherVerdicts,
};
console.log("\n语义指纹:", JSON.stringify(semantic));

await emit(args, { meta: { suite: "stats", tree: args.tree }, semantic, rows });
