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
    configPath: join(home, "dsh-decision-engine", "config.yml"),
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
    provider: "bamboonode",
    baseUrl: "https://api.bamboonode.dev/v1",
    model: "test-model",
    keyStorage: "config",
    bamboonodeApiKey: "sk-test-key-000000",
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
