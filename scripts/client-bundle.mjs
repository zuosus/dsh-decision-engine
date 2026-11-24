/**
 * `lib/client.js` 单文件 bundle 的**构建逻辑**（纯函数，无副作用）。
 *
 * 拆成独立模块的理由：构建脚本本身要写文件，而测试需要**只读地**算出
 * 「源应该拼成什么」再与产物比对。若把写文件逻辑与这里的纯函数混在一个
 * 模块里，`import` 一次就会顺手把 bundle 重新生成——漂移断言会在比对之前
 * 被自己的 import 悄悄修好，测试永远绿。这条已经踩过一次，所以刻意分开。
 *
 * 背景：宿主把 `client.js` 当作单文件浏览器 bundle 直接加载，factory 里的
 * `require` 只解析 shell 的共享模块表，加载不了本包的其它源文件。于是源码
 * 拆在 `lib/client-src/`，构建期按顺序拼回一个文件。
 *
 * 拼接是**纯连接**（`join("")`），不做空白规整：分片是原文件的字符区间切片，
 * 只有纯连接才能保证产物逐字节等于拆分前。
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC_DIR = new URL("../lib/client-src/", import.meta.url);

/** 分片文件名：`<两位数>-<职责>.js`。数字前缀决定拼接顺序。 */
export const FRAGMENT_NAME = /^(\d{2})-([a-z0-9-]+)\.js$/;

/**
 * 读分片，按前缀数字升序排列。
 *
 * 顺序即语义：分片是原文件的有序切片，任何重排都会让 `const` 在声明前被使用
 * （TDZ）。所以这里拒绝重复前缀——重复意味着「谁在前」要靠文件系统返回顺序
 * 决定，那是不确定的。
 */
export function readFragments() {
  const names = readdirSync(fileURLToPath(SRC_DIR)).filter((name) => FRAGMENT_NAME.test(name));
  const seen = new Map();
  for (const name of names) {
    const prefix = FRAGMENT_NAME.exec(name)[1];
    if (seen.has(prefix)) {
      throw new Error(`client-src 分片前缀重复：${seen.get(prefix)} 与 ${name}`);
    }
    seen.set(prefix, name);
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, name]) => ({ prefix, name, body: readFileSync(new URL(name, SRC_DIR), "utf8") }));
}

/** 把分片拼成 bundle 正文。每片必须以换行结尾，否则两片会粘行。 */
export function concatFragments(fragments) {
  if (fragments.length === 0) throw new Error("client-src 下没有任何分片");
  for (const fragment of fragments) {
    if (!fragment.body.endsWith("\n")) {
      throw new Error(`client-src/${fragment.name} 必须以换行结尾，否则分片会粘行`);
    }
  }
  return fragments.map((fragment) => fragment.body).join("");
}

/**
 * 用两份可编辑源覆盖 bundle 里的嵌入内容（DEC-051 的约定，继续生效）。
 *
 *   1. `CFG_SECTION_CSS = \`...\`` —— 正文换成 `lib/client.config.css`；
 *   2. `BEGIN/END CONFIG CONTROLS` 之间 —— 换成 `lib/client.config-controls.js`。
 *
 * 约束与旧 `sync-config-css.mjs` 一致：CSS 里出现反引号或 `${` 就无法安全塞进
 * 模板字符串，直接报错而不是悄悄产出坏产物。
 */
export function applyEditableSources(bundle) {
  const css = readFileSync(new URL("../lib/client.config.css", import.meta.url), "utf8");
  const cssToken = "    const CFG_SECTION_CSS = `";
  const cssStart = bundle.indexOf(cssToken);
  const cssEnd = bundle.indexOf("`;", cssStart + cssToken.length);
  if (cssStart < 0 || cssEnd < 0) throw new Error("找不到 CFG_SECTION_CSS 模板字符串");
  if (/[`$]/u.test(css)) throw new Error("client.config.css 含反引号或 $，无法安全嵌入模板字符串");

  let next = bundle.slice(0, cssStart + cssToken.length) + "\n" + css + bundle.slice(cssEnd);

  const controls = readFileSync(new URL("../lib/client.config-controls.js", import.meta.url), "utf8");
  const begin = "    // BEGIN CONFIG CONTROLS\n";
  const finish = "    // END CONFIG CONTROLS";
  const controlStart = next.indexOf(begin);
  const controlEnd = next.indexOf(finish, controlStart);
  if (controlStart < 0 || controlEnd < 0) throw new Error("找不到配置控件嵌入标记");
  const indented = controls
    .split("\n")
    .map((line) => (line ? `    ${line}` : ""))
    .join("\n");
  return next.slice(0, controlStart + begin.length) + indented + next.slice(controlEnd);
}

/** 源 → 应有的 bundle 正文。构建脚本与防漂移测试共用同一条路径。 */
export function buildBundle() {
  return applyEditableSources(concatFragments(readFragments()));
}
