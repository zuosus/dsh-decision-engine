/**
 * 「删除配置」按钮的服务端验收（DEC-080）。
 *
 * 按钮删的是**当前 provider 的 API Key**，两处存储都要清：
 *   - keyStorage=credentials → ~/.dsh/.credentials.yaml 的 refs 项；
 *   - keyStorage=config      → config.yml 里的显式 key 字段。
 * 其余配置（provider / 模型 / 地址 / 变量名）必须原样保留。
 *
 * 做法与 save-path.test.js 一致：DSH_HOME 指到临时目录，用最小假 ctx 走真实
 * apply()，直接调注册进来的 fetch，再读磁盘断言结果。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";
import { pickRefValue } from "../lib/credentials.js";

function setup({ config, credentials, env } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-delkey-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  if (credentials !== undefined) {
    writeFileSync(join(home, ".credentials.yaml"), credentials, { encoding: "utf8", mode: 0o600 });
  }
  const configDir = join(home, "plugins", "dsh-decision-engine");
  const configPath = join(configDir, "config.yml");
  if (config !== undefined) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, config, { encoding: "utf8", mode: 0o600 });
  }
  const savedEnv = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const routes = {};
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on() {},
    get(name) {
      return name === "connection" ? { fetch: { register(entry) { routes[entry.path] = entry; } } } : undefined;
    },
    inject(_names, fn) { fn(); },
    plugin() {},
    effect() {},
  };
  apply(ctx, {});
  return {
    home,
    routes,
    configPath,
    credPath: join(home, ".credentials.yaml"),
    cleanup() {
      process.env.DSH_HOME = previousHome ?? "";
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function callDeleteKey(routes, body) {
  const route = routes["/api/decision-engine/config/key"];
  assert.ok(route, "应注册 DELETE /api/decision-engine/config/key 路由");
  assert.ok(route.methods.includes("DELETE"), "路由应允许 DELETE 方法");
  const res = await route.fetch({
    method: "DELETE",
    url: "http://localhost/api/decision-engine/config/key",
    text: async () => JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test("删除凭据模式下的 key：refs 项消失，其它 provider 的 key 与其它配置保留（DEC-080）", async () => {
  const { routes, credPath, configPath, cleanup } = setup({
    credentials: [
      "version: 1",
      "refs:",
      "  TYPESAFE_API_KEY: sk-TYPESAFE-1234567890",
      "  SILICONFLOW_API_KEY: sk-SILICONFLOW-1234567890",
      "records:",
      "  keep: this",
      "",
    ].join("\n"),
    config: [
      "provider: systemone",
      "model: keep-model",
      "enabled: true",
      "keyStorage: credentials",
      "",
    ].join("\n"),
  });
  try {
    const { status, data } = await callDeleteKey(routes, { provider: "systemone" });
    assert.equal(status, 200, `删除应成功，实际：${JSON.stringify(data)}`);
    const raw = readFileSync(credPath, "utf8");
    assert.equal(pickRefValue(raw, "TYPESAFE_API_KEY"), undefined, "当前 provider 的 key 应被删除");
    assert.equal(
      pickRefValue(raw, "SILICONFLOW_API_KEY"),
      "sk-SILICONFLOW-1234567890",
      "其它 provider 的 key 不能受影响",
    );
    assert.ok(raw.includes("records:"), "refs 以外的段必须原样保留");
    const cfg = readFileSync(configPath, "utf8");
    assert.ok(cfg.includes("model: keep-model"), "模型等其它配置保留");
    assert.equal(data.keyStatus?.systemone?.configured, false, "返回的状态里该 provider 应变成未配置");
    assert.equal(data.keyStatus?.siliconflow?.configured, true, "其它 provider 状态不变");
  } finally {
    cleanup();
  }
});

test("删除配置文件模式下的 key：显式 key 字段消失，其它字段保留（DEC-080）", async () => {
  const { routes, configPath, cleanup } = setup({
    config: [
      "provider: systemone",
      "keyStorage: config",
      "systemoneApiKey: sk-PLAINTEXT-1234567890",
      "systemoneModel: keep-model",
      "enabled: true",
      "",
    ].join("\n"),
  });
  try {
    const { status, data } = await callDeleteKey(routes, { provider: "systemone" });
    assert.equal(status, 200, `删除应成功，实际：${JSON.stringify(data)}`);
    const raw = readFileSync(configPath, "utf8");
    const valueLine = raw.split("\n").find((line) => line.startsWith("systemoneApiKey:"));
    assert.ok(valueLine !== undefined && valueLine.replace("systemoneApiKey:", "").trim() === "", "config.yml 里的明文 key 应被清空（按键保留空行，不破坏注释/其它字段）");
    assert.equal(raw.includes("sk-PLAINTEXT-1234567890"), false, "明文 key 不应残留在文件里");
    assert.ok(raw.includes("systemoneModel: keep-model"), "模型字段保留");
    assert.ok(raw.includes("enabled: true"), "开关保留");
    assert.equal(data.keyStatus?.systemone?.configured, false, "返回状态应显示未配置");
  } finally {
    cleanup();
  }
});

test("删除不存在的 key 是安全的空操作（DEC-080）", async () => {
  const { routes, credPath, cleanup } = setup({
    credentials: "version: 1\nrefs:\n  SILICONFLOW_API_KEY: sk-KEEP-1234567890\n",
  });
  try {
    const before = readFileSync(credPath, "utf8");
    const { status, data } = await callDeleteKey(routes, { provider: "systemone" });
    assert.equal(status, 200, `本来就没有 key，删除也应成功：${JSON.stringify(data)}`);
    assert.equal(readFileSync(credPath, "utf8"), before, "没有 key 时凭据文件不应被改写");
    assert.equal(data.keyStatus?.systemone?.configured, false);
  } finally {
    cleanup();
  }
});

test("拒绝未知 provider，且不碰任何凭据（DEC-080）", async () => {
  const { routes, credPath, cleanup } = setup({
    credentials: "version: 1\nrefs:\n  TYPESAFE_API_KEY: sk-KEEP-1234567890\n",
  });
  try {
    const before = readFileSync(credPath, "utf8");
    const { status, data } = await callDeleteKey(routes, { provider: "not-a-provider" });
    assert.equal(status, 400, "未知 provider 应被拒绝，避免删错 key");
    assert.ok(typeof data.error === "string" && data.error.length > 0, "应返回原因");
    assert.equal(readFileSync(credPath, "utf8"), before, "失败的删除不能碰凭据文件");
  } finally {
    cleanup();
  }
});

test("删除后重新打开 /status 仍显示未配置（状态不是只在本次响应里改了）（DEC-080）", async () => {
  const { routes, credPath, cleanup } = setup({
    credentials: "version: 1\nrefs:\n  TYPESAFE_API_KEY: sk-TYPESAFE-1234567890\n",
  });
  try {
    await callDeleteKey(routes, { provider: "systemone" });
    assert.equal(pickRefValue(readFileSync(credPath, "utf8"), "TYPESAFE_API_KEY"), undefined);
    const res = await routes["/api/decision-engine/status"].fetch({
      method: "GET",
      url: "http://localhost/api/decision-engine/status",
    });
    const data = await res.json();
    assert.equal(data.keyStatus?.systemone?.configured, false, "再次读状态应仍是未配置");
  } finally {
    cleanup();
  }
});

test("keyStorage=config 时删除不会去动凭据文件里同名的 ref（DEC-080）", async () => {
  const { routes, credPath, cleanup } = setup({
    credentials: "version: 1\nrefs:\n  TYPESAFE_API_KEY: sk-CREDENTIALS-1234567890\n",
    config: ["provider: systemone", "keyStorage: config", "systemoneApiKey: sk-CONFIG-1234567890", ""].join("\n"),
  });
  try {
    await callDeleteKey(routes, { provider: "systemone" });
    // 切换存储位置时旧值不清除是既有约定（persistKeys 的规则 2）；删除只针对
    // 当前生效位置，凭据里的旧值保留，用户切回去还能用。
    assert.equal(
      pickRefValue(readFileSync(credPath, "utf8"), "TYPESAFE_API_KEY"),
      "sk-CREDENTIALS-1234567890",
      "删除当前生效位置的 key，不应顺手删掉另一处保存的值",
    );
  } finally {
    cleanup();
  }
});

test("凭据文件不存在时删除 key 不报错（DEC-080）", async () => {
  const { routes, credPath, cleanup } = setup();
  try {
    assert.equal(existsSync(credPath), false, "前置：凭据文件应不存在");
    const { status, data } = await callDeleteKey(routes, { provider: "systemone" });
    assert.equal(status, 200, `没有凭据文件时删除也应安全返回：${JSON.stringify(data)}`);
  } finally {
    cleanup();
  }
});
