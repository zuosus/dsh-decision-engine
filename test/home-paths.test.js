/**
 * 家目录解析的验收测试。
 *
 * 这一层的价值：路径解析错了不会报错，只会**静默写到别的地方**——用户表现
 * 为「保存了但找不到配置」「换了启动方式配置就丢了」。因此优先级、空白值、
 * 波浪号、相对路径四种情形都必须显式验证。
 *
 * 基准是宿主 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`：
 * 本插件复刻它的行为而不依赖它（保持零运行时依赖）。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  DSH_HOME_DIR_NAME,
  DSH_HOME_ENV,
  dshHomePath,
  expandHomePath,
  resolveDshHome,
} from "../lib/home-paths.js";

const DEFAULT_HOME = join(homedir(), DSH_HOME_DIR_NAME);

test("常量与宿主保持一致", () => {
  assert.equal(DSH_HOME_DIR_NAME, ".dsh");
  assert.equal(DSH_HOME_ENV, "DSH_HOME");
});

test("未设置 DSH_HOME 时回退到 ~/.dsh", () => {
  assert.equal(resolveDshHome({ env: {} }), resolve(DEFAULT_HOME));
});

test("空串与纯空白的 DSH_HOME 视为未设置", () => {
  // 宿主注释专门强调：空白覆盖绝不能把家目录解析到当前工作目录。
  for (const blank of ["", "   ", "\t", "\n"]) {
    assert.equal(
      resolveDshHome({ env: { DSH_HOME: blank } }),
      resolve(DEFAULT_HOME),
      `空白值 ${JSON.stringify(blank)} 应回退默认家目录`,
    );
  }
});

test("DSH_HOME 优先于默认值", () => {
  const home = resolveDshHome({ env: { DSH_HOME: "/tmp/custom-home" } });
  assert.equal(home, resolve("/tmp/custom-home"));
});

test("显式配置优先于 DSH_HOME（与宿主优先级一致）", () => {
  const home = resolveDshHome({
    configured: "/tmp/explicit",
    env: { DSH_HOME: "/tmp/from-env" },
  });
  assert.equal(home, resolve("/tmp/explicit"));
});

test("相对路径被规范化为绝对路径", () => {
  // 不规范化的话，落盘位置会随进程工作目录漂移——表现为
  // 「同一个配置有时读得到有时读不到」。
  const home = resolveDshHome({ env: { DSH_HOME: "./relhome" } });
  assert.ok(resolve(home) === home, "必须是绝对路径");
  assert.equal(home, resolve(process.cwd(), "relhome"));
});

test("路径里的 .. 与 . 被消除", () => {
  const home = resolveDshHome({ env: { DSH_HOME: "/tmp/a/../b/./c" } });
  assert.equal(home, resolve("/tmp/b/c"));
});

test("波浪号三种形式都展开到操作系统家目录", () => {
  assert.equal(expandHomePath("~"), homedir());
  assert.equal(expandHomePath("~/x"), join(homedir(), "x"));
  // `~\` 是 Windows 形式，宿主为此专门加了一条。
  assert.equal(expandHomePath("~\\x"), join(homedir(), "x"));
});

test("命名用户的波浪号形式原样返回（不擅自展开）", () => {
  assert.equal(expandHomePath("~alice/x"), "~alice/x");
});

test("非波浪号路径原样返回", () => {
  assert.equal(expandHomePath("/abs/path"), "/abs/path");
  assert.equal(expandHomePath("relative/x"), "relative/x");
});

test("dshHomePath 把子路径拼到家目录上", () => {
  assert.equal(dshHomePath("dsh-decision-engine"), join(resolve(DEFAULT_HOME), "dsh-decision-engine"));
  assert.equal(dshHomePath(), resolve(DEFAULT_HOME));
});

test("同一 DSH_HOME 在不同写法下解析结果一致", () => {
  // 这些写法都指向同一个目录，必须得到同一个绝对路径。
  const target = "/tmp/equivalence";
  const variants = [
    { DSH_HOME: target },
    { DSH_HOME: `${target}/` },
    { DSH_HOME: `${target}/.` },
    { DSH_HOME: `/tmp/other/../equivalence` },
  ];
  for (const env of variants) {
    assert.equal(resolveDshHome({ env }), resolve(target), `写法 ${env.DSH_HOME} 应等价`);
  }
});
