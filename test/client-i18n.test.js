/**
 * 配置页 / 统计页的**语言**测试：真的把客户端 bundle 跑起来，按宿主语言渲染。
 *
 * 防的是三类错：
 *
 * 1. 宿主的 `ctx.locale` 契约用错（读快照的位置、订阅的退订形状）——写错了
 *    不报错，只是语言永远停在初始值。
 * 2. 词典漏词：英文界面里还夹着中文。这类错只有在**真的渲染一遍**才看得见，
 *    静态比对（字面量是否都在词典里）抓不到「跨行拼接后整段没命中」这种情况。
 * 3. 把数据或标识也翻了（`value` / `href` / 错误 code）：翻译过度同样坏。
 *
 * 与 test/client-ui.test.js 的分工：那边测业务文案与结构，这边只测语言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PROVIDER_PRESETS, providerCatalog } from "../lib/providers.js";

/** 每次加载都要拿到新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/** 中文字符（含全角标点）——英文界面里出现任何一个都算漏翻。 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 加载 bundle 并按给定宿主语言渲染。
 *
 * @param options.lang - 宿主 locale：`"en"` / `"zh"` / null（没有 locale 服务）。
 * @param options.slots - `{ useState序号: 值 }`。
 * @param options.render - 渲染哪个组件：`"page"`（配置/统计页）或 `"tail"`。
 * @returns `{ text, tree, controls, i18n }`
 */
async function renderLang(options = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const unique = `\n// lang-test-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  const slots = options.slots ?? {};
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
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect() {
      /* SSR 语义：effect 不执行（订阅在 apply 里，不在 effect 里） */
    },
    useMemo: (fn) => fn(),
  };

  let component;
  let tailComponent;
  let i18n;
  const registered = [];

  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
        // 宿主 locale 服务：按 dsh-client-locale 的 LocaleFace 形状造。
        // getSnapshot 返回冻结的 { active, locales, revision }；
        // subscribe 返回退订函数。
        const snapshot = { active: options.lang ?? "en", locales: [], revision: 1 };
        const locale = options.lang === null
          ? undefined
          : {
              getSnapshot: () => snapshot,
              subscribe: () => () => {},
              register: () => () => {},
              bind: () => (key) => key,
            };
        const subs = [];
        const ctx = {
          logger: { info() {}, warn() {} },
          ...(locale === undefined ? {} : { locale }),
          on(event, fn) {
            subs.push([event, fn]);
            return () => {};
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
        tailComponent = registered[1];
        i18n = bundle.i18n;
      },
    },
  };

  await import(dataUrl);
  assert.ok(typeof component === "function", "客户端 bundle 未注册组件");

  const tree = component({ view: "config" });
  return { tree, text: collectText(tree).join("\n"), controls: collectControls(tree), i18n, tail: tailComponent };
}

/** 收集渲染树里的文本（含 value / placeholder）。 */
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

function collectControls(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectControls(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (node.type === "input" || node.type === "select") out.push(node);
  collectControls(node.children, out);
  return out;
}

/** useState 槽位（与 client-ui.test.js 保持一致）。 */
const SLOTS = {
  status: 0,
  keyInputs: 1,
  busy: 2,
  msg: 3,
  loading: 4,
  draft: 5,
  providerDraft: 6,
  storageDraft: 7,
  providerError: 8,
  models: 9,
  modelsState: 10,
  decisions: 11,
  pointsDraft: 12,
  stats: 13,
  statsError: 14,
  statsFilter: 15,
  tab: 16,
  statsMeta: 17,
  saveState: 18,
  // 19 = useLang 的 state（新增，排在最后）
};

/** 服务端状态（模拟已加载）。 */
function stateWith(over = {}) {
  return {
    enabled: true,
    mode: "shadow",
    provider: "bamboonode",
    providerLabel: "bamboonode",
    providerValid: true,
    providerError: "",
    providerCatalog: providerCatalog(),
    baseUrl: "https://api.bamboonode.dev/v1/decisions",
    rawBaseUrl: "https://api.bamboonode.dev/v1",
    customBaseUrl: "",
    customEndpointStyle: "auto",
    customModel: "",
    customHeaders: "",
    customApiKeyEnv: "",
    customKeyConfigured: false,
    model: "自动（服务端默认）",
    rawModel: "",
    rawSystemoneModel: "",
    rawModels: { model: "", systemoneModel: "", siliconflowModel: "", siliconflowIntlModel: "", customModel: "" },
    thinkMode: "never",
    timeoutMs: 8000,
    keyConfigured: true,
    keyHint: "…abcd",
    keyEnvName: "BAMBOO_API_KEY",
    keyStorage: "credentials",
    keySource: { active: "bamboonode", configured: true, hint: "…abcd", refName: "BAMBOO_API_KEY", sourceLabel: "环境变量" },
    credentialSources: [],
    decisions: [],
    ...over,
  };
}

/** 统计结果（覆盖节省量、裁决、历史、写盘各区块）。 */
function statsWith(over = {}) {
  return {
    range: { preset: "today", label: "当日", start: "", end: "", valid: true, error: "" },
    labels: { today: "当日", week: "本周", month: "本月", year: "本年", custom: "自定义" },
    presets: ["today", "week", "month", "year", "custom"],
    totals: {
      requests: 12, cached: 4, inputTokens: 24000, outputTokens: 3600, totalTokens: 27600,
      durationMs: 15000, observeRequests: 8, observeInputTokens: 16000, observeOutputTokens: 2400,
      observeDurationMs: 10000, observeBaseInputTokens: 40000, observeBaseOutputTokens: 3600,
      observeBaseDurationMs: 22000, savedInputTokens: 16000, savedOutputTokens: 0, savedTotalTokens: 16000,
      savedDurationMs: 7000, savedRatio: 0.5797, savedTimeRatio: 0.3181, avgDurationMs: 1250,
    },
    rows: [{
      provider: "bamboonode", model: "startlux-decision-27b-autothink", requests: 8, cached: 4,
      inputTokens: 16000, outputTokens: 2400, durationMs: 10000, avgDurationMs: 1250,
      observeRequests: 8, observeInputTokens: 16000, observeOutputTokens: 2400, observeDurationMs: 10000,
      savedInputTokens: 12000, savedOutputTokens: 0, savedDurationMs: 5000, savedRatio: 0.6,
    }],
    byProvider: [], byPoint: [],
    savings: { totalRequests: 8, byMode: { observe: 8, enforce: 0, off: 0, unknown: 0 } },
    savingsMeta: { totalRequests: 8, byMode: { observe: 8, enforce: 0, off: 0, unknown: 0 } },
    outcomes: {
      allow: 120, ask: 8, reject: 3, none: 5, decided: 131, total: 136,
      byPoint: [
        { point: "authorize", allow: 100, ask: 8, reject: 3, none: 2 },
        { point: "retrieval", allow: 20, ask: 0, reject: 0, none: 3 },
      ],
      otherVerdicts: [], otherVerdictCount: 0,
    },
    legacy: { included: true, count: 42, note: "" },
    store: { path: "/tmp/stats.jsonl", written: 120, failed: 0, dropped: 0 },
    ...over,
  };
}

const decisionsFixture = [
  { id: "authorize", label: "工具授权", hook: "tools/pre-execute", trigger: "每次工具调用", mode: "shadow", available: true, mounted: true, hotPath: true, gate: "只读工具直接放行", summary: "在工具执行前判断风险", stats: { requests: 3, cached: 1, tokens: 120, avgLatencyMs: 900 } },
  { id: "retrieval", label: "检索必要性", hook: "retrieval/pre", trigger: "每次检索", mode: "off", available: true, mounted: true, hotPath: false, gate: "问题含时间指代", summary: "判断要不要检索", stats: {} },
];

// ---------------------------------------------------------------- 英文渲染

test("英文：宿主语言为 en 时，配置页不残留中文", async () => {
  const { text } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith(), [SLOTS.decisions]: decisionsFixture } });
  const leftover = collectCjkFragments(text);
  assert.deepEqual(leftover, [], `配置页仍有中文：\n${leftover.join("\n")}\n\n全文：\n${text.slice(0, 3000)}`);
});

test("英文：统计页不残留中文", async () => {
  const { text } = await renderLang({
    lang: "en",
    slots: {
      [SLOTS.status]: stateWith(),
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWith(),
      [SLOTS.statsMeta]: { presets: ["today", "week", "month", "year", "custom"], labels: { today: "当日", week: "本周", month: "本月", year: "本年", custom: "自定义" } },
      [SLOTS.decisions]: decisionsFixture,
    },
  });
  const leftover = collectCjkFragments(text);
  assert.deepEqual(leftover, [], `统计页仍有中文：\n${leftover.join("\n")}\n\n全文：\n${text.slice(0, 3000)}`);
});

test("英文：界面上确实出现了英文关键词（不是整页空白或原样中文）", async () => {
  const { text } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith(), [SLOTS.decisions]: decisionsFixture } });
  assert.ok(text.includes("Provider"), `应出现 Provider，实际：\n${text.slice(0, 1200)}`);
  assert.ok(text.includes("Enable guard"), `应出现 Enable guard，实际：\n${text.slice(0, 1200)}`);
});

test("中文：宿主语言为 zh 时保持原样中文界面", async () => {
  const { text } = await renderLang({ lang: "zh", slots: { [SLOTS.status]: stateWith(), [SLOTS.decisions]: decisionsFixture } });
  assert.ok(text.includes("服务提供方"), `中文界面应显示「服务提供方」，实际：\n${text.slice(0, 1200)}`);
  assert.ok(text.includes("启用守卫"), `中文界面应显示「启用守卫」，实际：\n${text.slice(0, 1200)}`);
});

test("宿主没有 locale 服务时按浏览器语言（测试环境 navigator=en-US → 英文）", async () => {
  const { text } = await renderLang({ lang: null, slots: { [SLOTS.status]: stateWith(), [SLOTS.decisions]: decisionsFixture } });
  assert.ok(text.includes("Provider"), `无 locale 服务时应回落到浏览器语言（en-US → 英文），实际：\n${text.slice(0, 1200)}`);
});

// ---------------------------------------------------------------- 机制

test("normalizeLang：带 zh 前缀都算中文，其余算英文", async () => {
  const { i18n } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith() } });
  assert.equal(i18n.normalizeLang("zh"), "zh");
  assert.equal(i18n.normalizeLang("zh-CN"), "zh");
  assert.equal(i18n.normalizeLang("zh-Hant"), "zh");
  assert.equal(i18n.normalizeLang("en"), "en");
  assert.equal(i18n.normalizeLang("en-US"), "en");
  assert.equal(i18n.normalizeLang("ja"), "en", "未来第三种语言应回落到英文，不是中文");
  assert.equal(i18n.normalizeLang(""), null);
  assert.equal(i18n.normalizeLang(undefined), null);
});

test("readHostLang：按 LocaleFace 的快照读 active", async () => {
  const { i18n } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith() } });
  const ctx = { locale: { getSnapshot: () => ({ active: "zh", locales: [], revision: 3 }) } };
  assert.equal(i18n.readHostLang(ctx), "zh");
  // 快照不可用时退回直接属性。
  assert.equal(i18n.readHostLang({ locale: { active: "en" } }), "en");
  // 什么都没有时返回 null，由调用方回落。
  assert.equal(i18n.readHostLang({}), null);
  assert.equal(i18n.readHostLang(undefined), null);
});

test("t()：模板查表并填参，参数里的中文也翻译", async () => {
  const { i18n } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith() } });
  assert.equal(i18n.t("按「{label}」排序", { label: "总耗时" }), "Sort by “Total time”");
  assert.equal(i18n.t("统计读取失败：{error}", { error: "timeout" }), "Failed to load statistics: timeout");
  // 缺参数时保留占位符，不吞掉。
  assert.equal(i18n.t("统计读取失败：{error}"), "Failed to load statistics: {error}");
});

test("tr()：英文界面下未登记的中文原样返回（宁可留中文，也不出乱码）", async () => {
  const { i18n } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith() } });
  assert.equal(i18n.tr("没有登记的新文案"), "没有登记的新文案");
  assert.equal(i18n.tr("次数"), "Calls");
  // 空串与非字符串原样返回（可能是 null / 数字节点）。
  assert.equal(i18n.tr(""), "");
  assert.equal(i18n.tr(null), null);
  assert.equal(i18n.tr(42), 42);
});

test("setLang：切换时通知订阅者（useLang 的重绘来源）", async () => {
  const { i18n } = await renderLang({ lang: "en", slots: { [SLOTS.status]: stateWith() } });
  assert.equal(i18n.lang, "en");
  i18n.setLang("zh");
  assert.equal(i18n.lang, "zh");
  // 同值再设不重复通知（force 才通知）。
  i18n.setLang("zh");
  assert.equal(i18n.lang, "zh");
});

/** 把文本切成「含中文的片段」，用于定位漏翻。 */
function collectCjkFragments(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !CJK.test(trimmed)) continue;
    out.push(trimmed.slice(0, 120));
  }
  return out;
}

// ------------------------------------------------- 未走到/异常分支的漏翻检查
//
// 主流程渲染干净还不够：错误提示、空状态、custom provider 表单、未加载态
// 都是**单独的文案分支**，平时不出现，最容易漏登记。这里逐个把状态推进那些
// 分支，再断言英文界面里没有中文。

test("英文：custom provider 表单与本地校验提示不残留中文", async () => {
  const catalog = providerCatalog();
  const custom = catalog.find((item) => item.id === "custom");
  const { text } = await renderLang({
    lang: "en",
    slots: {
      [SLOTS.status]: stateWith({
        provider: "custom",
        providerValid: false,
        providerError: "地址不合法",
        customBaseUrl: "not-a-url",
        customEndpointStyle: "auto",
        providerCatalog: catalog,
        ...(custom ? {} : {}),
      }),
      [SLOTS.decisions]: decisionsFixture,
    },
  });
  const leftover = collectCjkFragments(text);
  assert.deepEqual(leftover, [], `custom 表单仍有中文：\n${leftover.join("\n")}`);
});

test("英文：保存失败态与重试按钮不残留中文", async () => {
  const { text } = await renderLang({
    lang: "en",
    slots: {
      [SLOTS.status]: stateWith(),
      [SLOTS.saveState]: { error: "invalid base URL" },
      [SLOTS.decisions]: decisionsFixture,
    },
  });
  const leftover = collectCjkFragments(text);
  assert.deepEqual(leftover, [], `保存失败态仍有中文：\n${leftover.join("\n")}`);
  assert.ok(text.includes("Retry"), `应有 Retry 按钮，实际：\n${text.slice(0, 900)}`);
});

test("英文：统计读取失败与空区间态不残留中文", async () => {
  const { text } = await renderLang({
    lang: "en",
    slots: {
      [SLOTS.status]: stateWith(),
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWith({ rows: [], totals: { requests: 0 }, savings: null, savingsMeta: null, outcomes: undefined, legacy: { included: false, count: 0 }, store: null }),
      [SLOTS.statsError]: "timeout",
      [SLOTS.statsMeta]: { presets: ["today", "week", "month", "year", "custom"], labels: { today: "当日", week: "本周", month: "本月", year: "本年", custom: "自定义" } },
      [SLOTS.decisions]: decisionsFixture,
    },
  });
  const leftover = collectCjkFragments(text);
  assert.deepEqual(leftover, [], `统计错误/空态仍有中文：\n${leftover.join("\n")}`);
});

test("英文：状态未加载（首屏）时不残留中文", async () => {
  const { text } = await renderLang({ lang: "en", slots: { [SLOTS.status]: null } });
  const leftover = collectCjkFragments(text);
  assert.deepEqual(leftover, [], `未加载态仍有中文：\n${leftover.join("\n")}`);
});

test("英文：错误尾部（决策点/分类/工具名）不残留中文", async () => {
  const { tail } = await renderLang({ lang: "en" });
  assert.ok(typeof tail === "function", "未注册错误尾部组件");
  const tree = tail({
    turn: { turn: 3, data: { get: (key) => (key === "decision-engine-error" ? { kind: "turn", turn: 3, key, value: { errors: [{ turn: 3, point: "authorize", code: "auth-failed", label: "鉴权被拒", tool: "bash" }] } } : undefined) } },
    seq: 1,
    openFile() {},
  });
  const leftover = collectCjkFragments(collectText(tree).join("\n") + "\n" + (tree.props?.title ?? ""));
  assert.deepEqual(leftover, [], `错误尾部仍有中文：\n${leftover.join("\n")}`);
});
