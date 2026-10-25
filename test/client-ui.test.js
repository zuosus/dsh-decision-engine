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

/** 每次加载都要拿到一份新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/**
 * 渲染配置页。
 *
 * @param status - 第 0 个 useState（status）要返回的值；null 表示「状态未加载」。
 * @returns `{ text, controls }`：全部文本，以及 input/select 节点。
 */
async function render(status) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 加一段唯一注释再转 data URL：内容是变量 → 模块标识不同 → factory 会重新执行。
  loadSeq += 1;
  const unique = `\n// test-instance-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  let stateIndex = 0;
  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = stateIndex;
      stateIndex += 1;
      if (index === 0) return [status, () => {}];
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
          locale: { register: () => () => {} },
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
      },
    },
  };

  await import(dataUrl);
  assert.ok(typeof component === "function", "client bundle 未注册配置组件");

  const tree = component({ view: "config" });
  return { tree, text: collectText(tree).join("\n"), controls: collectControls(tree) };
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
      model: "",
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
      custom: {
        configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", keyField: "customApiKey",
        source: "none", sourceLabel: "未配置",
      },
    },
    stats: { requests: 0, cached: 0 },
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
  const toggleButton = findNode(tree, (node) => node.type === "button" && node.props["aria-pressed"] !== undefined);
  assert.ok(toggleButton !== undefined && toggleButton !== null, "没有找到开关按钮");
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
  const { tree } = await render(stateWith({ provider: "bamboonode" }));
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
  assert.equal(body.bamboonodeApiKey, "sk-test-1234567890", `patch 应带上密钥，实际：${configCall.init.body}`);
  // 只写当前 provider 那一格：切 provider 不会把 A 的 key 存到 B 名下。
  assert.equal(Object.hasOwn(body, "systemoneApiKey"), false, "不该写其它 provider 的 key 字段");
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
  assert.equal(Object.hasOwn(body, "model"), false, "不该写 bamboonode 的模型字段");
  assert.equal(Object.hasOwn(body, "customModel"), false, "不该写 custom 的模型字段");
});

test("服务端没给 provider 字段映射时绝不猜格子：宁可延后也不写", async () => {
  // 模拟「status 还没回来」：catalog 为空 → 前端不知道模型与 key 该写哪一格。
  // 猜一个名字就会把 siliconflow 的 key 存进 bamboonode 的格子——正是
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
  const bamboo = await render(stateWith({ provider: "bamboonode", providerLabel: "bamboonode" }));
  assert.ok(bamboo.text.includes("BAMBOO_API_KEY"), "bamboonode 没显示自己的 key 名");

  const systemOne = await render(
    stateWith({ provider: "systemone", providerLabel: "system one", baseUrl: "https://api.typesafe.ai/v1/systemone" }),
  );
  assert.ok(systemOne.text.includes("TYPESAFE_API_KEY"), "system one 没显示自己的 key 名");
  assert.equal(
    systemOne.text.includes("BAMBOO_API_KEY"),
    false,
    "system one 界面不应出现 bamboonode 的 key 名",
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
  // 全局 setter 不在本文件声明，但可以调用。
  const globals = new Set(["setTimeout", "setInterval", "setImmediate"]);
  const dangling = new Set();
  for (const match of code.matchAll(/(^|[^.\w$])(set[A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = match[2];
    if (!declared.has(name) && !globals.has(name)) dangling.add(name);
  }
  assert.deepEqual([...dangling], [], `client.js 引用了未定义的 setter：${[...dangling].join(", ")}`);
});
