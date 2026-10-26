/**
 * 决策缓存回归测试——对应评审意见（2026-10）：
 *
 *   "The authorization soft cache can reuse a low-risk result for different
 *    tool arguments. Please bind authorization caching to the full
 *    call/context, or disable soft reuse for this check."
 *
 * 修复采用「禁用授权软复用」方案，并把软缓存翻成 fail-closed：
 * 只有调用方显式传 `softCacheable: true` 才启用。这里验证：
 *
 *   1. 授权（authorize）对**不同参数**的同类调用绝不复用——必须重新请求；
 *   2. 授权的精确复用仍然有效（完整 state 一致才命中）；
 *   3. state 的任一字段（cwd / recent）不同都会使精确键失配；
 *   4. 传了 signatureText 但未显式声明 softCacheable:true —— 不建软键
 *      （旧适配器风格的函数形式同样被忽略）；
 *   5. 显式声明 softCacheable:true 的调用方仍可用软层（文档化该出口）；
 *   6. 授权裁决的下游语义（decideGuard）不受影响。
 *
 * 全部走假的 fetchFn，不打网络、不碰文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { StartluxClient, decideGuard, extractGuardAnswers } from "../lib/index.js";
import { POINT_SPECS } from "../lib/points/spec.js";

const LOW_RISK_ANSWERS = {
  risk: { type: "choice", choice: "low", confidence: 0.9 },
  irreversible: { type: "noul", noul: 0.05 },
  matches_task: { type: "noul", noul: 0.9 },
  injection_suspect: { type: "noul", noul: 0.05 },
};

/** 造一个带假 fetch 的 client。answers 可覆盖，fetches 记录每次真实请求体。 */
function makeClient({ answers = LOW_RISK_ANSWERS, cfg: cfgOver = {} } = {}) {
  const fetches = [];
  const cfg = {
    provider: "bamboonode",
    bamboonodeApiKey: "test-key",
    cacheSize: 256,
    cacheTtlMs: 600000,
    timeoutMs: 5000,
    thinkMode: "never",
    mode: "shadow",
    guardEnabled: true,
    ...cfgOver,
  };
  const client = new StartluxClient({
    getConfig: () => cfg,
    logger: { warn() {}, info() {} },
    fetchFn: async () => {
      fetches.push(1);
      return new Response(
        JSON.stringify({ answers, model: "test-model", usage: { input_tokens: 10 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, fetches, cfg };
}

/** 造一次与 guardListener 同构的 authorize 调用。 */
function authorizeCall({ command, cwd = "/tmp", recent = "" }) {
  return {
    point: "authorize",
    tag: "guard",
    mode: "shadow",
    tool: "bash",
    state: { tool: "bash", args_preview: JSON.stringify({ command }), recent, cwd },
    questions: {
      risk: { type: "choice", instructions: "q", criteria: ["low", "medium", "high"] },
      irreversible: { type: "noul", instructions: "q" },
      matches_task: { type: "noul", instructions: "q" },
      injection_suspect: { type: "noul", instructions: "q" },
    },
  };
}

test("评审场景：同族不同参数的 authorize 调用不得复用低风险放行", async () => {
  const { client, fetches } = makeClient();
  // 第一次：无害的 node 调试命令 → 判低风险放行。
  const first = await client.classify(authorizeCall({ command: "node -e 'fs.writeFileSync(\"/tmp/a\",\"hi\")'" }));
  assert.equal(first.cached, false);
  assert.equal(fetches.length, 1);
  // 第二次：参数完全不同、危险性高得多的同类命令 —— 软键族名/风险标记一致，
  // 修复前会命中「低风险放行」的软缓存，修复后必须重新请求。
  const second = await client.classify(authorizeCall({ command: "node -e 'fs.rmSync(\"/Users/chi/Code\",{recursive:true})'" }));
  assert.equal(second.cached, false, "不同参数必须各自请求，不得同类复用");
  assert.equal(fetches.length, 2);
  // rm 命中的是同一条真实路径（no-op 与真删除的区别只在参数）。
  const third = await client.classify(authorizeCall({ command: "rm -rf /Users/chi/important" }));
  assert.equal(third.cached, false);
  assert.equal(fetches.length, 3);
});

test("authorize 不得向缓存写入任何软键", async () => {
  const { client } = makeClient();
  await client.classify(authorizeCall({ command: "node -e 'a'" }));
  await client.classify(authorizeCall({ command: "node -e 'b'" }));
  for (const key of client.cache.map.keys()) {
    assert.ok(!key.startsWith("s:"), `缓存里不该有软键，发现 ${key.slice(0, 24)}…`);
  }
});

test("authorize 的精确复用仍然有效（完整 state 一致才命中）", async () => {
  const { client, fetches } = makeClient();
  const call = authorizeCall({ command: "node -e 'same'" });
  const first = await client.classify(call);
  assert.equal(first.cached, false);
  const second = await client.classify({ ...call });
  assert.equal(second.cached, true, "完全相同的 state + questions 应命中精确键");
  assert.equal(fetches.length, 1);
});

test("state 任一字段不同（cwd / recent）都会使精确键失配", async () => {
  const { client, fetches } = makeClient();
  await client.classify(authorizeCall({ command: "node -e 'x'", cwd: "/tmp" }));
  await client.classify(authorizeCall({ command: "node -e 'x'", cwd: "/home/chi" }));
  assert.equal(fetches.length, 2, "cwd 变了必须重新判断");
  await client.classify(authorizeCall({ command: "node -e 'x'", cwd: "/home/chi", recent: "新上下文" }));
  assert.equal(fetches.length, 3, "recent 变了必须重新判断");
});

test("fail-closed：只传 signatureText 不声明 softCacheable 不建软键", async () => {
  const { client, fetches } = makeClient();
  // 每次调用 state 唯一，确保精确键失配——这样第二次是否发请求只取决于软层。
  const call = (n) => ({
    point: "route",
    tag: "route",
    mode: "shadow",
    state: { n },
    questions: { q: { type: "noul", instructions: "x" } },
    signatureText: "node -e 'AAA'",
  });
  await client.classify(call(1));
  await client.classify(call(2));
  assert.equal(fetches.length, 2, "未显式声明 softCacheable 时签名不得启用软缓存");
  for (const key of client.cache.map.keys()) {
    assert.ok(!key.startsWith("s:"));
  }
});

test("fail-closed：旧适配器风格的 softCacheable 函数形式被忽略", async () => {
  const { client, fetches } = makeClient();
  const call = (n, sig) => ({
    point: "retrieval",
    tag: "retrieval",
    mode: "shadow",
    state: { n },
    questions: { q: { type: "noul", instructions: "x" } },
    signatureText: sig,
    softCacheable: () => true,
  });
  await client.classify(call(1, "query one"));
  await client.classify(call(2, "query two"));
  assert.equal(fetches.length, 2, "函数形式不再被接受——软缓存只认显式 true");
});

test("显式 softCacheable: true 的调用方仍可使用软层（文档化出口）", async () => {
  const { client, fetches } = makeClient();
  // state 唯一（精确键必失配），signatureText 同族——第二次命中只能来自软层。
  const call = (n, tool, sig) => ({
    point: "title",
    tag: "title",
    mode: "shadow",
    state: { n },
    questions: { q: { type: "noul", instructions: "x" } },
    softCacheable: true,
    tool,
    signatureText: sig,
  });
  await client.classify(call(1, "web_search", "node -e 'AAA'"));
  // 同点 + 同工具 + 同族（node）+ 同风险标记 → 软键一致 → 命中。
  const hit = await client.classify(call(2, "web_search", "node -e 'BBB'"));
  assert.equal(hit.cached, true, "显式声明的调用方按声明获得同类复用");
  assert.equal(fetches.length, 1);
  // 工具名不同 → 软键不同 → 不复用（软层的点内/工具内隔离仍在）。
  const otherTool = await client.classify(call(3, "web_fetch", "node -e 'CCC'"));
  assert.equal(otherTool.cached, false);
  assert.equal(fetches.length, 2);
});

test("授权裁决的下游语义不受缓存改造影响", async () => {
  const { client } = makeClient();
  const result = await client.classify(authorizeCall({ command: "node -e 'write'" }));
  const parsed = extractGuardAnswers(result.answers);
  assert.notEqual(parsed, undefined);
  assert.equal(decideGuard(parsed, { guardInjectionAskThreshold: 0.6 }).kind, "delegate");
});

test("各决策点的 spec.build 不再返回 signatureText", () => {
  const inputs = {
    route: { turn: 1, step: 1, current: { provider: "p", model: "m" } },
    delegate: { turn: 1, step: 1, incoming: "task" },
    compact: { totalTokens: 1, triggerTokens: 1 },
    turnStop: { turn: 1, last: "text" },
    retrieval: { tool: "web_search", query: "q" },
    skillPick: { requested: "x", candidates: [{ name: "a", description: "d" }] },
    cotTranslate: { text: "hello prose world", head: "hello prose world" },
  };
  for (const [id, spec] of Object.entries(POINT_SPECS)) {
    if (id === "authorize") continue; // authorize 不在 POINT_SPECS 里，走手写守卫
    const built = spec.build(inputs[id] ?? {});
    assert.equal(built.signatureText, undefined, `${id} 不应再传递软缓存签名`);
  }
});
