/**
 * 错误尾部的测试：降级/异常要能挂在**对应那条消息**的末尾。
 *
 * 覆盖三条链路的每一段：
 *
 *   宿主  lib/errors.js    错误归一化、按轮次归拢账本、从会话日志读当前轮次
 *   宿主  lib/publish.js   降级原因 → 分类的归并；发布器不因发布失败而崩
 *   客户端 lib/client-errors.js  事件 → 轮次数据 → 尾部渲染
 *
 * 另外盯一件事：**客户端 bundle 里内联的那份逻辑必须与 lib/client-errors.js
 * 一致**。客户端 bundle 是独立加载单元（window.__ModuleLoader__），
 * 它的 require() 拿不到同目录的兄弟文件，所以两份是各写各的——
 * 这份测试就是防止它们悄悄跑偏的那道闸。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ERROR_CODES,
  ERROR_LABELS,
  createErrorLedger,
  currentTurnOf,
  errorFromTelemetry,
  normalizeError,
} from "../lib/errors.js";
import { createErrorPublisher, errorCodeOf } from "../lib/publish.js";
import {
  ERROR_LABELS as CLIENT_ERROR_LABELS,
  ERROR_EVENT_TYPE,
  POINT_LABELS,
  TURN_DATA_KEY,
  createErrorDefinition,
  errorFromEvent,
  errorsOfTurn,
} from "../lib/client-errors.js";

// ---------------------------------------------------------------- 归一化

test("错误归一化：未知分类归到 adapter-error（不猜）", () => {
  const error = normalizeError({ point: "authorize", code: "http-404" });
  assert.equal(error.code, "adapter-error");
  assert.equal(error.label, ERROR_LABELS["adapter-error"]);
});

test("错误归一化：保留轮次、工具与说明", () => {
  const error = normalizeError({
    point: "authorize",
    code: "auth-failed",
    detail: "HTTP 401",
    turn: 7,
    tool: "bash",
  });
  assert.equal(error.code, "auth-failed");
  assert.equal(error.turn, 7);
  assert.equal(error.tool, "bash");
  assert.equal(error.detail, "HTTP 401");
});

test("错误归一化：没有轮次就不带轮次（不猜一个 0）", () => {
  const error = normalizeError({ point: "route", code: "timeout" });
  assert.equal(Object.hasOwn(error, "turn"), false, "没有轮次时不该凭空造一个 0");
});

test("错误归一化：说明过长会被截断（消息尾部放不下整段响应体）", () => {
  const error = normalizeError({ point: "route", code: "timeout", detail: "x".repeat(500) });
  assert.ok(error.detail.length <= 121, `说明应被截断，实际 ${error.detail.length}`);
  assert.ok(error.detail.endsWith("…"), "截断后应有省略号");
});

// ---------------------------------------------------------------- 账本

test("账本：同一轮同一分类只留一条（消息尾部不会堆出五行红字）", () => {
  const ledger = createErrorLedger();
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 1 }));
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 1, detail: "第二次" }));
  const errors = ledger.errorsOf(1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail, "第二次", "应保留后来的那条（它通常更具体）");
});

test("账本：同一轮的不同分类各占一行", () => {
  const ledger = createErrorLedger();
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 1 }));
  ledger.note(normalizeError({ point: "route", code: "no-key", turn: 1 }));
  assert.equal(ledger.errorsOf(1).length, 2);
});

test("账本：不同轮互不干扰（错误不会跑到别的消息下面）", () => {
  const ledger = createErrorLedger();
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 1 }));
  ledger.note(normalizeError({ point: "authorize", code: "no-key", turn: 2 }));
  assert.equal(ledger.errorsOf(1).length, 1);
  assert.equal(ledger.errorsOf(1)[0].code, "timeout");
  assert.equal(ledger.errorsOf(2)[0].code, "no-key");
  assert.equal(ledger.errorsOf(3).length, 0);
});

test("账本：超出容量上限时丢掉最旧的轮次（常驻内存不能无界增长）", () => {
  const ledger = createErrorLedger({ maxTurns: 2 });
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 1 }));
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 2 }));
  ledger.note(normalizeError({ point: "authorize", code: "timeout", turn: 3 }));
  assert.equal(ledger.errorsOf(1).length, 0, "最旧的一轮应被丢掉");
  assert.equal(ledger.errorsOf(3).length, 1);
});

test("账本：没有轮次的错误不入账（挂不到消息上就不入账）", () => {
  const ledger = createErrorLedger();
  ledger.note(normalizeError({ point: "authorize", code: "timeout" }));
  assert.equal(ledger.errorsOf(undefined).length, 0);
});

// ---------------------------------------------------------------- 当前轮次

test("当前轮次：从会话事件里读出最近一条 turn/start", () => {
  const session = {
    events: [
      { type: "turn/start", data: { turn: 1 } },
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "turn/start", data: { turn: 2 } },
    ],
  };
  assert.equal(currentTurnOf(session), 2);
});

test("当前轮次：读不到时返回 undefined（宁可少显示，也不挂错消息）", () => {
  assert.equal(currentTurnOf({ events: [] }), undefined);
  assert.equal(currentTurnOf(undefined), undefined);
  assert.equal(currentTurnOf({ events: [{ type: "step/start", data: { turn: 3 } }] }), undefined);
});

// ---------------------------------------------------------------- 分类归并

test("分类归并：http-4xx / http-5xx 归成 http-error（不铺开一堆红字）", () => {
  assert.equal(errorCodeOf("http-404"), "http-error");
  assert.equal(errorCodeOf("http-500"), "http-error");
  assert.equal(errorCodeOf("auth-failed"), "auth-failed");
  assert.equal(errorCodeOf("no-key"), "no-key");
});

test("分类归并：429 单列成限流（修复动作与其它 HTTP 错误不同）", () => {
  assert.equal(errorCodeOf("http-429"), "rate-limited");
  assert.equal(errorCodeOf("http-500"), "http-error");
});

test("分类归并：引擎层的笼统原因归到 adapter-error", () => {
  assert.equal(errorCodeOf("classify"), "adapter-error");
  assert.equal(errorCodeOf("build-error"), "adapter-error");
  assert.equal(errorCodeOf("no-spec"), "adapter-error");
  assert.equal(errorCodeOf(undefined), "adapter-error");
});

// ---------------------------------------------------------------- 发布器

test("发布器：错误按轮次落进指定会话", () => {
  const published = [];
  const publisher = createErrorPublisher({
    publish: (session, error) => published.push([session, error]),
  });
  const session = { id: "s1" };
  publisher.note(session, { point: "authorize", code: "auth-failed", turn: 4 });
  assert.equal(published.length, 1);
  assert.equal(published[0][0], session, "必须落到出错的那个会话，不能落到别的会话");
  assert.equal(published[0][1].turn, 4);
});

test("发布器：发布失败不影响决策（报告通路不能反过来弄坏决策）", () => {
  const publisher = createErrorPublisher({
    publish: () => {
      throw new Error("boom");
    },
    logger: { warn() {} },
  });
  // 不抛即通过：发布器的职责是「报告」，报告失败只记警告。
  const error = publisher.note({ id: "s1" }, { point: "authorize", code: "timeout", turn: 1 });
  assert.equal(error.code, "timeout");
});

test("发布器：没有会话时只记不发布", () => {
  const published = [];
  const publisher = createErrorPublisher({ publish: (session, error) => published.push(error) });
  publisher.note(undefined, { point: "authorize", code: "timeout", turn: 1 });
  assert.equal(published.length, 0);
});

// ---------------------------------------------------------------- 客户端：事件 → 轮次数据

test("客户端：错误事件被归一化成可展示的错误", () => {
  const error = errorFromEvent({
    type: ERROR_EVENT_TYPE,
    data: { turn: 3, point: "retrieval", code: "timeout", detail: "8s" },
  });
  assert.equal(error.turn, 3);
  assert.equal(error.point, "retrieval");
  assert.equal(error.label, CLIENT_ERROR_LABELS.timeout);
});

test("客户端：不是错误事件就返回 null", () => {
  assert.equal(errorFromEvent({ type: "assistant/message", data: {} }), null);
  assert.equal(errorFromEvent({ type: ERROR_EVENT_TYPE, data: { point: "x" } }), null);
});

test("客户端：Definition 把同一轮的多条错误折进同一轮次数据", () => {
  const definition = createErrorDefinition();
  const state = { turn: 2, errors: [] };
  const afterFirst = definition.update(
    { state },
    { event: { type: ERROR_EVENT_TYPE, data: { turn: 2, point: "authorize", code: "timeout" } } },
  );
  const afterSecond = definition.update(
    { state: afterFirst },
    { event: { type: ERROR_EVENT_TYPE, data: { turn: 2, point: "route", code: "no-key" } } },
  );
  assert.equal(afterSecond.errors.length, 2, "同一轮的不同分类都该保留");
});

test("客户端：Definition 必须以 turn/start 作为 start 匹配", () => {
  // 对话层要求每个上下文先有 start 匹配，之后才收 update 匹配；
  // 只匹配错误事件（全是 update）会撞上
  // 「conversation Context received an update before its start Match」而抛错。
  const definition = createErrorDefinition();
  const start = definition.match({ type: "turn/start", data: { turn: 4 } });
  assert.ok(start !== null, "turn/start 必须被匹配");
  assert.equal(start.role, "start", "turn/start 必须是 start 角色");
  assert.equal(start.id, "4", "id 必须是轮次号（与错误事件的 id 同轴）");

  const update = definition.match({
    type: ERROR_EVENT_TYPE,
    data: { turn: 4, point: "authorize", code: "timeout" },
  });
  assert.equal(update.role, "update");
  assert.equal(update.id, start.id, "同一轮的 start 与 update 必须落在同一个上下文");
});

test("客户端：turn/start 的轮次号取自事件本身（不是我们自己写的副本）", () => {
  const definition = createErrorDefinition();
  const match = definition.match({ type: "turn/start", data: { turn: 7 } });
  const state = definition.start({}, match);
  assert.equal(state.turn, 7);
  assert.deepEqual(state.errors, []);
});

test("客户端：轮次号非法时不匹配（不造出一个上下文）", () => {
  const definition = createErrorDefinition();
  assert.equal(definition.match({ type: "turn/start", data: { turn: -1 } }), null);
  assert.equal(definition.match({ type: "turn/start", data: {} }), null);
});

test("客户端：Definition 的轮次数据键名与读取端一致", () => {
  const definition = createErrorDefinition();
  const data = definition.buildLocationData(
    { state: { turn: 5, errors: [] } },
    "turn",
    undefined,
  );
  assert.equal(data.key, TURN_DATA_KEY);
  assert.equal(data.turn, 5);
});

test("客户端：turnTail 用 owner.turn.data 取回本轮错误", () => {
  const errors = [{ turn: 1, point: "authorize", code: "timeout", label: "决策请求超时" }];
  const owner = {
    turn: {
      data: {
        get: (key) => (key === TURN_DATA_KEY ? { kind: "turn", turn: 1, key, value: { errors } } : undefined),
      },
    },
  };
  assert.equal(errorsOfTurn(owner).length, 1);
  assert.equal(errorsOfTurn({}).length, 0);
});

// ---------------------------------------------------------------- 两份实现必须一致

test("一致性：客户端 bundle 内联的分类表与 lib/client-errors.js 相同", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const code of Object.keys(CLIENT_ERROR_LABELS)) {
    // 客户端 bundle 里的清单是对象字面量，键可能带引号也可能不带，
    // 两种写法都要认——否则这个测试会因为格式差异误报。
    assert.ok(
      source.includes(`"${code}"`) || source.includes(`${code}:`),
      `客户端 bundle 缺少错误分类「${code}」——两份清单跑偏了`,
    );
    assert.ok(
      source.includes(CLIENT_ERROR_LABELS[code]),
      `客户端 bundle 缺少错误分类「${code}」的中文名`,
    );
  }
});

test("一致性：客户端 bundle 内联的事件类型与轮次数据键名一致", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(source.includes(ERROR_EVENT_TYPE), "客户端 bundle 的事件类型与共享模块不一致");
  assert.ok(source.includes(TURN_DATA_KEY), "客户端 bundle 的轮次数据键名与共享模块不一致");
});

test("一致性：客户端 bundle 内联的决策点中文名表与共享模块相同", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const point of Object.keys(POINT_LABELS)) {
    assert.ok(
      source.includes(`"${point}"`) || source.includes(`${point}:`),
      `客户端 bundle 缺少决策点「${point}」`,
    );
    assert.ok(source.includes(POINT_LABELS[point]), `客户端 bundle 缺少决策点「${point}」的中文名`);
  }
});

test("一致性：宿主与客户端的错误分类表相同（否则界面上显示的名字对不上）", () => {
  assert.deepEqual(Object.keys(CLIENT_ERROR_LABELS).sort(), Object.keys(ERROR_LABELS).sort());
  for (const code of Object.keys(ERROR_LABELS)) {
    assert.equal(CLIENT_ERROR_LABELS[code], ERROR_LABELS[code], `分类「${code}」的中文名两侧不一致`);
  }
});

test("一致性：宿主与客户端的事件类型相同（否则客户端永远收不到事件）", () => {
  const hostSource = readFileSync(new URL("../lib/publish.js", import.meta.url), "utf8");
  assert.ok(
    hostSource.includes(`"${ERROR_EVENT_TYPE}"`),
    "宿主发布的事件类型与客户端匹配的不一致",
  );
});

test("一致性：错误分类表里的每一项都能被归一化认出来", () => {
  for (const code of ERROR_CODES) {
    const error = normalizeError({ point: "authorize", code });
    assert.equal(error.code, code, `分类「${code}」没能原样通过归一化`);
  }
});

// ---------------------------------------------------------------- 遥测回填

test("遥测回填：带轮次的降级记录能读出错误", () => {
  const error = errorFromTelemetry({
    action: "degraded",
    detail: "auth-failed",
    point: "authorize",
    turn: 3,
  });
  assert.equal(error.code, "auth-failed");
  assert.equal(error.turn, 3);
});

test("遥测回填：不是降级或没有轮次的记录不产生错误", () => {
  assert.equal(errorFromTelemetry({ action: "allow", turn: 3 }), null);
  assert.equal(errorFromTelemetry({ action: "degraded", detail: "timeout" }), null);
  assert.equal(errorFromTelemetry(null), null);
});
