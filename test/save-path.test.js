/**
 * 保存链路的验收测试：首次保存要能建目录，失败必须整体回滚。
 *
 * 为什么单列一组：这条链路最容易出「半成功」——凭据已经写进去、配置却
 * 没写进去，用户只看到一条报错，而 key 其实已经悄悄换了。这种状态在界面上
 * 与「完全没保存」无法区分，是本项目反复踩到的故障形态。
 *
 * 覆盖：
 *   1. 全新安装（数据目录不存在）时首次保存能成功，并自动建出目录
 *   2. 配置写入失败时，已写入的凭据必须回滚为原值
 *   3. keyStorage=config 时凭据文件不被写（明文不落两处）
 *
 * 做法：把 DSH_HOME 指到临时目录，用最小假 ctx 走真实 PUT /config。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";
import { pickRefValue } from "../lib/credentials.js";

/** 造隔离环境；返回 home、configPath、credentialsPath 与已注册的接口表。 */
function setup({ seedCredentials } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-save-"));
  process.env.DSH_HOME = home;
  const credPath = join(home, ".credentials.yaml");
  if (seedCredentials !== undefined) {
    writeFileSync(credPath, seedCredentials, { encoding: "utf8", mode: 0o600 });
  }
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
  return { home, routes, credPath, configPath: join(home, "dsh-decision-engine", "config.yml") };
}

/** 走真实 PUT /api/decision-engine/config。 */
async function putConfig(routes, body) {
  const res = await routes["/api/decision-engine/config"].fetch({
    method: "PUT",
    text: async () => JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test("全新安装（数据目录不存在）首次保存能成功，并自动建出目录", async () => {
  const { home, routes, configPath } = setup();
  try {
    assert.equal(existsSync(join(home, "dsh-decision-engine")), false, "前置：目录应不存在");

    const { status, data } = await putConfig(routes, {
      provider: "bamboonode",
      keyStorage: "config",
      enabled: true,
      bamboonodeApiKey: "sk-FRESH-INSTALL-123456",
    });

    assert.equal(status, 200, `首次保存应成功，实际：${JSON.stringify(data)}`);
    assert.ok(existsSync(join(home, "dsh-decision-engine")), "应自动创建数据目录");
    assert.ok(existsSync(configPath), "应写出 config.yml");

    const raw = readFileSync(configPath, "utf8");
    assert.ok(raw.includes("bamboonodeApiKey: sk-FRESH-INSTALL-123456"), "key 应写入配置");
    assert.ok(raw.includes("enabled: true"), "其它字段也应写入");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配置写入失败时，已写入的凭据回滚为原值（不留半套改动）", async () => {
  const { home, routes, credPath, configPath } = setup({
    seedCredentials: "version: 1\nrefs:\n  BAMBOO_API_KEY: sk-ORIGINAL-KEY\n",
  });
  try {
    // 制造写入失败：把数据目录占成一个普通文件，mkdir 必然失败。
    writeFileSync(join(home, "dsh-decision-engine"), "not a directory");
    assert.equal(existsSync(configPath), false);

    const { status, data } = await putConfig(routes, {
      provider: "bamboonode",
      keyStorage: "credentials",
      bamboonodeApiKey: "sk-NEW-KEY-SHOULD-ROLL-BACK",
    });

    assert.equal(status, 500, "配置写不进去时必须整体报错，而不是假装成功");
    assert.ok(typeof data.error === "string" && data.error.length > 0, "应返回可展示的原因");

    // 核心断言：凭据必须还是原值，不能留下「凭据改了、配置没改」。
    const after = pickRefValue(readFileSync(credPath, "utf8"), "BAMBOO_API_KEY");
    assert.equal(after, "sk-ORIGINAL-KEY", "凭据必须回滚为写入前的值");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keyStorage=config 时凭据文件不被写入（明文不落两处）", async () => {
  const { home, routes, credPath } = setup({
    seedCredentials: "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-KEEP\n",
  });
  try {
    const { status } = await putConfig(routes, {
      provider: "bamboonode",
      keyStorage: "config",
      bamboonodeApiKey: "sk-ONLY-IN-CONFIG",
    });
    assert.equal(status, 200);

    const raw = readFileSync(credPath, "utf8");
    assert.equal(pickRefValue(raw, "BAMBOO_API_KEY"), undefined, "凭据文件里不应出现这个 key");
    assert.equal(pickRefValue(raw, "DEEPSEEK_API_KEY"), "sk-KEEP", "其它凭据不应被改动");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keyStorage=credentials 时 key 写进凭据文件、且不落配置文件", async () => {
  const { home, routes, credPath, configPath } = setup();
  try {
    const { status } = await putConfig(routes, {
      provider: "bamboonode",
      keyStorage: "credentials",
      bamboonodeApiKey: "sk-TO-CREDENTIALS-777",
    });
    assert.equal(status, 200);

    assert.equal(
      pickRefValue(readFileSync(credPath, "utf8"), "BAMBOO_API_KEY"),
      "sk-TO-CREDENTIALS-777",
      "应写进凭据文件",
    );
    const yml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    assert.equal(yml.includes("sk-TO-CREDENTIALS-777"), false, "明文不应同时落进配置文件");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("五个 provider 分别写各自命名的凭据键，互不覆盖", async () => {
  const { home, routes, credPath } = setup();
  try {
    // 每个 provider 存一次自己的 key（模拟用户逐个配置）。
    // 覆盖全部预设：persistKeys 的槽位是**按预设表生成**的，漏掉一个 provider
    // 时它的 key 会绕过凭据文件、直接以明文写进 config.yml。
    for (const [provider, field, value] of [
      ["systemone", "systemoneApiKey", "sk-SYSTEMONE-A"],
      ["bamboonode", "bamboonodeApiKey", "sk-BAMBOONODE-B"],
      ["siliconflow", "siliconflowApiKey", "sk-SILICONFLOW-C"],
      ["siliconflow-intl", "siliconflowIntlApiKey", "sk-SILICONFLOW-INTL-D"],
      ["custom", "customApiKey", "sk-CUSTOM-E"],
    ]) {
      const body = { keyStorage: "credentials", provider, [field]: value };
      if (provider === "custom") body.customBaseUrl = "https://gw.example.com/v1";
      const { status, data } = await putConfig(routes, body);
      assert.equal(status, 200, `${provider} 保存失败：${JSON.stringify(data)}`);
    }

    const raw = readFileSync(credPath, "utf8");
    assert.equal(pickRefValue(raw, "TYPESAFE_API_KEY"), "sk-SYSTEMONE-A");
    assert.equal(pickRefValue(raw, "BAMBOO_API_KEY"), "sk-BAMBOONODE-B");
    assert.equal(pickRefValue(raw, "SILICONFLOW_API_KEY"), "sk-SILICONFLOW-C");
    assert.equal(pickRefValue(raw, "SILICONFLOW_INTL_API_KEY"), "sk-SILICONFLOW-INTL-D");
    assert.equal(pickRefValue(raw, "DECISION_ENGINE_CUSTOM_KEY"), "sk-CUSTOM-E");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
