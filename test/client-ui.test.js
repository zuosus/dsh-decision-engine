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

/** 一份带三个预设的服务端状态（模拟已加载）。 */
function stateWith(over) {
  return {
    enabled: true,
    mode: "shadow",
    provider: "bamboonode",
    providerLabel: "bamboonode",
    providerValid: true,
    providerError: "",
    providerCatalog: [
      { id: "systemone", label: "system one", baseUrl: "https://api.typesafe.ai/v1", hint: "System One 协议" },
      { id: "bamboonode", label: "bamboonode", baseUrl: "https://api.bamboonode.dev/v1", hint: "StartLux 官方端点" },
      { id: "custom", label: "custom", baseUrl: "", hint: "任意 system-one 风格服务" },
    ],
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
    thinkMode: "never",
    timeoutMs: 8000,
    keyConfigured: true,
    keyHint: "…abcd",
    keyEnvName: "BAMBOO_API_KEY",
    keyStorage: "credentials",
    keyStatus: {
      systemone: { configured: false, hint: "", refName: "TYPESAFE_API_KEY", source: "none" },
      bamboonode: { configured: true, hint: "…abcd", refName: "BAMBOO_API_KEY", source: "credentials" },
      custom: { configured: false, hint: "", refName: "DECISION_ENGINE_CUSTOM_KEY", source: "none" },
    },
    stats: { requests: 0, cached: 0 },
    ...over,
  };
}

// ---------------------------------------------------------------- 用例

test("状态未加载时也渲染出完整表单（不空白）", async () => {
  const { text } = await render(null);
  for (const label of ["服务提供方", "生效端点", "启用守卫", "真正拦截", "模型", "API Key", "保存", "测试端点"]) {
    assert.ok(text.includes(label), `缺少「${label}」：\n${text.slice(0, 400)}`);
  }
  // 兜底状态不得自带服务商地址：地址只能来自服务端下发的预设
  assert.equal(text.includes("bamboonode.dev"), false, "兜底状态硬编码了服务商地址");
});

test("provider 下拉包含全部预设，默认 bamboonode", async () => {
  const { controls } = await render(stateWith({}));
  const providerSelect = controls.find((node) => node.type === "select" && node.props.value === "bamboonode");
  assert.ok(providerSelect !== undefined, "没有找到 provider 下拉（或当前值不是 bamboonode）");
  const options = providerSelect.children
    .filter((child) => child !== null && typeof child === "object" && child.type === "option")
    .map((child) => child.props.value);
  assert.deepEqual(options, ["systemone", "bamboonode", "custom"]);
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
