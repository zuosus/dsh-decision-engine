/**
 * 「连续多次慢调用」判定的测试。
 *
 * 防的是这几类错：
 *
 *   1. **口径漂移**——阈值写成 `>= 10000`，把「恰好 10 秒」也算成超时；
 *      用户原文是「超过 10s」，边界必须逐字对齐。
 *   2. **缓存命中被当成一次快调用**——命中时根本没发请求、耗时 0，若拿它
 *      去打断连续段，真机上「偶发命中一次就永远报不出来」。
 *   3. **降级记录被当成快调用**——降级的耗时里混着「发出去并超时」与
 *      「缺 key / 地址非法，根本没发」，两者分不开。只有当它超过阈值时
 *      才确定「真等了这么久」，否则一律不参与判定。
 *   4. **只计数不清零**——一次快调用之后警告必须消失，否则「慢过一次就
 *      永远红着」，用户很快学会无视它。
 *   5. **监视器没接上**——服务端建了监视器却没交给客户端，或路由读的是一个
 *      空对象：界面永远显示「正常」，而这条警告的意义就是「它该亮的时候亮」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SLOW_CALL_STREAK,
  SLOW_CALL_THRESHOLD_MS,
  classifySlowCall,
  createSlowCallMonitor,
} from "../lib/slow-calls.js";
import { apply, StartluxClient } from "../lib/index.js";

/** 一条「真实请求」样本：发出去了、拿到了回复。 */
function sample(durationMs, over = {}) {
  return { durationMs, cached: false, degraded: false, ...over };
}

test("默认口径：阈值 10 秒、连续 5 次", () => {
  assert.equal(SLOW_CALL_THRESHOLD_MS, 10000);
  assert.equal(SLOW_CALL_STREAK, 5);
});

test("阈值边界：恰好 10 秒不算超时，多 1ms 才算", () => {
  assert.equal(classifySlowCall(sample(10000)), "fast");
  assert.equal(classifySlowCall(sample(10001)), "slow");
});

test("缓存命中不参与判定（没有发出请求）", () => {
  assert.equal(classifySlowCall(sample(0, { cached: true })), "skip");
  // 即便记录上带了很长的耗时，命中也不是一次真实往返。
  assert.equal(classifySlowCall(sample(15000, { cached: true })), "skip");
});

test("降级记录：未超阈值时无法断定，超阈值时算慢", () => {
  assert.equal(classifySlowCall(sample(300, { degraded: true })), "skip");
  assert.equal(classifySlowCall(sample(12000, { degraded: true })), "slow");
});

test("畸形耗时一律不判定，绝不猜成 0", () => {
  assert.equal(classifySlowCall(undefined), "skip");
  assert.equal(classifySlowCall({}), "skip");
  assert.equal(classifySlowCall({ durationMs: Number.NaN }), "skip");
  assert.equal(classifySlowCall({ durationMs: -1 }), "skip");
  assert.equal(classifySlowCall({ durationMs: "12000" }), "skip");
});

test("连续到第 5 次才报警，前面 4 次只是计数", () => {
  const monitor = createSlowCallMonitor();
  for (let index = 0; index < 4; index += 1) {
    const status = monitor.observe(sample(12000));
    assert.equal(status.active, false, `第 ${index + 1} 次不该报警`);
    assert.equal(status.streak, index + 1);
  }
  const status = monitor.observe(sample(12000));
  assert.equal(status.active, true, "第 5 次必须报警");
  assert.equal(status.streak, 5);
  assert.equal(status.needed, 5);
  assert.equal(status.thresholdMs, 10000);
  assert.equal(status.lastDurationMs, 12000);
  assert.ok(Number.isFinite(Date.parse(status.sinceAt)), "报警时必须能说出「从什么时候开始」");
});

test("一次快调用立刻清零，报警随之消失", () => {
  const monitor = createSlowCallMonitor();
  for (let index = 0; index < 5; index += 1) monitor.observe(sample(11000));
  assert.equal(monitor.status().active, true);
  const status = monitor.observe(sample(200));
  assert.equal(status.active, false);
  assert.equal(status.streak, 0);
  assert.equal(status.sinceAt, "", "清零后不该再留下上一段的起点");
});

test("缓存命中与「没发请求的降级」都不打断连续段", () => {
  const monitor = createSlowCallMonitor();
  monitor.observe(sample(12000));
  monitor.observe(sample(12000));
  // 中间夹一次缓存命中：没有发生真实往返，连续段照样成立。
  monitor.observe(sample(0, { cached: true }));
  monitor.observe(sample(300, { degraded: true }));
  monitor.observe(sample(12000));
  monitor.observe(sample(12000));
  const status = monitor.observe(sample(12000));
  assert.equal(status.streak, 5);
  assert.equal(status.active, true);
});

test("继续变慢时 streak 继续增长，报警保持", () => {
  const monitor = createSlowCallMonitor();
  for (let index = 0; index < 7; index += 1) monitor.observe(sample(15000));
  const status = monitor.status();
  assert.equal(status.streak, 7);
  assert.equal(status.active, true);
});

test("status() 不返回内部可变对象（外部改不到监视器状态）", () => {
  const monitor = createSlowCallMonitor();
  monitor.observe(sample(12000));
  const first = monitor.status();
  first.streak = 999;
  assert.equal(monitor.status().streak, 1);
});

test("client.recordDecision 会把每次调用的耗时喂给监视器", () => {
  const monitor = createSlowCallMonitor();
  const call = { point: "authorize", action: "allow", detail: "allow" };
  const facts = { point: "authorize", provider: "p", model: "m", durationMs: 12000, inputTokens: 1, outputTokens: 1 };
  // 不注入 statsStore：即使统计这一路被关掉，慢调用判定也必须照常工作
  //（它回答的是「服务商是不是变慢了」，与「记不记统计」无关）。
  const client = new StartluxClient({ getConfig: () => ({}), slowCalls: monitor });
  for (let index = 0; index < 5; index += 1) client.recordDecision({ facts, ...call });
  assert.equal(monitor.status().active, true);

  // 缓存命中不该把这 5 次冲掉。
  const cachedFacts = { ...facts, durationMs: 0, cached: true };
  client.recordDecision({ facts: cachedFacts, ...call });
  assert.equal(monitor.status().streak, 5);
});

/**
 * 造一个隔离环境（与 test/decisions-route.test.js 同一套路）。
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "dsh-slowcalls-"));
  process.env.DSH_HOME = home;
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
    on() {},
    get(name) {
      return name === "connection" ? connection : undefined;
    },
    inject(_names, fn) {
      fn();
    },
    plugin() {},
    effect() {},
  };
  apply(ctx, {});
  return { home, routes };
}

/** 调用一次 GET 路由。 */
async function get(routes, url) {
  const key = url.split("?")[0];
  const res = await routes[key].fetch({ method: "GET", url: `http://localhost${url}` });
  return { status: res.status, data: await res.json() };
}

test("路由 /slow-calls：拿到形状正确、初始为「未报警」的载荷", async () => {
  const { home, routes } = setup();
  try {
    assert.ok(routes["/api/decision-engine/slow-calls"] !== undefined, "路由必须注册");
    const { status, data } = await get(routes, "/api/decision-engine/slow-calls");
    assert.equal(status, 200);
    assert.deepEqual(data, {
      active: false,
      streak: 0,
      needed: SLOW_CALL_STREAK,
      thresholdMs: SLOW_CALL_THRESHOLD_MS,
      lastDurationMs: 0,
      sinceAt: "",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("接线断言：apply() 把监视器交给客户端，路由读的是同一个监视器", () => {
  // 这段胶水没法从外部驱动（apply() 作用域里的监视器不导出，而真跑一次
  // 决策又要网络）。因此直接盯源码里那两处接线——漏了任何一处，界面上
  // 永远显示「正常」，而那正是用户最需要它亮的时刻。
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(source, /const slowCalls = createSlowCallMonitor\(/, "apply() 必须建监视器");
  assert.match(source, /new StartluxClient\(\{[\s\S]{0,4000}?\n\s+slowCalls,/, "客户端必须拿到监视器");
  assert.match(
    source,
    /path: "\/api\/decision-engine\/slow-calls"[\s\S]{0,400}?slowCalls\.status\(\)/,
    "路由必须读监视器的实时状态",
  );
});
