/**
 * 「免费模型兜底」（backup model）的端到端接线测试。
 *
 * 这一组测的不是「纯函数算得对不对」（那在 test/backup-model.test.js），而是
 * **这个功能的四条承诺有没有兑现**——它们只能靠真发一遍请求来确认：
 *
 *   1. **默认关就是真的不动**：主模型 429 时只发一条请求，绝不碰下发端点。
 *   2. **开着且就绪时真的接管**：第一条打主模型（失败），第二条打免费端点，
 *      且用的是**下发的那把 key**、**同一份请求体**，答案按正常裁决处理。
 *   3. **兜底不可用时不白发请求**：主模型的失败原样降级，原因不被人为改写。
 *   4. **归因分得清**：兜底成功的那次记成 provider = `server` 且 `backup: true`，
 *      统计与决策明细都能认出「这次是兜底的」。
 *
 * 另外两条是既有承诺的回归护栏：下发的明文 key 仍然**永不落盘**；兜底结果
 * **不进缓存**（否则后续同题会既不打主模型也无从得知它是否恢复）。
 *
 * 做法与 test/server-provider-route.test.js 一致：`DSH_HOME` 指到临时目录，
 * 用最小假 ctx 走真实 `apply()`，服务端的 fetch 用桩，不打网络。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply, StartluxClient } from "../lib/index.js";
import { DEFAULT_TTL_SECONDS, SERVER_CONFIG_ENDPOINT } from "../lib/server-config.js";

/** 下发的那把 key：够醒目，任何地方出现都能被一眼 grep 到。 */
const BACKUP_KEY = "sk-BACKUP-CANARY-9f8e7d6c5b4a3210";

/** 主模型（本地配置）的 base URL：与下发地址刻意不同，便于按地址断言。 */
const LOCAL_ORIGIN = "https://local.example.com";
const FREE_ORIGIN = "https://free.example.com";

/** 造一套隔离环境；决策端点由 `options.decide` 决定怎么回。 */
function setup(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-backup-"));
  process.env.DSH_HOME = home;

  // 本地配置：custom provider 指向 LOCAL_ORIGIN。用 custom 是为了让「主模型
  // 地址」与「下发地址」明显不同，断言不会互相误命中。
  if (options.seedConfig !== undefined) {
    const dir = join(home, "plugins", "dsh-decision-engine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yml"), options.seedConfig, { encoding: "utf8", mode: 0o600 });
  }

  const decisionCalls = [];
  const serverCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === SERVER_CONFIG_ENDPOINT) {
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
            baseUrl: `${FREE_ORIGIN}/v1`,
            model: "Kev-4B",
            endpointStyle: "systemone",
            key: BACKUP_KEY,
            ttlSeconds: DEFAULT_TTL_SECONDS,
          };
        },
        async text() {
          return "";
        },
      };
    }
    decisionCalls.push({ url: target, init });
    const decide = options.decide;
    if (typeof decide === "function") return decide(target, init, decisionCalls.length);
    return okResponse();
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

  const dataDir = join(home, "plugins", "dsh-decision-engine");
  return {
    home,
    routes,
    decisionCalls,
    serverCalls,
    dataDir,
    configPath: join(dataDir, "config.yml"),
    restore() {
      globalThis.fetch = originalFetch;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 一个成功的决策响应（只实现 classify 用到的字段）。 */
function okResponse(answers = { risk: { type: "noul", noul: 0.1 } }) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => undefined },
    async json() {
      return { answers, model: "free-model" };
    },
    async text() {
      return "{}";
    },
  };
}

/** 指定状态码的错误响应。 */
function statusResponse(status, body = "boom") {
  return {
    ok: false,
    status,
    headers: { get: () => undefined },
    async json() {
      return { error: body };
    },
    async text() {
      return body;
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

/** 走一次 POST /server-provider（强制刷新下发值）。 */
async function postRefresh(routes) {
  const res = await routes["/api/decision-engine/server-provider"].fetch({
    method: "POST",
    url: "http://localhost/api/decision-engine/server-provider",
  });
  return { status: res.status, data: await res.json() };
}

/** 走一次 POST /test（真打一次决策端点，用来看它落到哪）。 */
async function postTest(routes) {
  const res = await routes["/api/decision-engine/test"].fetch({
    method: "POST",
    url: "http://localhost/api/decision-engine/test",
  });
  return { status: res.status, data: await res.json() };
}

/** 递归收集一个目录下所有文件的文本（承诺 5：key 不落盘）。 */
function readAllFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...readAllFiles(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** 一份让主模型指向本地、并且已保存「兜底已开」的配置。 */
const LOCAL_CONFIG = [
  "enabled: true",
  "provider: custom",
  `customBaseUrl: ${LOCAL_ORIGIN}/v1`,
  "customEndpointStyle: decisions",
  "customApiKey: sk-local-test-key-0123456789",
  "customModel: local-model",
  "cacheSize: 0",
  "retryAttempts: 1",
  "failureThreshold: 99",
  "serverProvider: false",
  "backupModel: true",
  "",
].join("\n");

// ---------------------------------------------------------- 1. 默认关

test("默认关闭：主模型 429 时只发一条请求，且绝不请求下发端点", async () => {
  // 「默认关」不是风格问题：开了它就会在失败时多打一次网络请求、并要求插件
  // 提前去取免费配置。升级不能让任何人在不知情的情况下多出这些行为。
  const env = setup({
    // 已有配置（老用户），且没写 backupModel → 取内置默认 false。
    seedConfig: [
      "enabled: true",
      "provider: custom",
      `customBaseUrl: ${LOCAL_ORIGIN}/v1`,
      "customEndpointStyle: decisions",
      "customApiKey: sk-local-test-key-0123456789",
      "customModel: local-model",
      "cacheSize: 0",
      "serverProvider: false",
      "",
    ].join("\n"),
    decide: () => statusResponse(429, "insufficient balance"),
  });
  try {
    const { data } = await getStatus(env.routes);
    assert.equal(data.backupModel?.enabled, false, "没有配置时兜底必须默认关");

    const result = await postTest(env.routes);
    assert.equal(result.status, 200, "测试端点本身不该因为 429 而报错");
    assert.equal(
      result.data.ok,
      false,
      "本次决策应失败（429），但失败本身不是兜底能修的——开关关着",
    );
    assert.equal(env.decisionCalls.length, 1, "关着时不该有第二条请求");
    assert.equal(env.serverCalls.length, 0, "关着时绝不该请求下发端点");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------- 2. 开着且就绪

test("开着且就绪：主模型 429 后自动改用免费端点，用的是下发的那把 key", async () => {
  // 直接驱动 classify()：兜底是**决策**路径的行为，而 POST /test 是
  // 「测你配的那个端点」的诊断工具——让它静默改道，诊断结果就不再回答
  // 「我配的这个地址通不通」了。因此这里用真实的 StartluxClient，
  // 把「此刻可用的下发值」注入进去（apply() 里正是这么接的）。
  const dir = await mkdtemp(join(tmpdir(), "dsh-backup-classify-"));
  try {
    const calls = [];
    const cfg = {
      provider: "custom",
      customBaseUrl: `${LOCAL_ORIGIN}/v1`,
      customEndpointStyle: "decisions",
      customApiKey: "sk-local-test-key-0123456789",
      customModel: "local-model",
      cacheSize: 0,
      cacheTtlMs: 0,
      timeoutMs: 5000,
      thinkMode: "never",
      mode: "shadow",
      failureThreshold: 99,
      retryAttempts: 1,
      serverProvider: false,
      backupModel: true,
    };
    const client = new StartluxClient({
      getConfig: () => cfg,
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      getBackupOverride: () => ({
        baseUrl: `${FREE_ORIGIN}/v1`,
        model: "Kev-4B",
        endpointStyle: "systemone",
        key: BACKUP_KEY,
      }),
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        return String(url).startsWith(LOCAL_ORIGIN)
          ? statusResponse(429, "insufficient balance")
          : okResponse();
      },
    });

    const result = await client.classify({
      point: "authorize",
      tag: "guard",
      mode: "shadow",
      tool: "bash",
      state: { tool: "bash", args_preview: "{}" },
      questions: { alive: { type: "noul", instructions: "?" } },
    });

    assert.equal(result?.degraded, undefined, `兜底应让这次决策成功：${JSON.stringify(result)}`);
    assert.equal(calls.length, 2, `应恰好两条请求（主 + 兜底），实际 ${calls.length}`);
    assert.ok(calls[0].url.startsWith(LOCAL_ORIGIN), `第一条应打主模型，实际：${calls[0].url}`);
    assert.ok(calls[1].url.startsWith(FREE_ORIGIN), `第二条应打免费端点，实际：${calls[1].url}`);

    // 兜底必须带**下发的** key：拿本地 key 打下发地址等于用错账号。
    assert.equal(
      calls[1].init.headers.authorization,
      `Bearer ${BACKUP_KEY}`,
      "兜底请求应使用下发的那把 key",
    );
    // 请求体必须与主模型一致（same state / questions / think_mode），否则两次
    // 结论不可比。**唯一允许不同的是 model**：它是各服务商自己的模型名，
    // 不可能也不需要相同（下发值带的是免费通道那家的模型）。
    const primaryBody = JSON.parse(calls[0].init.body);
    const backupBody = JSON.parse(calls[1].init.body);
    assert.deepEqual(
      { ...backupBody, model: primaryBody.model },
      primaryBody,
      "除 model 外，兜底与主模型的请求体必须逐字相同",
    );
    assert.equal(backupBody.model, "Kev-4B", "兜底应使用下发值里的模型名");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("兜底成功时归因到 provider=server，并标记 backup=true", async () => {
  // 归因必须能看出「这次不是主模型答的」：否则统计页会把它算到主模型头上，
  // 「主模型花了多少」与「谁真的答了」两件事就混成一件。
  const dir = await mkdtemp(join(tmpdir(), "dsh-backup-attrib-"));
  try {
    const cfg = {
      provider: "custom",
      customBaseUrl: `${LOCAL_ORIGIN}/v1`,
      customEndpointStyle: "decisions",
      customApiKey: "sk-local-test-key-0123456789",
      customModel: "local-model",
      cacheSize: 0,
      cacheTtlMs: 0,
      timeoutMs: 5000,
      thinkMode: "never",
      mode: "shadow",
      failureThreshold: 99,
      retryAttempts: 1,
      serverProvider: false,
      backupModel: true,
    };
    const client = new StartluxClient({
      getConfig: () => cfg,
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      getBackupOverride: () => ({
        baseUrl: `${FREE_ORIGIN}/v1`,
        model: "Kev-4B",
        endpointStyle: "systemone",
        key: BACKUP_KEY,
      }),
      fetchFn: async (url) =>
        String(url).startsWith(LOCAL_ORIGIN) ? statusResponse(429) : okResponse(),
    });

    const result = await client.classify({
      point: "authorize",
      tag: "guard",
      mode: "shadow",
      tool: "bash",
      state: { tool: "bash", args_preview: "{}" },
      questions: { alive: { type: "noul", instructions: "?" } },
    });

    assert.equal(result?.backup, true, "兜底结果应带 backup 标记");
    assert.equal(result?.provider, "server", `provider 应为 server，实际 ${String(result?.provider)}`);
    assert.equal(result?.statsFacts?.backup, true, "统计事实也要带 backup，统计页才分得清");
    assert.equal(client.backupUses, 1, "兜底计数应加一（面板显示「已兜底 N 次」）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("兜底也失败时保留主模型的失败原因，并记下「试过兜底」", async () => {
  // 用兜底的错误（可能是 404/401）盖掉主模型的 429，会把人引向错的排查方向。
  const dir = await mkdtemp(join(tmpdir(), "dsh-backup-bothfail-"));
  try {
    const cfg = {
      provider: "custom",
      customBaseUrl: `${LOCAL_ORIGIN}/v1`,
      customEndpointStyle: "decisions",
      customApiKey: "sk-local-test-key-0123456789",
      customModel: "local-model",
      cacheSize: 0,
      cacheTtlMs: 0,
      timeoutMs: 5000,
      thinkMode: "never",
      mode: "shadow",
      failureThreshold: 99,
      retryAttempts: 1,
      serverProvider: false,
      backupModel: true,
    };
    const client = new StartluxClient({
      getConfig: () => cfg,
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      getBackupOverride: () => ({
        baseUrl: `${FREE_ORIGIN}/v1`,
        model: "Kev-4B",
        endpointStyle: "systemone",
        key: BACKUP_KEY,
      }),
      fetchFn: async (url) =>
        String(url).startsWith(LOCAL_ORIGIN) ? statusResponse(429, "insufficient balance") : statusResponse(503, "cdn down"),
    });

    const result = await client.classify({
      point: "authorize",
      tag: "guard",
      mode: "shadow",
      tool: "bash",
      state: { tool: "bash", args_preview: "{}" },
      questions: { alive: { type: "noul", instructions: "?" } },
    });

    assert.equal(result?.degraded, "http-429", `降级原因应仍是主模型的 429，实际 ${String(result?.degraded)}`);
    assert.equal(client.backupUses, 0, "兜底没成功，计数不该加");
    // 「试过兜底」这件事必须能在审计里看到，否则一次失败会看起来像
    // 「兜底根本没被考虑过」——这正是排查时最容易走错的一步。
    const telemetry = readFileSync(join(dir, "telemetry.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const failing = telemetry.filter((row) => row.action === "degraded");
    assert.ok(failing.length > 0, "应有降级遥测");
    assert.equal(
      failing.at(-1)?.extra?.backupAttempted,
      "http-503",
      "遥测应记下兜底也失败了、以及它自己的失败原因",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("兜底结果不进缓存：主模型恢复后下一次仍会打主模型", async () => {
  // 缓存键按**主模型**的 endpoint/model 算。若把兜底答案塞进去，后续同题会
  // 直接命中——既不再打主模型（无从得知它是否恢复），归因还会错记成主模型。
  const dir = await mkdtemp(join(tmpdir(), "dsh-backup-cache-"));
  try {
    const cfg = {
      provider: "custom",
      customBaseUrl: `${LOCAL_ORIGIN}/v1`,
      customEndpointStyle: "decisions",
      customApiKey: "sk-local-test-key-0123456789",
      customModel: "local-model",
      cacheSize: 64,
      cacheTtlMs: 600000,
      timeoutMs: 5000,
      thinkMode: "never",
      mode: "shadow",
      failureThreshold: 99,
      retryAttempts: 1,
      serverProvider: false,
      backupModel: true,
    };
    let primaryHealthy = false;
    const urls = [];
    const client = new StartluxClient({
      getConfig: () => cfg,
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      getBackupOverride: () => ({
        baseUrl: `${FREE_ORIGIN}/v1`,
        model: "Kev-4B",
        endpointStyle: "systemone",
        key: BACKUP_KEY,
      }),
      fetchFn: async (url) => {
        urls.push(String(url));
        if (!String(url).startsWith(LOCAL_ORIGIN)) return okResponse();
        return primaryHealthy ? okResponse({ risk: { type: "noul", noul: 0.2 } }) : statusResponse(429);
      },
    });
    const call = () => ({
      point: "authorize",
      tag: "guard",
      mode: "shadow",
      tool: "bash",
      state: { tool: "bash", args_preview: "{}" },
      questions: { alive: { type: "noul", instructions: "?" } },
    });

    await client.classify(call());
    assert.equal(urls.filter((u) => u.startsWith(LOCAL_ORIGIN)).length, 1, "第一次应打主模型");

    // 主模型恢复；同一份题再问一次：若兜底答案进了缓存，这里会 0 次请求。
    primaryHealthy = true;
    urls.length = 0;
    await client.classify(call());
    assert.equal(
      urls.filter((u) => u.startsWith(LOCAL_ORIGIN)).length,
      1,
      "主模型恢复后应重新打主模型（兜底结果不该进缓存）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- 3. 不可用时不白发

test("开着但下发值尚未取到：主模型 500 原样降级，不新增请求", async () => {
  const env = setup({
    seedConfig: LOCAL_CONFIG,
    // 下发端点一直失败 → 没有可用配置。
    responder: () => statusResponse(503, "cdn down"),
    decide: () => statusResponse(500, "server error"),
  });
  try {
    const status = await getStatus(env.routes);
    assert.equal(status.data.backupModel?.enabled, true, "开关本身是开着的");
    assert.equal(status.data.backupModel?.ready, false, "但配置不可用");
    assert.equal(status.data.backupModel?.blocked, "no-config", "原因应说清是没配置");

    env.decisionCalls.length = 0;
    const result = await postTest(env.routes);
    assert.equal(result.data.ok, false);
    assert.equal(env.decisionCalls.length, 1, "兜底不可用时不该有第二条请求");
    assert.match(String(result.data.text), /HTTP 500/, "失败原因仍是主模型的 500");
  } finally {
    env.restore();
  }
});

test("主模型超时不触发兜底（超时已有冷启动重试，不该再抬最坏等待）", async () => {
  const env = setup({
    seedConfig: LOCAL_CONFIG,
    decide: (target) => {
      if (target.startsWith(LOCAL_ORIGIN)) {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }
      return okResponse();
    },
  });
  try {
    await postRefresh(env.routes);
    env.decisionCalls.length = 0;
    const result = await postTest(env.routes);
    assert.equal(result.data.ok, false, "超时仍应失败");
    const hits = env.decisionCalls.filter((call) => call.url.startsWith(FREE_ORIGIN));
    assert.equal(hits.length, 0, "超时不该触发兜底（它不在触发集合里）");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------- 4. 互斥

test("「使用免费模型」已开时兜底无意义：状态报 primary-is-free", async () => {
  // 那时免费模型就是主模型，失败后拿同一份配置重问一遍只会多打一次请求。
  const env = setup({ seedConfig: "enabled: true\nserverProvider: true\nbackupModel: true\n" });
  try {
    const { data } = await getStatus(env.routes);
    assert.equal(data.backupModel?.enabled, true);
    assert.equal(data.backupModel?.ready, false);
    assert.equal(data.backupModel?.blocked, "primary-is-free");
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------- 5. key 不落盘

test("兜底不会让下发的明文 key 落盘（沿用既有 canary 承诺）", async () => {
  const env = setup({
    seedConfig: LOCAL_CONFIG,
    decide: (target) =>
      target.startsWith(LOCAL_ORIGIN) ? statusResponse(429) : okResponse(),
  });
  try {
    await postRefresh(env.routes);
    await postTest(env.routes);
    // 给它一点时间把异步写盘（统计/遥测/明细）落完。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const files = readAllFiles(env.dataDir);
    const offenders = files.filter((file) => file.text.includes(BACKUP_KEY));
    assert.deepEqual(
      offenders.map((file) => file.path),
      [],
      "下发的 key 绝不能出现在任何落盘文件里",
    );
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------- 6. 配置接线

test("backupModel 走 PUT /config 白名单，且只接受布尔值", async () => {
  // 不在白名单里的后果是「面板能拨、显示已保存、值从来没落盘」——
  // 这类静默失效在本插件里有明确先例（DEC-019 / DEC-030）。
  const ok = setup({ seedConfig: "enabled: true\n" });
  try {
    const res = await putConfig(ok.routes, { backupModel: true });
    assert.equal(res.status, 200, `布尔值应被接受：${JSON.stringify(res.data)}`);
    assert.equal(res.data.backupModel?.enabled, true, "落盘后回显应为开");
  } finally {
    ok.restore();
  }

  const bad = setup({ seedConfig: "enabled: true\n" });
  try {
    const res = await putConfig(bad.routes, { backupModel: "true" });
    assert.equal(res.status, 400, "字符串 'true' 应被拒（否则界面开、实际不走兜底）");
    assert.ok(String(res.data.error).includes("布尔"), `错误文案应说明原因：${res.data.error}`);
  } finally {
    bad.restore();
  }
});

// ---------------------------------------------------------- 7. 记录层

test("统计与决策明细都带 backup 标记（且不影响既有字段）", async () => {
  // 只写进遥测是不够的：「决策历史」页与统计页各有自己的数据源，
  // 两处都必须能分出「这次是兜底答的」，否则用户会把它算到主模型头上。
  const dir = await mkdtemp(join(tmpdir(), "dsh-backup-record-"));
  try {
    const cfg = {
      provider: "custom",
      customBaseUrl: `${LOCAL_ORIGIN}/v1`,
      customEndpointStyle: "decisions",
      customApiKey: "sk-local-test-key-0123456789",
      customModel: "local-model",
      cacheSize: 0,
      cacheTtlMs: 0,
      timeoutMs: 5000,
      thinkMode: "never",
      mode: "shadow",
      failureThreshold: 99,
      retryAttempts: 1,
      serverProvider: false,
      backupModel: true,
    };
    const { StatsStore } = await import("../lib/stats-store.js");
    const statsStore = new StatsStore({ dir });
    const client = new StartluxClient({
      getConfig: () => cfg,
      logger: { warn() {}, info() {} },
      telemetryDir: dir,
      statsStore,
      getBackupOverride: () => ({
        baseUrl: `${FREE_ORIGIN}/v1`,
        model: "Kev-4B",
        endpointStyle: "systemone",
        key: BACKUP_KEY,
      }),
      fetchFn: async (url) =>
        String(url).startsWith(LOCAL_ORIGIN) ? statusResponse(429) : okResponse(),
    });

    const result = await client.classify({
      point: "authorize",
      tag: "guard",
      mode: "shadow",
      tool: "bash",
      state: { tool: "bash", args_preview: "{}" },
      questions: { alive: { type: "noul", instructions: "?" } },
    });
    assert.equal(result?.backup, true);

    // 统计：把消耗事实交给写盘端（与引擎里的调用方式一致）。
    client.recordDecision({ facts: result.statsFacts, action: "allow", detail: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = await statsStore.read();
    const row = rows.at(-1);
    assert.equal(row?.backup, true, "统计行应带 backup：true");
    assert.equal(row?.provider, "server", "统计行 provider 应是 server");

    // 决策明细：构造入口要能带上这个标记。
    const { buildDecisionRecord } = await import("../lib/decision-store.js");
    const record = buildDecisionRecord({ provider: "server", action: "allow", backup: true, ts: new Date().toISOString() });
    assert.equal(record.backup, true, "明细记录应带 backup：true");
    const plain = buildDecisionRecord({ provider: "server", action: "allow", ts: new Date().toISOString() });
    assert.equal(
      Object.hasOwn(plain, "backup"),
      false,
      "非兜底记录不该带一个值为 false 的多余字段（有则带、无则省）",
    );
  } finally {
    // 明细/统计是异步落盘的旁路：删临时目录时它们可能还在写（ENOTEMPTY）。
    // 与 DEC-071 记录的偶发竞态同一类，这里重试几次即可，不当成失败。
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});
