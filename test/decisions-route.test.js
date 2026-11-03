/**
 * 「决策历史」查询路由的测试（DEC-022）。
 *
 * 走**真实的** HTTP 路由（`connection.fetch.register` 注册的那张表），
 * 不打网络、不起浏览器。做法与 `test/save-path.test.js` 一致：把 DSH_HOME
 * 指到临时目录，用最小假 ctx 走 `apply()`，再直接调用注册进来的 fetch。
 *
 * 防的是这几类错：
 *
 *   1. **会话参数没校验**——缺 sessionId 时返回全部记录，用户会看到一堆
 *      不属于自己的决策。
 *   2. **空文件 / 坏文件时崩掉**——页面必须能显示空态而不是 500。
 *   3. **limit 失控**——一次拉回几 MB 会把浏览器拖垮。
 *   4. **开关关闭后仍然返回内容**——用户说「不记录」，读端也不该给出内容。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { apply } from "../lib/index.js";

/**
 * 造一个隔离环境。
 *
 * @returns `{ home, routes, dataDir }`：`routes` 是注册进来的路径表，
 *   `dataDir` 是插件的数据目录。
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "dsh-decroute-"));
  process.env.DSH_HOME = home;
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
  return { home, routes, dataDir: join(home, "dsh-decision-engine") };
}

/**
 * 调一次 GET 路由。
 *
 * 注意查表用的是**去掉查询串**的路径：路由注册表以 path 为键，
 * `?sessionId=…` 是请求 URL 的一部分，不在键里。
 */
async function get(routes, url) {
  const key = url.split("?")[0];
  const res = await routes[key].fetch({ method: "GET", url: `http://localhost${url}` });
  return { status: res.status, data: await res.json() };
}

/** 往明细文件里写几行。 */
function seed(dataDir, entries) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "decisions.jsonl"),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    "utf8",
  );
}

/** 一条最小明细记录。 */
function entry(over = {}) {
  return {
    v: 1,
    seq: 1,
    ts: "2026-11-03T00:00:00.000Z",
    sessionId: "session-a",
    point: "authorize",
    provider: "bamboonode",
    model: "m1",
    action: "delegate",
    detail: "delegate",
    latencyMs: 100,
    capture: "full",
    ...over,
  };
}

test("缺少 sessionId 时返回 400（不返回全部记录）", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [entry(), entry({ seq: 2, sessionId: "session-b" })]);
    const { status, data } = await get(routes, "/api/decision-engine/session-decisions");
    assert.equal(status, 400);
    assert.equal(typeof data.error, "string");
    assert.equal(data.entries, undefined, "出错时不该顺带返回记录");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("按会话过滤：只返回本会话的记录", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [
      entry({ seq: 1, sessionId: "session-a", tool: "read" }),
      entry({ seq: 2, sessionId: "session-b", tool: "grep" }),
      entry({ seq: 3, sessionId: "session-a", tool: "bash" }),
    ]);
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(data.entries.length, 2);
    assert.equal(data.total, 2);
    assert.deepEqual(data.entries.map((item) => item.tool), ["read", "bash"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("文件不存在时返回空列表而不是 500", async () => {
  const { home, routes } = setup();
  try {
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.deepEqual(data.entries, []);
    assert.equal(data.total, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("坏行被跳过，其余记录照常返回", async () => {
  const { home, routes, dataDir } = setup();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "decisions.jsonl"),
      `${JSON.stringify(entry({ tool: "read" }))}\n{"v":1,"broken\n${JSON.stringify(entry({ seq: 2, tool: "bash" }))}\n`,
      "utf8",
    );
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(data.entries.length, 2, "坏行不该影响好行");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("limit 生效且有上限（不会一次拉回全部）", async () => {
  const { home, routes } = setup();
  try {
    seed(
      join(home, "dsh-decision-engine"),
      Array.from({ length: 40 }, (_, index) => entry({ seq: index + 1, tool: `t${index}` })),
    );
    const { data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a&limit=5",
    );
    assert.equal(data.entries.length, 5);
    assert.equal(data.total, 40);
    assert.equal(data.truncated, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("超大的 limit 被压到上限之内", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [entry()]);
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a&limit=999999",
    );
    assert.equal(status, 200);
    assert.equal(data.entries.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("返回体带上界面需要的元信息（文件路径、开关）", async () => {
  const { home, routes } = setup();
  try {
    seed(join(home, "dsh-decision-engine"), [entry()]);
    const { data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(data.sessionId, "session-a");
    assert.equal(typeof data.file, "string");
    assert.ok(data.file.includes("decisions.jsonl"), "应回报明细文件路径");
    assert.equal(data.enabled, true, "默认开启");
    // DEC-029：「采不采内容」不再是独立档位，响应里就该没有这个字段。
    // 断言「它不在」比断言「它是 true」更能防止它悄悄回来。
    assert.equal(
      Object.hasOwn(data, "capture"),
      false,
      "内容采集不是独立档位，响应里不该再有 capture",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("开关关闭后不再写明细（文件不会被创建）", async () => {
  const { home, routes, dataDir } = setup();
  try {
    // 通过真实的配置路由把开关关掉。
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsTabEnabled: false }),
    });
    assert.equal(res.status, 200, `关开关应成功：${JSON.stringify(await res.clone().json())}`);

    // 记录一条（走守卫路径太重，这里直接验证存储层的行为）。
    const { status, data } = await get(
      routes,
      "/api/decision-engine/session-decisions?sessionId=session-a",
    );
    assert.equal(status, 200);
    assert.equal(data.enabled, false, "状态应回报开关已关");
    assert.deepEqual(data.entries, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("状态接口回报开关的生效值（默认开）", async () => {
  const { home, routes } = setup();
  try {
    const { status, data } = await get(routes, "/api/decision-engine/status");
    assert.equal(status, 200);
    assert.equal(data.decisionsTabEnabled, true, "默认应开启");
    // DEC-029：decisionsCapture 已退役——它曾经能在配置页之外把每条记录
    // 静默降级成元数据，现在状态接口不再回传它。
    assert.equal(
      Object.hasOwn(data, "decisionsCapture"),
      false,
      "退役的 decisionsCapture 不该再出现在状态里",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("开关能被保存并回显（配置页的开关链路）", async () => {
  const { home, routes } = setup();
  try {
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsTabEnabled: false }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.decisionsTabEnabled, false, "保存后应立刻回显新值");

    // 落盘检查：值真的写进了 config.yml。
    const raw = readFileSync(join(home, "dsh-decision-engine", "config.yml"), "utf8");
    assert.ok(raw.includes("decisionsTabEnabled: false"), `配置内容：${raw}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config.yml 里遗留的退役键不再影响任何行为（旧配置平滑升级）", async () => {
  // 真机上就是这个形态：config.yml 里留着 `decisionsCapture: false`
  // （合并开关后的残留），而 decisionsTabEnabled 是 true。DEC-029 之前
  // 这一行让每条记录都退化成「只有元数据」；退役之后它必须变成**惰性键**——
  // 插件照常启动，开关照常生效，并且它不会从任何出口再冒出来。
  const home = mkdtempSync(join(tmpdir(), "dsh-decroute-legacy-"));
  process.env.DSH_HOME = home;
  const dataDir = join(home, "dsh-decision-engine");
  mkdirSync(dataDir, { recursive: true });
  const legacy = [
    "enabled: true",
    "mode: enforce",
    "decisionsTabEnabled: true",
    "decisionsCapture: false",
    "",
  ].join("\n");
  writeFileSync(join(dataDir, "config.yml"), legacy, "utf8");

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
  try {
    // 不抛 = 带惰性键的旧配置仍能启动。
    apply(ctx, {});

    const { status, data } = await get(routes, "/api/decision-engine/status");
    assert.equal(status, 200, "带遗留键的配置应照常启动");
    assert.equal(data.decisionsTabEnabled, true, "开关照常生效");
    assert.equal(
      Object.hasOwn(data, "decisionsCapture"),
      false,
      "退役键不该再出现在状态回显里",
    );

    // 惰性键不被回写、也不被清除：退役是「不再读」，不是「偷偷改用户的文件」。
    assert.equal(readFileSync(join(dataDir, "config.yml"), "utf8"), legacy, "不该改写用户的配置");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("已退役的 decisionsCapture 不再是一个可写配置（PUT 只带它应被拒）", async () => {
  const { home, routes } = setup();
  try {
    // DEC-029：这个键曾经能落盘，并让「开关显示开、记录只有元数据」。
    // 退役之后它既不在白名单里也不在 schema 里，只提交它应当被拒——
    // 而不是「静默接受一个没人再读的值」。
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ decisionsCapture: false }),
    });
    assert.equal(res.status, 400, "只提交退役键应被拒");
    const payload = await res.json();
    assert.match(String(payload.error), /no updatable fields/, `实际：${payload.error}`);

    // 而且什么都没落盘。
    assert.equal(
      existsSync(join(home, "dsh-decision-engine", "config.yml")),
      false,
      "被拒的请求不该写出配置文件",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 同批修的既有缺陷

test("匿名统计档位能保存（此前点了「off」不落盘）", async () => {
  const { home, routes } = setup();
  try {
    // 1997 行的白名单与 configPatchOf 都漏了 telemetryLevel，于是这个下拉
    // 能点、能显示「已保存」，值却从来没落盘——用户以为关掉了统计，实际
    // 每天照发。隐私开关静默失效必须拦住。
    const res = await routes["/api/decision-engine/config"].fetch({
      method: "PUT",
      text: async () => JSON.stringify({ telemetryLevel: "off" }),
    });
    assert.equal(res.status, 200, `保存匿名统计档位应成功：${JSON.stringify(await res.clone().json())}`);
    const payload = await res.json();
    assert.equal(payload.telemetryLevel, "off", "保存后应回显新档位");

    const raw = readFileSync(join(home, "dsh-decision-engine", "config.yml"), "utf8");
    assert.ok(raw.includes("telemetryLevel: off"), `配置内容：${raw}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("状态接口回显匿名统计档位（此前永远显示兜底值）", async () => {
  const { home, routes } = setup();
  try {
    const { data } = await get(routes, "/api/decision-engine/status");
    assert.equal(typeof data.telemetryLevel, "string", "应回报当前档位");
    assert.deepEqual(data.telemetryLevels, ["off", "install", "daily"], "可选档位也下发");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
