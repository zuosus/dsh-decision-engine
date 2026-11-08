/**
 * 「审批卡正文可读化」这个开关的语义（DEC-042）。
 *
 * 为什么这个开关值得单独一组测试：它决定**要不要接管宿主的一块 UI**。
 * 接管是实质性的耦合（宿主将来改这块的呈现方式时我们不会自动跟上），
 * 所以默认必须是关、关掉时行为必须与升级前**零差异**。这条承诺如果只在
 * 代码里写一句注释，下次重构就会悄悄变成「默认开」。
 *
 * 这里守三件事：
 *   1. 默认值就是 `false`（DEFAULTS 与 schema 默认一致）；
 *   2. `/status` 回传的是**归一化后的布尔值**，不是原值——配置里没写这一项
 *      时，客户端必须能看出「关」，否则接手逻辑会误挂；
 *   3. 这个键在配置页的保存白名单里（不在白名单里的后果是「界面拨了、
 *      显示已保存、服务端 400 什么都没写」——DEC-037 记过这个坑）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Config, DEFAULTS } from "../lib/index.js";

const SOURCE = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

test("默认关闭：接管宿主的 UI 是选择性行为，升级不该改变任何人的现状", () => {
  assert.equal(DEFAULTS.approvalDetailReadable, false, "DEFAULTS 必须默认关");
  // schema 的默认值必须与 DEFAULTS 一致——两处不一致时，配置里省略这一项
  // 会得到与 DEFAULTS 不同的值，行为就取决于「谁先读」。
  const parsed = Config({});
  assert.equal(parsed.approvalDetailReadable, false, "schema 默认值必须也是关");
});

test("显式打开能被 schema 接受", () => {
  assert.equal(Config({ approvalDetailReadable: true }).approvalDetailReadable, true);
});

test("/status 回传归一化后的布尔值，而不是原值", () => {
  // 回 `cfg.approvalDetailReadable` 原值的话，配置里没写这一项时客户端拿到
  // undefined，`=== true` 判关是对的，但「真值」判断（如 `!== false`）就错了。
  // 统一归一化成布尔值，客户端只有一个正确的读法。
  assert.match(
    SOURCE,
    /approvalDetailReadable: cfg\.approvalDetailReadable === true/,
    "status 必须回传归一化布尔值",
  );
});

test("这个键在配置页保存白名单里", () => {
  // 白名单是服务端 applyConfigUpdates 接受的键集合。漏登记的后果很具体：
  // 配置页能拨、状态行显示「已保存」，而服务端 400 什么都没写。
  assert.match(
    SOURCE,
    /"approvalDetailReadable",\s*\n\s*\/\/ 服务端下发开关/,
    "approvalDetailReadable 必须在保存白名单里",
  );
});
