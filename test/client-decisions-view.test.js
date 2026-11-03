/**
 * 「决策历史」标签页的渲染测试（DEC-022）。
 *
 * 防的是这几类错：
 *
 *   1. **列表顺序错了**——决策历史的时间顺序是这个页面的全部意义。
 *   2. **字段没显示**——provider / model / 裁决 / 耗时缺一列，用户就看不出
 *      「这次到底问的是谁、答了什么」。
 *   3. **展开看不到内容**——「问了什么、答了什么」是这个页面的核心用途。
 *   4. **空态是空白**——没有记录时应该有一句可读的话，而不是一片空白。
 *   5. **英文界面残留中文**——切换语言后混着中文，比全英文更难读。
 *   6. **一条坏记录搞崩整页**——明细是用户可编辑的文件，不能信它。
 *
 * 做法：把客户端 bundle 真正跑起来（提供最小 react 桩），拿到注册的
 * `conversation.view` 组件，用固定顺序的 useState 注入数据，然后渲染。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** 每次加载都要拿到一份新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/** 中文字符（含全角标点）——英文界面里出现任何一个都算漏翻。 */
const CJK = /[一-鿿　-〿＀-￯]/;

/**
 * DecisionsView 的 useState 顺序（改动这个顺序时同步改这里）：
 *
 *   0 page      1 error    2 loading
 *   3 expanded  4 labels   5 sort
 */
const SLOTS = {
  page: 0,
  error: 1,
  loading: 2,
  expanded: 3,
  // 点名表与排序状态在**最后**声明：本文件按「第 n 个 useState」注入状态，
  // 往中间插一个新槽位会把后面全部挪位，测试会静默断言错对象。
  labels: 4,
  sort: 5,
};

/** 一条最小明细记录（与服务端返回的形状一致）。 */
function entry(over = {}) {
  const seq = over.seq ?? 1;
  return {
    v: 1,
    // `id` 是服务端补齐的**全局唯一**标识（存储层保证），界面用它当 React key
    // 与展开标识。`seq` 只是**排序**用的进程内计数器，跨重启会重复——真实数据
    // 里 307 条只有 119 个不同的 seq，拿它当身份会「点第二行展开第三行」。
    // 夹具默认带 id（且由 seq 派生，保证一份夹具里多条记录不会撞 id），
    // 就是为了让测试走与真机同一条路。
    id: `rec-${seq}`,
    seq,
    ts: "2026-11-03T08:30:00.000Z",
    sessionId: "session-abcdef0123456789",
    point: "authorize",
    provider: "bamboonode",
    model: "startlux-decision-27b-autothink",
    action: "delegate",
    detail: "decision-engine: 风险低，放行",
    cached: false,
    degraded: false,
    latencyMs: 1689,
    inputTokens: 2713,
    outputTokens: 12,
    capture: "full",
    ...over,
  };
}

/**
 * 加载客户端 bundle，拿到注册的 `conversation.view` 组件。
 *
 * @param options.lang - 宿主语言："zh"（默认）或 "en"。
 * @param options.status - `/status` 的响应（决定 tab 是否挂载）。
 * @param options.page - `/session-decisions` 的响应。
 * @returns `{ view, i18n }`：`view` 是组件函数（没挂载时为 null）。
 */
async function loadClient({ lang = "zh", status = {}, page = null } = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const unique = `\n// decisions-view-test-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect() {
      /* SSR 语义：effect 不执行，正好避免真实网络请求与定时器。 */
    },
    useMemo: (fn) => fn(),
  };

  const registered = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes("/session-decisions")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(page ?? { entries: [] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(status) };
  };

  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
        const ctx = {
          logger: { info() {}, warn() {} },
          locale: {
            register: () => () => {},
            getSnapshot: () => ({ active: lang, locales: [], revision: 1 }),
            subscribe: () => () => {},
          },
          slots: {
            inject(_slot, callback) {
              const disposer = callback();
              return () => {
                try {
                  disposer?.();
                } catch {
                  /* 忽略 */
                }
              };
            },
            register(meta, component) {
              registered.push({ meta, component });
              return () => {};
            },
          },
          effect(body) {
            const iterator = body();
            let step = iterator.next();
            while (!step.done) step = iterator.next(step.value);
            return () => {};
          },
          on() {},
        };
        bundle.apply(ctx);
      },
    },
  };

  try {
    await import(dataUrl);
    // reconcile 是异步的（要等 /status 回来），给它一点时间。
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const found = registered.find((item) => item.meta?.name === "conversation.view");
  return { view: found?.component ?? null, meta: found?.meta ?? null, registered };
}

// ------------------------------------------------------------------ 注册

test("决策历史以 conversation.view 注册，order 排在内置 tab 之后", async () => {
  const { view, meta } = await loadClient({ status: { decisionsTabEnabled: true } });
  assert.ok(view, "决策历史视图应当被注册");
  assert.equal(meta.name, "conversation.view");
  assert.equal(meta.id, "decisions");
  // 内置的 chat 是 0、trajectory 是 10；我们取 15，紧跟其后，
  // 且在第三方插件（retrace 20 / git-panel 30）之前。
  assert.equal(meta.order, 15);
  assert.ok(meta.order > 10, "应排在轨迹之后");
});

test("开关关闭时不注册这个视图", async () => {
  const { view, registered } = await loadClient({ status: { decisionsTabEnabled: false } });
  assert.equal(view, null, "关闭时不该挂载这个标签页");
  const names = registered.map((item) => item.meta?.name).filter(Boolean);
  assert.equal(names.includes("conversation.view"), false);
});

test("标签名是随语言重读的 thunk（切换语言不必重新注册）", async () => {
  const { meta } = await loadClient({ status: { decisionsTabEnabled: true }, lang: "zh" });
  assert.equal(typeof meta.label, "function", "label 应该是 thunk");
  assert.equal(meta.label(), "决策历史");
});

// ------------------------------------------------------------------ 渲染

/**
 * 渲染视图，并且**真的有状态**：useState 会跨渲染保留，setState 会触发
 * 重渲染，useEffect 会真的执行（带依赖比较），useCallback 会记忆化。
 *
 * ## 为什么必须做成有状态的
 *
 * 之前的版本把 `useState` 的 setter 写成空函数、`useEffect` 写成空操作。
 * 于是「点一下筛选芯片」这条路径**从来没有被真正执行过**——测试全绿，真机上
 * 点击却没有任何反应（2026-11-03 用户反馈）。只断言「初始画面」的渲染测试，
 * 对交互等于没测。
 *
 * @param options.page - `/session-decisions` 的响应；缺省时取 `slots[0]`。
 * @param options.sessionFails - 让 `/session-decisions` 失败（测错误态）。
 * @param options.decisions - `/decisions` 的响应（决策点名表）。
 * @param options.slots - 覆盖 useState 序号对应的初值。
 * @param options.lang - 宿主语言。
 * @param options.props - 传给组件的 props。
 */
async function renderDecisions({
  page,
  sessionFails = false,
  slots = {},
  lang = "zh",
  props = {},
  decisions = {
    points: [
      { id: "authorize", label: "工具授权" },
      { id: "retrieval", label: "检索必要性" },
      { id: "turnStop", label: "轮次延续" },
    ],
  },
} = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const unique = `\n// decisions-render-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  // —— useState 槽 ——
  // 只有 useState 占用「渲染测试序号」（SLOTS），因此 useRef / useCallback /
  // useEffect 用各自的计数器，不干扰 useState 的编号。
  const stateValues = [];
  const stateInit = new Set();
  let stateIndex = 0;
  // —— 其余 hook 槽 ——
  const memoValues = [];
  const refValues = [];
  const effectValues = [];
  let memoIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let pendingEffects = [];

  /** 依赖比较：与 React 一致用引用相等（`Object.is`），不做深比较。 */
  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
    return true;
  };

  const reactStub = {
    createElement(type, props2, ...children) {
      return { type, props: props2 ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = stateIndex;
      stateIndex += 1;
      if (!stateInit.has(index)) {
        stateValues[index] = Object.hasOwn(slots, index)
          ? slots[index]
          : typeof initial === "function"
            ? initial()
            : initial;
        stateInit.add(index);
      }
      return [
        stateValues[index],
        (next) => {
          const value = typeof next === "function" ? next(stateValues[index]) : next;
          if (!Object.is(value, stateValues[index])) stateValues[index] = value;
        },
      ];
    },
    // 记忆化：没有它，`load` 每次渲染都是新函数 → 依赖 [load] 的 effect
    // 每轮都重跑 → 无限「取数 → setState → 再取数」。React 里 useCallback
    // 就是干这个的，桩必须照做，否则测出来的行为不是真实行为。
    useCallback(fn, deps) {
      const index = memoIndex;
      memoIndex += 1;
      const prev = memoValues[index];
      if (prev && sameDeps(prev.deps, deps)) return prev.value;
      memoValues[index] = { deps, value: fn };
      return fn;
    },
    useMemo(fn, deps) {
      const index = memoIndex;
      memoIndex += 1;
      const prev = memoValues[index];
      if (prev && sameDeps(prev.deps, deps)) return prev.value;
      const value = fn();
      memoValues[index] = { deps, value };
      return value;
    },
    useRef(value) {
      const index = refIndex;
      refIndex += 1;
      if (!(index in refValues)) refValues[index] = { current: value };
      return refValues[index];
    },
    useEffect(fn, deps) {
      const index = effectIndex;
      effectIndex += 1;
      pendingEffects.push({ index, fn, deps });
    },
  };

  const registered = [];
  const originalFetch = globalThis.fetch;
  // 注入的 page 优先；没给就退回「测试通过 slots[0] 注入的那一份」，
  // 否则 load() 会把注入的夹具覆盖成空列表，测试全部落空。
  const pagePayload = page !== undefined ? page : (Object.hasOwn(slots, 0) ? slots[0] : { entries: [] });
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.includes("/session-decisions")) {
      if (sessionFails) return { ok: false, status: 500, text: async () => JSON.stringify({ error: "后台不可达" }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(pagePayload ?? { entries: [] }) };
    }
    if (text.includes("/decisions")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(decisions ?? { points: [] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ decisionsTabEnabled: true }) };
  };

  globalThis.window = {
    // 定时器**不真的建**：视图里有 5 秒轮询，真建了测试进程会一直挂着。
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
        const ctx = {
          logger: { info() {}, warn() {} },
          locale: {
            register: () => () => {},
            getSnapshot: () => ({ active: lang, locales: [], revision: 1 }),
            subscribe: () => () => {},
          },
          slots: {
            inject(_slot, callback) {
              const disposer = callback();
              return () => {
                try {
                  disposer?.();
                } catch {
                  /* 忽略 */
                }
              };
            },
            register(meta, component) {
              registered.push({ meta, component });
              return () => {};
            },
          },
          effect(body) {
            const iterator = body();
            let step = iterator.next();
            while (!step.done) step = iterator.next(step.value);
            return () => {};
          },
          on() {},
        };
        bundle.apply(ctx);
      },
    },
  };

  let current = null;
  const cleanups = [];

  /**
   * 渲染一轮并把它排队/触发的 effect 落定。
   *
   * 循环上界 8：effect 里会 setState（取数、点名表），需要重渲染才能收敛；
   * 给个上界是为了万一出现「setState ↔ effect」互相触发时不至于死循环。
   */
  const renderAndSettle = async () => {
    const component = registered.find((item) => item.meta?.name === "conversation.view")?.component;
    if (!component) return null;
    for (let round = 0; round < 8; round += 1) {
      stateIndex = 0;
      memoIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      pendingEffects = [];
      current = component({ sessionId: "session-abcdef0123456789", ...props });
      const queued = pendingEffects;
      if (queued.length === 0) break;
      // 只跑依赖变了的 effect（与 React 一致）。
      const toRun = queued.filter((item) => {
        const prev = effectValues[item.index];
        return !(prev && sameDeps(prev.deps, item.deps));
      });
      if (toRun.length === 0) break;
      for (const item of toRun) {
        effectValues[item.index] = { deps: item.deps };
        const cleanup = item.fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return current;
  };

  try {
    await import(dataUrl);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await renderAndSettle();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const found = registered.find((item) => item.meta?.name === "conversation.view");
  assert.ok(found, "视图应已注册");

  const textOf = () => collectText(current).join("\n");
  const buttons = () => {
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "button") out.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    walk(current);
    return out;
  };
  const dataRows = () => {
    const out = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      // 数据行 = 带 onClick 的 tr（表头那一行没有 onClick）。
      if (node.type === "tr" && typeof node.props?.onClick === "function") out.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    walk(current);
    return out;
  };

  /**
   * tbody 里各行的**实际顺序**，形如 `["row:08:00", "row:08:01", "detail:…", "row:08:02"]`。
   *
   * 存在的理由：判断「点第 n 行、详情插在第 n 行后面」必须看**行的先后**，
   * 而收集所有行会把顺序信息丢掉——真机上那个错位正是顺序问题
   * （点第二行、详情跑到第三行后面），只看「有没有展开」是抓不到的。
   */
  const tbodySequence = () => {
    const out = [];
    const findBody = (node) => {
      if (!node || typeof node !== "object") return null;
      if (node.type === "tbody") return node;
      for (const child of node.children ?? []) {
        const hit = findBody(child);
        if (hit) return hit;
      }
      return null;
    };
    const body = findBody(current);
    if (!body) return out;
    for (const tr of body.children ?? []) {
      if (!tr || typeof tr !== "object") continue;
      const text = collectText(tr).join(" ");
      const clickable = typeof tr.props?.onClick === "function";
      if (clickable) {
        const clock = text.match(/\d{2}:\d{2}:\d{2}/);
        out.push(`row:${clock ? clock[0] : text.slice(0, 10)}`);
      } else {
        out.push(`detail:${text.includes("UNIQUE_MARKER") ? "MARKER" : text.slice(0, 16)}`);
      }
    }
    return out;
  };

  return {
    get text() {
      return textOf();
    },
    get tree() {
      return current;
    },
    /** 点第 n 条数据行（0 起），用于展开/收起。 */
    async clickRow(index) {
      const list = dataRows();
      assert.ok(list.length > index, `只有 ${list.length} 行，取不到第 ${index} 行`);
      list[index].props.onClick();
      await renderAndSettle();
      return textOf();
    },
    /**
     * 点第 n 个表头（0 起，与列定义顺序一致），用于排序交互。
     *
     * 排序缺陷与展开错位同型：只看初始画面测不出来，必须真的点、
     * 然后断言行的先后与箭头指示。
     */
    async clickTh(index) {
      const ths = findNodes(current, "th");
      assert.ok(ths.length > index, `只有 ${ths.length} 个表头，取不到第 ${index} 个`);
      ths[index].props.onClick();
      await renderAndSettle();
      return textOf();
    },
    /** 当前渲染出的所有按钮的可见文本（用于断言「某个控件在不在」）。 */
    buttonTexts() {
      return buttons().map((node) => collectText(node).join(""));
    },
    /** tbody 里各行的实际先后顺序（见函数定义处的说明）。 */
    tbodySequence,
  };
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
  if (node.children !== undefined) collectText(node.children, out);
  return out;
}

test("列出本会话的决策：时间、决策点、提供方、模型、裁决、耗时", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        sessionId: "session-abcdef0123456789",
        entries: [entry({ seq: 1, tool: "bash" })],
        total: 1,
        truncated: false,
        file: "/tmp/decisions.jsonl",
      },
      [SLOTS.loading]: false,
    },
  });
  assert.match(text, /工具授权/, "应显示决策点的中文名");
  assert.match(text, /bamboonode/, "应显示提供方");
  assert.match(text, /startlux-decision-27b-autothink/, "应显示模型");
  assert.match(text, /delegate/, "应显示裁决");
  assert.match(text, /1689ms/, "应显示耗时");
  assert.match(text, /2026-11-03 08:30:00/, "应显示时间");
});

test("多条记录按时间顺序列出", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({ seq: 1, ts: "2026-11-03T08:00:00.000Z", tool: "first" }),
          entry({ seq: 2, ts: "2026-11-03T08:10:00.000Z", tool: "second" }),
        ],
        total: 2,
      },
      [SLOTS.loading]: false,
    },
  });
  const firstAt = text.indexOf("2026-11-03 08:00:00");
  const secondAt = text.indexOf("2026-11-03 08:10:00");
  assert.ok(firstAt >= 0 && secondAt >= 0, "两条时间都要出现");
  assert.ok(firstAt < secondAt, "应按时间升序");
});

test("展开后能看到决策内容：现场、问题、回答、分数", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({
            seq: 7,
            id: "rec-open",
            scores: { risk_p: 0.97 },
            content: {
              state: { tool: "bash", args_preview: "ls -la" },
              questions: { risk: { type: "choice" } },
              answers: { risk: { type: "choice", choice: "low" } },
            },
          }),
        ],
        total: 1,
      },
      [SLOTS.loading]: false,
      [SLOTS.expanded]: "rec-open",   // 展开标识是 id，不是 seq
    },
  });
  assert.match(text, /args_preview/, "应能看到发给决策模型的现场");
  assert.match(text, /questions|choice/, "应能看到问题集");
  assert.match(text, /choice/, "应能看到回答");
  assert.match(text, /risk_p/, "应能看到分数");
});

test("没有内容时明确说明「只保存了元数据」", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: { entries: [entry({ seq: 3, id: "rec-meta", capture: "meta" })], total: 1 },
      [SLOTS.loading]: false,
      [SLOTS.expanded]: "rec-meta",
    },
  });
  assert.match(text, /只保存了元数据/, "应说明这条没有内容");
});

test("没有记录时给出可读的空态", async () => {
  const { text } = await renderDecisions({
    slots: { [SLOTS.page]: { entries: [], total: 0 }, [SLOTS.loading]: false },
  });
  assert.match(text, /本会话还没有决策记录/);
  assert.match(text, /决策点都处于「关闭」时不会产生记录/, "应说明为什么没有记录");
});

test("读取失败时显示原因而不是空白", async () => {
  // 走**真实的失败路径**（让 /session-decisions 真的失败），而不是注入一个
  // error 状态：注入了就测不到「取数失败 → setError → 渲染」这条链路。
  const { text } = await renderDecisions({ sessionFails: true });
  assert.match(text, /读取决策历史失败/);
  assert.match(text, /后台不可达/);
});

test("一条坏记录不会让整页崩掉", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [entry({ seq: 1 }), null, { seq: 3 }],
        total: 3,
      },
      [SLOTS.loading]: false,
    },
  });
  assert.match(text, /工具授权/, "好记录仍应渲染");
});

test("没有会话 id 时显示提示而不是崩溃", async () => {
  const { text } = await renderDecisions({
    slots: { [SLOTS.page]: null, [SLOTS.loading]: false },
    props: { sessionId: "" },
  });
  assert.ok(text.length > 0, "应给出可读提示");
});

test("被截断时提示还有更多记录", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: { entries: [entry()], total: 500, truncated: true },
      [SLOTS.loading]: false,
    },
  });
  assert.match(text, /还有更多记录没有显示/);
});

test("缓存命中与降级各有标记", async () => {
  const { text } = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [entry({ seq: 1, cached: true }), entry({ seq: 2, degraded: true })],
        total: 2,
      },
      [SLOTS.loading]: false,
    },
  });
  assert.match(text, /缓存命中/);
  assert.match(text, /已降级/);
});

test("英文界面里没有中文残留（UI 文案；记录内容是数据，不算）", async () => {
  const { text } = await renderDecisions({
    lang: "en",
    slots: {
      [SLOTS.page]: {
        entries: [
          // 所有**界面**字段都是纯数据（时间/模型/裁决词），只有 detail 是
          // 服务端写的原始审计文本——它本来就可能含中文，且**不该被翻译**
          // （翻译审计记录等于篡改记录）。这里给一条英文 detail，把「UI 文案
          // 是否漏翻」这件事单独隔离出来测。
          entry({
            seq: 1,
            detail: "decision-engine: low risk, allowed",
            scores: { risk_p: 0.9 },
            content: { state: { tool: "bash" }, questions: {}, answers: {} },
          }),
        ],
        total: 1,
      },
      [SLOTS.loading]: false,
      [SLOTS.expanded]: "rec-1",
    },
  });
  const offenders = text.split("\n").filter((line) => CJK.test(line));
  assert.deepEqual(offenders, [], `英文界面的 UI 文案里出现了中文：\n${offenders.join("\n")}`);
  assert.match(text, /Tool authorization/, "决策点应显示英文名");
  assert.match(text, /Decisions|Refresh|Verdict/, "表头/按钮应显示英文");
});

test("原始审计文本原样输出，不被翻译（记录不被篡改）", async () => {
  const { text } = await renderDecisions({
    lang: "en",
    slots: {
      [SLOTS.page]: {
        entries: [entry({ seq: 1, detail: "decision-engine: 风险低，放行" })],
        total: 1,
      },
      [SLOTS.loading]: false,
      [SLOTS.expanded]: "rec-1",
    },
  });
  // detail 是数据：英文界面下它仍是原文（这正是审计记录应有的行为）。
  assert.match(text, /风险低，放行/, "审计原文不能被翻译");
});

// ------------------------------------------------------------------ 表头冻结

/** 深度遍历渲染树，收集指定类型的节点。 */
function findNodes(node, type, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, type, out);
    return out;
  }
  if (typeof node === "object") {
    if (node.type === type) out.push(node);
    if (node.children !== undefined) findNodes(node.children, type, out);
  }
  return out;
}

/**
 * 表头冻结的三个必要条件，逐个钉住。
 *
 * 这一组断言的存在理由：sticky 失效**不会报错、不会让测试变红**，
 * 只有人眼在浏览器里滚动才看得出来——所以必须把它拆成可断言的样式事实。
 * 少任何一条，表头就会「跟着一起滚走」（2026-11-03 真机就是这样）。
 */
test("表头 sticky 的前提条件都在", async () => {
  const { tree } = await renderDecisions({
    slots: {
      [SLOTS.page]: { entries: [entry({ seq: 1 })], total: 1 },
      [SLOTS.loading]: false,
    },
  });

  const ths = findNodes(tree, "th");
  assert.ok(ths.length >= 7, `应有 7 个表头单元格，实际 ${ths.length}`);
  for (const th of ths) {
    // 条件 1：粘到滚动容器上沿。
    assert.equal(th.props.style.position, "sticky", "th 必须 sticky");
    assert.equal(th.props.style.top, 0, "sticky 必须给 top，否则不会粘");
    // 条件 3：背景不透明——半透明会让正文从表头底下透出来。
    const background = String(th.props.style.background ?? "");
    assert.ok(background.length > 0, "th 必须有背景色，否则行会透上来");
    assert.equal(background.includes("rgba("), false, `背景不能半透明：${background}`);
  }

  // 条件 2 之一：表必须是 border-collapse: separate。
  // collapse 会让 Chrome / Safari 上的 sticky th 直接失效。
  const tables = findNodes(tree, "table");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].props.style.borderCollapse, "separate", "collapse 会破坏 sticky thead");
});

test("表头粘的滚动容器一定会滚（不依赖宿主布局）", async () => {
  const { tree } = await renderDecisions({
    slots: {
      [SLOTS.page]: { entries: [entry({ seq: 1 })], total: 1 },
      [SLOTS.loading]: false,
    },
  });

  // 表格外层必须有一个滚动容器。关键在它用 **maxHeight**：
  // `height:100%` 需要父级有确定高度，而宿主那条 flex 链会长到内容高度，
  // 于是 100% 退化成 auto —— 内层永远不出滚动条，sticky 等于没设（真机踩到）。
  const divs = findNodes(tree, "div");
  // 详情块自己也有 overflowY:auto（限高 420px），所以判据必须带上
  // 「maxHeight 相对视口」——只有表头那个滚动容器同时满足两条。
  const scroller = divs.find((node) => {
    const style = node.props?.style ?? {};
    return style.overflowY === "auto" && typeof style.maxHeight === "string" && style.maxHeight.includes("vh");
  });
  assert.ok(scroller, "表格外层应有一个滚动容器");
  const style = scroller.props.style;
  assert.equal(typeof style.maxHeight, "string", "滚动容器必须由 maxHeight 限高");
  assert.match(style.maxHeight, /vh/, "限高要相对视口，才与父级高度无关");
  assert.equal(style.height, undefined, "不该用 height:100%（宿主 flex 链下会失效）");
  // 视口很矮时 `100vh - 200px` 会塌成零甚至负数，列表直接看不见。必须用
  // CSS max() 在同一个值里兜住下限——不用 minHeight，因为那会在一两行记录时
  // 于表格下方强行留出一片空白。
  assert.match(style.maxHeight, /^max\(/, "maxHeight 必须自带下限，防短视口塌成零高");
  assert.equal(style.minHeight, undefined, "不该用 minHeight（会在记录很少时留空白）");
});

test("滚动容器之上不再有任何 overflow/height 祖先截胡 sticky", async () => {
  const { tree } = await renderDecisions({
    slots: {
      [SLOTS.page]: { entries: [entry({ seq: 1 })], total: 1 },
      [SLOTS.loading]: false,
    },
  });
  // 根容器（decisionsWrap）必须是「普通块级盒」：它一旦 overflow 或定高，
  // 就会变成 sticky 的裁剪/滚动祖先，把粘性从真正的滚动区抢走。
  const root = tree;
  const rootStyle = root.props?.style ?? {};
  assert.equal(rootStyle.overflow, undefined, "根容器不能设 overflow");
  assert.equal(rootStyle.overflowY, undefined, "根容器不能设 overflowY");
  assert.equal(rootStyle.overflowX, undefined, "根容器不能设 overflowX");
  assert.equal(rootStyle.height, undefined, "根容器不能定高（宿主 flex 链下无意义）");
});

// ------------------------------------------------------------------ 交互
//
// 这一组测的是「点一下到底有没有反应」。之前那版测试桩把 setState 写成空操作，
// 于是这类缺陷**测不出来**——测试全绿而真机点击无效。桩现在还保持有状态，
// 因为这正是「展开/收起」这类交互的前提。

/** 两条不同决策点的记录（用于验证点名表与多行渲染）。 */
const TWO_POINTS = {
  entries: [
    entry({ seq: 1, ts: "2026-11-03T08:00:00.000Z", point: "authorize", action: "delegate" }),
    entry({ seq: 2, ts: "2026-11-03T08:01:00.000Z", point: "turnStop", action: "stop" }),
  ],
  total: 2,
};

test("点击整行展开内容，再点收起", async () => {
  const view = await renderDecisions({
    page: {
      entries: [
        entry({
          seq: 1,
          scores: { risk_p: 0.9 },
          content: { state: { args_preview: "UNIQUE_MARKER" }, questions: {}, answers: {} },
        }),
      ],
      total: 1,
    },
  });
  assert.equal(/UNIQUE_MARKER/.test(view.text), false, "初始应折叠");
  await view.clickRow(0);
  assert.match(view.text, /UNIQUE_MARKER/, "点一下应展开出内容");
  await view.clickRow(0);
  assert.equal(/UNIQUE_MARKER/.test(view.text), false, "再点一次应收起");
});

test("决策点名表由视图自己拉取（不依赖宿主传 props）", async () => {
  // 宿主并不给 conversation.view 传点名字表，注册时也拿不到服务端数据。
  // 曾经因此把 props 当来源、兜底成 {}，真机上「决策点」列显示的是
  // turnStop 这种原始 id。
  const view = await renderDecisions({ page: TWO_POINTS });
  assert.match(view.text, /工具授权/, "应显示决策点中文名");
  assert.match(view.text, /轮次延续/, "应显示决策点中文名");
  assert.equal(/turnStop/.test(view.text), false, "不该把原始 id 当显示名");
});

test("不再有决策点筛选控件（该功能已移除）", async () => {
  // 用户要求去掉：这个交互反复出问题，移除比修更干净。
  // 断言「没有筛选按钮」比断言「筛选能用」更能防止它悄悄回来。
  const view = await renderDecisions({ page: TWO_POINTS });
  assert.deepEqual(
    view.buttonTexts(),
    ["刷新"],
    `只应剩「刷新」按钮，实际：${view.buttonTexts().join(" / ")}`,
  );
  assert.equal(/已筛选/.test(view.text), false, "不该残留筛选提示");
});

// ------------------------------------------------------------------ 展开定位
//
// 真机缺陷（2026-11-03）：「点击第二个，展开的是第三个」。
//
// 根因不在渲染逻辑，而在**身份标识**：服务端的 `seq` 只是**进程内**计数器，
// DSH 每重启一次就从 1 重数（实测用户文件里 307 条记录只有 119 个不同的 seq）。
// 界面拿它当 React `key`，重复 key 让事件处理器落到了错的行上。
//
// 这一组测试的前提是**多行**：单行永远测不出错位——之前就只测了单行。

/** 三行、时间可区分、内容带唯一标记的记录。 */
function threeRows({ sameSeq = false } = {}) {
  const ids = sameSeq ? ["p1-1", "p2-1", "p3-1"] : ["p1-1", "p1-2", "p1-3"];
  const seqs = sameSeq ? [1, 1, 1] : [1, 2, 3];
  return {
    entries: [0, 1, 2].map((index) =>
      entry({
        id: ids[index],
        seq: seqs[index],
        ts: `2026-11-03T08:0${index}:00.000Z`,
        point: "authorize",
        content: {
          state: { args_preview: `UNIQUE_MARKER_${index}` },
          questions: {},
          answers: {},
        },
      }),
    ),
    total: 3,
  };
}

test("点第二行，详情插在第二行后面（不是第三行后面）", async () => {
  const view = await renderDecisions({ page: threeRows() });
  const before = view.tbodySequence();
  assert.equal(before.length, 3, `初始应三行，实际：${before.join(" | ")}`);

  await view.clickRow(1);
  const after = view.tbodySequence();
  // 期望顺序：第一行、第二行、详情、第三行
  assert.equal(after.length, 4, `展开后应四行，实际：${after.join(" | ")}`);
  assert.match(after[0], /^row:/);
  assert.match(after[1], /^row:/);
  assert.match(after[2], /^detail:/, `详情应在第二行之后，实际顺序：${after.join(" | ")}`);
  assert.match(after[3], /^row:/, `第三行应被推到详情之后，实际：${after.join(" | ")}`);
});

test("点第一行与第三行也各自正确", async () => {
  // 断言**位置**而不是文本正则：正则写起来脆，且不匹配时只给一句含糊的
  // 失败信息；直接比「第几个是详情行」更清楚。
  const first = await renderDecisions({ page: threeRows() });
  await first.clickRow(0);
  const seqFirst = first.tbodySequence();
  assert.equal(seqFirst.length, 4, seqFirst.join(" | "));
  assert.match(seqFirst[0], /^row:/);
  assert.match(seqFirst[1], /^detail:/, `点第一行时详情应紧跟其后：${seqFirst.join(" | ")}`);
  assert.match(seqFirst[2], /^row:/);
  assert.match(seqFirst[3], /^row:/);

  const third = await renderDecisions({ page: threeRows() });
  await third.clickRow(2);
  const seqThird = third.tbodySequence();
  assert.equal(seqThird.length, 4, seqThird.join(" | "));
  assert.match(seqThird[2], /^row:/);
  assert.match(seqThird[3], /^detail:/, `点第三行时详情应在最后：${seqThird.join(" | ")}`);
});

test("seq 重复（DSH 重启后）仍按 id 定位：只展开被点的那一行", async () => {
  // 这正是真机数据的形态：多批记录共用同一批 seq。
  const view = await renderDecisions({ page: threeRows({ sameSeq: true }) });
  await view.clickRow(1);
  const seq = view.tbodySequence();
  const details = seq.filter((line) => line.startsWith("detail:"));
  assert.equal(details.length, 1, `seq 重复时也只该展开一行，实际：${seq.join(" | ")}`);
  assert.equal(seq[2].startsWith("detail:"), true, `详情应紧跟第二行：${seq.join(" | ")}`);
});

test("同一行点两次会收起，且不影响别的行", async () => {
  const view = await renderDecisions({ page: threeRows() });
  await view.clickRow(1);
  assert.equal(view.tbodySequence().length, 4);
  await view.clickRow(1);
  assert.equal(view.tbodySequence().length, 3, "再点一次应恢复三行");
});

// ------------------------------------------------------------------ 表头排序
//
// 用户要求（2026-11-03）：表头每一列都可点、按该列升序降序交替，
// 默认按时间升序。与「展开定位」一节同理：只断言初始画面测不出交互，
// 所以这里真的去点表头，然后看行的先后顺序。

/**
 * 三条时间与耗时可区分的记录：时间升序 = 08:00/08:01/08:02，
 * 耗时 3000/1000/2000——两个键的顺序故意错开，排错列会立刻显形。
 */
const SORT_FIXTURE = {
  entries: [
    entry({ seq: 1, ts: "2026-11-03T08:00:00.000Z", latencyMs: 3000 }),
    entry({ seq: 2, ts: "2026-11-03T08:01:00.000Z", latencyMs: 1000 }),
    entry({ seq: 3, ts: "2026-11-03T08:02:00.000Z", latencyMs: 2000 }),
  ],
  total: 3,
};

/** 列定义顺序：时间(0) 决策点(1) 提供方(2) 模型(3) 裁决(4) 耗时(5) 内容(6)。 */
const COL = { ts: 0, point: 1, provider: 2, model: 3, action: 4, latencyMs: 5, capture: 6 };

test("默认按时间升序", async () => {
  const view = await renderDecisions({ page: SORT_FIXTURE });
  assert.deepEqual(
    view.tbodySequence(),
    ["row:08:00:00", "row:08:01:00", "row:08:02:00"],
    `默认应是时间升序，实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("点「时间」表头：升序降序交替，箭头只画在当前列", async () => {
  const view = await renderDecisions({ page: SORT_FIXTURE });
  const thTexts = () => findNodes(view.tree, "th").map((th) => collectText(th).join(""));

  // 初始：时间列升序，↑ 只画在时间列。
  assert.match(thTexts()[COL.ts], /↑/, "当前排序列应带 ↑");
  assert.equal(/↑|↓/.test(thTexts()[COL.latencyMs]), false, "非排序列不该带箭头");

  await view.clickTh(COL.ts); // 已是升序 → 翻成降序
  assert.deepEqual(
    view.tbodySequence(),
    ["row:08:02:00", "row:08:01:00", "row:08:00:00"],
    `点一次应变降序，实际：${view.tbodySequence().join(" | ")}`,
  );
  assert.match(thTexts()[COL.ts], /↓/, "降序应带 ↓");

  await view.clickTh(COL.ts); // 再点 → 回到升序
  assert.deepEqual(
    view.tbodySequence(),
    ["row:08:00:00", "row:08:01:00", "row:08:02:00"],
    `再点应变回升序，实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("点「耗时」表头：首次降序（最慢在前），再点升序", async () => {
  const view = await renderDecisions({ page: SORT_FIXTURE });
  await view.clickTh(COL.latencyMs);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:08:00:00", "row:08:02:00", "row:08:01:00"],
    `首次点耗时应变降序（3000/2000/1000），实际：${view.tbodySequence().join(" | ")}`,
  );
  await view.clickTh(COL.latencyMs);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:08:01:00", "row:08:02:00", "row:08:00:00"],
    `再点应变升序（1000/2000/3000），实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("排完别的列再点「时间」：从升序起，且箭头跟着切换", async () => {
  const view = await renderDecisions({ page: SORT_FIXTURE });
  const thTexts = () => findNodes(view.tree, "th").map((th) => collectText(th).join(""));

  await view.clickTh(COL.latencyMs); // 排序列现在是耗时
  assert.match(thTexts()[COL.latencyMs], /↓/);
  assert.equal(/↑|↓/.test(thTexts()[COL.ts]), false, "箭头应从时间列挪走");

  await view.clickTh(COL.ts); // 首次点时间：升序
  assert.deepEqual(
    view.tbodySequence(),
    ["row:08:00:00", "row:08:01:00", "row:08:02:00"],
    `换列首次点击应从升序起，实际：${view.tbodySequence().join(" | ")}`,
  );
  assert.match(thTexts()[COL.ts], /↑/, "箭头应回到时间列");
  assert.equal(/↑|↓/.test(thTexts()[COL.latencyMs]), false, "耗时列不该再有箭头");
});
