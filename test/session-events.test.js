/**
 * 会话事件读取的**兼容层**测试（DEC-045）。
 *
 * 为什么值得单独测：宿主把 `session.events` 换成了 `session.snapshotEvents()`，
 * 而插件原来的写法是 `session.events ?? []`——`??` 兜住了 `undefined`，
 * 于是**不报错、只是永远拿到空数组**。
 *
 * 这类失败没有任何日志：用户只看到插件时灵时不灵。因此必须由测试守住
 * 「新宿主上读得到、旧宿主上也读得到」。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sessionEventsOf, findLastEvent } from "../lib/session-events.js";

/** 一条最小的消息事件。 */
const messageEvent = (seq, role, text) => ({
  type: role === "user" ? "user/message" : "assistant/message",
  seq,
  data: { message: { role, content: [{ type: "text", text }] } },
});

/** 旧宿主形状：公开的 events 数组。 */
const legacySession = (events) => ({ events });

/** 新宿主形状：只有 snapshotEvents()，没有 events 成员。 */
const modernSession = (events) => ({ snapshotEvents: () => events });

test("新宿主：读 snapshotEvents()", () => {
  const events = [messageEvent(0, "user", "hi")];
  assert.deepEqual(sessionEventsOf(modernSession(events)), events);
});

test("旧宿主：读 events 数组", () => {
  const events = [messageEvent(0, "user", "hi")];
  assert.deepEqual(sessionEventsOf(legacySession(events)), events);
});

test("新宿主优先：两个都在时用 snapshotEvents()", () => {
  const modern = [messageEvent(1, "assistant", "新")];
  const legacy = [messageEvent(0, "user", "旧")];
  const session = { snapshotEvents: () => modern, events: legacy };
  assert.deepEqual(sessionEventsOf(session), modern);
});

test("snapshotEvents 抛错时回落到旧 API", () => {
  const legacy = [messageEvent(0, "user", "hi")];
  const session = {
    snapshotEvents: () => {
      throw new Error("boom");
    },
    events: legacy,
  };
  assert.deepEqual(sessionEventsOf(session), legacy);
});

test("snapshotEvents 返回的不是数组时回落到旧 API", () => {
  const legacy = [messageEvent(0, "user", "hi")];
  const session = { snapshotEvents: () => undefined, events: legacy };
  assert.deepEqual(sessionEventsOf(session), legacy);
});

test("两个 API 都没有时返回空数组（不抛）", () => {
  assert.deepEqual(sessionEventsOf({}), []);
  assert.deepEqual(sessionEventsOf(null), []);
  assert.deepEqual(sessionEventsOf(undefined), []);
});

test("events 不是数组时返回空数组", () => {
  assert.deepEqual(sessionEventsOf({ events: "not an array" }), []);
});

test("findLastEvent 从后往前找", () => {
  const events = [
    messageEvent(0, "user", "第一"),
    messageEvent(1, "assistant", "第二"),
    messageEvent(2, "assistant", "第三"),
  ];
  const found = findLastEvent(modernSession(events), (event) => event.type === "assistant/message");
  assert.equal(found.seq, 2);
});

test("findLastEvent 找不到时返回 undefined", () => {
  const found = findLastEvent(modernSession([messageEvent(0, "user", "x")]), () => false);
  assert.equal(found, undefined);
});
