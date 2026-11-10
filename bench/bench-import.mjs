#!/usr/bin/env node
/**
 * 模块加载成本基准：lib/index.js / lib/client.js 的导入耗时与体积。
 *
 * 用法：node bench/bench-import.mjs [treeRoot] [--json=out.json]
 *
 * 三种口径（缺一不可）：
 *   1. **子进程冷启动到 import 完成**（真实插件加载路径；每次全新进程）
 *   2. **纯 parse+compile**（vm.Script 编译整份源码，不含执行）——这是
 *      client.js 这种浏览器 bundle 唯一能公平测的部分：它在 Node 里
 *      没有 window.__ModuleLoader__，无法执行，但下载/解析/编译的成本
 *      在浏览器里是真实存在的。
 *   3. **体积**（字节 + gzip，gzip 接近实际传输量）
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { execFileSync } from "node:child_process";
import vm from "node:vm";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import { parseArgs, median, emit, percentile } from "./lib/harness.mjs";

const { readFileSync } = await import("node:fs");
const args = parseArgs(process.argv.slice(2), import.meta.url);
const RUNS = 9;

function timeSubprocess(file) {
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const code = `const t=process.hrtime.bigint();await import(${JSON.stringify(pathToFileURL(file).href)});const d=Number(process.hrtime.bigint()-t)/1e6;process.stdout.write(String(d));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    const n = Number(out.trim());
    if (Number.isFinite(n)) times.push(n);
  }
  return times;
}

function compileTimes(source, label) {
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    new vm.Script(source, { filename: label });
    times.push(performance.now() - t0);
  }
  return times;
}

const modules = [
  ["lib/index.js", true],
  ["lib/client.js", false],
  ["lib/stats.js", true],
  ["lib/providers.js", true],
  ["lib/decision-store.js", true],
  ["lib/stats-store.js", true],
  ["lib/engine.js", true],
  ["lib/tokenizer.js", true],
  ["lib/decision-cache.js", true],
];

const rows = [];
console.log(`\n## module load @ ${args.tree}  (${RUNS} runs each, median)`);
console.log(`${"module".padEnd(26)} ${"bytes".padStart(10)} ${"gzip".padStart(9)} ${"lines".padStart(7)}  ${"compile ms".padStart(11)}  ${"import ms".padStart(10)}  spread`);
for (const [rel, importable] of modules) {
  const path = join(args.tree, rel);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.log(`${rel.padEnd(26)}  (missing)`);
    continue;
  }
  const bytes = Buffer.byteLength(source, "utf8");
  const gz = zlib.gzipSync(Buffer.from(source, "utf8")).length;
  const lineCount = source.split("\n").length;
  const ct = compileTimes(source, rel);
  const ctMed = median(ct);
  let im = null;
  let imMed = null;
  if (importable) {
    im = timeSubprocess(path);
    imMed = median(im);
  }
  rows.push({
    name: rel,
    bytes,
    gzipBytes: gz,
    lines: lineCount,
    compileMs: ctMed,
    compileMin: Math.min(...ct),
    compileMax: Math.max(...ct),
    importMs: imMed,
    importSpreadPct: im ? ((Math.max(...im) - Math.min(...im)) / (imMed || 1)) * 100 : 0,
  });
  console.log(
    `${rel.padEnd(26)} ${bytes.toLocaleString("en-US").padStart(10)} ${gz.toLocaleString("en-US").padStart(9)} ${lineCount.toString().padStart(7)}  ${ctMed.toFixed(2).padStart(11)}  ${(imMed === null ? "n/a" : imMed.toFixed(2)).padStart(10)}  ${im ? `${((Math.max(...im) - Math.min(...im)) / (imMed || 1) * 100).toFixed(0)}%` : ""}`,
  );
}

// 依赖子树：index.js 会把整条运行时依赖链一起拉起来，这个数才是「插件加载」的真实代价。
const subDepPaths = ["lib/engine.js", "lib/providers.js", "lib/stats.js", "lib/stats-store.js", "lib/decision-store.js", "lib/points/spec.js"];
const t0 = performance.now();
for (const rel of subDepPaths) {
  await import(pathToFileURL(join(args.tree, rel)).href);
}
const inProcess = performance.now() - t0;
console.log(`\nin-process warm import of ${subDepPaths.length} runtime modules: ${inProcess.toFixed(2)} ms`);

const indexImportTimes = timeSubprocess(join(args.tree, "lib/index.js"));
console.log(`cold process import lib/index.js (+ full dep graph): median ${median(indexImportTimes).toFixed(2)} ms, p90 ${percentile(indexImportTimes, 0.9).toFixed(2)} ms`);

await emit(args, {
  meta: { suite: "import", tree: args.tree, runs: RUNS },
  modules: rows,
  inProcessWarmMs: inProcess,
  coldIndexImportMs: median(indexImportTimes),
  coldIndexImportRaw: indexImportTimes,
});
