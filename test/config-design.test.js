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

test("provider row owns its original select through a labelled control wrapper", async () => {
  const root = await render();
  const row = nodes(root, (node) => hasClass(node, "de-cfg__row") && node.props["data-field"] === "provider")[0];
  assert.ok(row, "provider row missing de-cfg__row / data-field=provider");
  const control = nodes(row, (node) => hasClass(node, "de-cfg__control"))[0];
  assert.ok(control, "provider row missing de-cfg__control wrapper");
  const select = nodes(control, (node) => node.type === "select")[0];
  assert.ok(select, "control wrapper must contain the existing provider select");
  assert.equal(select.props.value, "systemone");
  assert.ok(nodes(select, (node) => node.type === "option" && node.props.value === "custom").length,
    "provider select must preserve custom provider option");
  const labels = associatedLabel(root, select);
  assert.ok(labels.some((label) => nodes(row).includes(label)), "select label must belong to its row");
  assert.ok(labels.some((label) => text(label).includes("服务提供方")), "select must name its row title");
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
