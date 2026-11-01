/**
 * 判断计数通路的单元测试。
 *
 * 覆盖的是服务端那一半（lib/judgements.js）：发布器与归一化。两项纪律
 * 在这里被逐条验证，因为它们一旦破了，故障形态都是**静默**的：
 *
 *   - 发布器抛异常 → 决策路径被炸（违反 fail-open）；
 *   - 开关关不掉 → 关掉开关的用户的会话里仍在长记录（违反零足迹承诺）；
 *   - 缓存命中被当成裁决 → 界面上的数字随命中率乱跳；
 *   - 降级被当成裁决 → 「判断了 3 次」里混着 2 次根本没拿到答案的尝试。
 *
 * 全部用假 session 与假宿主接口，不打网络、不碰真实会话文件。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  JUDGEMENT_EVENT_TYPE,
  createJudgementPublisher,
  normalizeJudgement,
  pointIdOf,
} from "../lib/judgements.js";

/** 造一个最小的 session（发布器只把它整个传下去，不读它的字段）。 */
const makeSession = () => ({ id: "s1", events: [] });

/**
 * 造一个记录宿主调用的假 `appendPluginRecord` 装载器。
 *
 * `load` 的签名与 `loadAppendPluginRecord` 一致：返回 Promise<函数>。
 * 调用次数单独计数，用来验证「动态 import 的结果被缓存」。
 */
function makeLoader({ impl } = {}) {
  const records = [];
  const fn = (session, type, data) => {
    records.push({ session, type, data });
    if (impl !== undefined) impl(session, type, data);
  };
  let loadCount = 0;
  const load = () => {
    loadCount += 1;
    return Promise.resolve(fn);
  };
  return { load, records, fn, loads: () => loadCount };
}

/**
 * 造一个发布器，并锁住事件循环，保证 fire-and-forget 的 Promise 已跑完。
 *
 * 发布器刻意不 await（决策路径上不多等一次 I/O），因此测试必须自己等：
 * 这里用一次 `setImmediate` 让微任务链落地，而不是靠 setTimeout 猜时间。
 */
async function publish(publisher, session, input) {
  const record = publisher.note(session, input);
  await new Promise((resolve) => setImmediate(resolve));
  return record;
}

// ------------------------------------------------------------------ 归一化

test("归一化：裁决记录带上轮次 / 决策点 / 模式 / 裁决词", () => {
  const record = normalizeJudgement({ turn: 3, point: "retrieval", mode: "enforce", action: "skip" });
  assert.deepEqual(record, { turn: 3, point: "retrieval", mode: "enforce", action: "skip" });
});

test("归一化：降级记录带原因而不是裁决词（降级不是判断）", () => {
  const record = normalizeJudgement({ turn: 2, point: "route", mode: "observe", degraded: "timeout" });
  assert.deepEqual(record, { turn: 2, point: "route", mode: "observe", degraded: "timeout" });
  assert.equal(record.action, undefined, "降级记录不得伪装成裁决");
});

test("归一化：同时给了裁决词与降级原因时按降级记（一次尝试不可能两样都成立）", () => {
  const record = normalizeJudgement({ turn: 1, point: "route", mode: "observe", action: "keep", degraded: "http-404" });
  assert.equal(record.degraded, "http-404");
  assert.equal(record.action, undefined);
});

test("归一化：没有轮次时返回 null（记录归不到任何一条消息下面）", () => {
  assert.equal(normalizeJudgement({ point: "route", mode: "observe", action: "keep" }), null);
  assert.equal(normalizeJudgement({ turn: undefined, point: "route", mode: "observe", action: "keep" }), null);
  // 负轮次与非整数一样是「没有轮次」：界面上不存在第 -1 条消息。
  assert.equal(normalizeJudgement({ turn: -1, point: "route", mode: "observe", action: "keep" }), null);
  assert.equal(normalizeJudgement({ turn: 1.5, point: "route", mode: "observe", action: "keep" }), null);
});

test("归一化：模式不是 observe/enforce 时返回 null（客户端按这个二值分栏）", () => {
  assert.equal(normalizeJudgement({ turn: 1, point: "route", mode: "off", action: "keep" }), null);
  assert.equal(normalizeJudgement({ turn: 1, point: "route", mode: undefined, action: "keep" }), null);
});

test("归一化：既无裁决也无降级原因时返回 null（不伪造一条空记录）", () => {
  assert.equal(normalizeJudgement({ turn: 1, point: "route", mode: "observe" }), null);
  assert.equal(normalizeJudgement({ turn: 1, point: "route", mode: "observe", action: "  " }), null);
});

test("归一化：过长的降级原因被裁短（每个字符都要写进会话文件）", () => {
  const record = normalizeJudgement({ turn: 1, point: "route", mode: "observe", degraded: "x".repeat(500) });
  assert.equal(record.degraded.length, 81, "80 个字符 + 一个省略号");
  assert.equal(record.degraded.endsWith("…"), true);
});

test("点名归一：hook 名与遥测 tag 映射到它承载的那个决策点", () => {
  assert.equal(pointIdOf("guard"), "authorize");
  // pre-step 上挂着分派与压缩两个点，取分派（映射只影响行名，不影响计数）。
  assert.equal(pointIdOf("pre-step"), "delegate");
  assert.equal(pointIdOf("turn-stopping"), "turnStop");
});

test("点名归一：认不出来时记 unknown，不丢也不猜", () => {
  assert.equal(pointIdOf("route"), "route");
  assert.equal(pointIdOf("nope"), "unknown");
  assert.equal(pointIdOf(undefined), "unknown");
  assert.equal(pointIdOf(""), "unknown");
});

// -------------------------------------------------------------------- 发布

test("事件类型带包名与 plugin: 前缀（宿主的插件记录语法）", () => {
  assert.equal(JUDGEMENT_EVENT_TYPE, "plugin:decision-engine/judgement");
  assert.equal(JUDGEMENT_EVENT_TYPE.startsWith("plugin:"), true);
});

test("发布：用宿主的 appendPluginRecord 写一条记录", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  const session = makeSession();
  const record = await publish(publisher, session, { turn: 4, point: "compact", mode: "enforce", action: "prune" });
  assert.deepEqual(record, { turn: 4, point: "compact", mode: "enforce", action: "prune" });
  assert.equal(records.length, 1);
  assert.equal(records[0].session, session, "记录必须落到判断发生的那个会话");
  assert.equal(records[0].type, JUDGEMENT_EVENT_TYPE);
  assert.deepEqual(records[0].data, { turn: 4, point: "compact", mode: "enforce", action: "prune" });
});

test("发布：降级记录带原因（界面把它放进独立的降级桶）", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  await publish(publisher, makeSession(), { turn: 2, point: "retrieval", mode: "observe", degraded: "no-key" });
  assert.equal(records.length, 1);
  assert.equal(records[0].data.degraded, "no-key");
  assert.equal(records[0].data.action, undefined);
});

test("发布：发布是同步返回的（fire-and-forget，不阻塞决策路径）", () => {
  // 决策路径上多等一次 I/O 不值得：记录晚到几十毫秒对「判断了几次」没有区别。
  let resolved = false;
  const load = () => {
    resolved = true;
    return Promise.resolve(() => {});
  };
  const publisher = createJudgementPublisher({ load });
  publisher.note(makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.equal(resolved, false, "note() 返回时不得已经 await 过装载");
});

test("发布：没有会话时不发（记录无处可落，宁可不落也不要张冠李戴）", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  const record = await publish(publisher, undefined, { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.equal(record, null);
  assert.equal(records.length, 0);
  assert.equal(await publish(publisher, null, { turn: 1, point: "route", mode: "observe", action: "keep" }), null);
  assert.equal(records.length, 0);
});

test("发布：不该发的输入一条都不发（缺轮次 / 模式非法 / 空记录）", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  const session = makeSession();
  assert.equal(await publish(publisher, session, { point: "route", mode: "observe", action: "keep" }), null);
  assert.equal(await publish(publisher, session, { turn: 1, point: "route", mode: "off", action: "keep" }), null);
  assert.equal(await publish(publisher, session, { turn: 1, point: "route", mode: "observe" }), null);
  assert.equal(records.length, 0);
});

// -------------------------------------------------------------------- 开关

test("开关：judgementCount 为 false 时一条都不发（零会话足迹）", async () => {
  const { load, records, loads } = makeLoader();
  const publisher = createJudgementPublisher({ load, enabled: () => false });
  const session = makeSession();
  assert.equal(await publish(publisher, session, { turn: 1, point: "route", mode: "observe", action: "keep" }), null);
  assert.equal(await publish(publisher, session, { turn: 1, point: "route", mode: "observe", degraded: "timeout" }), null);
  assert.equal(records.length, 0, "关掉时一个字节都不该写进会话");
  // 连宿主接口都不必去取：关掉时这条通路应当完全不产生开销。
  assert.equal(loads(), 0);
});

test("开关：为 true 时照常发布", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load, enabled: () => true });
  await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.equal(records.length, 1);
});

test("开关：缺省视为开启（不给 enabled 也照常发布）", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.equal(records.length, 1);
});

test("开关：每次发布都现读（改配置立即生效，不必重启）", async () => {
  let value = true;
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load, enabled: () => value });
  const session = makeSession();
  await publish(publisher, session, { turn: 1, point: "route", mode: "observe", action: "keep" });
  value = false;
  await publish(publisher, session, { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.equal(records.length, 1, "关掉之后的那一条不该发");
});

// -------------------------------------------------------------- 失败可吞

test("发布：宿主接口抛异常时不向外抛（报告通路不能弄坏决策）", async () => {
  const { load } = makeLoader({
    impl: () => {
      throw new Error("宿主记录接口炸了");
    },
  });
  const publisher = createJudgementPublisher({ load });
  const record = await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  // 不抛即通过。返回值仍是记录本身：调用方不必为了拿记录而承担抛错风险。
  assert.deepEqual(record, { turn: 1, point: "route", mode: "observe", action: "keep" });
});

test("发布：宿主接口取不到时不抛，只记一条警告", async () => {
  const warnings = [];
  const publisher = createJudgementPublisher({
    load: () => Promise.resolve(undefined),
    logger: { warn: (text) => warnings.push(text) },
  });
  const record = await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.deepEqual(record, { turn: 1, point: "route", mode: "observe", action: "keep" }, "接口缺失不影响归一化结果");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /插件记录接口/);
});

test("发布：动态 import 本身失败时不抛（老宿主没有这个包）", async () => {
  const warnings = [];
  const publisher = createJudgementPublisher({
    load: () => Promise.reject(new Error("Cannot find package")),
    logger: { warn: (text) => warnings.push(text) },
  });
  await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  // 不抛即通过。import 失败不需要再报一遍警告：它和「取不到接口」是同一件事。
  assert.equal(warnings.length, 0);
});

test("发布：抛出的异常即使是同步的也被吞掉（兜底不能被绕过）", async () => {
  const publisher = createJudgementPublisher({
    // 装载器同步抛：真实代码里 `options.enabled()` 或装载器都可能这样炸。
    enabled: () => {
      throw new Error("读取配置炸了");
    },
  });
  assert.equal(await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" }), null);
});

test("发布：宿主接口缺失时也不向 logger 抛（logger 本身可能就没有）", async () => {
  const publisher = createJudgementPublisher({ load: () => Promise.resolve(undefined) });
  await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  // 不抛即通过。
});

// ------------------------------------------------------- 动态 import 缓存

test("发布：appendPluginRecord 的装载结果被缓存（每条记录一次 import 就够了）", async () => {
  const { load, records, loads } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  const session = makeSession();
  for (let index = 0; index < 5; index += 1) {
    await publish(publisher, session, { turn: index, point: "route", mode: "observe", action: "keep" });
  }
  assert.equal(records.length, 5, "五条记录都发出去了");
  assert.equal(loads(), 1, "装载只发生一次：缓存失效会让热路径上多出成百上千次动态 import");
});

test("发布：缓存的是装载动作，记录仍然逐条发出（不是只发第一条）", async () => {
  const { load, records } = makeLoader();
  const publisher = createJudgementPublisher({ load });
  const session = makeSession();
  await publish(publisher, session, { turn: 1, point: "route", mode: "observe", action: "keep" });
  await publish(publisher, session, { turn: 1, point: "skillPick", mode: "enforce", action: "redirect" });
  assert.deepEqual(
    records.map((entry) => entry.data),
    [
      { turn: 1, point: "route", mode: "observe", action: "keep" },
      { turn: 1, point: "skillPick", mode: "enforce", action: "redirect" },
    ],
    "同一轮的多条记录都要落下去（客户端靠它们累加）",
  );
});

test("发布：默认装载走与错误发布器共用的那一份缓存", async () => {
  // 不注入 load 时用真实的 loadAppendPluginRecord：它内部缓存了 Promise，
  // 与错误事件合起来只动态 import 一次。这里只验证「拿不到时也不抛」。
  const publisher = createJudgementPublisher();
  const record = await publish(publisher, makeSession(), { turn: 1, point: "route", mode: "observe", action: "keep" });
  assert.deepEqual(record, { turn: 1, point: "route", mode: "observe", action: "keep" });
});
