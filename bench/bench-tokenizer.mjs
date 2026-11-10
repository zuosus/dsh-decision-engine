#!/usr/bin/env node
/**
 * tokenizer 基准：tokenProfile / estimateTextTokens / estimateRequestTokens / scaleTokensByChars。
 *
 * 用法：
 *   node bench/bench-tokenizer.mjs [treeRoot] [--json=out.json]
 *   node bench/bench-tokenizer.mjs /tmp/de-baseline   # 基线
 *   node bench/bench-tokenizer.mjs                    # 当前工作树
 *
 * 已知热点（task-3 点名）：lib/tokenizer.js 里 `source.match(CJK_PATTERN)?.length`
 * 为了「数一个数」而分配一个装着**每一个** CJK 字符的数组。这个用例就是要让
 * 那个分配在 B/op 那一列里现形。
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { bench, parseArgs, printTable, emit, sink } from "./lib/harness.mjs";
import { makeStateText, makeStateObject } from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), import.meta.url);
const tok = await import(pathToFileURL(join(args.tree, "lib/tokenizer.js")).href);

const SIZES = [
  ["1KB", 1024],
  ["64KB", 65536],
  ["512KB", 524288],
];
const FLAVORS = ["ascii", "cjk", "mixed"];
const texts = new Map();
for (const [label, bytes] of SIZES) {
  for (const flavor of FLAVORS) texts.set(`${label}/${flavor}`, makeStateText(bytes, flavor, 1234));
}

const rows = [];
const itersFor = (bytes) => (bytes >= 524288 ? 60 : bytes >= 65536 ? 400 : 4000);

for (const [label, bytes] of SIZES) {
  for (const flavor of FLAVORS) {
    const text = texts.get(`${label}/${flavor}`);
    rows.push(bench(`tokenProfile ${label}/${flavor}`, () => sink.n += tok.tokenProfile(text).cjk, {
      iterations: itersFor(bytes),
      rounds: 5,
      warmup: 2,
    }));
    rows.push(bench(`estimateRequestTokens ${label}/${flavor}`, () => sink.n += tok.estimateRequestTokens(text), {
      iterations: itersFor(bytes),
      rounds: 5,
      warmup: 2,
    }));
    rows.push(bench(`estimateTextTokens ${label}/${flavor}`, () => sink.n += tok.estimateTextTokens(text), {
      iterations: itersFor(bytes),
      rounds: 5,
      warmup: 2,
    }));
  }
}

// 端到端：engine 实际会做的事——把 state 对象序列化再估算。
const stateObj = makeStateObject(65536, "mixed", 1234);
rows.push(bench("JSON.stringify(state)+estimate 64KB/mixed", () => {
  sink.n += tok.estimateRequestTokens(JSON.stringify(stateObj));
}, { iterations: 300, rounds: 5, warmup: 2 }));

// 小输入的高频调用：决策路径上其实多为短文本（args_preview 512 字符）。
const short = makeStateText(512, "mixed", 99);
rows.push(bench("estimateRequestTokens 512B(short args)", () => sink.n += tok.estimateRequestTokens(short), {
  iterations: 20000, rounds: 5, warmup: 3,
}));
const emptyish = "";
rows.push(bench("estimateRequestTokens empty", () => sink.n += tok.estimateRequestTokens(emptyish), {
  iterations: 200000, rounds: 5, warmup: 3,
}));

rows.push(bench("scaleTokensByChars", () => sink.n += tok.scaleTokensByChars(1200, 4000, 9000), {
  iterations: 200000, rounds: 5, warmup: 3,
}));

printTable(`tokenizer @ ${args.tree}`, rows);

// 语义自检：口径变了就必须在报告里显式标出来（task-3 被要求保持系数语义）。
const semantic = {
  cjkRatio: tok.estimateRequestTokens("中文中文中文") ,
  asciiRatio: tok.estimateRequestTokens("abc abc abc abc abc abc abc abc"),
  empty: tok.estimateRequestTokens(""),
  overhead: tok.REQUEST_OVERHEAD_TOKENS,
  surrogate: tok.tokenProfile("\u{1F600}\u{1F600}\u{1F600}").chars,
};
console.log("\n语义指纹（baseline 与 after 必须逐字段相同）:", JSON.stringify(semantic));

await emit(args, { meta: { suite: "tokenizer", tree: args.tree }, semantic, rows });
