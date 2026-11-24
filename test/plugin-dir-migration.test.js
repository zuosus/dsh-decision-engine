/**
 * 插件数据目录迁移的验收测试。
 *
 * 背景：本插件过去把自有数据放在 `$DSH_HOME/dsh-decision-engine/`（家目录根部），
 * 现在统一收到 `$DSH_HOME/plugins/dsh-decision-engine/`——`plugins/` 是 DSH 既有的
 * 插件数据父目录惯例（本机已有 `~/.dsh/plugins/dsh-generative-ui/` 等）。
 *
 * 为什么这组测试必须有：目录搬错了不会报错，只会**让老用户的 key 凭空消失**
 * （插件静默回落到「未配置」）。这正是本项目上一次遇到的故障形态
 * （见 test/config-rename.test.js），所以整目录迁移必须能脱离真实文件系统验证。
 *
 * 覆盖四条硬规则：
 *   1. 正常路径：旧目录整体搬到新目录，内容原样、旧目录消失；
 *   2. 边界：新目录已存在 → 绝不覆盖、绝不合并，旧目录原样留着；
 *   3. 边界：旧目录不存在 → 静默什么都不做（全新安装不该凭空多出目录）；
 *   4. 失败路径：迁移失败（`plugins` 被占成普通文件）→ 回退读旧目录、不崩溃。
 *
 * 另外钉住两条实现约束：迁移幂等、旧地址是普通文件时不把文件当目录搬走。
 *
 * 做法与 test/save-path.test.js 一致：DSH_HOME 指到临时目录、最小假 ctx 走真实
 * apply()，再从 GET /status 读「插件实际用的是哪个目录」。绝不碰真实的 ~/.dsh。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 必须在导入插件前清掉：模块级路径解析会读 DSH_HOME。
delete process.env.DSH_HOME;

// 整包导入（而不是解构具名导出）：缺函数时要红在「行为缺失」上，
// 而不是红在「模块没有这个导出」的语法/导入错误上。
const index = await import("../lib/index.js");
const { apply } = index;

/** 迁移前的旧地址（家目录根部）。 */
const OLD_REL = "dsh-decision-engine";
/** 迁移后的新地址（plugins 父目录下）。 */
const NEW_REL = join("plugins", "dsh-decision-engine");

/** 一份「老用户」配置：有 key、开着守卫。 */
const OLD_CONFIG = [
  "# 用户注释必须原样保留",
  "enabled: true",
  "provider: systemone",
  "systemoneApiKey: sk-MOVED-KEY-1234",
  "",
].join("\n");

/** 造一个隔离的 DSH_HOME。 */
function makeHome() {
  return mkdtempSync(join(tmpdir(), "dsh-plugindir-"));
}

/** 在 home 下按相对路径造目录并写入若干文件。 */
function seed(home, rel, files) {
  const dir = join(home, rel);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, { encoding: "utf8", mode: 0o600 });
  }
  return dir;
}

/**
 * 用最小假 ctx 跑一次 apply()。
 *
 * fetch 一律打桩成 404：迁移与路径解析都不该真的发网络请求，桩掉之后
 * 测试才是纯本地的（也避免 CI 上偶发的慢）。
 */
function runApply() {
  const routes = {};
  const connection = {
    fetch: {
      register(entry) {
        routes[entry.path] = entry;
      },
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on() {},
    get(name) {
      return name === "connection" ? connection : undefined;
    },
    inject(_names, fn) {
      fn();
    },
    plugin() {},
    effect() {},
  };
  apply(ctx, {});
  return { routes };
}

/** 读 /status：里面回报了插件实际在用的配置文件路径。 */
async function status(routes) {
  const res = await routes["/api/decision-engine/status"].fetch({ method: "GET" });
  return res.json();
}

/** 跑一次 apply 并清理，返回 /status 的结果。 */
async function statusAfterApply(home) {
  process.env.DSH_HOME = home;
  const { routes } = runApply();
  return status(routes);
}

test("正常路径：旧数据目录整体搬到 plugins/ 下，内容原样、旧目录消失", async () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  try {
    seed(home, OLD_REL, { "config.yml": OLD_CONFIG, "telemetry.jsonl": '{"point":"authorize"}\n' });

    const data = await statusAfterApply(home);

    const movedConfig = join(home, NEW_REL, "config.yml");
    assert.ok(existsSync(movedConfig), "配置应出现在新地址 plugins/dsh-decision-engine/config.yml");
    assert.equal(readFileSync(movedConfig, "utf8"), OLD_CONFIG, "内容必须逐字保留（含注释与 key）");
    assert.ok(
      existsSync(join(home, NEW_REL, "telemetry.jsonl")),
      "遥测是同目录的兄弟文件，整目录搬走后应一并到位",
    );
    assert.equal(existsSync(join(home, OLD_REL)), false, "旧目录应已消失（是搬走而不是复制）");
    assert.equal(data.configPath, movedConfig, "插件必须从新地址读配置");
    assert.equal(data.keyConfigured, true, "key 必须仍然可读——这正是本组测试要防的故障");
    // 老用户不能被当成全新安装（DEC-062）：默认开免费模型会顶掉他本地的 key。
    assert.equal(data.serverProvider.enabled, false, "迁移过的老用户默认仍应是关");
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("边界：新地址已存在时绝不覆盖、绝不合并，旧地址原样留着", async () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  try {
    const keep = "enabled: false\nsystemoneApiKey: sk-NEW-WINS\n";
    seed(home, NEW_REL, { "config.yml": keep });
    seed(home, OLD_REL, { "config.yml": OLD_CONFIG, "telemetry.jsonl": '{"point":"old"}\n' });

    const data = await statusAfterApply(home);

    assert.equal(
      readFileSync(join(home, NEW_REL, "config.yml"), "utf8"),
      keep,
      "新地址的配置必须原样保留，绝不能被旧目录覆盖",
    );
    assert.equal(
      existsSync(join(home, NEW_REL, "telemetry.jsonl")),
      false,
      "绝不合并：旧目录里的文件不应被搬进已存在的新目录",
    );
    assert.ok(existsSync(join(home, OLD_REL, "config.yml")), "旧地址必须原样留着，不删不改");
    assert.equal(data.configPath, join(home, NEW_REL, "config.yml"), "两个地址都在时应以新地址为准");
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("边界：旧地址不存在时静默什么都不做（不凭空建目录）", async () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  try {
    await statusAfterApply(home);
    assert.equal(
      existsSync(join(home, "plugins")),
      false,
      "全新安装不该被迁移逻辑凭空造出 plugins/ 目录",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("失败路径：迁移失败时回退读旧目录，插件照常可用、不崩溃", async () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  try {
    // 让迁移必然失败：把 plugins 占成普通文件，mkdir / rename 都会 ENOTDIR。
    writeFileSync(join(home, "plugins"), "not a directory", { encoding: "utf8" });
    const legacyDir = seed(home, OLD_REL, { "config.yml": OLD_CONFIG });

    const data = await statusAfterApply(home);

    assert.equal(
      data.configPath,
      join(legacyDir, "config.yml"),
      "搬不动就必须回退到旧地址继续读，而不是当成没有配置",
    );
    assert.equal(data.keyConfigured, true, "回退路径下 key 仍然要读得到");
    assert.ok(existsSync(join(legacyDir, "config.yml")), "失败时旧文件绝不能被删掉");
    assert.equal(
      readFileSync(join(home, "plugins"), "utf8"),
      "not a directory",
      "迁移失败不该改动挡路的那个文件",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("幂等：连续两次 apply 结果一致，不会搬第二次也不会报错", async () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  try {
    seed(home, OLD_REL, { "config.yml": OLD_CONFIG });
    await statusAfterApply(home);
    const afterFirst = readFileSync(join(home, NEW_REL, "config.yml"), "utf8");

    const data = await statusAfterApply(home);

    assert.equal(readFileSync(join(home, NEW_REL, "config.yml"), "utf8"), afterFirst, "第二次启动不应改动任何内容");
    assert.equal(existsSync(join(home, OLD_REL)), false, "旧目录不该被重新造出来");
    assert.equal(data.configPath, join(home, NEW_REL, "config.yml"));
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("旧地址是普通文件而不是目录时，不把文件当成数据目录搬走", async () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  try {
    writeFileSync(join(home, OLD_REL), "not a directory", { encoding: "utf8" });

    await statusAfterApply(home);

    assert.equal(existsSync(join(home, NEW_REL)), false, "普通文件不该被改名成数据目录");
    assert.equal(readFileSync(join(home, OLD_REL), "utf8"), "not a directory", "那个文件必须原样留着");
  } finally {
    globalThis.fetch = originalFetch;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("跨卷回退：rename 抛 EXDEV 时退化为递归拷贝再删除源目录", () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const legacyDir = seed(home, OLD_REL, {
      "config.yml": OLD_CONFIG,
      "telemetry.jsonl": '{"point":"authorize"}\n',
    });

    assert.equal(
      typeof index.migratePluginDataDir,
      "function",
      "整目录迁移应可单独注入 rename 来验证跨卷回退",
    );
    const result = index.migratePluginDataDir({
      // 只让「跨卷」的那一步抛 EXDEV——这正是真实跨卷的形状：旧目录在别的
      // 卷上（rename 必失败），而 staging 与新地址同父目录，落位那步是同卷的。
      rename(from, to) {
        if (from === legacyDir) {
          const error = new Error("EXDEV: cross-device link not permitted");
          error.code = "EXDEV";
          throw error;
        }
        return renameSync(from, to);
      },
    });

    assert.equal(result, "moved", "跨卷时应走拷贝分支并报告已搬走");
    assert.equal(
      readFileSync(join(home, NEW_REL, "config.yml"), "utf8"),
      OLD_CONFIG,
      "拷贝分支同样要逐字保留内容",
    );
    assert.ok(existsSync(join(home, NEW_REL, "telemetry.jsonl")), "兄弟文件也要一并搬过去");
    assert.equal(existsSync(legacyDir), false, "拷贝成功后必须删掉源目录，否则两份数据并存");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("拷贝中途失败：新地址不被残骸占住，旧地址原样留着、下次还能重试", () => {
  const home = makeHome();
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const legacyDir = seed(home, OLD_REL, { "config.yml": OLD_CONFIG });

    // 模拟「跨卷 + 落位那一步也失败」（例如拷贝到一半磁盘写满）：
    // 第一次 rename 抛 EXDEV 走拷贝，第二次（staging → new）再抛。
    const result = index.migratePluginDataDir({
      rename(from, to) {
        const error = new Error(from === legacyDir ? "EXDEV" : "ENOSPC");
        error.code = from === legacyDir ? "EXDEV" : "ENOSPC";
        throw error;
      },
    });

    assert.equal(result, "failed", "落位失败应报告 failed，由调用方回退读旧地址");
    assert.equal(
      existsSync(join(home, NEW_REL)),
      false,
      "半拷贝绝不能占住新地址：否则下次启动会按「新地址已存在」直接跳过，用户从此读残缺配置",
    );
    assert.equal(
      existsSync(join(home, `${NEW_REL}.migrating`)),
      false,
      "staging 残骸应被清掉，不留垃圾也不影响下次重试",
    );
    assert.equal(readFileSync(join(legacyDir, "config.yml"), "utf8"), OLD_CONFIG, "旧地址是唯一的完整副本，绝不能动");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
