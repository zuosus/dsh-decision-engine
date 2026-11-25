/**
 * 统计与对比页的**设计验收**：它必须和配置页共用同一套视觉系统（DEC-070 / DEC-085）。
 *
 * 为什么单独一个文件：`client-ui.test.js` 盯的是「数字与文案对不对」，它的断言
 * 全是 `text` 里有没有某句话——所以统计页哪怕整页还是旧的内联 rgba 卡片、
 * 和配置页完全两个样子，那边也全绿。设计一致性只能由「结构 + 样式源」断言守住。
 *
 * 三条硬要求（对应 DEC-085）：
 *   1. 两个 tab 共用同一个 `de-settings` 外壳——否则配置页的样式表一条都进不来
 *      （旧实现里统计 tab 的根节点根本没有这个 class，于是连 tab 栏都长得不一样）。
 *   2. 统计页的区块、指标格、表格、提示条一律走类名，不再内联硬编码配色；
 *      颜色与间距只能来自 `client.config.css` 的共享令牌。
 *   3. 离散选项（时间范围）与配置页的 picker 同一种控件语言：
 *      `button[aria-pressed]` 线框按钮，选中态由 `aria-pressed` 表达。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../lib/client.config.css", import.meta.url), "utf8");
const BUNDLE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** 每次加载都要一份新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

const status = {
  enabled: true,
  mode: "shadow",
  provider: "systemone",
  providerLabel: "systemone",
  providerValid: true,
  providerError: "",
  providerCatalog: [],
  baseUrl: "https://api.typesafe.ai/v1/decisions",
  rawBaseUrl: "https://api.typesafe.ai/v1",
  customBaseUrl: "",
  customEndpointStyle: "auto",
  customModel: "",
  customHeaders: "",
  customApiKeyEnv: "",
  customKeyConfigured: false,
  model: "自动（服务端默认）",
  rawModel: "",
  rawModels: {},
  thinkMode: "never",
  timeoutMs: 8000,
  keyConfigured: true,
  keyStorage: "credentials",
  keyStatus: {},
  stats: { requests: 0, cached: 0 },
  serverProvider: { enabled: false, status: "idle" },
};

const decisions = {
  points: [
    { id: "authorize", label: "工具授权", mode: "enforce", available: true, mounted: true },
    { id: "retrieval", label: "检索必要性", mode: "enforce", available: true, mounted: true },
  ],
  modes: ["off", "observe", "enforce"],
};

/**
 * 一份**每个区块都能渲染**的统计结果。
 *
 * 刻意给全：区块类名只在区块真的渲染时才存在，缺一块测试就会漏掉那一块的结构
 * 断言（例如只给 rows 不给 byPoint，分账表根本没渲染，它的 td 却「通过」了）。
 */
const stats = {
  range: { preset: "today", label: "当日", start: "", end: "", valid: true, error: "" },
  presets: ["today", "week", "month", "year", "custom"],
  labels: { today: "当日", week: "本周", month: "本月", year: "本年", custom: "自定义" },
  totals: {
    requests: 12,
    cached: 4,
    inputTokens: 24000,
    outputTokens: 3600,
    durationMs: 15000,
    avgDurationMs: 1250,
    observeRequests: 8,
    observeInputTokens: 16000,
    observeOutputTokens: 2400,
    observeDurationMs: 10000,
    observeBaseInputTokens: 40000,
    observeBaseOutputTokens: 3600,
    observeBaseDurationMs: 22000,
    savedInputTokens: 16000,
    savedOutputTokens: 0,
    savedDurationMs: 7000,
    savedRatio: 0.5797,
  },
  rows: [
    {
      provider: "systemone",
      model: "s1-fast",
      requests: 8,
      cached: 4,
      inputTokens: 16000,
      outputTokens: 2400,
      durationMs: 10000,
      avgDurationMs: 1250,
      observeRequests: 8,
      observeInputTokens: 16000,
      observeOutputTokens: 2400,
      observeDurationMs: 10000,
      savedInputTokens: 12000,
      savedOutputTokens: 0,
      savedDurationMs: 5000,
      savedRatio: 0.6,
    },
  ],
  byPoint: [
    { point: "authorize", requests: 7, cached: 2, inputTokens: 14000, outputTokens: 2000, durationMs: 9000, avgDurationMs: 1285 },
    { point: "retrieval", requests: 5, cached: 2, inputTokens: 10000, outputTokens: 1600, durationMs: 6000, avgDurationMs: 1200 },
  ],
  outcomes: {
    total: 12,
    decided: 10,
    none: 2,
    allow: 6,
    ask: 3,
    reject: 1,
    byPoint: [
      { point: "authorize", allow: 5, ask: 2, reject: 1, none: 1 },
      { point: "retrieval", allow: 1, ask: 1, reject: 0, none: 1 },
    ],
    otherVerdictCount: 0,
    otherVerdicts: [],
  },
  savings: {
    observeRequests: 8,
    totalRequests: 12,
    byMode: { observe: 8, enforce: 4, off: 0, unknown: 0 },
    unavailable: false,
  },
  series: {
    bucket: "hour",
    buckets: ["09:00", "10:00", "11:00"],
    nowIndex: 2,
    series: { requests: [3, 5, 4], inputTokens: [6000, 9000, 9000], durationMs: [3000, 6000, 6000] },
  },
  legacy: { included: false, count: 0, note: "" },
  recordCount: 12,
};

const slotsWith = (statsValue) => ({
  0: status,
  11: decisions,
  13: statsValue,
  14: "",
  15: { preset: "today", start: "", end: "", sort: "inputTokens", dir: "desc" },
  16: "stats",
  17: { presets: stats.presets, labels: stats.labels },
});

async function renderStats(over = {}) {
  const states = { ...slotsWith(stats), ...over };
  let stateIndex = 0;
  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = stateIndex++;
      return [Object.hasOwn(states, index) ? states[index]
        : typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, _getSnapshot, getServerSnapshot) =>
      typeof getServerSnapshot === "function" ? getServerSnapshot() : null,
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
        bundle.apply({
          logger: { info() {}, warn() {} },
          locale: {
            register: () => () => {},
            getSnapshot: () => ({ active: "zh", locales: [], revision: 1 }),
            subscribe: () => () => {},
          },
          slots: {
            inject(_slot, callback) { callback(); return () => {}; },
            register(_meta, comp) { registered.push(comp); return () => {}; },
          },
          effect(body) {
            const iterator = body();
            let step = iterator.next();
            while (!step.done) step = iterator.next(step.value);
            return () => {};
          },
        });
        component = registered[0];
      },
    },
  };
  const unique = `${BUNDLE}\n// stats-design-${++loadSeq}\n`;
  await import(`data:text/javascript;base64,${Buffer.from(unique).toString("base64")}`);
  assert.equal(typeof component, "function", "loader must register the config component");
  return component({ view: "config" });
}

function nodes(node, predicate = () => true, out = []) {
  if (Array.isArray(node)) node.forEach((child) => nodes(child, predicate, out));
  else if (node && typeof node === "object") {
    if (predicate(node)) out.push(node);
    nodes(node.children, predicate, out);
  }
  return out;
}

const hasClass = (node, name) => String(node.props?.className ?? "").split(/\s+/).includes(name);
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object") return text(node.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

/** CSS 里统计页那一段（从共享令牌注释到文件末尾的容器查询之前）。 */
function statsCssRegion() {
  const start = CSS.indexOf(".de-settings .de-stats");
  assert.ok(start >= 0, "client.config.css 里找不到统计页样式区（.de-settings .de-stats）");
  return CSS.slice(start);
}

// ---------------------------------------------------------------- 外壳

test("统计页与配置页共用 de-settings 外壳", async () => {
  const root = await renderStats();
  assert.ok(hasClass(root, "de-settings"), "统计页根节点缺 de-settings：配置页的样式表一条都进不来");
  assert.ok(hasClass(root, "de-stats"), "统计页根节点缺 de-stats 标记");
  // tab 栏在同一个作用域里，两个 tab 才能用同一种 tab 样式。
  const tabBar = nodes(root, (node) => hasClass(node, "de-settings__tabs"))[0];
  assert.ok(tabBar, "tab 栏缺 de-settings__tabs：切到统计页时 tab 会退回旧胶囊样式");
});

test("统计页区块使用与配置页相同的分组节奏", async () => {
  const root = await renderStats();
  const sections = nodes(root, (node) => hasClass(node, "de-stats__section"));
  assert.ok(sections.length >= 5, `统计页应有 ≥5 个 de-stats__section（区块），实际 ${sections.length}`);
  for (const section of sections) {
    assert.ok(nodes(section, (node) => hasClass(node, "de-stats__title")).length > 0,
      "每个区块必须有一个 de-stats__title");
  }
  // 分组之间的分隔线只能由 CSS 的兄弟选择器表达，不能靠每块自带的卡片边框。
  const region = statsCssRegion();
  assert.match(region, /\.de-stats__section \+ \.de-stats__section\s*\{[^}]*border-top: 1px solid var\(--de-border\)/,
    "分组之间必须用 .de-stats__section + .de-stats__section 的顶边细线，与配置页同一套节奏");
});

// ---------------------------------------------------------------- 控件

test("时间范围是线框按钮组，选中态用 aria-pressed 表达", async () => {
  const root = await renderStats();
  const presets = nodes(root, (node) => hasClass(node, "de-stats__presets"))[0];
  assert.ok(presets, "时间范围缺 de-stats__presets 按钮组");
  const buttons = nodes(presets, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed"));
  assert.equal(buttons.length, stats.presets.length, "每个预设一个按钮");
  const selected = buttons.filter((button) => button.props["aria-pressed"] === true);
  assert.equal(selected.length, 1, "恰好一个预设处于选中态");
  assert.equal(text(selected[0]), "当日", "默认选中「当日」");
  // 与配置页的 picker 共用同一组 CSS 规则（DEC-082 / DEC-084 的控件语言）。
  const region = statsCssRegion();
  assert.match(region, /\.de-stats__presets\b/, "CSS 必须给预设按钮组样式");
});

// ---------------------------------------------------------------- 不再内联配色

test("统计页不再内联硬编码配色（旧视觉语言已清除）", async () => {
  const root = await renderStats();
  const legacy = [];
  for (const node of nodes(root)) {
    const style = node.props?.style;
    if (!style || typeof style !== "object") continue;
    for (const [key, value] of Object.entries(style)) {
      if (typeof value !== "string") continue;
      if (/#[0-9a-fA-F]{3,8}\b/.test(value) || /rgba?\(/.test(value)) {
        legacy.push(`<${node.type} ${key}: ${value}>`);
      }
    }
  }
  assert.deepEqual(legacy, [], `统计页仍有内联硬编码配色：${legacy.slice(0, 6).join(", ")}`);
});

test("样式源里统计页的颜色与间距只能来自共享令牌", async () => {
  const region = statsCssRegion();
  assert.doesNotMatch(region, /rgba\(128,\s*128,\s*128/, "不得再用旧的灰色 rgba 硬编码");
  assert.match(region, /var\(--de-space-[1234]\)/, "间距必须走 --de-space-* 令牌");
  assert.match(region, /var\(--de-border\)/, "分隔线与边框必须走 --de-border");
});

// ---------------------------------------------------------------- 表格与指标

test("指标格、表格与提示条都走类名", async () => {
  const root = await renderStats();
  const metrics = nodes(root, (node) => hasClass(node, "de-stats__metric"));
  assert.ok(metrics.length >= 8, `汇总/裁决指标格应渲染出来，实际 ${metrics.length}`);
  const tables = nodes(root, (node) => hasClass(node, "de-stats__table"));
  assert.ok(tables.length >= 3, `对比 / 裁决 / 分账三张表都应存在，实际 ${tables.length}`);
  assert.ok(nodes(root, (node) => hasClass(node, "de-stats__td")).length > 0, "单元格缺 de-stats__td");
  assert.ok(nodes(root, (node) => hasClass(node, "de-stats__td--saved")).length > 0,
    "节省量单元格缺 de-stats__td--saved（绿色语义由 CSS 承担）");
  assert.ok(nodes(root, (node) => hasClass(node, "de-stats__th")).length > 0, "表头缺 de-stats__th");
});

test("读取失败与空区间用同一套提示条（不再画红框卡片）", async () => {
  const failed = await renderStats({ 14: "boom" });
  const errorNotice = nodes(failed, (node) => hasClass(node, "de-stats__notice--error"))[0];
  assert.ok(errorNotice, "读取失败必须用 de-stats__notice--error");
  assert.match(text(errorNotice), /统计读取失败/, "提示条里要带上失败原因");

  const empty = await renderStats({ 13: { ...stats, rows: [], byPoint: [] } });
  const notices = nodes(empty, (node) => hasClass(node, "de-stats__notice"));
  assert.ok(notices.length > 0, "空区间必须给一条提示，而不是空白");
});
