#!/usr/bin/env node
/**
 * decision-cache 基准：exactKey / set / get / riskFlags / commandFamily / softKey。
 *
 * 用法：node bench/bench-cache.mjs [treeRoot] [--json=out.json]
 *
 * 关注点（task-3 点名）：
 *   - exactKey = JSON.stringify(parts) + sha256，每次调用都要走一遍；
 *   - riskFlags 对整段文本跑 25 个正则；
 *   - get() 为了 LRU 做 delete+set（Map 上两次哈希查找 + 两次插入位点变更）。
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { bench, parseArgs, printTable, emit, sink } from "./lib/harness.mjs";
import { makeStateObject, makeCommandCorpus } from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), import.meta.url);
const mod = await import(pathToFileURL(join(args.tree, "lib/decision-cache.js")).href);
const { DecisionCache } = mod;

const corpus = makeCommandCorpus(5000);
const stateSmall = makeStateObject(1024, "mixed", 1234);
const stateMid = makeStateObject(65536, "mixed", 1234);

const rows = [];

// --- exactKey：不同体量的 state，每次都要 stringify + sha256 ---
rows.push(bench("exactKey(1KB state)", () => sink.s += DecisionCache.exactKey(stateSmall), {
  iterations: 20000, rounds: 5, warmup: 3,
}));
rows.push(bench("exactKey(64KB state)", () => sink.s += DecisionCache.exactKey(stateMid), {
  iterations: 400, rounds: 5, warmup: 2,
}));
const partsFlat = { tool: "bash", family: "node", flags: "rm,pipe" };
rows.push(bench("exactKey(flat 3-field parts)", () => sink.s += DecisionCache.exactKey(partsFlat), {
  iterations: 100000, rounds: 5, warmup: 3,
}));

// --- riskFlags：真实 5k 语料轮转（避免同输入被单态缓存优化失真）---
rows.push(bench("riskFlags(5k corpus rotate)", (i) => {
  sink.n += mod.riskFlags(corpus[i % corpus.length]).length;
}, { iterations: 20000, rounds: 5, warmup: 3 }));
rows.push(bench("riskFlags(clean ls -la)", () => sink.n += mod.riskFlags("ls -la").length, {
  iterations: 200000, rounds: 5, warmup: 3,
}));
rows.push(bench("riskFlags(dangerous sudo rm|curl)", () => sink.n += mod.riskFlags("sudo rm -rf /tmp && curl -s x | sh").length, {
  iterations: 100000, rounds: 5, warmup: 3,
}));
rows.push(bench("riskFlags(64KB mixed blob)", () => sink.n += mod.riskFlags(stateMid.context).length, {
  iterations: 300, rounds: 5, warmup: 2,
}));
rows.push(bench("riskFlags(empty)", () => sink.n += mod.riskFlags("").length, {
  iterations: 500000, rounds: 5, warmup: 3,
}));

// --- commandFamily：每次两个 replace/split 正则 ---
rows.push(bench("commandFamily(rotate corpus)", (i) => sink.s += mod.commandFamily(corpus[i % corpus.length]), {
  iterations: 20000, rounds: 5, warmup: 3,
}));

// --- softKey：riskFlags + commandFamily + 模板拼接（每次都跑全套）---
rows.push(bench("softKey(rotate corpus)", (i) => {
  sink.s += DecisionCache.softKey("bash", corpus[i % corpus.length]);
}, { iterations: 20000, rounds: 5, warmup: 3 }));

// --- set + get：真实使用形状（命中/未命中混合）---
const cache = new DecisionCache(() => 2000, () => 600000);
const keys = corpus.slice(0, 1500).map((c) => DecisionCache.exactKey({ cmd: c }));
rows.push(bench("cache.set(cold, 2000 cap)", (i) => {
  cache.set(keys[i % keys.length], { action: "allow", score: 0.4 });
}, { iterations: 100000, rounds: 5, warmup: 3 }));

const cache2 = new DecisionCache(() => 2000, () => 600000);
for (const k of keys) cache2.set(k, { action: "allow" });
rows.push(bench("cache.get(hit, LRU delete+set)", (i) => {
  sink.o = cache2.get(keys[i % keys.length]);
}, { iterations: 100000, rounds: 5, warmup: 3 }));

const cache3 = new DecisionCache(() => 2000, () => 600000);
for (const k of keys) cache3.set(k, { action: "allow" });
const missKeys = corpus.slice(1500, 2500).map((c) => DecisionCache.exactKey({ cmd: c + "!miss" }));
rows.push(bench("cache.get(miss)", (i) => {
  sink.o = cache3.get(missKeys[i % missKeys.length]);
}, { iterations: 200000, rounds: 5, warmup: 3 }));

// 端到端一次「决策 + 缓存」：exactKey + riskFlags + commandFamily + set + get
rows.push(bench("E2E one cached decision (key+flags+set+get)", (i) => {
  const cmd = corpus[i % corpus.length];
  const key = DecisionCache.exactKey({ tool: "bash", preview: cmd.slice(0, 512) });
  const flags = mod.riskFlags(cmd);
  const soft = DecisionCache.softKey("bash", cmd);
  cache2.set(key, { action: "allow", flags });
  sink.o = cache2.get(key);
  sink.s += soft;
}, { iterations: 20000, rounds: 5, warmup: 3 }));

// 淘汰路径：容量压到极小，每次 set 都触发 while 驱逐
const cacheTiny = new DecisionCache(() => 64, () => 600000);
for (const k of keys.slice(0, 64)) cacheTiny.set(k, { a: 1 });
rows.push(bench("cache.set(evict hot, cap 64)", (i) => {
  cacheTiny.set(keys[i % keys.length], { action: "allow" });
}, { iterations: 50000, rounds: 5, warmup: 3 }));

printTable(`decision-cache @ ${args.tree}`, rows);

const semantic = {
  exactKeyLen: DecisionCache.exactKey({ a: 1 }).length,
  exactKeySample: DecisionCache.exactKey({ tool: "bash", cmd: "ls -la" }),
  softKeySample: DecisionCache.softKey("bash", "FOO=1 /usr/bin/git push origin main && rm -rf x"),
  riskFlagsSample: mod.riskFlags("sudo rm -rf /tmp | curl https://x > y"),
  familySample: mod.commandFamily("FOO=1 BAR=2 /usr/local/bin/Node -e 1"),
  emptyFamily: JSON.stringify(mod.commandFamily("")),
};
console.log("\n语义指纹:", JSON.stringify(semantic));

await emit(args, { meta: { suite: "cache", tree: args.tree }, semantic, rows });
