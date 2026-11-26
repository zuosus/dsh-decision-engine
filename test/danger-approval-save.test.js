/**
 * 「危险权限申请交给决策模型」的**落盘链路**测试（DEC-093）。
 *
 * ## 为什么必须有这一层
 *
 * 这个开关的真机症状是「打开后去别的页面再回来，发现又是关闭的」。当时
 * 渲染测试全绿、服务端白名单测试也全绿，因为它们各自只看了一半：
 *
 *   - 渲染测试证明开关**画得对**；
 *   - 白名单测试证明服务端**收到就能存**。
 *
 * 中间还有一段没人测：**客户端到底发没发那个 PUT**。真凶正在这里——
 * `patchDiffersFromServer()` 用一张手写的字段表判断「这次改动值不值得发请求」，
 * 新字段漏登记 → 判定「没有变化」→ 一个 PUT 都不发 → 状态行还显示「已保存」
 * → 下次 `/status` 回显就画回关。
 *
 * 所以本文件**真的驱动控件**：取渲染树里那个开关的 onClick、再取确认对话框
 * 里那个按钮的 onClick，一路点到 `fetch`，然后断言请求体里有这个字段。
 *
 * 两个方向都要测：
 *   1. 服务端是关、用户打开 → **必须**发出带 `dangerFullAccessDecider: true` 的 PUT；
 *   2. 服务端已经是开 → 再点一次关闭 → **必须**发出带 `false` 的 PUT（关掉同样不能哑火）。
 *
 * 这两条都不看「界面画成什么」，只看「有没有真的把话传出去」。
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
 * `dangerConfirmOpen` 是最后一个（23）；渲染时注入 true 就等于「用户已经点过
 * 开关、对话框正开着」，于是可以直接取到确认按钮。
 */
const SLOTS = { status: 0, draftState: 5, sectionOpen: 19, dangerConfirmOpen: 23 };

/** 四个分组全展开，否则正文是 `hidden` 的。 */
const ALL_SECTIONS_OPEN = { connection: true, guard: true, record: true, model: true };

/** 服务端 `/status` 的最小回显。 */
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
 * 渲染配置页并把 fetch 打桩成「永远成功」。
 *
 * **fetch 桩必须活到点击之后**：`call()` 用的是裸 `fetch`，在事件触发时才解析。
 * 早一步还原桩，请求会打到真实网络上（Node 里是 "Failed to parse URL"），
 * 而 flush 的 catch 会把错误吞成状态行文案——测试于是只看到「没有 PUT」，
 * 分不清是「没发」还是「发失败了」。所以这里把还原交给调用方。
 *
 * @param options.slots - `{ 槽位序号: 值 }`，覆盖对应 useState 的返回值。
 * @returns `{ tree, calls, restore }`。
 */
async function render({ slots = {} } = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(
    `${source}\n// danger-save-${loadSeq}\n`,
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
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    const payload = JSON.stringify(slots[SLOTS.status] ?? null);
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
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
            getSnapshot: () => ({ active: "zh", locales: [], revision: 1 }),
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

  await import(dataUrl);
  return {
    tree: registered[0]({ view: "config" }),
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      globalThis.window = originalWindow;
    },
  };
}

/** 递归查找所有满足条件的节点。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node) === true) out.push(node);
  findAll(node.children, predicate, out);
  return out;
}

/** 递归收集文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === "object") textOf(node.children, out);
  return out;
}

/** 取出对话框里文字含 `hint` 的按钮。 */
function buttonInDialog(tree, hint) {
  const dialog = findAll(tree, (node) => node.props?.role === "dialog")[0];
  assert.ok(dialog !== undefined, "风险提示对话框应当存在");
  const hit = findAll(dialog, (node) => node.type === "button").find((node) =>
    textOf(node).join("").includes(hint),
  );
  assert.ok(hit !== undefined, `对话框里应当有「${hint}」按钮`);
  return hit;
}

/** 等待 flush 那一轮异步落盘跑完。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

// ------------------------------------------------------------------ 契约

test("打开开关：必须发出携带 dangerFullAccessDecider=true 的 PUT", async () => {
  // 服务端是关、用户点了确认。少了这个 PUT，界面会「看起来保存成功」，
  // 然后下一次回显把它画回关——这就是真机上的那个 bug。
  const page = await render({
    slots: {
      [SLOTS.status]: stateWith({ dangerFullAccessDecider: false }),
      [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
      [SLOTS.dangerConfirmOpen]: true,
    },
  });
  try {
    buttonInDialog(page.tree, "仍然开启").props.onClick();
    await settle();
    const put = page.calls.find((call) => call.method === "PUT");
    assert.ok(
      put !== undefined,
      `必须发出 PUT；实际请求：${JSON.stringify(page.calls.map((c) => `${c.method} ${c.url}`))}`,
    );
    assert.equal(JSON.parse(put.body).dangerFullAccessDecider, true, "PUT 必须携带该字段");
  } finally {
    page.restore();
  }
});

test("关闭开关：同样必须发出携带 false 的 PUT（收紧也不能哑火）", async () => {
  // 关掉是更重要的方向：用户以为已经收回权限，实际服务端还开着。
  const page = await render({
    slots: {
      [SLOTS.status]: stateWith({ dangerFullAccessDecider: true }),
      [SLOTS.sectionOpen]: ALL_SECTIONS_OPEN,
    },
  });
  try {
    const row = findAll(page.tree, (node) => node.props?.["data-field"] === "dangerFullAccessDecider")[0];
    assert.ok(row !== undefined, "应当有 dangerFullAccessDecider 这一行");
    const toggle = findAll(row, (node) => node.type === "button" && node.props["aria-pressed"] !== undefined)[0];
    assert.ok(toggle !== undefined, "应当有开关");
    assert.equal(toggle.props["aria-pressed"], true, "前置：服务端此刻是开");
    toggle.props.onClick();
    await settle();
    const put = page.calls.find((call) => call.method === "PUT");
    assert.ok(
      put !== undefined,
      `必须发出 PUT；实际请求：${JSON.stringify(page.calls.map((c) => `${c.method} ${c.url}`))}`,
    );
    assert.equal(JSON.parse(put.body).dangerFullAccessDecider, false, "PUT 必须携带 false");
  } finally {
    page.restore();
  }
});
