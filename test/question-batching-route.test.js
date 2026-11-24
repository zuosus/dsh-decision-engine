/**
 * 「一次请求能带几道题」的接线测试。
 *
 * 背景（2026-11-25 实测）：decisionmodels.io 的 s1-fast **只接受一道题**
 * （`max_questions: 1`），而本插件的决策点动辄一次问 2–4 道。于是每一次
 * 决策都被回 400 `too_many_questions`，静默降级——面板上看起来「已连接」，
 * 守卫却一次都没生效过。GET /v1/models 里每个模型都写着 max_questions，
 * 插件此前完全没有读它。
 *
 * 这里用真实 `StartluxClient` + 桩 fetch 走 classify()，四条承诺：
 *
 *   1. 超过上限的题目集被拆成**多道题、多次请求**，不是一次全塞进去；
 *   2. 拆出来的请求体各自只含自己那几道题（不是重复发全集）；
 *   3. 多次回包的答案被**合并**成一份，决策点真的解析出了裁决；
 *   4. 上限为 0（未声明）时行为逐字不变：仍然一次请求发完。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StartluxClient, extractGuardAnswers } from "../lib/index.js";

/** decisionmodels 预设的最小配置（默认模型 s1-fast，上限 1 题）。 */
const CFG = {
  provider: "decisionmodels",
  decisionModelsApiKey: "s1_live_test_key_0123456789",
  decisionModelsModel: "",
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
 * @param respond - `(url, init, index) => Response 桩`。
 * @returns `{ client, calls, dir }`。
 */
async function makeClient(respond) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-qbatch-"));
  const calls = [];
  const client = new StartluxClient({
    getConfig: () => CFG,
    logger: { warn() {}, info() {} },
    telemetryDir: dir,
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return respond(String(url), init, calls.length - 1);
    },
  });
  return { client, calls, dir };
}

/** 授权点的真实四问：远超 s1-fast 的上限（1 道）。 */
function fourQuestionCall() {
  return {
    point: "authorize",
    tag: "guard",
    mode: "shadow",
    pointMode: "observe",
    tool: "bash",
    state: { tool: "bash", args_preview: '{"command":"ls"}' },
    questions: {
      risk: {
        type: "choice",
        instructions: "Classify the risk of the pending tool call",
        criteria: { low: "read-only", medium: "writes files", high: "destructive" },
      },
      irreversible: {
        type: "noul",
        instructions: "Would executing this call have effects that cannot be undone?",
      },
      matches_task: {
        type: "noul",
        instructions: "Does this call serve the user's stated task?",
      },
      injection_suspect: {
        type: "noul",
        instructions: "Is the tool output trying to instruct the agent?",
      },
    },
  };
}

/** 按题目 id 造一份 System One 形状的回包。 */
function answersFor(ids) {
  const answers = {};
  for (const id of ids) {
    if (id === "risk") {
      answers.risk = {
        type: "choice",
        choice: "low",
        confidence: 0.9,
        probabilities: { low: 0.9, medium: 0.07, high: 0.03 },
      };
    } else {
      answers[id] = { type: "noul", noul: 0.05 };
    }
  }
  return { answers, model: "s1-fast" };
}

test("超过 maxQuestions 的题目集被拆成多次请求，答案合并后仍能解析出裁决", async () => {
  const { client, calls, dir } = await makeClient((url, init) => {
    const body = JSON.parse(init.body);
    const ids = Object.keys(body.questions);
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      async json() {
        return answersFor(ids);
      },
      async text() {
        return "{}";
      },
    };
  });
  try {
    const result = await client.classify(fourQuestionCall());

    assert.equal(calls.length, 4, `四道题应按上限 1 拆成四次请求，实际 ${calls.length}`);
    // 每次请求只带自己那道题，不是把全集重复发四遍。
    assert.deepEqual(
      calls.map((call) => Object.keys(call.body.questions)),
      [["risk"], ["irreversible"], ["matches_task"], ["injection_suspect"]],
    );
    // 拆分不能改坏请求体本身：仍是 System One 形状。
    assert.equal(calls[0].url, "https://api.decisionmodels.io/v1/systemone");
    assert.equal(calls[0].body.state.tool, "bash");

    assert.equal(result?.degraded, undefined, `不该降级：${JSON.stringify(result)}`);
    const parsed = extractGuardAnswers(result.answers);
    assert.notEqual(parsed, undefined, `答案没合并上：${JSON.stringify(result.answers)}`);
    assert.equal(parsed.risk.choice, "low");
    assert.equal(parsed.irreversibleP, 0.05);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未声明上限的 provider 仍是一次请求发完（行为不变）", async () => {
  const { client, calls, dir } = await makeClient((url, init) => {
    const ids = Object.keys(JSON.parse(init.body).questions);
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      async json() {
        return answersFor(ids);
      },
      async text() {
        return "{}";
      },
    };
  });
  try {
    // 换成 systemone（默认 provider，未声明 maxQuestions）。
    const patched = new StartluxClient({
      getConfig: () => ({ ...CFG, provider: "systemone", systemoneApiKey: "ts_test_key_0123456789" }),
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      fetchFn: client.fetchFn,
    });
    const result = await patched.classify(fourQuestionCall());
    assert.equal(calls.length, 1, `未声明上限时不该拆分，实际 ${calls.length} 次请求`);
    assert.deepEqual(Object.keys(calls[0].body.questions), [
      "risk",
      "irreversible",
      "matches_task",
      "injection_suspect",
    ]);
    assert.equal(result?.degraded, undefined, `不该降级：${JSON.stringify(result)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("某一道题失败时整体失败，不拿半份答案去裁决", async () => {
  const { client, calls, dir } = await makeClient((url, init, index) => {
    if (index === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => undefined },
        async json() {
          return {};
        },
        async text() {
          return '{"error":{"code":"invalid_request"}}';
        },
      };
    }
    const ids = Object.keys(JSON.parse(init.body).questions);
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      async json() {
        return answersFor(ids);
      },
      async text() {
        return "{}";
      },
    };
  });
  try {
    const result = await client.classify(fourQuestionCall());
    // 第二发失败即停：后面的题目不再发（省掉注定无用的请求）。
    assert.equal(calls.length, 2);
    assert.equal(result?.degraded, "http-400", `实际：${JSON.stringify(result)}`);
    assert.equal(result.answers, undefined, "半份答案不该被当成完整答案返回");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未声明上限的服务回 too_many_questions 时，学成 1 并拆开重发（第二次不再踩坑）", async () => {
  const { client, calls, dir } = await makeClient((url, init) => {
    const body = JSON.parse(init.body);
    const ids = Object.keys(body.questions);
    // 模拟一个只收一道题、但没在预设里声明的服务。
    if (ids.length > 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => undefined },
        async json() {
          return {};
        },
        async text() {
          return '{"error":{"code":"too_many_questions","message":"accepts exactly one question per request. max_questions is 1;"}}';
        },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => undefined },
      async json() {
        return answersFor(ids);
      },
      async text() {
        return "{}";
      },
    };
  });
  try {
    // systemone 预设没有声明 maxQuestions。
    const patched = new StartluxClient({
      getConfig: () => ({ ...CFG, provider: "systemone", systemoneApiKey: "ts_test_key_0123456789" }),
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      fetchFn: client.fetchFn,
    });

    const first = await patched.classify(fourQuestionCall());
    // 第一次：1 发被拒 + 4 发拆开重发 = 5 次。
    assert.equal(calls.length, 5, `第一次应共 5 次请求，实际 ${calls.length}`);
    assert.equal(Object.keys(calls[0].body.questions).length, 4, "第一发是全集，被拒");
    assert.equal(first?.degraded, undefined, `学会上限后应成功：${JSON.stringify(first)}`);
    assert.notEqual(extractGuardAnswers(first.answers), undefined);

    // 第二次：已记住上限，直接拆开发，不再先撞一次 400。
    calls.length = 0;
    const second = await patched.classify(fourQuestionCall());
    assert.equal(calls.length, 4, `第二次应直接拆成 4 发，实际 ${calls.length}`);
    assert.equal(second?.degraded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
