/**
 * 「危险权限申请交给决策模型」的界面验收测试（DEC-089）。
 *
 * 这块功能在界面上只有两件事，但两件都错不起：
 *
 *   1. **开关读的是服务端生效值**——默认关。界面显示「已开启」而服务端其实
 *      没开，用户会以为模型在替他把关，实际上每张卡照弹（或者更糟：以为有
 *      人看，其实没有）。
 *   2. **打开之前必须先看到风险与免责说明**——而且「取消」必须真的什么都没
 *      发生。这里用独立状态表达对话框，而不是借草稿：借草稿会让「我只是想
 *      看看它说什么」变成一次已保存的开启。
 *
 * 做法与 `client-ui.test.js` 同一条路：把客户端 bundle 真跑起来（最小 react
 * 桩），按 useState 槽位注入状态，再对渲染树断言。槽位表见下面 SLOTS。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { providerCatalog } from "../lib/providers.js";

/** 每次加载都要一份新模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/**
 * 配置页的 useState 槽位（顺序见 `client-src/31-config-page-state.js`）。
 *
 * 只登记本文件要用的几个；其余槽位用组件自己的初值。`dangerConfirmOpen`
 * 是**最后一个**（23），所以在本文件里新增它不影响任何既有槽位。
 */
const SLOTS = { status: 0, draftState: 5, sectionOpen: 19, dangerConfirmOpen: 23 };

/** 一份 `open: true` 的分组状态：默认四组全开，便于断言正文。 */
const ALL_SECTIONS_OPEN = { connection: true, guard: true, record: true, model: true };

/** 服务端 `/status` 的最小回显（配置页据此生成草稿）。 */
function stateWith(over = {}) {
  return {
    enabled: true,
    mode: "shadow",
    provider: "systemone",
    providerLabel: "systemone",
    providerValid: true,
    providerCatalog: providerCatalog(),
    baseUrl: "https://api.typesafe.ai/v1/decisions",
    rawBaseUrl: "https://api.typesafe.ai/v1",
    model: "自动（服务端默认）",
    rawModel: "",
    rawSystemoneModel: "",
    rawModels: { systemoneModel: "", siliconflowModel: "", siliconflowIntlModel: "", customModel: "" },
    thinkMode: "never",
    timeoutMs: 8000,
    keyConfigured: true,
    keyHint: "…abcd",
    keyEnvName: "TYPESAFE_API_KEY",
    keyStorage: "credentials",
    decisionsTabEnabled: true,
    approvalDetailReadable: true,
    serverProvider: { enabled: false, active: false, usable: false, endpoint: "", label: "", status: "idle" },
    backupModel: { enabled: false, active: false },
    ...over,
  };
}

/**
 * 渲染配置页，返回渲染树。
 *
 * @param options.slots - `{ 槽位序号: 值 }`，覆盖对应 useState 的返回值。
 * @param options.lang - 宿主语言，默认 zh。
 */
async function render({ slots = {}, lang = "zh" } = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(
    `${source}\n// danger-ui-${loadSeq}\n`,
    "utf8",
  ).toString("base64")}`;

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
      /* SSR 语义：effect 不执行，正好避免真实网络请求。 */
    },
    useMemo: (fn) => fn(),
    useSyncExternalStore(_subscribe, snapshot) {
      return snapshot();
    },
    useLayoutEffect() {},
  };

  const registered = [];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.fetch = async () => {
    const payload = JSON.stringify(slots[SLOTS.status] ?? null);
    return { ok: true, status: 200, text: async () => payload };
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
              callback();
              return () => {};
            },
            register(_meta, component) {
              registered.push(component);
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
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }

  assert.ok(typeof registered[0] === "function", "client bundle 未注册配置组件");
  return registered[0]({ view: "config" });
}

/** 递归收集文本。 */
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
  if (typeof node === "object") collectText(node.children, out);
  return out;
}

/** 递归查找第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || node === false || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node) === true) return node;
  return findNode(node.children, predicate);
}

/** 该行的开关（`data-field` 是 config.yml 里的字段名）。 */
function toggleOfField(tree, field) {
  const row = findNode(tree, (node) => node.props?.["data-field"] === field);
  if (row === null) return undefined;
  return findNode(row.children, (node) => node.type === "button" && node.props["aria-pressed"] !== undefined);
}

/** 对话框节点（`role="dialog"`）。 */
function dialogOf(tree) {
  return findNode(tree, (node) => node.props?.role === "dialog");
}

// ------------------------------------------------------------------ 契约

test("开关存在，且默认（服务端没写这一项）显示为关", async () => {
  const tree = await render({
    slots: { [SLOTS.status]: stateWith(), [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN },
  });
  const toggle = toggleOfField(tree, "dangerFullAccessDecider");
  assert.ok(toggle !== undefined, "配置页必须有 dangerFullAccessDecider 这一行的开关");
  assert.equal(toggle.props["aria-pressed"], false, "默认必须是关：这一项不能替用户默认打开");
});

test("服务端回显已开启时，开关画成开", async () => {
  const tree = await render({
    slots: {
      [SLOTS.status]: stateWith({ dangerFullAccessDecider: true }),
      [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
    },
  });
  assert.equal(toggleOfField(tree, "dangerFullAccessDecider").props["aria-pressed"], true);
});

test("开关关着时不显示风险对话框（不挡路）", async () => {
  const tree = await render({
    slots: { [SLOTS.status]: stateWith(), [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN },
  });
  assert.equal(dialogOf(tree), null, "没点开之前不该有任何遮罩");
});

test("风险提示对话框：说清越界范围、模型会错、免责、可随时关闭", async () => {
  const tree = await render({
    slots: {
      [SLOTS.status]: stateWith(),
      [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
      // 用户点了开关 → 对话框弹出（状态由组件自己的 setDangerConfirmOpen 置位）。
      [SLOTS.dangerConfirmOpen]: true,
    },
  });
  const dialog = dialogOf(tree);
  assert.ok(dialog !== null, "点了开关必须先弹风险提示");
  assert.equal(dialog.props["aria-modal"], "true", "对话框必须是模态语义");
  const text = collectText(dialog).join("\n");
  assert.ok(text.includes("整个文件系统"), "必须说清越界范围是整块磁盘，不只是工作区");
  assert.ok(text.includes("它会出错"), "必须说清判断来自小模型，会出错");
  assert.ok(text.includes("不承担任何责任"), "必须有免责说明");
  assert.ok(text.includes("随时可以关掉"), "必须说明可以随时收回");
});

test("对话框两个按钮：取消在前，确认按钮写明确认意图", async () => {
  const tree = await render({
    slots: {
      [SLOTS.status]: stateWith(),
      [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
      [SLOTS.dangerConfirmOpen]: true,
    },
  });
  const dialog = dialogOf(tree);
  const labels = (function walk(node, out = []) {
    if (node === null || node === undefined || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (node.type === "button") out.push(collectText(node).join(""));
    walk(node.children, out);
    return out;
  })(dialog);
  assert.deepEqual(labels, ["取消", "我了解风险，仍然开启"]);
});

test("开启时给出「模型同意就跳过卡片」的说明，关着时说明默认关", async () => {
  const off = collectText(
    await render({ slots: { [SLOTS.status]: stateWith(), [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN } }),
  ).join("\n");
  assert.ok(off.includes("默认关闭"), "关着时应说明默认关与开启前的提示");
  const on = collectText(
    await render({
      slots: {
        [SLOTS.status]: stateWith({ dangerFullAccessDecider: true }),
        [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
      },
    }),
  ).join("\n");
  assert.ok(on.includes("模型同意时不会弹卡"), "开着时应说明模型同意即放行");
});

test("英文界面里这条说明没有残留中文", async () => {
  const tree = await render({
    slots: {
      [SLOTS.status]: stateWith(),
      [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
      [SLOTS.dangerConfirmOpen]: true,
    },
    lang: "en",
  });
  const dialog = dialogOf(tree);
  const text = collectText(dialog).join("\n");
  // 全角标点也算残留（与 i18n 覆盖测试同一口径）。
  assert.equal(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text), false, text);
  assert.ok(text.includes("entire file system"), "英文界面应给出英文风险说明");
});
