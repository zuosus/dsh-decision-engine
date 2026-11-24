/**
 * 模型级能力的验收测试。
 *
 * 背景：decisionmodels.io 的三款模型脾气不同——s1-fast 一次只收 1 道题，
 * s1-pro 收 3 道，s1-vision 能看图。把这类差异写在 provider 层会得到
 * 「默认模型的保守值套到所有模型上」的谎报（s1-pro 被无谓地拆成 4 发）。
 *
 * 本文件盯住三条承诺：
 *
 *   1. `models` 数组里每个对象都能声明 `capabilities`，字符串写法仍兼容；
 *   2. 模型能力覆盖 provider 能力（包括未知键），协议事实仍优先；
 *   3. `resolveProvider` / catalog / 请求体读到的都是**生效模型**的能力。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRequestBody,
  parseProviderPresets,
  providerCatalog,
  resolveProvider,
} from "../lib/providers.js";
import { effectiveCapabilities } from "../lib/provider-presets.js";

/** 只有 id 的最小预设：字段名由 id 推导，能力全靠声明。 */
function preset(raw) {
  return parseProviderPresets([raw])[0];
}

// ------------------------------------------------ 数据层：两种写法都能解析

test("models 数组支持对象写法：每个对象可声明自己的 capabilities", () => {
  const parsed = preset({
    id: "gw",
    baseUrl: "https://gw.example.com/v1",
    capabilities: { thinkMode: false, maxQuestions: 1 },
    models: [
      { id: "fast", capabilities: { maxQuestions: 1 } },
      { id: "pro", capabilities: { maxQuestions: 3 } },
      { id: "vision", capabilities: { vision: true } },
    ],
  });
  // models 仍是 id 清单（既有消费者全部照常），对象里的能力另存一张表。
  assert.deepEqual(parsed.models, ["fast", "pro", "vision"]);
  assert.deepEqual(parsed.knownModels, ["fast", "pro", "vision"]);
  assert.equal(parsed.defaultModel, "fast");
  assert.deepEqual(parsed.modelCapabilities.pro, { maxQuestions: 3 });
  assert.deepEqual(parsed.modelCapabilities.vision, { vision: true });
});

test("models 数组仍接受字符串写法（老 JSON 不改也能用）", () => {
  const parsed = preset({
    id: "gw",
    baseUrl: "https://gw.example.com/v1",
    models: ["m1", "m2"],
  });
  assert.deepEqual(parsed.models, ["m1", "m2"]);
  assert.deepEqual(parsed.modelCapabilities, { m1: {}, m2: {} });
  assert.equal(parsed.defaultModel, "m1");
});

test("模型声明覆盖 provider 声明，未知键原样保留，provider 表不被改脏", () => {
  const parsed = preset({
    id: "gw",
    baseUrl: "https://gw.example.com/v1",
    protocol: "systemone",
    capabilities: { thinkMode: false, maxQuestions: 1, futureKnob: "provider" },
    models: [
      { id: "plain", capabilities: {} },
      { id: "override", capabilities: { thinkMode: true, maxQuestions: 3, futureKnob: "model" } },
    ],
  });
  const plain = effectiveCapabilities(parsed, "plain");
  assert.equal(plain.thinkMode, false);
  assert.equal(plain.maxQuestions, 1);
  assert.equal(plain.futureKnob, "provider");

  const override = effectiveCapabilities(parsed, "override");
  assert.equal(override.thinkMode, true);
  assert.equal(override.maxQuestions, 3);
  assert.equal(override.futureKnob, "model", "模型覆盖未知键，数据层不吞");

  // 合并不能写回 provider 表：否则后续 resolve 另一个模型会读到上一次的覆盖。
  assert.equal(parsed.capabilities.maxQuestions, 1);
  assert.equal(parsed.capabilities.thinkMode, false);
  assert.deepEqual(effectiveCapabilities(parsed, "plain").futureKnob, "provider");
});

test("协议事实仍优先：非 systemone 协议下模型声明 thinkMode:true 不能谎报", () => {
  const parsed = preset({
    id: "gw",
    baseUrl: "https://gw.example.com/v1",
    protocol: "openai-decisions",
    models: [{ id: "m", capabilities: { thinkMode: true } }],
  });
  assert.equal(effectiveCapabilities(parsed, "m").thinkMode, false);
});

// ------------------------------------------------ 内置预设：decisionmodels

test("decisionmodels：每款模型有自己的能力，s1-pro 的上限不再是 s1-fast 的 1", () => {
  const fast = resolveProvider({ provider: "decisionmodels" });
  assert.equal(fast.model, "s1-fast");
  assert.equal(fast.maxQuestions, 1);
  assert.equal(fast.capabilities.thinkMode, false);

  const pro = resolveProvider({ provider: "decisionmodels", decisionModelsModel: "s1-pro" });
  assert.equal(pro.model, "s1-pro");
  assert.equal(pro.maxQuestions, 3);
  assert.equal(pro.capabilities.thinkMode, false, "模型只覆盖自己声明的键，thinkMode 仍继承 provider");

  const vision = resolveProvider({ provider: "decisionmodels", decisionModelsModel: "s1-vision" });
  assert.equal(vision.capabilities.vision, true, "未知能力键也能从模型配置透传到生效表");
  assert.equal(vision.capabilities.thinkMode, false);
});

test("请求体读生效能力：模型能重开 think_mode，未覆盖的模型仍不发", () => {
  const parsed = preset({
    id: "gw",
    baseUrl: "https://gw.example.com/v1",
    protocol: "systemone",
    capabilities: { thinkMode: false },
    models: [
      { id: "plain", capabilities: {} },
      { id: "thinker", capabilities: { thinkMode: true } },
    ],
  });
  // 用 resolveProvider 同形状的对象喂给传输层，验证它读的是合并后的表。
  const of = (id, thinkMode) => ({
    protocol: "systemone",
    model: id,
    thinkMode,
    capabilities: effectiveCapabilities(parsed, id),
    supportsThinkMode: effectiveCapabilities(parsed, id).thinkMode === true,
  });
  assert.equal(buildRequestBody(of("thinker", "always"), { state: {}, questions: {} }).think_mode, "always");
  assert.equal(buildRequestBody(of("plain", "always"), { state: {}, questions: {} }).think_mode, undefined);
});

// ------------------------------------------------ catalog：界面拿到的也是合并后的表

test("providerCatalog 按模型下发合并后的 capabilities，界面可直接取用", () => {
  const item = providerCatalog().find((entry) => entry.id === "decisionmodels");
  assert.deepEqual(item.models, ["s1-fast", "s1-pro", "s1-vision", "reax-1"], "兼容字段仍是 id 清单");
  assert.equal(item.modelCapabilities["s1-fast"].maxQuestions, 1);
  assert.equal(item.modelCapabilities["s1-pro"].maxQuestions, 3);
  assert.equal(item.modelCapabilities["s1-vision"].vision, true);
  assert.equal(item.modelCapabilities["s1-vision"].thinkMode, false, "provider 级能力仍在模型表里");
  assert.equal(item.modelCapabilities["s1-fast"].thinkMode, false);
});
