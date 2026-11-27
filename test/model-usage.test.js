/**
 * 匿名统计里的 provider × model 上报（DEC-096）。
 *
 * 口径：上一完整自然日、按 provider×model 分开的决策次数；免费模型（server）
 * 与无法归因的 unknown 一律不进这份明细，总量 d 不受影响。
 *
 * 这个文件 TDD 先行：所有断言都是纯函数行为，不碰网络、不碰磁盘。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MODEL_PAIRS,
  buildModelUsagePayload,
  normalizeModelPairs,
} from "../lib/model-usage.js";

const rows = [
  { provider: "systemone", model: "jev-latest", requests: 10 },
  { provider: "siliconflow", model: "Qwen/Qwen2.5-7B", requests: 3 },
  { provider: "server", model: "free-model", requests: 99 },
  { provider: "unknown", model: "mystery", requests: 7 },
  { provider: "systemone", model: "", requests: 5 },
  { provider: "custom", model: "local-model", requests: 0 },
];

test("normalizeModelPairs 排除免费模型与无法归因的行", () => {
  const pairs = normalizeModelPairs(rows);
  assert.deepEqual(pairs, [
    ["systemone", "jev-latest", 10],
    ["siliconflow", "Qwen/Qwen2.5-7B", 3],
  ]);
});

test("normalizeModelPairs 按次数降序、同次数按名称排序，结果稳定", () => {
  const pairs = normalizeModelPairs([
    { provider: "b", model: "z", requests: 2 },
    { provider: "a", model: "y", requests: 2 },
    { provider: "a", model: "x", requests: 5 },
  ]);
  assert.deepEqual(pairs, [["a", "x", 5], ["a", "y", 2], ["b", "z", 2]]);
});

test("normalizeModelPairs 清洗名称、截断长度与条数，异常输入不抛错", () => {
  const many = Array.from({ length: MAX_MODEL_PAIRS + 5 }, (_, i) => ({
    provider: `p${i}`,
    model: `m${i}`,
    requests: i + 1,
  }));
  const pairs = normalizeModelPairs(many);
  assert.equal(pairs.length, MAX_MODEL_PAIRS);
  assert.deepEqual(pairs[0], ["p" + (MAX_MODEL_PAIRS + 4), "m" + (MAX_MODEL_PAIRS + 4), MAX_MODEL_PAIRS + 5]);

  const dirty = normalizeModelPairs([{
    provider: "  sys tem<one>  ",
    model: "Qwen/Qwen2.5-7B; rm -rf / # 中文",
    requests: 1e9,
  }]);
  assert.equal(dirty[0][0], "systemone");
  assert.equal(dirty[0][1].includes(" "), false);
  assert.equal(dirty[0][2], 100000);

  for (const bad of [null, undefined, 42, "x", {}, [null, 1, {}]]) {
    assert.deepEqual(normalizeModelPairs(bad), []);
  }
});

test("buildModelUsagePayload 只在上报体里放合法字段，空明细时整字段省略", () => {
  assert.deepEqual(buildModelUsagePayload(rows), [
    ["systemone", "jev-latest", 10],
    ["siliconflow", "Qwen/Qwen2.5-7B", 3],
  ]);
  assert.equal(buildModelUsagePayload([]), undefined);
  assert.equal(buildModelUsagePayload([{ provider: "server", model: "free", requests: 3 }]), undefined);
});
