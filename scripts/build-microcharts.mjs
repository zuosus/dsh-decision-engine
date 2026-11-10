#!/usr/bin/env node
/**
 * 重新生成统计页图表的按需分块（`lib/client.charts.js`）。
 *
 * 这个脚本是**构建期工具**，不是运行时依赖：它把 `@microcharts/react`
 * 的一个子集打成一个符合宿主分块协议的包内 chunk，产物已提交进仓库，
 * 普通安装/使用**不需要**跑它，也不需要 node_modules 里有 microcharts。
 *
 * 为什么要留一个可重跑脚本而不是「一次性手工产物」：
 * 那份产物是压缩过的第三方代码，没人能靠读它判断「用的是哪一版、哪几个
 * 图型、react 之外还依赖了什么」。脚本是这三点唯一的可核对来源，也让升级
 * microcharts 或调整图型子集变成改两行而不是重新摸索一遍构建参数。
 *
 * 用法：
 *   npm i -D esbuild && npm i @microcharts/react
 *   node scripts/build-microcharts.mjs
 *
 * 产物两件：
 *   lib/client.charts.js                      代码（chunk，随 `require.async` 按需下载）
 *   lib/vendor/microcharts-charts.css         样式（由 client.js 注进 document.head）
 *
 * 关键约束（改动这里之前先读一遍，破坏了任何一条线上都会静默失效）：
 *
 * 1. **只允许依赖 react**。宿主 factory 只保证 `require("react")` 可用；
 *    `react/jsx-runtime` 不在平台种子表里，所以必须用 jsx 垫片把它改写成
 *    `createElement`。产物里若出现别的 `require("xxx")`，加载时必然抛
 *    "cannot resolve"。
 * 2. **文件名必须是 `client.<name>.js`**。宿主用
 *    `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` 判定包内分块，别的名字
 *    会被直接拒绝。
 * 3. **chunk 的 `id` 必须是插件包名**，`chunk` 必须是文件名；宿主据此把
 *    分块挂到本包名下，`require.async("./client.charts.js")` 才找得到。
 * 4. **CSS 里不要改库自带的那一段**。图型的可见性依赖 `[data-mc-ink]` 的
 *    fill/stroke 规则，删一条就可能整张图空白。主题化只加在末尾的覆盖段。
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkgRoot = join(root, "node_modules", "@microcharts", "react");

if (!existsSync(pkgRoot)) {
  console.error(
    "缺少 @microcharts/react。先安装（版本要和 lib/client.charts.js 头部注明的版本一致）：\n" +
      "  npm i @microcharts/react",
  );
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
const scratch = join(root, ".microcharts-build");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, "src"), { recursive: true });

/*
 * 图型子集。只导出统计页真的会用到的几类：
 *   Sparkline     单指标走势（请求量、耗时随时间）
 *   SparkBar      离散柱（每桶一根，走势的柱状版）
 *   MiniBar       横向比较（provider×model 之间谁多谁少）
 *   SegmentedBar  占比构成（allow/ask/reject 三格）
 *   Bullet        目标达成（节省量的实际 vs 基线）
 *   Delta         有符号变化（节省比例这样一个 +/- 数字）
 *   MicroDonut    圆环占比（按决策点分账的构成）
 *
 * 少导出一种就少一份要审的第三方代码；加图型请同时补测试与 DEC 条目。
 *
 * 为什么是 MicroDonut 而不是 PieChart：**microcharts 故意不提供饼图**。
 * 官方文档把饼图、仪表盘、华夫图列为「词级尺寸下不可读」的一类，并给了
 * 各自的替代品——SegmentedBar 替代饼图、Bullet 替代仪表盘。圆环
 * （micro-donut）是库给出的折中：保住了「一个整体被切成几份」的直觉，
 * 但它是**带洞的环**，洞用来放总数，而且默认会合并长尾。
 *
 * 用它的代价必须自己补上：圆环本身**不画分块标签、也没有图例**，只看
 * 颜色分不出哪块是哪个决策点。所以 client.js 里必须配一份文字图例
 * （见 renderPointDonut 的调用处），否则这张图只有「形」没有「义」。
 */
writeFileSync(
  join(scratch, "src", "entry.js"),
  [
    'export { Sparkline } from "@microcharts/react/sparkline";',
    'export { SparkBar } from "@microcharts/react/sparkbar";',
    'export { Bullet } from "@microcharts/react/bullet";',
    'export { SegmentedBar } from "@microcharts/react/segmented-bar";',
    'export { Delta } from "@microcharts/react/delta";',
    'export { MiniBar } from "@microcharts/react/mini-bar";',
    'export { MicroDonut } from "@microcharts/react/micro-donut";',
    "",
  ].join("\n"),
);

/*
 * jsx 垫片：把 `react/jsx-runtime` 翻成 `createElement`。
 * 这是「产物只依赖 react」这条约束的实现手段（见文件头第 1 条）。
 */
copyFileSync(join(root, "lib", "vendor-src", "jsx-shim.js"), join(scratch, "src", "jsx-shim.js"));

const outFile = join(scratch, "charts.js");
execFileSync(
  join(root, "node_modules", ".bin", "esbuild"),
  [
    join(scratch, "src", "entry.js"),
    "--bundle",
    "--format=cjs",
    "--platform=browser",
    "--target=chrome110,safari16,firefox110",
    "--minify",
    "--legal-comments=none",
    "--external:react",
    `--alias:react/jsx-runtime=${join(scratch, "src", "jsx-shim.js")}`,
    `--outfile=${outFile}`,
  ],
  { stdio: "inherit", cwd: root },
);

const bundle = readFileSync(outFile, "utf8").trim();

/* 产物自检：这条断言防的是「构建参数被改坏」，而不是运行期错误。 */
const foreignRequires = [...bundle.matchAll(/require\("([^"]+)"\)/g)]
  .map((match) => match[1])
  .filter((name) => name !== "react");
if (foreignRequires.length > 0) {
  console.error(
    `产物里出现了 react 之外的依赖：${[...new Set(foreignRequires)].join(", ")}\n` +
      "宿主只给 react，这些 require 在浏览器里必然抛 cannot resolve。",
  );
  process.exit(1);
}

const chunkFile = "client.charts.js";

/*
 * 样式：库自带的 core.css + sparkline.css **原样保留**，末尾追加把 token
 * 接到 DSH 语义色上的覆盖段。
 *
 * 为什么原样保留而不是只挑「用到的规则」：图型的可见性完全依赖
 * `[data-mc-ink]` / `[data-mc-cat]` 那批规则（它们决定每一块图形填什么色、
 * 描不描边）。挑规则时漏掉一条，画出来的就不是「样式丑一点」，而是
 * **整张图空白**——而空白不会报错，只会让人以为「这段没数据」。
 */
const stylesDir = join(pkgRoot, "dist", "styles");
const fullCss = `${readFileSync(join(stylesDir, "core.css"), "utf8").trim()}\n${readFileSync(
  join(stylesDir, "sparkline.css"),
  "utf8",
).trim()}\n`;


/**
 * 主题覆盖段：把库的硬编码调色板接到 DSH 的语义变量上。
 *
 * 每个变量都带兜底值：宿主变量名在版本间可能变，兜底保证即使宿主改了名，
 * 图表也只是回到库的默认外观，而不是消失。
 */
const themeOverride = `
/* ============================================================
 * 主题覆盖：把 microcharts 的 token 接到 DSH 的语义变量上
 * ============================================================ */
:where(.mc-theme) {
  /* 兜底用 currentColor 而不是一个固定的深色：固定深色在深色宿主里
     是不可见的黑，而 currentColor 永远等于它身边的文字色——宿主改了
     变量名时图表只是「跟正文同色」，不是「消失」。 */
  --mc-stroke: var(--dsw-alias-label-primary, currentColor);
  --mc-neutral: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 55%, transparent));
  --mc-accent: var(--dsw-alias-state-business-primary, #1f6091);
  --mc-positive: var(--dsw-alias-state-success-primary, #0e7a5f);
  --mc-negative: #e8797f;
  --mc-cat-1: var(--dsw-alias-state-success-primary, #2e8c66);
  --mc-cat-2: var(--dsw-alias-state-warn-primary, #d2982f);
  --mc-cat-3: #e8797f;
  --mc-cat-4: var(--dsw-alias-label-tertiary, #8a8986);
  --mc-cat-5: var(--dsw-alias-state-business-primary, #285788);
  --mc-cat-6: var(--dsw-alias-label-secondary, #a55a89);
  --mc-on-cat: var(--dsw-alias-bg-base, rgba(0, 0, 0, .9));
  --mc-on-cat-1: var(--dsw-alias-bg-base, rgba(0, 0, 0, .9));
  --mc-on-cat-2: var(--dsw-alias-bg-base, rgba(0, 0, 0, .9));
  --mc-on-cat-3: var(--dsw-alias-bg-base, rgba(255, 255, 255, .96));
  --mc-on-cat-4: var(--dsw-alias-bg-base, rgba(0, 0, 0, .9));
  --mc-on-cat-5: var(--dsw-alias-bg-base, rgba(255, 255, 255, .96));
  --mc-on-cat-6: var(--dsw-alias-bg-base, rgba(255, 255, 255, .96));
  --mc-font: inherit;
}

/* 图表与数字并排时的容器：垂直居中，行高归零免得撑高卡片。 */
:where(.de-chart) {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  line-height: 0;
}
`;

writeFileSync(
  join(root, "lib", chunkFile),
  `/**
 * 统计页图表的按需分块（microcharts@${version} 子集，**构建期生成**）。
 *
 * 由 scripts/build-microcharts.mjs 生成，**不要手改**。要升级或调整图型
 * 子集，改脚本后重跑；手改会在下次构建时被整个覆盖。
 *
 * 为什么是独立 chunk 而不是内联进 client.js：这包是第三方代码，而
 * client.js 是每个打开设置页的人都要下载的首屏 bundle。图表只有统计页
 * 用得到，内联进去等于让所有人为一个可能永远不打开的 tab 付体积。
 *
 * 依赖面：整份产物只 require("react")——内部对 react/jsx-runtime 的使用
 * 已在构建期被垫片改写成 createElement（见 lib/vendor-src/jsx-shim.js）。
 *
 * 加载方式：宿主 factory 的 \`require.async("./client.charts.js")\`。
 * 文件名必须匹配 \`client.<name>.js\`，这是宿主的包内分块命名规则。
 *
 * 样式随本分块一起返回（导出对象上的 \`styles\` 字段），由 client.js
 * 注入（见 ensureChartsCss）。代码与样式同批到达，避免「代码到了、
 * 样式没到」时画出无填充的黑色方块。
 */

window.__ModuleLoader__.load({
  id: "dsh-decision-engine",
  chunk: ${JSON.stringify(chunkFile)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // ---- microcharts 构建产物开始（esbuild --format=cjs，react 外置）----
${bundle}
    // ---- 构建产物结束 ----
    // 样式随分块一起返回：代码与 CSS 是同一份构建的产物，分开取会出现
    // 「代码到了、样式没到」的中间态（SVG 无填充 → 一片黑块）。
    // 挂到最终导出对象上：构建产物自己会重写 module.exports，挂在 exports 上会被丢掉。
    module.exports.styles = ${JSON.stringify(`${fullCss}\n${themeOverride}`)};
    return module.exports;
  },
});
`,
);

/*
 * 样式：库自带的 core.css + sparkline.css 原样保留，末尾追加把 token
 * 接到 DSH 语义色上的覆盖段。
 */


writeFileSync(
  join(root, "lib", "vendor", "microcharts-charts.css"),
  `/**
 * microcharts@${version} 的统计页样式（**构建期生成**，勿手改）。
 *
 * 内容与 lib/${chunkFile} 里导出的 styles 字段一致。这份独立文件的用途是
 * 便于人查阅与比对（chunk 里是转义后的字符串，读不了）；运行时真正注入
 * 页面的样式来自分块导出的那份，二者由同一次构建同时生成。
 */

${fullCss}
${themeOverride}
`,
);

rmSync(scratch, { recursive: true, force: true });
console.log(
  `已生成 lib/${chunkFile} 与 lib/vendor/microcharts-charts.css（microcharts@${version}）`,
);
