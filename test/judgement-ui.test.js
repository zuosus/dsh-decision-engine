/**
 * 判断计数的**渲染**测试（真的把客户端 bundle 跑起来）。
 *
 * 与 test/client-errors.test.js / test/error-tail-render.test.js 同一族：
 * 槽位注册与渲染都是「写错了不会报错、只是什么都不显示」的那类代码——
 * 比如 `id` 写成了 `key`（会覆盖别人的格子）、忘了 `locale: NS`（宿主根本
 * 不注入 `t`，文案整块消失）、或者没记录时也占一行。语法检查抓不到这些。
 *
 * 本文件盯四件事：
 *
 *   1. 槽位条目用自己的 `id`、order 20、带 `locale: NS`；
 *   2. conversation Definition 真的注册了，且 `turn/start` 是 start 角色；
 *   3. 计数器数字对、没记录时返回 null、浮层里的分账行对；
 *   4. 客户端内联的两份常量/映射与服务端（lib/judgements.js + lib/outcomes.js）
 *      以及 lib/client-judgements.js 逐字一致。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  JUDGEMENT_EVENT_TYPE as SERVER_EVENT_TYPE,
  normalizeJudgement,
  pointIdOf,
} from "../lib/judgements.js";
import {
  LEGACY_UNKNOWN_POINT_OUTCOMES,
  OUTCOME_MATRIX,
  outcomeOf,
} from "../lib/outcomes.js";
import { DECISION_POINTS } from "../lib/decision-points.js";
import {
  JUDGEMENT_EVENT_TYPE,
  LEGACY_UNKNOWN_POINT_VERDICTS,
  POINT_LABELS,
  POINT_LABELS_EN,
  POINT_ORDER,
  TURN_DATA_KEY,
  VERDICT_MATRIX,
  createJudgementDefinition,
  judgementFromEvent,
  judgementsOfTurn,
  summarizeTurn,
  verdictOf,
} from "../lib/client-judgements.js";

/** 每次加载都要拿到一份新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/** 极简 DOM：只为让 portal 与 Esc 监听这两条路径在裸 Node 里跑起来。 */
const fakeDocument = {
  body: { nodeName: "BODY" },
  listeners: [],
  addEventListener(type, handler) {
    this.listeners.push({ type, handler });
  },
  removeEventListener(type, handler) {
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.handler === handler));
  },
};

/**
 * 加载客户端 bundle，返回它注册的槽位、Definition 与字典。
 *
 * @param options.slots - `{ useState 序号: 值 }`；序号 0 是浮层的 `open`。
 * @returns `{ slots, definitions, dictionaries }`。
 */
async function loadBundle(options = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const unique = `\n// test-instance-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  const injected = { 0: false, ...(options.slots ?? {}) };
  let stateIndex = 0;

  /** 记录所有 `setState` 调用：用它可以断言「Esc 真的触发了关闭」。 */
  const setStateCalls = [];
  /** 记录 effect 的清理函数：断言监听被摘掉。 */
  const effectCleanups = [];

  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = stateIndex;
      stateIndex += 1;
      const value = Object.prototype.hasOwnProperty.call(injected, index)
        ? injected[index]
        : typeof initial === "function"
          ? initial()
          : initial;
      return [
        value,
        (next) => {
          setStateCalls.push({ index, value: typeof next === "function" ? next(value) : next });
        },
      ];
    },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    // 真的执行 effect：浮层的 Esc 监听就挂在 effect 里，不执行就看不到它。
    useEffect(body) {
      const cleanup = body();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
    },
    useMemo: (fn) => fn(),
    // 轮次数据的订阅口：宿主给的是 useSyncExternalStore 形状
    // （subscribe / getSnapshot）。桩里照着实现：读一次当前值，订阅记下来。
    useSyncExternalStore(subscribe, getSnapshot) {
      const snapshot = typeof getSnapshot === "function" ? getSnapshot() : undefined;
      const unsubscribe = typeof subscribe === "function" ? subscribe(() => {}) : undefined;
      if (typeof unsubscribe === "function") effectCleanups.push(unsubscribe);
      return snapshot;
    },
  };

  const slots = [];
  const definitions = [];
  let dictionaries;

  globalThis.document = fakeDocument;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          if (name === "react-dom") {
            return {
              // 把 portal 的「挂到哪」留在树里，这样测试能断言它真的挂到了 body。
              createPortal(children, container) {
                return {
                  type: "portal",
                  props: { container: container?.nodeName ?? String(container) },
                  children: [children],
                };
              },
            };
          }
          throw new Error(`unexpected require: ${name}`);
        });
        const ctx = {
          logger: { info() {}, warn() {} },
          // 宿主 locale 服务：显式声明中文。DEC-018 之后 `apply()` 一进来就
          // 读宿主语言（读不到才退浏览器语言）——裸 Node 里 `navigator` 是
          // en-US，不声明的话整个 bundle 会按英文翻译，本文件断言的中文
          // （POINT_LABELS 的决策点名等）就全被渲染边界换掉了。与本文件
          // 断言 en 的用例无关：那几个用例的期望走的是字典 `t`，不受影响。
          locale: {
            register(_ns, dicts) {
              dictionaries = dicts;
              return () => {};
            },
            getSnapshot: () => ({ active: "zh", locales: [], revision: 1 }),
            subscribe: () => () => {},
          },
          slots: {
            inject(_slot, callback) {
              callback();
              return () => {};
            },
            register(meta, comp) {
              slots.push({ ...meta, component: comp });
              return () => {};
            },
          },
          uiConversation: {
            events: {
              register(definitionValue) {
                definitions.push(definitionValue);
                return () => {};
              },
            },
          },
          effect(body) {
            // cordis 的 effect 两种形态都支持：generator（yield 出 disposer）
            // 与普通函数（返回 disposer）。
            if (typeof body === "function" && body.constructor?.name === "GeneratorFunction") {
              const iterator = body();
              let step = iterator.next();
              while (!step.done) step = iterator.next(step.value);
              return () => {};
            }
            const disposer = body();
            return typeof disposer === "function" ? disposer : () => {};
          },
        };
        bundle.apply(ctx);
      },
    },
  };

  await import(dataUrl);
  return { slots, definitions, dictionaries, setStateCalls, effectCleanups };
}

/**
 * 把渲染树里的**函数组件**展开成真实节点。
 *
 * react 桩只造 `{type, props, children}`，不执行组件函数——于是浮层在树里
 * 只是一个 `{type: JudgementOverlay}` 的占位。要断言浮层里的内容，必须自己
 * 调一遍组件函数（真实 react 在渲染时做的正是这件事）。
 */
function deepRender(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return node;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return node.map((child) => deepRender(child, depth + 1));
  if (typeof node !== "object") return node;
  if (typeof node.type === "function" && depth < 12) {
    const props = { ...node.props };
    if (node.children.length > 0) props.children = node.children;
    return deepRender(node.type(props), depth + 1);
  }
  return { ...node, children: node.children.map((child) => deepRender(child, depth + 1)) };
}

/** 递归收集渲染树里的文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === "object") {
    const props = node.props ?? {};
    if (typeof props.title === "string") out.push(props.title);
    if (typeof props["aria-label"] === "string") out.push(props["aria-label"]);
    collectText(node.children, out);
  }
  return out;
}

/** 在渲染树里按 prop 值找节点。 */
function findByProp(node, key, value) {
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByProp(child, key, value);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node.props?.[key] === value) return node;
  return findByProp(node.children, key, value);
}

/**
 * 用 bundle 自己注册的字典造一个 `t`（宿主注入的就是这么个东西）。
 *
 * 刻意不用测试里抄一份的假 `t`：那样「字典里漏了 judgement.count 这一条」
 * 也能绿，而漏词条的后果是界面上直接冒出 `judgement.count` 这种裸 key。
 */
function translateWith(dictionaries, lang = "zh") {
  const dict = dictionaries?.[lang] ?? {};
  return (key, params) => {
    const template = dict[key] ?? key;
    if (params === undefined || params === null) return template;
    return template.replace(/\{(\w+)\}/g, (all, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all,
    );
  };
}

/** 造一个 turnTail 的 owner：只带本插件读得到的那部分（turn.data.get + t）。 */
function ownerWith(turn, entries, t) {
  return {
    turn: {
      turn,
      data: {
        // 按宿主的真实契约：**返回发布出去的那个值本身**，不是
        // `{kind, turn, key, value}` 包装（宿主 MutableLocationDataStore.get
        // 就是 `entries.get(key)?.value`）。2026-11-02 之前这里写的是包装，
        // 于是组件在真机上永远取不到 entries——而测试却是绿的。
        get: (key) => (key === "decision-engine-judgement" ? { turn, entries } : undefined),
      },
    },
    seq: 1,
    openFile() {},
    t,
  };
}

/** 取出判断计数那个槽位条目。 */
async function judgementSlot(options) {
  const { slots, ...rest } = await loadBundle(options);
  const entry = slots.find((item) => item.id === "decision-engine-judgements");
  assert.ok(entry, `没有注册 decision-engine-judgements，实际注册了：${slots.map((s) => s.id ?? s.key).join(", ")}`);
  return { entry, slots, ...rest };
}

// ---------------------------------------------------------------- 槽位注册

test("判断计数：用 id（不是 key）注册在 conversation.chat.turnTail 上，order 20", async () => {
  const { entry } = await judgementSlot();
  assert.equal(entry.name, "conversation.chat.turnTail");
  assert.equal(entry.id, "decision-engine-judgements", "必须用自己的 id");
  assert.equal(entry.key, undefined, "列表型槽位不该用 key（key 会顶掉别人的格子）");
  assert.equal(entry.order, 20, "order 20：排在错误尾部（30）之前");
});

test("判断计数：注册项带 locale: NS（否则宿主不注入 t，文案整块消失）", async () => {
  const { entry, slots } = await judgementSlot();
  assert.equal(entry.locale, "decisionEngine");
  // 错误尾部那一格同样要补上 locale——它原本漏了，同一个 bug。
  const errors = slots.find((item) => item.id === "decision-engine-errors");
  assert.ok(errors, "错误尾部那一格应该还在（两个格子共存）");
  assert.equal(errors.locale, "decisionEngine", "错误尾部也必须有 locale: NS");
});

test("判断计数：两个格子共存，互不顶替", async () => {
  const { slots } = await judgementSlot();
  const ids = slots.filter((item) => item.name === "conversation.chat.turnTail").map((item) => item.id);
  assert.deepEqual(ids.sort(), ["decision-engine-errors", "decision-engine-judgements"]);
});

// ---------------------------------------------------------------- Definition

test("判断计数：注册了 conversation Definition（判断事件的入口）", async () => {
  const { definitions } = await judgementSlot();
  const definition = definitions.find((item) => item.kind === "decision-engine-judgement");
  assert.ok(definition, `没有注册判断 Definition，实际注册了：${definitions.map((d) => d.kind).join(", ")}`);
  assert.equal(definition.target, "chat");
});

test("判断计数：Definition 以 turn/start 为 start、以判断事件为 update，同一轮同 id", async () => {
  const definition = createJudgementDefinition();
  const start = definition.match({ type: "turn/start", data: { turn: 4 } });
  assert.ok(start !== null, "turn/start 必须被匹配");
  assert.equal(start.role, "start", "turn/start 必须是 start 角色（否则 update 会先到而抛错）");
  assert.equal(start.id, "4");

  const update = definition.match({
    type: JUDGEMENT_EVENT_TYPE,
    data: { turn: 4, point: "authorize", mode: "enforce", action: "deny" },
  });
  assert.equal(update.role, "update");
  assert.equal(update.id, start.id, "同一轮的 start 与 update 必须落在同一个上下文");
});

test("判断计数：轮次号非法时不匹配（不造出一个上下文）", () => {
  const definition = createJudgementDefinition();
  assert.equal(definition.match({ type: "turn/start", data: { turn: -1 } }), null);
  assert.equal(definition.match({ type: "turn/start", data: {} }), null);
  assert.equal(definition.match(null), null);
  assert.equal(definition.match({ type: JUDGEMENT_EVENT_TYPE, data: { point: "authorize", action: "deny" } }), null);
});

test("判断计数：Definition 的轮次数据键名与读取端一致，且 previous 不变时原样返回", () => {
  const definition = createJudgementDefinition();
  const match = definition.match({ type: "turn/start", data: { turn: 5 } });
  const state = definition.start({}, match);
  const data = definition.buildLocationData({ state }, "turn", undefined);
  assert.equal(data.key, TURN_DATA_KEY);
  assert.equal(data.turn, 5);
  assert.equal(data.kind, "turn");
  // 引用相等：宿主靠它判断「没变」，每次造新对象会让界面白白重渲染。
  assert.equal(definition.buildLocationData({ state }, "turn", data), data);
  assert.equal(definition.buildLocationData({ state }, "session", undefined), null, "只发布轮次数据");
});

test("判断计数：同一轮的多条记录全部累加（计数要的就是次数，不去重）", () => {
  const definition = createJudgementDefinition();
  const state = { turn: 2, entries: [] };
  const after = ["deny", "ask", "delegate"].reduce(
    (acc, action) =>
      definition.update(
        { state: acc },
        { event: { type: JUDGEMENT_EVENT_TYPE, time: 1000, data: { turn: 2, point: "authorize", mode: "enforce", action } } },
      ),
    state,
  );
  assert.equal(after.entries.length, 3);
  assert.equal(after.entries[0].at, 1000, "`at` 取会话事件的 time");
});

// ---------------------------------------------------------------- 纯逻辑

test("归一化：裁决记录与降级记录都能收；形状不对的一律 null", () => {
  const verdict = judgementFromEvent({
    type: JUDGEMENT_EVENT_TYPE,
    time: 1700000000000,
    data: { turn: 3, point: "retrieval", mode: "enforce", action: "skip" },
  });
  assert.equal(verdict.turn, 3);
  assert.equal(verdict.point, "retrieval");
  assert.equal(verdict.action, "skip");
  assert.equal(verdict.at, 1700000000000);

  const degraded = judgementFromEvent({
    type: JUDGEMENT_EVENT_TYPE,
    data: { turn: 3, point: "authorize", mode: "observe", degraded: "timeout" },
  });
  assert.equal(degraded.degraded, "timeout");
  assert.equal(degraded.action, undefined);

  assert.equal(judgementFromEvent({ type: "assistant/message", data: {} }), null, "不是判断事件");
  assert.equal(judgementFromEvent({ type: JUDGEMENT_EVENT_TYPE, data: { point: "authorize" } }), null, "没有轮次");
  assert.equal(judgementFromEvent({ type: JUDGEMENT_EVENT_TYPE, data: { turn: 1 } }), null, "既无裁决也无降级原因");
  assert.equal(judgementFromEvent(null), null);
});

test("裁决映射：裸裁决词按点映射成 allow/ask/reject（同一个词在不同点上含义相反）", () => {
  assert.equal(verdictOf("retrieval", "skip"), "reject", "检索 skip 真的拦下了这次调用");
  assert.equal(verdictOf("cotTranslate", "skip"), "allow", "翻译 skip 只是没翻译");
  assert.equal(verdictOf("authorize", "deny"), "reject");
  assert.equal(verdictOf("authorize", "ask"), "ask");
  assert.equal(verdictOf("authorize", "delegate"), "allow");
  assert.equal(verdictOf("unknown", "deny"), "reject", "unknown 走老记录兜底");
  assert.equal(verdictOf("authorize", "wat"), "none", "没登记的裁决词不猜");
  assert.equal(verdictOf(undefined, "deny"), "none");
});

test("汇总：总数只数判决；降级单独成桶并合并原因", () => {
  const summary = summarizeTurn([
    { point: "authorize", mode: "enforce", action: "deny", at: 1000 },
    { point: "authorize", mode: "observe", action: "delegate", at: 1200 },
    { point: "retrieval", mode: "enforce", action: "skip", at: 1500 },
    { point: "route", mode: "enforce", degraded: "timeout" },
    { point: "route", mode: "enforce", degraded: "timeout" },
    { point: "route", mode: "enforce", degraded: "http-error" },
  ]);
  assert.equal(summary.total, 3, "降级不是判断，不该计入总数");
  assert.equal(summary.firstAt, 1000);
  assert.equal(summary.lastAt, 1500);
  const byPoint = new Map(summary.rows.map((row) => [row.point, row]));
  assert.deepEqual(
    { ...byPoint.get("authorize") },
    { point: "authorize", judged: 2, observe: 1, enforce: 1, allow: 1, ask: 0, reject: 1, degraded: 0, degradedReasons: [] },
  );
  assert.deepEqual(
    { ...byPoint.get("retrieval") },
    { point: "retrieval", judged: 1, observe: 0, enforce: 1, allow: 0, ask: 0, reject: 1, degraded: 0, degradedReasons: [] },
  );
  const route = byPoint.get("route");
  assert.equal(route.judged, 0);
  assert.equal(route.degraded, 3);
  assert.deepEqual(route.degradedReasons, ["timeout", "http-error"], "同一原因只留一条");
});

test("汇总：行按决策点固定顺序排（不随出现顺序跳）", () => {
  const rows = summarizeTurn([
    { point: "skillPick", mode: "enforce", action: "allow" },
    { point: "authorize", mode: "enforce", action: "deny" },
    { point: "route", mode: "enforce", action: "keep" },
  ]).rows;
  assert.deepEqual(rows.map((row) => row.point), ["authorize", "route", "skillPick"]);
  // 未知点排在最后，而不是被丢掉。
  const withUnknown = summarizeTurn([{ point: "unknown", mode: "observe", degraded: "no-key" }]).rows;
  assert.equal(withUnknown.length, 1);
  assert.equal(withUnknown[0].point, "unknown");
});

test("汇总：畸形输入不抛（null / 非对象 / 不是数组都当空）", () => {
  assert.equal(summarizeTurn(undefined).total, 0);
  assert.equal(summarizeTurn(null).total, 0);
  assert.equal(summarizeTurn("nope").total, 0);
  assert.deepEqual(summarizeTurn([null, 42, {}]).rows, [], "没有 point 的记录落到 unknown 桶，但什么都数不出来");
});

test("读取端：turnTail 用 owner.turn.data 取回本轮记录；owner 缺失时为空", () => {
  const entries = [{ point: "authorize", mode: "enforce", action: "deny" }];
  const owner = {
    // 宿主契约：get() 返回**值**本身（不是 {kind,turn,key,value} 包装）。
    turn: { data: { get: (key) => (key === TURN_DATA_KEY ? { entries } : undefined) } },
  };
  assert.equal(judgementsOfTurn(owner).length, 1);
  assert.equal(judgementsOfTurn({}).length, 0);
  assert.equal(judgementsOfTurn(undefined).length, 0);
});

test("读取端：按宿主契约读——get() 返回值本身，不是一层包装（2026-11-02 回归闸）", () => {
  // 宿主的 MutableLocationDataStore.get 是 `entries.get(key)?.value`：
  // 返回**发布出去的值**，不是 `{kind, turn, key, value}` 包装。
  // 2026-11-02 的现场缺陷正是这里写错了——按包装读，界面上永远 0 条，
  // 而当时的测试桩也写着包装，于是测试全绿、真机全哑。
  const entries = [{ point: "authorize", mode: "enforce", action: "deny" }];
  // 宿主形状：值直接给出。
  assert.equal(judgementsOfTurn({ turn: { data: { get: () => ({ entries }) } } }).length, 1);
  // 旧形状：多一层包装，也要认（万一宿主哪天改回去，或别的插件这么喂）。
  assert.equal(
    judgementsOfTurn({ turn: { data: { get: () => ({ value: { entries } }) } } }).length,
    1,
  );
  // 取到的是值里的其它字段时，不该被误当成记录列表。
  assert.deepEqual(judgementsOfTurn({ turn: { data: { get: () => ({ turn: 3 }) } } }), []);
});

test("计数器：订阅轮次数据——晚到的记录也会把计数刷新出来", async () => {
  const { entry, dictionaries } = await judgementSlot();
  const t = translateWith(dictionaries);
  // 宿主形状的轮次数据存取口：get 返回值本身，source 是订阅口。
  let value = { entries: [] };
  const listeners = new Set();
  const owner = {
    turn: {
      turn: 7,
      data: {
        get: () => value,
        source: () => ({
          getSnapshot: () => value,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
      },
    },
    seq: 1,
    openFile() {},
    t,
  };
  // 先渲染：还没有记录 → 不占位。
  const before = deepRender(entry.component(owner));
  assert.equal(collectText(before).join("\n").includes("次判断"), false, "没有记录时不该显示计数");
  // 一条记录落进来（宿主发布 → 订阅者被通知 → 重绘）。
  value = { entries: [{ point: "authorize", mode: "enforce", action: "deny" }] };
  assert.equal(listeners.size, 1, "组件应当订阅了轮次数据（晚到的记录才有办法刷新）");
  for (const listener of listeners) listener();
  // 桩里的 useSyncExternalStore 只在渲染时读快照，所以这里直接重渲一次：
  // 真实 React 会在订阅回调后自动重绘。
  const after = deepRender(entry.component(owner));
  assert.ok(
    collectText(after).join("\n").includes("1 次判断"),
    `晚到的记录应当显示出来，实际：\n${collectText(after).join("\n")}`,
  );
});

// ---------------------------------------------------------------- 渲染

test("计数器：这一轮判断了 3 次就显示「3 次判断」", async () => {
  const { entry, dictionaries } = await judgementSlot();
  const t = translateWith(dictionaries);
  const tree = entry.component(
    ownerWith(
      7,
      [
        { point: "authorize", mode: "enforce", action: "deny", at: 1700000000000 },
        { point: "authorize", mode: "observe", action: "delegate", at: 1700000001000 },
        { point: "retrieval", mode: "enforce", action: "skip", at: 1700000002000 },
      ],
      t,
    ),
  );
  assert.ok(tree, "有记录时不该返回 null");
  const text = collectText(tree).join("\n");
  assert.ok(text.includes("3 次判断"), `应显示「3 次判断」，实际：\n${text}`);
  assert.equal(tree.props["data-decision-engine-judgement-count"], "3");
});

test("计数器：英文界面显示「3 judgements」", async () => {
  const { entry, dictionaries } = await judgementSlot();
  const t = translateWith(dictionaries, "en");
  const tree = entry.component(
    ownerWith(7, [
      { point: "authorize", mode: "enforce", action: "deny" },
      { point: "route", mode: "enforce", action: "keep" },
      { point: "skillPick", mode: "enforce", action: "redirect" },
    ], t),
  );
  const text = collectText(tree).join("\n");
  assert.ok(text.includes("3 judgements"), `英文应为「3 judgements」，实际：\n${text}`);
});

test("计数器：没有记录时返回 null（正常的轮次不占位）", async () => {
  const { entry, dictionaries } = await judgementSlot();
  const t = translateWith(dictionaries);
  assert.equal(entry.component(ownerWith(1, [], t)), null);
  assert.equal(entry.component(undefined), null, "连 owner 都没有时也不能炸");
  assert.equal(entry.component({}), null, "owner 里没有 turn 时也不能炸");
});

test("浮层：按决策点列出分账行（含观察/生效、放行/询问/拦截、降级）", async () => {
  const { entry, dictionaries } = await judgementSlot({ slots: { 0: true } });
  const t = translateWith(dictionaries);
  const tree = deepRender(
    entry.component(
      ownerWith(
        9,
        [
          { point: "authorize", mode: "enforce", action: "deny", at: 1700000000000 },
          { point: "authorize", mode: "observe", action: "ask", at: 1700000001000 },
          { point: "route", mode: "enforce", action: "keep", at: 1700000002000 },
          { point: "route", mode: "enforce", degraded: "timeout" },
        ],
        t,
      ),
    ),
  );
  const text = collectText(tree).join("\n");
  // 表头：总数 + 时间范围
  assert.ok(text.includes("本轮判断 3"), `表头应有总数，实际：\n${text}`);
  // 每个决策点一行，含中文名与分账
  assert.ok(text.includes("工具授权"), `应有决策点中文名，实际：\n${text}`);
  assert.ok(text.includes("模型路由"), text);
  assert.ok(
    text.includes("判断 2") && text.includes("观察 1") && text.includes("生效 1"),
    `应有观察/生效分账，实际：\n${text}`,
  );
  assert.ok(text.includes("判断 1"), `模型路由那一行应是「判断 1」，实际：\n${text}`);
  assert.ok(
    text.includes("放行 1") && text.includes("询问 1") && text.includes("拦截 1"),
    `应有裁决分账，实际：\n${text}`,
  );
  assert.ok(text.includes("降级 1") && text.includes("timeout"), `应有降级桶与原因，实际：\n${text}`);
  // 行按固定顺序：工具授权在模型路由之前
  assert.ok(text.indexOf("工具授权") < text.indexOf("模型路由"), "行应按决策点固定顺序排");
});

test("浮层：挂在 document.body 上（portal），且有关闭按钮与 aria", async () => {
  const { entry, dictionaries } = await judgementSlot({ slots: { 0: true } });
  const t = translateWith(dictionaries);
  const tree = deepRender(
    entry.component(ownerWith(9, [{ point: "authorize", mode: "enforce", action: "deny" }], t)),
  );
  /** 递归收集 portal 节点与 button 节点。 */
  const walk = (node, out = { portals: [], buttons: [], dialogs: [] }) => {
    if (node === null || node === undefined || node === false) return out;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (typeof node !== "object") return out;
    if (node.type === "portal") out.portals.push(node);
    if (node.type === "button") out.buttons.push(node);
    if (node.props?.role === "dialog") out.dialogs.push(node);
    walk(node.children, out);
    return out;
  };
  const found = walk(tree);
  assert.equal(found.portals.length, 1, "浮层应该只挂一次");
  assert.equal(found.portals[0].props.container, "BODY", "必须挂在 document.body 上（否则被祖先层叠上下文夹住）");
  assert.equal(found.dialogs.length, 1, "浮层应该带 role=dialog");
  // 计数器按钮：aria-haspopup=dialog + aria-expanded（键盘可达 + 状态可读）
  const trigger = found.buttons.find((button) => button.props["aria-haspopup"] === "dialog");
  assert.ok(trigger, "计数器应该是 button（键盘可达）");
  assert.equal(trigger.props["aria-expanded"], true);
  // 关闭按钮：aria-label 是「关闭浮层」。特意不叫「关闭」——EN_CONFIG 已把
  // 「关闭」登记成 "Off"（提供方开关的档位名），同一句中文两处语义不同，
  // 文案形态只能有一个英文，按钮的 aria-label 换成了不会撞车的说法
  //（对应 lib/client.js 里 JUDGEMENT_ZH 与 EN_CONFIG 的注释）。
  const close = found.buttons.find((button) => button.props["aria-label"] === "关闭浮层");
  assert.ok(close, "应有带 aria-label 的关闭按钮（点它关闭）");
  assert.equal(typeof close.props.onClick, "function", "关闭按钮要真的能点");
});

test("浮层：关闭时（open=false）不渲染浮层", async () => {
  const { entry, dictionaries } = await judgementSlot({ slots: { 0: false } });
  const t = translateWith(dictionaries);
  const tree = deepRender(
    entry.component(ownerWith(9, [{ point: "authorize", mode: "enforce", action: "deny" }], t)),
  );
  const json = JSON.stringify(tree);
  assert.ok(!json.includes("BODY"), "关闭状态下不该有 portal");
});

test("浮层：遮罩点击 — 点遮罩关，点卡片内部不关", async () => {
  const { entry, dictionaries, setStateCalls } = await judgementSlot({ slots: { 0: true } });
  const t = translateWith(dictionaries);
  const tree = deepRender(
    entry.component(ownerWith(9, [{ point: "authorize", mode: "enforce", action: "deny" }], t)),
  );
  const scrim = findByProp(tree, "data-decision-engine-judgement-scrim", true);
  assert.ok(scrim, "应有遮罩层");
  assert.equal(typeof scrim.props.onClick, "function", "遮罩要能点");
  // 点卡片内部：target !== currentTarget，不该关。
  const before = setStateCalls.length;
  scrim.props.onClick({ target: { inside: true }, currentTarget: scrim.props });
  assert.equal(setStateCalls.length, before, "点卡片内部不该关（会误伤选文字这类操作）");
  // 点遮罩本身：target === currentTarget，关。
  scrim.props.onClick({ target: scrim.props, currentTarget: scrim.props });
  assert.deepEqual(setStateCalls.at(-1), { index: 0, value: false }, "点遮罩应把 open 置为 false");
});

test("浮层：Esc 关（监听挂在 document 上，卸载时摘掉）", async () => {
  const { entry, dictionaries, setStateCalls, effectCleanups } = await judgementSlot({ slots: { 0: true } });
  const t = translateWith(dictionaries);
  fakeDocument.listeners = [];
  // deepRender：浮层是函数组件，react 桩不会执行它——不展开就看不到它挂的 effect。
  deepRender(entry.component(ownerWith(9, [{ point: "authorize", mode: "enforce", action: "deny" }], t)));
  const keydowns = fakeDocument.listeners.filter((entry2) => entry2.type === "keydown");
  assert.equal(keydowns.length, 1, "浮层打开时应挂上一条 keydown 监听");
  const before = setStateCalls.length;
  keydowns[0].handler({ key: "Escape" });
  assert.deepEqual(setStateCalls.at(-1), { index: 0, value: false }, "Esc 应把 open 置为 false");
  // 别的键不该关。
  keydowns[0].handler({ key: "a" });
  assert.equal(setStateCalls.length, before + 1, "按别的键不该关");
  effectCleanups.forEach((cleanup) => cleanup());
  assert.equal(fakeDocument.listeners.filter((entry2) => entry2.type === "keydown").length, 0, "卸载时应摘掉监听");
});

test("失效开放：t 缺失 / 数据畸形时也不炸（报告通路不能弄坏聊天）", async () => {
  const { entry } = await judgementSlot({ slots: { 0: true } });
  // 没有 t（宿主没注入）：组件应照常渲染，只是文案退化成 key。
  const tree = entry.component({
    turn: { data: { get: () => ({ kind: "turn", turn: 1, value: { entries: [{ point: "authorize", mode: "enforce", action: "deny" }] } }) } },
  });
  assert.ok(tree, "没有 t 时不能炸");
  // data.get 返回畸形值：entries 不是数组 → 视为没有记录 → null。
  assert.equal(
    entry.component({ turn: { data: { get: () => ({ value: { entries: "boom" } }) } } }),
    null,
  );
});

// ---------------------------------------------------------------- 客户端 / 服务端一致性

test("一致性：客户端的事件类型与轮次数据键名与服务端一致", () => {
  assert.equal(JUDGEMENT_EVENT_TYPE, SERVER_EVENT_TYPE, "客户端匹配的事件类型必须与服务端发布的一致");
  assert.equal(TURN_DATA_KEY, "decision-engine-judgement");
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(source.includes(SERVER_EVENT_TYPE), "客户端 bundle 里没有这个事件类型（两份跑偏了）");
  assert.ok(source.includes(TURN_DATA_KEY), "客户端 bundle 里没有这个轮次数据键名");
});

test("一致性：客户端的裁决映射与 lib/outcomes.js 的 OUTCOME_MATRIX 逐字相同", () => {
  assert.deepEqual(VERDICT_MATRIX, OUTCOME_MATRIX);
  assert.deepEqual(LEGACY_UNKNOWN_POINT_VERDICTS, LEGACY_UNKNOWN_POINT_OUTCOMES);
  // 逐个（点, 词）比对两份查表结果，避免「表看起来一样但查法不同」。
  for (const [point, bucket] of Object.entries(OUTCOME_MATRIX)) {
    for (const kind of Object.keys(bucket)) {
      assert.equal(verdictOf(point, kind), outcomeOf(point, kind), `${point}.${kind} 两侧不一致`);
    }
  }
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const point of Object.keys(OUTCOME_MATRIX)) {
    assert.ok(source.includes(`${point}:`), `客户端 bundle 缺少决策点「${point}」的裁决映射`);
  }
});

test("一致性：决策点清单与顺序与 lib/decision-points.js 相同", () => {
  assert.deepEqual(POINT_ORDER, DECISION_POINTS.map((point) => point.id));
  for (const point of DECISION_POINTS) {
    assert.ok(POINT_LABELS[point.id] !== undefined, `客户端缺少决策点「${point.id}」的中文名`);
  }
  // 英文名与服务端 labelEn 对齐（cotTranslate 在客户端叫「思维链翻译」，是同一个点的简称）。
  for (const point of DECISION_POINTS) {
    assert.ok(POINT_LABELS_EN[point.id] !== undefined, `客户端缺少决策点「${point.id}」的英文名`);
  }
  assert.equal(POINT_LABELS.unknown, "决策引擎", "unknown 也要有名字（服务端的别名表可能映射不过来）");
});

test("一致性：服务端归一化出来的记录，客户端能原样吃下", () => {
  const record = normalizeJudgement({ turn: 4, point: "guard", mode: "enforce", action: "deny" });
  const entry = judgementFromEvent({ type: SERVER_EVENT_TYPE, time: 1, data: record });
  assert.equal(entry.point, "authorize", "服务端的 guard 别名应已归一成 authorize");
  assert.equal(entry.action, "deny");
  const summary = summarizeTurn([entry]);
  assert.equal(summary.total, 1);
  assert.equal(summary.rows[0].reject, 1);

  const degraded = normalizeJudgement({ turn: 4, point: "nope", mode: "observe", degraded: "timeout" });
  const degradedEntry = judgementFromEvent({ type: SERVER_EVENT_TYPE, data: degraded });
  assert.equal(degradedEntry.point, "unknown", "认不出的点归一成 unknown，而不是丢掉");
  const degradedSummary = summarizeTurn([degradedEntry]);
  assert.equal(degradedSummary.total, 0, "降级不是判断");
  assert.equal(degradedSummary.rows[0].degraded, 1);
  assert.equal(pointIdOf("nope"), "unknown");
});
