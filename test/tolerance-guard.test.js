/**
 * 「人工审核比例」在**真实守卫链路**里的接线测试（DEC-035）。
 *
 * `test/tolerance.test.js` 覆盖纯函数（severity / 分位数 / 四档语义）；
 * 这里覆盖它们**接进 `tools/pre-execute` 监听器之后是否还成立**。
 *
 * 为什么必须分开测：纯函数全绿而接线错位，是本项目最常见的故障形态——
 * 参数传反了、或者裁决算出来却没被 return 出去，单测全都看不见，用户的
 * 感受则是「设置根本没生效」，而日志与单测一切正常。
 *
 * 因此这里**不直接调纯函数**，而是走真路径：
 *
 *   1. `apply()` 真跑，从 `ctx.on("tools/pre-execute")` 拿到真监听器；
 *   2. 写真实 `config.yml`——`guardListener` 每次调用前 `reloadOwnConfig()`
 *      重读 mtime，所以改档位**不需要重启或重新 apply**；
 *   3. `globalThis.fetch` 打桩。**必须在 `apply()` 之前打**：客户端在构造时
 *      就固化了 `fetchFn`（见 lib/index.js 的 `this.fetchFn = options.fetchFn
 *      ?? globalThis.fetch`），apply 之后再换桩不会生效；
 *   4. 调用监听器，断言它**return 给宿主的东西**（`{kind:"ask"}` /
 *      `{kind:"deny"}` / `next()` 的返回值），而不是内部变量。
 *
 * 覆盖七条契约：
 *
 *   1. 默认档与升级前逐字一致——低风险不可逆分支仍然 ask；
 *   2. 自治档把 ask 压成放行；
 *   3. 自治档**不**压制 deny（安全边界不随体验设定放开）；
 *   4. 轻松档压掉噪声 ask，但注入嫌疑仍然会问（安全下限生效）；
 *   5. 谨慎档攒够样本后，把默认放行的调用升级成 ask（并集而非替换）；
 *   6. 裁决留痕：`decisions.jsonl` / `telemetry.jsonl` 里查得到档位与严重度；
 *   7. 未知档位值不会让守卫崩（旧配置文件里写了非法值时的兜底）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";

/** 一份能通过 `extractGuardAnswers` 四问校验的答案体。 */
function answerBody({
  choice = "low",
  confidence = 0.9,
  irrev = 0.05,
  task = 0.9,
  inj = 0.05,
  probs = { high: 0.001, medium: 0.004 },
} = {}) {
  return {
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 8 },
    answers: {
      risk: { type: "choice", choice, confidence, probabilities: probs },
      irreversible: { type: "noul", noul: irrev },
      matches_task: { type: "noul", noul: task },
      injection_suspect: { type: "noul", noul: inj },
    },
  };
}

/**
 * 造隔离环境：先打桩 fetch，再 apply。
 *
 * @param options.body - 决策端点的响应体。
 * @returns `{ home, listener, configPath, dataDir, calls, setBody, restore }`
 */
function setup({ body = answerBody() } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-tolguard-"));
  process.env.DSH_HOME = home;

  /** 当前响应体；用 setBody 换，不必重新 apply。 */
  let current = body;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify(current), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const hooks = new Map();
  const routes = {};
  const connection = {
    fetch: {
      register(entry) {
        routes[entry.path] = entry;
      },
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    get(name) {
      // 刻意**不**提供 permissionPresets：提供的话会走「auto 预设下不再打扰」
      // 的分支，把要验证的档位语义提前短路。
      return name === "connection" ? connection : undefined;
    },
    inject(_names, fn) {
      fn();
    },
    plugin() {},
    effect() {},
  };
  apply(ctx, {});

  const listeners = hooks.get("tools/pre-execute") ?? [];
  return {
    home,
    routes,
    configPath: join(home, "dsh-decision-engine", "config.yml"),
    dataDir: join(home, "dsh-decision-engine"),
    /** 当前注册的守卫监听器（reloadOwnConfig 会重读配置，无需重新取）。 */
    listener: listeners[0],
    calls,
    setBody(next) {
      current = next;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * 写一份能让守卫真正打到决策端点的配置。
 *
 * 必须 `enabled: true` + `mode: enforce` + `pointAuthorize: enforce`，
 * 否则监听器开头就放行。key 走 config 存储，不依赖凭据文件/环境变量。
 *
 * @param configPath - 配置路径。
 * @param over - 覆盖项（例如 `{ tolerance: "relaxed" }`）。
 */
function writeConfig(configPath, over = {}) {
  const base = {
    enabled: true,
    mode: "enforce",
    provider: "bamboonode",
    baseUrl: "https://api.bamboonode.dev/v1",
    model: "test-model",
    keyStorage: "config",
    bamboonodeApiKey: "sk-test-key-000000",
    pointAuthorize: "enforce",
    decisionsTabEnabled: true,
    ...over,
  };
  const text = Object.entries(base)
    .map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : value}`)
    .join("\n");
  writeText(configPath, text + "\n");
}

/** 同步写文件（含建目录）：配置在监听器第一行被 stat+read，必须已落盘。 */
function writeText(path, text) {
  mkdirSync(dirnameOf(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

/** 极简 dirname（只为免多引一个 import；路径都是我们自己拼的 POSIX 路径）。 */
function dirnameOf(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

/**
 * 走一次真实监听器。
 *
 * @param listener - `apply()` 注册的函数。
 * @param options.args - 工具参数（每次换一下，避免精确缓存命中）。
 * @returns `{ decision, nextCalled }`
 */
async function runGuard(listener, { tool = "bash", args = { command: "echo hi" } } = {}) {
  let nextCalled = false;
  const decision = await listener(
    {
      name: tool,
      arguments: args,
      agent: { session: { id: "session-tolerance-test" } },
      signal: undefined,
    },
    async () => {
      nextCalled = true;
      return { kind: "proceed" };
    },
  );
  return { decision, nextCalled };
}

/** 读 JSONL 文件里的全部记录（文件不存在时返回空数组）。 */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* 半行跳过 */
    }
  }
  return out;
}

/** 等写盘队列落定（决策明细与遥测都是异步旁路）。 */
async function settle() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}


/** 「低风险 + 可能不可逆 + 任务相关性低」——DEC-008 里那条最吵的分支。 */
const NOISE = { irrev: 0.35, task: 0.2 };

/** 完全普通的一次调用（默认会放行）。 */
const BENIGN = { irrev: 0.02, task: 0.9 };

test("默认档与升级前逐字一致：低风险不可逆分支仍然升级询问", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    writeConfig(env.configPath, { tolerance: "default" });
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "echo a" } });
    assert.equal(nextCalled, false, "默认档下这条应被升级，不能直接放行");
    assert.equal(decision.kind, "ask", `默认档必须仍然是 ask，实际 ${JSON.stringify(decision)}`);
    // 文案必须还是原来那条分支的原文，不许被 tolerance 改写。
    assert.match(decision.reason, /需人工确认/);
  } finally {
    env.restore();
  }
});

test("省缺 tolerance（老配置文件）等价于默认档", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    // 刻意不写 tolerance 键：模拟升级前就存在的 config.yml。
    writeConfig(env.configPath);
    const { decision } = await runGuard(env.listener, { args: { command: "echo b" } });
    assert.equal(decision.kind, "ask", "没写这一项的配置必须保持原行为");
  } finally {
    env.restore();
  }
});

test("自治档：同样的调用不再询问，宿主直接放行", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    writeConfig(env.configPath, { tolerance: "autonomous" });
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "echo c" } });
    assert.equal(nextCalled, true, "自治档必须让这次调用继续执行");
    assert.equal(decision.kind, "proceed", "应返回 next() 的结果");
  } finally {
    env.restore();
  }
});

test("自治档不压制 deny：高风险且不可逆仍然被拦下", async () => {
  const env = setup({
    body: answerBody({ choice: "high", confidence: 0.95, irrev: 0.8, task: 0.9 }),
  });
  try {
    writeConfig(env.configPath, { tolerance: "autonomous" });
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "rm -rf /" } });
    assert.equal(nextCalled, false, "自治档不允许把拦截也一并放开");
    assert.equal(decision.kind, "deny", `自治档必须仍返回 deny，实际 ${JSON.stringify(decision)}`);
    assert.equal(decision.info?.code, "STARTLUX_GUARD_DENY");
  } finally {
    env.restore();
  }
});

test("四档都保留 deny（逐档拨一遍）", async () => {
  for (const level of ["autonomous", "relaxed", "default", "cautious"]) {
    const env = setup({
      body: answerBody({ choice: "high", confidence: 0.95, irrev: 0.8, task: 0.9 }),
    });
    try {
      writeConfig(env.configPath, { tolerance: level });
      const { decision } = await runGuard(env.listener, { args: { command: `rm -rf /${level}` } });
      assert.equal(decision.kind, "deny", `${level} 档不应取消拦截，实际 ${JSON.stringify(decision)}`);
    } finally {
      env.restore();
    }
  }
});

test("轻松档：压掉那条噪声 ask（冷启动阈值之下）", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    writeConfig(env.configPath, { tolerance: "relaxed" });
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "echo d" } });
    assert.equal(nextCalled, true, "轻松档应放过这条低严重度的调用");
    assert.equal(decision.kind, "proceed");
  } finally {
    env.restore();
  }
});

test("轻松档：达线的注入嫌疑仍然会问，且理由仍是模型自己的结论", async () => {
  // inj >= guardInjectionAskThreshold（0.8）时，`decideGuard()` **本身**就返回 ask；
  // 此时 tolerance 与默认判断一致（changed=false），因此裁决对象应**原样**透传。
  //
  // 这条断言守的是「审计口径不漂移」：模型说的是「疑似提示注入」，就不能因为
  // 用户选了轻松档而改写成「按你的档位设置询问」——后者会让事后核对时
  // 以为模型什么都没发现。
  const env = setup({ body: answerBody({ inj: 0.85, irrev: 0.02, task: 0.9 }) });
  try {
    writeConfig(env.configPath, { tolerance: "relaxed" });
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "echo e" } });
    assert.equal(nextCalled, false, "达线的注入嫌疑不该被轻松档静默放过");
    assert.equal(decision.kind, "ask", `注入嫌疑应升级，实际 ${JSON.stringify(decision)}`);
    assert.match(decision.reason, /注入/, "理由必须仍是模型自己的注入结论");
    assert.doesNotMatch(decision.reason, /人工审核比例/, "默认判断本来就 ask 时不该改写理由");
    assert.ok(decision.displayReason !== undefined, "ask 必须带 displayReason（DEC-019）");
  } finally {
    env.restore();
  }
});

test("轻松档：未达线但严重度够高的调用由 tolerance 升级，理由说明是档位要求", async () => {
  // inj=0.7 低于 guardInjectionAskThreshold（0.8），因此默认判断是**放行**；
  // 但 severity 取 max(..., inj)=0.7 > 冷启动阈值 0.6，轻松档应把它拉起来。
  // 这是唯一能证明「severity 真的接进了热路径」的用例——纯看默认判断的话
  // 它本来什么都不做。
  const env = setup({ body: answerBody({ inj: 0.7, irrev: 0.02, task: 0.9 }) });
  try {
    writeConfig(env.configPath, { tolerance: "relaxed" });
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "echo g" } });
    assert.equal(nextCalled, false, "严重度够高的调用应被升级");
    assert.equal(decision.kind, "ask", `应由 tolerance 升级，实际 ${JSON.stringify(decision)}`);
    // 这条是 tolerance **造出来**的 ask → 理由必须说明是档位要求，
    // 而不是伪造一条模型结论。
    assert.match(decision.reason, /人工审核比例/, "档位触发的 ask 必须自称是档位要求");
    assert.ok(decision.displayReason !== undefined, "tolerance 触发的 ask 也必须带 displayReason（DEC-019）");
    // DEC-041：标题给人读，只点名档位；`severity=` 与 0.xxx 只留在 reason 里。
    assert.doesNotMatch(decision.displayReason.zh, /severity=/);
    assert.doesNotMatch(decision.displayReason.zh, /\d\.\d/);
    assert.match(decision.displayReason.zh, /轻松/, "标题应点名用户选的「轻松」档");
  } finally {
    env.restore();
  }
});

test("谨慎档：攒够样本后把默认放行的普通调用升级成 ask（并集语义）", async () => {
  const env = setup({ body: answerBody(BENIGN) });
  try {
    writeConfig(env.configPath, { tolerance: "cautious" });
    // 先攒够 50 个样本（TOLERANCE_MIN_SAMPLES）。每次换参数，避免精确缓存命中
    // 让守卫拿不到新的 severity（缓存命中同样会 observe，但我们要真实的多次判断）。
    for (let i = 0; i < 60; i += 1) {
      await runGuard(env.listener, { args: { command: `echo warm-${i}` } });
    }
    const { decision, nextCalled } = await runGuard(env.listener, { args: { command: "echo warm-final" } });
    assert.equal(nextCalled, false, "谨慎档应把严重度靠前的调用升级，不该直接放行");
    assert.equal(decision.kind, "ask", `谨慎档应返回 ask，实际 ${JSON.stringify(decision)}`);
  } finally {
    env.restore();
  }
});

test("裁决留痕：decisions.jsonl 与 telemetry.jsonl 都带档位与严重度", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    writeConfig(env.configPath, { tolerance: "default" });
    await runGuard(env.listener, { args: { command: "echo trace" } });
    await settle();

    const decisionsPath = join(env.dataDir, "decisions.jsonl");
    const telemetryPath = join(env.dataDir, "telemetry.jsonl");
    const decisions = readJsonl(decisionsPath).filter((row) => row.point === "authorize");
    const telemetry = readJsonl(telemetryPath).filter((row) => row.point === "authorize");
    assert.ok(decisions.length > 0, "决策明细必须落盘（否则「这次为什么没问我」没法回答）");
    assert.ok(telemetry.length > 0, "遥测必须落盘");

    // 留痕字段在 scores.tolerance 里：level / sev / cutoff / base / changed。
    const detailTrace = decisions.at(-1)?.scores?.tolerance;
    assert.ok(detailTrace !== undefined, "明细里缺 scores.tolerance 留痕");
    assert.equal(detailTrace.level, "default");
    assert.equal(typeof detailTrace.sev, "number");
    assert.equal(detailTrace.base, "ask", "默认判断那一半必须如实记录");

    const telemetryTrace = telemetry.at(-1)?.scores?.tolerance;
    assert.ok(telemetryTrace !== undefined, "遥测里缺 scores.tolerance 留痕");
    assert.equal(telemetryTrace.level, "default");
  } finally {
    env.restore();
  }
});

test("非法档位值不会让守卫崩（旧配置写坏时的兜底）", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    // config.yml 是可手改的，坏值必须退化成默认档而不是抛错（fail-open）。
    writeConfig(env.configPath, { tolerance: "relax" });
    const { decision } = await runGuard(env.listener, { args: { command: "echo f" } });
    assert.equal(decision.kind, "ask", "非法档位应退回默认行为，不得抛错也不得静默放行");
  } finally {
    env.restore();
  }
});

test("只读工具不走这套逻辑（零开销，档位不影响）", async () => {
  const env = setup({ body: answerBody(NOISE) });
  try {
    writeConfig(env.configPath, { tolerance: "cautious" });
    const { nextCalled } = await runGuard(env.listener, { tool: "read", args: { file_path: "/tmp/x" } });
    assert.equal(nextCalled, true, "只读工具应在守卫里直接放行");
  } finally {
    env.restore();
  }
});
