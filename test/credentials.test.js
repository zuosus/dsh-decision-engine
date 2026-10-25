/**
 * 凭据文件读写的往返测试。
 *
 * `~/.dsh/.credentials.yaml` 是**共享**文件：DeepSeek / ModelScope / 智谱 等
 * 所有服务的 key 与授权记录都在里面。写坏它的代价是用户整套服务一起失效，
 * 所以这一层必须有往返断言，不能靠读代码确认。
 *
 * 全部是纯文本变换，不碰真实文件。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyRefUpdates, listRefNames, pickRefValue } from "../lib/credentials.js";

/** 一份贴近真实的凭据文件（含 records 嵌套段）。 */
const SAMPLE = [
  "version: 1",
  "records:",
  "  client-connection/browser-session:",
  "    kind: grant",
  "    payload:",
  "      version: 1",
  "      secret: abc123",
  "  deepseek-account-platform/device:",
  "    kind: grant",
  "refs:",
  "  DEEPSEEK_API_KEY: sk-deepseek",
  "  MODELSCOPE_API_KEY: ms-modelscope",
  "  BAMBOO_API_KEY: sk-bamboo",
  "",
].join("\n");

// ---------------------------------------------------------------- 读取

test("能从 refs 段读出指定 key", () => {
  assert.equal(pickRefValue(SAMPLE, "BAMBOO_API_KEY"), "sk-bamboo");
  assert.equal(pickRefValue(SAMPLE, "DEEPSEEK_API_KEY"), "sk-deepseek");
  assert.equal(pickRefValue(SAMPLE, "NOT_EXIST"), undefined);
});

test("不会误从 records 段取值", () => {
  // secret 在 records 里，不是 refs 的键；取它必须失败。
  assert.equal(pickRefValue(SAMPLE, "secret"), undefined);
  assert.equal(pickRefValue(SAMPLE, "kind"), undefined);
});

test("能列出 refs 里的键名（不含值）", () => {
  assert.deepEqual(listRefNames(SAMPLE), [
    "DEEPSEEK_API_KEY",
    "MODELSCOPE_API_KEY",
    "BAMBOO_API_KEY",
  ]);
});

// ---------------------------------------------------------------- 写入

test("新增 key 追加到 refs 段末尾，records 段不动", () => {
  const next = applyRefUpdates(SAMPLE, { TYPESAFE_API_KEY: "key-typesafe" });

  assert.equal(pickRefValue(next, "TYPESAFE_API_KEY"), "key-typesafe");
  // 已有 key 一个都不能丢
  assert.equal(pickRefValue(next, "DEEPSEEK_API_KEY"), "sk-deepseek");
  assert.equal(pickRefValue(next, "MODELSCOPE_API_KEY"), "ms-modelscope");
  assert.equal(pickRefValue(next, "BAMBOO_API_KEY"), "sk-bamboo");
  // records 段的嵌套内容必须逐字保留
  assert.ok(next.includes("  client-connection/browser-session:"));
  assert.ok(next.includes("      secret: abc123"));
});

test("覆盖已有 key 不产生重复行", () => {
  const next = applyRefUpdates(SAMPLE, { BAMBOO_API_KEY: "sk-bamboo-new" });
  assert.equal(pickRefValue(next, "BAMBOO_API_KEY"), "sk-bamboo-new");
  const occurrences = next.split("\n").filter((line) => line.trim().startsWith("BAMBOO_API_KEY:")).length;
  assert.equal(occurrences, 1, `BAMBOO_API_KEY 出现 ${occurrences} 次`);
  // 位置保持原样（仍排在 MODELSCOPE 之后）
  assert.ok(next.indexOf("MODELSCOPE_API_KEY") < next.indexOf("BAMBOO_API_KEY"));
});

test("三个 provider 的 key 可以同时存在，互不覆盖", () => {
  let text = applyRefUpdates(SAMPLE, {
    TYPESAFE_API_KEY: "key-typesafe",
    BAMBOO_API_KEY: "key-bamboo",
    DECISION_ENGINE_CUSTOM_KEY: "key-custom",
  });
  assert.equal(pickRefValue(text, "TYPESAFE_API_KEY"), "key-typesafe");
  assert.equal(pickRefValue(text, "BAMBOO_API_KEY"), "key-bamboo");
  assert.equal(pickRefValue(text, "DECISION_ENGINE_CUSTOM_KEY"), "key-custom");
  // 其它服务的 key 仍在
  assert.equal(pickRefValue(text, "DEEPSEEK_API_KEY"), "sk-deepseek");
});

test("传空字符串表示删除该键", () => {
  const next = applyRefUpdates(SAMPLE, { BAMBOO_API_KEY: "" });
  assert.equal(pickRefValue(next, "BAMBOO_API_KEY"), undefined);
  assert.equal(listRefNames(next).includes("BAMBOO_API_KEY"), false);
  // 其它键不受影响
  assert.equal(pickRefValue(next, "DEEPSEEK_API_KEY"), "sk-deepseek");
});

test("删除不存在的键不会报错也不改动文件", () => {
  const next = applyRefUpdates(SAMPLE, { NEVER_EXISTED: "" });
  assert.equal(pickRefValue(next, "NEVER_EXISTED"), undefined);
  assert.equal(pickRefValue(next, "BAMBOO_API_KEY"), "sk-bamboo");
});

test("没有 refs 段时新建一个", () => {
  const bare = "version: 1\nrecords:\n  foo:\n    kind: grant\n";
  const next = applyRefUpdates(bare, { BAMBOO_API_KEY: "sk-new" });
  assert.equal(pickRefValue(next, "BAMBOO_API_KEY"), "sk-new");
  // 原有内容保留
  assert.ok(next.includes("version: 1"));
  assert.ok(next.includes("  foo:"));
});

test("空文件也能写入", () => {
  const next = applyRefUpdates("", { MY_KEY: "v1" });
  assert.equal(pickRefValue(next, "MY_KEY"), "v1");
});

// ------------------------------------------------------- 值的边界情况

test("特殊字符的 key 能正确往返", () => {
  // key 里偶尔会出现需要引号的字符；写进去读不回来等于 key 丢了。
  for (const value of ["sk-abc123", "sk-with:colon", "sk-with#hash", "带中文的key", "a,b,c"]) {
    const next = applyRefUpdates(SAMPLE, { PROBE_KEY: value });
    assert.equal(pickRefValue(next, "PROBE_KEY"), value, `值 ${JSON.stringify(value)} 往返失败`);
  }
});

test("带引号的值不会被双重包裹", () => {
  const next = applyRefUpdates(SAMPLE, { QUOTED: "'already-quoted'" });
  // 读回来应当与写入语义一致（去一层引号）
  const got = pickRefValue(next, "QUOTED");
  assert.ok(got === "already-quoted" || got === "'already-quoted'", `实际 ${JSON.stringify(got)}`);
});

test("连续多次写入保持稳定（幂等）", () => {
  let text = applyRefUpdates(SAMPLE, { A_KEY: "1" });
  text = applyRefUpdates(text, { A_KEY: "1" });
  text = applyRefUpdates(text, { A_KEY: "1" });
  const occurrences = text.split("\n").filter((line) => line.trim().startsWith("A_KEY:")).length;
  assert.equal(occurrences, 1);
  assert.equal(pickRefValue(text, "A_KEY"), "1");
});