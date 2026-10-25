/**
 * 端点回退的单元测试。
 *
 * 背景见 docs/lessons/endpoint-path-vs-model.md：路径后缀由**服务商**决定，
 * 不由模型决定（实测 SiliconFlow 的 Kev-4B 只通 /v1/systemone）。旧实现
 * 只拼一条路径，踩空就是 404 + 静默降级——守卫 fail-open，于是「配了没反应」。
 *
 * 这里只测纯逻辑（零依赖、零网络）：候选顺序、404 才换路径、记忆与提升。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PATH_MISS_STATUS,
  EndpointMemory,
  sendWithEndpointFallback,
} from "../lib/endpoint-fallback.js";
import { endpointCandidates, resolveProvider } from "../lib/providers.js";

/** 造一个最小 Response 替身。 */
const fakeResponse = (status) => ({ status, body: { cancel: async () => {} } });

test("404 会换下一条候选再试", async () => {
  const tried = [];
  const result = await sendWithEndpointFallback(
    ["https://x.dev/v1/decisions", "https://x.dev/v1/systemone"],
    async (endpoint) => {
      tried.push(endpoint);
      return endpoint.endsWith("/systemone") ? fakeResponse(200) : fakeResponse(404);
    },
  );
  assert.deepEqual(tried, ["https://x.dev/v1/decisions", "https://x.dev/v1/systemone"]);
  assert.equal(result.endpoint, "https://x.dev/v1/systemone");
  assert.equal(result.response.status, 200);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].status, 404);
});

test("400 不换路径：换路径对「模型/内容不合法」无用", async () => {
  const tried = [];
  const result = await sendWithEndpointFallback(
    ["https://x.dev/v1/decisions", "https://x.dev/v1/systemone"],
    async (endpoint) => {
      tried.push(endpoint);
      return fakeResponse(400);
    },
  );
  assert.deepEqual(tried, ["https://x.dev/v1/decisions"], "400 时不该再打第二条路径");
  assert.equal(result.response.status, 400);
});

test("401 / 5xx 同样不换路径", async () => {
  for (const status of [401, 403, 500, 503]) {
    const tried = [];
    await sendWithEndpointFallback(
      ["https://x.dev/v1/decisions", "https://x.dev/v1/systemone"],
      async (endpoint) => {
        tried.push(endpoint);
        return fakeResponse(status);
      },
    );
    assert.deepEqual(tried, ["https://x.dev/v1/decisions"], `HTTP ${status} 时不该换路径`);
  }
});

test("网络异常直接上抛，不换路径重试", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      sendWithEndpointFallback(
        ["https://x.dev/v1/decisions", "https://x.dev/v1/systemone"],
        async () => {
          calls += 1;
          throw new Error("ECONNREFUSED");
        },
      ),
    /ECONNREFUSED/,
  );
  assert.equal(calls, 1, "网络失败对所有候选都一样，重试只是把一次失败变两次");
});

test("候选为空时不会发请求", async () => {
  let calls = 0;
  const result = await sendWithEndpointFallback([], async () => {
    calls += 1;
    return fakeResponse(200);
  });
  assert.equal(calls, 0);
  assert.equal(result.response, undefined);
  assert.deepEqual(result.attempts, []);
});

test("换路径前会丢弃上一条失败的响应体（不挂住连接）", async () => {
  let cancelled = 0;
  await sendWithEndpointFallback(
    ["https://x.dev/v1/decisions", "https://x.dev/v1/systemone"],
    async (endpoint) => ({
      status: endpoint.endsWith("/systemone") ? 200 : PATH_MISS_STATUS,
      body: {
        cancel: async () => {
          cancelled += 1;
        },
      },
    }),
  );
  assert.equal(cancelled, 1, "404 换路径前应取消上一条响应体");
});

// ---- 候选生成 -------------------------------------------------------------

test("auto 风格：decisions 优先，systemone 兜底", () => {
  const candidates = endpointCandidates("https://api.siliconflow.cn/v1", "auto");
  assert.deepEqual(candidates, [
    "https://api.siliconflow.cn/v1/decisions",
    "https://api.siliconflow.cn/v1/systemone",
  ]);
});

test("显式指定 systemone：systemone 优先，decisions 兜底", () => {
  const candidates = endpointCandidates("https://api.siliconflow.cn/v1", "systemone");
  assert.deepEqual(candidates, [
    "https://api.siliconflow.cn/v1/systemone",
    "https://api.siliconflow.cn/v1/decisions",
  ]);
});

test("地址已自带端点时只给一个候选（用户的明确决定不被改写）", () => {
  for (const url of [
    "https://gw.example.com/v1/systemone",
    "https://gw.example.com/v1/decisions",
  ]) {
    const candidates = endpointCandidates(url, "auto");
    assert.deepEqual(candidates, [url.replace(/\/+$/, "")], `${url} 不该被追加候选`);
  }
});

test("只有 origin 时补 /v1/<段>，另一条路径也带上", () => {
  const candidates = endpointCandidates("https://gw.example.com", "auto");
  assert.deepEqual(candidates, [
    "https://gw.example.com/v1/decisions",
    "https://gw.example.com/v1/systemone",
  ]);
});

test("resolveProvider 暴露候选端点", () => {
  const provider = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://api.siliconflow.cn/v1",
    customEndpointStyle: "auto",
  });
  assert.deepEqual(provider.candidates, [
    "https://api.siliconflow.cn/v1/decisions",
    "https://api.siliconflow.cn/v1/systemone",
  ]);
  // 主端点仍是首选（不改变既有行为）。
  assert.equal(provider.endpoint, "https://api.siliconflow.cn/v1/decisions");
});

test("内置 systemone 预设的候选以 /systemone 开头", () => {
  const provider = resolveProvider({ provider: "systemone" });
  assert.equal(provider.candidates[0], "https://api.typesafe.ai/v1/systemone");
  assert.equal(provider.candidates.length, 2);
});

// ---- 记忆 -----------------------------------------------------------------

test("记忆：验证过的路径会被提到候选最前", () => {
  const memory = new EndpointMemory();
  const base = "https://api.siliconflow.cn/v1";
  const candidates = ["https://api.siliconflow.cn/v1/decisions", "https://api.siliconflow.cn/v1/systemone"];
  memory.record(base, "https://api.siliconflow.cn/v1/systemone", "systemone");
  const ordered = memory.order(base, candidates);
  assert.equal(ordered[0], "https://api.siliconflow.cn/v1/systemone");
  assert.equal(ordered.length, 2, "提升不应丢掉其它候选");
});

test("记忆按 base URL 隔离：A 服务商的结论不会套到 B 服务商", () => {
  const memory = new EndpointMemory();
  memory.record("https://a.dev/v1", "https://a.dev/v1/systemone", "systemone");
  const ordered = memory.order("https://b.dev/v1", [
    "https://b.dev/v1/decisions",
    "https://b.dev/v1/systemone",
  ]);
  assert.equal(ordered[0], "https://b.dev/v1/decisions", "B 还没有探测结论，不该被 A 污染");
});

test("记忆：换过地址后旧结论不再插队", () => {
  const memory = new EndpointMemory();
  memory.record("https://a.dev/v1", "https://a.dev/v1/systemone", "systemone");
  // 候选里已经没有那条端点了（用户改了端点风格）：不该强行插队。
  const ordered = memory.order("https://a.dev/v1", ["https://a.dev/v1/decisions"]);
  assert.deepEqual(ordered, ["https://a.dev/v1/decisions"]);
});
