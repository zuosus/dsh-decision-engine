/**
 * 配置文件读写的往返测试。
 *
 * 这一层测的是需求里「持久化、读取、编辑和切换」那一条：用户保存后再打开
 * 必须看到自己填的值，且**切换 provider 不能把别的 provider 的配置冲掉**。
 * 这两件事只能靠「写进去 → 读出来」的往返断言，读代码确认不了。
 *
 * 全部是纯文本变换，不碰文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyConfigUpdates, parseConfigText, renderConfigValue } from "../lib/config-file.js";

/** 把一次保存模拟成「读→改→写→再读」。 */
function roundTrip(initialText, updates) {
  const lines = initialText.split("\n");
  const written = applyConfigUpdates(lines, updates).join("\n");
  return { written, parsed: parseConfigText(written) };
}

// ---------------------------------------------------------------- 基础解析

test("解析标量、布尔、数字、数组与注释", () => {
  const parsed = parseConfigText(
    [
      "# 注释",
      "",
      "enabled: true",
      "mode: shadow",
      "timeoutMs: 8000",
      "model:",
      "guardReadOnlyTools: [read, grep, glob]",
      "baseUrl: https://api.example.com/v1",
    ].join("\n"),
  );
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.mode, "shadow");
  assert.equal(parsed.timeoutMs, 8000);
  // 显式空值必须保留为 ""，否则会回落到内置默认模型
  assert.equal(parsed.model, "");
  assert.deepEqual(parsed.guardReadOnlyTools, ["read", "grep", "glob"]);
  assert.equal(parsed.baseUrl, "https://api.example.com/v1");
});

test("URL 里的 # 不会被当成行尾注释", () => {
  const parsed = parseConfigText("customBaseUrl: https://x.dev/v1#frag");
  assert.equal(parsed.customBaseUrl, "https://x.dev/v1#frag");
  // 真正的行尾注释（前面有空格）才去掉
  assert.equal(parseConfigText("timeoutMs: 8000 # 8 秒").timeoutMs, 8000);
});

// ------------------------------------------------------- 保存→重读 回显

test("provider 与 custom 字段保存后能原样回显", () => {
  const { parsed } = roundTrip("# 我的配置\nprovider: bamboonode\n", {
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    customEndpointStyle: "systemone",
    customModel: "my-model",
    customApiKeyEnv: "MY_KEY",
    customHeaders: "X-Tenant: team-a; X-Trace: dsh",
  });
  assert.equal(parsed.provider, "custom");
  assert.equal(parsed.customBaseUrl, "https://gw.example.com/v1");
  assert.equal(parsed.customEndpointStyle, "systemone");
  assert.equal(parsed.customModel, "my-model");
  assert.equal(parsed.customApiKeyEnv, "MY_KEY");
  // 带冒号与分号的值必须原样读回（引号只在文件里，不进入值）
  assert.equal(parsed.customHeaders, "X-Tenant: team-a; X-Trace: dsh");
});

test("切换 provider 不动已存在的其它 provider 配置", () => {
  // 用户先配好 custom，再切到 system one
  const first = roundTrip("", {
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    customModel: "my-model",
    customApiKey: "sk-custom-1",
  });
  assert.equal(first.parsed.provider, "custom");

  const second = roundTrip(first.written, { provider: "systemone" });

  // 只有 provider 变了，custom 的地址 / 模型 / key 必须原样还在
  assert.equal(second.parsed.provider, "systemone");
  assert.equal(second.parsed.customBaseUrl, "https://gw.example.com/v1");
  assert.equal(second.parsed.customModel, "my-model");
  assert.equal(second.parsed.customApiKey, "sk-custom-1");

  // 再切回 custom：值仍在，这就是「切换不影响其它 provider 配置」
  const third = roundTrip(second.written, { provider: "custom" });
  assert.equal(third.parsed.customBaseUrl, "https://gw.example.com/v1");
  assert.equal(third.parsed.customModel, "my-model");
});

test("注释与顺序在保存后保留", () => {
  const initial = ["# 总开关", "enabled: true", "", "# 地址", "baseUrl: https://a.dev/v1", ""].join("\n");
  const { written } = roundTrip(initial, { enabled: false });
  assert.ok(written.includes("# 总开关"), "注释被吃掉了");
  assert.ok(written.includes("# 地址"), "注释被吃掉了");
  assert.ok(written.indexOf("enabled: false") < written.indexOf("baseUrl:"), "顺序被打乱了");
});

test("同一个键重复保存不会追加出第二行", () => {
  const initial = "provider: bamboonode\n";
  let { written } = roundTrip(initial, { provider: "custom" });
  ({ written } = roundTrip(written, { provider: "systemone" }));
  const occurrences = written.split("\n").filter((line) => line.startsWith("provider:")).length;
  assert.equal(occurrences, 1, `provider 出现了 ${occurrences} 次：\n${written}`);
});

test("缺失的键追加在末尾", () => {
  const { written, parsed } = roundTrip("enabled: true\n", { provider: "custom" });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.provider, "custom");
  assert.ok(written.trimEnd().endsWith("provider: custom"));
});

test("undefined 表示不修改（不会写出一行 undefined）", () => {
  const { written, parsed } = roundTrip("provider: bamboonode\n", { provider: undefined, model: "m1" });
  assert.equal(parsed.provider, "bamboonode");
  assert.equal(parsed.model, "m1");
  assert.equal(written.includes("undefined"), false);
});

// --------------------------------------------------------------- 值的渲染

test("需要引号的值被正确包裹并可往返", () => {
  const values = [
    "https://api.example.com/v1",
    "X-Tenant: team-a; X-Trace: dsh",
    "带 空格 和 中文",
    '{"a":"b"}',
    "a,b,c",
    "[不是数组]",
    "含'单引号'与: 冒号",
  ];
  for (const value of values) {
    const { parsed } = roundTrip("", { probe: value });
    assert.equal(parsed.probe, value, `值 ${JSON.stringify(value)} 往返失败：${JSON.stringify(parsed.probe)}`);
  }
});

test("空字符串渲染为空值而不是引号", () => {
  assert.equal(renderConfigValue(""), "");
  const { parsed } = roundTrip("", { model: "" });
  assert.equal(parsed.model, "");
});

test("数组渲染成 [a, b] 形式", () => {
  assert.equal(renderConfigValue(["read", "grep"]), "[read, grep]");
  const { parsed } = roundTrip("", { guardReadOnlyTools: ["read", "grep"] });
  assert.deepEqual(parsed.guardReadOnlyTools, ["read", "grep"]);
});