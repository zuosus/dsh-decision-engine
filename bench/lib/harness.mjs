/**
 * 基准测试计时内核（零依赖）。
 *
 * 方法论（写死在这里，避免每个脚本各写一套导致口径不一致）：
 *
 *   1. 预热：先跑 warmup 次，让 JIT 完成分层编译，否则第一轮永远最慢。
 *   2. 多轮取**中位数**：单轮受系统噪声影响极大（这台机器上有 5 个 agent
 *      同时在跑测试），中位数比平均值稳健。
 *   3. `process.hrtime.bigint()` 计时，纳秒精度。
 *   4. 分配量：有 `--expose-gc` 时先强制 GC，再测整批操作的 heapUsed 增量，
 *      除以次数得到 bytes/op（粗口径，只用于比较，不当绝对值用）。
 *   5. 反优化保护：每次测量都跑一个同样次数的空循环做基线，从耗时里减不
 *      掉的部分就不减（保持简单），但把 sink 变量写回全局，防止 DCE 把
 *      被测代码整个消掉——这是 micro-benchmark 最常见的假胜利来源。
 *
 * @module bench/lib/harness
 */

/** 防止死代码消除：所有被测函数的返回值都累进这个对象。 */
export const sink = { n: 0, s: "", o: null };

/** 把一批结果打成统一的 JSON 载荷。 */
export function makePayload(meta, groups) {
  return { meta, groups };
}

/** mulberry32：小而确定的 PRNG。固定种子 ⇒ baseline 与 after 生成**完全相同**的语料。 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 中位数（输入会被复制再排序，不改原数组）。 */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 分位数（用于给多轮结果做 p50/p90）。 */
export function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

function heapUsedBytes() {
  if (typeof globalThis.gc === "function") globalThis.gc();
  return process.memoryUsage().heapUsed;
}

/**
 * 测量一个函数。
 *
 * @param name - 用例名（表格里显示）。
 * @param fn - 被测函数；参数里的 i 是迭代序号，用于「每次换一条语料」这类用例。
 * @param options.iterations - 每轮迭代次数。
 * @param options.rounds - 测量轮数（取中位数）。
 * @param options.warmup - 预热轮数（每轮同样 iterations 次）。
 * @param options.measureAlloc - 是否测分配量。
 * @returns 结果行。
 */
export function bench(name, fn, options = {}) {
  const iterations = Number.isFinite(options.iterations) ? options.iterations : 1000;
  const rounds = Number.isFinite(options.rounds) ? options.rounds : 5;
  const warmup = Number.isFinite(options.warmup) ? options.warmup : 1;

  for (let r = 0; r < warmup; r += 1) {
    for (let i = 0; i < iterations; i += 1) fn(i);
  }

  const nsPerRound = [];
  for (let r = 0; r < rounds; r += 1) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) fn(i);
    const t1 = process.hrtime.bigint();
    nsPerRound.push(Number(t1 - t0));
  }

  const medianNs = median(nsPerRound);
  const nsPerOp = medianNs / iterations;

  let bytesPerOp = null;
  if (options.measureAlloc !== false) {
    // 单独一轮，前面强制 GC，测整批 heapUsed 增量。
    const before = heapUsedBytes();
    for (let i = 0; i < iterations; i += 1) fn(i);
    const after = process.memoryUsage().heapUsed;
    const delta = Math.max(0, after - before);
    bytesPerOp = delta / iterations;
  }

  return {
    name,
    iterations,
    rounds,
    nsPerOp,
    msPerOp: nsPerOp / 1e6,
    opsPerSec: nsPerOp > 0 ? 1e9 / nsPerOp : Infinity,
    p90NsPerOp: percentile(nsPerRound, 0.9) / iterations,
    minNsPerOp: Math.min(...nsPerRound) / iterations,
    spreadPct: medianNs > 0 ? ((Math.max(...nsPerRound) - Math.min(...nsPerRound)) / medianNs) * 100 : 0,
    bytesPerOp,
  };
}

/**
 * 测量一次性的慢操作（如「加载 20k 行 JSONL」）：没有 iterations 概念，
 * 直接多轮取中位数，单位 ms。
 *
 * @param name - 用例名。
 * @param fn - 被测异步函数。
 * @param options.rounds - 轮数。
 */
export async function benchAsyncOnce(name, fn, options = {}) {
  const rounds = Number.isFinite(options.rounds) ? options.rounds : 3;
  const warmup = Number.isFinite(options.warmup) ? options.warmup : 1;
  for (let r = 0; r < warmup; r += 1) await fn();

  const msRuns = [];
  let lastResult = null;
  for (let r = 0; r < rounds; r += 1) {
    const t0 = process.hrtime.bigint();
    lastResult = await fn();
    const t1 = process.hrtime.bigint();
    msRuns.push(Number(t1 - t0) / 1e6);
  }
  sink.o = lastResult;
  const medianMs = median(msRuns);
  return {
    name,
    iterations: 1,
    rounds,
    msPerOp: medianMs,
    nsPerOp: medianMs * 1e6,
    opsPerSec: medianMs > 0 ? 1000 / medianMs : Infinity,
    p90NsPerOp: percentile(msRuns, 0.9) * 1e6,
    minNsPerOp: Math.min(...msRuns) * 1e6,
    spreadPct: medianMs > 0 ? ((Math.max(...msRuns) - Math.min(...msRuns)) / medianMs) * 100 : 0,
    bytesPerOp: null,
    unit: "ms",
  };
}

/**
 * 解析 `--tree=` / 位置参数 / `--json=` / `--filter=`。
 *
 * 用法：`node bench/bench-tokenizer.mjs [treeRoot] [--json=out.json]`
 * treeRoot 缺省 = 仓库根（bench/ 的上一级）。这样
 * 「baseline vs after」就是同一条命令换个 root 参数。
 */
export function parseArgs(argv, scriptDir) {
  const args = { tree: null, json: null, filter: null, rest: [] };
  for (const token of argv) {
    if (token.startsWith("--tree=")) args.tree = token.slice(7);
    else if (token.startsWith("--json=")) args.json = token.slice(7);
    else if (token.startsWith("--filter=")) args.filter = token.slice(9);
    else if (!token.startsWith("--")) args.rest.push(token);
  }
  if (args.tree === null) args.tree = args.rest[0] ?? new URL("..", scriptDir).pathname;
  return args;
}

/** 打印结果表（人类可读）。 */
export function printTable(suite, rows) {
  const width = Math.max(24, ...rows.map((r) => r.name.length));
  console.log(`\n## ${suite}`);
  console.log(`${"case".padEnd(width)}  ${"ms/op".padStart(12)}  ${"ns/op".padStart(14)}  ${"ops/s".padStart(14)}  ${"B/op".padStart(12)}  spread`);
  for (const row of rows) {
    console.log(
      [
        row.name.padEnd(width),
        row.msPerOp.toFixed(row.msPerOp < 0.01 ? 6 : 4).padStart(12),
        Math.round(row.nsPerOp).toLocaleString("en-US").padStart(14),
        Math.round(row.opsPerSec).toLocaleString("en-US").padStart(14),
        row.bytesPerOp === null ? "n/a".padStart(12) : Math.round(row.bytesPerOp).toLocaleString("en-US").padStart(12),
        `${row.spreadPct.toFixed(1)}%`,
      ].join("  "),
    );
  }
}

/** 写出 JSON 结果（供 compare.mjs 汇总）。 */
export async function emit(args, payload) {
  if (args.json) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(args.json), { recursive: true });
    await writeFile(args.json, JSON.stringify(payload, null, 2));
  }
}
