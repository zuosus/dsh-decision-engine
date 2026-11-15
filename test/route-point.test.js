/**
 * 模型路由第 3 道闸（机械闸）的测试。
 *
 * 防的是这一类错：**新用户任务的第一步被判断要不要下沉到便宜模型**。
 *
 * 修之前闸3 是 `hasFreshUserInput(session) && state.askedSteps.size > 0`，
 * 于是「本轮还没问过任何一步」时这个闸根本拦不住——新任务的第一步照样会
 * 问一次决策模型。而第一步恰恰是最不该下沉的一步：用户刚提出目标，后文
 * 还没展开，交上去的 `state` 只有 current/recent，没有任何「下一步是机械活」
 * 的证据。问出来的多半是 keep（白付一次 ~2 秒 / ~1.9k token）；万一判成
 * 机械，整个新任务就从开局跑在便宜模型上。
 *
 * 因此这里按「闸门的结果」测，不测实现细节：
 *
 *   ① 带新用户输入的步骤（尤其第一步）一次都不问；
 *   ② 只有上一条相关事件是工具结果时才问，且 switch 真的生效；
 *   ③ observe 只记录、不改路由；
 *   ④ 闸1（每轮步数上限）/ 闸2（已知路由不重问）行为不变；
 *   ⑤ 没配下沉目标时零请求；
 *   ⑥ 读不到会话事件时**保持旧行为**（问），不许静默失效。
 *
 * 全部用假的 ctx / runner / session 事件数组，不打网络、不写磁盘。
 *
 * 运行：node --test test/route-point.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mountRoutePoint } from "../lib/adapters/route.js";

/** 配置基线：便宜模型配好了，闸1 的步数上限取 3（与默认值一致）。 */
const CFG = {
  recentMessages: 0,
  recentMessageChars: 240,
  routeCheapProvider: "cheap-provider",
  routeCheapModel: "cheap-model",
  routeMaxStepsPerTurn: 3,
};

/** 决策模型的两种裁决：下沉 / 保留。 */
const SWITCH = {
  action: { kind: "switch", provider: "cheap-provider", model: "cheap-model" },
};
const KEEP = { action: { kind: "keep", reason: "decision-engine-route: 不是机械步骤，保留强模型" } };

/** 宿主原本要用的强模型 config（maxTokens 用来验证「只换 provider/model」）。 */
const STRONG = () => Promise.resolve({ provider: "strong", model: "strong-1", maxTokens: 1000 });

const userMessage = (text) => ({ type: "user/message", text });
const toolResult = () => ({ type: "tool/result" });

/** 最小假 ctx：只实现 mount 用到的 on（记录监听器）。 */
function makeCtx() {
  const hooks = new Map();
  return {
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      hooks.set(name, listener);
    },
    listener(name) {
      return hooks.get(name);
    },
  };
}

/**
 * 挂一个路由点。
 *
 * @param cfg - 配置。
 * @param decision - 决策模型返回的裁决。
 * @param mode - enforce（可改路由）或 observe（只记录）。
 * @returns `{ listener, calls }`：`calls` 是 runner 收到的请求，用来断言「问没问」。
 */
function mount({ cfg = CFG, decision = SWITCH, mode = "enforce" } = {}) {
  const ctx = makeCtx();
  const calls = [];
  const runner = {
    participates: () => true,
    enforces: () => mode === "enforce",
    async ask(point, input, extra) {
      calls.push({ point, input, extra });
      return decision;
    },
  };
  mountRoutePoint(ctx, {
    runner,
    getConfig: () => cfg,
    digestRecent: () => "最近对话摘要",
    telemetry: { noteAdapterError() {} },
  });
  return { listener: ctx.listener("agent/request"), calls };
}

// ---------------------------------------------------------------- ① 新用户输入

test("新用户任务第一步：即使配置了便宜模型也一次都不问", async () => {
  const { listener, calls } = mount();
  const session = { events: [userMessage("帮我看看 route 的闸3")] };
  const expected = { provider: "strong", model: "strong-1", maxTokens: 1000 };

  const proposed = await listener({ turn: 1, step: 1, agent: { session } }, () => Promise.resolve(expected));

  assert.equal(calls.length, 0, "带新用户输入的第一步不该问决策模型");
  // 连对象都不换：没有裁决时必须原样交还宿主已解析好的 config。
  assert.equal(proposed, expected, "不判断时应原样返回宿主的 config");
});

test("回归：本轮已经问过步之后，带新用户输入的步骤仍不判断", async () => {
  // 修前的条件 `state.askedSteps.size > 0` 让这类步骤照常放行——用户中途
  // 补一句话，本轮已问过步，于是又问一次「要不要下沉」。这是同一个缺陷的
  // 另一半，必须一起钉住。
  const { listener, calls } = mount({ decision: KEEP });
  const session = { events: [toolResult()] };

  await listener({ turn: 1, step: 1, agent: { session } }, STRONG);
  assert.equal(calls.length, 1, "工具结果之后的延续可以问（本轮第一次）");

  session.events = [toolResult(), userMessage("改成只对工具结果后的步骤判断")];
  await listener({ turn: 1, step: 2, agent: { session } }, STRONG);
  assert.equal(calls.length, 1, "带新用户输入的步骤不该再问");
});

test("新宿主（snapshotEvents）也认得出用户新输入", async () => {
  // 新宿主上 `session.events` 根本不存在，只能走 snapshotEvents()。
  // 这条用新 API 的形态，防止修复只在老宿主上生效。
  const { listener, calls } = mount();
  const session = { snapshotEvents: () => [userMessage("新任务")] };
  await listener({ turn: 1, step: 1, agent: { session } }, STRONG);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- ② 工具结果之后

test("上一条是工具结果时才问，switch 生效", async () => {
  const { listener, calls } = mount();
  const session = { events: [userMessage("跑一下测试"), toolResult()] };

  const proposed = await listener({ turn: 1, step: 2, agent: { session } }, STRONG);

  assert.equal(calls.length, 1, "机械延续要判断");
  assert.equal(calls[0].point, "route");
  assert.equal(calls[0].input.basis, "after-tool-result", "要留下「凭什么问这一步」的依据");
  assert.equal(calls[0].input.current.provider, "strong");
  assert.equal(proposed.provider, "cheap-provider");
  assert.equal(proposed.model, "cheap-model");
  assert.equal(proposed.maxTokens, 1000, "只换 provider/model，其余字段原样保留");
});

// ---------------------------------------------------------------- ③ observe

test("observe：照常问一次并记录，但不改路由", async () => {
  const { listener, calls } = mount({ mode: "observe" });
  const session = { events: [toolResult()] };

  const proposed = await listener({ turn: 1, step: 2, agent: { session } }, STRONG);

  assert.equal(calls.length, 1, "observe 仍要发声，统计才有样本");
  assert.equal(calls[0].extra.session, session, "会话对象要交给决策历史");
  assert.equal(proposed.provider, "strong", "observe 不得改变行为");
});

// ---------------------------------------------------------------- ④ 闸1 / 闸2 不变

test("闸1：每轮最多问 routeMaxStepsPerTurn 步", async () => {
  const { listener, calls } = mount({ decision: KEEP, cfg: { ...CFG, routeMaxStepsPerTurn: 2 } });
  const session = { events: [toolResult()] };

  for (let step = 1; step <= 5; step += 1) {
    // 每一步都是「工具结果之后的延续」，闸3 全程放行，只有步数闸能挡住。
    session.events = [toolResult()];
    await listener({ turn: 1, step, agent: { session } }, STRONG);
  }

  assert.equal(calls.length, 2, `应只问 2 次，实际 ${calls.length}`);
});

test("闸2：宿主已经给出同一个路由时不再重问", async () => {
  const { listener, calls } = mount();
  const session = { events: [toolResult()] };

  await listener({ turn: 1, step: 1, agent: { session } }, STRONG); // 问 → 切到 cheap
  const again = await listener(
    { turn: 1, step: 2, agent: { session } },
    () => Promise.resolve({ provider: "cheap-provider", model: "cheap-model" }),
  );

  assert.equal(calls.length, 1, "路由没变过就不必再问");
  assert.equal(again.provider, "cheap-provider");
});

// ---------------------------------------------------------------- ⑤ 无下沉目标

test("没配下沉目标：一次都不问", async () => {
  const { listener, calls } = mount({ cfg: { ...CFG, routeCheapProvider: "", routeCheapModel: "" } });
  const session = { events: [toolResult()] };
  const expected = { provider: "strong", model: "strong-1" };

  const proposed = await listener({ turn: 1, step: 2, agent: { session } }, () => Promise.resolve(expected));

  assert.equal(calls.length, 0, "留空等于「不路由」，问一次再放弃是纯浪费");
  assert.equal(proposed, expected);
});

// ---------------------------------------------------------------- ⑥ 读不到事件

test("读不到会话事件时保持旧行为：照常问，而不是静默不判断", async () => {
  // 老宿主没有 events、也没有 snapshotEvents。此时「不知道上一条是什么」，
  // 不能当成「有用户新输入」——那会让路由在老宿主上**静默失效**（见
  // lib/session-events.js 顶部记的坑）。宁可多问一次，也不假装判断过了。
  const { listener, calls } = mount();
  const session = {};

  await listener({ turn: 1, step: 1, agent: { session } }, STRONG);

  assert.equal(calls.length, 1, "读不到事件时保持旧行为");
  assert.equal(
    Object.hasOwn(calls[0].input, "basis"),
    false,
    "没有依据就不编造 basis",
  );
});
