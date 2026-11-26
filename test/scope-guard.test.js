/**
 * 作用域边界在**真实守卫链路**里的接线测试（DEC-045）。
 *
 * `test/scope.test.js` 覆盖纯函数（写根判定、路径提取、裁决词）；
 * 这里覆盖它**接进 `tools/pre-execute` 监听器之后是否还成立**。
 *
 * 为什么必须分开测：纯函数全绿而接线错位，是本项目最常见的故障形态——
 * 参数传反了、或者判定算出来了却没被 return 出去，单测全都看不见，
 * 用户的感受则是「设置根本没生效」，而日志与单测一切正常。
 *
 * 因此这里**不直接调纯函数**，而是走真路径：
 *
 *   1. `apply()` 真跑，从 `ctx.on("tools/pre-execute")` 拿到真监听器；
 *   2. 写真实 `config.yml`；
 *   3. `globalThis.fetch` 打桩。**必须在 `apply()` 之前打**：客户端在构造时
 *      就固化了 `fetchFn`；
 *   4. 调用监听器，断言它**return 给宿主的东西**，而不是内部变量。
 *
 * 覆盖的契约：
 *
 *   1. 目标在工作区写根之外 → **放行**（不询问、不拦下、**不发请求**）；
 *   2. 目标在工作区之内 → 照常走模型判断（边界不误伤正常写入）；
 *   3. 宿主没有 `sandboxPolicy` 服务 → 边界判定跳过（fail-open）；
 *   4. 关掉 `guardDeferOutsideWorkspace` → 回到旧行为（照常问模型）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";

/** 一份能通过 `extractGuardAnswers` 四问校验的答案体。 */
function answerBody() {
  return {
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 8 },
    answers: {
      risk: { type: "choice", choice: "low", confidence: 0.9, probabilities: { high: 0.001, medium: 0.004 } },
      irreversible: { type: "noul", noul: 0.05 },
      matches_task: { type: "noul", noul: 0.9 },
      injection_suspect: { type: "noul", noul: 0.05 },
    },
  };
}

/**
 * 造隔离环境：先打桩 fetch，再 apply。
 *
 * @param options.sandboxPolicy - 注入给 ctx 的宿主沙箱策略服务；缺省则不提供。
 * @param options.workspaceRoot - 沙箱策略给出的工作区根。
 * @returns 测试夹具。
 */
function setup({ sandboxPolicy = true, workspaceRoot = "/work/repo" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-scopeguard-"));
  process.env.DSH_HOME = home;

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify(answerBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const hooks = new Map();
  const connection = { fetch: { register() {} } };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    get(name) {
      if (name === "connection") return connection;
      // 宿主的沙箱策略服务：给出「哪些目录能写」的规范化允许清单。
      if (name === "sandboxPolicy" && sandboxPolicy) {
        return {
          resolve: (request) => ({
            mode: "workspace-write",
            workspaceRoot: request?.session?.header?.cwd ?? workspaceRoot,
            additionalWritableRoots: [],
          }),
        };
      }
      // 刻意**不**提供 permissionPresets：提供的话会走「auto 预设下不再打扰」
      // 的分支，把要验证的边界提前短路。
      return undefined;
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
    configPath: join(home, "plugins", "dsh-decision-engine", "config.yml"),
    listener: listeners[0],
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * 写一份能让守卫真正打到决策端点的配置。
 *
 * 配置走插件自己的 `config.yml`，格式是极简 YAML（`key: value`），
 * 不是 JSON——插件用的是自己的极简解析器（见 lib/config-file.js）。
 */
function writeConfig(configPath, over = {}) {
  const config = {
    enabled: true,
    mode: "enforce",
    pointAuthorize: "enforce",
    provider: "systemone",
    baseUrl: "https://api.typesafe.ai/v1",
    model: "test-model",
    keyStorage: "config",
    systemoneApiKey: "sk-test-key-000000",
    // 这组测的是作用域边界，不测服务端下发。全新安装默认会开「使用免费模型」，
    // 后台刷新下发端点会多打一次 fetch，把下面按「问模型次数」计的断言搞脏。
    // 显式关掉，让夹具只做一件事：照常走本地决策端点。
    serverProvider: false,
    ...over,
  };
  const text = Object.entries(config)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${text}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 造一次待决的工具调用。 */
function toolCall({ name = "write", args = {}, cwd = "/work/repo" } = {}) {
  return {
    name,
    arguments: args,
    agent: { session: { id: "s1", header: { cwd } } },
    signal: new AbortController().signal,
  };
}

// ------------------------------------------------ 预设隔离域里的服务查找

/**
 * 隔离域夹具：`sandboxPolicy` **只**在 Agent 的预设域里可见。
 *
 * 按宿主的规则（`@deepseek-ai/dsh-agent-preset-registry` 的 `serviceFor`）：
 * 预设服务发布在自己的 `cordis:group` realm 里，group 之外的普通 Context
 * lookup 仍选宿主 realm，因此插件根 `ctx.get("sandboxPolicy")` 拿不到它。
 * 这正是「越界让位静默失效」的成因（DEC-045 的边界判定整段被跳过）。
 */
function setupIsolatedRealm({ workspaceRoot = "/work/repo" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-realm-"));
  process.env.DSH_HOME = home;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify(answerBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const hooks = new Map();
  const connection = { fetch: { register() {} } };
  /** 预设域里才有的那个沙箱策略。 */
  const scopedPolicy = {
    resolve: (request) => ({
      mode: "workspace-write",
      workspaceRoot: request?.session?.header?.cwd ?? workspaceRoot,
      additionalWritableRoots: [],
    }),
  };
  let serviceForCalls = 0;
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    get(name) {
      if (name === "connection") return connection;
      // `agentPresets` 本身在根 ctx 上是可见的（它是插件级服务），
      // 但它管理的那些服务在隔离域里。
      if (name === "agentPresets") {
        return {
          serviceFor(agent, serviceName) {
            serviceForCalls += 1;
            return serviceName === "sandboxPolicy" ? scopedPolicy : undefined;
          },
        };
      }
      // 关键：根 ctx **刻意不提供** sandboxPolicy——真实宿主在这一点上就是这样。
      return undefined;
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
    configPath: join(home, "plugins", "dsh-decision-engine", "config.yml"),
    listener: listeners[0],
    calls,
    serviceForCalls: () => serviceForCalls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("隔离域：sandboxPolicy 只在预设域里时，越界让位仍然生效", async () => {
  // 回归：修之前插件只用根 ctx 查服务，隔离域里的 sandboxPolicy 永远取不到，
  // 写根为空 → 边界判定整段跳过 → 越界写入被送进决策模型（而不是交还宿主）。
  const env = setupIsolatedRealm();
  try {
    writeConfig(env.configPath);
    let released = false;
    await env.listener(
      toolCall({ name: "write", args: { file_path: "/etc/evil.txt" } }),
      () => {
        released = true;
        return { kind: "allow" };
      },
    );
    assert.equal(released, true, "越界写必须让位给宿主");
    assert.equal(env.calls.length, 0, "让位时不应发出决策请求");
    assert.ok(env.serviceForCalls() > 0, "必须先问过 agentPresets.serviceFor");
  } finally {
    env.restore();
  }
});

test("隔离域：界内写仍然照常走模型判断（服务查得到不等于一律放行）", async () => {
  const env = setupIsolatedRealm();
  try {
    writeConfig(env.configPath);
    await env.listener(toolCall({ name: "write", args: { file_path: "/work/repo/a.txt" } }), () => ({ kind: "allow" }));
    assert.ok(env.calls.length > 0, "界内写应当照常发请求");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------- 契约

test("越出工作区的写入：放行，且**不发请求**", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    let released = false;
    const result = await env.listener(
      toolCall({ args: { file_path: "/etc/passwd", content: "x" } }),
      () => {
        released = true;
        return { kind: "allow" };
      },
    );
    assert.equal(released, true, "必须放行");
    assert.deepEqual(result, { kind: "allow" }, "不该询问也不该拦下");
    assert.equal(env.calls.length, 0, "边界内不该发请求（省掉一次模型往返）");
  } finally {
    env.restore();
  }
});

test("工作区之内的写入：照常走模型判断（边界不误伤正常写入）", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    await env.listener(
      toolCall({ args: { file_path: "src/a.ts", content: "x" } }),
      () => ({ kind: "allow" }),
    );
    assert.equal(env.calls.length, 1, "工作区内的写入必须照常问模型");
  } finally {
    env.restore();
  }
});

test("宿主没有沙箱策略服务：边界判定跳过（fail-open）", async () => {
  const env = setup({ sandboxPolicy: false });
  try {
    writeConfig(env.configPath);
    await env.listener(
      toolCall({ args: { file_path: "/etc/passwd", content: "x" } }),
      () => ({ kind: "allow" }),
    );
    assert.equal(env.calls.length, 1, "拿不到写根时不能瞎判，必须照常走原流程");
  } finally {
    env.restore();
  }
});

test("关掉 guardDeferOutsideWorkspace：回到旧行为（照常问模型）", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath, { guardDeferOutsideWorkspace: false });
    await env.listener(
      toolCall({ args: { file_path: "/etc/passwd", content: "x" } }),
      () => ({ kind: "allow" }),
    );
    assert.equal(env.calls.length, 1, "关掉后插件照常问模型");
  } finally {
    env.restore();
  }
});

test("相对路径按会话 cwd 解析：逃出工作区即让位", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    let released = false;
    await env.listener(
      toolCall({ args: { file_path: "../../etc/passwd", content: "x" } }),
      () => {
        released = true;
        return { kind: "allow" };
      },
    );
    assert.equal(released, true, "逃出工作区必须让位");
    assert.equal(env.calls.length, 0);
  } finally {
    env.restore();
  }
});

test("apply_patch 的补丁头指向工作区外时同样让位", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    const patch = "*** Begin Patch\n*** Add File: /etc/evil\n+x\n*** End Patch";
    let released = false;
    await env.listener(
      toolCall({ name: "apply_patch", args: { input: patch } }),
      () => {
        released = true;
        return { kind: "allow" };
      },
    );
    assert.equal(released, true);
    assert.equal(env.calls.length, 0);
  } finally {
    env.restore();
  }
});

test("多目标补丁：越界目标排在界内目标之后，同样必须让位", async () => {
  // 回归（DEC-045）：修之前 scope.js 只匹配第一个 `*** ... File:`，于是
  // 「界内 + 越界」的补丁被判成 none，越界让位整段不触发——这次调用会被
  // 送进决策模型，而不是交还宿主沙箱。这是「同一个危险目标因为排在第二位
  // 就消失」的那类 bug，必须在集成层面钉住，不能只测纯函数。
  const env = setup();
  try {
    writeConfig(env.configPath);
    const patch = [
      "*** Begin Patch",
      "*** Add File: /work/repo/harmless.txt",
      "+ok",
      "*** Add File: /etc/evil.txt",
      "+bad",
      "*** End Patch",
    ].join("\n");
    let released = false;
    await env.listener(
      toolCall({ name: "apply_patch", args: { input: patch } }),
      () => {
        released = true;
        return { kind: "allow" };
      },
    );
    assert.equal(released, true, "越界目标存在时必须让位给宿主");
    assert.equal(env.calls.length, 0, "让位时不应发出决策请求");
  } finally {
    env.restore();
  }
});

test("bash 命令里的路径不判定（不解析 shell，只交给宿主沙箱）", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    await env.listener(
      toolCall({ name: "bash", args: { command: "echo x > /etc/passwd" } }),
      () => ({ kind: "allow" }),
    );
    assert.equal(env.calls.length, 1, "shell 里的路径没有边界，交给宿主沙箱管");
  } finally {
    env.restore();
  }
});
