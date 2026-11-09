/**
 * 「审批卡正文可读化」这个开关的语义（DEC-042 / DEC-043）。
 *
 * 为什么这个开关值得单独一组测试：它决定**要不要接管宿主的一块 UI**。
 * 接管是实质性的耦合（宿主将来改这块的呈现方式时我们不会自动跟上），
 * 所以默认值的每一次变化都必须是有意为之、并且被测试钉住的，而不是
 * 代码里一句注释改一改就过去了。
 *
 * DEC-043 把默认值从关翻成了开——理由不是「功能好用就默认开」，而是
 * 原来那张卡确实没法读：十几行的 `python3 - <<'PY'` 全被折叠成一条
 * 不分行的墙。「默认不开」等于默认把这个问题留给每一个用户，而其中
 * 绝大多数人不会去翻配置页。但翻默认值这件事比新增开关危险得多——
 * 它等于把「接管」变成所有人的现状，所以「用户仍能显式关掉」这一条
 * 必须和「默认是开」一起被测试守住。
 *
 * 这里守四件事：
 *   1. 默认值就是 `true`（DEFAULTS 与 schema 默认一致）；
 *   2. 显式 `false` 仍然有效——这是用户拿回升级前宿主渲染的唯一途径；
 *   3. `/status` 回传的是**归一化后的布尔值**，缺省时表示「开」——配置里
 *      没写这一项时，客户端绝不能把它读成「关」；
 *   4. 这个键在配置页的保存白名单里（不在白名单里的后果是「界面拨了、
 *      显示已保存、服务端 400 什么都没写」——DEC-037 记过这个坑）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Config, DEFAULTS } from "../lib/index.js";

const SOURCE = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

test("默认打开：两处默认值必须是同一个 true，否则行为取决于「谁先读」", () => {
  assert.equal(DEFAULTS.approvalDetailReadable, true, "DEFAULTS 必须默认开");
  // schema 的默认值必须与 DEFAULTS 一致——两处不一致时，配置里省略这一项
  // 会得到与 DEFAULTS 不同的值，行为就取决于「谁先读」：配置页看到一套、
  // 客户端挂载逻辑看到另一套，而且没有任何地方会报错。
  const parsed = Config({});
  assert.equal(parsed.approvalDetailReadable, true, "schema 默认值必须也是开");
});

test("显式关闭仍然有效：这是用户拿回宿主原渲染的唯一途径", () => {
  // 翻默认可接受的前提就是「开关还是真的开关」。这一条一旦失守，
  // 觉得新版卡片碍眼（或不想让我们接管那块 UI）的用户就再没有退路，
  // 只能改源码——「默认开」于是变成了「强制开」。
  assert.equal(Config({ approvalDetailReadable: false }).approvalDetailReadable, false);
});

test("显式打开能被 schema 接受", () => {
  assert.equal(Config({ approvalDetailReadable: true }).approvalDetailReadable, true);
});

test("/status 回传归一化后的布尔值，且缺省即开", () => {
  // 回 `cfg.approvalDetailReadable` 原值的话，配置里没写这一项时客户端拿到
  // undefined：判 `=== true` 的客户端会把「服务端其实是开」画成关，判
  // `!== false` 的客户端才是对的——同一份 status 出现两种读法，就是这类
  // 「看起来没生效」的来源。统一归一化成布尔值，客户端只有一个正确的读法。
  assert.match(
    SOURCE,
    /approvalDetailReadable: cfg\.approvalDetailReadable !== false/,
    "status 必须回传归一化布尔值，且缺省时归一化为 true",
  );
});

test("这个键在配置页保存白名单里", () => {
  // 白名单是服务端 applyConfigUpdates 接受的键集合。漏登记的后果很具体：
  // 配置页能拨、状态行显示「已保存」，而服务端 400 什么都没写。
  //
  // 匹配的是「注释行 + 键」这一对，而不是光匹配键名：`"approvalDetailReadable",`
  // 单独出现时可能只是注释、或者被别的条目带出来的字面量，那并不能证明它
  // 进了白名单数组。注释里的「要」字写成可选的，是因为这句话在历史上有过
  // 「配置页能拨」与「配置页要能拨」两种写法；守的是「这行说明和白名单条目
  // 仍然贴在一起」，别因为一个虚词就让测试变成改注释就得跟着改的负担。
  assert.match(
    SOURCE,
    /\/\/ 审批卡正文可读化（DEC-042）：配置页要?能拨，否则拨了也存不下去。\s*\n\s*"approvalDetailReadable",/,
    "approvalDetailReadable 必须在保存白名单里",
  );
});

test("生效值可以被显式关回去：别让默认值变成写死的 true", () => {
  // 同一组断言里放两个方向，是为了让「把默认值实现成硬编码 true」的回归
  // 立刻失败：那种写法能满足「默认开」，但用户拨掉之后服务端仍然回 true，
  // 卡片怎么都关不掉，而且没有任何报错。
  assert.equal(
    Config({ approvalDetailReadable: false }).approvalDetailReadable,
    false,
    "配置里显式写了 false，就必须是 false",
  );
  assert.equal(
    Config({}).approvalDetailReadable,
    true,
    "配置里没写这一项时，生效值才是默认的 true",
  );
});
