/**
 * 插件页「详细介绍」区不隐藏 README 的守卫（DEC-050）。
 *
 * 背景：DEC-038 / DEC-039 曾经两次「让插件页不显示内容」——先用 `meta.detail` 把 README
 * 挡掉、换成一份精简 DETAIL，再干脆把那份 DETAIL 置空，让宿主渲染出一个零高的空区。
 * 两步的方向都错了：插件页显示什么文档是 **DSH 宿主对所有插件统一的取文档规则**
 * （`@deepseek-ai/dsh-plugin-detail` 的 `readPackageDocument`：locale `meta.detail` →
 * 包 README → 仓库 README），不是本插件自己加的功能。用 `meta.detail` 去改它，等于
 * 借一条留给「想自定义长描述」的通道去做「我不给描述」，而这个插件并没有别的长描述要给。
 *
 * 所以本测试守的是那三条事实，不守任何实现细节：
 *
 *   1. locale 里**没有** `meta.detail` —— 有它宿主就永远不会落到 README。
 *   2. 包内**没有** DETAIL 文档 —— 空文件同样能把 README 挡在外面，删掉才叫撤销。
 *   3. 包清单**没有**声明它们 —— 否则 `npm pack` 会继续把挡板随包发出去。
 *
 * 这三条合起来才等价于「插件页按宿主默认规则显示 README」。少了任何一条，行为都会
 * 悄悄退回 DEC-038/039。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const PACKAGE = readJson("../package.json");
const ZH = readJson("../locale/zh.json");
const EN = readJson("../locale/en.json");

test("locale 不声明 meta.detail：宿主才会按默认规则回落到 README（DEC-050）", () => {
  for (const [name, locale] of [
    ["locale/zh.json", ZH],
    ["locale/en.json", EN],
  ]) {
    assert.equal(
      locale.meta.detail,
      undefined,
      `${name} 声明了 meta.detail —— 宿主一旦命中就不再读 README，插件页会看不到内容`,
    );
  }
});

test("包内没有 DETAIL 文档：空文件同样是挡板（DEC-050）", () => {
  for (const path of ["../docs/DETAIL.md", "../docs/DETAIL.zh.md"]) {
    assert.equal(
      existsSync(new URL(path, import.meta.url)),
      false,
      `${path} 还在包里 —— 被 meta.detail 指向时它会把 README 挡在外面`,
    );
  }
});

test("包清单不再声明 DETAIL 文档（DEC-050）", () => {
  const declared = PACKAGE.files.filter((entry) => /DETAIL/i.test(entry));
  assert.deepEqual(declared, [], `package.json 的 files 仍在声明 DETAIL：${declared.join(", ")}`);
});

test("locale 保留了 title 与 description：撤销的只是「长描述挡板」，不是整个简介", () => {
  for (const [name, locale] of [
    ["locale/zh.json", ZH],
    ["locale/en.json", EN],
  ]) {
    assert.equal(typeof locale.meta.title, "string", `${name} 丢了 meta.title`);
    assert.equal(typeof locale.meta.description, "string", `${name} 丢了 meta.description`);
    assert.ok(locale.meta.description.length > 0, `${name} 的 meta.description 是空的`);
  }
});
