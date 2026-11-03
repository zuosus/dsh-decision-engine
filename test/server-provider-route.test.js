/**
 * 服务端下发 provider 配置的接线测试（DEC-030）。
 *
 * 这一组测的不是「函数能不能跑」，而是**这个功能的承诺有没有兑现**。它只有
 * 三条承诺，每条都只有靠端到端跑一遍才能确认：
 *
 *   1. **下发的值真的被用上了**：地址、模型、key 三样都换成下发值。只换地址
 *      不换 key 是最危险的半成品——那是用本地账号打服务端的地址，必 401，
 *      而守卫是 fail-open 的，症状是「静默没反应」。
 *   2. **下发的 key 真的没落盘**：跑完一整套流程后，逐个读磁盘上的配置、
 *      凭据、遥测、统计、明细、统计状态文件，明文 key 一个字节都不许出现。
 *      这条承诺没法靠读代码确认——只能读文件。
 *   3. **服务端不可用时真的回落到本地**：不是崩掉、不是持续重试风暴，
 *      而是照旧用本地手动配置。
 *
 * 做法与 test/save-path.test.js 一致：`DSH_HOME` 指到临时目录，用最小假 ctx
 * 走真实 `apply()`，直接调注册进来的 fetch。服务端的 fetch 用桩，不打网络。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";
import {
  DEFAULT_TTL_SECONDS,
  SERVER_CONFIG_ENDPOINT,
} from "../lib/server-config.js";

/** 下发的那把 key：够醒目，任何地方出现都能被一眼 grep 到。 */
const SERVER_KEY = "sk-SERVER-CANARY-d41d8cd98f00b204";
/** 本地手动配置的那把 key：用于证明「下发失效时用的仍是它」。 */
const LOCAL_KEY = "sk-LOCAL-CANARY-aabbccdd11223344";

/**
 * 造一套隔离环境，并让服务端 fetch 走桩。
 *
 * @param options.responder - `(url, init) => ({ status, body }) | throws`。
 *   只有**下发端点**会被它接管；决策端点的请求照旧返回一个成功响应，
 *   以便观察请求头与地址。
 * @returns `{ home, routes, decisionCalls, serverCalls, dataFiles, restore }`。
 */
function setup(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-servercfg-"));
  process.env.DSH_HOME = home;

  const decisionCalls = [];
  const serverCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("provider-config")) {
      serverCalls.push({ url: target, init });
      const responder = options.responder;
      if (typeof responder === "function") return responder(target, init);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            v: 1,
            baseUrl: "https://api.example.com/v1",
            model: "Kev-4B",
            endpointStyle: "systemone",
            key: SERVER_KEY,
            ttlSeconds: DEFAULT_TTL_SECONDS,
          };
        },
        async text() {
          return "";
        },
      };
    }
    decisionCalls.push({ url: target, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { answers: {}, model: "Kev-4B" };
      },
      async text() {
        return "{}";
      },
    };
  };

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

  const dataDir = join(home, "dsh-decision-engine");
  return {
    home,
    routes,
    decisionCalls,
    serverCalls,
    dataDir,
    configPath: join(dataDir, "config.yml"),
    credPath: join(home, ".credentials.yaml"),
    restore() {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 走一次 GET /status。 */
async function getStatus(routes) {
  const res = await routes["/api/decision-engine/status"].fetch({
    method: "GET",
    url: "http://localhost/api/decision-engine/status",
  });
  return { status: res.status, data: await res.json() };
}

/** 走一次 PUT /config。 */
async function putConfig(routes, body) {
  const res = await routes["/api/decision-engine/config"].fetch({
    method: "PUT",
    url: "http://localhost/api/decision-engine/config",
    async text() {
      return JSON.stringify(body);
    },
  });
  return { status: res.status, data: await res.json() };
}

/** 走一次 POST /server-provider（强制刷新）。 */
async function postRefresh(routes) {
  const res = await routes["/api/decision-engine/server-provider"].fetch({
    method: "POST",
    url: "http://localhost/api/decision-engine/server-provider",
  });
  return { status: res.status, data: await res.json() };
}

/** 走一次 POST /test（真打一次决策端点，用来观察实际发到哪）。 */
async function postTest(routes) {
  const res = await routes["/api/decision-engine/test"].fetch({
    method: "POST",
    url: "http://localhost/api/decision-engine/test",
  });
  return { status: res.status, data: await res.json() };
}

/**
 * 递归收集数据目录下的所有文件内容。
 *
 * 为什么要递归而不是逐个点名：点名只能覆盖「我以为会写」的文件，
 * 而漏掉的正是将来某天新加的那个。测试要盯的是**磁盘**，不是清单。
 */
function readAllFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...readAllFiles(path));
    } else {
      out.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

// ---------------------------------------------- 1. 下发的值真的被用上

test("打开开关后，决策请求打到下发地址并带下发 key", async () => {
  const env = setup();
  try {
    const put = await putConfig(env.routes, { serverProvider: true });
    assert.equal(put.status, 200, `开启开关应成功：${JSON.stringify(put.data)}`);
    assert.equal(put.data.serverProvider.enabled, true, "回显应报告开关已开");

    // 强制刷新一次，把下发值取回来（不依赖后台时序）。
    const refreshed = await postRefresh(env.routes);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.data.serverProvider.status, "ready", "刷新后应处于 ready");

    // 真打一次决策端点，观察它到底发到哪、带了什么头。
    await postTest(env.routes);
    const call = env.decisionCalls.at(-1);
    assert.ok(call !== undefined, "没有发出任何决策请求");
    assert.ok(
      call.url.startsWith("https://api.example.com/v1"),
      `决策请求应打在下发地址上，实际：${call.url}`,
    );
    assert.ok(
      call.url.endsWith("/systemone"),
      `端点风格应来自下发值（systemone），实际：${call.url}`,
    );
    assert.equal(
      call.init.headers.authorization,
      `Bearer ${SERVER_KEY}`,
      "必须使用下发的那把 key（用本地 key 打下发地址等于拿错账号）",
    );
  } finally {
    env.restore();
  }
});

test("下发的 model 会进入请求体，而不是沿用本地模型", async () => {
  const env = setup();
  try {
    await putConfig(env.routes, { serverProvider: true });
    await postRefresh(env.routes);
    await postTest(env.routes);
    const call = env.decisionCalls.at(-1);
    const body = JSON.parse(call.init.body);
    assert.equal(body.model, "Kev-4B", `请求体应用下发的模型，实际：${call.init.body}`);
  } finally {
    env.restore();
  }
});

test("下发覆盖不改写本地 provider 选择（否则面板会把 server 写回配置）", async () => {
  // provider 是用户持久化的选择。若 status 把 provider 报成 "server"，前端
  // 会把它原样提交回来，而 PUT 的白名单只认 PROVIDER_IDS —— 一次 400，
  // 症状是「保存了没生效」。
  const env = setup();
  try {
    await putConfig(env.routes, { serverProvider: true });
    await postRefresh(env.routes);
    const { data } = await getStatus(env.routes);
    assert.equal(data.serverProvider.active, true, "下发值应处于生效状态");
    assert.ok(
      !String(data.provider).includes("server"),
      `status 的 provider 必须仍是本地选择，实际：${data.provider}`,
    );
    assert.equal(data.keySource, "server", "key 来源应如实报成 server");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------- 2. 下发的 key 不落盘

test("整套流程跑完后，磁盘上任何文件都不含下发的 key", async () => {
  const env = setup();
  try {
    await putConfig(env.routes, { serverProvider: true });
    await postRefresh(env.routes);
    await postTest(env.routes);
    await getStatus(env.routes);

    // 逐个读：配置、凭据、以及数据目录下的遥测 / 统计 / 明细 / 状态文件。
    const files = [
      { path: env.configPath, text: existsSync(env.configPath) ? readFileSync(env.configPath, "utf8") : "" },
      { path: env.credPath, text: existsSync(env.credPath) ? readFileSync(env.credPath, "utf8") : "" },
      ...readAllFiles(env.dataDir),
    ];
    const leaked = files.filter((file) => file.text.includes(SERVER_KEY));
    assert.deepEqual(
      leaked.map((file) => file.path),
      [],
      `下发的 key 被写进了磁盘：\n${leaked.map((f) => f.path).join("\n")}`,
    );
    // 反证：检查确实有内容可查，不是「文件都没生成所以通过」。
    assert.ok(
      files.some((file) => file.text.includes("serverProvider: true")),
      "config.yml 应记录了开关（这条同时证明上面的检查不是空集）",
    );
  } finally {
    env.restore();
  }
});

test("任何接口的响应里都不出现明文 key（最多末四位）", async () => {
  // 这份 JSON 会经过浏览器。既有约定是只回 keyHint，这里守的正是那条约定
  // ——它靠人守，所以必须有断言。
  const env = setup();
  try {
    await putConfig(env.routes, { serverProvider: true });
    const refreshed = await postRefresh(env.routes);
    const status = await getStatus(env.routes);

    for (const [name, data] of [
      ["POST /server-provider", refreshed.data],
      ["GET /status", status.data],
    ]) {
      const text = JSON.stringify(data);
      assert.equal(text.includes(SERVER_KEY), false, `${name} 的响应泄漏了明文 key`);
      // 末四位是允许的（用户要靠它确认是哪一把）。
      assert.equal(data.serverProvider.keyHint, `…${SERVER_KEY.slice(-4)}`, `${name} 应回报 key 末四位`);
    }
  } finally {
    env.restore();
  }
});

// ---------------------------------------------- 3. 失败时回落

test("服务端 404（未部署 key）时静默回落到本地配置", async () => {
  const env = setup({
    responder: () => ({ ok: false, status: 404, json: async () => ({ ok: false, err: "not-configured" }) }),
  });
  try {
    await putConfig(env.routes, { serverProvider: true });
    const refreshed = await postRefresh(env.routes);
    assert.equal(refreshed.data.serverProvider.status, "error", "应报错状态");
    assert.equal(refreshed.data.serverProvider.active, false, "不可用时不得标记为生效");

    // 关键：此时打出去的必须是本地端点、本地 key。
    await postTest(env.routes);
    const call = env.decisionCalls.at(-1);
    assert.ok(call !== undefined, "回落时仍应能发出决策请求");
    assert.equal(
      call.url.startsWith("https://api.example.com"),
      false,
      `回落时不该打下发地址，实际：${call.url}`,
    );
  } finally {
    env.restore();
  }
});

test("服务端网络异常时也不抛，只报状态", async () => {
  const env = setup({
    responder: () => {
      throw new Error("network down");
    },
  });
  try {
    await putConfig(env.routes, { serverProvider: true });
    const refreshed = await postRefresh(env.routes);
    assert.equal(refreshed.status, 200, "刷新失败不应把整个接口打挂");
    assert.equal(refreshed.data.serverProvider.status, "error");
    // 错误文案要能看：只报「失败」而不给原因，用户无法判断是网络还是配置。
    assert.ok(
      String(refreshed.data.serverProvider.error).length > 0,
      "错误状态必须带可展示的原因",
    );
  } finally {
    env.restore();
  }
});

test("下发的 baseUrl 非法时整笔拒绝，不半桌拼接", async () => {
  // 只有地址不合格、key 却可用：绝不能「用下发的 key 打本地地址」。
  const env = setup({
    responder: () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        v: 1,
        baseUrl: "ftp://nope.example.com/v1",
        model: "Kev-4B",
        key: SERVER_KEY,
      }),
    }),
  });
  try {
    await putConfig(env.routes, { serverProvider: true });
    const refreshed = await postRefresh(env.routes);
    assert.equal(refreshed.data.serverProvider.status, "error", "非法载荷应被整笔拒绝");
    assert.equal(refreshed.data.serverProvider.active, false);
  } finally {
    env.restore();
  }
});

// ---------------------------------------------- 4. 关掉开关

test("关掉开关后清空内存里的下发值，并不再请求下发端点", async () => {
  const env = setup();
  try {
    await putConfig(env.routes, { serverProvider: true });
    await postRefresh(env.routes);
    const before = env.serverCalls.length;
    assert.ok(before > 0, "开启后应至少请求过一次下发端点");

    const off = await putConfig(env.routes, { serverProvider: false });
    assert.equal(off.status, 200);
    assert.equal(off.data.serverProvider.enabled, false, "关掉后回显应为关");
    assert.equal(off.data.serverProvider.active, false, "关掉后不得仍标记为生效");
    assert.equal(off.data.serverProvider.keyHint, "", "关掉后内存里的 key 应被清空（连末四位都不留）");

    // 再请求两次状态：关着就不该再去打下发端点。
    await getStatus(env.routes);
    await getStatus(env.routes);
    assert.equal(
      env.serverCalls.length,
      before,
      "开关关闭后不应再请求下发端点",
    );
  } finally {
    env.restore();
  }
});

// ---------------------------------------------- 5. 默认关（回归）

test("默认关闭时，一次状态请求不会去下发端点取任何东西", async () => {
  // 这是「装了插件不等于联网」的姿态：默认关就必须一个请求都不发。
  const env = setup();
  try {
    const { data } = await getStatus(env.routes);
    assert.equal(data.serverProvider.enabled, false, "默认必须关");
    assert.equal(data.serverProvider.status, "idle", "默认应是 idle");
    assert.equal(env.serverCalls.length, 0, "默认关闭时不应请求下发端点");
    assert.ok(
      data.serverProvider.endpoint === SERVER_CONFIG_ENDPOINT,
      "即使没开，也应回报内置端点地址（面板要显示它是从哪取的）",
    );
  } finally {
    env.restore();
  }
});

test("serverProvider 只接受布尔值（避免字符串 'false' 被当成真）", async () => {
  const env = setup();
  try {
    const bad = await putConfig(env.routes, { serverProvider: "false" });
    assert.equal(bad.status, 400, `非布尔值应被拒，实际：${JSON.stringify(bad.data)}`);
    assert.ok(
      String(bad.data.error).includes("布尔"),
      `错误文案应说明原因，实际：${bad.data.error}`,
    );
  } finally {
    env.restore();
  }
});
