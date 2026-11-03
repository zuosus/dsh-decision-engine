/**
 * 服务端下发配置源（lib/server-config.js）的验收测试。
 *
 * 这一层必须有测试，因为它的失败模式**都不会报错**：
 *
 *   - 取不到配置却当成取到了 → 上层把手里的 key 打向一个空地址；
 *   - 失败重试下限没生效 → 服务端一抖，每次决策都补一发后台请求；
 *   - status() 里漏出明文 key → 它会进日志与界面，而这是服务端账号的凭据。
 *
 * 三者都只能靠断言把住。因此这里**不发任何真实请求**：`fetchImpl` 与 `clock`
 * 全部注入，超时也通过注入时钟覆盖（否则每条超时用例都要真等 5 秒）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  REQUEST_TIMEOUT_MS,
  RETRY_FLOOR_MS,
  SERVER_CONFIG_ENDPOINT,
  ServerConfigSource,
  parseServerConfig,
} from "../lib/server-config.js";

/** 一个醒目到不可能「碰巧出现在别处」的假 key，用来做反断言。 */
const FAKE_KEY = "sk-test-DEADBEEF-1234";

/** 可控时钟：注入后超时、过期、重试下限都不必等真实时间。 */
function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  return clock;
}

/** 只实现本模块用到的部分（status + json）的假响应。 */
function jsonResponse(body, status = 200) {
  return { status, json: async () => body };
}

/** 记录调用参数的 fetch 桩。 */
function stubFetch(responder) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  return { impl, calls: () => calls };
}

/** 合法下发体。 */
const OK_BODY = {
  ok: true,
  v: 1,
  baseUrl: "https://gw.example.com/v1",
  model: "m-1",
  endpointStyle: "systemone",
  key: FAKE_KEY,
  ttlSeconds: 120,
};

/** 一个「每次刷新都成功」的源。 */
function readySource(overrides = {}) {
  const clock = makeClock();
  const { impl, calls } = stubFetch(() => jsonResponse(OK_BODY));
  const source = new ServerConfigSource({ fetchImpl: impl, clock, ...overrides });
  return { source, calls, clock };
}

// ------------------------------------------------------- parseServerConfig

test("parseServerConfig 常量与冻结接口一致", () => {
  assert.equal(SERVER_CONFIG_ENDPOINT, "https://dsh.zuos.us/api/provider-config");
  assert.equal(DEFAULT_TTL_SECONDS, 600);
  assert.equal(MIN_TTL_SECONDS, 60);
  assert.equal(MAX_TTL_SECONDS, 3600);
  assert.equal(REQUEST_TIMEOUT_MS, 5000);
  assert.equal(RETRY_FLOOR_MS, 30000);
});

test("parseServerConfig 接受合法配置并归一字段", () => {
  const parsed = parseServerConfig({ ...OK_BODY, baseUrl: "https://gw.example.com/v1/", key: `  ${FAKE_KEY}  ` });
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed.value), ["baseUrl", "model", "endpointStyle", "key", "ttlSeconds"]);
  // base URL 去掉结尾斜杠、key 去掉首尾空白：两者都会被拿去拼接与发送。
  assert.equal(parsed.value.baseUrl, "https://gw.example.com/v1");
  assert.equal(parsed.value.key, FAKE_KEY);
  assert.equal(parsed.value.model, "m-1");
  assert.equal(parsed.value.endpointStyle, "systemone");
  assert.equal(parsed.value.ttlSeconds, 120);
});

test("parseServerConfig 缺省值：endpointStyle=auto、ttl=默认、model 空串", () => {
  const parsed = parseServerConfig({ ok: true, v: 1, baseUrl: "https://gw.example.com/v1", key: FAKE_KEY });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.endpointStyle, "auto");
  assert.equal(parsed.value.model, "");
  assert.equal(parsed.value.ttlSeconds, DEFAULT_TTL_SECONDS);
});

test("parseServerConfig 拒绝非对象输入", () => {
  for (const bad of [null, undefined, "x", 42, [], true, () => {}]) {
    const result = parseServerConfig(bad);
    assert.equal(result.ok, false, `输入 ${String(bad)} 应被拒绝`);
    assert.ok(/[\u4e00-\u9fa5]/.test(result.error), `错误应为可展示的中文：${result.error}`);
  }
});

test("parseServerConfig 要求 ok===true 且 v===1", () => {
  for (const ok of [undefined, false, "true", 1, null]) {
    assert.equal(parseServerConfig({ ...OK_BODY, ok }).ok, false, `ok=${String(ok)}`);
  }
  for (const v of [undefined, 0, 2, "1", null, 1.5]) {
    assert.equal(parseServerConfig({ ...OK_BODY, v }).ok, false, `v=${String(v)}`);
  }
});

test("parseServerConfig 拒绝非法 baseUrl（整笔不生效）", () => {
  const bad = [
    ["", "空"],
    ["   ", "只有空白"],
    ["gw.example.com/v1", "缺 scheme"],
    ["ftp://gw.example.com/v1", "非 http(s)"],
    ["https://gw.example.com/v1?x=1", "带查询串"],
    ["https://", "缺主机名"],
    ["https://gw example.com/v1", "含空格"],
  ];
  for (const [baseUrl, why] of bad) {
    const result = parseServerConfig({ ...OK_BODY, baseUrl });
    assert.equal(result.ok, false, `${why} 应被拒绝：${baseUrl}`);
    assert.ok(/[\u4e00-\u9fa5]/.test(result.error), `${why} 的错误应为中文：${result.error}`);
    assert.ok(!result.error.includes(FAKE_KEY), "错误文案不得带出 key");
  }
});

test("parseServerConfig 要求非空 key", () => {
  for (const key of [undefined, null, "", "   ", 42, {}, []]) {
    const result = parseServerConfig({ ...OK_BODY, key });
    assert.equal(result.ok, false, `key=${JSON.stringify(key)} 应被拒绝`);
  }
  // 前后空白要 trim 掉：带空白的 key 会拼出非法的鉴权头。
  assert.equal(parseServerConfig({ ...OK_BODY, key: ` ${FAKE_KEY} ` }).value.key, FAKE_KEY);
});

test("parseServerConfig 允许空 model（= 上层省略 model 字段）", () => {
  const parsed = parseServerConfig({ ...OK_BODY, model: "" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.model, "");
  // model 缺失时同样按空处理，而不是拒绝：省略 model 是合法语义。
  assert.equal(parseServerConfig({ ...OK_BODY, model: undefined }).value.model, "");
});

test("parseServerConfig 对非法 endpointStyle 整笔拒绝而不是静默改 auto", () => {
  for (const endpointStyle of ["bogus", "", null, "DECISIONS", 1, {}]) {
    const result = parseServerConfig({ ...OK_BODY, endpointStyle });
    assert.equal(result.ok, false, `endpointStyle=${JSON.stringify(endpointStyle)} 应整笔拒绝`);
  }
  // 三个合法取值原样保留。
  for (const style of ["auto", "decisions", "systemone"]) {
    assert.equal(parseServerConfig({ ...OK_BODY, endpointStyle: style }).value.endpointStyle, style);
  }
});

test("parseServerConfig 夹取 ttlSeconds 并拒绝非有穷数字", () => {
  assert.equal(parseServerConfig({ ...OK_BODY, ttlSeconds: 1 }).value.ttlSeconds, MIN_TTL_SECONDS);
  assert.equal(parseServerConfig({ ...OK_BODY, ttlSeconds: 99999 }).value.ttlSeconds, MAX_TTL_SECONDS);
  assert.equal(parseServerConfig({ ...OK_BODY, ttlSeconds: MIN_TTL_SECONDS }).value.ttlSeconds, MIN_TTL_SECONDS);
  assert.equal(parseServerConfig({ ...OK_BODY, ttlSeconds: MAX_TTL_SECONDS }).value.ttlSeconds, MAX_TTL_SECONDS);
  assert.equal(parseServerConfig({ ...OK_BODY, ttlSeconds: undefined }).value.ttlSeconds, DEFAULT_TTL_SECONDS);
  for (const ttlSeconds of [NaN, Infinity, -Infinity, "600", null, {}]) {
    assert.equal(parseServerConfig({ ...OK_BODY, ttlSeconds }).ok, false, `ttlSeconds=${String(ttlSeconds)}`);
  }
});

// ------------------------------------------------------ ServerConfigSource

test("成功刷新后 ready：值可用、字段齐全、请求形状正确", async () => {
  const { source, calls, clock } = readySource();
  assert.equal(source.usable(), false);
  assert.equal(source.status().status, "idle");

  const result = await source.refresh();
  assert.deepEqual(result, { ok: true, error: "" });
  assert.equal(source.usable(), true);
  const status = source.status();
  assert.equal(status.status, "ready");
  assert.equal(status.error, "");
  assert.equal(status.usable, true);
  assert.equal(status.expired, false);
  assert.equal(status.keyHint, "…1234");
  assert.equal(status.baseUrl, "https://gw.example.com/v1");
  assert.equal(status.model, "m-1");
  assert.equal(status.endpointStyle, "systemone");
  assert.equal(status.fetchedAt, clock());
  assert.equal(status.expiresAt, clock() + 120_000);
  assert.equal(source.value().key, FAKE_KEY);
  assert.equal(source.value().ttlSeconds, 120);

  assert.equal(calls().length, 1);
  assert.equal(calls()[0].url, SERVER_CONFIG_ENDPOINT);
  assert.equal(calls()[0].options.method, "GET");
  assert.equal(calls()[0].options.headers.accept, "application/json");
  assert.equal("x-provider-token" in calls()[0].options.headers, false);
  assert.notEqual(calls()[0].options.signal, undefined, "必须把 AbortSignal 交给 fetch");
});

test("token 非空时带 x-provider-token，为空时不带", async () => {
  const withToken = readySource({ token: "tok-1" });
  await withToken.source.refresh();
  assert.equal(withToken.calls()[0].options.headers["x-provider-token"], "tok-1");

  for (const token of [undefined, "", "   "]) {
    const blank = readySource({ token });
    await blank.source.refresh();
    assert.equal("x-provider-token" in blank.calls()[0].options.headers, false, `token=${String(token)}`);
  }
});

test("可自定义下发端点", async () => {
  const { source, calls } = readySource({ endpoint: "https://example.com/provider-config" });
  await source.refresh();
  assert.equal(calls()[0].url, "https://example.com/provider-config");
});

test("fetch 在调用时惰性解析：构造之后再打桩 globalThis.fetch 也生效", async () => {
  const clock = makeClock();
  const original = globalThis.fetch;
  const { impl, calls } = stubFetch(() => jsonResponse(OK_BODY));
  try {
    globalThis.fetch = undefined;
    // 构造时全局 fetch 不存在，也不该失败——真正取用发生在 refresh()。
    const source = new ServerConfigSource({ clock });
    globalThis.fetch = impl;
    const result = await source.refresh();
    assert.equal(result.ok, true);
    assert.equal(calls().length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("超时：永不 resolve 的 fetch 也不会挂住，降级为 error", async () => {
  const clock = makeClock();
  let calls = 0;
  const never = () => {
    calls += 1;
    return new Promise(() => {});
  };
  const source = new ServerConfigSource({ fetchImpl: never, clock });

  const pending = source.refresh();
  // 在途状态必须在真正 await 之前就能看到，界面才画得出「正在刷新」。
  assert.equal(source.status().status, "loading");

  // 推进注入时钟越过超时点：定时器轮询会据此判定超时。
  clock.advance(REQUEST_TIMEOUT_MS + 1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0, "超时必须给出可展示的原因");
  assert.equal(calls, 1);
  assert.equal(source.usable(), false);
  const status = source.status();
  assert.equal(status.status, "error");
  assert.equal(status.expired, false);
  assert.equal(status.baseUrl, "");
  assert.equal(source.value(), undefined);
});

test("网络异常、非 2xx、非 JSON 一律降级为 error 且不抛", async () => {
  const cases = [
    ["网络异常", async () => { throw new Error("ECONNREFUSED 127.0.0.1:443"); }],
    ["403", async () => ({ status: 403, json: async () => ({}) })],
    ["404", async () => ({ status: 404, json: async () => ({}) })],
    ["500", async () => ({ status: 500, json: async () => ({}) })],
    ["非 JSON", async () => ({ status: 200, json: async () => { throw new SyntaxError(`Unexpected token 's', "${FAKE_KEY}" is not valid JSON`); } })],
    ["body 不是对象", async () => jsonResponse("nope")],
    ["body 校验不通过", async () => jsonResponse({ ...OK_BODY, ok: false })],
  ];
  for (const [why, responder] of cases) {
    // 不 try/catch 地 await：一旦抛错，这条用例就失败（"绝不抛" 由它把住）。
    const source = new ServerConfigSource({ fetchImpl: responder, clock: makeClock() });
    const result = await source.refresh();
    assert.equal(result.ok, false, `${why} 应失败`);
    assert.ok(result.error.length > 0, `${why} 应有可展示的原因`);
    assert.equal(source.usable(), false, `${why} 不应产生可用值`);
    assert.equal(source.status().status, "error", why);
    assert.equal(source.value(), undefined, why);
    assert.ok(!JSON.stringify(source.status()).includes(FAKE_KEY), `${why} 的状态里不得带出 key`);
  }
  // 403 / 404 的错误文案要能看出是哪个状态码，否则用户无从判断该改什么。
  const forbidden = new ServerConfigSource({
    fetchImpl: async () => ({ status: 403, json: async () => ({}) }),
    clock: makeClock(),
  });
  assert.ok((await forbidden.refresh()).error.includes("403"));
  const missing = new ServerConfigSource({
    fetchImpl: async () => ({ status: 404, json: async () => ({}) }),
    clock: makeClock(),
  });
  assert.ok((await missing.refresh()).error.includes("404"));
});

test("status() 与它的 JSON 序列化都不含明文 key", async () => {
  const { source } = readySource();
  await source.refresh();
  const status = source.status();
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(FAKE_KEY), `状态里出现了明文 key：${serialized}`);
  assert.ok(!serialized.includes("DEADBEEF"), "连 key 的主体部分也不该出现");
  assert.equal(status.keyHint, "…1234");

  // 失败路径同样不能泄漏：响应体恰是 key、JSON 解析失败的报错原文里就带着它。
  const leaky = new ServerConfigSource({
    fetchImpl: async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token 's', "${FAKE_KEY}" is not valid JSON`);
      },
    }),
    clock: makeClock(),
  });
  await leaky.refresh();
  assert.equal(leaky.status().status, "error");
  assert.ok(!JSON.stringify(leaky.status()).includes(FAKE_KEY), "解析失败的原文不得进状态");
});

test("过期：clock 越过 expiresAt 后 usable false、expired true", async () => {
  const { source, clock } = readySource();
  await source.refresh();

  clock.advance(120_000 - 1);
  assert.equal(source.usable(), true, "到期前一毫秒仍应可用");
  clock.advance(2);
  assert.equal(source.usable(), false, "越过到期点即不可用");

  const status = source.status();
  assert.equal(status.expired, true);
  assert.equal(status.status, "error");
  assert.equal(status.error, "服务端配置已过期");
  assert.equal(status.usable, false);
  // 展示字段仍用内存里的旧值（用户要看到「上一份是什么」）。
  assert.equal(status.baseUrl, "https://gw.example.com/v1");
  assert.equal(status.keyHint, "…1234");
  // value() 本身不因过期清空：能不能用由 usable() 回答，调用方必须先过滤。
  assert.equal(source.value().key, FAKE_KEY);
});

test("刷新失败保留未过期的旧值", async () => {
  const clock = makeClock();
  let failing = false;
  const source = new ServerConfigSource({
    fetchImpl: async () => {
      if (failing) throw new Error("offline");
      return jsonResponse(OK_BODY);
    },
    clock,
  });
  await source.refresh();
  assert.equal(source.usable(), true);

  failing = true;
  const result = await source.refresh();
  assert.equal(result.ok, false);
  // 这是本模块最重要的一条：一次失败不该让整台机器丢掉可用的配置。
  assert.equal(source.usable(), true, "旧值未过期时必须继续可用");
  assert.equal(source.value().key, FAKE_KEY);
  const status = source.status();
  assert.equal(status.status, "ready");
  assert.ok(status.error.includes("offline"), `失败原因要能展示：${status.error}`);
});

test("并发去重：同一时刻两次 refresh 只打一发 fetch", async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return jsonResponse(OK_BODY);
  };
  const source = new ServerConfigSource({ fetchImpl: impl, clock: makeClock() });
  const [first, second] = await Promise.all([source.refresh(), source.refresh()]);
  assert.equal(calls, 1, "并发刷新必须复用同一个在途请求");
  assert.deepEqual(first, { ok: true, error: "" });
  assert.deepEqual(second, { ok: true, error: "" });
  assert.equal(source.status().status, "ready");
});

test("失败重试下限：非 force 跳过，越界后恢复，force 立即放行", async () => {
  const clock = makeClock();
  let calls = 0;
  const source = new ServerConfigSource({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
    clock,
  });

  assert.equal((await source.refresh()).ok, false);
  assert.equal(calls, 1);

  clock.advance(RETRY_FLOOR_MS - 1);
  const skipped = await source.refresh();
  assert.equal(skipped.ok, false);
  assert.equal(skipped.error, "retry-floor");
  assert.equal(calls, 1, "下限内不得再打请求");

  clock.advance(1);
  await source.refresh();
  assert.equal(calls, 2, "越过下限后应恢复重试");

  clock.advance(0);
  await source.refresh({ force: true });
  assert.equal(calls, 3, "force 必须忽略下限");

  // 成功之后下限不该继续卡住刷新：否则「刷新成功却 30 秒内不再刷新」的怪现象。
  const healthy = new ServerConfigSource({ fetchImpl: async () => jsonResponse(OK_BODY), clock });
  await healthy.refresh();
  clock.advance(1);
  assert.equal((await healthy.refresh()).ok, true);
});

test("clear() 清空全部内存字段", async () => {
  const { source } = readySource();
  await source.refresh();
  source.clear();

  assert.equal(source.value(), undefined);
  assert.equal(source.usable(), false);
  const status = source.status();
  assert.equal(status.status, "idle");
  assert.equal(status.error, "");
  assert.equal(status.keyHint, "");
  assert.equal(status.baseUrl, "");
  assert.equal(status.model, "");
  assert.equal(status.endpointStyle, "");
  assert.equal(status.fetchedAt, 0);
  assert.equal(status.expiresAt, 0);
  assert.equal(status.expired, false);
});

test("clear() 之后在途请求的结果被丢弃，不会把值写回来", async () => {
  const clock = makeClock();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const source = new ServerConfigSource({
    fetchImpl: async () => {
      await gate;
      return jsonResponse(OK_BODY);
    },
    clock,
  });

  const pending = source.refresh();
  source.clear();
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(source.value(), undefined, "清空后返回的在途结果不得落进内存");
  assert.equal(source.usable(), false);
  assert.equal(source.status().status, "idle");
});

test("日志只报一次，且只含状态与端点、不含 key", async () => {
  const logs = [];
  const clock = makeClock();
  const source = new ServerConfigSource({
    fetchImpl: async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError(FAKE_KEY);
      },
    }),
    clock,
    logger: { warn: (message) => logs.push(message) },
  });

  await source.refresh();
  clock.advance(RETRY_FLOOR_MS);
  await source.refresh();
  assert.equal(logs.length, 1, "同一实例只允许告警一次，避免日志被刷爆");
  assert.ok(logs[0].includes(SERVER_CONFIG_ENDPOINT), "告警要能定位到端点");
  assert.ok(!logs[0].includes(FAKE_KEY), "日志里绝不允许出现明文 key");

  // 注入的日志器抛错不能反过来把刷新打挂。
  const throwing = new ServerConfigSource({
    fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
    clock: makeClock(),
    logger: {
      warn: () => {
        throw new Error("logger boom");
      },
    },
  });
  const result = await throwing.refresh();
  assert.equal(result.ok, false);
});

test("lib/server-config.js 不依赖文件系统（静态断言）", () => {
  const source = readFileSync(new URL("../lib/server-config.js", import.meta.url), "utf8");
  for (const needle of ["node:fs", 'require("fs")', "writeFile"]) {
    assert.equal(source.includes(needle), false, `server-config.js 不应出现 ${needle}`);
  }
  // 只允许从 providers.js 引入纯函数：任何第三方依赖都会破坏「零依赖」。
  assert.equal((source.match(/^import .*from /gm) ?? []).length, 1);
  assert.ok(source.includes('from "./providers.js"'));
});