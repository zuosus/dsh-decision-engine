/**
 * 配置文件改名（`startlux.yml` → `config.yml`）的迁移验收。
 *
 * 为什么必须有这组测试：改名本身不改变任何配置语义，但**一旦迁移出错，
 * 用户唯一感知到的就是「我的 API key 没了」**。这正是本项目上一次遇到的
 * 故障形态，所以迁移路径必须能脱离 DSH 真实文件系统验证。
 *
 * 做法：把 `DSH_HOME` 指到临时目录，直接调 `apply()` 触发迁移，
 * 再断言文件落在哪、内容是否原样、旧文件是否被正确处理。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 必须在导入插件前设置：模块级路径解析会读 DSH_HOME。
delete process.env.DSH_HOME;

const { apply } = await import("../lib/index.js");

/** 造一个隔离的 DSH_HOME，返回其路径。 */
function makeHome() {
  return mkdtempSync(join(tmpdir(), "dsh-cfg-rename-"));
}

/**
 * 用最小假 ctx 跑一次 apply()，只为触发迁移与路径解析。
 *
 * 只提供 apply 早期真正会用到的成员：logger 与 on()。
 * 其余能力（fetch 注册、services）在 apply 里都有存在性判断，
 * 缺失不会抛——这正是「缺服务时不崩」的设计。
 */
function runApply() {
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on() {},
    get() {
      return undefined;
    },
    inject() {},
    plugin() {},
    effect() {},
  };
  apply(ctx, {});
}

test("旧名 startlux.yml 会被改名迁移为 config.yml，内容原样保留", () => {
  const home = makeHome();
  const dir = join(home, "dsh-decision-engine");
  mkdirSync(dir, { recursive: true });
  const legacy = join(dir, "startlux.yml");
  const original = "# 用户注释要保留\nenabled: true\nbamboonodeApiKey: sk-KEEP-ME-123\n";
  writeFileSync(legacy, original, { encoding: "utf8", mode: 0o600 });

  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    runApply();
    const next = join(dir, "config.yml");
    assert.ok(existsSync(next), "应生成 config.yml");
    assert.equal(readFileSync(next, "utf8"), original, "内容必须逐字保留（含注释与 key）");
    // 同目录改名用 rename，旧文件不应残留两份配置。
    assert.equal(existsSync(legacy), false, "同目录改名后旧文件应已消失，避免两份配置并存");
    // 含明文 key 的文件权限保持 600。
    assert.equal(statSync(next).mode & 0o777, 0o600);
  } finally {
    process.env.DSH_HOME = prev ?? "";
    if (prev === undefined) delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("已经存在 config.yml 时绝不被旧文件覆盖", () => {
  const home = makeHome();
  const dir = join(home, "dsh-decision-engine");
  mkdirSync(dir, { recursive: true });
  const current = join(dir, "config.yml");
  const keep = "enabled: true\nbamboonodeApiKey: sk-NEW-WINS\n";
  writeFileSync(current, keep, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(dir, "startlux.yml"), "enabled: false\nbamboonodeApiKey: sk-OLD\n", { encoding: "utf8" });

  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    runApply();
    assert.equal(readFileSync(current, "utf8"), keep, "新文件必须原样保留，不能被旧文件覆盖");
  } finally {
    process.env.DSH_HOME = prev ?? "";
    if (prev === undefined) delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("历史数据目录（上一代位置）里的配置会被搬到新目录并改名", () => {
  const home = makeHome();
  const legacyDir = join(home, "dsh-startlux-decision");
  mkdirSync(legacyDir, { recursive: true });
  const payload = "enabled: true\nbamboonodeApiKey: sk-FROM-LEGACY-DIR\n";
  writeFileSync(join(legacyDir, "startlux.yml"), payload, { encoding: "utf8", mode: 0o600 });

  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    runApply();
    const target = join(home, "dsh-decision-engine", "config.yml");
    assert.ok(existsSync(target), "跨目录迁移应落到新目录的 config.yml");
    assert.equal(readFileSync(target, "utf8"), payload);
    // 跨目录是拷贝不是移动：旧文件保留，出问题可对照。
    assert.ok(existsSync(join(legacyDir, "startlux.yml")), "跨目录迁移应保留源文件");
  } finally {
    process.env.DSH_HOME = prev ?? "";
    if (prev === undefined) delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("全新安装（无任何历史配置）不会凭空造出配置文件", () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    runApply();
    assert.equal(existsSync(join(home, "dsh-decision-engine", "config.yml")), false,
      "没有历史配置时不应该创建空文件（否则用 DEFAULTS 即可，且避免误以为已配置）");
  } finally {
    process.env.DSH_HOME = prev ?? "";
    if (prev === undefined) delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
