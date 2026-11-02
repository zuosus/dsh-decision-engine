/**
 * 匿名统计（lib/telemetry.js）的单元测试。
 *
 * 为什么这一层必须有测试：这个模块的失败模式**都不会报错**——
 *
 *   - 「关掉」却仍然联网：用户看不到任何提示，隐私承诺静默失效；
 *   - 同一天重复上报：DAU 被自己刷高，数字变得不可信；
 *   - 上报体里悄悄多带一个字段：没人会发现，直到它变成事故。
 *
 * 三者都只能靠断言把住。因此这里**不发任何真实请求**：`fetchImpl` 与
 * `clock` 全部注入，临时目录用 `mkdtemp`，测完删掉。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ENDPOINT,
  STATE_FILE,
  TelemetryReporter,
  buildPayload,
  decideKind,
  isValidInstallId,
  newInstallId,
  normalizeVersion,
  parseState,
  resolveEndpoint,
  resolveLevel,
  serializeState,
  shanghaiDay,
} from "../lib/telemetry.js";

/** 建一个临时目录，测完自动清理。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-telemetry-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 一个永远不该被调用的 fetch 桩：被调用就证明「关掉时仍然联网」。 */
function forbiddenFetch() {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  return { impl, calls: () => calls };
}

/** 记录调用的 fetch 桩，返回固定状态码。`calls()` 用函数取值，与上面的桩保持同一形状。 */
function stubFetch(status = 202) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok: status >= 200 && status < 300, status };
  };
  return { impl, calls: () => calls };
}

test("shanghaiDay 按 UTC+8 计日，跨 UTC 零点仍算同一当地日", () => {
  // 2026-11-02T16:30:00Z = 上海 2026-11-03 00:30 → 当地日应是 11-03。
  assert.equal(shanghaiDay(Date.parse("2026-11-02T16:30:00Z")), "2026-11-03");
  // 2026-11-02T15:59:00Z = 上海 2026-11-02 23:59 → 仍是 11-02。
  assert.equal(shanghaiDay(Date.parse("2026-11-02T15:59:00Z")), "2026-11-02");
  assert.equal(shanghaiDay(NaN), "");
});

test("安装 id 只接受 UUIDv4", () => {
  assert.equal(isValidInstallId(newInstallId()), true);
  assert.equal(isValidInstallId("not-a-uuid"), false);
  assert.equal(isValidInstallId(""), false);
  assert.equal(isValidInstallId(null), false);
  // v1 UUID 形态必须被拒：那不是本模块生成的。
  assert.equal(isValidInstallId("f79dcf33-abcd-1803-98bd-38f0800b8ced"), false);
});

test("状态往返：字段齐全且顺序稳定", () => {
  const state = parseState(serializeState({
    installId: newInstallId(),
    firstRunAt: 1730505600000,
    firstVersion: "1.0.0",
    lastSentDay: "2026-11-02",
    lastAttemptDay: "2026-11-02",
    lastOkDay: "2026-11-02",
    failures: 0,
    degraded: false,
  }));
  assert.equal(state.firstRunAt, 1730505600000);
  assert.equal(state.firstVersion, "1.0.0");
  assert.equal(state.lastSentDay, "2026-11-02");
  assert.equal(state.failures, 0);
  assert.equal(state.degraded, false);
  // 顺序稳定便于人直接读文件。
  assert.match(serializeState(state), /"installId"[\s\S]*"degraded"/);
});

test("状态损坏时退化成全新安装，而不是永远不报", () => {
  for (const bad of ["", "{", "[]", "null", '{"installId":"nope"}', '{"failures":"x"}']) {
    const state = parseState(bad);
    assert.equal(state.installId, null, `输入 ${bad}`);
    assert.equal(state.firstRunAt, null, `输入 ${bad}`);
    assert.equal(state.failures, 0, `输入 ${bad}`);
    assert.equal(state.degraded, false, `输入 ${bad}`);
  }
});

test("decideKind 真值表", () => {
  const fresh = parseState("");
  const installed = parseState(serializeState({
    installId: newInstallId(),
    firstRunAt: 1730505600000,
    firstVersion: "1.0.0",
  }));

  // 全新安装：install 档和 daily 档都报 install。
  assert.equal(decideKind(fresh, { today: "2026-11-02", level: "install" }), "install");
  assert.equal(decideKind(fresh, { today: "2026-11-02", level: "daily" }), "install");
  // off 永不发。
  assert.equal(decideKind(fresh, { today: "2026-11-02", level: "off" }), null);
  // 已安装：install 档不再发，daily 档发 heartbeat。
  assert.equal(decideKind(installed, { today: "2026-11-02", level: "install" }), null);
  assert.equal(decideKind(installed, { today: "2026-11-02", level: "daily" }), "heartbeat");
  // 同一天已尝试过：不再发（这是「每天最多一次」的执行点）。
  const attempted = { ...installed, lastAttemptDay: "2026-11-02" };
  assert.equal(decideKind(attempted, { today: "2026-11-02", level: "daily" }), null);
  // 次日恢复。
  assert.equal(decideKind(attempted, { today: "2026-11-03", level: "daily" }), "heartbeat");
  // 已降级：永不发。
  assert.equal(decideKind({ ...installed, degraded: true }, { today: "2026-11-02", level: "daily" }), null);
  // 日期缺失：不发（无法去重就不要发）。
  assert.equal(decideKind(installed, { today: "", level: "daily" }), null);
});

test("buildPayload 只包含允许的字段，且没有自由文本位", () => {
  const payload = buildPayload({
    installId: "8dec1da9-8712-4b12-8323-2957c13bf391",
    kind: "heartbeat",
    version: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    hostVersion: "",
    decisions: 42,
  });
  const keys = Object.keys(payload).sort();
  assert.deepEqual(keys, ["arch", "d", "id", "k", "os", "v", "ver"]);
  assert.equal(payload.v, 1);
  assert.equal(payload.d, 42);
  // host 为空串时整字段省略（不猜、不伪造）。
  assert.equal(payload.host, undefined);

  // 禁令：这些字段永远不许出现（任何一个出现都是隐私事故）。
  const forbidden = ["prompt", "key", "token", "path", "cwd", "url", "user", "ip", "session", "email", "host"];
  for (const name of forbidden) {
    assert.equal(payload[name], undefined, `payload 不应含 ${name}`);
  }

  // 自由文本无处可塞：版本/平台/架构都被白名单化。
  const dirty = buildPayload({
    installId: newInstallId(),
    kind: "install",
    version: "1.0.0; rm -rf / # 中文",
    platform: "dar win",
    arch: "arm 64",
  });
  assert.equal(dirty.ver, "1.0.0rm-rf");
  assert.equal(dirty.os, "darwin");
  assert.equal(dirty.arch, "arm64");
});

test("buildPayload 的 decisions 边界", () => {
  const base = { installId: newInstallId(), kind: "heartbeat", version: "1.0.0" };
  assert.equal(buildPayload({ ...base, decisions: 0 }).d, undefined);
  assert.equal(buildPayload({ ...base, decisions: -5 }).d, undefined);
  assert.equal(buildPayload({ ...base, decisions: NaN }).d, undefined);
  assert.equal(buildPayload({ ...base, decisions: 1e9 }).d, 100000);
  assert.equal(buildPayload({ ...base, decisions: 3.9 }).d, 3);
});

test("normalizeVersion / resolveEndpoint / resolveLevel 的兜底", () => {
  assert.equal(normalizeVersion("  1.2.3-rc.1  "), "1.2.3-rc.1");
  assert.equal(normalizeVersion("1.0 <script>"), "1.0script");
  assert.equal(normalizeVersion(""), "");

  // 端点：留空 / 非法 / 非 http 一律回落默认，绝不把请求发到奇怪的地方。
  assert.equal(resolveEndpoint(""), DEFAULT_ENDPOINT);
  assert.equal(resolveEndpoint("   "), DEFAULT_ENDPOINT);
  assert.equal(resolveEndpoint("ftp://example.com/x"), DEFAULT_ENDPOINT);
  assert.equal(resolveEndpoint("not a url"), DEFAULT_ENDPOINT);
  assert.equal(resolveEndpoint("https://example.com/api"), "https://example.com/api");

  // 档位：未知值回落 install（默认档），不是 daily。
  assert.equal(resolveLevel("daily"), "daily");
  assert.equal(resolveLevel("off"), "off");
  assert.equal(resolveLevel("install"), "install");
  assert.equal(resolveLevel("nonsense"), "install");
  assert.equal(resolveLevel(undefined), "install");
});

test("档位 off 时绝不联网、绝不读文件", async () => {
  await withTempDir(async (dir) => {
    const { impl, calls } = forbiddenFetch();
    const reporter = new TelemetryReporter({ dir, level: "off", fetchImpl: impl });

    // 让 statePath 指向一个真实存在的文件：如果它被读了，说明 off 没挡住。
    await writeFile(join(dir, STATE_FILE), serializeState({ installId: newInstallId(), firstRunAt: 1 }), "utf8");

    const result = await reporter.start({ version: "1.0.0", decisions: 5 });
    assert.deepEqual(result, { sent: false, kind: null, reason: "off" });
    assert.equal(calls(), 0, "off 档不允许调用 fetch");

    // prepare 同样直接返回 null，且不落盘。
    assert.equal(await reporter.prepare({ version: "1.0.0" }), null);
  });
});

test("首次运行发 install，同一天再启动不再发", async () => {
  await withTempDir(async (dir) => {
    const { impl, calls } = stubFetch();
    const clock = () => Date.parse("2026-11-02T02:00:00Z");
    const reporter = new TelemetryReporter({ dir, level: "daily", fetchImpl: impl, clock });

    const first = await reporter.start({ version: "1.0.0", platform: "darwin", arch: "arm64", decisions: 7 });
    assert.equal(first.sent, true);
    assert.equal(first.kind, "install");
    assert.equal(calls().length, 1);
    assert.equal(new URL(calls()[0].url).href, DEFAULT_ENDPOINT);
    const body = JSON.parse(calls()[0].options.body);
    assert.equal(body.k, "install");
    assert.equal(body.ver, "1.0.0");
    assert.equal(isValidInstallId(body.id), true);

    // 同一天第二次启动：不发。
    const second = await reporter.start({ version: "1.0.0" });
    assert.equal(second.sent, false);
    assert.equal(second.reason, "not-due");
    assert.equal(calls().length, 1, "同一天不允许第二次请求");

    // 次日：发 heartbeat。
    const nextDay = new TelemetryReporter({
      dir, level: "daily", fetchImpl: impl, clock: () => Date.parse("2026-11-03T02:00:00Z"),
    });
    const third = await nextDay.start({ version: "1.0.0", decisions: 12 });
    assert.equal(third.sent, true);
    assert.equal(third.kind, "heartbeat");
    assert.equal(calls().length, 2);
    assert.equal(JSON.parse(calls()[1].options.body).d, 12);
  });
});

test("安装 id 跨升级稳定；删掉状态文件后换新 id", async () => {
  await withTempDir(async (dir) => {
    const { impl, calls } = stubFetch();
    const reporter = new TelemetryReporter({
      dir, level: "daily", fetchImpl: impl, clock: () => Date.parse("2026-11-02T02:00:00Z"),
    });
    await reporter.start({ version: "0.9.1" });
    const id1 = JSON.parse(calls()[0].options.body).id;
    const state = JSON.parse(await readFile(join(dir, STATE_FILE), "utf8"));
    assert.equal(state.installId, id1);
    assert.equal(state.firstVersion, "0.9.1");

    // 升级后（版本变了，id 与首个版本都不变）。
    const upgraded = new TelemetryReporter({
      dir, level: "daily", fetchImpl: impl, clock: () => Date.parse("2026-11-03T02:00:00Z"),
    });
    await upgraded.start({ version: "1.0.0" });
    const id2 = JSON.parse(calls()[1].options.body).id;
    assert.equal(id2, id1, "升级不得更换安装 id");
    const after = JSON.parse(await readFile(join(dir, STATE_FILE), "utf8"));
    assert.equal(after.firstVersion, "0.9.1", "首个版本号应保持首次记录");

    // 用户删掉状态文件 = 换一个新身份（隐私承诺：可随时重置）。
    await rm(join(dir, STATE_FILE));
    const fresh = new TelemetryReporter({
      dir, level: "daily", fetchImpl: impl, clock: () => Date.parse("2026-11-04T02:00:00Z"),
    });
    const again = await fresh.start({ version: "1.0.0" });
    assert.equal(again.kind, "install", "换身份后应重新按 install 上报");
    assert.notEqual(JSON.parse(calls()[2].options.body).id, id1);
  });
});

test("install 档只报首次，之后永不再报", async () => {
  await withTempDir(async (dir) => {
    const { impl, calls } = stubFetch();
    const make = (ms) => new TelemetryReporter({ dir, level: "install", fetchImpl: impl, clock: () => ms });
    assert.equal((await make(Date.parse("2026-11-02T02:00:00Z")).start({ version: "1.0.0" })).kind, "install");
    assert.equal(calls().length, 1);
    for (const day of ["2026-11-03", "2026-11-10", "2026-12-01"]) {
      const r = await make(Date.parse(`${day}T02:00:00Z`)).start({ version: "1.0.0" });
      assert.equal(r.sent, false, `${day} 不应再发`);
    }
    assert.equal(calls().length, 1, "install 档总共只允许一次请求");
  });
});

test("发送失败不抛错，且当天不再重试", async () => {
  await withTempDir(async (dir) => {
    const failing = async () => {
      throw new Error("offline");
    };
    const reporter = new TelemetryReporter({
      dir, level: "daily", fetchImpl: failing, clock: () => Date.parse("2026-11-02T02:00:00Z"),
    });
    const result = await reporter.start({ version: "1.0.0" });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "http-failed");

    // 状态里记了「今天试过」：同一天不会再打第二次（失败也算试过）。
    const state = JSON.parse(await readFile(join(dir, STATE_FILE), "utf8"));
    assert.equal(state.lastAttemptDay, "2026-11-02");
    assert.equal(state.failures, 1);
    assert.equal(state.lastSentDay, "");

    const again = await reporter.start({ version: "1.0.0" });
    assert.equal(again.reason, "not-due");
  });
});

test("连续失败到阈值后彻底降级，不再尝试", async () => {
  await withTempDir(async (dir) => {
    // 直接把状态写成「已失败 29 次」，下一次失败即触发降级。
    await writeFile(join(dir, STATE_FILE), serializeState({
      installId: newInstallId(),
      firstRunAt: Date.parse("2026-01-01T00:00:00Z"),
      lastAttemptDay: "2026-11-01",
      failures: 29,
    }), "utf8");

    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("offline");
    };
    const reporter = new TelemetryReporter({
      dir, level: "daily", fetchImpl: failing, clock: () => Date.parse("2026-11-02T02:00:00Z"),
    });
    await reporter.start({ version: "1.0.0" });
    assert.equal(calls, 1);
    const state = JSON.parse(await readFile(join(dir, STATE_FILE), "utf8"));
    assert.equal(state.failures, 30);
    assert.equal(state.degraded, true, "第 30 次失败应触发降级");

    // 降级之后，次日也不再尝试。
    const next = new TelemetryReporter({
      dir, level: "daily", fetchImpl: failing, clock: () => Date.parse("2026-11-03T02:00:00Z"),
    });
    const r = await next.start({ version: "1.0.0" });
    assert.equal(r.sent, false);
    assert.equal(calls, 1, "降级后不允许再发请求");
  });
});

test("自定义端点生效；状态文件是合法 JSON 且权限收敛", async () => {
  await withTempDir(async (dir) => {
    const { impl, calls } = stubFetch();
    const reporter = new TelemetryReporter({
      dir,
      level: "daily",
      endpoint: "https://example.com/collect",
      fetchImpl: impl,
      clock: () => Date.parse("2026-11-02T02:00:00Z"),
    });
    await reporter.start({ version: "1.0.0" });
    assert.equal(calls()[0].url, "https://example.com/collect");

    const text = await readFile(join(dir, STATE_FILE), "utf8");
    assert.doesNotThrow(() => JSON.parse(text), "状态文件必须是合法 JSON");
    const { stat } = await import("node:fs/promises");
    const info = await stat(join(dir, STATE_FILE));
    assert.equal(info.mode & 0o077, 0, "状态文件不应给组/其他人读权限");
  });
});

test("状态文件损坏后重新上报，而不是静默死掉", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, STATE_FILE), "{ this is not json", "utf8");
    const { impl, calls } = stubFetch();
    const reporter = new TelemetryReporter({
      dir, level: "daily", fetchImpl: impl, clock: () => Date.parse("2026-11-02T02:00:00Z"),
    });
    const result = await reporter.start({ version: "1.0.0" });
    assert.equal(result.sent, true);
    assert.equal(result.kind, "install");
    assert.equal(calls().length, 1);
    // 损坏文件已被修好。
    const repaired = await readFile(join(dir, STATE_FILE), "utf8");
    assert.doesNotThrow(() => JSON.parse(repaired));
  });
});
