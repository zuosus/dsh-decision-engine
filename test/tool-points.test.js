/**
 * 检索必要性（retrieval）与技能选择（skillPick）的定点测试。
 *
 * 只钉审计里由代码直接证明的事，判断阈值本身仍在 spec.test.js：
 *
 *   1. skillPick 的 redirect 必须校验 suggest 属于候选集，非法就放行；
 *   2. 候选被截断时，用户当前请求的那个技能必须留在候选里；候选要先去重；
 *   3. retrieval 的 skip 在 enforce 下会变成 deny，因此「web_fetch / 带 URL /
 *      时效性关键词」这三类确定性输入不得交给模型决定跳过。
 *
 * 全部用假 runner / 假 ctx / 假遥测：不打网络，不写磁盘。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETRIEVAL_TOOLS,
  mountToolPoints,
  retrievalGuardReason,
} from "../lib/adapters/tools.js";

/** 配置基线。 */
const baseCfg = (over = {}) => ({
  mode: "shadow",
  recentMessages: 0,
  recentMessageChars: 240,
  skillPickCandidates: 8,
  ...over,
});

/** 造一个最小的 ctx：只提供 skills 服务与监听器注册。 */
function makeCtx(services = {}) {
  const hooks = new Map();
  return {
    logger: { warn() {}, info() {}, error() {} },
    on(name, listener) {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    /** 取第一个注册的监听器（本插件只注册一个）。 */
    listener(name) {
      return (hooks.get(name) ?? [])[0];
    },
  };
}

/** 造一个最小的 session（本文件里只有「被原样传给明细」这一个用途）。 */
function makeSession(id = "s-1") {
  return { id, header: { cwd: "/tmp" }, events: [], surface: { nodes: [] } };
}

/**
 * 挂载两个点并返回可断言的把手。
 *
 * @param options.modes - id → 模式。
 * @param options.ask - 替换 runner.ask 的实现（默认什么都不做）。
 * @param options.skills - `skills.list()` 的返回值；不给表示宿主没有该服务。
 * @param options.cfg - 配置。
 */
function mountPoints({ modes = {}, ask, skills, cfg = baseCfg() } = {}) {
  const ctx = makeCtx(skills === undefined ? {} : { skills: { async list() { return skills; } } });
  const calls = [];
  const entries = [];
  const errors = [];
  const runner = {
    participates: (id) => modes[id] === "observe" || modes[id] === "enforce",
    enforces: (id) => modes[id] === "enforce",
    async ask(id, input, extra) {
      calls.push({ id, input, extra });
      return ask === undefined ? { mode: modes[id], action: undefined } : ask(id, input, extra);
    },
  };
  mountToolPoints(ctx, {
    runner,
    getConfig: () => cfg,
    digestRecent: () => "",
    telemetry: {
      async log(entry) {
        entries.push(entry);
      },
      noteAdapterError(point, error) {
        errors.push({ point, error });
      },
    },
    retrievalTools: () => new Set(DEFAULT_RETRIEVAL_TOOLS),
  });
  return { listener: ctx.listener("tools/pre-execute"), calls, entries, errors, cfg };
}

/** 造一次待执行的工具调用。 */
const execOf = (name, args, session = makeSession()) => ({
  name,
  arguments: args,
  agent: { session },
  signal: new AbortController().signal,
});

/** 一个「放行」的 next，同时证明它真的被调用了。 */
function makeNext() {
  const state = { calls: 0 };
  const next = async () => {
    state.calls += 1;
    return { kind: "allow" };
  };
  return { next, state };
}

// ------------------------------------------------------------ 技能选择

test("skillPick：模型建议一个不在候选集里的技能时放行，不 deny", async () => {
  // 修之前：直接采用模型给的 suggest。于是这次调用被 deny 并指去一个不存在的
  // 技能名，模型照着原因再试一次只会再错一次 —— 一次正确的调用被拖成两次失败。
  const { listener, calls, entries } = mountPoints({
    modes: { skillPick: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "redirect", suggest: "ghost-skill", reason: "更匹配" } }),
    skills: [
      { name: "alpha", description: "a" },
      { name: "beta", description: "b" },
    ],
  });
  const { next, state } = makeNext();
  const decision = await listener(execOf("skill", { name: "alpha" }), next);

  assert.equal(calls.length, 1, "这次应该问过模型");
  assert.equal(state.calls, 1, "非法建议必须放行（next 被调用）");
  assert.equal(decision.kind, "allow", `不得拦下一次指向未知技能的调用，实际：${JSON.stringify(decision)}`);
  assert.equal(entries.length, 1, "这类模型漂移要留痕，否则用户只看到偶发的怪错误");
  assert.equal(entries[0].point, "skillPick");
  assert.equal(entries[0].action, "degraded");
  assert.equal(entries[0].detail, "skill-suggest-unlisted");
});

test("skillPick：建议属于候选集时仍然拦下并指路（回归：不能把保护写成放行）", async () => {
  const { listener, calls } = mountPoints({
    modes: { skillPick: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "redirect", suggest: "beta", reason: "更匹配" } }),
    skills: [
      { name: "alpha", description: "a" },
      { name: "beta", description: "b" },
    ],
  });
  const { next } = makeNext();
  const decision = await listener(execOf("skill", { name: "alpha" }), next);

  assert.equal(calls.length, 1);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "STARTLUX_SKILLPICK_REDIRECT");
  assert.equal(decision.info.suggest, "beta");
  assert.match(decision.reason, /beta/);
});

test("skillPick：建议就是请求本身时不拦（回归）", async () => {
  const { listener } = mountPoints({
    modes: { skillPick: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "redirect", suggest: "alpha", reason: "更匹配" } }),
    skills: [
      { name: "alpha", description: "a" },
      { name: "beta", description: "b" },
    ],
  });
  const { next } = makeNext();
  const decision = await listener(execOf("skill", { name: "alpha" }), next);
  assert.equal(decision.kind, "allow");
});

test("skillPick：候选被截断时，用户请求的那个技能必须留在候选里", async () => {
  // 修之前：`summaries.slice(0, limit)`。技能多的环境里请求第 9 个技能时它
  // 根本不在候选里，模型只能从别的技能中挑一个 —— 正确调用被判错并改写。
  const many = Array.from({ length: 10 }, (_item, index) => ({ name: `s${index}`, description: `d${index}` }));
  const { listener, calls } = mountPoints({
    modes: { skillPick: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "allow", reason: "fixture" } }),
    skills: many,
    cfg: baseCfg({ skillPickCandidates: 8 }),
  });
  const { next } = makeNext();
  await listener(execOf("skill", { name: "s8" }), next);

  assert.equal(calls.length, 1);
  const sent = calls[0].input.candidates.map((item) => item.name);
  assert.equal(sent.length, 8, "候选数不得超过上限（state 长度预算）");
  assert.ok(sent.includes("s8"), `请求的技能必须进候选，实际：${sent.join(",")}`);
  assert.ok(!sent.includes("s7"), "替换的是被截断掉的边界项，而不是追加");
  assert.ok(sent.includes("s0") && sent.includes("s6"), "前面的候选应保持原样");
  assert.equal(new Set(sent).size, sent.length, "候选不得重复");
});

test("skillPick：候选中同名条目去重、无名条目丢弃", async () => {
  const { listener, calls } = mountPoints({
    modes: { skillPick: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "allow", reason: "fixture" } }),
    skills: [
      { name: "dup", description: "第一次" },
      { name: "dup", description: "第二次" },
      { name: "", description: "没有名字" },
      { name: "other", description: "o" },
    ],
  });
  const { next } = makeNext();
  await listener(execOf("skill", { name: "dup" }), next);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].input.candidates.map((item) => item.name),
    ["dup", "other"],
    "同名只留第一条，空名不进候选",
  );
});

test("skillPick：observe 下不拦（回归：非法建议也不该在 observe 生效）", async () => {
  const { listener, entries } = mountPoints({
    modes: { skillPick: "observe" },
    ask: () => ({ mode: "observe", action: { kind: "redirect", suggest: "beta", reason: "更匹配" } }),
    skills: [
      { name: "alpha", description: "a" },
      { name: "beta", description: "b" },
    ],
  });
  const { next, state } = makeNext();
  const decision = await listener(execOf("skill", { name: "alpha" }), next);
  assert.equal(decision.kind, "allow");
  assert.equal(state.calls, 1);
  assert.equal(entries.length, 0, "observe 的裁决由引擎记，不该在这里多记一条");
});

// ------------------------------------------------------------ 检索必要性

test("retrieval：时效性查询不被拦截（连模型都不问）", async () => {
  // 修之前：模型说 skip 就 deny，而「最新/今天/版本/发布……」这类问题
  // 天然需要重新检索 —— 哪怕上下文里恰好提过相关字眼。
  const { listener, calls } = mountPoints({
    modes: { retrieval: "enforce" },
    ask: () => ({
      mode: "enforce",
      action: { kind: "skip", reason: "上下文已覆盖" },
    }),
  });
  const { next, state } = makeNext();
  const decision = await listener(execOf("web_search", { query: "查一下 React 最新版本" }), next);

  assert.equal(calls.length, 0, "时效性查询不该交给模型裁决");
  assert.equal(state.calls, 1);
  assert.equal(decision.kind, "allow");
});

test("retrieval：带 URL 的查询不被拦截", async () => {
  const { listener, calls } = mountPoints({
    modes: { retrieval: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "skip", reason: "上下文已覆盖" } }),
  });
  const { next } = makeNext();
  const decision = await listener(
    execOf("web_search", { query: "https://example.com/doc 里的 API 怎么写" }),
    next,
  );
  assert.equal(calls.length, 0);
  assert.equal(decision.kind, "allow");
});

test("retrieval：web_fetch 永远不交给模型决定跳过", async () => {
  const { listener, calls } = mountPoints({
    modes: { retrieval: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "skip", reason: "上下文已覆盖" } }),
  });
  const { next } = makeNext();
  // 参数里没有 URL 字样不算数：web_fetch 这个工具名本身就意味着「抓这个地址」。
  const decision = await listener(execOf("web_fetch", { url: "https://example.com/a" }), next);
  assert.equal(calls.length, 0);
  assert.equal(decision.kind, "allow");
});

test("retrieval：普通查询仍交给模型，判 skip 时 enforce 照样拦（反证保护不是一刀切）", async () => {
  const { listener, calls } = mountPoints({
    modes: { retrieval: "enforce" },
    ask: () => ({
      mode: "enforce",
      action: { kind: "skip", reason: "上下文已覆盖" },
    }),
  });
  const { next } = makeNext();
  const decision = await listener(execOf("web_search", { query: "what is the capital of France" }), next);

  assert.equal(calls.length, 1, "普通查询必须照旧问模型");
  assert.equal(decision.kind, "deny");
  assert.equal(decision.info.code, "STARTLUX_RETRIEVAL_SKIP");
});

test("retrieval：普通查询判 allow 时放行（回归）", async () => {
  const { listener, calls } = mountPoints({
    modes: { retrieval: "enforce" },
    ask: () => ({ mode: "enforce", action: { kind: "allow", reason: "检索有必要" } }),
  });
  const { next } = makeNext();
  const decision = await listener(execOf("web_search", { query: "what is the capital of France" }), next);
  assert.equal(calls.length, 1);
  assert.equal(decision.kind, "allow");
});

// ------------------------------------------------------------ 判据本身

test("确定性判据：只有三类输入被保护，其它一律留给模型", () => {
  // 英文词边界：不能让 "known" 里的 "now" 命中，否则绝大多数查询都会被保护。
  assert.equal(retrievalGuardReason("web_fetch", "随便什么查询"), "explicit-url");
  assert.equal(retrievalGuardReason("web_search", "看看 https://example.com 怎么说"), "url-in-query");
  assert.equal(retrievalGuardReason("web_search", "today's exchange rate"), "time-sensitive");
  assert.equal(retrievalGuardReason("web_search", "现在几点"), "time-sensitive");
  assert.equal(retrievalGuardReason("research", "release notes for v2"), "time-sensitive");
  assert.equal(retrievalGuardReason("web_search", "what is the capital of France"), undefined);
  assert.equal(retrievalGuardReason("web_search", "a well-known theorem"), undefined);
  assert.equal(retrievalGuardReason("research", ""), undefined);
});
