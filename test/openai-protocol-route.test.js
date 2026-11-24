/**
 * OpenAI Decisions 协议的端到端接线测试。
 *
 * 纯函数测试（test/protocols.test.js）证明「形状转换算得对」，但证明不了
 * **它真的接在请求路径上**：`classify()` 里若仍读 `body.answers` 当对象，
 * 纯函数全绿而实际每次决策都降级——这正是本插件最忌讳的「配了没反应」。
 *
 * 这里用真实 `StartluxClient` + 桩 fetch 走一遍 classify()，四条承诺：
 *
 *   1. 请求真的打到 `https://api.openai.com/v1/decisions`，Bearer 鉴权；
 *   2. 请求体是官方形状（input_json + questions 数组 + name），没有 state/think_mode；
 *   3. 回包的 answers **数组**被归一后，决策点真的解析出了裁决；
 *   4. refusal 与缺字段一律降级放行，不会把「拒绝判断」当成「低风险」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 授权点的四问与解析器在 index.js 里（它不是 POINT_SPECS 的成员：它挂在
// tools/pre-execute 上，由守卫自己装配）。
import { StartluxClient, extractGuardAnswers } from "../lib/index.js";

/** OpenAI 预设的最小配置（关闭缓存与重试，让请求次数可断言）。 */
const CFG = {
  provider: "openai-decisions",
  openaiDecisionsApiKey: "sk-openai-test-key-0123456789",
  openaiDecisionsModel: "",
  cacheSize: 0,
  cacheTtlMs: 0,
  timeoutMs: 5000,
  thinkMode: "never",
  mode: "shadow",
  failureThreshold: 99,
  retryAttempts: 1,
  serverProvider: false,
  backupModel: false,
};

/**
 * 造一个 client，fetch 由 `respond` 决定怎么回。
 * @param respond - `(url, init) => Response 桩`。
 * @returns `{ client, calls, dir }`。
 */
async function makeClient(respond) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-openai-proto-"));
  const calls = [];
  const client = new StartluxClient({
    getConfig: () => CFG,
    logger: { warn() {}, info() {} },
    telemetryDir: dir,
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    },
  });
  return { client, calls, dir };
}

/** 一次成功的决策响应（OpenAI 形状：answers 是数组）。 */
function openaiResponse(answers) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => undefined },
    async json() {
      return { answers, model: "gpt-6-luna" };
    },
    async text() {
      return "{}";
    },
  };
}

/** 授权点的一次调用参数。 */
function authorizeCall() {
  return {
    point: "authorize",
    tag: "guard",
    mode: "shadow",
    pointMode: "observe",
    tool: "bash",
    state: { tool: "bash", args_preview: '{"command":"rm -rf /tmp/demo"}' },
    questions: {
      irreversible: { type: "noul", instructions: "Would executing this call have effects that cannot be undone afterwards?" },
    },
  };
}

test("classify 打的是官方端点，请求体是 OpenAI 形状，没有 state / think_mode", async () => {
  const { client, calls, dir } = await makeClient(() =>
    openaiResponse([{ type: "predicate", name: "irreversible", probability: 0.1 }]),
  );
  try {
    await client.classify(authorizeCall());

    assert.equal(calls.length, 1, `应恰好一次请求，实际 ${calls.length}`);
    assert.equal(calls[0].url, "https://api.openai.com/v1/decisions");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk-openai-test-key-0123456789");
    assert.equal(calls[0].init.headers["x-goog-api-key"], undefined);

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.state, undefined, "OpenAI 端点不认 state 字段");
    assert.equal(body.think_mode, undefined, "OpenAI 端点不认 think_mode 字段");
    assert.equal(body.model, "gpt-6-luna", "model 必填，留空要回落预设默认");
    // state 进 input_json，保留结构。
    assert.equal(body.input[0].content[0].type, "input_json");
    assert.equal(body.input[0].content[0].data.tool, "bash");
    // noul 变成带 name 的 predicate。
    assert.deepEqual(body.questions, [
      {
        type: "predicate",
        name: "irreversible",
        instructions: "Would executing this call have effects that cannot be undone afterwards?",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("answers 数组被归一后，决策点真的解析出裁决（不是每次降级）", async () => {
  // 完整的授权四问：choice + 三个 predicate。全部按 OpenAI 形状回。
  const { client, calls, dir } = await makeClient(() =>
    openaiResponse([
      {
        type: "choice",
        name: "risk",
        choice: "low",
        confidence: 0.91,
        probabilities: [
          { value: "low", probability: 0.91 },
          { value: "medium", probability: 0.07 },
          { value: "high", probability: 0.02 },
        ],
      },
      { type: "predicate", name: "irreversible", probability: 0.05 },
      { type: "predicate", name: "matches_task", probability: 0.97 },
      { type: "predicate", name: "injection_suspect", probability: 0.02 },
    ]),
  );
  try {
    const result = await client.classify(authorizeCall());
    assert.equal(calls.length, 1);
    assert.equal(result?.degraded, undefined, `不该降级：${JSON.stringify(result)}`);

    // 归一后的形状必须让真实的解析器认出来——这是「接线真的通了」的唯一证据。
    const parsed = extractGuardAnswers(result.answers);
    assert.notEqual(parsed, undefined, `答案形状仍不合格：${JSON.stringify(result.answers)}`);
    assert.equal(parsed.risk.choice, "low");
    assert.equal(parsed.irreversibleP, 0.05);
    // probabilities 数组被转成按值索引：tolerance 的连续严重度靠 high/medium
    // 这两个键（守卫只透传这两项，见 index.js 的 extractGuardAnswers）。
    assert.equal(parsed.risk.probabilities.high, 0.02);
    assert.equal(parsed.risk.probabilities.medium, 0.07);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refusal 不当作低风险：答案形状不合格 → 降级放行，绝不放宽策略", async () => {
  const { client, dir } = await makeClient(() =>
    openaiResponse([
      { type: "refusal", name: "risk" },
      { type: "predicate", name: "irreversible", probability: 0.05 },
      { type: "predicate", name: "matches_task", probability: 0.97 },
      { type: "predicate", name: "injection_suspect", probability: 0.02 },
    ]),
  );
  try {
    const result = await client.classify(authorizeCall());
    // 有 answers 对象（refusal 也在里面），因此不会判 missing-answers；
    // 但 risk 的类型不认识，parse 必须返回 undefined。
    assert.equal(result?.degraded, undefined);
    assert.equal(extractGuardAnswers(result.answers), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("响应里没有 answers 数组时按 missing-answers 降级（不抛错）", async () => {
  const { client, dir } = await makeClient(() => ({
    ok: true,
    status: 200,
    headers: { get: () => undefined },
    async json() {
      return { model: "gpt-6-luna" };
    },
    async text() {
      return "{}";
    },
  }));
  try {
    const result = await client.classify(authorizeCall());
    assert.equal(result?.degraded, "missing-answers", `实际：${JSON.stringify(result)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
