/**
 * 「人工审核比例」控件的**设计验收**（DEC-088 立底，DEC-095 改 iOS 式分段控件）。
 *
 * 为什么单独一个文件：`client-ui.test.js` 只检查文案与 aria-pressed，
 * `config-design.test.js` 只守配置页的 provider / 模型 picker。滑块曾经用
 * 内联硬编码的靛蓝圆点和一条穿过所有圆点的细线来画——配色在宿主主题切换时
 * 不跟随、细线穿过未选中圆点显得廉价——而这两件事在现有测试里全是绿的。
 *
 * 硬要求：
 *   1. 四档按钮带 `de-tolerance__stop` 类，选中态走 `aria-pressed=true`；
 *   2. 渲染树里没有 `de-tolerance__rail` 轨道横线，不再有东西穿过圆点；
 *   3. 颜色、边框、圆角、间距全部交给 `client.config.css` 的宿主语义令牌，
 *      分片源码里不再出现 `#818cf8` / `#6366f1` / `rgba(128,128,128,…)`；
 *   4. CSS 是 **iOS 式分段控件**（DEC-095）：整组共一条外框与圆角，段与段
 *      **挨着**（gap: 0，没有独立线框按钮之间的缝隙），段间只有一条分隔线；
 *      紧贴选中段的分隔线透明（选中块连成整片），首末段圆角贴合外框；
 *      选中态仍用 `--de-accent` 反色，颜色仍走宿主语义令牌。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../lib/client.config.css", import.meta.url), "utf8");
const BUNDLE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let loadSeq = 0;

const tolerance = {
  level: "default",
  levels: ["autonomous", "relaxed", "default", "cautious"],
  presets: [
    { id: "autonomous", label: "自治", summary: "自治：从不询问用户", percentile: null },
    { id: "relaxed", label: "轻松", summary: "轻松：只问最前 1%", percentile: 0.99 },
    { id: "default", label: "默认", summary: "默认：沿用模型判断", percentile: null },
    { id: "cautious", label: "谨慎", summary: "谨慎：再多问 25%", percentile: 0.75 },
  ],
  calibration: { samples: 0, ready: false, minSamples: 50, fallbackSeverity: null },
};
const decisions = {
  points: [],
  modes: ["off", "observe", "enforce"],
  cache: { size: 0 },
  tolerance,
};
const status = {
  enabled: true, mode: "shadow", provider: "systemone", providerValid: true,
  providerCatalog: [], baseUrl: "https://example.test", rawBaseUrl: "https://example.test",
  customBaseUrl: "", customEndpointStyle: "auto", customModel: "", customHeaders: "",
  customApiKeyEnv: "", customKeyConfigured: false, model: "自动", rawModel: "",
  rawModels: {}, thinkMode: "never", timeoutMs: 8000,
  keyConfigured: true, keyStorage: "credentials", keyStatus: {},
  stats: { requests: 0, cached: 0 }, serverProvider: { enabled: false, status: "idle" },
};

async function renderConfig() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const states = { 0: status, 11: decisions };
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
    useSyncExternalStore: (_s, _g, getServerSnapshot) =>
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
  await import(`data:text/javascript;base64,${
    Buffer.from(source + `\n// tolerance-design-${++loadSeq}\n`, "utf8").toString("base64")
  }`);
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

test("配置页四档渲染为带类名的分段按钮，且只有一档选中", async () => {
  const root = await renderConfig();
  const stops = nodes(root, (node) => node.type === "button" && hasClass(node, "de-tolerance__stop"));
  assert.equal(stops.length, 4, `应有四个分段按钮，实际 ${stops.length}`);
  const active = stops.filter((node) => node.props["aria-pressed"] === true);
  assert.equal(active.length, 1, "只能有一个选中档位");
  assert.equal(nodes(root, (node) => node.props["aria-pressed"] === undefined && node.props.className === "de-tolerance__rail").length, 0,
    "不应再渲染贯穿圆点的轨道横线");
});

test("轨道横线与内联硬编码颜色已从源码移除", () => {
  for (const key of ["toleranceRail", "toleranceDot", "toleranceLabel", "toleranceStop"]) {
    assert.equal(new RegExp(`\\b${key}\\b`, "m").test(BUNDLE), false,
      `bundle 里仍残留旧的 ${key} 内联样式`);
  }
  assert.equal(/toleranceRail/.test(CSS), false, "CSS 里不该有轨道横线");
  // 旧滑块样式专属的硬编码配色（#818cf8 圆点 / #6366f1 实心）不该再出现
  // 在滑块组件附近；bundle 其它地方（审批卡按钮）的配色不在本条管辖范围。
  const sliderSource = BUNDLE.slice(
    BUNDLE.indexOf("function ToleranceSlider"),
    BUNDLE.indexOf("function providerText"),
  );
  for (const color of ["#818cf8", "#6366f1", "rgba(128,128,128"]) {
    assert.equal(sliderSource.includes(color), false, `滑块组件里仍有硬编码配色 ${color}`);
  }
});

test("CSS 用宿主语义令牌画 iOS 式分段控件：共一条外框、段间只留分隔线", () => {
  // 规则体提取：给选择器行的**字面量**（含结尾的逗号或空格，保证唯一），
  // 返回它第一条规则的正文（不含花括号）。
  const rule = (selectorLiteral) => {
    const index = CSS.indexOf(selectorLiteral);
    assert.ok(index >= 0, `CSS 缺少 ${selectorLiteral}`);
    const open = CSS.indexOf("{", index);
    const close = CSS.indexOf("}", open);
    assert.ok(open >= 0 && close > open, `规则 ${selectorLiteral} 没有闭合的花括号`);
    return CSS.slice(open + 1, close);
  };

  // —— 令牌定义在 .de-tolerance 自己身上：这样「决策」会话页（不在
  // .de-settings 外壳里）也能拿到同一套语义色。这一条沿用 DEC-088。
  const container = rule(".de-settings .de-tolerance, .de-tolerance {");
  for (const token of ["--de-border", "--de-accent", "--de-muted", "--de-surface", "--de-text"]) {
    assert.match(container, new RegExp(`${token}:\\s*var\\(--dsw-alias-`),
      `${token} 必须映射到宿主语义变量`);
  }
  assert.match(container, /--de-radius:\s*\d+px/, "圆角令牌有具体像素值");

  // —— 外框在容器上，且段与段**挨着**：这是 iOS 分段控件与「独立线框按钮」
  // 的分水岭。gap 必须为 0（有缝隙就不是挨着），整组只画一条边框一个圆角。
  const stops = rule(".de-settings .de-tolerance__stops, .de-tolerance__stops {");
  assert.match(stops, /gap:\s*0\s*;?/, "分段之间不留缝隙：按钮必须挨着（iOS 式分段控件）");
  assert.match(stops, /border\s*:\s*1px\s+solid\s+var\(--de-border\)/, "整组共一条外框");
  assert.match(stops, /border-radius:\s*var\(--de-radius\)/, "外框圆角走 --de-radius");

  // —— 段本身不再有自己的外框与圆角（否则相邻边框会叠成 2px，圆角之间露缝）。
  const stop = rule(".de-settings .de-tolerance__stop, .de-tolerance__stop {");
  assert.match(stop, /border\s*:\s*none/, "档位不画独立外框");
  assert.match(stop, /border-radius:\s*0/, "中间档位不各自圆角");
  assert.match(stop, /white-space:\s*nowrap/, "档位标签不换行");

  // —— 段间只剩一条分隔线：非首段左边框（1px，语义边框色）。
  const divider = rule(".de-settings .de-tolerance__stop + .de-tolerance__stop,");
  assert.match(divider, /border-left\s*:\s*1px\s+solid\s+var\(--de-border\)/,
    "相邻档位之间画一条分隔线");

  // —— 首末段的圆角贴合外框内侧：半径 = --de-radius 减掉 1px 外框。
  const first = rule(".de-settings .de-tolerance__stop:first-child,");
  const last = rule(".de-settings .de-tolerance__stop:last-child,");
  assert.match(first, /calc\(var\(--de-radius\)\s*-\s*1px\)/, "首段左侧圆角贴合外框");
  assert.match(last, /calc\(var\(--de-radius\)\s*-\s*1px\)/, "末段右侧圆角贴合外框");

  // —— 选中态：仍用 --de-accent 反色（与 picker 同一语言），且紧贴它的两条
  // 分隔线透明（iOS 行为：选中段是连成整片的一块，不被线切成两半）。
  const active = rule('.de-settings .de-tolerance__stop[aria-pressed="true"],');
  assert.match(active, /var\(--de-accent\)/, "选中态用 --de-accent");
  assert.match(active, /var\(--dsw-alias-state-business-contrast/, "选中态文字用宿主 contrast 变量");
  assert.match(active, /border-left-color:\s*transparent/, "选中段左边的分隔线隐藏");
  const afterActive = rule('.de-settings .de-tolerance__stop[aria-pressed="true"] + .de-tolerance__stop,');
  assert.match(afterActive, /border-left-color:\s*transparent/, "选中段右边的分隔线隐藏");
});
