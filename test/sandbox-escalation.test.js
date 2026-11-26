/**
 * 危险权限申请（danger-full-access 升权卡）交决策模型的验收测试（DEC-089）。
 *
 * ## 为什么这一组必须走真链路
 *
 * 这块功能真正会错的地方不是纯函数，而是**接线**：宿主的升权 ask 走
 * `approval/request` waterfall，和本插件的 `tools/pre-execute` 守卫是两条
 * 完全不同的通道。写好了裁决、却挂错了事件（或者挂在交互式应答者后面），
 * 单测全绿而用户照旧每次都被弹卡——这正是本项目最常见的故障形态。
 *
 * 所以这里：
 *
 *   1. 真跑 `apply()`，从 `ctx.on("approval/request")` 取真监听器；
 *   2. 写真实 `config.yml`（插件的极简 YAML，不是 JSON）；
 *   3. `globalThis.fetch` 打桩，**在 apply 之前**（客户端构造时就固化 fetchFn）；
 *   4. 断言它 **return 给宿主的值**，不是内部变量。
 *
 * ## 覆盖的契约
 *
 *   1. 开关关闭（默认）→ 让位（`next()`），一次请求都不发；
 *   2. 开关打开 + 模型判定放行 → `allowed-once`；
 *   3. 模型说要问/要拦 → 仍让位，绝不替用户拒绝；
 *   4. 只认 `danger-full-access`：别的模式 / 认不出的 reason 一律让位；
 *   5. 决策点是 observe → 只记录，让位；
 *   6. 决策模型降级 → 让位（fail-open 到人，不是 fail-open 到车）；
 *   7. 没有 `reason` 的普通审批（如 auto-review）→ 让位。
 *
 * 反例（3/4/6/7）比正例更重要：这块代码一旦判错方向，就是「模型替用户
 * 批准了整个文件系统的写权限」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";
import { dangerEscalationOf, escalationVerdict, parseEscalationReason } from "../lib/sandbox-escalation.js";

/** 一份能通过 `extractGuardAnswers` 四问校验的答案体。 */
function answerBody(risk = "low") {
  return {
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 8 },
    answers: {
      risk: {
        type: "choice",
        choice: risk,
        confidence: 0.9,
        probabilities: { high: risk === "high" ? 0.9 : 0.001, medium: 0.004 },
      },
      irreversible: { type: "noul", noul: risk === "high" ? 0.95 : 0.05 },
      matches_task: { type: "noul", noul: 0.9 },
      injection_suspect: { type: "noul", noul: 0.05 },
    },
  };
}

/**
 * 造隔离环境：先打桩 fetch，再 apply。
 *
 * @param options.answerBody - 决策端点的回包；默认「低风险放行」。
 * @param options.status - 决策端点的 HTTP 状态码；非 200 用于造降级。
 * @returns 测试夹具。
 */
function setup({ body = answerBody(), status = 200 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-escalation-"));
  process.env.DSH_HOME = home;

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  const hooks = new Map();
  // 注册顺序是这个功能能不能成立的前提（见下面「注册在转发桥之前」用例）：
  // 记录每次 `ctx.on` 的 options，才能断言我们用了 prepend。
  const registrations = [];
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener, options) {
      registrations.push({ name, options });
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    // 刻意不提供 sandboxPolicy / permissionPresets：这两条会短路守卫分支，
    // 而本组测的是审批应答者，与它们无关。
    get() {
      return undefined;
    },
    inject(_names, fn) {
      fn();
    },
    plugin() {},
    effect() {},
  };
  apply(ctx, {});

  const listeners = hooks.get("approval/request") ?? [];
  return {
    home,
    configPath: join(home, "plugins", "dsh-decision-engine", "config.yml"),
    listener: listeners[0],
    registrations,
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/** 写一份能让插件真正打到决策端点的配置。 */
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
    // 全新安装默认会开「使用免费模型」，后台会多打一次 fetch，
    // 把按「问模型次数」计的断言搞脏。显式关掉。
    serverProvider: false,
    dangerFullAccessDecider: true,
    ...over,
  };
  const text = Object.entries(config)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${text}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 造一次宿主的升权审批请求（形状照抄 `dsh-sandbox/escalation.ts`）。 */
function escalationAsk({ mode = "danger-full-access", justification = "需要写入 /etc/hosts" } = {}) {
  return {
    agent: { id: "a1", session: { id: "s1", header: { cwd: "/work/repo" } } },
    toolName: "bash",
    callId: "call-1",
    reason: `escalate sandbox to ${mode}: ${justification}`,
    signal: new AbortController().signal,
  };
}

/** 交互式应答者：假装用户在卡上点了「允许」。 */
function userAllows() {
  return async () => "allowed-once";
}

// ---------------------------------------------------------------- 纯函数

test("解析宿主的升权 reason：认得出模式与理由", () => {
  assert.deepEqual(parseEscalationReason("escalate sandbox to danger-full-access: 写 /etc/hosts"), {
    mode: "danger-full-access",
    justification: "写 /etc/hosts",
  });
  // 带引号的写法（宿主源码里 mode 用模板串插入，未来可能加引号）也必须认。
  assert.equal(
    parseEscalationReason('escalate sandbox to "workspace-write": 改名').mode,
    "workspace-write",
  );
});

test("认不出的 reason 一律返回 null（不猜别的审批形状）", () => {
  assert.equal(parseEscalationReason(undefined), null);
  assert.equal(parseEscalationReason(""), null);
  assert.equal(parseEscalationReason("auto review denied: 越界"), null);
  // 只有前缀没有理由：形状不完整，不当成升权。
  assert.equal(parseEscalationReason("escalate sandbox to danger-full-access"), null);
});

test("只接管 danger-full-access：更窄的升权也算别人的事", () => {
  assert.notEqual(dangerEscalationOf(escalationAsk()), null);
  assert.equal(dangerEscalationOf(escalationAsk({ mode: "workspace-write" })), null);
});

test("裁决 → 应答：只有「放行 + enforce」才自动批准", () => {
  assert.equal(escalationVerdict({ kind: "delegate", pointMode: "enforce" }), "grant");
  // 模型说「要问」「要拦」时一律让位给用户——宿主把非 allowed-once 的结果
  // 报给模型时写的是「用户拒绝了」，替用户拒绝等于让模型替用户背这个决定。
  assert.equal(escalationVerdict({ kind: "ask", pointMode: "enforce" }), "delegate");
  assert.equal(escalationVerdict({ kind: "deny", pointMode: "enforce" }), "delegate");
  // observe 只记录，不改变行为。
  assert.equal(escalationVerdict({ kind: "delegate", pointMode: "observe" }), "delegate");
  assert.equal(escalationVerdict({ kind: "delegate", pointMode: "off" }), "delegate");
});

// ---------------------------------------------------------------- 接线

test("默认关闭：让位给用户，且一次请求都不发", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath, { dangerFullAccessDecider: false });
    const result = await env.listener(escalationAsk(), userAllows());
    assert.equal(result, "allowed-once", "必须原样转交交互式应答者的结论");
    assert.equal(env.calls.length, 0, "开关关着就不能花用户的 token");
  } finally {
    env.restore();
  }
});

test("打开且模型判定放行：直接批准，不再弹卡", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    let asked = false;
    const result = await env.listener(escalationAsk(), async () => {
      asked = true;
      return "allowed-once";
    });
    assert.equal(env.calls.length, 1, "打开后必须真的问一次模型");
    assert.equal(result, "allowed-once");
    assert.equal(asked, false, "模型已放行时不该再打扰用户");
    // 送出去的现场要能解释这次裁决：模式与理由都在。
    const sent = String(env.calls[0].body);
    assert.match(sent, /danger-full-access/);
  } finally {
    env.restore();
  }
});

test("模型判定高风险：仍然弹给用户，绝不替用户拒绝", async () => {
  const env = setup({ body: answerBody("high") });
  try {
    writeConfig(env.configPath);
    let asked = false;
    const result = await env.listener(escalationAsk(), async () => {
      asked = true;
      return "rejected";
    });
    assert.equal(asked, true, "非放行裁决必须交还给用户");
    // 宿主拿到的是用户在卡上的选择，而不是插件伪造的 rejected。
    assert.equal(result, "rejected");
  } finally {
    env.restore();
  }
});

test("决策点是 observe：只记录，照样弹卡", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath, { pointAuthorize: "observe" });
    let asked = false;
    const result = await env.listener(escalationAsk(), async () => {
      asked = true;
      return "allowed-once";
    });
    assert.equal(asked, true);
    assert.equal(result, "allowed-once");
  } finally {
    env.restore();
  }
});

test("决策点是 off：连模型都不问", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath, { pointAuthorize: "off" });
    await env.listener(escalationAsk(), userAllows());
    assert.equal(env.calls.length, 0);
  } finally {
    env.restore();
  }
});

test("更窄的升权（workspace-write）：不让位给模型，照旧问用户", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    let asked = false;
    await env.listener(escalationAsk({ mode: "workspace-write" }), async () => {
      asked = true;
      return "allowed-once";
    });
    assert.equal(asked, true);
    assert.equal(env.calls.length, 0, "只接管 danger-full-access");
  } finally {
    env.restore();
  }
});

test("没有 reason 的普通审批（auto-review 等）：让位", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath);
    let asked = false;
    await env.listener(
      { ...escalationAsk(), reason: undefined },
      async () => {
        asked = true;
        return "allowed-once";
      },
    );
    assert.equal(asked, true);
    assert.equal(env.calls.length, 0);
  } finally {
    env.restore();
  }
});

test("决策模型降级：让位给用户（fail-open 到人，不是放行）", async () => {
  const env = setup({ status: 500 });
  try {
    writeConfig(env.configPath);
    let asked = false;
    const result = await env.listener(escalationAsk(), async () => {
      asked = true;
      return "rejected";
    });
    assert.equal(asked, true, "降级不能变成自动批准");
    assert.equal(result, "rejected");
  } finally {
    env.restore();
  }
});

test("接管时写一条遥测：tag=escalation 且带目标模式（事后可核对）", async () => {
  // 遥测是「插件这次到底插手没有」的唯一现场记录。不写的话，用户问
  // 「那次升权卡为什么没弹」时日志里根本没有这一笔；统计页也拿不到这次裁决
  // 的 provider × model 归属，看起来就像模型从没参与过。
  const env = setup();
  try {
    writeConfig(env.configPath);
    await env.listener(escalationAsk(), userAllows());
    const telemetryPath = join(env.home, "plugins", "dsh-decision-engine", "telemetry.jsonl");
    assert.ok(existsSync(telemetryPath), "接管后必须写出遥测文件");
    const escalationLines = readFileSync(telemetryPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      // 免费模型刷新等旁路也会写遥测，只挑出升权那几条。
      .filter((entry) => entry.tag === "escalation");
    assert.equal(escalationLines.length, 1, "一次升权裁决应写一条遥测");
    assert.equal(escalationLines[0].point, "authorize");
    assert.equal(escalationLines[0].tool, "bash");
    assert.equal(escalationLines[0].escalated_mode, "danger-full-access");
    assert.equal(escalationLines[0].action, "delegate");
  } finally {
    env.restore();
  }
});

test("插件整体关掉：让位（enabled=false 时任何点都不参与）", async () => {
  const env = setup();
  try {
    writeConfig(env.configPath, { enabled: false });
    let asked = false;
    await env.listener(escalationAsk(), async () => {
      asked = true;
      return "allowed-once";
    });
    assert.equal(asked, true);
    assert.equal(env.calls.length, 0);
  } finally {
    env.restore();
  }
});

test("注册在转发桥之前：approval/request 必须用 prepend（否则永远轮不到）", () => {
  // 这条断言对应一个真实故障（2026-11-26）：宿主的 `@deepseek-ai/dsh-api-remotes`
  // 在 boot 阶段就把 `approval/request` 注册成转发监听器，把请求推给浏览器的
  // `dsh-client-ui-approval` 弹卡并**一直等到用户作答**。它只在「会话不在这个
  // 客户端」或「卡片被显式交还」时才 next()。
  //
  // 所以追加注册的监听器排在它之后 = 永远轮不到：开关打开、配置正确、单测全绿，
  // 用户看到的仍是每一张卡都照弹。顺序不是优化，是功能成立的前提。
  const env = setup();
  try {
    const registration = env.registrations.find((item) => item.name === "approval/request");
    assert.ok(registration, "必须注册 approval/request 监听器");
    assert.equal(
      registration.options?.prepend,
      true,
      "必须以 prepend 注册：宿主把 approval/request 转发给浏览器弹卡的监听器在 boot 就排上了",
    );
  } finally {
    env.restore();
  }
});
