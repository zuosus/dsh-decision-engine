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
 *   7. **新记录「直接蹦出来」**——列表每 5 秒轮询一次，刚多出来的那一条要看得
 *      见它出现（入场动画），而首屏那一整批和已有的行不能跟着动（DEC-044）。
 *
 *   第 1 条的「顺序」本身在 DEC-044 里改了口径：**默认按时间降序**（最新在上），
 *   所以这一族用例的期望都是「上面是刚发生的」。
 *
 * 做法：把客户端 bundle 真正跑起来（提供最小 react 桩），拿到注册的
 * `conversation.view` 组件，用固定顺序的 useState 注入数据，然后渲染。
 */

/**
 * 时间列渲染的是**运行环境本地时间**，不是 ISO 串的 UTC 挂钟。
 *
 * 所以「夹具里的 `08:00:00Z` 应该显示成几点」取决于机器时区。断言里写死
 * 字面量就必须先把时区钉住，否则同一份测试在北京过、在伦敦挂——那是最难查的
 * 一类失败。这里钉到 **Asia/Shanghai（+8，且刻意不是 UTC）**：
 *
 *   1. 夹具 ISO 里的 08:xx 恒等于本地 16:xx，期望值稳定且与机器无关；
 *   2. 因为**本地 ≠ UTC**，一旦有人把时间列退回「切一刀 ISO 串」的 UTC 挂钟
 *      渲染，这些用例会立刻变红——钉 UTC 就抓不到这一点（两者恰好相等）。
 *
 * 时区对 `Date` 的影响是进程级的，Node 在 `process.env.TZ` 赋值后即生效
 * （本地取值器读到新时区）。必须在加载 client bundle 之前设置。
 */
process.env.TZ = "Asia/Shanghai";

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
 *
 * 核对结论（DEC-044）：**0~8 一个编号都没动**。新增的行入场动画里，「已经见过
 * 哪些记录」的基线走 `useRef`（不占 useState 槽位）；「这一批要动画的 id」
 * （`newIds`）是后期从「渲染时对着 ref 现算」改成「取数那一刻存进 state」的
 * （动画挂在样式上，渲染时现算会被随后那次重绘掐断），它**追加在末尾** = 9，
 * 与 `labels` / `sort` / 比例三态同一条规矩，所以本文件不需要挪任何槽位。
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
  // 人工审核比例（DEC-035）的三个状态同样**追加在末尾**，理由同上：
  // 往中间插会挪走 labels / sort，测试会静默断言错对象。
  //   toleranceDraft   6  用户刚点的档位（乐观更新）
  //   toleranceSaving  7  正在 PUT
  //   toleranceError   8  保存失败原因
  toleranceDraft: 6,
  toleranceSaving: 7,
  toleranceError: 8,
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
 * @param options.reducedMotion - 模拟系统「减弱动态效果」开着（DEC-044）。
 * @param options.sessionId - 传给视图的会话 id（测「换会话」时改它）。
 */
async function renderDecisions({
  page,
  sessionFails = false,
  slots = {},
  lang = "zh",
  props = {},
  reducedMotion = false,
  sessionId = "session-abcdef0123456789",
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
  //
  // 用 `let`：`poll()` 要换掉它来模拟「下一轮轮询取到的数据不一样」
  // （DEC-044 的新增行判定只有真的换一批数据才测得出来）。
  let pagePayload = page !== undefined ? page : (Object.hasOwn(slots, 0) ? slots[0] : { entries: [] });
  // 视图（与插件生命周期）登记的定时器回调。`setInterval` **不真的建定时器**
  // （建了测试进程会挂着不退出），但回调要留着——否则「5 秒后又取了一次」
  // 这条真实路径在测试里永远跑不到，`poll()` 就是手动触发它们。
  //
  // 用 Map（句柄 → 回调）而不是数组：**`clearInterval` 必须真的生效**。轮询
  // effect 的依赖是 `load`，`load` 又只在换会话时换身份，所以 `switchSession`
  // 会触发一次「清掉旧定时器、装一个新回调」。若 `clearInterval` 是空操作，
  // 旧会话那个回调会留在表里，`poll()` 把两个都敲一遍 → 同一批数据被取两次，
  // 第二次是「没有新增」，把第一次刚置上的 `newIds` 抹成 `null`，动画凭空消失。
  // 这不是测试桩的洁癖：真机上浏览器**确实**会清掉旧定时器，桩不照做就是在
  // 测一条真机不存在的路径。
  const pollers = new Map();
  let timerSeq = 0;
  // 取数桩单独命名：挂载结束后 `globalThis.fetch` 会被还原（不污染别的文件），
  // 而 `poll()` 要再跑一次 `load()`，那时得把**这一份**桩临时装回去——
  // 用真的 fetch 去打相对地址会直接 reject，轮询落到 catch 分支，动画永远测不出。
  const fetchStub = async (url) => {
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
  globalThis.fetch = fetchStub;

  globalThis.window = {
    // 定时器**不真的建**：视图里有 5 秒轮询，真建了测试进程会一直挂着。
    // 但回调要留在 `pollers` 里给 `poll()` 用。返回的是一个**数字句柄**而不是
    // 0：句柄得能互相区分，`clearInterval` 才知道该撤掉哪一个（见 `pollers`）。
    // 数字上取属性是 undefined，所以实现里的 `timer?.unref?.()` 是安全的空操作。
    setInterval: (fn) => {
      timerSeq += 1;
      pollers.set(timerSeq, fn);
      return timerSeq;
    },
    clearInterval: (handle) => {
      pollers.delete(handle);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    // 新增行动画要读系统的「减弱动态效果」（DEC-044）。默认给一个「什么都没
    // 命中」的 matchMedia：真实浏览器里这个查询在无偏好时就返回 matches:false，
    // 桩不给 matchMedia 等于测的是「宿主没实现」那条兜底分支。
    matchMedia: (query) => ({ matches: reducedMotion && /prefers-reduced-motion/.test(query), media: query }),

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
  // 视图当前看到的会话 id。用 `let`：`switchSession()` 要换掉它来模拟宿主
  // **复用同一个视图实例**切到另一个会话（DEC-044 的基线清空就挂在这条路径上）。
  let activeSessionId = sessionId;

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
      current = component({ sessionId: activeSessionId, ...props });
      const queued = pendingEffects;
      if (queued.length === 0) break;
      // 只跑依赖变了的 effect（与 React 一致）。
      const toRun = queued.filter((item) => {
        const prev = effectValues[item.index];
        return !(prev && sameDeps(prev.deps, item.deps));
      });
      if (toRun.length === 0) break;
      for (const item of toRun) {
        // **先跑上一次的 cleanup，再跑这一次的 effect**——React 的顺序就是如此。
        // 少了这一步，`clearInterval` 永远不会被调用，换会话后旧会话的轮询回调
        // 还留在 `pollers` 里；更糟的是任何真实实现里「靠 cleanup 撤销上一轮」
        // 的代码在测试里都撤不掉，测出来的行为与真机不一致。
        const previous = effectValues[item.index];
        if (typeof previous?.cleanup === "function") previous.cleanup();
        effectValues[item.index] = { deps: item.deps, cleanup: item.fn() };
        if (typeof effectValues[item.index].cleanup === "function") {
          cleanups.push(effectValues[item.index].cleanup);
        }
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
   * 每条数据行的**记录 id**（取自行上的 React `key`，形如 `row-<id>`），
   * 顺序与 tbody 一致。
   *
   * 存在的理由：这一页默认按时间**降序**（DEC-044），而夹具是升序写的，于是
   * 「第 n 行」与「第 n 条记录」正好相反。按列断言一旦写死下标，改一次排序
   * 就得重算一遍下标，还会把「行序」这件事偷偷塞进本来只关心「某一列写了
   * 什么」的用例里。那一类用例应当**按 id 定位行**，与怎么排无关。
   */
  const rowIds = () => dataRows().map((tr) => String(tr.props?.key ?? "").replace(/^row-/, ""));

  /** 每条数据行的单元格文本（按列顺序）；`rowCells()` 的实现。 */
  const collectRowCells = () =>
    dataRows().map((tr) =>
      (tr.children ?? [])
        .filter((td) => td && typeof td === "object" && td.type === "td")
        .map((td) => collectText(td).join("")),
    );

  /** 每条数据行的 `style.animation`（没动画 = 空串）；`rowAnimations()` 的实现。 */
  const collectRowAnimations = () => dataRows().map((tr) => String(tr.props?.style?.animation ?? ""));

  /**
   * tbody 里各行的**实际顺序**，形如 `["row:16:00", "row:16:01", "detail:…", "row:16:02"]`。
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
    /**
     * 每条数据行的**单元格文本**（按列顺序）。
     *
     * 存在的理由：`text` 是整个表格拼起来的文本，「缓存命中」出现在哪一列
     * 是看不出来的——而 DEC-029 修的正是「表头写着内容、格子里却是缓存标记」
     * 这种**列与值错位**。要断言列，就必须按 `td` 取。
     */
    rowCells() {
      return collectRowCells();
    },
    /** 数据行的记录 id，顺序与 tbody 一致（用它按 id 定位行，别按下标猜）。 */
    rowIds,
    /**
     * 按**记录 id** 取那一行的单元格文本。
     *
     * 与排序方式无关：行怎么排都能取到对的行；id 不在页面上就直接失败，
     * 而不是静默地断言到另一行上去。
     */
    cellsOf(id) {
      const ids = rowIds();
      const index = ids.indexOf(id);
      assert.ok(index >= 0, `页面上没有 id 为「${id}」的行，实际有：${ids.join(" | ")}`);
      return collectRowCells()[index];
    },
    /**
     * 每条数据行的 `style.animation`（没有入场动画就是空串），顺序与 tbody 一致。
     *
     * 存在的理由（DEC-044）：入场动画只体现在**行的内联样式**上，可见文本一个字
     * 都不变——没有这个读法，「新行淡入」和「新行直接蹦出来」在测试里一模一样。
     */
    rowAnimations() {
      return collectRowAnimations();
    },
    /** 带着入场动画的那些行的**记录 id**（配合降序后的行序做断言）。 */
    animatedIds() {
      const ids = rowIds();
      return collectRowAnimations()
        .map((animation, index) => (animation.length > 0 ? ids[index] : null))
        .filter((id) => id !== null);
    },
    /**
     * 模拟**下一轮轮询**：换成本批数据，跑一遍已登记的 `setInterval` 回调，
     * 再落定渲染与 effect，返回渲染文本。
     *
     * 为什么需要它：桩把 `window.setInterval` 吞成了「记下回调、不真的等 5 秒」，
     * 于是「轮询多出一条记录」这条真实路径原本一次也没被执行过——而 DEC-044 的
     * 入场动画恰恰只在那一刻发生。
     *
     * @param nextPage - 这一轮 `/session-decisions` 返回的内容。
     */
    async poll(nextPage) {
      assert.ok(pollers.size > 0, "视图没有登记任何轮询回调：poll() 将测不到真实路径");
      pagePayload = nextPage;
      // 挂载结束时 `renderDecisions` 把 `globalThis.fetch` 还原了（免得桩漏给
      // 别的文件），所以轮询期间要把这一份桩临时装回去。
      const previousFetch = globalThis.fetch;
      globalThis.fetch = fetchStub;
      try {
        // 回调体是 `void load()`，同步返回 undefined，拿不到它的 promise →
        // 只能空转宏任务等 `call()` 里那两个 await（fetch、res.text()）落定。
        // 三轮是余量，一轮其实就够；跑全部回调与真机一致（插件自己也挂了一个
        // 60 秒的 /status reconcile，它会安静地重新 mount 一次，不影响本视图）。
        for (const tick of [...pollers.values()]) await tick();
        for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        await renderAndSettle();
      } finally {
        globalThis.fetch = previousFetch;
      }
      return textOf();
    },
    /**
     * 模拟宿主**复用同一个视图实例**切到另一个会话，并让新会话的第一次取数落定。
     *
     * 为什么需要它（DEC-044）：新增判定的基线若不在换会话时清空，新会话那一整页
     * 记录相对上一个会话全是「没见过的新行」，会一次全部淡入——首屏整页闪动。
     * 这条路径只有换 `sessionId` 才走得到，`poll()` 换不掉身份（它换的是数据）。
     *
     * @param nextSessionId - 新会话 id。
     * @param nextPage - 新会话的 `/session-decisions` 响应。
     */
    async switchSession(nextSessionId, nextPage) {
      pagePayload = nextPage;
      activeSessionId = nextSessionId;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = fetchStub;
      try {
        // 换会话只改 props，取数仍由那个依赖 `load`（也就是依赖 `sessionId`）的
        // effect 触发——所以这里要跑一遍 `renderAndSettle()`，让新 effect 真的
        // 执行一次。`pollers` 里的定时器回调与身份无关，不必敲。
        await renderAndSettle();
        for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        await renderAndSettle();
      } finally {
        globalThis.fetch = previousFetch;
      }
      return textOf();
    },
    /** 表头文本（按列顺序）。 */
    thTexts() {
      return findNodes(current, "th").map((th) => collectText(th).join(""));
    },
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
  assert.match(text, /交给主模型/, "应显示裁决（中文名）");
  assert.match(text, /1689ms/, "应显示耗时");
  assert.match(text, /2026-11-03 16:30:00/, "应显示时间");
});

test("多条记录按时间列出：默认降序，最新在上（DEC-044）", async () => {
  // 这条钉的是「整页的默认口径」，与下面「表头排序」一节互为正反两面：
  // 数据每 5 秒自己往上长，用户开这一页要看的永远是**刚才**那次裁决。
  // 升序时最新一条躺在列表最底下，而表格自己滚（maxHeight），首屏停在顶上——
  // 每次都得滚到底才看得到新记录，等于这个页面默认情况下不好用。
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
  const newestAt = text.indexOf("2026-11-03 16:10:00");
  const oldestAt = text.indexOf("2026-11-03 16:00:00");
  assert.ok(newestAt >= 0 && oldestAt >= 0, "两条时间都要出现");
  assert.ok(newestAt < oldestAt, "默认降序：后发生的那条在上面");
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

test("「内容」列显示捕获状态：有内容 / 仅元数据", async () => {
  const view = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({ seq: 1, id: "rec-full", capture: "full" }),
          entry({ seq: 2, id: "rec-meta", capture: "meta" }),
        ],
        total: 2,
      },
      [SLOTS.loading]: false,
    },
  });
  // 断言这一列的表头与它的语义一致（箭头只画在当前排序列，默认在时间列，
  // 「内容」列因此不带箭头——这正是「箭头只画在当前列」的既有约定）。
  assert.equal(view.thTexts()[COL.capture], "内容", `内容列表头：${view.thTexts()[COL.capture]}`);
  // **按 id 取行**，不按下标：这两条夹具的 ts 相同（都是 entry() 的默认值），
  // 默认降序下同一毫秒按写入顺序反过来（后写入的在上，DEC-044），行序与夹具
  // 顺序正好相反。本用例要测的是「这一列写了什么」，与行序无关，所以让行序
  // 怎么变都不影响它——将来再改排序也不用回来重算下标。
  assert.equal(view.cellsOf("rec-full")[COL.capture], "有内容", `有内容那条的内容列：${view.cellsOf("rec-full")[COL.capture]}`);
  assert.equal(view.cellsOf("rec-meta")[COL.capture], "仅元数据", `仅元数据那条的内容列：${view.cellsOf("rec-meta")[COL.capture]}`);
  assert.deepEqual(view.rowIds(), ["rec-meta", "rec-full"], "同毫秒时后写入的在上");
});

test("缓存/降级标记只在「标记」列，「内容」列不再兼报它们", async () => {
  // DEC-029 修的就是这个错位：表头叫「内容」，格子里却是缓存命中/已降级，
  // 而排序键又是「有没有内容」——名、值、排序三样对不上。
  const view = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({ seq: 1, cached: true }),
          entry({ seq: 2, degraded: true, detail: "http-404" }),
          entry({ seq: 3 }),
        ],
        total: 3,
      },
      [SLOTS.loading]: false,
    },
  });
  assert.equal(view.thTexts()[COL.flags], "标记");
  // 三条夹具的 ts 都是默认值（同一毫秒），默认降序把写入顺序整个反过来
  // （后写入的在上，DEC-044）——所以这里**按 id 取行**而不是按下标：
  // 本用例断言的是「缓存/降级该出现在哪一列」，行序不是它要管的事。
  assert.equal(view.rowIds().join("|"), "rec-3|rec-2|rec-1", "同毫秒时后写入的在上");
  assert.deepEqual(
    ["rec-1", "rec-2", "rec-3"].map((id) => view.cellsOf(id)[COL.capture]),
    ["有内容", "有内容", "有内容"],
    "「内容」列只回答捕获状态",
  );
  assert.deepEqual(
    ["rec-1", "rec-2", "rec-3"].map((id) => view.cellsOf(id)[COL.flags]),
    ["缓存命中", "已降级 · http-404", ""],
    "「标记」列回答缓存/降级，并附失败原因",
  );
});

test("「内容」表头按有没有内容排序（与列语义一致）", async () => {
  const view = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({ seq: 1, id: "rec-a", ts: "2026-11-03T08:00:00.000Z", capture: "meta" }),
          entry({ seq: 2, id: "rec-b", ts: "2026-11-03T08:01:00.000Z", capture: "full" }),
        ],
        total: 2,
      },
      [SLOTS.loading]: false,
    },
  });
  // 首次点非时间列 → 从降序起（有内容在前）；再点翻成升序。
  await view.clickTh(COL.capture);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:01:00", "row:16:00:00"],
    `首次点应降序（有内容在前），实际：${view.tbodySequence().join(" | ")}`,
  );
  await view.clickTh(COL.capture);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:00:00", "row:16:01:00"],
    `再点应升序（仅元数据在前），实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("「标记」表头按状态分组排序（无 → 已降级 → 缓存命中）", async () => {
  const view = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({ seq: 1, id: "rec-cache", ts: "2026-11-03T08:00:00.000Z", cached: true }),
          entry({ seq: 2, id: "rec-plain", ts: "2026-11-03T08:01:00.000Z" }),
          entry({ seq: 3, id: "rec-deg", ts: "2026-11-03T08:02:00.000Z", degraded: true }),
        ],
        total: 3,
      },
      [SLOTS.loading]: false,
    },
  });
  await view.clickTh(COL.flags);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:00:00", "row:16:02:00", "row:16:01:00"],
    `降序应是 缓存 → 已降级 → 无，实际：${view.tbodySequence().join(" | ")}`,
  );
  await view.clickTh(COL.flags);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:01:00", "row:16:02:00", "row:16:00:00"],
    `升序应是 无 → 已降级 → 缓存，实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("英文界面里没有中文残留（UI 文案；记录内容是数据，不算）", async () => {
  const view = await renderDecisions({
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
  const offenders = view.text.split("\n").filter((line) => CJK.test(line));
  assert.deepEqual(offenders, [], `英文界面的 UI 文案里出现了中文：\n${offenders.join("\n")}`);
  assert.match(view.text, /Tool authorization/, "决策点应显示英文名");
  // 表头必须真的翻成英文。这里只断言**表头**：原先那句用的是
  // `/Decisions|Refresh|Verdict/`，而「刷新」按钮已在 DEC-036 里删掉——
  // 一个含已不存在控件的 or 断言会一直靠另一半蒙过去，等于没测它。
  const headers = view.thTexts().join(" | ");
  assert.equal(CJK.test(headers), false, `表头不该残留中文：${headers}`);
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
  assert.equal(/已筛选/.test(view.text), false, "不该残留筛选提示");
});

test("顶部那一排「会话 / 总数 / 刷新」整排移除（DEC-036）", async () => {
  // 用户要求：「不需要显示会话名称，总数，刷新按钮；删除一整排」。
  //
  // 断言「整排不在」而不只是「按钮不在」：会话名与计数是 **span**，不是按钮，
  // 只数按钮的话它们悄悄回来测试照样全绿。判据同时盯三件事：
  //   1. 一个 button 都不剩（这页没有任何需要点击的头部控件了）；
  //   2. 没有「会话 xxxx」这种会话名（短 id 形如 `sessio…3456789`）；
  //   3. 没有「共 N 条决策」这种计数。
  //
  // 时间列里本来就有 `2026-11-03 16:00:00` 这类文本，所以「没有数字」这种
  // 粗断言用不得——只针对被删的那两句模板。
  const view = await renderDecisions({ page: threeRows() });
  assert.deepEqual(view.buttonTexts(), [], `这页不该剩任何按钮，实际：${view.buttonTexts().join(" / ")}`);
  assert.equal(/会话/.test(view.text), false, "不该再显示会话名称");
  assert.equal(/条决策/.test(view.text), false, "不该再显示决策总数");
  // 但表格本身必须还在——证明是「少一排」，不是整页被删空。
  assert.ok(view.thTexts().length > 0, "表格应正常渲染");
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
// 用户要求（2026-11-03）：表头每一列都可点、按该列升序降序交替。
// 默认方向（DEC-044，2026-11-09 改口径）：**默认按时间降序**（最新在上），
// 且**首次点任何一列都从降序起**——与整页默认同向，用户点一下永远先看到
// 「这一列最靠后的那个」（时间=最新、耗时=最慢），想反方向再点一次。
// 与「展开定位」一节同理：只断言初始画面测不出交互，
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

/** 列定义顺序：时间(0) 决策点(1) 提供方(2) 模型(3) 裁决(4) 耗时(5) 内容(6) 标记(7)。 */
const COL = { ts: 0, point: 1, provider: 2, model: 3, action: 4, latencyMs: 5, capture: 6, flags: 7 };

test("默认按时间降序（最新在上）", async () => {
  // DEC-044 改的就是这一条原先的期望（「默认升序」）。留着的理由不是怀旧：
  // 默认方向是这个页面**唯一不需要用户学习**的行为，它错了就等于每次打开
  // 都要人自己滚到底去找刚发生的事。
  const view = await renderDecisions({ page: SORT_FIXTURE });
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:02:00", "row:16:01:00", "row:16:00:00"],
    `默认应是时间降序（最新在上），实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("点「时间」表头：降序升序交替，箭头只画在当前列", async () => {
  const view = await renderDecisions({ page: SORT_FIXTURE });
  const thTexts = () => findNodes(view.tree, "th").map((th) => collectText(th).join(""));

  // 初始：时间列降序（默认），↓ 只画在时间列。
  assert.match(thTexts()[COL.ts], /↓/, "当前排序列应带 ↓");
  assert.equal(/↑|↓/.test(thTexts()[COL.latencyMs]), false, "非排序列不该带箭头");

  await view.clickTh(COL.ts); // 已是降序 → 翻成升序
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:00:00", "row:16:01:00", "row:16:02:00"],
    `点一次应变升序，实际：${view.tbodySequence().join(" | ")}`,
  );
  assert.match(thTexts()[COL.ts], /↑/, "升序应带 ↑");

  await view.clickTh(COL.ts); // 再点 → 回到降序（与整页默认同一个方向）
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:02:00", "row:16:01:00", "row:16:00:00"],
    `再点应变回降序，实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("点「耗时」表头：首次降序（最慢在前），再点升序", async () => {
  const view = await renderDecisions({ page: SORT_FIXTURE });
  await view.clickTh(COL.latencyMs);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:00:00", "row:16:02:00", "row:16:01:00"],
    `首次点耗时应变降序（3000/2000/1000），实际：${view.tbodySequence().join(" | ")}`,
  );
  await view.clickTh(COL.latencyMs);
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:01:00", "row:16:02:00", "row:16:00:00"],
    `再点应变升序（1000/2000/3000），实际：${view.tbodySequence().join(" | ")}`,
  );
});

test("排完别的列再点「时间」：从降序起，且箭头跟着切换", async () => {
  // 换列首次点击一律从**降序**起（DEC-044 与整页默认对齐）。这条测的是
  // 「换列」那条分支（`sort.key` 变了 → 不看旧的 dir）：它必须和默认一致，
  // 否则用户点回时间列时会先看到最旧的一条在最上，与刚打开页面时相反。
  const view = await renderDecisions({ page: SORT_FIXTURE });
  const thTexts = () => findNodes(view.tree, "th").map((th) => collectText(th).join(""));

  await view.clickTh(COL.latencyMs); // 排序列现在是耗时
  assert.match(thTexts()[COL.latencyMs], /↓/);
  assert.equal(/↑|↓/.test(thTexts()[COL.ts]), false, "箭头应从时间列挪走");

  await view.clickTh(COL.ts); // 首次点时间：降序（最新在上）
  assert.deepEqual(
    view.tbodySequence(),
    ["row:16:02:00", "row:16:01:00", "row:16:00:00"],
    `换列首次点击应从降序起，实际：${view.tbodySequence().join(" | ")}`,
  );
  assert.match(thTexts()[COL.ts], /↓/, "箭头应回到时间列，且是降序箭头");
  assert.equal(/↑|↓/.test(thTexts()[COL.latencyMs]), false, "耗时列不该再有箭头");
});


test("降级「标记」列写出失败原因与状态码", async () => {
  const view = await renderDecisions({
    slots: {
      [SLOTS.page]: {
        entries: [
          entry({ seq: 1, id: "rec-http", degraded: true, detail: "http-404" }),
          entry({ seq: 2, id: "rec-auth", degraded: true, detail: "auth-failed", status: 401 }),
          entry({ seq: 3, id: "rec-plain", degraded: true, detail: "" }),
        ],
        total: 3,
      },
      [SLOTS.loading]: false,
    },
  });
  // 三条夹具同 ts（同一毫秒），默认降序下按写入顺序反过来——本用例要断言的是
  // 「标记列写了什么」，与行序无关，所以**按 id 取行**。
  assert.deepEqual(view.rowIds(), ["rec-plain", "rec-auth", "rec-http"], "同毫秒时后写入的在上");
  assert.equal(view.cellsOf("rec-http")[COL.flags], "已降级 · http-404", "HTTP 错误直接在标记列带状态码");
  assert.equal(view.cellsOf("rec-auth")[COL.flags], "已降级 · auth-failed (HTTP 401)", "401 也带状态码，且不跟 detail 里的码重复");
  assert.equal(view.cellsOf("rec-plain")[COL.flags], "已降级", "无 detail 时只写已降级");
});

// ------------------------------------------------------------------ 裁决词的中文显示
//
// 裁决词是**机器词**：明细文件、遥测、`detail` 原因串里写的都是
// `delegate` / `inline` 这种英文。可这一列是整张表唯一还在说英文的地方，
// 中文界面读这张表时最想看的就是它。用户要求（2026-11-05）：
// 「裁决里的英文需要对应的中文翻译：inline, delegate 等」。
//
// 口径：**只换显示，不换数据**。`VERDICT_LABELS` 给中文名，
// `EN_LABELS` 把中文名翻回**机器词本身**，所以英文界面与改前逐字一致。

/** 全部 16 个裁决词 → 中文名（与 lib/client.js 的 VERDICT_LABELS 同源口径）。 */
const VERDICT_ZH = {
  allow: "照常放行",
  keep: "保留原模型",
  delegate: "交给主模型",
  switch: "换模型",
  redirect: "改用别的技能",
  advise: "建议分派",
  prune: "裁剪结果",
  summarize: "摘要压缩",
  continue: "续一轮",
  translate: "翻译",
  stop: "收束本轮",
  inline: "自己接着做",
  skip: "跳过",
  ask: "转人工确认",
  deny: "拒绝执行",
  degraded: "降级未裁决",
};

/** 每个裁决词一条记录，用来逐列取「裁决」格。 */
const ALL_VERDICTS = {
  entries: Object.keys(VERDICT_ZH).map((action, index) =>
    entry({
      seq: index + 1,
      id: `rec-verdict-${action}`,
      ts: `2026-11-05T08:${String(index).padStart(2, "0")}:00.000Z`,
      action,
    }),
  ),
  total: Object.keys(VERDICT_ZH).length,
};

/**
 * 把「裁决」列的显示值**按记录 id 归档**（`{ id → 该格文本 }`）。
 *
 * 存在的理由：这一组用例要测的是「哪个词显示成什么」，与行排在第几无关。
 * 默认降序（DEC-044）之后，夹具的写入顺序与屏幕顺序正好相反，按下标比
 * 一份顺序数组会把「翻译对不对」和「排序对不对」两件事捆在一起失败——
 * 按 id 取就只可能因前者变红。
 */
function actionById(view) {
  const ids = view.rowIds();
  const cells = view.rowCells();
  const out = {};
  ids.forEach((id, index) => {
    out[id] = cells[index][COL.action];
  });
  return out;
}

test("裁决列写中文名：16 个裁决词全覆盖", async () => {
  const view = await renderDecisions({ page: ALL_VERDICTS });
  const shown = actionById(view);
  assert.equal(Object.keys(shown).length, Object.keys(VERDICT_ZH).length, "每个裁决词都该有一行");
  const wrong = Object.entries(VERDICT_ZH)
    .filter(([action, label]) => shown[`rec-verdict-${action}`] !== label)
    .map(([action, label]) => `${action}：期望「${label}」，实际「${shown[`rec-verdict-${action}`]}」`);
  assert.deepEqual(wrong, [], `裁决列没有按词显示中文名：\n${wrong.join("\n")}`);
  // 机器词不该再出现在中文界面的这一列里。
  const values = Object.values(shown);
  const leaked = Object.keys(VERDICT_ZH).filter((action) => values.includes(action));
  assert.deepEqual(leaked, [], `这些裁决词还是英文：${leaked.join(", ")}`);
});

test("原始机器词留在裁决格的 title 上（对照明细文件与日志用）", async () => {
  const view = await renderDecisions({ page: { entries: [entry({ seq: 1, action: "inline" })], total: 1 } });
  const tags = findNodes(view.tree, "span");
  const titles = tags.map((node) => node.props?.title).filter((value) => typeof value === "string");
  assert.ok(titles.includes("inline"), `title 应带原始机器词，实际：${titles.join(" | ")}`);
});

test("英文界面：裁决列翻回机器词，且不残留中文", async () => {
  const view = await renderDecisions({ page: ALL_VERDICTS, lang: "en" });
  const shown = actionById(view);
  // 同样**按 id 比**：这条测的是「英文名 = 机器词本身」（改中文名时不许动到
  // 英文界面），行序由默认降序决定，与它无关。
  const wrong = Object.keys(VERDICT_ZH)
    .filter((action) => shown[`rec-verdict-${action}`] !== action)
    .map((action) => `${action}：期望「${action}」，实际「${shown[`rec-verdict-${action}`]}」`);
  assert.deepEqual(wrong, [], `英文界面的裁决列没翻回机器词：\n${wrong.join("\n")}`);
  const leftover = view.text.split("\n").filter((line) => CJK.test(line.trim()));
  assert.deepEqual(leftover, [], `英文界面残留中文：\n${leftover.join("\n")}`);
});

test("未登记的裁决词退回原词，不显示空格或 undefined", async () => {
  // 新裁决词在 `lib/outcomes.js` 登记了、却忘了补中文名时，界面必须还能读。
  const view = await renderDecisions({ page: { entries: [entry({ seq: 1, action: "brand-new-word" })], total: 1 } });
  assert.equal(view.rowCells()[0][COL.action], "brand-new-word", "未登记的词应原样显示");
});

test("裁决列按中文名排序，不按机器词的字母序", async () => {
  // keep / advise / allow 三个词：机器词字母序是 advise < allow < keep，
  // 中文名序是 保留原模型 < 建议分派 < 照常放行，时间序又是第三种排列
  // （夹具把 ts 排成 keep → allow → advise）——三条顺序互不相同，
  // 排错任何一条都会显形。
  const fixture = {
    entries: [
      entry({ seq: 1, id: "rec-advise", ts: "2026-11-05T08:02:00.000Z", action: "advise" }),
      entry({ seq: 2, id: "rec-allow", ts: "2026-11-05T08:01:00.000Z", action: "allow" }),
      entry({ seq: 3, id: "rec-keep", ts: "2026-11-05T08:00:00.000Z", action: "keep" }),
    ],
    total: 3,
  };
  const view = await renderDecisions({ page: fixture });
  // 非时间列首点从降序起（DEC-028 的口径），再点才翻回升序。
  await view.clickTh(COL.action);
  const desc = view.rowCells().map((row) => row[COL.action]);
  assert.deepEqual(
    desc,
    ["照常放行", "建议分派", "保留原模型"],
    `首点应是中文名降序，实际：${desc.join(" | ")}`,
  );
  await view.clickTh(COL.action);
  const asc = view.rowCells().map((row) => row[COL.action]);
  assert.deepEqual(
    asc,
    ["保留原模型", "建议分派", "照常放行"],
    `再点应翻回升序，实际：${asc.join(" | ")}`,
  );
});

// ------------------------------------------------------------------ 新增行的入场动画（DEC-044）
//
// 用户要求（2026-11-09）：「决策历史，默认按照时间降序排序，并且新增 rows 需要
// 用简单动画出现，而不是直接出现。」上面「表头排序」一节管的是前半句，这一节
// 管后半句——它才是这条需求的正身。
//
// 为什么必须单独一组用例：入场动画只体现在**行的内联样式**（`style.animation`）
// 上，可见文本一个字都不变。也就是说把实现里的 `animation` 整条删掉，本文件
// 其余 45 条用例**照样全绿**，而真机上用户看到的仍然是「行直接蹦出来」。
// 这类「测不到的功能」正是靠 `rowAnimations()` / `animatedIds()` 与 `poll()`
// 三个新读法补上的。
//
// 三条契约，各自对应一类真机故障：
//
//   1. **首屏那一整批不动画**——几十条一起淡入等于整页闪一下，没人看得出
//      哪条是新的；动画要说的是「这条刚冒出来」，对首屏不成立。
//   2. **只有轮询多出来的那一条动**——这页每 5 秒重绘一次，已有行若也挂着
//      动画，用户看到的是整页周期性闪动（比不动更糟）。动画还必须挂在**对
//      的那条**上：挂错行等于指着旧记录说「这是新的」。
//   3. **只播一次**——新增标记若活过这一批，同一条会每 5 秒重播一遍。
//
// 另外两条边界：换排序 / 展开这类纯界面动作不该让别的行「获得」动画；
// 系统开着「减弱动态效果」时一条都不动（但记录照常出现）。
//
// 桩的机制说明（决定这些断言为什么这么写）：`window.setInterval` 被桩换成
// 「把回调记进 `pollers`、不真的等 5 秒」，`poll()` 就是手动敲响它们。新增判定
// 发生在 `load()` 里（取数那一刻算出 `newIds` 并存进 state），所以 `poll()` 之后
// 的渲染树就是用户在那 600ms 里看到的那一帧；标记会一直挂到**下一次轮询**
// 才被覆盖——下面第 4 条按这个口径断言「不扩散、不搬家」，而不是断言「消失」。

/** 上一批已显示的两条记录（动画用例的「旧数据」）。 */
const ANIM_TWO = {
  entries: [
    entry({ seq: 1, ts: "2026-11-03T08:00:00.000Z", action: "allow" }),
    entry({ seq: 2, ts: "2026-11-03T08:01:00.000Z", action: "keep" }),
  ],
  total: 2,
};

/** 下一轮轮询：同样那两条 + 多出来的一条（时间最新，默认降序下排在最上面）。 */
function animThree() {
  return {
    entries: [
      ...ANIM_TWO.entries,
      entry({
        seq: 3,
        ts: "2026-11-03T08:02:00.000Z",
        action: "delegate",
        latencyMs: 777,
        content: { state: { args_preview: "NEW_ROW_MARKER" }, questions: {}, answers: {} },
      }),
    ],
    total: 3,
  };
}

test("首屏那一整批不带入场动画", async () => {
  // 防的真机故障：打开页面的瞬间几十条一起淡入——那不是「新增提示」，是整页闪动，
  // 而且用户完全无法从里面认出「刚发生的那一条」。
  const view = await renderDecisions({ page: SORT_FIXTURE });
  assert.equal(view.rowIds().length, 3, "夹具应渲染出三行");
  assert.deepEqual(
    view.rowAnimations(),
    ["", "", ""],
    `首屏不该有任何行带 animation，实际：${view.rowAnimations().join(" | ")}`,
  );
  assert.deepEqual(view.animatedIds(), [], "首屏没有「新增」这回事");
});

test("轮询多出来的那一条带动画，已有的行一条都不带", async () => {
  const view = await renderDecisions({ page: ANIM_TWO });
  assert.deepEqual(view.rowAnimations(), ["", ""], "前提：首屏两行都不动");

  await view.poll(animThree());

  // **按 id 断言**，不按「第一行」：动画属于那条新记录，与它排在哪儿无关。
  assert.deepEqual(
    view.animatedIds(),
    ["rec-3"],
    `该只有新记录 rec-3 带动画，实际：${view.rowIds().map((id, index) => `${id}=${view.rowAnimations()[index] || "-"}`).join(" | ")}`,
  );
  // 带动画的这一行**确实是那条新记录**（不是把样式挂到了同一位置的旧行上）。
  assert.match(view.cellsOf("rec-3")[COL.ts], /16:02:00/, "带动画的行应是 16:02 那条");
  assert.equal(view.cellsOf("rec-3")[COL.latencyMs], "777ms", "同上：耗时也是新记录的那一条");
  assert.match(view.cellsOf("rec-1")[COL.ts], /16:00:00/, "旧记录仍带着它原来的数据");

  const animation = view.rowAnimations()[view.rowIds().indexOf("rec-3")];
  // keyframes 名必须与注入的那份 `@keyframes` 对得上：名字错了浏览器会**静默**
  // 不播（样式表里找不到同名 keyframes 时整条 animation 失效），测试不报错。
  assert.match(animation, /dsh-decision-row-enter/, "animation 要引用注入的 keyframes 名");
  // 时长也不能省：CSS 默认 duration 是 0s，写了等于没写，用户看到的还是「直接出现」。
  // DEC-057 把 DEC-044 的 300ms 翻倍成 600ms：这里断言翻倍后的新时长。
  assert.match(animation, /600ms/, "要有明确时长（DEC-057：300ms 翻倍到 600ms）");
});

test("动画只播一次：下一轮轮询没多出新记录时谁都不再动", async () => {
  // 防的真机故障：这页每 5 秒取一次数，如果「新」的判定只看数据里有什么、
  // 不看相对上一批多出了什么，同一批记录会每 5 秒集体重播一遍淡入。
  const view = await renderDecisions({ page: ANIM_TWO });
  await view.poll(animThree());
  assert.deepEqual(view.animatedIds(), ["rec-3"], "前提：新增那一次确实动了");

  await view.poll(animThree());
  assert.deepEqual(
    view.rowAnimations(),
    ["", "", ""],
    `同一批再轮询一次不该重播，实际：${view.rowAnimations().join(" | ")}`,
  );
  // 行还在：摘掉动画不等于把记录摘掉。
  assert.deepEqual(view.rowIds(), ["rec-3", "rec-2", "rec-1"], "三行仍按默认降序在页面上");
});

test("翻排序方向 / 展开行：动画只跟着那一条记录，不扩散也不搬家", async () => {
  // 防的真机故障：新增判定若跟着「排序后的位置」或「渲染轮次」走，用户点一下
  // 表头就会看到另一行重新淡入（动画在行间跳来跳去），或者整列都动起来。
  const view = await renderDecisions({ page: ANIM_TWO });
  await view.poll(animThree());
  assert.deepEqual(view.animatedIds(), ["rec-3"], "前提：只有新记录带动画");
  const before = view.rowIds();

  // 纯界面动作 ①：换排序列。行序整个反过来，动画必须**跟着记录**而不是跟着位置。
  await view.clickTh(COL.latencyMs);
  assert.notDeepEqual(view.rowIds(), before, "点了表头，行序确实变了（否则这条等于没测）");
  assert.deepEqual(
    view.animatedIds(),
    ["rec-3"],
    "换排序列后动画仍只属于 rec-3：既不搬给别的行，也不扩散给已有行",
  );

  // 纯界面动作 ②：展开一行（会插入一行详情、并让整表重绘）。
  const clickIndex = view.rowIds().indexOf("rec-2");
  await view.clickRow(clickIndex);
  assert.equal(
    view.tbodySequence().filter((line) => line.startsWith("detail:")).length,
    1,
    `应展开出一行详情，实际：${view.tbodySequence().join(" | ")}`,
  );
  assert.deepEqual(view.animatedIds(), ["rec-3"], "展开/重绘同样不该让别的行获得动画");
  assert.equal(
    view.text.includes("NEW_ROW_MARKER"),
    false,
    "展开的是 rec-2 那一行：详情里不该出现新记录的内容（动画行与展开行是两件事）",
  );
  // 边界说明：这一帧里 rec-3 仍带着 animation 是**设计如此**——标记挂在取数那
  // 一刻，活到下一次轮询（600ms 的动画早播完了），这样中途任何重绘都不会把
  // 动画掐在第几帧上。「下一次轮询时它必须消失」由上面那条用例负责。
});

test("系统要求减弱动态效果时一律不动画（但新记录照常出现）", async () => {
  // 防的真机故障：macOS / Windows 的「减弱动态效果」是**可访问性设置**，前庭
  // 功能敏感的用户靠它关掉这类位移淡入。无视它属于可访问性缺陷。
  const view = await renderDecisions({ page: ANIM_TWO, reducedMotion: true });
  await view.poll(animThree());
  assert.deepEqual(
    view.rowAnimations(),
    ["", "", ""],
    `开着减弱动效就不该有行动画，实际：${view.rowAnimations().join(" | ")}`,
  );
  // 关掉动画不等于关掉功能：新记录必须还在，而且位置与顺序都不变。
  assert.deepEqual(view.rowIds(), ["rec-3", "rec-2", "rec-1"], "新记录仍出现在降序的最上面");
  assert.match(view.text, /777ms/, "新记录的内容仍要渲染出来");
});

test("换会话：新会话的第一批只登记、不动画（基线随会话清空）", async () => {
  // 防的真机故障：宿主**复用同一个视图实例**切到另一个会话时（在会话列表里点
  // 另一条会话，就是这个路径），若「已经见过哪些记录」的基线不清空，新会话那
  // 一整页记录相对上一个会话全是「没见过的新行」→ 整页一起淡入。这与首屏那个
  // 「几十条一起淡等于整页闪」是同一类毛病，只是从「刚打开」挪到了「切会话」。
  const view = await renderDecisions({ page: ANIM_TWO });
  // 先在旧会话里制造一次「有动画」的状态，证明基线此刻**确实**立起来了：
  // 否则「换会话后不动画」也可能只是基线从来没生效过，测了个寂寞。
  await view.poll(animThree());
  assert.deepEqual(view.animatedIds(), ["rec-3"], "前提：旧会话里轮询出新记录时是动起来的");

  // 切到另一个会话：记录是**另一批**（id 全不相同），第一屏。期望一条都不动。
  const other = {
    entries: [
      entry({ id: "other-a", seq: 1, ts: "2026-11-03T09:00:00.000Z", action: "allow" }),
      entry({ id: "other-b", seq: 2, ts: "2026-11-03T09:01:00.000Z", action: "deny" }),
    ],
    total: 2,
  };
  await view.switchSession("session-ffffffffffffffff", other);
  assert.deepEqual(view.rowIds(), ["other-b", "other-a"], "新会话的记录应已经渲染出来（不是空白）");
  assert.deepEqual(
    view.rowAnimations(),
    ["", ""],
    `换会话后的第一批不该有入场动画（基线没清空就会整页淡入），实际：${view.rowAnimations().join(" | ")}`,
  );

  // 换过去之后再轮询出新记录，动画要照常工作——清空基线不是把功能关掉。
  const more = { entries: [...other.entries, entry({ id: "other-c", seq: 3, ts: "2026-11-03T09:02:00.000Z" })], total: 3 };
  await view.poll(more);
  assert.deepEqual(view.animatedIds(), ["other-c"], "新会话里新冒出来的那条照样要有动画");
});

test("keyframes 只往文档里注一次；没有 document 也只是不动画、不崩", async () => {
  // 这一条补的是**有** document 的那一半：样式表必须幂等注入。
  // （「没有 document 不能抛错」由上面几条天然覆盖——Node 环境里 `document`
  //  根本不存在，而它们全都跑绿了；实现读不到 document 就返回 false。）
  //
  // 防的真机故障：这个标签页会被 DEC-022 的 reconcile **卸载 / 重挂**（用户在
  // 插件详情页拨一下开关就会发生一次），插件热重载也一样。不幂等的话 `head`
  // 里会攒下一堆一模一样的 `<style>`——每重挂一次多一份，久了就是几百 KB 的
  // 重复样式表挂在会话页上。
  const appended = [];
  const byId = new Map();
  globalThis.document = {
    head: {
      appendChild(node) {
        appended.push(node);
        byId.set(node.id, node);
        return node;
      },
    },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), dataset: {}, id: "", textContent: "" }),
    getElementById: (id) => byId.get(id) ?? null,
  };
  try {
    const view = await renderDecisions({ page: ANIM_TWO });
    assert.equal(appended.length, 1, `第一次挂载应注入一次 keyframes，实际 ${appended.length} 次`);
    const style = appended[0];
    // id 是幂等判定的唯一依据，名字错了就等于每次都新注一个。
    assert.equal(style.id, "dsh-decision-row-enter-css", "注入的 <style> 要带固定 id");
    assert.equal(style.tagName, "STYLE", "注的必须是 <style>");
    assert.equal(style.dataset.plugin, "dsh-decision-engine", "要能看出这条样式是谁注的");
    // 关键帧名必须与行上那条 `animation` 引用得上（对不上就是静默不播）。
    const css = String(style.textContent);
    assert.match(css, /@keyframes\s+dsh-decision-row-enter/);

    // DEC-057：新增行自带一层不同的背景色，整段动画里逐渐褪到默认（透明）。
    // 背景色写在 keyframes 而非行内联样式上——样式表注不上时它随整条 animation
    // 一起失效，行不会卡在高亮底色上（与 DEC-044 第 2 条同一个失败方向）。
    const fromFrame = css.match(/from\{([^}]*)\}/);
    const toFrame = css.match(/to\{([^}]*)\}/);
    assert.ok(fromFrame && toFrame, "入场关键帧要有 from / to 两帧");
    assert.match(fromFrame[1], /background-color\s*:/, "from 帧要给新增行一层背景色");
    assert.match(toFrame[1], /background-color\s*:/, "to 帧要把背景色收敛到默认值");
    const fromBg = fromFrame[1].match(/background-color\s*:\s*([^;}]+)/)[1];
    const toBg = toFrame[1].match(/background-color\s*:\s*([^;}]+)/)[1];
    assert.notEqual(fromBg, toBg, "起始背景色与默认色必须不同（否则等于没动画）");
    assert.match(toBg, /,\s*0\s*\)|transparent/, `to 帧应褪到透明/默认色，实际：${toBg}`);

    // 同一个实例里再来一轮轮询 + 一次纯界面动作：都不该再注第二个 <style>。
    await view.poll(animThree());
    await view.clickTh(COL.ts);
    assert.equal(appended.length, 1, `轮询/重绘后仍只该有一个 <style>，实际 ${appended.length} 个`);
    // 有文档可注时动画才是「有处可播」的：这一轮的新记录确实拿到了 animation。
    assert.deepEqual(view.animatedIds(), ["rec-3"]);

    // **再挂载一个视图实例**（reconcile 重挂 / 热重载后是全新的一份组件与模块）。
    // 幂等判定必须跨实例成立——它查的是文档，不是组件里的某个标记。
    const second = await renderDecisions({ page: ANIM_TWO });
    assert.equal(appended.length, 1, `第二个实例挂载后仍只该有一个 <style>，实际 ${appended.length} 个`);
    await second.poll(animThree());
    assert.equal(appended.length, 1, "复用已注过的样式表，不是复用已断掉的动画");
    assert.deepEqual(second.animatedIds(), ["rec-3"], "第二个实例的动画照样要能播");
  } finally {
    // 必须拆掉：本文件其它用例都靠 `typeof document === "undefined"` 这条
    // Node 语义跑，留着假文档会让它们走进另一条分支（互相污染）。
    delete globalThis.document;
  }
});


// ===========================================================================
// 人工审核比例（DEC-035）：决策历史页的那个滑块
// ===========================================================================
//
// 这个页面上放滑块的理由：用户正是在这里看到「刚才又问我了」，于是想调
// 打扰频率的那个瞬间就在这里。让他为此切到插件配置页，等于承认这两处
// 说的是同一件事却要跳一次。
//
// 两条格外重要的契约：
//
//   1. **空态也必须有滑块**——「一条记录都没有」恰恰可能是「档位太吵、
//      我把决策点关了」的结果，那才是最想调低档位的一刻；
//   2. **没有下发数据时安静消失**——后端少拼字段时不能整页崩。

/** 决策历史页看到的那份 tolerance 载荷（与 /session-decisions 下发同形）。 */
function tolerancePage(over = {}) {
  return {
    level: "default",
    levels: ["autonomous", "relaxed", "default", "cautious"],
    presets: [
      { id: "autonomous", label: "自治", labelEn: "Autonomous", summary: "自治：从不询问用户，只有高风险调用会被直接拦下", summaryEn: "x", percentile: null },
      { id: "relaxed", label: "轻松", labelEn: "Relaxed", summary: "轻松：只有严重度排在最前的 1% 才询问用户", summaryEn: "x", percentile: 0.99 },
      { id: "default", label: "默认", labelEn: "Default", summary: "默认：按决策模型自己的判断提问（当前的默认行为）", summaryEn: "x", percentile: null },
      { id: "cautious", label: "谨慎", labelEn: "Cautious", summary: "谨慎：在默认判断之外，再把严重度靠前的 25% 也拿来询问", summaryEn: "x", percentile: 0.75 },
    ],
    calibration: {
      provider: "bamboonode",
      model: "test-model",
      samples: 0,
      ready: false,
      minSamples: 50,
      windowSize: 200,
      threshold: null,
      fallbackSeverity: null,
    },
    ...over,
  };
}

test("决策历史页渲染四段滑块（车厢里就能调，不用跳去配置页）", async () => {
  const { text } = await renderDecisions({
    page: { entries: threeRows().entries, tolerance: tolerancePage() },
  });
  assert.ok(text.includes("人工审核比例"), `决策历史页缺少滑块：\n${text.slice(0, 900)}`);
  for (const name of ["自治", "轻松", "默认", "谨慎"]) {
    assert.ok(text.includes(name), `缺少「${name}」段`);
  }
  // 不是下拉，且当前档位的比例说明必须在（它取代了挤在落点上的尾注）。
  assert.ok(
    text.includes("默认：按决策模型自己的判断"),
    `应说明当前档位的语义，实际：\n${text.slice(0, 900)}`,
  );
});

test("空态（本会话没有记录）仍然有滑块可调", async () => {
  // 空态是最想调档位的一刻：一条记录都没有，很可能正是「太吵，我把决策点关了」。
  const { text } = await renderDecisions({
    page: { entries: [], tolerance: tolerancePage() },
  });
  assert.ok(text.includes("本会话还没有决策记录"), "应显示空态文案");
  assert.ok(text.includes("人工审核比例"), "空态也必须能让用户改档位");
});

test("错误态：读取失败时如实报错，且不画一个没有数据支撑的滑块", async () => {
  // 这里刻意**不**断言「错误态也要有滑块」：滑块需要「当前档位」才画得出来，
  // 而读取失败意味着 `page` 从未被设置过——没有数据时硬画一个滑块，只能
  // 猜一个档位给用户看，那是更坏的行为（显示一个可能不是真实生效值的控件）。
  //
  // 因此断言的是：页面不崩、错误原因可见、并且**没有**凭空出现的滑块。
  // 四个提前 return 共用同一个 `header`，空态（有数据）那一条才要求滑块。
  const { text } = await renderDecisions({
    sessionFails: true,
    page: { entries: [], tolerance: tolerancePage() },
  });
  assert.ok(text.includes("读取决策历史失败"), `应显示失败原因，实际：\n${text.slice(0, 900)}`);
  assert.ok(!text.includes("人工审核比例"), "没有数据时不该画滑块（否则显示的可能不是真实生效值）");
});

test("服务端不下发 tolerance 时，决策历史页照常渲染（回归守卫）", async () => {
  const { text } = await renderDecisions({
    page: { entries: threeRows().entries },
  });
  assert.ok(!text.includes("人工审核比例"), "没有下发数据时不该画滑块");
  // 但表格本身必须还在——证明是「少一块」，不是「整页挂了」。
  assert.ok(text.includes("裁决") || text.includes("时间"), `表格应正常，实际：\n${text.slice(0, 900)}`);
});

test("英文界面下这个滑块不残留中文（服务端中文标签有词表兜着）", async () => {
  // 四档的 label / summary 来自服务端（中文），界面在渲染边界翻译。
  // 这条防的是「新增控件时忘了登记英文」——英文宿主上冒出四块中文。
  const CJK = /[一-鿿　-〿＀-￯]/;
  const { text } = await renderDecisions({
    lang: "en",
    page: {
      entries: [
        entry({
          detail: "decision-engine: benign call allowed",
          point: "authorize",
        }),
      ],
      tolerance: tolerancePage(),
    },
  });
  const offenders = text
    .split("\n")
    .filter((line) => CJK.test(line))
    // detail 是**数据**（审计原文），英文界面下保持不变是正确行为。
    .filter((line) => !line.includes("benign call allowed"));
  assert.deepEqual(offenders, [], `英文界面里出现了中文：\n${offenders.join("\n")}`);
  assert.match(text, /Review tolerance/, "滑块标题应显示英文");
  assert.match(text, /Autonomous|Relaxed|Cautious/, "四个段应显示英文");
});
