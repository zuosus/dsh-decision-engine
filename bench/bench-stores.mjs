#!/usr/bin/env node
/**
 * 存储层基准：DecisionStore / StatsStore 的 JSONL 读写路径。
 *
 * 用法：node bench/bench-stores.mjs [treeRoot] [--json=out.json]
 *
 * 覆盖：
 *   - readTailLines(20k 行文件)：反向分块读（界面「决策历史」的主路径）
 *   - DecisionStore.readForSession：倒扫 + JSON.parse 每行 + 过滤 + 排序 + id 去重
 *   - StatsStore.read()：整文件 readFile + split + 逐行 JSON.parse
 *   - maskSecrets：7 个全局正则过一遍整行
 *   - truncateContent / buildDecisionRecord：写盘前的裁剪（含 JSON round-trip 深拷贝）
 *   - record()+flush() 队列落盘
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { bench, benchAsyncOnce, parseArgs, printTable, emit, sink } from "./lib/harness.mjs";
import { makeDecisionLines, makeStatsRecords, writeJsonl } from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), import.meta.url);
const dsMod = await import(pathToFileURL(join(args.tree, "lib/decision-store.js")).href);
const ssMod = await import(pathToFileURL(join(args.tree, "lib/stats-store.js")).href);
const stMod = await import(pathToFileURL(join(args.tree, "lib/stats.js")).href);

const dir = await mkdtemp(join(tmpdir(), "de-bench-stores-"));
const lines = makeDecisionLines(20000);
const bigPath = await writeJsonl(dir, "decisions.jsonl", lines);
const rotatedPath = join(dir, "decisions.jsonl.1");
await writeJsonl(dir, "decisions.jsonl.1", []);
const statsPath = await writeJsonl(dir, "stats.jsonl", makeStatsRecords(20000).map((r) => JSON.stringify(r)));
console.log(`fixture dir: ${dir}\n  decisions.jsonl 20k lines = ${(lines.reduce((a, b) => a + b.length + 1, 0) / 1e6).toFixed(2)} MB`);

const rows = [];

// --- readTailLines：界面默认 scanLines=4000 ---
rows.push(await benchAsyncOnce("readTailLines(20k file, 4000 lines)", () => dsMod.readTailLines(bigPath, 4000), { rounds: 5 }));
rows.push(await benchAsyncOnce("readTailLines(20k file, 200 lines)", () => dsMod.readTailLines(bigPath, 200), { rounds: 5 }));
rows.push(await benchAsyncOnce("readTailLines(20k file, all 20000)", () => dsMod.readTailLines(bigPath, 20000), { rounds: 5 }));
rows.push(await benchAsyncOnce("readTailLines(small chunk 4KB, 4000)", () => dsMod.readTailLines(bigPath, 4000, 4096), { rounds: 5 }));

// --- DecisionStore.readForSession（含 JSON.parse × N + sort + 去重）---
const store = new dsMod.DecisionStore({ dir, getEnabled: () => true });
rows.push(await benchAsyncOnce("readForSession(target, limit 200, scan 4000)", () => store.readForSession("sess-target", { limit: 200 }), { rounds: 5 }));
rows.push(await benchAsyncOnce("readForSession(missing, limit 200)", () => store.readForSession("sess-nope", { limit: 200 }), { rounds: 5 }));
rows.push(await benchAsyncOnce("readForSession(limit 500, scan 20000)", () => store.readForSession("sess-target", { limit: 500, scanLines: 20000 }), { rounds: 5 }));

// --- StatsStore.read：整文件读 + split + parse ---
const statsStore = new ssMod.StatsStore({ dir, getEnabled: () => true });
rows.push(await benchAsyncOnce("StatsStore.read() 20k lines", () => statsStore.read(), { rounds: 5 }));

// --- 纯 CPU 组件 ---
const oneLine = lines[0];
const longLine = JSON.stringify({ ...JSON.parse(lines[0]), content: { state: { args_preview: "x".repeat(4000) } } });
rows.push(bench("maskSecrets(short line)", () => sink.s += dsMod.maskSecrets(oneLine).length, {
  iterations: 50000, rounds: 5, warmup: 3,
}));
rows.push(bench("maskSecrets(4KB line)", () => sink.s += dsMod.maskSecrets(longLine).length, {
  iterations: 5000, rounds: 5, warmup: 3,
}));
rows.push(bench("JSON.parse(one line)", () => sink.o = JSON.parse(oneLine), {
  iterations: 50000, rounds: 5, warmup: 3,
}));

// --- truncateContent：内部 jsonClone = JSON.parse(JSON.stringify()) ---
const content = JSON.parse(lines[0]).content;
rows.push(bench("truncateContent(under limit)", () => sink.o = dsMod.truncateContent(content, 4000), {
  iterations: 20000, rounds: 5, warmup: 3,
}));
const bigContent = { state: { args_preview: "y".repeat(50000), recent: [] }, questions: ["q"], answers: { a: 1 } };
rows.push(bench("truncateContent(needs truncation, 50KB)", () => sink.o = dsMod.truncateContent(bigContent, 4000), {
  iterations: 200, rounds: 5, warmup: 2,
}));

// --- buildDecisionRecord ---
rows.push(bench("buildDecisionRecord(full)", () => sink.o = dsMod.buildDecisionRecord({
  ts: "2026-11-09T12:00:00.000Z", sessionId: "sess-target", point: "tool_authorize",
  tool: "bash", action: "allow", mode: "observe", risk: 1, latencyMs: 120,
  content, requestTokens: 1200, responseTokens: 40,
}), { iterations: 10000, rounds: 5, warmup: 3 }));

// --- record() 入队成本（决策路径上的真实开销）---
const writeStore = new dsMod.DecisionStore({ dir: join(dir, "w1"), getEnabled: () => true });
const rec = dsMod.buildDecisionRecord({ ts: "2026-11-09T12:00:00.000Z", sessionId: "s", point: "p", content, action: "allow" });
rows.push(bench("store.record(enqueue only)", () => sink.n += writeStore.record(rec) ? 1 : 0, {
  iterations: 20000, rounds: 5, warmup: 3,
}));
await writeStore.flush();

const statsRecs = makeStatsRecords(500);
const statsWrite = new ssMod.StatsStore({ dir: join(dir, "w2"), getEnabled: () => true });
rows.push(bench("statsStore.record(enqueue only)", () => sink.n += statsWrite.record(statsRecs[0]) ? 1 : 0, {
  iterations: 20000, rounds: 5, warmup: 3,
}));
await statsWrite.flush();

printTable(`stores @ ${args.tree}`, rows);

const semantic = {
  tailCount: (await dsMod.readTailLines(bigPath, 4000)).length,
  tailFirstLineHead: (await dsMod.readTailLines(bigPath, 4000))[0].slice(0, 60),
  sessionTotal: (await store.readForSession("sess-target", { limit: 200 })).total,
  sessionScanned: (await store.readForSession("sess-target", { limit: 200 })).scanned,
  sessionTruncated: (await store.readForSession("sess-target", { limit: 200 })).truncated,
  idsUnique: new Set((await store.readForSession("sess-target", { limit: 500, scanLines: 20000 })).entries.map((e) => e.id)).size,
  maskSample: dsMod.maskSecrets('{"apiKey": "sk-abcdefghijklmnop", "x": 1, "t":"ghp_abcdefghijklmnopqrstuv"}'),
  truncateSample: (() => { const r = dsMod.truncateContent(bigContent, 4000); return [r.capture, r.note, JSON.stringify(r.content).length]; })(),
  statsReadLen: (await statsStore.read()).length,
};
console.log("\n语义指纹:", JSON.stringify(semantic));

await emit(args, { meta: { suite: "stores", tree: args.tree }, semantic, rows });
await rm(dir, { recursive: true, force: true });
