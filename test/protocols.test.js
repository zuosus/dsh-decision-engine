/**
 * 线协议（wire protocol）验收测试：OpenAI Decisions API 预设。
 *
 * 为什么单独一组：`providers.json` 里加一条预设只是「下拉里多一项」，
 * 真正决定它能不能用的是**线协议**——请求体形状、鉴权头、答案形状。
 * 三样里错一样，守卫会 fail-open 降级，症状是「配了没反应」，最难自查。
 *
 * 本组只碰纯函数（零网络、零 DSH 依赖），因此可以在裸 Node 下直接跑。
 * 端到端那一条在 test/openai-protocol-route.test.js。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

// 用命名空间导入而不是具名导入：`readAnswers` 是本次要新增的出口，
// 具名导入会让整个文件在**链接阶段**就失败（那不算「行为缺失」的红）。
import * as providers from "../lib/providers.js";
import {
  PROVIDER_IDS,
  buildHeaders,
  buildRequestBody,
  parseProviderPresets,
  providerCatalog,
  resolveProvider,
} from "../lib/providers.js";

/** 响应体归一入口（本次新增的出口）。 */
const readAnswers = (provider, body) => providers.readAnswers(provider, body);
import { readChoice, readNoul, readScore } from "../lib/points/spec.js";

/** OpenAI 预设的已解析 provider（带一把假 key，只为断言鉴权头）。 */
function openai(over = {}) {
  return resolveProvider({ provider: "openai-decisions", openaiDecisionsApiKey: "sk-test", ...over });
}

// ------------------------------------------------------------ 预设本身

test("OpenAI Decisions 预设：端点、key 变量名与默认模型", () => {
  const provider = openai();
  assert.equal(provider.valid, true);
  // base URL 是 /v1，端点风格 decisions → 拼成 /v1/decisions。
  assert.equal(provider.endpoint, "https://api.openai.com/v1/decisions");
  assert.equal(provider.apiKeyEnv, "OPENAI_API_KEY");
  // 字段名挂在 preset 上（`resolveProvider` 只回显生效值，不回显配置格名）。
  assert.equal(provider.preset.keyField, "openaiDecisionsApiKey");
  assert.equal(provider.preset.modelField, "openaiDecisionsModel");
  // 该端点只支持一个模型，且省略 model 会 400 → 留空必须回落默认模型。
  assert.equal(provider.preset.requiresModel, true);
  assert.equal(provider.model, "gpt-6-luna");
  assert.equal(provider.protocol, "openai-decisions");
  // 与 google-decisions 一样，不能被 404 回退带到 /systemone 上才算通过。
  assert.ok(provider.candidates.includes("https://api.openai.com/v1/decisions"));
});

test("OpenAI 预设在下拉清单里、custom 收尾，catalog 下发字段名与协议", () => {
  const ids = [...PROVIDER_IDS];
  assert.equal(ids.at(-1), "custom", "custom 必须收尾");
  assert.ok(ids.indexOf("openai-decisions") > ids.indexOf("google-decisions"));
  const item = providerCatalog().find((entry) => entry.id === "openai-decisions");
  assert.equal(item.label, "OpenAI Decisions");
  assert.equal(item.labelEn, "OpenAI Decisions");
  assert.deepEqual(item.models, ["gpt-6-luna"]);
  assert.equal(item.modelField, "openaiDecisionsModel");
  assert.equal(item.keyField, "openaiDecisionsApiKey");
  assert.equal(item.protocol, "openai-decisions");
  assert.equal(item.requiresModel, true);
  assert.ok(item.hint.length > 0 && item.hintEn.length > 0);
});

// ------------------------------------------------------------ 鉴权头

test("OpenAI 用 Bearer 鉴权，不带 Google 的 x-goog-api-key", () => {
  const headers = buildHeaders(openai(), "sk-test");
  assert.equal(headers.authorization, "Bearer sk-test");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-goog-api-key"], undefined);
});

// ------------------------------------------------------------ 请求体

test("OpenAI 请求体：input_json 装 state，questions 从对象改成带 name 的数组", () => {
  const body = buildRequestBody(openai(), {
    state: { tool: "bash", command: "rm -rf /tmp/demo/cache" },
    questions: {
      irreversible: { type: "noul", instructions: "Is this action irreversible?" },
      route: {
        type: "choice",
        instructions: "Which route should handle this?",
        criteria: { fast: "Cheap and sufficient.", strong: "Needs deep reasoning." },
      },
      depth: {
        type: "score",
        instructions: "How much deliberation is required?",
        criteria: ["none", "some", "deep"],
      },
    },
    thinkMode: "always",
  });

  // 官方 REST 只认 input / questions / model；state 与 think_mode 都不是它的字段。
  assert.equal(body.state, undefined);
  assert.equal(body.think_mode, undefined);
  assert.equal(body.model, "gpt-6-luna");

  // 结构化证据走 input_json，避免把 state 压成字符串后丢掉结构。
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [{ type: "input_json", data: { tool: "bash", command: "rm -rf /tmp/demo/cache" } }],
    },
  ]);

  // 三个题型各自映射：noul → predicate，choice → choices，score → levels。
  assert.deepEqual(body.questions, [
    { type: "predicate", name: "irreversible", instructions: "Is this action irreversible?" },
    {
      type: "choice",
      name: "route",
      instructions: "Which route should handle this?",
      choices: [
        { value: "fast", description: "Cheap and sufficient." },
        { value: "strong", description: "Needs deep reasoning." },
      ],
    },
    {
      type: "score",
      name: "depth",
      instructions: "How much deliberation is required?",
      levels: [{ label: "none" }, { label: "some" }, { label: "deep" }],
    },
  ]);
});

test("OpenAI 请求体：state 是字符串时直接当 input，不再包一层", () => {
  const body = buildRequestBody(openai(), { state: "Export fails in Safari.", questions: {} });
  assert.equal(body.input, "Export fails in Safari.");
});

test("OpenAI 请求体：模型留空时回落预设默认（端点要求 model 非空）", () => {
  const body = buildRequestBody(openai(), { state: {}, questions: {} });
  assert.equal(body.model, "gpt-6-luna");
  // 显式写的模型覆盖默认值。
  assert.equal(buildRequestBody(openai({ openaiDecisionsModel: "gpt-6-luna-mini" }), { state: {}, questions: {} }).model,
    "gpt-6-luna-mini");
});

test("OpenAI 请求体：choice 的 criteria 是数组时按 value=label 映射", () => {
  const body = buildRequestBody(openai(), {
    state: {},
    questions: { pick: { type: "choice", instructions: "Pick one.", criteria: ["a", "b"] } },
  });
  assert.deepEqual(body.questions[0].choices, [
    { value: "a", description: "a" },
    { value: "b", description: "b" },
  ]);
});

// ------------------------------------------------------------ 答案

test("OpenAI 答案数组按 name 归一成内部对象：predicate/choice/score 各自可解析", () => {
  const answers = readAnswers(openai(), {
    answers: [
      { type: "predicate", name: "irreversible", probability: 0.92 },
      {
        type: "choice",
        name: "risk",
        choice: "high",
        confidence: 0.93,
        probabilities: [
          { value: "low", probability: 0.02 },
          { value: "medium", probability: 0.05 },
          { value: "high", probability: 0.93 },
        ],
      },
      {
        type: "score",
        name: "depth",
        score: 1.1,
        confidence: 0.55,
        probabilities: [
          { value: 0, label: "none", probability: 0.1 },
          { value: 1, label: "some", probability: 0.7 },
          { value: 2, label: "deep", probability: 0.2 },
        ],
      },
    ],
  });

  // 各决策点的 parse 只认内部形状，这里逐个用真实的读取器验一遍。
  assert.equal(readNoul(answers, "irreversible"), 0.92);
  assert.equal(readChoice(answers, "risk").choice, "high");
  assert.equal(readChoice(answers, "risk").confidence, 0.93);
  // tolerance 的严重度靠 high/medium 的连续概率，因此数组必须转成按 value 取值。
  assert.deepEqual(readChoice(answers, "risk").probabilities, { low: 0.02, medium: 0.05, high: 0.93 });
  assert.equal(readScore(answers, "depth", 3), 0.55);
});

test("OpenAI 的 refusal 原样保留 → 各决策点 parse 判为形状不符（降级放行）", () => {
  const answers = readAnswers(openai(), {
    answers: [{ type: "refusal", name: "risk" }],
  });
  // 不能把 refusal 当成低风险：类型不认识就必须让它落到 undefined。
  assert.equal(answers.risk.type, "refusal");
  assert.equal(readChoice(answers, "risk"), undefined);
});

test("OpenAI 答案缺失或畸形时不抛错（交给上层按 missing-answers 降级）", () => {
  assert.equal(readAnswers(openai(), {}), undefined);
  assert.equal(readAnswers(openai(), { answers: null }), undefined);
  // 数组里没有 name 的条目无法映射回问题，直接丢弃。
  assert.deepEqual(readAnswers(openai(), { answers: [{ type: "predicate", probability: 0.5 }] }), {});
});

// ------------------------------------------------------------ 协议隔离

test("其它 provider 的答案形状原样透传（不能被 OpenAI 的归一逻辑改掉）", () => {
  const systemone = resolveProvider({ provider: "systemone" });
  const answers = { risk: { type: "choice", choice: "low", confidence: 0.9, probabilities: { low: 0.9 } } };
  assert.equal(readAnswers(systemone, { answers }), answers);
  const google = resolveProvider({ provider: "google-decisions" });
  assert.equal(readAnswers(google, { answers }), answers);
});

test("未知协议回落 systemone（旧数据里没有 protocol 字段也不能坏）", () => {
  // 用 systemone 预设造一个「协议名写错了」的 provider：能力（preset）随预设，
  // 协议名才被改写。这是老配置/老下发值的真实形态——它们根本没有 protocol 字段。
  const base = resolveProvider({ provider: "systemone" });
  const provider = { ...base, protocol: "not-a-protocol" };
  const body = buildRequestBody(provider, { state: { a: 1 }, questions: { q: { type: "noul" } } });
  // systemone 线协议的特征字段：state + think_mode 都在。
  assert.equal(body.state.a, 1);
  assert.equal(body.think_mode, "never");
  assert.equal(body.input, undefined);
});

test("protocol 字段整段缺失时按 systemone 发（老配置升级路径）", () => {
  const base = resolveProvider({ provider: "systemone" });
  const provider = { ...base };
  delete provider.protocol;
  const body = buildRequestBody(provider, { state: { a: 1 }, questions: {} });
  assert.equal(body.state.a, 1);
  assert.equal(body.think_mode, "never");
});

// ------------------------------------------------- System One 的字段能力差异

test("decisionmodels：systemone 形状不变，但不发 think_mode（端点拒绝该字段）", () => {
  const provider = resolveProvider({ provider: "decisionmodels" });
  const body = buildRequestBody(provider, {
    state: { tool: "bash", command: "ls" },
    questions: { irreversible: { type: "noul", instructions: "Irreversible?" } },
    thinkMode: "always",
  });
  // 线协议其余部分保持 systemone 形状。
  assert.equal(provider.protocol, "systemone");
  assert.deepEqual(body.state, { tool: "bash", command: "ls" });
  assert.equal(body.model, "s1-fast");
  assert.deepEqual(body.questions.irreversible.criteria, {
    true: "The stated condition is true.",
    false: "The stated condition is false.",
  });
  // 实测 400: {"loc":["think_mode"],"msg":"Extra inputs are not permitted"}。
  assert.equal(body.think_mode, undefined);
});

test("其他 systemone provider 仍发送 think_mode（字段能力按 provider 数据层配置）", () => {
  const body = buildRequestBody(resolveProvider({ provider: "systemone" }), {
    state: {},
    questions: {},
  });
  assert.equal(body.think_mode, "never");
});

// ------------------------------------------------- 能力声明的**默认值**必须诚实

test("只有 systemone 协议才谈得上 think_mode：另两种协议的 supportsThinkMode 必须是 false", () => {
  // 这条盯的是「默认值说谎」：`supportsThinkMode` 的缺省是 true，但
  // google-decisions / openai-decisions 的请求体里**根本没有** think_mode 字段
  // （它们用 input / questions，见本文件前面的用例）。
  // 若能力表对它们回 true，UI 会照常显示「思考模式」下拉——用户选了 always
  // 却什么也不会发生，正是本插件最忌讳的「配了没反应」。
  for (const [id, expected] of [
    ["systemone", true],
    ["siliconflow", true],
    ["duanyan", true],
    ["decisionmodels", false],   // 实测 400: Extra inputs are not permitted
    ["google-decisions", false], // 协议本身没有该字段
    ["openai-decisions", false], // 协议本身没有该字段
  ]) {
    const provider = resolveProvider({ provider: id });
    assert.equal(
      provider.supportsThinkMode,
      expected,
      `${id} 的 supportsThinkMode 应为 ${expected}`,
    );
  }
});

test("supportsThinkMode 与实际请求体一致：声称支持的必须真的发得出来", () => {
  // 能力声明不能只是「一张会说谎的表」——它必须与 buildRequestBody 的实际
  // 行为同源。这条把两者钉在一起：声明 true 就必须能在请求体里看到 think_mode。
  for (const id of PROVIDER_IDS) {
    const provider = resolveProvider({ provider: id });
    const body = buildRequestBody(provider, {
      state: {},
      questions: {},
      thinkMode: "always",
    });
    assert.equal(
      provider.supportsThinkMode,
      Object.hasOwn(body, "think_mode"),
      `${id}：声明 supportsThinkMode=${provider.supportsThinkMode}，但请求体${Object.hasOwn(body, "think_mode") ? "有" : "没有"} think_mode`,
    );
  }
});

// ---------------------------------------------------- 通用能力表（capabilities）

test("capabilities 是对外唯一的能力口径，supportsThinkMode 只是它的别名", () => {
  const provider = resolveProvider({ provider: "decisionmodels" });
  // 两处必须一致：UI 读 capabilities，请求构造读 supportsThinkMode——
  // 若两者能各说各话，就又会回到「界面说支持、实际发不出去」。
  assert.equal(provider.capabilities.thinkMode, false);
  assert.equal(provider.supportsThinkMode, false);
  const systemone = resolveProvider({ provider: "systemone" });
  assert.equal(systemone.capabilities.thinkMode, true);
  assert.equal(systemone.supportsThinkMode, true);
});

test("catalog 下发 capabilities，前端不必知道任何一家的脾气", () => {
  const item = providerCatalog().find((entry) => entry.id === "decisionmodels");
  assert.equal(item.capabilities.thinkMode, false);
  const openai = providerCatalog().find((entry) => entry.id === "openai-decisions");
  assert.equal(openai.capabilities.thinkMode, false);
});

test("新增一种能力只改 JSON：未知能力键原样下发，不被丢掉", () => {
  // 这条是「以后加参数不必改代码」的保证：数据层不该把不认识的能力键
  // 静默吞掉，否则新参数在界面上永远拿不到声明。
  const presets = parseProviderPresets([
    {
      id: "future-gw",
      baseUrl: "https://gw.example.com/v1",
      capabilities: { thinkMode: true, someFutureKnob: false },
    },
  ]);
  assert.equal(presets[0].capabilities.thinkMode, true);
  assert.equal(presets[0].capabilities.someFutureKnob, false);
});

test("非 systemone 协议即使在 JSON 里写 thinkMode: true 也按不支持（协议优先）", () => {
  // 能力不能盖过协议事实：请求体里根本没有该字段时，声明 true 是谎报。
  const presets = parseProviderPresets([
    { id: "gw", baseUrl: "https://gw.example.com/v1", protocol: "openai-decisions", capabilities: { thinkMode: true } },
  ]);
  assert.equal(presets[0].capabilities.thinkMode, false);
});
