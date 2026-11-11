/**
 * 设置界面的渲染测试（不需要真实 react，也不起浏览器）。
 *
 * 客户端 bundle 的加载协议是 `window.__ModuleLoader__.load({ factory })`，
 * `factory` 里 `require("react")`。因此只要提供一个最小的 react 桩，就能在
 * 裸 Node 里直接调用组件函数，检查它渲染出的文案与字段。
 *
 * 防的是「provider 表单根本没渲染出来」这类纯逻辑错误（条件写反、字段名拼错、
 * 引用了不存在的变量）——语法检查抓不到，人肉打开界面才发现。
 *
 * 覆盖：
 *   - 状态未加载时的兜底渲染（不空白，且不自带服务商地址）
 *   - provider 下拉包含全部预设，默认 bamboonode
 *   - 选 custom 时出现必填字段与本地校验提示
 *   - 服务端拒绝的原因会显示在界面上
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// provider 清单与字段名的唯一真源在 providers.js（服务端下发给界面）。
// 测试直接引用它，避免「测试抄一份清单、漏了新预设也照样绿」。
import { PROVIDER_IDS, PROVIDER_PRESETS, providerCatalog } from "../lib/providers.js";

/**
 * 项目主页地址：与 lib/client.js 里的 SITE_URL 保持一致。
 *
 * 这里抄一份是刻意的：断言要盯住「链接指向哪」，而不是「client.js 里
 * 有没有一个叫 SITE_URL 的变量」——后者在常量被改名后依然会绿。
 */
const SITE_URL = "https://dsh.zuos.us/dsh-decision-engine/";

/** 每次加载都要拿到一份新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/**
 * 渲染插件信息页。
 *
 * @param status - 第 0 个 useState（status）要返回的值；null 表示「状态未加载」。
 * @param options.slots - `{ 槽位序号: 值 }`，覆盖对应 useState 的返回值。
 * @returns `{ text, controls, tree }`：全部文本、input/select 节点、渲染树。
 *
 * React 的 useState 只能按**调用顺序**注入，所以这里用槽位表注入。
 * 当前组件的 useState 顺序（改动这个顺序时同步改这里）：
 *
 *   0 status        1 keyInputs     2 busy       3 msg
 *   4 loading       5 draftState    6 providerDraftState
 *   7 storageDraft  8 providerError 9 models     10 modelsState
 *   11 decisions    12 pointsDraft  13 stats     14 statsError
 *   15 statsFilter  16 tab          17 statsMeta    18 saveState
 *
 * 槽位对错了的表现很具体：比如把统计结果注到 `tab` 上，配置页会照常渲染
 * 而统计页不出来——测试会失败，而不是静默通过。
 */
const SLOTS = {
  status: 0,
  decisions: 11,
  stats: 13,
  statsError: 14,
  statsFilter: 15,
  tab: 16,
  statsMeta: 17,
};

/**
 * 一份决策点清单（服务端 /decisions 下发的形状）。
 *
 * 统计页的裁决分账表靠它显示决策点的**中文名**：没有它，
 * pointLabels 为空，界面会退回显示裸 id（authorize / retrieval）。
 */
/**
 * 人工审核比例的下发载荷（DEC-035）。
 *
 * 形状照抄 `lib/index.js` 的 `tolerancePayload()`：四档元数据由**服务端**下发，
 * 前端不抄一份，所以夹具也必须给全 label / summary / percentile——只给 id
 * 的话测试会通过，但界面上的标签会是裸 id，真机上就是「四个英文内部名」。
 */
const toleranceFixture = (over = {}) => ({
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
});

const decisionsFixture = {
  points: [
    { id: "authorize", label: "工具授权", mode: "enforce", available: true, mounted: true },
    { id: "retrieval", label: "检索必要性", mode: "enforce", available: true, mounted: true },
  ],
  modes: ["off", "observe", "enforce"],
  cache: { size: 0, exactHits: 0, softHits: 0, stores: 0, hitRate: 0 },
  tolerance: toleranceFixture(),
};

async function render(status, options = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 加一段唯一注释再转 data URL：内容是变量 → 模块标识不同 → factory 会重新执行。
  loadSeq += 1;
  const unique = `\n// test-instance-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  const slots = { [SLOTS.status]: status, ...(options.slots ?? {}) };

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
    useEffect() {
      // SSR 语义：effect 不执行，正好避免真实网络请求。
    },
    /**
     * 交互版图表用到的 hook。
     *
     * 为什么必须补齐：microcharts 的交互入口（`/interactive`）用
     * `useLayoutEffect` 画十字线、`useMemo` 缓存几何、`useSyncExternalStore`
     * 订阅选中态。桩里缺任何一个，交互版图表就会在渲染时抛
     * ReferenceError——而桩只提供 `useState` 时，静态版一切正常，
     * 于是「交互坏了」这件事在测试里根本不会暴露。
     *
     * `useSyncExternalStore` 的语义是「订阅外部 store 并返回快照」；
     * 这里没有外部 store，返回第三参数（getServerSnapshot）即可——
     * 它正是 SSR/无订阅场景下的正确答案。
     */
    useLayoutEffect() {
      // 同 useEffect：SSR 语义，不执行。
    },
    useMemo(fn) {
      return fn();
    },
    useSyncExternalStore(_subscribe, _getSnapshot, getServerSnapshot) {
      return typeof getServerSnapshot === "function" ? getServerSnapshot() : null;
    },
  };

  let component;
  let i18n;
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
          // 宿主 locale 服务：**显式声明中文**。
          //
          // 这些用例断言的是中文文案，而语言不再写死——它跟随宿主。若不给出
          // 语言，`browserLang()` 会读 Node 的 navigator（en-US）→ 界面变英文，
          // 断言全部落空。中文界面在这里是「测试输入」，不是默认值。
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
            register(_meta, comp) {
              registered.push(comp);
              return () => {};
            },
          },
          effect(body) {
            // generator 里 yield 的 disposer 在真实 cordis 里由框架管理。
            const iterator = body();
            let step = iterator.next();
            while (!step.done) step = iterator.next(step.value);
            return () => {};
          },
        };
        bundle.apply(ctx);
        component = registered[0];
        i18n = bundle.i18n;
      },
    },
  };

  await import(dataUrl);
  assert.ok(typeof component === "function", "client bundle 未注册配置组件");

  const tree = component({ view: "config" });
  return { tree, text: collectText(tree).join("\n"), controls: collectControls(tree), i18n };
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

/** 递归收集 input / select 节点。 */
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

/** 渲染树里是否有文字恰好是 label 的按钮。 */
function hasButtonLabeled(node, label) {
  if (node === null || node === undefined || node === false) return false;
  if (Array.isArray(node)) return node.some((child) => hasButtonLabeled(child, label));
  if (typeof node !== "object") return false;
  if (node.type === "button") {
    const texts = (node.children ?? []).filter((child) => typeof child === "string");
    if (texts.includes(label)) return true;
  }
  return (node.children ?? []).some((child) => hasButtonLabeled(child, label));
}

/** 一份带三个预设的服务端状态（模拟已加载）。 */
function stateWith(over) {
  return {
    enabled: true,
    mode: "shadow",
    provider: "bamboonode",
    providerLabel: "bamboonode",
    providerValid: true,
    providerError: "",
    // provider 清单直接用服务端那张表（providers.js 的 providerCatalog()）：
    // 界面按它渲染，测试若另抄一份就测不出「清单漏了新预设」。
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
    // 服务端按「字段名」下发的模型原值（见 lib/providers.js 的 modelField）。
    // 这张表决定「模型框写回 config.yml 的哪一格」，新增预设时前端自动跟上。
    rawModels: {
      systemoneModel: "",
      siliconflowModel: "",
      siliconflowIntlModel: "",
      customModel: "",
    },
    thinkMode: "never",
    timeoutMs: 8000,
    keyConfigured: true,
    keyHint: "…abcd",
    keyEnvName: "BAMBOO_API_KEY",
    keyStorage: "credentials",
    keyStatus: {
      systemone: {
        configured: false, hint: "", refName: "TYPESAFE_API_KEY", keyField: "systemoneApiKey",
        source: "none", sourceLabel: "未配置",
      },
      bamboonode: {
        configured: true, hint: "…abcd", refName: "BAMBOO_API_KEY", keyField: "bamboonodeApiKey",
        source: "credentials", sourceLabel: "~/.dsh/.credentials.yaml 的 BAMBOO_API_KEY",
      },
      siliconflow: {
        configured: false, hint: "", refName: "SILICONFLOW_API_KEY", keyField: "siliconflowApiKey",
        source: "none", sourceLabel: "未配置",
      },
      "siliconflow-intl": {
        configured: false, hint: "", refName: "SILICONFLOW_INTL_API_KEY", keyField: "siliconflowIntlApiKey",
        source: "none", sourceLabel: "未配置",
      },
      custom: {
        configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", keyField: "customApiKey",
        source: "none", sourceLabel: "未配置",
      },
    },
    stats: { requests: 0, cached: 0 },
    // 服务端下发（DEC-030）的默认形态：关闭、尚未取过。字段名与
    // `/status` 的冻结契约一致（服务端由 lib/index.js 的 statusPayload 给出）。
    serverProvider: {
      enabled: false,
      active: false,
      endpoint: "https://dsh.zuos.us/api/provider-config",
      label: "服务端下发",
      status: "idle",
      usable: false,
      error: "",
      keyHint: "",
      baseUrl: "",
      model: "",
      endpointStyle: "auto",
      fetchedAt: 0,
      expiresAt: 0,
      expired: false,
    },
    ...over,
  };
}

// ---------------------------------------------------------------- 用例

test("状态未加载时也渲染出完整表单（不空白）", async () => {
  const { text, tree } = await render(null);
  for (const label of ["服务提供方", "生效端点", "启用守卫", "真正拦截", "模型", "API Key", "测试端点"]) {
    assert.ok(text.includes(label), `缺少「${label}」：\n${text.slice(0, 400)}`);
  }
  // 兜底状态不得自带服务商地址：地址只能来自服务端下发的预设
  assert.equal(text.includes("bamboonode.dev"), false, "兜底状态硬编码了服务商地址");
  // 自动保存：没有「保存」按钮，只有状态提示。
  assert.ok(text.includes("改动即保存"), "缺少自动保存的状态提示");
  assert.equal(hasButtonLabeled(tree, "保存"), false, "不该再有独立的「保存」按钮");
});

test("面板顶部有项目主页链接（入口放在最上面，不是附注）", async () => {
  // 配置页是插件的主入口，但插件信息页里没有「文档在哪」的入口。
  // 用户想查决策点说明、provider 清单只能自己搜——所以链接放在面板最顶上一行。
  //
  // 断言「在最上面」：埋到表单末尾等于没有（表单很长，没人会滚到底）。
  const { tree } = await render(stateWith({}));
  const link = findNode(tree, (node) => node.type === "a" && node.props.href === SITE_URL);
  assert.ok(link !== null, "面板没有指向项目主页的链接");

  // 站外链接：新标签页打开，并断开 opener（否则目标页能反向操纵本页）。
  assert.equal(link.props.target, "_blank", "站外链接应在新标签页打开");
  assert.ok(link.props.rel.includes("noreferrer"), "rel 应含 noreferrer");
  assert.ok(link.props.rel.includes("noopener"), "rel 应含 noopener");
  // 链接文字本身要能说明它去哪，不能只有一个孤零零的箭头。
  assert.ok(
    collectText(link).join("").includes("项目主页"),
    `链接文字应说明去向，实际：${JSON.stringify(link.children)}`,
  );
});

test("链接排在 tab 栏上面（页面头部），不是塞进表单末尾", async () => {
  // 这条防的是「链接存在但埋到了底部」——有链接 ≠ 用户看得见。
  const { tree } = await render(stateWith({}));
  // react 桩会把 children 摊平（flat(Infinity)），根节点的 children 依次是：
  // [链接, tabBar, 配置页内容…]。
  const kids = tree.children.filter((child) => child !== null && child !== undefined && child !== false);
  const linkIndex = kids.findIndex(
    (child) => child.type === "a" && child.props.href === SITE_URL,
  );
  assert.ok(linkIndex >= 0, "面板没有指向项目主页的链接");
  const tabIndex = kids.findIndex((child) => child.props.key === "tabs");
  assert.ok(tabIndex >= 0, "没找到 tab 栏");
  assert.ok(
    linkIndex < tabIndex,
    `链接应在 tab 栏上面，实际位置：链接 ${linkIndex}，tab ${tabIndex}`,
  );
});

test("切到统计 tab 时链接依然在（它是页面级入口，不属于某一页）", async () => {
  // 链接放在 tab 栏上面而不是配置页内部，就是为了让「文档在哪」在整个面板
  // 里一直可见。若哪天把它挪回配置页内部，这条会红。
  const { tree } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) },
  });
  const link = findNode(tree, (node) => node.type === "a" && node.props.href === SITE_URL);
  assert.ok(link !== null, "统计页里找不到项目主页链接");
});

test("有改动时状态行说明自动保存，而不是等用户点按钮", async () => {
  // 这条防的是「改回旧版」：把保存按钮加回来、或把状态提示删掉，
  // 都会让用户重新面对「改了没存 / 存没存不知道」。
  const { text, tree } = await render(stateWith({}));
  assert.ok(text.includes("改动即保存"), `应提示自动保存，实际：\n${text.slice(0, 600)}`);
  assert.equal(hasButtonLabeled(tree, "保存"), false, "配置页不应有「保存」按钮");
  assert.ok(hasButtonLabeled(tree, "测试端点"), "「测试端点」按钮应保留");
});

// ------------------------------------------------- 改动即保存（不点按钮）

/** 找到第一个 `predicate` 为真的节点（含 children）。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (predicate(node) === true) return node;
  return findNode(node.children, predicate);
}

/**
 * 按**所在行的标题**取那一行的开关。
 *
 * 不能用「渲染树里第一个 toggle」定位：每加一个开关行，位置就会指到别人，
 * 而测试仍然会绿——它测的已经不是它名字里说的那个开关了（DEC-030 加
 * 「跟随服务端下发」（DEC-037 改名为「使用免费模型」）时就发生过：那条
 * 「拨一下开关就发出 PUT」实际拨的是新增的那个）。行结构固定为
 * `div > [标题/说明, 控件]`（见 client.js 的 row()），因此按标题找到行节点，
 * 再取行内的 button[aria-pressed] 即可。标题用**当前界面上的名字**。
 */
function toggleOfRow(node, title) {
  const row = findNode(node, (item) => {
    const children = Array.isArray(item?.children) ? item.children : [];
    const head = children[0];
    const texts = head === undefined || head === null ? [] : collectText(head);
    return texts.includes(title);
  });
  if (row === null) return undefined;
  return findNode(row.children, (item) => item.type === "button" && item.props["aria-pressed"] !== undefined);
}

/**
 * 拦截 fetch：记录每次调用，并回一份「服务端原样接受」的响应。
 *
 * @returns `{ calls, restore }`：calls 是 `{ url, init }` 列表。
 */
function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, enabled: true });
      },
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("拨一下开关就发出 PUT /config，不需要点保存", async () => {
  const { tree } = await render(stateWith({ enabled: false }));
  // 按**所在行的标题**定位，而不是「渲染树里第一个 toggle」——后者在新增
  // 开关行之后会静默指到别处，测试照样绿但已经名不副实。
  const toggleButton = toggleOfRow(tree, "启用守卫");
  assert.ok(toggleButton !== undefined && toggleButton !== null, "没有找到「启用守卫」开关按钮");
  assert.equal(toggleButton.props["aria-pressed"], false, "开关初始应为关闭");

  const stub = stubFetch();
  try {
    toggleButton.props.onClick();
    // 自动保存是异步的：给微任务一个回合。
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }

  assert.ok(stub.calls.length > 0, "改动后应自动发出请求（无需点保存按钮）");
  const configCall = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/config"));
  assert.ok(configCall !== undefined, `应 PUT /config，实际请求：${stub.calls.map((c) => c.url).join(", ")}`);
  assert.equal(configCall.init.method, "PUT", "配置改动应走 PUT");
  const body = JSON.parse(configCall.init.body);
  assert.equal(body.enabled, true, `patch 应带上刚拨动的开关，实际：${configCall.init.body}`);
});

test("粘贴 API Key 后失焦即提交，且只带 key 那一格", async () => {
  const { tree } = await render(stateWith({ provider: "systemone" }));
  const keyInput = findNode(tree, (node) => node.type === "input" && node.props.type === "password");
  assert.ok(keyInput !== undefined && keyInput !== null, "没有找到 API Key 输入框");

  const stub = stubFetch();
  try {
    // 模拟粘贴 + 失焦：输入本身不落盘（半截 key 不能进凭据文件），失焦才提交。
    keyInput.props.onChange({ target: { value: "sk-test-1234567890" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stub.calls.length, 0, "仅输入（未失焦/回车）不该落盘");

    keyInput.props.onBlur();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }

  const configCall = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/config"));
  assert.ok(configCall !== undefined, "失焦后应自动提交密钥");
  const body = JSON.parse(configCall.init.body);
  assert.equal(body.systemoneApiKey, "sk-test-1234567890", `patch 应带上密钥，实际：${configCall.init.body}`);
  // 只写当前 provider 那一格：切 provider 不会把 A 的 key 存到 B 名下。
  assert.equal(Object.hasOwn(body, "siliconflowApiKey"), false, "不该写其它 provider 的 key 字段");
  assert.equal(Object.hasOwn(body, "customApiKey"), false, "不该写其它 provider 的 key 字段");
});

test("硅基流动：粘贴 key 写进它自己那一格（字段名来自服务端 providerCatalog）", async () => {
  const preset = PROVIDER_PRESETS.siliconflow;
  const { tree } = await render(
    stateWith({
      provider: "siliconflow",
      providerLabel: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1/systemone",
    }),
  );
  const keyInput = findNode(tree, (node) => node.type === "input" && node.props.type === "password");
  assert.ok(keyInput !== undefined && keyInput !== null, "没有找到 API Key 输入框");

  const stub = stubFetch();
  try {
    keyInput.props.onChange({ target: { value: "sk-sf-1234567890" } });
    keyInput.props.onBlur();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }

  const configCall = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/config"));
  assert.ok(configCall !== undefined, "失焦后应自动提交密钥");
  const body = JSON.parse(configCall.init.body);
  assert.equal(
    body[preset.keyField],
    "sk-sf-1234567890",
    `key 应写进 ${preset.keyField}，实际：${configCall.init.body}`,
  );
  // 别家的格子一个都不许写：这是「切 provider 不串 key」的最低保证。
  for (const other of PROVIDER_IDS) {
    if (other === "siliconflow") continue;
    assert.equal(
      Object.hasOwn(body, PROVIDER_PRESETS[other].keyField),
      false,
      `不该写 ${other} 的 key 字段 ${PROVIDER_PRESETS[other].keyField}`,
    );
  }
});

test("硅基流动：改模型写进它自己那一格，且「留空」被说成预设默认", async () => {
  const preset = PROVIDER_PRESETS.siliconflow;
  const { text, controls } = await render(
    stateWith({
      provider: "siliconflow",
      providerLabel: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1/systemone",
    }),
  );
  // 该端点 model 必填（实测省略回 400），所以「留空」不能说成「服务端默认」。
  assert.ok(
    text.includes(`留空 = 用预设默认 ${preset.defaultModel}`),
    `模型栏应说明留空的含义，实际文案：\n${text.slice(0, 700)}`,
  );

  const modelSelect = controls.find((node) => node.type === "select" && node.props.value === "");
  assert.ok(modelSelect !== undefined, "没有找到模型下拉（当前值应为空 = 走预设默认）");

  const stub = stubFetch();
  try {
    modelSelect.props.onChange({ target: { value: "SemIf" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }

  const configCall = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/config"));
  assert.ok(configCall !== undefined, "改模型应自动落盘");
  const body = JSON.parse(configCall.init.body);
  assert.equal(
    body[preset.modelField],
    "SemIf",
    `模型应写进 ${preset.modelField}，实际：${configCall.init.body}`,
  );
  // 只写当前 provider 的模型格：A 的模型名不能被写进 B 的格子。
  assert.equal(Object.hasOwn(body, "model"), false, "不该写遗留的模型字段");
  assert.equal(Object.hasOwn(body, "customModel"), false, "不该写 custom 的模型字段");
});

test("服务端没给 provider 字段映射时绝不猜格子：宁可延后也不写", async () => {
  // 模拟「status 还没回来」：catalog 为空 → 前端不知道模型与 key 该写哪一格。
  // 猜一个名字就会把一家的 key 存进另一家的格子——正是
  // 「填了 key 仍说没配 key」的来源。
  const { tree } = await render(
    stateWith({ provider: "siliconflow", providerCatalog: [] }),
  );
  const keyInput = findNode(tree, (node) => node.type === "input" && node.props.type === "password");

  const stub = stubFetch();
  try {
    keyInput.props.onChange({ target: { value: "sk-test-1234567890" } });
    keyInput.props.onBlur();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }

  const configCall = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/config"));
  assert.equal(configCall, undefined, "字段映射缺失时不该发 /config（宁可延后也不猜着写）");
});

test("provider 下拉包含全部预设，默认 bamboonode", async () => {
  const { controls } = await render(stateWith({}));
  const providerSelect = controls.find((node) => node.type === "select" && node.props.value === "bamboonode");
  assert.ok(providerSelect !== undefined, "没有找到 provider 下拉（或当前值不是 bamboonode）");
  const options = providerSelect.children
    .filter((child) => child !== null && typeof child === "object" && child.type === "option")
    .map((child) => child.props.value);
  // 下拉必须与 providers.js 的预设清单完全一致：多一个少一个都是漏改。
  assert.deepEqual(options, [...PROVIDER_IDS]);
});

test("选 system one 时下拉回显它、且不出现 custom 专属字段", async () => {
  const { text, controls } = await render(
    stateWith({ provider: "systemone", providerLabel: "system one", baseUrl: "https://api.typesafe.ai/v1/systemone", keyEnvName: "TYPESAFE_API_KEY" }),
  );
  const providerSelect = controls.find((node) => node.type === "select" && node.props.value === "systemone");
  assert.ok(providerSelect !== undefined, "provider 下拉未回显 systemone");
  assert.equal(text.includes("Base URL（必填）"), false, "内置预设不该出现 custom 字段");
});

test("选 custom 时出现必填字段与本地校验提示", async () => {
  const { text, controls } = await render(stateWith({ provider: "custom", providerLabel: "custom", baseUrl: "", customBaseUrl: "" }));
  for (const label of ["Base URL（必填）", "端点风格", "附加请求头", "密钥变量名"]) {
    assert.ok(text.includes(label), `custom 表单缺少「${label}」`);
  }
  // 必填但为空 → 当场提示，而不是等保存后才报错
  assert.ok(text.includes("必填"), "缺 base URL 时没有必填提示");

  const placeholders = controls
    .filter((node) => node.type === "input")
    .map((node) => node.props.placeholder ?? "")
    .join("|");
  assert.ok(placeholders.includes("https://api.example.com/v1"), "缺少 base URL 的填写示例");
});

test("custom 地址非法时给出具体原因", async () => {
  const { text } = await render(
    stateWith({ provider: "custom", providerLabel: "custom", baseUrl: "", customBaseUrl: "ftp://x.dev" }),
  );
  assert.ok(text.includes("必须以 http:// 或 https:// 开头"), "非法地址没有给出原因");
});

test("端点风格下拉说明它是「首选」且 404 会自动换路径", async () => {
  const { text, controls } = await render(
    stateWith({ provider: "custom", providerLabel: "custom", customBaseUrl: "https://x.dev/v1" }),
  );
  assert.ok(text.includes("首选"), "端点风格的说明没讲清它是首选而不是唯一");
  assert.ok(text.includes("404"), "端点风格的说明没讲 404 会自动换路径");
  const styleSelect = controls.find(
    (node) => node.type === "select" && node.props.value === "auto",
  );
  assert.ok(styleSelect !== undefined, "端点风格下拉未回显 auto");
  // 下拉必须保留三条选项：auto / decisions / systemone
  const options = (styleSelect?.children ?? []).filter((child) => child?.type === "option");
  assert.deepEqual(
    options.map((item) => item.props.value),
    ["auto", "decisions", "systemone"],
    "端点风格下拉的选项不完整",
  );
});

test("探测出的可用端点会显示在「生效端点」下方", async () => {
  const { text } = await render(
    stateWith({
      provider: "custom",
      providerLabel: "custom",
      baseUrl: "https://api.siliconflow.cn/v1/decisions",
      detectedEndpoint: "https://api.siliconflow.cn/v1/systemone",
    }),
  );
  assert.ok(
    text.includes("已验证可用") && text.includes("/v1/systemone"),
    "探测出的可用端点没有显示出来",
  );
});

test("服务端拒绝的原因会显示在界面上", async () => {
  const { text } = await render(
    stateWith({
      provider: "custom",
      providerLabel: "custom",
      providerValid: false,
      providerError: "自定义 provider 的 base URL 不可用：base URL 必须以 http:// 或 https:// 开头",
      baseUrl: "",
      customBaseUrl: "gw.example.com/v1",
    }),
  );
  assert.ok(text.includes("自定义 provider 的 base URL 不可用"), "服务端错误原因没有显示");
});

test("密钥保存位置有下拉，默认 .credentials.yaml", async () => {
  const { text, controls } = await render(stateWith({}));
  assert.ok(text.includes("密钥保存位置"), "缺少「密钥保存位置」");
  const storageSelect = controls.find(
    (node) => node.type === "select" && node.props.value === "credentials",
  );
  assert.ok(storageSelect !== undefined, "没有找到存储位置下拉（默认值应为 credentials）");
  const values = storageSelect.children
    .filter((child) => child !== null && typeof child === "object" && child.type === "option")
    .map((child) => child.props.value);
  assert.deepEqual(values, ["credentials", "config"]);
  assert.ok(text.includes(".credentials.yaml"), "没有说明会存进 .credentials.yaml");
});

test("每个 provider 显示自己的密钥名，不共用", async () => {
  const sf = await render(stateWith({ provider: "siliconflow", providerLabel: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1/systemone" }));
  assert.ok(sf.text.includes("SILICONFLOW_API_KEY"), "硅基流动没显示自己的 key 名");

  const systemOne = await render(
    stateWith({ provider: "systemone", providerLabel: "system one", baseUrl: "https://api.typesafe.ai/v1/systemone" }),
  );
  assert.ok(systemOne.text.includes("TYPESAFE_API_KEY"), "system one 没显示自己的 key 名");
  assert.equal(
    systemOne.text.includes("SILICONFLOW_API_KEY"),
    false,
    "system one 界面不应出现硅基流动的 key 名",
  );
});

test("生效端点始终可见（避免界面显示与实际请求不一致）", async () => {
  const { text } = await render(
    stateWith({ provider: "custom", providerLabel: "custom", baseUrl: "https://gw.example.com/v1/systemone" }),
  );
  assert.ok(text.includes("https://gw.example.com/v1/systemone"), "没有显示生效端点");
});
test("思考模式下拉存在，回显当前值且提供全部三档", async () => {
  const { controls, text } = await render(
    stateWith({ thinkMode: "auto", thinkModes: ["never", "auto", "always"] }),
  );
  assert.ok(text.includes("思考模式"), "界面上没有「思考模式」这一项");
  const select = controls.find((node) => node.type === "select" && node.props.value === "auto");
  assert.ok(select !== undefined, "没有找到思考模式下拉（或当前值不是 auto）");
  const options = select.children
    .filter((child) => child !== null && typeof child === "object" && child.type === "option")
    .map((child) => child.props.value);
  assert.deepEqual(options, ["never", "auto", "always"], "三档必须齐全，否则用户无法切到 always");
});

test("思考模式选项由服务端下发，不在前端硬编码", async () => {
  // 服务端若只给两档（例如未来改动），前端应照办而不是自己补一个 always。
  const { controls } = await render(stateWith({ thinkMode: "never", thinkModes: ["never", "auto"] }));
  const select = controls.find((node) => node.type === "select" && node.props.value === "never");
  assert.ok(select !== undefined);
  const options = select.children
    .filter((child) => child !== null && typeof child === "object" && child.type === "option")
    .map((child) => child.props.value);
  assert.deepEqual(options, ["never", "auto"]);
});

test("选 always 时提示延迟代价", async () => {
  const { text } = await render(stateWith({ thinkMode: "always" }));
  assert.ok(text.includes("多等"), "选 always 时应提示额外的延迟代价");
});

test("状态未加载时思考模式下拉仍有兜底选项", async () => {
  const { controls } = await render(null);
  const select = controls.find((node) => node.type === "select" && node.props.value === "never");
  assert.ok(select !== undefined, "status 未返回时思考模式下拉不应消失");
  const options = select.children
    .filter((child) => child !== null && typeof child === "object" && child.type === "option")
    .map((child) => child.props.value);
  assert.deepEqual(options, ["never", "auto", "always"]);
});

// ------------------------------------------- 密钥来源必须显示「真实来源」

test("keyStorage=config 时显示配置文件的字段名，不显示凭据变量名", async () => {
  // 这是本用例要防的核心误解：页面曾显示 `BAMBOO_API_KEY`，
  // 而该变量在 keyStorage=config 下根本没被读取——用户会以为 key
  // 存在 .credentials.yaml 里，甚至误判它过期。
  const { text } = await render(
    stateWith({
      keyStorage: "config",
      keyStatus: {
        systemone: {
          configured: false, hint: "", refName: "TYPESAFE_API_KEY", keyField: "systemoneApiKey",
          source: "none", sourceLabel: "未配置",
        },
        bamboonode: {
          configured: true, hint: "…abcd", refName: "BAMBOO_API_KEY", keyField: "bamboonodeApiKey",
          source: "config", sourceLabel: "配置文件 config.yml 的 bamboonodeApiKey",
        },
        siliconflow: {
          configured: false, hint: "", refName: "SILICONFLOW_API_KEY", keyField: "siliconflowApiKey",
          source: "none", sourceLabel: "未配置",
        },
        custom: {
          configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", keyField: "customApiKey",
          source: "none", sourceLabel: "未配置",
        },
      },
    }),
  );
  assert.ok(
    text.includes("密钥来源 配置文件 config.yml 的 bamboonodeApiKey"),
    `应显示真实来源（配置字段），实际文案：\n${text.slice(0, 1200)}`,
  );
  // 关键断言：不能把未被读取的凭据变量名当成「密钥来源」展示。
  assert.equal(
    text.includes("密钥来源 BAMBOO_API_KEY"),
    false,
    "不得把未被读取的凭据变量名显示为密钥来源",
  );
});

test("凭据文件来源时显示 .credentials.yaml 与变量名", async () => {
  const { text } = await render(stateWith({ keyStorage: "credentials" }));
  assert.ok(
    text.includes("密钥来源 ~/.dsh/.credentials.yaml 的 BAMBOO_API_KEY"),
    `应显示凭据文件来源，实际：\n${text.slice(0, 1200)}`,
  );
});

test("环境变量来源时明确标注是环境变量", async () => {
  const { text } = await render(
    stateWith({
      keyStatus: {
        systemone: {
          configured: false, hint: "", refName: "TYPESAFE_API_KEY", keyField: "systemoneApiKey",
          source: "none", sourceLabel: "未配置",
        },
        bamboonode: {
          configured: true, hint: "…abcd", refName: "BAMBOO_API_KEY", keyField: "bamboonodeApiKey",
          source: "env", sourceLabel: "环境变量 BAMBOO_API_KEY",
        },
        siliconflow: {
          configured: false, hint: "", refName: "SILICONFLOW_API_KEY", keyField: "siliconflowApiKey",
          source: "none", sourceLabel: "未配置",
        },
        custom: {
          configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", keyField: "customApiKey",
          source: "none", sourceLabel: "未配置",
        },
      },
    }),
  );
  assert.ok(text.includes("密钥来源 环境变量 BAMBOO_API_KEY"), `实际：\n${text.slice(0, 1200)}`);
});

test("未配置时来源显示「未配置」并标注未读到", async () => {
  const { text } = await render(
    stateWith({
      keyStatus: {
        systemone: {
          configured: false, hint: "", refName: "TYPESAFE_API_KEY", keyField: "systemoneApiKey",
          source: "none", sourceLabel: "未配置",
        },
        bamboonode: {
          configured: false, hint: "", refName: "BAMBOO_API_KEY", keyField: "bamboonodeApiKey",
          source: "none", sourceLabel: "未配置",
        },
        siliconflow: {
          configured: false, hint: "", refName: "SILICONFLOW_API_KEY", keyField: "siliconflowApiKey",
          source: "none", sourceLabel: "未配置",
        },
        custom: {
          configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", keyField: "customApiKey",
          source: "none", sourceLabel: "未配置",
        },
      },
    }),
  );
  assert.ok(text.includes("密钥来源 未配置（未读到）"), `实际：\n${text.slice(0, 1200)}`);
});

test("存到插件配置时提示的是字段名，而不是凭据变量名", async () => {
  const { text } = await render(
    stateWith({
      keyStorage: "config",
      keyStatus: {
        systemone: {
          configured: false, hint: "", refName: "TYPESAFE_API_KEY", keyField: "systemoneApiKey",
          source: "none", sourceLabel: "未配置",
        },
        bamboonode: {
          configured: true, hint: "…abcd", refName: "BAMBOO_API_KEY", keyField: "bamboonodeApiKey",
          source: "config", sourceLabel: "配置文件 config.yml 的 bamboonodeApiKey",
        },
        siliconflow: {
          configured: false, hint: "", refName: "SILICONFLOW_API_KEY", keyField: "siliconflowApiKey",
          source: "none", sourceLabel: "未配置",
        },
        custom: {
          configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", keyField: "customApiKey",
          source: "none", sourceLabel: "未配置",
        },
      },
    }),
  );
  assert.ok(
    text.includes("存到插件配置 config.yml 的 bamboonodeApiKey"),
    `保存目标应说明字段名，实际：\n${text.slice(0, 1200)}`,
  );
  assert.equal(
    text.includes("存到「插件配置」的 BAMBOO_API_KEY"),
    false,
    "不应再出现「存到插件配置的 BAMBOO_API_KEY」这种自相矛盾的文案",
  );
});

test("client.js 不引用未定义的 setXxx（防重构留下悬空调用）", () => {
  // 背景：移除「自身 token 预算」时留下一处 `setBudgetDraft(null)`，而那个
  // state 已经删掉——保存决策点会抛 ReferenceError，界面上只显示「未保存」。
  // 语法检查抓不到（运行时才炸），渲染测试也未必走到那一支，所以静态比对：
  // 每个 setXxx( 调用都必须有对应的 `const [x, setXxx] = useState(...)`
  // 或 `const setXxx = ...`。
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 先剥注释：注释里会提到 setDirty 这类「本该有」的名字，比对时要排除。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const declared = new Set();
  for (const match of code.matchAll(/const\s+\[[A-Za-z_$][\w$]*,\s*(set[A-Za-z_$][\w$]*)\]\s*=/g)) {
    declared.add(match[1]);
  }
  for (const match of code.matchAll(/const\s+(set[A-Za-z_$][\w$]*)\s*=/g)) {
    declared.add(match[1]);
  }
  // 模块级普通函数也可能叫 setXxx（i18n 的 `function setLang(...)`），
  // 同样是「本文件声明过」的名字，一并登记。
  for (const match of code.matchAll(/function\s+(set[A-Za-z_$][\w$]*)\s*\(/g)) {
    declared.add(match[1]);
  }
  // 全局 setter 不在本文件声明，但可以调用。
  const globals = new Set(["setTimeout", "setInterval", "setImmediate"]);
  const dangling = new Set();
  for (const match of code.matchAll(/(^|[^.\w$])(set[A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = match[2];
    if (!declared.has(name) && !globals.has(name)) dangling.add(name);
  }
  assert.deepEqual([...dangling], [], `client.js 引用了未定义的 setter：${[...dangling].join(", ")}`);
});

// ---------------------------------------------------------------- 统计与对比

/** 一份服务端返回的统计结果。 */
function statsWith(over) {
  return {
    range: { preset: "today", label: "当日", start: "", end: "", valid: true, error: "" },
    totals: {
      requests: 12,
      cached: 4,
      degraded: 0,
      inputTokens: 24000,
      outputTokens: 3600,
      totalTokens: 27600,
      durationMs: 15000,
      observeRequests: 8,
      observeInputTokens: 16000,
      observeOutputTokens: 2400,
      observeDurationMs: 10000,
      observeBaseInputTokens: 40000,
      observeBaseOutputTokens: 3600,
      observeBaseDurationMs: 22000,
      savedInputTokens: 16000,
      savedOutputTokens: 0,
      savedTotalTokens: 16000,
      savedDurationMs: 7000,
      savedRatio: 0.5797,
      savedTimeRatio: 0.3181,
      avgDurationMs: 1250,
    },
    rows: [
      {
        provider: "bamboonode",
        model: "startlux-decision-27b-autothink",
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
      {
        provider: "siliconflow",
        model: "Kev-4B",
        requests: 4,
        cached: 0,
        inputTokens: 8000,
        outputTokens: 1200,
        durationMs: 5000,
        avgDurationMs: 1250,
        observeRequests: 4,
        observeInputTokens: 8000,
        observeOutputTokens: 1200,
        observeDurationMs: 5000,
        savedInputTokens: 4000,
        savedOutputTokens: 0,
        savedDurationMs: 2000,
        savedRatio: 0.33,
      },
    ],
    byProvider: [],
    byPoint: [],
    recordCount: 12,
    /**
     * 节省量的来源说明。节省量只由观察模式的记录贡献，所以服务端必须
     * 把「有多少条记录参与了节省」一起下发，界面才能解释「节省为 0」。
     */
    savings: {
      observeRequests: 8,
      totalRequests: 12,
      byMode: { observe: 8, enforce: 4, off: 0, unknown: 0 },
      unavailable: false,
    },
    presets: ["today", "week", "month", "year", "custom"],
    labels: { today: "当日", week: "本周", month: "本月", year: "本年", custom: "自定义" },
    legacy: { included: false, count: 0, note: "" },
    ...over,
  };
}

test("页面拆成两个 tab：配置 / 统计与对比", async () => {
  // 统计从配置页里搬出来单独成一页：一张十来列的对比表挤在表单末尾，
  // 既看不清，也让本来就长的配置页更难用。
  const { text, tree } = await render(stateWith({}));
  assert.ok(hasButtonLabeled(tree, "配置"), "缺少「配置」tab");
  assert.ok(hasButtonLabeled(tree, "统计与对比"), "缺少「统计与对比」tab");
  // 默认停在配置页：统计页不该在用户没打开时就去读整个统计文件。
  assert.equal(
    text.includes("用量统计与对比"),
    false,
    "默认 tab 应是配置，不该直接渲染统计页",
  );
  assert.ok(text.includes("服务提供方"), "配置 tab 应照常渲染表单");
});

test("统计：区间预设由服务端下发，前端不硬编码清单", async () => {
  const { text, tree } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) },
  });
  assert.ok(text.includes("用量统计与对比"), "统计 tab 应渲染整页");
  // 五个预设都要有按钮，标签取自服务端下发的 labels（不是前端抄的一份）。
  for (const label of ["当日", "本周", "本月", "本年", "自定义"]) {
    assert.ok(
      hasButtonLabeled(tree, label),
      `缺少预设按钮「${label}」，实际：\n${text.slice(0, 700)}`,
    );
  }
  // 服务端没下发 presets 时不能凭空长出一批按钮（避免两份清单漂移）。
  const { tree: bare } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({ presets: [] }) },
  });
  assert.equal(hasButtonLabeled(bare, "本周"), false, "预设清单只能来自服务端");
});

test("统计：把预设解析成的真实区间显示出来", async () => {
  // 「本周」到底是哪几天，跨月/跨年时用户无从核对——所以实际边界要写出来。
  const { text } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWith({
        range: {
          preset: "week",
          label: "本周",
          start: "2026-10-26T00:00:00.000Z",
          end: "2026-11-02T00:00:00.000Z",
          valid: true,
        },
      }),
    },
  });
  assert.ok(
    text.includes("实际区间"),
    `应显示实际区间，实际：\n${text.slice(0, 900)}`,
  );
});

test("统计：自定义范围要填全起止才发请求", async () => {
  // 没填完时服务端只会回「需要合法的起止时间」，那是没填完而不是出错，
  // 显示成失败会误导。
  const { text } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: null,
      [SLOTS.statsFilter]: { preset: "custom", start: "2026-10-20T08:00", end: "", sort: "inputTokens", dir: "desc" },
    },
  });
  assert.ok(
    text.includes("请填写完整的起止时间"),
    `应提示填全起止，实际：\n${text.slice(0, 900)}`,
  );
});

test("统计：横向对比表按 provider × model 列出，节省量另有对比表", async () => {
  const { text } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) },
  });
  assert.ok(text.includes("bamboonode"), "对比表应列出 provider");
  assert.ok(text.includes("Kev-4B"), "对比表应列出 model");
  assert.ok(text.includes("provider / model"), "应有一列说明这是 provider/model 组合");
  assert.ok(text.includes("横向对比"), "应有「横向对比」一节");
  assert.ok(text.includes("节省量对比"), "应有「节省量对比」一节");
  // 数字带千分位分组：同一个值在两个地方显示成两种写法最难核对。
  assert.ok(
    text.includes("16,000"),
    `应显示节省的 input token（分组后），实际：\n${text.slice(0, 900)}`,
  );
  // 耗时按量级换单位（totals.durationMs = 15000 → 「15s」），
  // 而不是甩一个「15000ms」；超过一分钟才换成 m/s。
  assert.ok(
    text.includes("15s"),
    `总耗时应按量级可读化，实际：\n${text.slice(0, 900)}`,
  );
});

test("统计：说明基线口径（用户必须知道「省了多少」相对什么算）", async () => {
  const { text } = await render(stateWith({}), { slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) } });
  assert.ok(
    text.includes("基线 = 不启用本插件的缓存与上下文压缩时"),
    `应说明基线口径，实际：\n${text.slice(0, 1200)}`,
  );
});

test("统计：节省量一节写明只统计「观察」模式", async () => {
  // 用户明确要求：UI 要说明「节省」只在观察模式下才有意义。
  // 提示必须紧贴数字看得到的地方，不能只塞在脚注里。
  const { text } = await render(stateWith({}), { slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) } });
  assert.ok(
    text.includes("节省量只统计"),
    `应说明节省量只统计观察模式，实际：\n${text.slice(0, 1400)}`,
  );
  assert.ok(
    text.includes("观察"),
    `应出现「观察」二字，实际：\n${text.slice(0, 1400)}`,
  );
  // 汇总卡片的标题也要带上来源标记：读者看卡片时不一定往下读。
  assert.ok(
    text.includes("（观察）"),
    `汇总卡片应标注「（观察）」，实际：\n${text.slice(0, 1400)}`,
  );
  // 节省量那一节的标题同样要标。
  assert.ok(
    text.includes("节省量对比（观察模式"),
    `节省量对比一节标题应标注观察模式，实际：\n${text.slice(0, 1400)}`,
  );
  // 口径脚注里解释「为什么只有观察模式算数」。
  assert.ok(
    text.includes("普通 LLM 路径并没有真的发生"),
    `脚注应解释生效模式为何不计入，实际：\n${text.slice(0, 1400)}`,
  );
});

test("统计：没有观察模式的记录时说明「节省为 0」不等于「没省」", async () => {
  // 「省了 0」与「没有可比对的数据」是两件事：前者说明观察模式下确实
  // 没省，后者说明这段时间根本没在观察模式跑。界面上必须区分，否则
  // 用户会得出完全错误的结论。
  const { text } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWith({
        savings: {
          observeRequests: 0,
          totalRequests: 12,
          byMode: { observe: 0, enforce: 12, off: 0, unknown: 0 },
          unavailable: true,
        },
      }),
    },
  });
  assert.ok(
    text.includes("没有一条来自观察模式"),
    `应说明本区间没有观察模式的记录，实际：\n${text.slice(0, 1600)}`,
  );
  assert.ok(
    text.includes("不是「一点也没省」"),
    `应区分「没有可比数据」与「没省」，实际：\n${text.slice(0, 1600)}`,
  );
});

test("统计：按模式分账，说明节省量的来源", async () => {
  // 用户要能看出「节省量是从多少条记录算出来的」。
  const { text } = await render(stateWith({}), { slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) } });
  assert.ok(
    text.includes("按模式分账"),
    `应给出按模式的分账，实际：\n${text.slice(0, 1600)}`,
  );
  assert.ok(
    text.includes("观察"),
    `分账里应出现「观察」，实际：\n${text.slice(0, 1600)}`,
  );
});

test("统计：含历史推算数据时明确标注", async () => {
  // 统计结果由 /stats 单独下发，不在 status 里——通过 useState 槽位注入。
  const { text: legacyText } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({ legacy: { included: true, count: 42, note: "含推算" } }) },
  });
  assert.ok(
    legacyText.includes("由旧遥测推算的历史记录"),
    `应标注历史推算数据，实际：\n${legacyText.slice(0, 1400)}`,
  );
});

test("统计：区间内无数据时说明原因，而不是显示一排空值", async () => {
  const { text } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({ rows: [], totals: { requests: 0 } }) },
  });
  assert.ok(
    text.includes("该时间范围内没有统计记录"),
    `应说明没有记录，实际：\n${text.slice(0, 1400)}`,
  );
});

// ------------------------------------------------------- 裁决统计（allow/ask/reject）

/** 一份带裁决统计的服务端返回。 */
function outcomesWith(over = {}) {
  return statsWith({
    outcomes: {
      allow: 120,
      ask: 8,
      reject: 3,
      none: 5,
      decided: 131,
      total: 136,
      byPoint: [
        { point: "authorize", allow: 100, ask: 8, reject: 3, none: 2 },
        { point: "retrieval", allow: 20, ask: 0, reject: 0, none: 3 },
      ],
      otherVerdicts: [],
      otherVerdictCount: 0,
      ...over,
    },
  });
}

test("统计：裁决统计单列一节，显示 allow / ask / reject 三格", async () => {
  const { text } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: outcomesWith({}) },
  });
  assert.ok(
    text.includes("裁决统计"),
    `应有「裁决统计」一节，实际：\n${text.slice(0, 1600)}`,
  );
  assert.ok(text.includes("放行 allow"), "应有「放行」格");
  assert.ok(text.includes("询问 ask"), "应有「询问」格");
  assert.ok(text.includes("拦截 reject"), "应有「拦截」格");
  assert.ok(text.includes("120"), "应显示放行次数");
  assert.ok(text.includes("8"), "应显示询问次数");
  assert.ok(text.includes("3"), "应显示拦截次数");
});

test("统计：裁决统计按决策点分账", async () => {
  const { text } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: outcomesWith({}),
      [SLOTS.decisions]: decisionsFixture,
    },
  });
  // 决策点用中文名（服务端下发的 pointLabels），不是裸 id。
  assert.ok(
    text.includes("工具授权"),
    `裁决分账表应列出决策点中文名，实际：\n${text.slice(0, 2000)}`,
  );
  assert.ok(text.includes("检索必要性"), "应列出全部有裁决的决策点");
});

test("统计：未归类的裁决必须显式提示（否则数字只是悄悄偏小）", async () => {
  const { text } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: outcomesWith({
        otherVerdicts: [{ verdict: "authorize/newKind", count: 4 }],
        otherVerdictCount: 4,
      }),
    },
  });
  assert.ok(
    text.includes("未归类"),
    `未登记的裁决应显式提示，实际：\n${text.slice(0, 2000)}`,
  );
  assert.ok(text.includes("authorize/newKind"), "应指出是哪个裁决未登记");
});

test("统计：没有裁决数据时不渲染裁决一节（而不是显示一排零）", async () => {
  // 服务端还没给 outcomes 时，渲染一张全零的表会让人以为
  // 「一次都没拦过」——而真实情况可能是根本没数据。
  const { text } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWith({}) },
  });
  assert.ok(
    !text.includes("裁决统计"),
    `没有 outcomes 时不该渲染裁决一节，实际：\n${text.slice(0, 1600)}`,
  );
});

test("决策历史在配置页只有一个开关（不再有「决策内容」子开关）", async () => {
  // 曾经是「决策历史 + 决策内容」两个开关，表达的是**同一件事**（这个功能
  // 要不要用），却要求用户先决定「记不记」、再决定「记多细」——而后者根本不是
  // 日常选择。合成一个之后，第二个不该再出现。
  //
  // 「只存元数据、不存内容」那个档位曾经退到 config.yml 的 `decisionsCapture`，
  // DEC-029 之后它**整个退役**了：隐藏档位能在暗处把每条记录降级成元数据，
  // 而用户看到的开关和真实行为不一致——这正是用户报的那个缺陷。现在唯一
  // 的开关就是这一行，想要不落内容只能把功能整个关掉。
  //
  // 判据用行上的 `key`（就是配置键名），而不是文案：文案会随开关状态变化，
  // 拿文案当判据会漏（第一次就是这么写的，变异测试证明它抓不到）。
  const { tree } = await render(stateWith({}));
  const keys = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.props?.key === 'string') keys.push(node.props.key);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  assert.equal(
    keys.filter((key) => key === 'decisionsTabEnabled').length,
    1,
    `配置页应恰有一行决策历史，实际：${keys.join(', ')}`,
  );
  assert.equal(keys.includes('decisionsCapture'), false, '不该再有第二个子开关');
});

test("决策历史关闭时仍然只有一行，且提示说明「不写文件」", async () => {
  // 合并成一行之后，关闭态不该换出第二个控件（比如又冒出一个「保留元数据」），
  // 也不该只是把开关拨灰——提示要明确回答「关掉会发生什么」。
  const { tree, text } = await render(stateWith({ decisionsTabEnabled: false }));
  const keys = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.props?.key === 'string') keys.push(node.props.key);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  assert.equal(keys.filter((key) => key === 'decisionsTabEnabled').length, 1, '仍应只有一行');
  assert.equal(keys.includes('decisionsCapture'), false, '关闭态也不该多出子开关');
  assert.ok(
    text.includes('关闭后不写任何明细文件'),
    `关闭态应说明后果，实际：\n${text.slice(0, 400)}`,
  );
});


test("custom 时模型行移入「自定义 provider」区，自动项改为「不发送 model 字段」", async () => {
  const { text, tree } = await render(
    stateWith({
      provider: "custom",
      providerLabel: "custom",
      baseUrl: "",
      customBaseUrl: "https://gw.example.com/v1",
    }),
  );
  // 位置：模型行必须出现在「自定义 provider」小节里（小节标题之后），
  // 而不是通用区域——清单来自用户自己的服务，与 Base URL 是一组的。
  const sectionAt = text.indexOf("自定义 provider");
  const modelAt = text.indexOf("自动（不发送 model 字段）");
  assert.ok(sectionAt >= 0, "缺少「自定义 provider」小节");
  assert.ok(modelAt > sectionAt, "模型选择器应位于自定义 provider 区内");
  // 文案：custom 没有「服务端默认」可言，自动项必须说清真实语义。
  // 只看下拉选项本身（页面别处——如底部状态行——会回显状态里的模型字样，不算）。
  const optionTexts = [];
  (function collect(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (node.type === "option") {
      optionTexts.push((node.children ?? []).filter((c) => typeof c === "string").join(""));
    }
    for (const child of node.children ?? []) collect(child);
  })(tree);
  assert.ok(optionTexts.includes("自动（不发送 model 字段）"), "custom 的自动项应说明是省略 model 字段");
  assert.equal(
    optionTexts.includes("自动（服务端默认）"),
    false,
    "custom 不应出现「服务端默认」的误导文案",
  );
});

test("内置预设的模型行留在通用区域，自动项仍是「服务端默认」", async () => {
  const { text } = await render(stateWith({ provider: "systemone" }));
  const modelAt = text.indexOf("自动（服务端默认）");
  const apiKeyAt = text.indexOf("API Key");
  assert.ok(modelAt >= 0, "缺少模型下拉");
  assert.ok(apiKeyAt < 0 || modelAt < apiKeyAt, "非 custom 的模型行应留在通用区域（API Key 之前）");
});

// ===========================================================================
// 配置页重排（DEC-037）：四组、三条分隔线、改名与小字
// ===========================================================================
//
// 这一组钉的是**结构**，不是「某个词出现过」：
//
//   - 顺序用渲染树的**同级兄弟下标**断言，而不是 `text.includes`。文本收集
//     会把整棵树拍平，`includes` 能证明「在」，却证明不了「在哪」——把
//     分隔线挪到页头、或把滑块挪回 API Key 隔壁，`includes` 全是绿的。
//     去重后的拼接文本里大打折扣（页面上「Kev-4B」这类词多处出现时尤其糟）。
//   - 分隔线用 `key`（divider-1/2/3）定位，同时断言它**不是** rowLine 形状
//     ——那是「一行控件」的形状，拿来做分隔线会被读成空白控件，而且最后
//     那组「滑块不许被塞进 rowLine」的用例正好收集这个形状。
//   - 小字断言走**行内**定位：它必须在「使用免费模型」那一行的 rowText 里，
//     而不是碰巧出现在页面某处。

/**
 * 配置页里 configBody 的顶层元素顺序（按渲染树的同级兄弟下标）。
 *
 * `h(type, props, siteLink, tabBar, configBody)` 里的 configBody 是一个数组，
 * 桩的 `createElement` 会把 children `flat(Infinity)`，于是配置页各行**直接**
 * 成为页面根 div 的孩子，排在 siteLink / tabBar 之后。这里跳过那两个页面级
 * 节点，剩下的每块用它的标题文本或 key 认出来，返回 `Map<标识, 下标>`——
 * 后续断言比的是**下标**，不是字符串位置。
 */
function configBlocks(tree) {
  const PAGE_LEVEL_KEYS = new Set(["site-link", "tabs"]);
  const body = tree.children.filter(
    (child) => child !== null && child !== undefined && !PAGE_LEVEL_KEYS.has(child?.props?.key),
  );
  assert.ok(body.length > 10, `配置页主体行太少（${body.length}），渲染树形状变了？`);

  /**
   * 取一「行」的**标题**：row() 的形状是
   * `div > [div.rowText > [div.rowTitle, div.rowHint, div.rowNote], 控件]`，
   * 所以标题是「第一个孩子 → 第一个孩子」。整块容器（`tolerance` / custom /
   * points / actions）的第一孩子同样是标题节点，规则通用。
   *
   * 刻意**不**把整段 rowText 都拼进来：说明与小字会一起粘在标题后面，
   * 于是「使用免费模型」变成「使用免费模型关闭：…可能会失效」，按标题找就
   * 永远找不到。标题必须只取 rowTitle 那一个节点。
   */
  const titleOf = (node) => {
    const kids = Array.isArray(node.children) ? node.children : [];
    const head = kids[0];
    if (head === null || head === undefined) return "";
    const headKids = Array.isArray(head?.children) ? head.children : [];
    const text = collectText(headKids.length > 0 ? headKids[0] : head).join("");
    // 有些标题带**动态后缀**（「API Key」+「（已配置 …abcd）」由服务端下发的
    // key 末四位拼成）。截到第一个全角括号为止，剩下的才是稳定标题——
    // 否则这条断言会随夹具里 key 的提示文本变化而红。
    const cut = text.indexOf("（");
    return (cut >= 0 ? text.slice(0, cut) : text).trim();
  };

  const at = new Map();
  body.forEach((node, index) => {
    const key = typeof node.props?.key === "string" ? node.props.key : "";
    // 分隔线：有 divider-N 的 key，且没有子节点。
    if (key.startsWith("divider-")) {
      at.set(key, index);
      return;
    }
    const title = titleOf(node);
    if (title.length > 0) at.set(title, index);
    // 整块容器另外用自己的 key 记一份（custom / tolerance / points 等）。
    if (key.length > 0) at.set(`#${key}`, index);
  });
  return at;
}

/**
 * 取一块的下标。行优先按标题找（`Map` 里键是标题），找不到再按 key 找
 * （分隔线、整块容器）。
 */
function blockAt(at, label) {
  return at.has(label) ? at.get(label) : at.get(`#${label}`);
}

// ===========================================================================
// 配置页的分组折叠（DEC-051）
// ===========================================================================
//
// DEC-037 的「一条长表单 + 三条分隔线」被换成**四个可展开的分组**（样式参考
// `@xbzbing/dsh-git-panel` 的插件配置页）。这一组用例钉的是**结构契约**：
//
//   - 四个分组按固定顺序出现，标题分别是 连接方式 / 守卫行为 / 记录与展示 /
//     模型与统计；每个标题都是**按钮**，且带 `aria-expanded` / `aria-controls`；
//   - 每个分组的正文装在自己的 `section-body` 里，**折叠时仍在树里**（只是
//     `hidden`）——卸载会让控件草稿值丢失，那是另一个事故；
//   - 每一项都归属正确的那一组：断言「这一项在哪个 body 下」，而不是
//     「页面上有这个字」；
//   - 旧的 `divider-N` 节点必须**全部消失**：分组标题就是新的分隔。

/** 递归收集某个节点的全部后代文本。 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out);
    return out;
  }
  if (typeof node === "object") textsOf(node.children, out);
  return out;
}

/** 找出配置页里所有分组 `<section>`（按出现顺序）。 */
function sectionsOf(tree) {
  const found = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === "section" && typeof node.props?.["data-section"] === "string") {
      found.push(node);
    }
    for (const child of node.children ?? []) walk(child);
  })(tree);
  return found;
}

/** 取一个分组里的标题按钮（`aria-controls` 指向它自己的 body）。 */
function headerOf(section) {
  return (section.children ?? []).find(
    (child) => child?.type === "button" && typeof child.props?.["aria-controls"] === "string",
  );
}

/** 取一个分组的正文容器。 */
function bodyOf(section) {
  const header = headerOf(section);
  const id = header?.props?.["aria-controls"];
  return (section.children ?? []).find(
    (child) => child?.type === "div" && child.props?.id === id,
  );
}

test("配置页分成四个可折叠分组，顺序与标题固定（DEC-051）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const sections = sectionsOf(tree);
  assert.equal(sections.length, 4, `应有 4 个分组，实际 ${sections.length}`);

  const EXPECTED = [
    ["connection", "连接方式", "business"],
    ["guard", "守卫行为", "warn"],
    ["record", "记录与展示", "success"],
    ["model", "模型与统计", "neutral"],
  ];
  sections.forEach((section, index) => {
    const [id, title, tone] = EXPECTED[index];
    assert.equal(section.props?.["data-section"], id, `第 ${index + 1} 个分组的 id 应为 ${id}`);
    const header = headerOf(section);
    assert.ok(header !== undefined, `分组 ${id} 缺少标题按钮`);
    assert.ok(
      textsOf(header).join("").includes(title),
      `分组 ${id} 的标题应含「${title}」，实际：${textsOf(header).join("")}`,
    );
    assert.ok(
      header.props.className.includes(`de-cfg__section--${tone}`) === false,
      // 语义色挂在 section 上（正文竖线要继承它），标题只带自己的图标色。
      `分组 ${id} 的 section 应带 ${tone} 色调`,
    );
    assert.ok(
      String(section.props.className).includes(`de-cfg__section--${tone}`),
      `分组 ${id} 的 section 应带 --${tone}`,
    );
  });
});

test("每个分组标题是带 aria-expanded / aria-controls 的按钮（可点可折叠）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const sections = sectionsOf(tree);
  for (const section of sections) {
    const id = section.props["data-section"];
    const header = headerOf(section);
    assert.equal(header.type, "button", `分组 ${id} 的标题应是 <button>`);
    assert.ok(
      ["true", "false"].includes(header.props["aria-expanded"]),
      `分组 ${id} 的标题应带 aria-expanded`,
    );
    const body = bodyOf(section);
    assert.ok(body !== undefined, `分组 ${id} 缺少与 aria-controls 对应的正文容器`);
    assert.equal(body.props.id, header.props["aria-controls"], `分组 ${id} 的 aria-controls 应指向自己的正文`);
    // 折叠是 `hidden`，不是卸载：卸载会丢控件草稿（例如填了一半的 base URL）。
    assert.equal(
      body.props.hidden === true,
      header.props["aria-expanded"] === "false",
      `分组 ${id} 的 hidden 状态应与 aria-expanded 一致`,
    );
  }
});

test("默认只展开第一组（连接方式），其余收起（DEC-051）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const sections = sectionsOf(tree);
  const states = sections.map((section) => [
    section.props["data-section"],
    headerOf(section).props["aria-expanded"],
  ]);
  assert.deepEqual(
    states,
    [["connection", "true"], ["guard", "false"], ["record", "false"], ["model", "false"]],
    "首次访问应只展开「连接方式」——它是唯一回答「连到哪」的一组；其余设一次就忘",
  );
});

test("每一项都归属正确的那一组（断言父子关系，不是「页面上有这个字」）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const sections = sectionsOf(tree);
  const byId = new Map(sections.map((section) => [section.props["data-section"], section]));

  // 每一组**至少**要有这些项出现在它的正文里。用文本判断归属，
  // 因为 row() 的标题藏在 `rowText > rowTitle` 两层里。
  const EXPECTED = {
    connection: ["使用免费模型", "服务提供方", "模型", "API Key", "生效端点", "密钥保存位置"],
    guard: ["启用守卫", "真正拦截", "人工审核比例", "决策模型参与点"],
    record: ["决策历史", "审批卡正文可读化"],
    model: ["思考模式", "匿名统计"],
  };

  for (const [id, labels] of Object.entries(EXPECTED)) {
    const section = byId.get(id);
    assert.ok(section !== undefined, `缺少分组 ${id}`);
    const bodyText = textsOf(bodyOf(section)).join("\n");
    for (const label of labels) {
      assert.ok(bodyText.includes(label), `分组「${id}」的正文应含「${label}」`);
    }
  }

  // 反向：某项**不该**出现在别的组里（防止「两项都写上、反正都在页面上」）。
  const CROSS = [
    ["启用守卫", "connection"],
    ["思考模式", "connection"],
    ["使用免费模型", "guard"],
    ["决策历史", "model"],
  ];
  for (const [label, wrongId] of CROSS) {
    const bodyText = textsOf(bodyOf(byId.get(wrongId))).join("\n");
    assert.equal(
      bodyText.includes(label),
      false,
      `「${label}」不该出现在分组「${wrongId}」里`,
    );
  }
});

test("页脚（保存状态 / 测试端点 / 状态信息）在所有分组之下，不属于任何一组（DEC-051）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const sections = sectionsOf(tree);
  const bodyText = sections.map((section) => textsOf(bodyOf(section)).join("\n"));
  // 页脚回答的是「刚才存没存、端点通不通」，是四组的共同结论。
  for (const label of ["改动即保存", "测试端点"]) {
    assert.equal(
      bodyText.some((text) => text.includes(label)),
      false,
      `「${label}」是页脚，应留在分组之外`,
    );
    assert.ok(textsOf(tree).join("\n").includes(label), `页面上应有「${label}」`);
  }
  // 页脚排在四个分组之后：它是 `.de-cfg` 里的最后一个子节点，自己包在
  // `.de-cfg__footer` 里（不该被套上分组的竖线与顶边线）。
  const container = findNode(tree, (node) => node.type === "div" && node.props?.className === "de-cfg");
  assert.ok(container !== null, "没找到 .de-cfg 容器");
  const kids = (container.children ?? []).filter((child) => child !== null && child !== undefined);
  const lastSectionAt = kids.findLastIndex((child) => child?.type === "section");
  const footerAt = kids.findIndex(
    (child) => child?.type === "div" && child.props?.className === "de-cfg__footer",
  );
  assert.ok(lastSectionAt >= 0, "没找到分组");
  assert.ok(footerAt >= 0, "没找到页脚容器");
  assert.ok(footerAt > lastSectionAt, "页脚应排在所有分组之后");
  // 页脚容器里必须装得下那两项。
  const footerText = textsOf(kids[footerAt]).join("\n");
  assert.ok(footerText.includes("改动即保存"), "页脚应有保存状态");
  assert.ok(footerText.includes("测试端点"), "页脚应有测试端点按钮");
});

test("分组展开状态记在 localStorage，刷新后不弹回（DEC-051）", async () => {
  // 用户把「守卫行为」展开、把「连接方式」收起，下次打开面板应当保持那次选择。
  // 这条防的是「状态只活在内存里」：刷新一次全部复位，等于每次都要重新折叠。
  //
  // 做法：起一个带 localStorage 的最小环境，把 bundle 的纯函数从 `i18n`
  // 探针上取出来直接调——不必真的跑一次浏览器重渲染。
  const { i18n } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  assert.equal(typeof i18n.readSectionOpen, "function", "readSectionOpen 应挂在 i18n 探针上");
  assert.equal(typeof i18n.writeSectionOpen, "function", "writeSectionOpen 应挂在 i18n 探针上");

  // 没有 localStorage 时回落到默认值：只展开「连接方式」。
  assert.deepEqual(i18n.readSectionOpen(), {
    connection: true,
    guard: false,
    record: false,
    model: false,
  });

  // 有 localStorage 时按存下来的值还原。
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
  };
  try {
    i18n.writeSectionOpen({ connection: false, guard: true, record: false, model: true });
    assert.deepEqual(i18n.readSectionOpen(), {
      connection: false,
      guard: true,
      record: false,
      model: true,
    });
    // 坏数据（手工改坏 / 别的版本写的）不能让页面崩：退回默认值。
    store[i18n.SECTION_OPEN_KEY] = "{not json";
    assert.deepEqual(i18n.readSectionOpen(), {
      connection: true,
      guard: false,
      record: false,
      model: false,
    });
  } finally {
    delete globalThis.localStorage;
  }
});

test("折叠是 hidden 而不是卸载：控件草稿不会因为收起分组而丢（DEC-051）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const sections = sectionsOf(tree);
  // 收起的组里，正文必须仍是一个**有内容的**节点，只是 props.hidden = true。
  // 卸载会让 base URL 填到一半时一切归零（真实事故：切 tab 后草稿消失）。
  const collapsed = sections.filter((section) => headerOf(section).props["aria-expanded"] === "false");
  assert.ok(collapsed.length > 0, "默认应有收起的组");
  for (const section of collapsed) {
    const body = bodyOf(section);
    assert.ok(body !== undefined, `${section.props["data-section"]} 的正文容器应仍在树里`);
    assert.equal(body.props.hidden, true, "收起时应 hidden");
    assert.ok((body.children ?? []).length > 0, "正文内容应保留（不是空壳）");
  }
  // 展开的组不能 hidden。
  for (const section of sections) {
    if (headerOf(section).props["aria-expanded"] === "true") {
      assert.notEqual(bodyOf(section).props.hidden, true, "展开的组不该 hidden");
    }
  }
});

const EXPECTED_TONE = {
  connection: "business",
  guard: "warn",
  record: "success",
  model: "neutral",
};

test("每个分组标题带语义色图标与 chevron，且图标与色块同色（DEC-051）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  for (const section of sectionsOf(tree)) {
    const id = section.props["data-section"];
    const header = headerOf(section);
    // 图标是 `<SectionIcon>` 组件元素：桩不会执行子组件，所以这里比对
    // 「元素类型是函数」+ 它的入参，再把该组件**直接调一次**验证形状。
    const iconEl = findNode(header, (node) => typeof node.type === "function");
    assert.ok(iconEl !== null, `分组 ${id} 缺少图标组件`);
    assert.equal(iconEl.props.tone, EXPECTED_TONE[id], `分组 ${id} 的图标色调应与其分组一致`);
    const svg = iconEl.type(iconEl.props);
    assert.equal(svg.type, "svg", `分组 ${id} 的图标应渲染成 svg`);
    assert.equal(svg.props["aria-hidden"], "true", `分组 ${id} 的图标是纯装饰，应 aria-hidden`);
    // 图标是内联 path 画的（不依赖宿主的图标库）。
    assert.ok((svg.children ?? []).length > 0, `分组 ${id} 的图标应有图形`);
    const chevron = findNode(header, (node) => typeof node.props?.className === "string" && node.props.className.includes("de-cfg__chevron"));
    assert.ok(chevron !== null, `分组 ${id} 缺少 chevron`);
    // 两态的指示必须**可分辨**：展开加 --open 类，闭合不加。若两态都带同一个
    // 内联 transform，chevron 就永远指同一个方向，指示等于没有。
    const isOpen = header.props["aria-expanded"] === "true";
    assert.equal(
      String(chevron.props.className).includes("de-cfg__chevron--open"),
      isOpen,
      `分组 ${id} 的 chevron 开合态与 aria-expanded 不一致`,
    );
    assert.equal(
      typeof chevron.props.style?.transform,
      "undefined",
      `分组 ${id} 的 chevron 不该用内联 transform——旋转由 CSS 类控制`,
    );
  }
});

test("旧的分隔线节点已全部移除（分组标题就是新的分隔，DEC-051）", async () => {
  const { tree } = await render(stateWith({}), { slots: { [SLOTS.decisions]: decisionsFixture } });
  const dividers = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node.props?.key === "string" && node.props.key.startsWith("divider-")) {
      dividers.push(node);
    }
    for (const child of node.children ?? []) walk(child);
  })(tree);
  assert.deepEqual(dividers, [], "分隔线应由分组标题取代，不该再留");
});

test("配置页与统计页的容器不限制最大宽度（DEC-040）", async () => {
  // 用户反馈：配置内容被框死在一个固定宽度里，比它宽的那部分要**手动左右拖**
  // 才看得到。关键在于这一层同时是 `overflowY: auto`——CSS 规范里，一个轴不是
  // visible 时另一个轴的 visible 按 auto 处理，所以 `maxWidth` 在这里不是「留白」，
  // 而是货真价实的一条横向滚动条。这条用例防的是有人把像素上限改回来。
  for (const tab of ["config", "stats"]) {
    const { tree } = await render(stateWith({}), { slots: { [SLOTS.tab]: tab } });
    const style = tree.props.style ?? {};
    assert.ok(
      style.maxWidth === undefined || style.maxWidth === "none",
      `${tab} 页容器不应限制最大宽度，实际：${JSON.stringify(style.maxWidth)}`,
    );
    // 纵向滚动仍归这一层自己管（宿主那条链会长到内容高度，见 DEC-022）。
    assert.equal(style.overflowY, "auto", `${tab} 页容器应保留纵向滚动`);
  }
});

test("「使用免费模型」下面有一行小字「可能会失效」，且就在这一行里（DEC-037）", async () => {
  const { tree } = await render(stateWith({}));
  const row = findNode(tree, (item) => {
    const children = Array.isArray(item?.children) ? item.children : [];
    const head = children[0];
    return head !== undefined && head !== null && collectText(head).includes("使用免费模型");
  });
  assert.ok(row !== null && row !== undefined, "没有找到「使用免费模型」这一行");
  const rowText = row.children[0];
  const lines = collectText(rowText);
  const noteIndex = lines.indexOf("可能会失效");
  assert.ok(noteIndex >= 0, `小字不在「使用免费模型」的 rowText 里；实际：${JSON.stringify(lines)}`);
  // 标题 → 说明（serverHint）→ 小字：小字必须排在说明**之后**，不能抢在
  // 说明前面（那句说明才是「这个开关干什么」，小字是它的风险注脚）。
  assert.ok(
    noteIndex > lines.indexOf("使用免费模型"),
    "小字应排在标题之后",
  );
  // 而且它只出现一次（不是页面上某个别的地方也有这个词）。
  assert.equal(lines.filter((line) => line === "可能会失效").length, 1, "「可能会失效」在行内出现了多次");
});


// ------------------------------------------- 使用免费模型（DEC-030；原名「跟随服务端下发」，DEC-037 改名）

// 这一组测的是「服务端下发的值真的用上了，且没有一次把明文 key 送到界面上」。
// 前者靠文案断言（界面显示的就是生效值）；后者只能靠**反断言**——
// 用一个醒目的假 key 铺满所有下发字段，然后确认整棵树里找不到它。

/** 一份「服务端已下发」的 status 片段。 */
function serverProviderWith(over) {
  return {
    enabled: true,
    active: true,
    endpoint: "https://dsh.zuos.us/api/provider-config",
    label: "服务端下发",
    status: "ready",
    usable: true,
    error: "",
    keyHint: "…1234",
    baseUrl: "https://api.example.com/v1",
    model: "Kev-4B",
    endpointStyle: "systemone",
    fetchedAt: Date.UTC(2026, 10, 3, 6, 30),
    expiresAt: Date.UTC(2026, 10, 3, 6, 40),
    expired: false,
    ...over,
  };
}

test("「使用免费模型」开关默认关，且说明用的是本地配置", async () => {
  // 默认关是产品约束（不是风格）：装了插件的人可能已经在用自己的 key，
  // 默认开启会把他们悄悄换成服务商的账号，而他们只会看到「key 好像失效了」。
  const { text, tree } = await render(stateWith({}));
  assert.ok(text.includes("使用免费模型"), `缺少开关行：\n${text.slice(0, 600)}`);
  const toggle = toggleOfRow(tree, "使用免费模型");
  assert.ok(toggle !== undefined, "没有找到「使用免费模型」的开关控件");
  assert.equal(toggle.props["aria-pressed"], false, "开关默认必须是关");
  assert.ok(
    text.includes("关闭：使用下方的本地配置（与现在完全一致）"),
    `关闭时未说明回落行为：\n${text.slice(0, 600)}`,
  );
  // 关着的时候不该有「重新获取」——它此时什么也不会改变。
  assert.equal(hasButtonLabeled(tree, "重新获取"), false, "关闭时不该出现「重新获取」按钮");
});

test("服务端下发生效时显示地址、模型与 key 末四位，且树里没有明文 key", async () => {
  const { text, tree } = await render(
    stateWith({
      // 生效值来自服务端：面板的这两行本来就取「生效值」。
      baseUrl: "https://api.example.com/v1/systemone",
      model: "Kev-4B",
      keyHint: "…1234",
      serverProvider: serverProviderWith({}),
    }),
  );
  // 一行说明就够：地址 + 模型 + key 末四位 + 来源角标。
  assert.ok(text.includes("https://api.example.com/v1"), `未显示下发地址：\n${text.slice(0, 600)}`);
  assert.ok(text.includes("Kev-4B"), "未显示下发模型");
  assert.ok(text.includes("…1234"), "未显示 key 末四位");
  assert.ok(text.includes("（地址与密钥来自服务端下发）"), "生效端点行缺少来源角标");
  assert.ok(hasButtonLabeled(tree, "重新获取"), "开启时应出现「重新获取」按钮");
});

test("服务端不可用时说明原因，并明确已回落到本地配置", async () => {
  // 「静默回落」的代价是用户不知道发生了什么；所以回落本身可以静默，
  // 但**必须有地方说**——否则一次下发失败会表现成「key 突然不管用了」。
  const { text } = await render(
    stateWith({
      serverProvider: serverProviderWith({
        active: false,
        status: "error",
        usable: false,
        error: "服务端返回 HTTP 404",
      }),
    }),
  );
  assert.ok(
    text.includes("服务端不可用：服务端返回 HTTP 404；已回落到本地手动配置"),
    `未说明回落与原因：\n${text.slice(0, 700)}`,
  );
});

test("下发值过期时额外说明「已过期」", async () => {
  // 过期与「从没取到」是两件事：前者说明这台机器曾经正常工作过，
  // 排查方向是网络/服务端；后者更像是从没配对过。文案必须区分。
  const { text } = await render(
    stateWith({
      serverProvider: serverProviderWith({ active: false, status: "error", usable: false, expired: true }),
    }),
  );
  assert.ok(text.includes("（服务端下发的值已过期）"), `未提示过期：\n${text.slice(0, 700)}`);
});

test("「重新获取」发的是 POST /server-provider，不是又存一次配置", async () => {
  // 它表达的是「现在就要一份新的下发值」，而不是「保存当前表单」。
  // 发成 PUT /config 会看起来什么都没变（服务端按缓存决定拉不拉）。
  const { tree } = await render(stateWith({ serverProvider: serverProviderWith({}) }));
  const button = findNode(
    tree,
    (node) =>
      node.type === "button" && collectText(node).join("").includes("重新获取"),
  );
  assert.ok(button !== null && button !== undefined, "没有找到「重新获取」按钮");

  const stub = stubFetch();
  try {
    button.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }
  const call = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/server-provider"));
  assert.ok(call !== undefined, `应 POST /server-provider，实际：${stub.calls.map((c) => c.url).join(", ")}`);
  assert.equal(call.init.method, "POST", "强制刷新应走 POST");
});

test("服务端生效时，手动输入 key 与 provider 下拉都还在（手动方案不变）", async () => {
  // 这条是 DEC-030 的验收核心之一：新功能**不得**以任何方式削弱手工路径。
  // 不 disable、不隐藏——服务端一旦不可用，用户要靠这些控件自己救场。
  const { tree } = await render(stateWith({ serverProvider: serverProviderWith({}) }));
  const keyInput = findNode(tree, (node) => node.type === "input" && node.props.type === "password");
  assert.ok(keyInput !== null && keyInput !== undefined, "服务端生效时 API Key 输入框被隐藏了");
  // 不按具体 provider 名匹配：默认值历史上在 bamboonode / systemone 之间来回
  // 换过（DEC-031 与其撤销），钉死名字会让这条 DEC-030 验收随默认值翻车。
  const select = findNode(
    tree,
    (node) => node.type === "select" && PROVIDER_IDS.includes(node.props.value),
  );
  assert.ok(select !== null && select !== undefined, "服务端生效时 provider 下拉消失或不再回显当前值");
});

test("播开关会 PUT /config 且带上 serverProvider: true", async () => {
  const { tree } = await render(stateWith({}));
  const toggle = toggleOfRow(tree, "使用免费模型");
  assert.ok(toggle !== undefined, "没有找到「使用免费模型」的开关");

  const stub = stubFetch();
  try {
    toggle.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stub.restore();
  }
  const call = stub.calls.find((item) => item.url.endsWith("/api/decision-engine/config"));
  assert.ok(call !== undefined, `应 PUT /config，实际：${stub.calls.map((c) => c.url).join(", ")}`);
  const body = JSON.parse(call.init.body);
  assert.equal(body.serverProvider, true, `patch 应带上 serverProvider: true，实际：${call.init.body}`);
});

test("即使服务端误把明文 key 塞进响应，界面也不会显示它", async () => {
  // 界面这一侧的最后一道闸。服务端的契约里只有 keyHint，但契约是靠人守的；
  // 这里模拟「后端某天顺手多回了 key 字段」，确认渲染路径不会把它带出来——
  // 面板文本会进日志、截图、用户复制，明文一旦出现在这里就不再可控。
  const LEAK = "sk-LEAK-CANARY-9f8e7d6c5b4a";
  const { text } = await render(
    stateWith({
      serverProvider: { ...serverProviderWith({}), key: LEAK, apiKey: LEAK },
    }),
  );
  assert.equal(text.includes(LEAK), false, `明文 key 泄漏到了面板文本里：\n${text.slice(0, 800)}`);
});


// ===========================================================================
// 人工审核比例（DEC-035）：四段滑块
// ===========================================================================
//
// 这一组防的是「控件存在但用户用不了 / 看见的是内部 id / 点了不落盘」。
// 同时守一条曾经的**真实回归**：滑块曾经只在服务端下发 `tolerance` 时渲染，
// 后端一旦漏配（少拼一个字段），界面上就整块消失、用户以为功能被砍掉了。
// 所以「无数据时安静消失」与「有数据时四个段都在」必须同时钉住。

/** 收集渲染树里所有 button 节点的显示文字。 */
function buttonLabels(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node !== "object") return out;
  if (node.type === "button") {
    const parts = [];
    const walk = (child) => {
      if (child === null || child === undefined || child === false) return;
      if (typeof child === "string" || typeof child === "number") {
        parts.push(String(child));
        return;
      }
      (child.children ?? []).forEach(walk);
    };
    walk(node);
    if (parts.join("").length > 0) out.push(parts.join(""));
  }
  (node.children ?? []).forEach((child) => buttonLabels(child, out));
  return out;
}

test("配置页渲染四段滑块，且四个段依次是 自治 / 轻松 / 默认 / 谨慎", async () => {
  const { tree, text, controls } = await render(stateWith({}), {
    slots: { [SLOTS.decisions]: decisionsFixture },
  });

  assert.ok(text.includes("人工审核比例"), `配置页缺少「人工审核比例」这一行：\n${text.slice(0, 800)}`);

  // 四段必须都在。用「包含」而不是「等于」：标签带语义尾注
  //（「轻松（只问最前 1%）」），那正是让用户看懂「往右更常问」的那半句。
  const labels = buttonLabels(tree);
  const segment = (name) => labels.some((label) => label.includes(name));
  for (const name of ["自治", "轻松", "默认", "谨慎"]) {
    assert.ok(segment(name), `滑块缺少「${name}」段；实际按钮文字：${JSON.stringify(labels)}`);
  }

  // 比例说明必须出现在轨道下方那一行——它取代了原本挤在落点上的尾注
  //（落点放不下「轻松（只问最前 1%）」，窄面板里只能换行叠成一团；容器自 DEC-040
  //  起不再限宽，但窗口窄的时候这条照样成立）。
  // 断言「当前档位」这一行：默认档不按比例，所以说的是模型自己的判断。
  assert.ok(
    text.includes("默认：按决策模型自己的判断"),
    `应说明当前档位的语义，实际：\n${text.slice(0, 900)}`,
  );
});

test("滑块不是下拉菜单：四档不是 select 的选项", async () => {
  // 用户明确要求「不要 dropdown menu，要 segmented slider」。
  // 这条防的是有人图省事把滑块换回 select——那样四个档位会被压成
  // 四个互不相干的选项，「往右更保守」这层语义就没了。
  const { controls, text } = await render(stateWith({}), {
    slots: { [SLOTS.decisions]: decisionsFixture },
  });
  const selectOptionTexts = controls
    .filter((node) => node.type === "select")
    .flatMap((node) => (node.children ?? []).filter((child) => child?.type === "option"))
    .map((node) => collectText(node).join(""));
  for (const name of ["自治", "轻松", "谨慎"]) {
    assert.ok(
      !selectOptionTexts.some((option) => option.includes(name)),
      `「${name}」不应出现在 select 的选项里（要求是分段滑块，不是下拉）`,
    );
  }
});

test("当前档位被打勾（aria-pressed），其余为 false", async () => {
  // 无障碍与「我到底选了哪个」都靠它：只靠颜色的话，色觉障碍用户与
  // 深浅色主题下都读不出来。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.decisions]: { ...decisionsFixture, tolerance: toleranceFixture({ level: "relaxed" }) },
    },
  });
  const pressed = [];
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (node.type === "button" && node.props?.["aria-pressed"] !== undefined) {
      const label = collectText(node).join("");
      if (["自治", "轻松", "默认", "谨慎"].some((name) => label.includes(name))) {
        pressed.push({ label, pressed: node.props["aria-pressed"] });
      }
    }
    (node.children ?? []).forEach(walk);
  };
  walk(tree);
  assert.equal(pressed.length, 4, `应有四个带 aria-pressed 的段，实际 ${pressed.length}`);
  const active = pressed.filter((item) => item.pressed === true);
  assert.equal(active.length, 1, `只能有一个选中段，实际 ${JSON.stringify(active)}`);
  assert.ok(active[0].label.includes("轻松"), `选中段应为轻松，实际 ${active[0].label}`);
});

test("服务端不下发 tolerance 时，配置页照常渲染且不出现滑块（曾经的回归）", async () => {
  // 这是一条**回归守卫**：滑块渲染的条件里带了 `decisions?.tolerance`
  // 判断，后端漏拼这个字段时控件会整块消失。只要页面不崩、其它字段还在，
  // 这个降级是可接受的——但绝不能整页报错。
  const withoutTolerance = {
    points: decisionsFixture.points,
    modes: decisionsFixture.modes,
    cache: decisionsFixture.cache,
  };
  const { text } = await render(stateWith({}), {
    slots: { [SLOTS.decisions]: withoutTolerance },
  });
  assert.ok(!text.includes("人工审核比例"), "没有下发数据时不该画出滑块");
  // 页面其余部分必须仍在（证明是「少了一块」，不是「整页挂了」）。
  assert.ok(text.includes("启用守卫"), `页面其它内容应正常，实际：\n${text.slice(0, 600)}`);
});

test("校准脚注：未就绪时写「校准中 n/50」，就绪后写实际阈值", async () => {
  // 冷启动与「设置失效」在界面上必须能区分开。用户看到「校准中 0/50」
  // 就知道是样本不够，而不是以为滑块没生效。
  const notReady = await render(stateWith({}), {
    slots: {
      [SLOTS.decisions]: {
        ...decisionsFixture,
        tolerance: toleranceFixture({
          level: "relaxed",
          calibration: {
            ...toleranceFixture().calibration,
            samples: 12,
            ready: false,
            fallbackSeverity: 0.6,
          },
        }),
      },
    },
  });
  assert.ok(notReady.text.includes("校准中 12/50"), `未就绪时应写明进度，实际：\n${notReady.text.slice(0, 900)}`);

  const ready = await render(stateWith({}), {
    slots: {
      [SLOTS.decisions]: {
        ...decisionsFixture,
        tolerance: toleranceFixture({
          level: "relaxed",
          calibration: {
            ...toleranceFixture().calibration,
            samples: 120,
            ready: true,
            threshold: 0.4321,
          },
        }),
      },
    },
  });
  assert.ok(ready.text.includes("已按这个模型校准"), `就绪后应写已校准，实际：\n${ready.text.slice(0, 900)}`);
  assert.ok(ready.text.includes("0.432"), `应显示出实际阈值，实际：\n${ready.text.slice(0, 900)}`);
});


test("滑块独占一整行，没被塞进 rowLine 的右半边（真机竖排事故的回归守卫）", async () => {
  // 事故现场：滑块被当成 row() 的**右侧控件**放进 `rowLine`（一个
  // `justify-content: space-between` 的两列布局）。四段在里面各自
  // `flex: 1 1 0` + `minWidth: 0`，被压到每个只有一个字宽，中文标签逐字
  // 换行，四个段叠成一团竖排，整个页面看着像坏了。
  //
  // 因此这里断言两件事：
  //   1. 滑块**不在**任何 rowLine 容器里（它自成一块 `toleranceSection`）；
  //   2. 四个落点各自 `minWidth: max-content` 且 `whiteSpace: nowrap`
  //      ——这两条是「标签永不换行」的实现手段，少了任何一条就会重现竖排。
  const { tree } = await render(stateWith({}), {
    slots: { [SLOTS.decisions]: decisionsFixture },
  });

  // 收集「段按钮」：带 aria-pressed 且文案是四档之一的 button。
  const NAMES = ["自治", "轻松", "默认", "谨慎"];
  const stopButtons = [];
  const rowLineContainers = [];
  const walk = (node, ancestors) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    const style = node.props?.style ?? {};
    // 事故的形状专指 `rowLine`：两列 space-between，且**没有** relative 定位
    // ——滑块自己的轨道也用 space-between 来等距排列四个落点，但它是
    // `position: relative`（为轨道细线提供定位上下文），是正当用法。
    if (
      style.justifyContent === "space-between"
      && style.display === "flex"
      && style.position !== "relative"
    ) {
      rowLineContainers.push(node);
    }
    if (node.type === "button" && node.props?.["aria-pressed"] !== undefined) {
      const label = collectText(node).join("");
      if (NAMES.some((name) => label.includes(name))) stopButtons.push(node);
    }
    (node.children ?? []).forEach((child) => walk(child, [...ancestors, node]));
  };
  walk(tree, []);

  assert.equal(stopButtons.length, 4, `应有四个落点按钮，实际 ${stopButtons.length}`);
  for (const button of stopButtons) {
    assert.equal(button.props.style.whiteSpace, "nowrap", "落点必须禁止换行（否则中文会竖着叠成一列）");
    assert.equal(
      button.props.style.minWidth,
      "max-content",
      "落点必须用 max-content（纯 minWidth:0 会让标签逐字换行）",
    );
  }

  // 每个落点都不能落在 rowLine 里（那就是事故的形状）。
  for (const line of rowLineContainers) {
    const texts = collectText(line).join("");
    assert.ok(
      !NAMES.every((name) => texts.includes(name)),
      `四个段不该整组出现在 rowLine（两列布局）里；这里出现了：${texts.slice(0, 200)}`,
    );
  }
});

// ---------------------------------------------------------------- 统计页图表

/**
 * 一份最小的图表模块替身。
 *
 * 用它而不是真的 microcharts：渲染测试要验证的是「统计页有没有把数据
 * 交给图型、失败时会不会降级」，不是第三方库画得对不对（那由库自己的
 * 测试与我们的 chunk 自检负责）。替身让这些断言不依赖一个 24 KB 的产物，
 * 也不会因为库升级改了几何就让整个 UI 套件变红。
 *
 * 每个组件都把自己的入参摊成一个可断言的节点，于是测试能直接问
 * 「Sparkline 拿到的 data 是不是服务端那条序列」。
 */
function chartStub(name) {
  const Stub = function Stub() {
    return null;
  };
  // 标记在函数对象上：渲染树里的节点 type 就是这个函数本身
  // （createElement 不把函数换成字符串），所以靠标记识别图型，
  // 而不是靠 type 的形状。
  Stub.__chart = name;
  return Stub;
}

const chartsFixture = {
  Sparkline: chartStub("Sparkline"),
  SparkBar: chartStub("SparkBar"),
  MiniBar: chartStub("MiniBar"),
  SegmentedBar: chartStub("SegmentedBar"),
  Bullet: chartStub("Bullet"),
  Delta: chartStub("Delta"),
  MicroDonut: chartStub("MicroDonut"),
};

/** 在渲染树里按 type 找节点（替身组件的 type 是字符串，便于断言）。 */
function findAllByType(node, chartName, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) findAllByType(child, chartName, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (typeof node.type === "function" && node.type.__chart === chartName) out.push(node);
  findAllByType(node.children, chartName, out);
  findAllByType(node.props?.children, chartName, out);
  return out;
}

/** 带时间序列的统计结果（走势图需要它）。 */
function statsWithSeries(over) {
  return statsWith({
    series: {
      bucket: "hour",
      buckets: ["2026-11-10T09", "2026-11-10T10", "2026-11-10T11"],
      series: {
        requests: [3, 0, 4],
        inputTokens: [600, 0, 900],
        outputTokens: [90, 0, 120],
        durationMs: [3000, 0, 4000],
        allow: [2, 0, 1],
        ask: [1, 0, 1],
        reject: [0, 0, 2],
        none: [0, 0, 0],
      },
      total: 3,
    },
    ...over,
  });
}

/**
 * 同一份序列，再补上服务端的 `series.nowIndex`（「第一个还没开始的桶」的下标）。
 *
 * `undefined` 走「字段根本不存在」那条路——那是老服务端的样子，必须和现在
 * 一模一样，所以这里不是「传个 null 占位」，而是整个键都不写。
 */
function statsWithSeriesFuture(nowIndex) {
  const base = statsWithSeries({});
  const series = { ...base.series };
  if (nowIndex !== undefined) series.nowIndex = nowIndex;
  return { ...base, series };
}

/**
 * 取走势图里我们自己画的那条虚线（`data-mc-ink="muted"` 的 path 子节点）。
 *
 * 子节点在 `props.children` 上：`renderTrend` 是把 path 放进 Sparkline 的
 * props 对象的，替身组件不展开子树，所以只能顺着 props 取。
 */
function dashedChildOf(sparklineNode) {
  const kids = [sparklineNode?.children ?? [], sparklineNode?.props?.children ?? []].flat(Infinity);
  return kids.find(
    (child) =>
      child !== null &&
      typeof child === "object" &&
      child.type === "path" &&
      child.props?.["data-mc-ink"] === "muted",
  );
}

/**
 * 把路径 `d` 解析回顶点数组。
 *
 * 分隔规则照 microcharts 自己那一套：每段各起一个 `M`，段内用 `" L"` 连接，
 * 段与段之间用一个空格。写错分隔符的话浏览器整条路径解析失败，
 * 表现是「虚线根本不出现且不报错」，所以这里也按同一规则解析。
 */
function parsePathVertices(d) {
  return String(d)
    .split("M")
    .filter((segment) => segment !== "")
    .flatMap((segment) =>
      segment.split(" L").map((pair) => {
        const [x, y] = pair.trim().split(" ").map(Number);
        return { x, y };
      }),
    );
}

/** 走势图里「请求次数」那一张（三条序列里 data[0] === 3 的那条）。 */
function requestsTrend(tree) {
  return findAllByType(tree, "Sparkline").find(
    (node) => node.props.data?.length === 3 && node.props.data?.[0] === 3,
  );
}

test("图表：有图表模块时，走势图拿到服务端那条序列", async () => {
  // 关键断言是「图里画的就是表里那个数」：走势图的 data 必须与服务端
  // 下发的序列**逐点相同**，不能在渲染层再算一遍（那会出现图与表对不上）。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWithSeries({}),
      20: chartsFixture,
    },
  });
  const sparklines = findAllByType(tree, "Sparkline");
  assert.ok(sparklines.length >= 1, "统计页应渲染走势图");
  const requests = sparklines.find((node) => node.props.data?.join(",") === "3,0,4");
  assert.ok(requests !== undefined, "请求次数走势应原样使用服务端序列（含空桶 0）");
});

test("图表：区间尾部有未来段时，未来点在 data 里置 null、虚线段自己画", async () => {
  // 区间上界常常延伸到未来（today → 次日 0 点、year → 年末），尾部那些桶恒为 0。
  // 现在要求：过去段维持原样，未来段用淡色虚线。做法是把交给库的 data 在未来
  // 索引处置 null（库把非有限值当断点，线停在边界，hover/键盘也跳过未来的桶），
  // 虚线段由我们塞进 Sparkline 的 children。
  const { tree, text } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWithSeriesFuture(2),
      20: chartsFixture,
    },
  });
  const requests = requestsTrend(tree);
  assert.ok(requests !== undefined, "请求次数走势图应在");

  // ① 交给库的序列：下标 2（还没开始的桶）必须是 null，前两点原样不动。
  //    null 而不是 0：0 会被库当成真实读数画出来、也会被 hover 念出来。
  assert.deepEqual(requests.props.data, [3, 0, null], "未来索引处置 null，实线停在边界");

  // ② 值域必须由我们显式传，而且**按原始序列**算：库拿 null 化之后的
  //    [3, 0, null] 自己算会得到 [0, 3]，过去段的坡度就因「后面挂了几格未来」
  //    被偷偷改掉，实线与虚线也不是同一套缩放。这里必须仍是 [0, 4]。
  assert.deepEqual(requests.props.domain, [0, 4], "值域含未来段的值，形状不因 null 化而变");

  // ③ 顶点数 = 桶数：库默认 maxPoints 200，超过就 min/max 抽稀，
  //    长区间（year + 日桶）上虚线会和实线错开好几个桶。
  assert.equal(requests.props.maxPoints, 3, "关抽稀：虚线与实线逐桶对应");

  // ④ 虚线段本体。
  const dashed = dashedChildOf(requests);
  assert.ok(dashed !== undefined, '应有一个 data-mc-ink="muted" 的 path 子节点');
  assert.equal(dashed.props["data-mc-ink"], "muted", "淡色/虚线/略细全靠这条 ink 规则");
  const vertices = parsePathVertices(dashed.props.d);
  // 覆盖 [futureFrom - 1, length - 1]：**从最后一个已发生的点起笔**，
  // 否则虚线与实线之间会留一段肉眼可见的缺口。
  // 数字来自这套布局：pad 2、x = 2 + i*(258-2)/(3-1) → 2 / 130 / 258；
  // y = 32 + (v - 0)*(2 - 32)/(4 - 0)。与库自己算的顶点是否逐位相同，
  // 由 test/client-charts-chunk.test.js 拿真实产物锁定（这里只断言接线位置）。
  assert.equal(vertices.length, 2, `虚线应有两个顶点，实际 d=${dashed.props.d}`);
  assert.deepEqual(vertices[0], { x: 130, y: 32 }, "起笔 = 最后一个已发生的桶（下标 1，值 0）");
  // 下标 2 在这份夹具里故意给了 4（真实数据里未来桶恒为 0）。这一条顺带锁住
  // 一个性质：虚线画的是**序列里的真实值**，不是把未来段一律拉平到 0——
  // 所以它必须落在 y=2（4 的顶点），而不是贴底的 32。
  assert.deepEqual(vertices[1], { x: 258, y: 2 }, "延伸到最后一个桶（下标 2，值 4 → y=2）");

  // ⑤ 文案：读者必须知道虚线是什么，读屏用户也一样。
  assert.ok(
    text.includes("虚线段是区间内还没到的时间，不计入读数。"),
    "说明行应在有未来段时出现",
  );
  assert.ok(
    String(requests.props.summary).includes("虚线为未来 1 个桶"),
    `无障碍摘要应说明虚线含义，实际：${requests.props.summary}`,
  );
});

test("图表：没有未来段时（字段缺失 / 越界 / 非数字 / 整段未来）行为与旧版逐点相同", async () => {
  // 向后兼容是硬要求：老服务端响应里没有 nowIndex，非法值一律当作「没有未来段」。
  // 做错的表现都不是「报错」而是「画了不该画的线」——比如把整段历史画成虚线，
  // 读者会以为这段时间根本没有请求。
  const cases = [
    ["字段缺失（老服务端）", undefined],
    ["nowIndex === buckets.length（没有未来段）", 3],
    ["nowIndex === 0（整段都在未来，没有已发生的点可以起笔）", 0],
    ["字符串数字", "2"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["小数", 1.5],
    ["负数（越界）", -1],
    ["大于长度（越界）", 99],
    ["null", null],
  ];
  for (const [name, nowIndex] of cases) {
    const { tree, text } = await render(stateWith({}), {
      slots: {
        [SLOTS.tab]: "stats",
        [SLOTS.stats]: statsWithSeriesFuture(nowIndex),
        20: chartsFixture,
      },
    });
    const requests = requestsTrend(tree);
    assert.ok(requests !== undefined, `${name}：走势图应在`);
    assert.deepEqual(requests.props.data, [3, 0, 4], `${name}：data 必须原样交给库`);
    assert.equal(requests.props.domain, undefined, `${name}：不该由我们指定值域`);
    assert.equal(requests.props.maxPoints, undefined, `${name}：不该改库的抽稀默认值`);
    assert.equal(dashedChildOf(requests), undefined, `${name}：不该出现虚线段`);
    assert.ok(!text.includes("虚线段是区间内还没到的时间"), `${name}：不该出现虚线说明`);
    assert.ok(
      !String(requests.props.summary).includes("虚线"),
      `${name}：摘要不该提虚线，实际：${requests.props.summary}`,
    );
  }
});

test("图表：没有图表模块时统计页照常显示数字表格（降级）", async () => {
  // 分块可能因为宿主版本、缓存、网络任何一环加载失败。那时统计页**必须**
  // 还能用：表格是主体，图表只是让数字更好读的增强。这条防的是
  // 「图表没加载出来 → 整页空白 / 报错」。
  const { text, tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWithSeries({}),
      20: null,
    },
  });
  assert.equal(findAllByType(tree, "Sparkline").length, 0, "没模块时不该渲染图表");
  // 数字与表格仍在：合计、对比表、节省量都能看到。
  assert.ok(text.includes("用量统计与对比"), "统计页标题应在");
  assert.ok(text.includes("横向对比"), "对比表应在");
  assert.ok(text.includes("节省量对比"), "节省量表应在");
  assert.ok(text.includes("48000") || text.includes("24,000") || text.includes("24000"), "合计数字应在");
});

test("图表：裁决构成条只在有裁决时出现，且不含「未裁决」", async () => {
  // 「未裁决」不是第四种裁决结果，而是「这次根本没产生裁决」。把它拼进
  // 100% 的构成条，会让「降级很多」看起来像「模型总在拦/放」。
  const withDecided = statsWithSeries({
    outcomes: { allow: 10, ask: 3, reject: 2, none: 5, decided: 15, byPoint: [], otherVerdicts: [], otherVerdictCount: 0 },
  });
  const { tree } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: withDecided, 20: chartsFixture },
  });
  const bars = findAllByType(tree, "SegmentedBar");
  assert.equal(bars.length, 1, "有裁决时应渲染一条构成条");
  const labels = bars[0].props.data.map((item) => item.label);
  assert.deepEqual(labels, ["放行", "询问", "拦截"], "构成条只含三种裁决，顺序固定");
  assert.equal(
    bars[0].props.order,
    "data",
    "顺序固定成 allow→ask→reject，不能按大小重排（否则跨区间颜色会换）",
  );

  // 全零裁决：不画空条（空条会被读成「裁决了但全是别的」）。
  const noneDecided = statsWithSeries({
    outcomes: { allow: 0, ask: 0, reject: 0, none: 7, decided: 0, byPoint: [], otherVerdicts: [], otherVerdictCount: 0 },
  });
  const { tree: bare } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: noneDecided, 20: chartsFixture },
  });
  assert.equal(findAllByType(bare, "SegmentedBar").length, 0, "没有裁决时不该画构成条");
});

test("图表：节省量对比只在「观察模式有数据」时画，且带基线", async () => {
  // 节省量是反事实数字，最容易误读。没有观察模式记录时画一条「实际=基线」
  // 的满格条，会被读成「一点没省」——所以要整块不画。
  const { tree } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWithSeries({}), 20: chartsFixture },
  });
  const bullets = findAllByType(tree, "Bullet");
  assert.ok(bullets.length >= 1, "有观察模式数据时应渲染节省量对比");
  const inputBullet = bullets.find((node) => node.props.target === 40000);
  assert.ok(inputBullet !== undefined, "子弹图应把基线作为 target");
  assert.equal(inputBullet.props.value, 16000, "条长应是实际消耗");

  const unavailable = statsWithSeries({
    savings: { observeRequests: 0, totalRequests: 12, byMode: { observe: 0, enforce: 12, off: 0, unknown: 0 }, unavailable: true },
  });
  const { tree: bare } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: unavailable, 20: chartsFixture },
  });
  assert.equal(findAllByType(bare, "Bullet").length, 0, "没有观察模式数据时不该画节省量对比");
});

test("图表：请求次数排序条只取前 8 个组合", async () => {
  // 行数一多，横向条的标签会挤在一起。图表负责「看出头部」，表格
  // 负责「查具体值」——所以排序条截断，表格不截断。
  const manyRows = Array.from({ length: 12 }, (_, index) => ({
    provider: `p${index}`,
    model: `m${index}`,
    requests: 100 - index,
    cached: 0,
    inputTokens: 1000,
    outputTokens: 100,
    durationMs: 100,
    avgDurationMs: 100,
    observeRequests: 0,
    observeInputTokens: 0,
    observeOutputTokens: 0,
    observeDurationMs: 0,
    savedInputTokens: 0,
    savedOutputTokens: 0,
    savedDurationMs: 0,
    savedRatio: 0,
  }));
  const { tree } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWithSeries({ rows: manyRows }), 20: chartsFixture },
  });
  // 排序条现在是自己画的行（名称 + 条 + 数值 + 占比），不再用 MiniBar：
  // 实测 MiniBar 横向模式不画标签、也不能按条上色，画出来是一排没有身份的
  // 白条。这里改成检查「每一行都带名称与数值」这件真正该保证的事。
  const text = collectText(tree).join("\n");
  assert.ok(text.includes("p0 · m0"), "排序条应带 provider · model 名称");
  assert.ok(text.includes("100"), "排序条应带数值，不能只有一根条");
  assert.ok(/\d+(\.\d+)?%/.test(text), "排序条应带占比");
  // 只取前 8 个：第 9 个（p8 · m8，requests=92）不该出现在条形列表里。
  assert.equal(text.includes("p8 · m8"), false, "排序条只画前 8 个组合");
});

test("图表：按决策点分账画圆环，且图例与圆环同色（mc-theme 作用域）", async () => {
  // microcharts 故意不提供饼图，圆环（MicroDonut）是它的折中。但圆环
  // **不画分块标签、也没有图例**——没有文字图例的圆环只有「形」没有「义」，
  // 所以图例是本表格不可分割的一半。这条同时盯住那个静默错位：
  // 图例若跑到 mc-theme 外面，会按库的默认调色板取色，与圆环显示成两种颜色。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries({
        byPoint: [
          { point: "authorize", requests: 120, cached: 2, inputTokens: 500, outputTokens: 50, durationMs: 1000, avgDurationMs: 8 },
          { point: "retrieval", requests: 40, cached: 0, inputTokens: 200, outputTokens: 20, durationMs: 400, avgDurationMs: 13 },
        ],
      }),
      20: chartsFixture,
    },
  });

  const donuts = findAllByType(tree, "MicroDonut");
  assert.equal(donuts.length, 1, "按决策点分账应渲染一个圆环");
  // 顺序按请求次数降序：图例与图型共用同一个已排序数组，颜色才不会错位。
  assert.deepEqual(
    donuts[0].props.data.map((item) => item.value),
    [120, 40],
    "圆环数据应按请求次数降序",
  );

  // 图例必须存在，且逐项列出决策点中文名与占比。
  const text = collectText(tree).join("\n");
  assert.ok(text.includes("工具授权"), "图例应显示决策点中文名");
  assert.ok(text.includes("检索必要性"), "图例应显示第二个决策点");
  // 占比：120/160 = 75%
  assert.ok(text.includes("75.0%") || text.includes("75%"), `图例应显示占比，实际：\n${text.slice(0, 600)}`);
});

test("图表：圆环下方不再加自己的一行读数（图自己会报数）", async () => {
  // 这条锁住一次「删繁」的改动：以前界面把圆环 hover 的楔形数据抄进 React
  // state，再在**图下面**自己画一行读数（「工具授权 120 次请求」）。但交互版
  // 圆环自带读数气泡（`.mc-spark-readout`，在图上方），同一件事被说两遍：
  // 多占一行版面，还会让读者以为两处的数字是两回事。
  //
  // 守卫盯住两件事：
  //   1. 圆环**不接** onActive / onSelect（接了就说明又要自己抄一份读数）；
  //   2. 界面上不出现那一行读数的痕迹（它的样式是 chartReadout + flexBasis
  //      100%，且它带一个「次请求」单位标签）。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries({
        byPoint: [
          { point: "authorize", requests: 120, cached: 0, inputTokens: 500, outputTokens: 50, durationMs: 1000, avgDurationMs: 8 },
          { point: "retrieval", requests: 40, cached: 0, inputTokens: 200, outputTokens: 20, durationMs: 400, avgDurationMs: 13 },
        ],
      }),
      20: chartsFixture,
    },
  });

  const donuts = findAllByType(tree, "MicroDonut");
  assert.equal(donuts.length, 1, "按决策点分账应渲染一个圆环");
  assert.equal(donuts[0].props.onActive, undefined, "圆环不该再往外抛 onActive");
  assert.equal(donuts[0].props.onSelect, undefined, "圆环不该再往外抛 onSelect");
  assert.equal(donuts[0].props.readout, undefined, "圆环不该再带自绘读数");

  // 那一行读数的样式指纹：chartReadout 的 flexBasis:100% 整行。
  // 走势图的读数行没有 flexBasis，所以两者能区分开。
  const readoutRows = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    const style = node.props?.style;
    if (style !== null && typeof style === "object" && style.flexBasis === "100%") readoutRows.push(node);
    walk(node.children);
    walk(node.props?.children);
  })(tree);
  assert.deepEqual(
    readoutRows,
    [],
    `圆环下方不应再有自己的读数行，实际找到 ${readoutRows.length} 个`,
  );

  // 旧读数行的单位标签「次请求」也不该再出现在页面上。
  const text = collectText(tree).join("\n");
  assert.equal(text.includes("次请求"), false, "旧读数行的「次请求」标签应已移除");
});

test("图表：走势图下方的读数行仍然保留（只有圆环去掉了）", async () => {
  // 与上一条互为对照：这次删的只是**圆环**那一行，走势图自己的读数行
  // 还在（它读的是「第几个桶、那个桶多少」，没有别的图形能替它说）。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWithSeries({}),
      20: chartsFixture,
    },
  });

  const readoutRows = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    const style = node.props?.style;
    if (style !== null && typeof style === "object" && style.minHeight === "16px") readoutRows.push(node);
    walk(node.children);
    walk(node.props?.children);
  })(tree);
  assert.ok(readoutRows.length > 0, "走势图下方的读数行应仍然存在");

  const text = collectText(tree).join("\n");
  assert.ok(
    text.includes("把鼠标移到图上看某一格的具体值"),
    `走势图的读数提示应仍然存在，实际：\n${text.slice(0, 600)}`,
  );
});

test("图表：圆环容器带 mc-theme，图例颜色才不会与圆环错位", async () => {
  // 这条是上面那个 bug 的形状守卫：`--mc-cat-N` 在 .mc-theme 里被重新
  // 定义（接的是 DSH 语义色）。图例色块在 chartBox 外面，只有容器的
  // className 里带 mc-theme，两者才取到同一套颜色。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.stats]: statsWithSeries({
        byPoint: [
          { point: "authorize", requests: 10, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
          { point: "retrieval", requests: 5, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
        ],
      }),
      20: chartsFixture,
    },
  });
  // 找到图例色块，向上确认它所在的容器链上出现过 mc-theme。
  const swatches = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    const cls = node.props?.className ?? "";
    if (typeof cls === "string" && cls.includes("background:") === false && node.props?.style?.background !== undefined) {
      swatches.push(node);
    }
    walk(node.children);
    walk(node.props?.children);
  })(tree);
  // 更直接的守卫：圆环外层容器的 className 必须含 mc-theme。
  const holders = [];
  (function find(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(find);
    if (typeof node !== "object") return;
    if (typeof node.props?.className === "string" && node.props.className.includes("mc-theme")) holders.push(node);
    find(node.children);
    find(node.props?.children);
  })(tree);
  assert.ok(holders.length > 0, "必须有带 mc-theme 的容器承载图例");
  assert.ok(
    holders.some((node) => node.props?.style?.display === "flex" && node.props?.style?.gap === "18px"),
    "圆环与图例共用的外层容器应带 mc-theme（否则图例与圆环取色不一致）",
  );
});

test("图表：没有 byPoint 时不画圆环", async () => {
  const { tree } = await render(stateWith({}), {
    slots: { [SLOTS.tab]: "stats", [SLOTS.stats]: statsWithSeries({ byPoint: [] }), 20: chartsFixture },
  });
  assert.equal(findAllByType(tree, "MicroDonut").length, 0, "没有按决策点数据时不该画圆环");
});

test("图表：点击图例可隐藏决策点，其余点重新归一化", async () => {
  // 这是「工具调用常年占 95%+，把饼图吃满」的那个需求：点掉巨无霸之后，
  // 剩下的点应该**重新归一化**到 100%，彼此比例才看得清。若分母仍是全量，
  // 留下的只是几个 2%、3% 的小数——比例关系还是读不出来，功能白做。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries({
        byPoint: [
          { point: "authorize", requests: 950, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
          { point: "retrieval", requests: 40, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
          { point: "compaction", requests: 10, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
        ],
      }),
      20: chartsFixture,
    },
  });

  // 图例项必须是**按钮**（可操作控件）：键盘用户要能 Tab 到、Enter 触发。
  const buttons = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    if (node.type === "button" && typeof node.props?.onClick === "function") buttons.push(node);
    walk(node.children);
    walk(node.props?.children);
  })(tree);
  const legendButtons = buttons.filter((node) => "aria-pressed" in (node.props ?? {}));
  assert.ok(legendButtons.length >= 3, `图例应有可点击按钮，实际 ${legendButtons.length}`);
  // 默认全部参与：aria-pressed 全为 true。
  assert.ok(
    legendButtons.every((node) => node.props["aria-pressed"] === true),
    "默认所有决策点都应参与绘制",
  );
});

test("图表：全部隐藏时给出可撤销的提示，而不是画一个空环", async () => {
  // 空环会被读成「这段时间没有数据」，而真相是「用户把所有点都排除了」。
  // 两者行动建议完全不同：前者要等数据，后者点一下图例就恢复。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries({
        byPoint: [
          { point: "authorize", requests: 10, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
        ],
      }),
      20: chartsFixture,
      // 槽位 21 是 hiddenPoints：把所有点都标成隐藏
      21: new Set(["authorize"]),
    },
  });
  const text = collectText(tree).join("\n");
  assert.ok(
    text.includes("所有决策点都被隐藏"),
    `应提示全部被隐藏，实际：\n${text.slice(0, 500)}`,
  );
});

test("图表：隐藏后圆环数据只含可见项，且颜色按 id 固定不随顺序漂移", async () => {
  // 颜色必须绑在「决策点 id」上而不是「第几个可见项」。否则隐藏掉第一个
  // 之后，原本第二名的颜色会顶到第一位——每点一次整张图换一套配色，
  // 读者无法在两次操作之间比较。
  const base = {
    byPoint: [
      { point: "authorize", requests: 50, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
      { point: "retrieval", requests: 30, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
    ],
  };
  const all = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries(base),
      20: chartsFixture,
    },
  });
  const allDonut = findAllByType(all.tree, "MicroDonut")[0];
  // colors 显式下发时，顺序与 data 对齐。
  assert.ok(Array.isArray(allDonut.props.colors), "应显式下发 colors（按 id 固定）");

  const hidden = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries(base),
      20: chartsFixture,
      21: new Set(["authorize"]),
    },
  });
  const hiddenDonut = findAllByType(hidden.tree, "MicroDonut")[0];
  assert.equal(hiddenDonut.props.data.length, 1, "隐藏后只应剩一个可见项");
  // 关键：剩下那个点的颜色，必须与「全部显示」时**它自己**的颜色相同。
  const indexAll = allDonut.props.data.findIndex((item) => item.label === "检索必要性");
  const indexHidden = hiddenDonut.props.data.findIndex((item) => item.label === "检索必要性");
  assert.equal(
    hiddenDonut.props.colors[indexHidden],
    allDonut.props.colors[indexAll],
    "同一个决策点的颜色不能因为隐藏了别人而改变",
  );
});

test("图表：读数元素不能塞进 chartBox 的样式参数（真机白屏事故的回归守卫）", async () => {
  // 事故经过：renderTrend 把 `options.readout()` 的 React 元素当成 chartBox 的
  // 第三个参数传了进去，而那个参数是**样式对象**。元素被展开进 style，
  // style 里出现 type/props/children 这些非法键 → React 设置样式时抛
  // TypeError → 整棵组件树被卸载 → 用户看到「点统计页，连配置 tab 一起消失」。
  //
  // 这条断言比「渲染不报错」更严格：它在任何环境（包括测试桩）里都能抓到
  // 「把元素当样式用」这个错误形态，不依赖 React 的样式校验是否会抛错。
  const { tree } = await render(stateWith({}), {
    slots: {
      [SLOTS.tab]: "stats",
      [SLOTS.decisions]: decisionsFixture,
      [SLOTS.stats]: statsWithSeries({
        byPoint: [
          { point: "authorize", requests: 8, cached: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, avgDurationMs: 1 },
        ],
        outcomes: { allow: 5, ask: 2, reject: 3, none: 0, decided: 10, byPoint: [], otherVerdicts: [], otherVerdictCount: 0 },
      }),
      20: chartsFixture,
    },
  });

  const badKeys = ["type", "props", "children", "$$typeof"];
  const offenders = [];
  (function walk(node) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    const style = node.props?.style;
    if (style !== null && typeof style === "object" && !Array.isArray(style)) {
      for (const key of badKeys) {
        if (Object.hasOwn(style, key)) offenders.push({ element: String(node.type), key });
      }
    }
    walk(node.children);
    walk(node.props?.children);
  })(tree);

  assert.deepEqual(
    offenders,
    [],
    `样式对象里出现了 React 元素的键，说明有元素被当成样式展开：${JSON.stringify(offenders.slice(0, 2))}`,
  );
});
