/**
 * 决策明细存储的测试（DEC-022）。
 *
 * 防的是这几类错：
 *
 *   1. **会话归属丢了**——那样「本会话的决策历史」会变成「全机所有会话的
 *      决策」，用户看到一堆不属于自己的记录。
 *   2. **内容没脱敏**——明细里有会话正文与命令片段，一次 `bash` 里贴过的
 *      key 不该躺在磁盘上。
 *   3. **内容没截断**——一条记录能长到几百 KB，文件很快撑爆。
 *   4. **文件无界增长**——必须有体积上限与轮转。
 *   5. **坏行让整页崩掉**——崩溃时写下的半行必须被跳过。
 *   6. **开关关掉后仍然在写**——用户说「不记录」，就必须真的不落盘。
 *
 * 全部走真实的临时目录，不打网络。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DecisionStore,
  buildDecisionRecord,
  maskSecrets,
  readTailLines,
  recordIdOf,
  truncateContent,
  DECISIONS_FILE_NAME,
} from "../lib/decision-store.js";

/**
 * 直接往明细文件里写原始记录（模拟**本次修复之前**落盘的老数据）。
 *
 * 老记录没有 `id` 字段，且 `seq` 跨重启重复——这正是真机上的数据形态。
 */
function seedRaw(dir, entries) {
  writeFileSync(
    join(dir, DECISIONS_FILE_NAME),
    entries.map((item) => `${JSON.stringify(item)}\n`).join(""),
    "utf8",
  );
}

/** 造一个隔离的数据目录；返回目录与清理函数。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-decstore-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 一条最小记录。 */
function record(over = {}) {
  return buildDecisionRecord({
    sessionId: "session-1",
    point: "authorize",
    tag: "guard",
    mode: "enforce",
    provider: "bamboonode",
    model: "startlux-decision-27b-autothink",
    action: "delegate",
    detail: "delegate",
    latencyMs: 1200,
    inputTokens: 2713,
    tool: "bash",
    ...over,
  });
}

// ------------------------------------------------------------------ 记录体

test("记录体带上会话归属与全部关键字段", () => {
  const entry = buildDecisionRecord({
    sessionId: "session-42",
    point: "authorize",
    tag: "guard",
    mode: "observe",
    topMode: "shadow",
    provider: "bamboonode",
    model: "m1",
    action: "delegate",
    detail: "delegate",
    latencyMs: 1689,
    inputTokens: 2713,
    outputTokens: 12,
    tool: "bash",
    turn: 3,
    step: 7,
    scores: { risk_p: 0.9 },
  });
  assert.equal(entry.v, 1);
  assert.equal(entry.sessionId, "session-42");
  assert.equal(entry.point, "authorize");
  assert.equal(entry.mode, "observe");
  assert.equal(entry.topMode, "shadow");
  assert.equal(entry.provider, "bamboonode");
  assert.equal(entry.model, "m1");
  assert.equal(entry.action, "delegate");
  assert.equal(entry.latencyMs, 1689);
  assert.equal(entry.inputTokens, 2713);
  assert.equal(entry.outputTokens, 12);
  assert.equal(entry.tool, "bash");
  assert.equal(entry.turn, 3);
  assert.equal(entry.step, 7);
  assert.deepEqual(entry.scores, { risk_p: 0.9 });
});

test("没有会话 id 时留空串（不可归属），而不是编一个", () => {
  const entry = buildDecisionRecord({ point: "cotTranslate" });
  assert.equal(entry.sessionId, "", "不可归属必须留空，不能臆造");
  assert.equal(entry.point, "cotTranslate");
});

test("缺省的现场字段不硬造 null（不存在的字段就省掉）", () => {
  const entry = buildDecisionRecord({ point: "cotTranslate", sessionId: "s" });
  assert.equal("tool" in entry, false);
  assert.equal("turn" in entry, false);
  assert.equal("step" in entry, false);
  assert.equal("scores" in entry, false);
});

test("记录体可 JSON 化（内容里有循环引用时不抛）", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const entry = buildDecisionRecord({ sessionId: "s", content: { state: cyclic } });
  assert.doesNotThrow(() => JSON.stringify(entry));
});

// ------------------------------------------------------------------ 脱敏

test("脱敏拦掉常见的 key 形态", () => {
  assert.equal(maskSecrets("sk-ABCDEFGHIJKLMNOPQRST"), "sk-***");
  assert.equal(maskSecrets('{"apiKey": "supersecretvalue"}'), '{"apiKey": "***"}');
  assert.match(maskSecrets("Authorization: Bearer abcdefgh12345"), /Bearer \*\*\*/);
  assert.equal(maskSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), "ghp_***");
});

test("脱敏后仍是一行合法 JSON（模式表针对的是 JSON 文本）", () => {
  const line = JSON.stringify({ detail: "用 key sk-ABCDEFGHIJKLMNOPQRST 调用" });
  const masked = maskSecrets(line);
  assert.doesNotThrow(() => JSON.parse(masked));
  assert.equal(JSON.parse(masked).detail.includes("sk-ABCDEFGHIJKLMNOPQRST"), false);
});

test("没有 key 的文本原样通过", () => {
  const text = "just a normal command: ls -la /tmp";
  assert.equal(maskSecrets(text), text);
});

// ------------------------------------------------------------------ 截断

test("内容超限时先砍工具参数，再砍对话摘要", () => {
  const content = {
    state: { args_preview: "x".repeat(3000), recent: "y".repeat(3000) },
    questions: { q: { type: "noul" } },
    answers: { q: { type: "noul", noul: 0.5 } },
  };
  const result = truncateContent(content, 1000);
  assert.equal(result.capture, "full");
  assert.ok(JSON.stringify(result.content).length <= 1000, "裁剪后必须不超过上限");
  assert.ok(result.content.state.args_preview.length < 3000, "参数预览应被砍短");
  assert.deepEqual(result.content.questions, content.questions, "问题集必须保留");
});

test("内容实在太大时退回只留元数据（连问题与回答都装不下）", () => {
  // 只有当**问题与回答本身**就超过上限时才退到 meta —— 参数预览与对话
  // 摘要都是可以砍的，砍完还装不下才说明这次决策本身就有巨大内容。
  const content = {
    state: { args_preview: "x".repeat(100000) },
    questions: { q: { type: "noul", instructions: "y".repeat(100000) } },
    answers: { q: { type: "noul", noul: 0.5 } },
  };
  const result = truncateContent(content, 200);
  assert.equal(result.capture, "meta");
  assert.equal(result.content, null);
});

test("参数预览超长时砍短它，但保住问题与回答（capture 仍是 full）", () => {
  const content = {
    state: { args_preview: "x".repeat(100000) },
    questions: { q: { type: "noul" } },
    answers: { q: { type: "noul", noul: 0.5 } },
  };
  const result = truncateContent(content, 500);
  assert.equal(result.capture, "full");
  assert.ok(JSON.stringify(result.content).length <= 500, "裁剪后必须不超过上限");
  assert.ok(result.content.state.args_preview.length < 100000, "参数预览应被砍短");
  assert.deepEqual(result.content.questions, content.questions, "问题集必须保留");
  assert.deepEqual(result.content.answers, content.answers, "回答必须保留");
});

test("内容在上限内时原样保留", () => {
  const content = { state: { tool: "bash" }, questions: { q: 1 } };
  const result = truncateContent(content, 4000);
  assert.equal(result.capture, "full");
  assert.deepEqual(result.content, content);
});

// ------------------------------------------------------------------ 写入

test("写入后能按会话读回来，且按时间升序", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "s-a", tool: "read" }));
    store.record(record({ sessionId: "s-b", tool: "grep" }));
    store.record(record({ sessionId: "s-a", tool: "bash" }));
    await store.flush();

    const page = await store.readForSession("s-a");
    assert.equal(page.total, 2);
    assert.equal(page.entries.length, 2);
    assert.deepEqual(page.entries.map((entry) => entry.tool), ["read", "bash"]);
  } finally {
    cleanup();
  }
});

test("不存在的会话返回空页，不报错", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    const page = await store.readForSession("never-seen");
    assert.deepEqual(page.entries, []);
    assert.equal(page.total, 0);
  } finally {
    cleanup();
  }
});

test("空会话 id 直接返回空页（不可归属的记录不属于任何人）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "" }));
    await store.flush();
    const page = await store.readForSession("");
    assert.deepEqual(page.entries, []);
  } finally {
    cleanup();
  }
});

test("文件不存在时返回空页，不抛错", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    const page = await store.readForSession("s");
    assert.deepEqual(page.entries, []);
    assert.equal(page.total, 0);
  } finally {
    cleanup();
  }
});

test("坏行被跳过，其余记录照常读出", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "s", tool: "read" }));
    await store.flush();
    // 追加一个「写到一半被杀」的半行。
    appendFileSync(join(dir, DECISIONS_FILE_NAME), '{"v":1,"sessionId":"s","too', "utf8");
    const page = await store.readForSession("s");
    assert.equal(page.total, 1, "坏行不应影响好行");
    assert.equal(page.entries[0].tool, "read");
  } finally {
    cleanup();
  }
});

test("关闭开关后完全不写（不建文件、不占磁盘）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir, getEnabled: () => false });
    const accepted = store.record(record());
    await store.flush();
    assert.equal(accepted, false);
    assert.equal(existsSync(join(dir, DECISIONS_FILE_NAME)), false, "关闭时不该建文件");
  } finally {
    cleanup();
  }
});

test("开关开启时内容一定落盘（decisionsCapture 不再能静默降级）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // DEC-029：这里曾经能传 `getCapture: () => false`，让元数据照记、内容
    // 被删掉。真机后果是「配置页开关显示开、记录却只有元数据」——用户报的
    // 就是这个。现在构造函数里没有这个选项，开关开着就一定带内容。
    const store = new DecisionStore({ dir });
    store.record(
      buildDecisionRecord({
        sessionId: "s",
        point: "authorize",
        content: { state: { text: "会话正文" }, questions: { q: ["a"] } },
      }),
    );
    await store.flush();
    const raw = readFileSync(join(dir, DECISIONS_FILE_NAME), "utf8");
    assert.ok(raw.includes("会话正文"), "开关开着时内容必须落盘");
    const page = await store.readForSession("s");
    assert.equal(page.entries[0].capture, "full");
    assert.equal(page.entries[0].content.state.text, "会话正文");
    assert.equal(page.entries[0].contentNote, undefined, "未裁剪时不该有 contentNote");
  } finally {
    cleanup();
  }
});

test("capture:meta 只可能来自超限裁剪，不是任何配置档位", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    // 问题与回答本身就超过上限：连「最后退回元数据」那一档都要走到。
    store.record(
      buildDecisionRecord({
        sessionId: "s",
        point: "authorize",
        maxContentChars: 200,
        content: {
          state: { args_preview: "x".repeat(20000) },
          questions: { q: ["y".repeat(20000)] },
        },
      }),
    );
    await store.flush();
    const page = await store.readForSession("s");
    assert.equal(page.entries[0].capture, "meta", "超限裁剪才产生 meta");
    assert.equal(page.entries[0].content, undefined);
    assert.equal(page.entries[0].contentNote, "too-large");
  } finally {
    cleanup();
  }
});

test("写入的文件权限是 600（明细含会话正文）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    store.record(record());
    await store.flush();
    const mode = statSync(join(dir, DECISIONS_FILE_NAME)).mode & 0o777;
    assert.equal(mode, 0o600, `实际权限 ${mode.toString(8)}`);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 轮转

test("超过体积上限时轮转，旧文件只留一代", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir, getMaxBytes: () => 1024 });
    for (let index = 0; index < 200; index += 1) {
      store.record(record({ sessionId: "s", tool: `t${index}`, detail: "x".repeat(50) }));
    }
    await store.flush();
    assert.equal(store.rotated > 0, true, "应该至少轮转过一次");
    assert.equal(existsSync(join(dir, "decisions.jsonl.1")), true, "旧文件应留一代");
    const rotated = readFileSync(join(dir, "decisions.jsonl.1"), "utf8");
    assert.ok(rotated.length > 0);
  } finally {
    cleanup();
  }
});

test("轮转后上一代的记录仍能读到（从 .1 里补）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir, getMaxBytes: () => 4096 });
    store.record(record({ sessionId: "old", tool: "first" }));
    await store.flush();
    // 一条一条写并落盘，直到真的轮转过一次为止——这样 .1 里装的就是
    // 「轮转前」的那一批，契约是「上一代还在」。
    for (let index = 0; index < 200 && store.rotated === 0; index += 1) {
      store.record(record({ sessionId: "new", tool: `t${index}`, detail: "y".repeat(200) }));
      await store.flush();
    }
    assert.equal(store.rotated >= 1, true, "应该至少轮转过一次");
    const old = await store.readForSession("old");
    assert.equal(old.total, 1, "上一代的记录不该丢");
    assert.equal(old.entries[0].tool, "first");
  } finally {
    cleanup();
  }
});

test("轮转只留一代：磁盘占用有界（不超过两倍上限）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const limit = 4096;
    const store = new DecisionStore({ dir, getMaxBytes: () => limit });
    for (let index = 0; index < 300; index += 1) {
      store.record(record({ sessionId: "s", tool: `t${index}`, detail: "z".repeat(200) }));
    }
    await store.flush();
    const current = statSync(join(dir, DECISIONS_FILE_NAME)).size;
    const rotated = existsSync(join(dir, "decisions.jsonl.1"))
      ? statSync(join(dir, "decisions.jsonl.1")).size
      : 0;
    assert.ok(current <= limit, `当前文件 ${current} 应不超过上限 ${limit}`);
    assert.ok(current + rotated <= limit * 2, `总占用 ${current + rotated} 应不超过两倍上限`);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 尾部读

test("尾部读只取最后 N 行，且顺序正确", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "lines.txt");
    writeFileSync(path, ["a", "b", "c", "d", "e"].join("\n"), "utf8");
    const lines = await readTailLines(path, 3);
    assert.deepEqual(lines, ["c", "d", "e"]);
  } finally {
    cleanup();
  }
});

test("尾部读处理没有尾换行的文件", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, "lines.txt");
    writeFileSync(path, "a\nb\nc", "utf8");
    const lines = await readTailLines(path, 10);
    assert.deepEqual(lines, ["a", "b", "c"]);
  } finally {
    cleanup();
  }
});

test("尾部读对不存在的文件返回空数组", async () => {
  const lines = await readTailLines("/nonexistent/does/not/exist", 10);
  assert.deepEqual(lines, []);
});

// ------------------------------------------------------------------ 分页

test("limit 会截断结果并标记 truncated", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DecisionStore({ dir });
    for (let index = 0; index < 30; index += 1) {
      store.record(record({ sessionId: "s", tool: `t${index}` }));
    }
    await store.flush();
    const page = await store.readForSession("s", { limit: 10 });
    assert.equal(page.entries.length, 10);
    assert.equal(page.total, 30);
    assert.equal(page.truncated, true);
    // 保留的是**最近**的 10 条（时间升序）。
    assert.equal(page.entries[9].tool, "t29");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ 记录身份与顺序
//
// 真机缺陷（2026-11-03）：「点击第二个，展开的是第三个」。
//
// 根因是 `seq` 只在一个进程内唯一：DSH 每重启一次就从 1 重数，于是明细文件里
// 大量记录共用同一批 seq（实测用户数据：307 条只有 119 个不同的 seq）。界面
// 拿它当 React key，重复 key 让事件处理器落到错的行上。
//
// 修复分三处，这里逐个钉住：写入时给全局唯一的 `id`、读取时为老记录补 `id`
// 并保证响应内唯一、**按时间而不是按 seq 排序**。

test("跨重启写入的记录 id 唯一（seq 会重复，id 不会）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 两次独立构造 = 模拟 DSH 重启（进程内计数器各自从 1 开始）。
    const first = new DecisionStore({ dir });
    first.record(record({ sessionId: "s", tool: "run-1-a" }));
    first.record(record({ sessionId: "s", tool: "run-1-b" }));
    await first.flush();

    const second = new DecisionStore({ dir });
    second.record(record({ sessionId: "s", tool: "run-2-a" }));
    second.record(record({ sessionId: "s", tool: "run-2-b" }));
    await second.flush();

    const page = await second.readForSession("s", { limit: 50 });
    const ids = page.entries.map((item) => item.id);
    const seqs = page.entries.map((item) => item.seq);

    assert.equal(page.entries.length, 4);
    assert.equal(new Set(ids).size, 4, `id 必须全局唯一，实际：${JSON.stringify(ids)}`);
    assert.ok(new Set(seqs).size < 4, `前置：seq 本该重复，实际：${JSON.stringify(seqs)}`);

    // 关键补充：**落盘的文件里** id 就必须唯一，而不是靠读取层的去重后缀兜住。
    //
    // 读端的确还有一道「撞了就加位置后缀」的保险，所以只断言「返回的 id 唯一」
    // 是不足以钉住写入侧的——变异测试证明了这一点：把写入的 id 退回 `String(seq)`
    // 之后，读端照样能返回唯一 id，那条断言不会红。
    // 但靠去重后缀是**下策**：它产生的是位置相关的合成 id，窗口一变就可能漂移。
    // 真正的修法是写入时就唯一（进程前缀 + seq），这里直接检查磁盘。
    const raw = readFileSync(join(dir, DECISIONS_FILE_NAME), "utf8");
    const storedIds = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line).id);
    assert.equal(storedIds.length, 4);
    assert.equal(
      new Set(storedIds).size,
      4,
      `落盘记录的 id 必须唯一，实际：${JSON.stringify(storedIds)}`,
    );
  } finally {
    cleanup();
  }
});

test("没有 id 的老记录在读取时被补上唯一 id", async () => {
  const { dir, cleanup } = tempDir();
  try {
    seedRaw(dir, [
      { v: 1, seq: 1, ts: "2026-11-03T08:00:00.000Z", sessionId: "s", point: "authorize" },
      { v: 1, seq: 1, ts: "2026-11-03T08:01:00.000Z", sessionId: "s", point: "authorize" },
      { v: 1, seq: 2, ts: "2026-11-03T08:02:00.000Z", sessionId: "s", point: "authorize" },
    ]);
    const store = new DecisionStore({ dir });
    const page = await store.readForSession("s", { limit: 50 });
    const ids = page.entries.map((item) => item.id);
    assert.equal(page.entries.length, 3);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0), `都应补上 id：${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, 3, `补出来的 id 也必须唯一：${JSON.stringify(ids)}`);
  } finally {
    cleanup();
  }
});

test("按时间排序，而不是按 seq（seq 每重启一次就重数）", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // 交错写入两批：seq 会重复，但 ts 单调递增。
    const store = new DecisionStore({ dir });
    store.record(record({ sessionId: "s", ts: "2026-11-03T08:00:00.000Z", tool: "a1" }));
    store.record(record({ sessionId: "s", ts: "2026-11-03T08:01:00.000Z", tool: "a2" }));
    await store.flush();
    const second = new DecisionStore({ dir });
    second.record(record({ sessionId: "s", ts: "2026-11-03T08:02:00.000Z", tool: "b1" }));
    second.record(record({ sessionId: "s", ts: "2026-11-03T08:03:00.000Z", tool: "b2" }));
    await second.flush();
    // 把第二批的 seq 造得比第一批小，模拟「重启后从 1 重数」的真实形态。
    // （真实文件里就是 append 顺序 = 时间顺序，这里直接验证读回来的顺序。）

    const page = await second.readForSession("s", { limit: 50 });
    const times = page.entries.map((item) => item.ts);
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted, `读回来必须按时间升序，实际：${JSON.stringify(times)}`);
  } finally {
    cleanup();
  }
});

test("recordIdOf：优先用 id，老记录退回 ts#seq", () => {
  assert.equal(recordIdOf({ id: "abc-1", ts: "t", seq: 1 }), "abc-1");
  assert.equal(recordIdOf({ ts: "t", seq: 7 }), "t#7");
  assert.equal(recordIdOf({ seq: 7 }), "#7");
  assert.equal(recordIdOf(null), "");
  assert.equal(recordIdOf({}), "");
});
