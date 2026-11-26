/**
 * 「决策调用持续变慢」警告的渲染测试。
 *
 * 用户的要求原文是：**连续多次出现「一次调用耗时超过 10 秒」时，在 tab title
 * 右边显示一个 warning icon，并在 tab 内容的顶部说明这个情况**。落点是插件
 * 详情页的「统计与对比」tab（配置 / 统计那一排）。
 *
 * 防的是这几类错：
 *
 *   1. **图标不跟着判定走**——没报警时也画一个 ⚠，或者报了警却什么都没有：
 *      那条警告的全部价值就是「它亮的时候确实有事」。
 *   2. **说明只在别处**——标题上有图标、页面里却没有一句能读的话，用户只能
 *      猜「这个三角是什么意思」。
 *   3. **说明不在内容顶部**——塞到页面底部或表格下面，等于没写。
 *   4. **读不到状态就崩**——`/slow-calls` 是旁路接口，失败时页面必须照常可用。
 *   5. **英文界面残留中文**——图标 aria-label 与说明横幅都要有英文。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let loadSeq = 0;

/** 中文字符（含全角标点）——英文界面里出现任何一个都算漏翻。 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * StartluxPage 的 useState 顺序（改动这个顺序时同步改这里）。
 *
 * 只列本文件要用的槽位；`slowCalls` 是**追加在末尾**的新状态（紧随
 * `dangerConfirmOpen`，理由与其它末尾状态一致：插在中间会把后面全部挪位，
 * 而 `useLang` 的槽位紧随其后）。
 */
const SLOTS = {
  status: 0,
  decisions: 11,
  stats: 13,
  statsFilter: 15,
  tab: 16,
  statsMeta: 17,
  slowCalls: 24,
};

/** 服务端 /slow-calls 的载荷形状（与 lib/slow-calls.js 的 status() 一致）。 */
const slowPayload = (over = {}) => ({
  active: true,
  streak: 5,
  needed: 5,
  thresholdMs: 10000,
  lastDurationMs: 12400,
  sinceAt: "2026-11-26T01:20:00.000Z",
  ...over,
});

/** 最小统计载荷：够渲染汇总与表，且不触发「没有观察模式数据」那条告警。 */
function statsFixture() {
  return {
    rows: [],
    totals: {
      requests: 0,
      cached: 0,
      degraded: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      savedInputTokens: 0,
      savedOutputTokens: 0,
      savedDurationMs: 0,
      savedRatio: 0,
    },
    series: { buckets: [] },
    range: { preset: "today", label: "当日", start: "", end: "", valid: true },
    presets: ["today", "week"],
    labels: { today: "当日", week: "本周" },
    savings: { observeRequests: 3, totalRequests: 3, byMode: { observe: 3 }, unavailable: false },
    outcomes: { allow: 0, ask: 0, reject: 0, none: 0, decided: 0, total: 0, byPoint: [], otherVerdicts: [] },
    byPoint: [],
    byProvider: [],
  };
}

/**
 * 渲染插件详情页（与 test/client-ui.test.js 同一套桩）。
 *
 * @param options.slots - `{ 槽位序号: 值 }`。
 * @param options.lang - 宿主语言（`zh` / `en`）。
 */
async function render(options = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const unique = `\n// slow-call-ui-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  const slots = { [SLOTS.status]: null, ...(options.slots ?? {}) };
  const lang = options.lang ?? "zh";

  let stateIndex = 0;
  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = stateIndex;
      stateIndex += 1;
      if (Object.hasOwn(slots, index)) return [slots[index], () => {}];
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback(fn) {
      return fn;
    },
    useRef(value) {
      return { current: value };
    },
    // SSR 语义：effect 不执行，避免真实网络请求。
    useEffect() {},
    useLayoutEffect() {},
    useMemo(fn) {
      return fn();
    },
    useSyncExternalStore(_subscribe, _getSnapshot, getServerSnapshot) {
      return typeof getServerSnapshot === "function" ? getServerSnapshot() : null;
    },
  };

  let component;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
        const registered = [];
        const ctx = {
          logger: { info() {}, warn() {} },
          locale: {
            register: () => () => {},
            getSnapshot: () => ({ active: lang, locales: [], revision: 1 }),
            subscribe: () => () => {},
          },
          slots: {
            inject(_slot, callback) {
              callback();
              return () => {};
            },
            register(_meta, comp) {
              registered.push(comp);
              return () => {};
            },
          },
          effect(body) {
            const iterator = body();
            let step = iterator.next();
            while (!step.done) step = iterator.next(step.value);
            return () => {};
          },
        };
        bundle.apply(ctx);
        component = registered[0];
      },
    },
  };

  await import(dataUrl);
  assert.ok(typeof component === "function", "client bundle 未注册配置组件");
  const tree = component({ view: "config" });
  return { tree, text: collectText(tree).join("\n"), nodes: collectNodes(tree) };
}

/** 递归收集渲染树里的文本（含 value / placeholder 属性）。 */
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
    if (typeof props.value === "string") out.push(props.value);
    if (typeof props.placeholder === "string") out.push(props.placeholder);
    collectText(node.children, out);
  }
  return out;
}

/** 递归收集所有节点（带 className 的按类名找，比按文本找稳）。 */
function collectNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  collectNodes(node.children, out);
  return out;
}

/** 某个类名命中的第一个节点（没有则 undefined）。 */
function byClass(nodes, className) {
  return nodes.find((node) => {
    const value = node.props?.className;
    if (typeof value !== "string") return false;
    return value.split(/\s+/).includes(className);
  });
}

/** 统计 tab 默认打开时的槽位组合。 */
function statsSlots(over = {}) {
  return {
    [SLOTS.tab]: "stats",
    [SLOTS.stats]: statsFixture(),
    [SLOTS.statsFilter]: { preset: "today", start: "", end: "", sort: "inputTokens", dir: "desc" },
    [SLOTS.statsMeta]: { presets: ["today", "week"], labels: { today: "当日", week: "本周" } },
    ...(over ?? {}),
  };
}

test("报警时：tab 标题右边有 warning icon，且带可读说明", async () => {
  const { nodes, text } = await render({ slots: statsSlots({ [SLOTS.slowCalls]: slowPayload() }) });
  const warn = byClass(nodes, "de-tab__warn");
  assert.ok(warn !== undefined, "报警时 tab 标题必须有警告图标");
  assert.equal(collectText(warn).join(""), "⚠");
  assert.ok(
    typeof warn.props["aria-label"] === "string" && warn.props["aria-label"].length > 0,
    "图标不能只有形状：必须有 aria-label 说明它是什么意思",
  );
  // tab 文案本身必须还在（图标是追加在标题右边，不是替换标题）。
  assert.match(text, /统计与对比/);
});

test("报警时：tab 内容顶部有一句能读的说明（数量与阈值都在里面）", async () => {
  const { nodes } = await render({ slots: statsSlots({ [SLOTS.slowCalls]: slowPayload() }) });
  const banner = byClass(nodes, "de-slow");
  assert.ok(banner !== undefined, "报警时统计 tab 顶部必须有说明块");
  const bannerText = collectText(banner).join(" ");
  assert.match(bannerText, /连续 5 次/);
  assert.match(bannerText, /10 秒|10s/);
  assert.match(bannerText, /12\.4s|12\.4 秒/, "要说清最近一次到底多慢");
});

test("说明块在内容顶部：排在同一 tab 里第一个区块之前", async () => {
  const { nodes } = await render({ slots: statsSlots({ [SLOTS.slowCalls]: slowPayload() }) });
  const bannerIndex = nodes.findIndex((node) => {
    const value = node.props?.className;
    return typeof value === "string" && value.split(/\s+/).includes("de-slow");
  });
  const titleIndex = nodes.findIndex((node) => node.type === "h3" && collectText(node).join("") === "用量统计与对比");
  assert.ok(bannerIndex >= 0 && titleIndex >= 0, "报警块与统计页标题都必须渲染");
  assert.ok(bannerIndex < titleIndex, "报警块必须在统计页内容的最上面");
});

test("未报警 / 状态没读到时：不画图标，也不画说明", async () => {
  for (const payload of [null, undefined, slowPayload({ active: false, streak: 2 })]) {
    const { nodes } = await render({ slots: statsSlots({ [SLOTS.slowCalls]: payload }) });
    assert.equal(byClass(nodes, "de-tab__warn"), undefined, "没报警时不该出现图标");
    assert.equal(byClass(nodes, "de-slow"), undefined, "没报警时不该出现说明");
  }
});

test("配置 tab 下也照样显示图标（图标跟着「现在有事」，不跟着当前页）", async () => {
  const { nodes } = await render({
    slots: {
      [SLOTS.tab]: "config",
      [SLOTS.slowCalls]: slowPayload(),
    },
  });
  assert.ok(byClass(nodes, "de-tab__warn") !== undefined, "用户在配置 tab 上时也该看见这个提醒");
});

test("英文界面：图标与说明都不留中文", async () => {
  const { nodes } = await render({
    lang: "en",
    slots: statsSlots({ [SLOTS.slowCalls]: slowPayload() }),
  });
  const warn = byClass(nodes, "de-tab__warn");
  const banner = byClass(nodes, "de-slow");
  assert.ok(warn !== undefined && banner !== undefined, "英文界面上这两处都得在");
  const ariaLabel = String(warn.props["aria-label"] ?? "");
  assert.equal(CJK.test(ariaLabel), false, `图标 aria-label 仍是中文：${ariaLabel}`);
  const bannerText = collectText(banner).join(" ");
  assert.equal(CJK.test(bannerText), false, `说明横幅仍是中文：${bannerText}`);
  assert.match(bannerText, /5/);
  assert.match(bannerText, /10/);
});
