/**
 * 单文件 bundle 的**构建一致性**测试（拆分后新增）。
 *
 * 背景：宿主要求 `lib/client.js` 必须是单文件 bundle（factory 里的 `require`
 * 加载不了本包的其它源文件），所以源码拆在 `lib/client-src/` 里、构建期拼回
 * 一个文件。拆开之后多了一类只在提交时才会暴露的事故：
 *
 *   1. 改分片忘了跑构建 —— 浏览器拿到旧 bundle，单测全部对着源码跑，全绿；
 *   2. 改了 `client.config.css` / `client.config-controls.js` 忘了构建 ——
 *      同上，样式与控件是「构建期覆盖」的，不构建就完全不生效；
 *   3. 分片顺序被重排 —— 拼接顺序即语义，重排会让 `const` 在声明前被使用。
 *
 * 这三条都不是行为逻辑错误，跑渲染测试抓不到，只能靠把「产物 == 构建(源)」
 * 这个等式钉成断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { readFragments, buildBundle } from "../scripts/client-bundle.mjs";

const CLIENT = new URL("../lib/client.js", import.meta.url);
const SRC_DIR = new URL("../lib/client-src/", import.meta.url);

test("lib/client.js 与 lib/client-src 的分片完全同步", () => {
  const built = buildBundle();
  const shipped = readFileSync(CLIENT, "utf8");
  assert.equal(shipped, built, "lib/client.js 与源码不同步：运行 node scripts/build-client.mjs");
});

test("分片按前缀升序拼接，且每片都以换行结尾", () => {
  const fragments = readFragments();
  assert.ok(fragments.length > 1, "client-src 应该有多个分片");
  const prefixes = fragments.map((fragment) => fragment.prefix);
  assert.deepEqual([...prefixes], [...prefixes].sort((a, b) => a.localeCompare(b)));
  for (const fragment of fragments) {
    assert.ok(fragment.body.endsWith("\n"), `${fragment.name} 必须以换行结尾，否则会与下一片粘行`);
  }
});

test("每个分片都在文件尺寸预算内（≤ 500 行）", () => {
  const oversized = readdirSync(new URL(".", SRC_DIR))
    .filter((name) => /^\d{2}-[a-z0-9-]+\.js$/.test(name))
    .map((name) => ({ name, lines: readFileSync(new URL(name, SRC_DIR), "utf8").split("\n").length - 1 }))
    .filter(({ lines }) => lines > 500);
  assert.deepEqual(oversized, [], `这些分片超过 500 行预算：${oversized.map((o) => `${o.name}=${o.lines}`).join(", ")}`);
});

test("bundle 仍把可编辑 CSS 与控件源逐字嵌入（防漂移）", () => {
  const source = readFileSync(CLIENT, "utf8");
  const css = readFileSync(new URL("../lib/client.config.css", import.meta.url), "utf8");
  const embedded = source.match(/const CFG_SECTION_CSS\s*=\s*`([\s\S]*?)`;/);
  assert.ok(embedded, "bundle 里必须保留 CFG_SECTION_CSS 的模板字符串");
  assert.equal(embedded[1].trim(), css.trim(), "内嵌 CSS 必须与 client.config.css 一致");

  const controls = readFileSync(new URL("../lib/client.config-controls.js", import.meta.url), "utf8");
  const begin = "    // BEGIN CONFIG CONTROLS\n";
  const finish = "    // END CONFIG CONTROLS";
  const start = source.indexOf(begin);
  const end = source.indexOf(finish, start);
  assert.ok(start >= 0 && end > start, "bundle 里必须保留控件嵌入标记");
  const indented = controls
    .split("\n")
    .map((line) => (line ? `    ${line}` : ""))
    .join("\n");
  assert.equal(source.slice(start + begin.length, end), indented, "内嵌控件源必须与 client.config-controls.js 一致");
});

test("分片里的可编辑源只留占位，不存展开副本（防静默失效）", () => {
  // 分片是唯一可编辑源，但 CSS 与控件那两块在构建期会被 client.config.css /
  // client.config-controls.js **覆盖**。若分片里还留着一份展开副本，编辑它不会有
  // 任何效果——产物只认配置文件那份。这类「改了但没生效」必须由测试拦住，不能
  // 靠人记得。
  const styleFragment = readFileSync(new URL("08-style-injection.js", SRC_DIR), "utf8");
  const begin = styleFragment.indexOf("    // BEGIN CONFIG CONTROLS");
  const end = styleFragment.indexOf("    // END CONFIG CONTROLS", begin);
  assert.ok(begin >= 0 && end > begin, "分片必须保留控件嵌入标记");
  const controlsBody = styleFragment.slice(begin, end);
  assert.match(controlsBody, /构建期由 lib\/client\.config-controls\.js 覆盖/,
    "控件嵌入区必须明确写「构建期覆盖」，指向可编辑源");
  assert.doesNotMatch(controlsBody, /function associateConfigControl/,
    "控件嵌入区不得内置展开副本，只有 lib/client.config-controls.js 是唯一实现");

  const cssMatch = styleFragment.match(/const CFG_SECTION_CSS = `([\s\S]*?)`;/);
  assert.ok(cssMatch, "分片必须保留 CFG_SECTION_CSS 模板字符串");
  assert.match(cssMatch[1], /构建期由 lib\/client\.config\.css 覆盖/,
    "CSS 模板正文必须明确写「构建期覆盖」，指向可编辑源");
  assert.doesNotMatch(cssMatch[1], /\.de-settings\s*\{/,
    "CSS 模板正文不得内置展开副本，只有 lib/client.config.css 是唯一实现");
});
