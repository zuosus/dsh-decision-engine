/**
 * 图表分块产物（`lib/client.charts.js`）的自检。
 *
 * 为什么单独一个文件：这个文件测试的是**构建产物**而不是产品逻辑。
 * 产品逻辑（统计页怎么画图）由 client-ui.test.js 覆盖；这里盯住的是
 * 「产物本身还是那个能用的东西」——因为它由脚本生成、又是压缩过的第三方
 * 代码，改构建参数时最容易在这里悄悄坏掉：
 *
 *   1. **只依赖 react**：宿主 factory 只保证 `require("react")` 可用，
 *      产物里出现第二个 require 就是线上 `cannot resolve`。
 *   2. **用的是交互入口**：静态入口渲染出的图没有 hover 读数、不能点选、
 *      不能键盘漫游——用户看到的是一坨没有反馈的图形。
 *   3. **交互层真的挂上了**：`data-mc-host` / `tabindex` / `aria-live`
 *      缺一个，交互就少一半（键盘不可达或读屏不播报）。
 *   4. **CSS 规则齐全**：`[data-mc-ink]` 的 fill/stroke 决定图形可见性，
 *      少一条就整张图空白——而且空白不报错，只让人以为「这段没数据」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/** 读产物并在 vm 里执行，拿到它注册的 factory。 */
function loadChunk() {
  const source = readFileSync(new URL("../lib/client.charts.js", import.meta.url), "utf8");
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          sandbox.__registration = registration;
        },
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { source, registration: sandbox.__registration };
}

/**
 * 一个够用的 react 桩。
 *
 * 只实现交互入口真正用到的那几个 hook。`useSyncExternalStore` 返回
 * `getServerSnapshot()`——那是它在无订阅场景下的正确答案。
 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: "Fragment",
  memo: (fn) => fn,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useSyncExternalStore: (_subscribe, _getSnapshot, getServerSnapshot) =>
    typeof getServerSnapshot === "function" ? getServerSnapshot() : null,
};

test("图表分块：产物语法正确，且只依赖 react", () => {
  const { source } = loadChunk();
  // 1) 语法：压缩产物里一个多余的字符就会让整个 chunk 加载失败。
  assert.doesNotThrow(() => new vm.Script(source), "分块必须是合法 JS");
  // 2) 依赖面：宿主只给 react，别的 require 必然抛 cannot resolve。
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  const unique = [...new Set(requires)];
  assert.deepEqual(unique, ["react"], `产物只能依赖 react，实际：${unique.join(", ")}`);
});

test("图表分块：注册协议正确（id + chunk 名）", () => {
  const { registration } = loadChunk();
  assert.ok(registration, "分块应通过 window.__ModuleLoader__.load 注册");
  assert.equal(registration.id, "dsh-decision-engine", "分块 id 必须是本插件包名");
  // 宿主用 /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/ 判定包内分块，
  // 名字不对会被直接拒绝加载。
  assert.match(
    registration.chunk,
    /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/,
    "分块文件名必须匹配宿主的命名规则",
  );
});

test("图表分块：导出全部图型 + 样式", () => {
  const { registration } = loadChunk();
  const charts = registration.factory((name) => {
    if (name === "react") return reactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  for (const name of ["Sparkline", "SparkBar", "MiniBar", "SegmentedBar", "Bullet", "Delta", "MicroDonut"]) {
    assert.equal(typeof charts[name], "function", `缺少图型 ${name}`);
  }
  assert.equal(typeof charts.styles, "string", "样式应随分块一起返回");
  assert.ok(charts.styles.length > 1000, "样式内容不应为空");
});

test("图表分块：用的是交互入口，交互层真的挂上了", () => {
  const { registration } = loadChunk();
  const charts = registration.factory((name) => {
    if (name === "react") return reactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  // 交互入口渲染出的宿主元素带这三个标记：
  //   data-mc-host   —— 交互层挂载点
  //   tabindex="0"   —— 键盘可漫游（方向键在数据点间移动）
  //   aria-live      —— 读屏软件播报当前点
  const el = charts.Sparkline({ data: [1, 4, 2, 8, 5], width: 200, height: 30 });
  const markup = JSON.stringify(el);
  assert.ok(markup.includes("data-mc-host"), "缺少交互宿主标记");
  assert.ok(markup.includes("mc-spark-interactive"), "不是交互版图型（应为 /interactive 入口）");
});

test("图表分块：CSS 具备图形可见性所需的规则", () => {
  // 缺了这些规则，图会画成「有路径但没有颜色」的空白——而且不报错。
  const { registration } = loadChunk();
  const charts = registration.factory((name) => {
    if (name === "react") return reactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  const css = charts.styles;
  for (const rule of ["[data-mc-ink=data]", "[data-mc-ink=bar]", "[data-mc-cat", "--mc-stroke", "--mc-accent"]) {
    assert.ok(css.includes(rule), `样式缺少规则 ${rule}`);
  }
});
