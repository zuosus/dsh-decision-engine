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
 * 取 `lib/client.js` 的导出（只要它的模块出口，不渲染界面）。
 *
 * 为什么要在这里加载 client.js：几何锁定测试必须把「我们自己复刻的坐标公式」
 * 和「库在这同一份产物上算出的顶点」放在一起比。client.js 是浏览器 bundle，
 * 加载协议和分块一样（`window.__ModuleLoader__.load({ factory })`），所以一个
 * react 桩就够了——不调用 `apply()`，也就不会碰宿主的注入点。
 */
async function loadClientExports(seq) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let bundle = null;
  const previous = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
      },
    },
  };
  try {
    // 加一段唯一注释再转 data URL：内容变了 → 模块标识不同 → factory 重新执行。
    const unique = `\n// chunk-test-instance-${seq}\n`;
    await import(`data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`);
  } finally {
    globalThis.window = previous;
  }
  assert.ok(bundle !== null, "client bundle 未注册 factory");
  return bundle;
}

/**
 * 在渲染树里找带某个 `data-mc-ink` 的元素。
 *
 * 替身 `createElement` 不会展开函数组件，所以遇到 `type` 是函数时要把它调一次
 * （交互版 Sparkline 把真正的 svg 交给内部组件渲染）。深度上限只是防自相似递归。
 */
function findByInk(node, ink, out = [], depth = 0) {
  if (node === null || node === undefined || depth > 20) return out;
  if (Array.isArray(node)) {
    for (const child of node) findByInk(child, ink, out, depth);
    return out;
  }
  if (typeof node !== "object") return out;
  if (node.props?.["data-mc-ink"] === ink) out.push(node);
  findByInk(node.children, ink, out, depth + 1);
  findByInk(node.props?.children, ink, out, depth + 1);
  if (typeof node.type === "function") {
    findByInk(node.type(node.props), ink, out, depth + 1);
  }
  return out;
}

/**
 * 解析路径 `d` 成顶点数组。
 *
 * 分隔规则与 microcharts 一致：每段各起一个 `M`，段内以 `" L"` 连接，
 * 段与段之间是一个空格（null 断点就切在这里）。
 */
function parseVertices(d) {
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

/** 几何锁定的用例：全部走统计页那一条配置（label "none"、dots "auto"、260×34）。 */
const GEOMETRY_CASES = [
  { name: "尾部两格未来（null 断在末尾，显式传值域）", data: [3, 0, 4, null, null], domain: [0, 4] },
  { name: "满上限 400 个桶（stat 页最长区间）", data: Array.from({ length: 400 }, (unused, index) => (index % 7) - 3), domain: undefined },
  { name: "不传值域（退给库自己算，锁 sparkDomain）", data: [1, 4, 2, 8, 5], domain: undefined },
  { name: "中段断点（虚线要切成子路径）", data: [2, null, 6, 1, null, 3], domain: undefined },
  { name: "面积模式（zero 会把值域压到含 0）", data: [7, 9, 6, 8], domain: undefined, fill: true },
  { name: "水平序列（值域退化，斜率非有限）", data: [5, 5, 5, null, 5], domain: undefined },
  { name: "全 0 + 面积", data: [0, 0, null, 0], domain: undefined, fill: true },
  { name: "负数与跨度不对称", data: [-4, 0, 3, null, -1], domain: undefined },
  { name: "两个点", data: [1, 9], domain: undefined },
  { name: "一个点（x 取中线）", data: [4], domain: undefined },
  { name: "宽高非法（走 fallback 80×20）", data: [1, 2, null, 4], width: 0, height: -5, domain: undefined },
];

test("走势图几何：我们复刻的坐标公式与 vendored 库自己算出的顶点逐位相同", async () => {
  /**
   * 这条测试是本方案唯一的真风险点。
   *
   * 统计页把走势的未来段（区间上界之后那批恒为 0 的桶）画成淡色虚线：过去段
   * 交给 microcharts，虚线段由 `lib/client.js` 的 `sparkTrendGeometry` /
   * `sparkTrendPath` 自己算坐标、自己拼 `d`。也就是说我们在**复刻一个第三方
   * 库的内部布局**（pad=2、按全长排 x、按值域排 y、坐标保留 2 位小数、null 处
   * 切子路径、每段各起一个 `M`）。
   *
   * 复刻错了不会报错，只会**错位**：虚线与实线断开、整体偏移一段、或者在长区间
   * 上偏好几个桶——用户看到的是「图坏了但还能看」，最难被发现。所以这里不做
   * 「形状差不多」的近似断言，而是拿**同一份 vendored 产物**渲染 Sparkline，
   * 把它画出的实线路径与我们算的路径逐字符比对。
   *
   * 将来重跑 `scripts/build-microcharts.mjs` 升级 microcharts、库改了 pad 或
   * 抽稀规则，这条立刻红，而不是让用户先看到错位的线。
   */
  const { registration } = loadChunk();
  const charts = registration.factory((name) => {
    if (name === "react") return reactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  const client = await loadClientExports(1);

  for (const [seq, testCase] of GEOMETRY_CASES.entries()) {
    const width = testCase.width ?? 260;
    const height = testCase.height ?? 34;
    const fill = testCase.fill === true;
    const label = `${testCase.name} #${seq}`;

    const props = {
      data: testCase.data,
      width,
      height,
      label: "none",
      dots: "auto",
      fill,
      // 顶点数 = 桶数：库默认 maxPoints 200 会做 min/max 抽稀，那样
      // linePoints 的顶点数不等于桶数，两边根本对不上（也是我们传它的值）。
      maxPoints: testCase.data.length,
    };
    if (testCase.domain !== undefined) props.domain = testCase.domain;
    // children 必须保持 undefined：reactStub 没有 Children.forEach，
    // 传子节点会在库的注释层里炸掉（那条路径由 client-ui.test.js 覆盖）。

    const element = charts.Sparkline(props);
    const dataPaths = findByInk(element, "data");
    assert.equal(dataPaths.length, 1, `${label}：应恰好有一条实线路径`);
    const vertices = parseVertices(dataPaths[0].props.d);

    // 我们那一套：点数组逐位等于库的顶点，拼出来的 d 逐字符等于库的 d。
    const ours = client.sparkTrendGeometry(testCase.data, {
      width,
      height,
      domain: testCase.domain,
      zero: fill,
    });
    assert.equal(
      ours.points.filter((point) => point !== null).length,
      vertices.length,
      `${label}：顶点数应一致（库在 null 处断线，我们也是）`,
    );
    for (let index = 0; index < vertices.length; index++) {
      const mine = ours.points.filter((point) => point !== null)[index];
      assert.equal(mine.x, vertices[index].x, `${label}：第 ${index} 个顶点 x`);
      assert.equal(mine.y, vertices[index].y, `${label}：第 ${index} 个顶点 y`);
    }
    assert.equal(
      client.sparkTrendPath(ours.points),
      dataPaths[0].props.d,
      `${label}：d 字符串必须逐字符相同（分段与分隔符规则也一样）`,
    );

    // 值域也必须一致：库内部 `domain ?? Nt(data, zero)`，我们显式传同一个值。
    // 未来段被 null 化时值域仍按原始序列算，所以这里比的是**同一条**序列上的值域。
    if (testCase.domain !== undefined) {
      assert.deepEqual(ours.domain, testCase.domain, `${label}：显式值域应原样采用`);
    } else {
      assert.deepEqual(ours.domain, client.sparkDomain(testCase.data, fill), `${label}：自动值域`);
      const library = client.sparkTrendGeometry(testCase.data, { width, height, zero: fill });
      assert.deepEqual(library.domain, ours.domain, `${label}：值域与库的来源同一`);
    }
  }

  // 锁定「非有限值 = 断点」这条：库的 L() 只认有限数字，我们也必须一样，
  // 否则 NaN 会被画成一个点、把虚线连穿。
  const withOdd = charts.Sparkline({
    data: [1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5, undefined, 7],
    width: 260,
    height: 34,
    label: "none",
    dots: "auto",
    maxPoints: 7,
  });
  const oddPath = findByInk(withOdd, "data")[0];
  const client2 = await loadClientExports(2);
  assert.equal(
    client2.sparkTrendPath(
      client2.sparkTrendGeometry([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5, undefined, 7], {
        width: 260,
        height: 34,
      }).points,
    ),
    oddPath.props.d,
    "NaN / Infinity / undefined 都要断成子路径",
  );
  assert.equal(parseVertices(oddPath.props.d).length, 4, "四段：1 | 3 | 5 | 7");
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
