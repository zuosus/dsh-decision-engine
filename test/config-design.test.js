/** Configuration design acceptance: same module-loader/React SSR stub as client-ui. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { providerCatalog } from "../lib/providers.js";

const cssPath = new URL("../lib/client.config.css", import.meta.url);
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
let loadSeq = 0;
const status = {
  enabled: true, mode: "shadow", provider: "systemone", providerValid: true,
  providerLabel: "systemone", providerError: "", providerCatalog: providerCatalog(),
  baseUrl: "https://api.typesafe.ai/v1/decisions", rawBaseUrl: "https://api.typesafe.ai/v1",
  customBaseUrl: "", customEndpointStyle: "auto", customModel: "", customHeaders: "",
  customApiKeyEnv: "", customKeyConfigured: false, model: "自动（服务端默认）",
  rawModel: "", rawModels: {}, thinkMode: "never", timeoutMs: 8000,
  keyConfigured: true, keyStorage: "credentials", keyStatus: {},
  stats: { requests: 0, cached: 0 }, serverProvider: { enabled: false, status: "idle" },
};

async function render(slots = {}) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const states = { 0: status, 4: false, ...slots };
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
  const unique = `${source}\n// config-design-${++loadSeq}\n`;
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
const hasClass = (node, name) => (node.props?.className ?? "").split(/\s+/).includes(name);
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object") return text(node.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function associatedLabel(root, control) {
  const ids = String(control.props["aria-labelledby"] ?? "").trim().split(/\s+/).filter(Boolean);
  assert.ok(ids.length, "control must have aria-labelledby");
  const labels = ids.map((id) => nodes(root, (node) => node.props.id === id));
  labels.forEach((matches) => assert.equal(matches.length, 1, "label ID must resolve uniquely"));
  assert.ok(labels.some(([label]) => text(label).trim()), "associated label must be readable");
  return labels.flat();
}

// Extract balanced at-rule bodies rather than depending on formatting or breakpoint spelling.
function atRuleBodies(source, pattern) {
  const bodies = [];
  for (const match of source.matchAll(pattern)) {
    const start = source.indexOf("{", match.index);
    let depth = 1;
    let end = start + 1;
    for (; end < source.length && depth; end++) {
      if (source[end] === "{") depth++;
      if (source[end] === "}") depth--;
    }
    bodies.push(source.slice(start + 1, end - 1));
  }
  return bodies;
}

test("default config root exposes de-settings scope", async () => {
  const root = await render();
  assert.ok(hasClass(root, "de-settings"), "config root is missing className de-settings");
});

test("provider row owns its grid of labelled buttons", async () => {
  const root = await render();
  const row = nodes(root, (node) => hasClass(node, "de-cfg__row") && node.props["data-field"] === "provider")[0];
  assert.ok(row, "provider row missing de-cfg__row / data-field=provider");
  const grid = nodes(row, (node) => hasClass(node, "de-cfg__provider-grid"))[0];
  assert.ok(grid, "provider row missing de-cfg__provider-grid");
  const buttons = nodes(grid, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed"));
  assert.ok(buttons.length > 1, "provider grid must render one button per provider");
  assert.ok(buttons.some((button) => text(button).includes("custom")),
    "provider grid must preserve the custom provider button");
  const selected = buttons.find((button) => button.props["aria-pressed"] === true);
  assert.ok(selected && text(selected).includes("System One"), "default selected provider must be System One");
  for (const button of buttons) {
    const labels = associatedLabel(root, button);
    assert.ok(labels.some((label) => nodes(row).includes(label)), "provider button label must belong to its row");
    assert.ok(labels.some((label) => text(label).includes("服务提供方")), "button must name its row title");
  }
});

test("config toggles have readable, unique aria-labelledby targets", async () => {
  const root = await render();
  const toggles = nodes(root, (node) => Object.hasOwn(node.props, "aria-pressed") || node.props.role === "switch");
  assert.ok(toggles.length, "default configuration must render toggles");
  for (const toggle of toggles) associatedLabel(root, toggle);
});

test("static configuration stylesheet uses scoped semantic spacing tokens", () => {
  assert.match(css, /\.de-settings\b/, "static CSS must have a de-settings scope");
  assert.match(css, /--de-space-2\s*:/, "static CSS must define semantic spacing token --de-space-2");
});

test("single-file loader embeds the static stylesheet without drift", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const embedded = source.match(/const CFG_SECTION_CSS\s*=\s*`([\s\S]*?)`;/);
  assert.ok(embedded, "single-file client must retain its static CSS injection source");
  assert.equal(embedded[1].trim(), css.trim(), "embedded configuration CSS must match client.config.css");
});

test("narrow container stacks config rows and collapsed bodies remain hidden", () => {
  const narrow = atRuleBodies(css, /@container\b[^{}]*(?:max-width|width\s*<)[^{}]*\{/g);
  assert.ok(narrow.length, "configuration needs a narrow container query");
  assert.ok(narrow.some((body) =>
    /\.de-cfg__row\b[^{}]*\{[^{}]*flex-direction\s*:\s*column\b/.test(body)
    || /\.de-cfg__text[^{}]*\.de-cfg__control[^{}]*\{[^{}]*grid-column\s*:\s*1\s*\/\s*-1/.test(body)),
    "narrow container must stack config rows vertically (flex column or full-width grid children)");
  assert.match(css, /\.de-settings[^{}]*\[hidden\][^{}]*\{[^{}]*display\s*:\s*none\b/,
    "scoped hidden bodies must keep display:none despite flex layout");
});

test("configuration CSS includes visible keyboard focus and reduced motion", () => {
  assert.match(css, /\.de-settings[^{}]*:focus-visible\s*\{[^{}]*(?:outline|box-shadow)\s*:/,
    "scoped focus-visible must provide a visible focus indicator");
  const reduced = atRuleBodies(css, /@media\b[^{}]*prefers-reduced-motion\s*:\s*reduce[^{}]*\{/g);
  assert.ok(reduced.some((body) => /(?:transition|animation)(?:-duration)?\s*:\s*(?:none|0(?:s|ms)?)/.test(body)),
    "reduced-motion query must disable or reduce movement");
});

test("configuration stylesheet removes old multicolour icon tone backgrounds", () => {
  assert.ok(css.trim(), "configuration stylesheet must exist before testing absence");
  assert.doesNotMatch(css, /\.de-cfg__section-ic--(?:business|success|warn|neutral)[^{}]*\{[^{}]*background\s*:/,
    "old per-tone icon backgrounds must not survive the redesign");
  assert.doesNotMatch(css, /--de-cfg-tone\s*:\s*color-mix/,
    "old multicolour section tone variables must not survive the redesign");
});

test("服务提供方用 grid 线框 buttons 渲染在标题与说明之间，选中高亮反色", async () => {
  const root = await render();
  const row = nodes(root, (node) => hasClass(node, "de-cfg__row") && node.props["data-field"] === "provider")[0];
  assert.ok(row, "provider row missing de-cfg__row / data-field=provider");

  // grid 容器是标题与 hint 之间的兄弟节点（不是塞进右侧 control）。
  const textCol = nodes(row, (node) => hasClass(node, "de-cfg__text"))[0];
  assert.ok(textCol, "provider row missing de-cfg__text");
  const children = (textCol.children ?? []).filter((node) => node !== null && typeof node === "object");
  const label = children.find((node) => hasClass(node, "de-cfg__label"));
  const hint = children.find((node) => hasClass(node, "de-cfg__hint"));
  const grid = children.find((node) => hasClass(node, "de-cfg__provider-grid"));
  assert.ok(grid, "provider grid must live between the title and the desc");
  assert.ok(children.indexOf(grid) > children.indexOf(label) && children.indexOf(grid) < children.indexOf(hint),
    "provider grid must be placed between the title and the desc");

  // 每个 provider 一个 button，选中态用 aria-pressed 表达；选中项高亮反色由 CSS 承担。
  const buttons = nodes(grid, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed"));
  assert.equal(buttons.length, status.providerCatalog.length,
    `按钮数应等于 provider 清单长度 ${status.providerCatalog.length}，实际 ${buttons.length}`);
  const pressed = buttons.filter((node) => node.props["aria-pressed"] === true);
  assert.equal(pressed.length, 1, "exactly one provider button must be selected");
  assert.ok(text(pressed[0]).includes("System One"), "default selected provider must be System One");
  for (const button of buttons) assert.equal(typeof button.props.onClick, "function", "provider button must be clickable");
  assert.match(css, /\.de-cfg__provider-grid\b[^{}]*\{[^{}]*grid-template-columns\s*:/,
    "provider grid must use CSS grid for its wireframe buttons");
  assert.match(css, /\[aria-pressed="true"\]/,
    "selected provider button must be styled via aria-pressed=true");
});

test("provider 已在别处配好 key 的按钮右侧显示小字「已配置Key」", async () => {
  const root = await render({ 0: { ...status, keyStatus: { ...status.keyStatus, siliconflow: { configured: true } } } });
  const buttons = nodes(root, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed") && text(node).includes("硅基流动"));
  assert.ok(buttons.length >= 1, "should render a 硅基流动 provider button");
  assert.ok(text(buttons[0]).includes("已配置Key"), "configured provider button should show 已配置Key badge");
  const systemone = nodes(root, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed") && text(node).includes("System One"))[0];
  assert.ok(systemone && !text(systemone).includes("已配置Key"), "unconfigured provider button must not show the badge");
});

test("模型 picker 改成标题与说明之间的 grid 按钮，含自动项与候选项", async () => {
  const root = await render({ 9: [{ id: "Kev-4B" }, { id: "SemIf" }], 10: "ok" });
  const row = nodes(root, (node) => hasClass(node, "de-cfg__row") && node.props["data-field"] === "model")[0];
  assert.ok(row, "model row missing");
  const textCol = nodes(row, (node) => hasClass(node, "de-cfg__text"))[0];
  const children = (textCol.children ?? []).filter((node) => node !== null && typeof node === "object");
  const label = children.find((node) => hasClass(node, "de-cfg__label"));
  const hint = children.find((node) => hasClass(node, "de-cfg__hint"));
  const grid = children.find((node) => hasClass(node, "de-cfg__model-grid"));
  assert.ok(grid, "model grid must live between title and desc");
  assert.ok(children.indexOf(grid) > children.indexOf(label) && children.indexOf(grid) < children.indexOf(hint),
    "model grid must be placed between title and desc");
  const buttons = nodes(grid, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed"));
  // 自动 + 两个候选项（无 custom 输入框时）
  assert.equal(buttons.length, 3, `应有 自动+Kev-4B+SemIf 三个按钮，实际 ${buttons.length}`);
  assert.ok(text(buttons[0]).includes("自动"), "第一个按钮应为自动项");
  assert.equal(buttons.filter((b) => b.props["aria-pressed"] === true).length, 1, "only one model selected");
});

test("密钥保存位置 picker 改成标题与说明之间的 grid 按钮", async () => {
  const root = await render();
  const row = nodes(root, (node) => hasClass(node, "de-cfg__row") && node.props["data-field"] === "keyStorage")[0];
  assert.ok(row, "keyStorage row missing");
  const textCol = nodes(row, (node) => hasClass(node, "de-cfg__text"))[0];
  const children = (textCol.children ?? []).filter((node) => node !== null && typeof node === "object");
  const label = children.find((node) => hasClass(node, "de-cfg__label"));
  const hint = children.find((node) => hasClass(node, "de-cfg__hint"));
  const grid = children.find((node) => hasClass(node, "de-cfg__storage-grid"));
  assert.ok(grid, "storage grid must live between title and desc");
  assert.ok(children.indexOf(grid) > children.indexOf(label) && children.indexOf(grid) < children.indexOf(hint),
    "storage grid must be placed between title and desc");
  const buttons = nodes(grid, (node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed"));
  assert.equal(buttons.length, 2, "应有 credentials 与 config 两个按钮");
  assert.equal(buttons.filter((b) => b.props["aria-pressed"] === true).length, 1, "only one storage selected");
  assert.ok(text(buttons[0]).includes(".credentials.yaml"), "默认应高亮 .credentials.yaml");
});

test("决策模型参与点三态按钮有 scoped CSS 框线与选中态（DEC-085）", () => {
  // 回归：DEC-070 的通用 `button:not([aria-pressed]) { background: transparent !important }`
  // 覆盖了三态按钮的内联选中色，按钮本身又没有真正的边框——三态成了一排纯文本。
  // 现在三态按钮带 de-cfg__seg / de-cfg__seg-item 类与 aria-pressed，样式交给 CSS。
  assert.match(css, /\.de-settings\s+\.de-cfg__seg\b[^{}]*\{[^{}]*display\s*:\s*inline-flex\b/,
    "三态按钮容器要有 scoped inline-flex 布局规则");
  assert.match(css, /\.de-cfg__seg-item\b[^{}]*\{[^{}]*border\s*:\s*1px\s+solid\b/,
    "三态按钮要有可见边框（不能只靠内联 border:none）");
  assert.match(css, /\.de-cfg__seg-item\[aria-pressed="true"\]/,
    "选中态必须由 aria-pressed=true 在 scoped CSS 里画出来");
  assert.match(css, /\.de-cfg__seg-item\[aria-pressed="true"\]\[data-tone="enforce"\]/,
    "生效模式要有自己的强调色（沿用原来的绿/琥珀语义）");
});

test("failed autosave is readable inside config root, retryable, and announced", async () => {
  const failure = "未保存：磁盘写入失败";
  const root = await render({ 18: { error: failure } });
  assert.ok(text(root).includes(failure), "save failure must remain readable inside config root");
  const retry = nodes(root, (node) => node.type === "button" && text(node).includes("重试"))[0];
  assert.ok(retry, "save failure must offer a retry button");
  assert.equal(typeof retry.props.onClick, "function", "retry must retain its action");
  assert.notEqual(retry.props.disabled, true, "retry must be enabled when idle");
  const live = nodes(root, (node) => ["status", "alert"].includes(node.props.role));
  assert.ok(live.some((node) => text(node).includes(failure)), "save failure needs role=status or role=alert");
});
