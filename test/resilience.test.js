/**
 * 韧性策略（lib/resilience.js）的单元测试。
 *
 * 背景：这个插件把每次工具调用先发给远端「决策小模型」，而外部服务会超时、
 * 会断链、会自己报 500。生产遥测里 358 次降级的分布是 timeout 83 次、
 * network-error 84 次、http-500 95 次、cooldown 93 次（cooldown 是前三类的
 * 放大：连续 3 次失败后 60s 内全部快速失败）。
 *
 * 关键实测规律（4 组独立实验一致）：服务端冷启动时首发要 7–16 秒，但首发
 * 即使被超时掐断也**已经把服务端焐热**，第二发 1.1–1.7 秒必中。所以重试只对
 * timeout / network-error 有意义，4xx/5xx 重试只是多烧额度。
 *
 * 这里只测纯函数（零依赖、零网络、零时钟）：重试判定、退避倍增与封顶、
 * 失败原因的中文翻译。重点覆盖**边界**与**非法输入不抛错**——这两处出错时
 * 症状最隐蔽：要么该重试的没重试（用户多等 8 秒），要么在失败路径上再抛一个
 * 异常（把降级变成崩溃）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RETRYABLE_REASONS,
  describeFailure,
  isRetryableReason,
  nextCooldownMs,
  shouldRetry,
} from "../lib/resilience.js";

// ---- 可重试原因 -----------------------------------------------------------

test("可重试原因只有 timeout 与 network-error，且数组被冻结", () => {
  assert.deepEqual([...RETRYABLE_REASONS], ["timeout", "network-error"]);
  assert.equal(Object.isFrozen(RETRYABLE_REASONS), true, "冻结：调用方不该就地改写这份清单");
  assert.equal(isRetryableReason("timeout"), true);
  assert.equal(isRetryableReason("network-error"), true);
});

test("5xx 与 4xx 都不可重试：前者是服务商故障，后者是配置错", () => {
  for (const reason of [
    "http-400",
    "http-401",
    "http-404",
    "http-500",
    "http-502",
    "http-503",
    "http-530",
    "auth-failed",
    "no-key",
    "invalid-json",
    "cooldown",
  ]) {
    assert.equal(isRetryableReason(reason), false, `${reason} 重试只是多烧一次额度`);
  }
});

test("原因判定是精确匹配：不做大小写归一，也不接受非字符串", () => {
  assert.equal(isRetryableReason("TIMEOUT"), false, "大小写写错说明调用方拿错了字段，不该静默纠正");
  assert.equal(isRetryableReason(" timeout"), false);
  assert.equal(isRetryableReason(undefined), false);
  assert.equal(isRetryableReason(null), false);
  assert.equal(isRetryableReason(500), false);
  assert.equal(isRetryableReason({ reason: "timeout" }), false);
});

// ---- shouldRetry：重试判定 -------------------------------------------------

/** shouldRetry 的一组「刚好可重试」的默认参数。 */
const retryArgs = (over = {}) => ({
  reason: "timeout",
  attempt: 0,
  elapsedMs: 8000,
  timeoutMs: 8000,
  maxAttempts: 2,
  maxBudgetMs: 20000,
  ...over,
});

test("首发超时、预算充足、还有下一次 → 重试", () => {
  assert.equal(shouldRetry(retryArgs()), true);
});

test("network-error 同样可重试（ECONNRESET 重发一次常常就通了）", () => {
  assert.equal(shouldRetry(retryArgs({ reason: "network-error" })), true);
});

test("不可重试原因：即使预算充足、还有次数也不重试", () => {
  for (const reason of ["http-500", "http-502", "http-400", "auth-failed", "no-key", "cooldown"]) {
    assert.equal(
      shouldRetry(retryArgs({ reason, attempt: 0, maxAttempts: 5, maxBudgetMs: 60000 })),
      false,
      `${reason} 不该重试`,
    );
  }
});

test("attempt 边界：attempt + 1 < maxAttempts 才重试（maxAttempts 含首发）", () => {
  // maxAttempts=2：attempt=0 还能再打一次，attempt=1 已经是最后一次。
  assert.equal(shouldRetry(retryArgs({ attempt: 0, maxAttempts: 2 })), true);
  assert.equal(shouldRetry(retryArgs({ attempt: 1, maxAttempts: 2 })), false);
  // maxAttempts=1：首发即最后一次，永不重试。
  assert.equal(shouldRetry(retryArgs({ attempt: 0, maxAttempts: 1 })), false);
  // maxAttempts=3：attempt=1 仍可重试。
  assert.equal(shouldRetry(retryArgs({ attempt: 1, maxAttempts: 3 })), true);
  assert.equal(shouldRetry(retryArgs({ attempt: 2, maxAttempts: 3 })), false);
});

test("预算边界：elapsedMs 达到或超过 maxBudgetMs 就不重试", () => {
  assert.equal(shouldRetry(retryArgs({ elapsedMs: 19999, maxBudgetMs: 20000 })), true);
  assert.equal(shouldRetry(retryArgs({ elapsedMs: 20000, maxBudgetMs: 20000 })), false, "预算刚好用完");
  assert.equal(shouldRetry(retryArgs({ elapsedMs: 20001, maxBudgetMs: 20000 })), false);
});

test("预算看的是整轮已耗时，与单次 timeoutMs 无关", () => {
  // 单次预算很大，但整轮预算已经耗光：再发一次只会更慢地失败。
  assert.equal(shouldRetry(retryArgs({ elapsedMs: 9000, timeoutMs: 30000, maxBudgetMs: 9000 })), false);
  // 单次预算很小，整轮预算还很充裕：该重试。
  assert.equal(shouldRetry(retryArgs({ elapsedMs: 1000, timeoutMs: 1000, maxBudgetMs: 20000 })), true);
});

test("预算判定是 elapsedMs < maxBudgetMs，不是 elapsedMs + timeoutMs > maxBudgetMs", () => {
  // 契约写的就是「elapsedMs 小于 maxBudgetMs」。若改成预估「已耗时 + 本次超时」，
  // 这一组会全部翻转：1100 + 1000 > 2000 会被判成不重试。实测第二发只需
  // 1.1–1.7 秒，用预估式会白白放弃掉「第二发必中」的那次机会。
  const args = { reason: "timeout", attempt: 0, maxAttempts: 2, timeoutMs: 1000, maxBudgetMs: 2000 };
  assert.equal(shouldRetry({ ...args, elapsedMs: 1100 }), true, "已耗时 1100 < 预算 2000 → 重试");
  assert.equal(shouldRetry({ ...args, elapsedMs: 1500 }), true, "已耗时 1500 < 预算 2000 → 重试");
  assert.equal(shouldRetry({ ...args, elapsedMs: 2000 }), false, "已耗时刚好等于预算 → 不重试");
});

test("非法输入一律返回 false，绝不抛错", () => {
  const bad = [
    undefined,
    null,
    {},
    [],
    "timeout",
    42,
    retryArgs({ attempt: -1 }),
    retryArgs({ attempt: 1.5 }),
    retryArgs({ attempt: "0" }),
    retryArgs({ attempt: undefined }),
    retryArgs({ maxAttempts: 0 }),
    retryArgs({ maxAttempts: 2.5 }),
    retryArgs({ maxAttempts: undefined }),
    retryArgs({ elapsedMs: -1 }),
    retryArgs({ elapsedMs: NaN }),
    retryArgs({ elapsedMs: undefined }),
    retryArgs({ maxBudgetMs: 0 }),
    retryArgs({ maxBudgetMs: -1 }),
    retryArgs({ maxBudgetMs: Infinity }),
    retryArgs({ maxBudgetMs: undefined }),
  ];
  for (const args of bad) {
    assert.doesNotThrow(() => shouldRetry(args), `shouldRetry(${JSON.stringify(args)}) 不该抛错`);
    assert.equal(shouldRetry(args), false, `shouldRetry(${JSON.stringify(args)}) 应为 false`);
  }
});

test("带 getter 的怪对象也不抛错（失败路径上宁可放弃重试）", () => {
  const trap = {
    get reason() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => shouldRetry(trap));
  assert.equal(shouldRetry(trap), false);
});

// ---- nextCooldownMs：退避 --------------------------------------------------

test("首轮冷却就是 base，之后逐轮倍增", () => {
  const args = { baseCooldownMs: 60000, maxCooldownMs: 600000 };
  assert.equal(nextCooldownMs({ ...args, streak: 1 }), 60000);
  assert.equal(nextCooldownMs({ ...args, streak: 2 }), 120000);
  assert.equal(nextCooldownMs({ ...args, streak: 3 }), 240000);
  assert.equal(nextCooldownMs({ ...args, streak: 4 }), 480000);
});

test("冷却时长封顶在 maxCooldownMs", () => {
  const args = { baseCooldownMs: 60000, maxCooldownMs: 600000 };
  assert.equal(nextCooldownMs({ ...args, streak: 5 }), 600000, "960000 应被压到封顶值");
  assert.equal(nextCooldownMs({ ...args, streak: 50 }), 600000);
  // 封顶值比 base 还小时，也不能超过封顶。
  assert.equal(nextCooldownMs({ baseCooldownMs: 60000, streak: 1, maxCooldownMs: 10000 }), 10000);
});

test("streak <= 0 视为 1；小数向下取整", () => {
  const args = { baseCooldownMs: 60000, maxCooldownMs: 600000 };
  assert.equal(nextCooldownMs({ ...args, streak: 0 }), 60000);
  assert.equal(nextCooldownMs({ ...args, streak: -3 }), 60000);
  assert.equal(nextCooldownMs({ ...args, streak: 2.9 }), 120000);
});

test("非法输入返回 base（或 0），不抛错也不返回 NaN", () => {
  const args = { baseCooldownMs: 60000, maxCooldownMs: 600000 };
  for (const streak of [undefined, null, NaN, "3", {}, []]) {
    const value = nextCooldownMs({ ...args, streak });
    assert.doesNotThrow(() => nextCooldownMs({ ...args, streak }));
    assert.equal(value, 60000, `streak=${JSON.stringify(streak)} 应按 1 处理`);
  }
  // 连参数都没有：base 不可用，只能返回 0（不能把 NaN 传出去）。
  assert.doesNotThrow(() => nextCooldownMs());
  assert.equal(nextCooldownMs(), 0);
  assert.equal(nextCooldownMs({ streak: 3 }), 0);
  assert.equal(nextCooldownMs({ baseCooldownMs: NaN, streak: 3 }), 0);
  assert.equal(nextCooldownMs({ baseCooldownMs: -1, streak: 3 }), 0);
  assert.equal(nextCooldownMs(null), 0);
});

test("缺省 maxCooldownMs 时不封顶，但不会返回 Infinity", () => {
  const value = nextCooldownMs({ baseCooldownMs: 1000, streak: 100 });
  assert.equal(Number.isFinite(value), true);
  assert.equal(value, Math.min(1000 * 2 ** 99, Number.MAX_SAFE_INTEGER));
});

// ---- describeFailure：中文翻译 ---------------------------------------------

/** 审计字段名（遥测内部语言，不该出现在给用户看的文案里）。 */
const AUDIT_FIELD = /\b(?:risk|p)\s*=/i;
/** 裸小数（例如 0.42）：用户语言里不该出现。 */
const BARE_DECIMAL = /(?<![\d.])\d+\.\d+/;

/** 断言 title / hint 都是非空中文，且不含审计字段名与裸小数。 */
const assertUserFacing = (result, label) => {
  assert.equal(typeof result.title, "string", `${label}: title 应为字符串`);
  assert.equal(typeof result.hint, "string", `${label}: hint 应为字符串`);
  assert.ok(result.title.trim().length > 0, `${label}: title 不能为空`);
  assert.ok(result.hint.trim().length > 0, `${label}: hint 不能为空`);
  assert.doesNotMatch(result.title, AUDIT_FIELD, `${label}: title 不该出现审计字段名`);
  assert.doesNotMatch(result.hint, AUDIT_FIELD, `${label}: hint 不该出现审计字段名`);
  assert.doesNotMatch(result.title, BARE_DECIMAL, `${label}: title 不该出现裸小数`);
  assert.doesNotMatch(result.hint, BARE_DECIMAL, `${label}: hint 不该出现裸小数`);
  assert.match(result.title, /[\u4e00-\u9fa5]/, `${label}: title 应为中文`);
  assert.match(result.hint, /[\u4e00-\u9fa5]/, `${label}: hint 应为中文`);
};

test("timeout → 请求超时，提示调大 timeoutMs 或关掉 thinkMode", () => {
  const result = describeFailure("timeout", { timeoutMs: 8000 });
  assertUserFacing(result, "timeout");
  assert.equal(result.title, "请求超时");
  assert.match(result.hint, /timeoutMs/);
  assert.match(result.hint, /thinkMode/);
  assert.match(result.hint, /冷启动/);
  assert.match(result.hint, /8000ms/, "把这次的预算说出来，用户才知道往哪调");
});

test("timeout 的预算带小数时取整，不把裸小数漏给用户", () => {
  const result = describeFailure("timeout", { timeoutMs: 8000.5 });
  assertUserFacing(result, "timeout(小数预算)");
  assert.match(result.hint, /8001ms/);
});

test("network-error → 网络连接失败，提示代理开关并附上底层错误", () => {
  const result = describeFailure("network-error", { message: "fetch failed" });
  assertUserFacing(result, "network-error");
  assert.equal(result.title, "网络连接失败");
  assert.match(result.hint, /NODE_USE_ENV_PROXY=1/);
  assert.match(result.hint, /代理/);
  assert.match(result.hint, /fetch failed/, "底层错误是用户搜问题的唯一线索");
  // 没有 message 时也不能拼出「底层错误：」这种空尾巴。
  const bare = describeFailure("network-error");
  assertUserFacing(bare, "network-error(无 message)");
  assert.doesNotMatch(bare.hint, /底层错误/, "没有底层错误就不要写这一句");
});

test("http-5xx（500/502/503/530）→ 服务端内部错误，带请求 id", () => {
  for (const reason of ["http-500", "http-502", "http-503", "http-530"]) {
    const result = describeFailure(reason, { requestId: "req-abc-123" });
    assertUserFacing(result, reason);
    assert.equal(result.title, "服务端内部错误", `${reason} 的标题`);
    assert.match(result.hint, /req-abc-123/, `${reason} 应带上请求 id`);
    assert.match(result.hint, /服务商/, `${reason} 应指明是服务商侧故障`);
    assert.match(result.hint, /无需改动/, `${reason} 应明确本地配置不用改`);
  }
});

test("http-5xx 的请求 id 也能从响应体里取到", () => {
  const result = describeFailure("http-500", {
    body: '{"error":{"message":"Database error"},"x-oneapi-request-id":"req-from-body-9"}',
  });
  assertUserFacing(result, "http-500(请求 id 在响应体里)");
  assert.match(result.hint, /req-from-body-9/);
});

test("http-5xx 没有请求 id 时，提示联系服务商并附响应体", () => {
  const withBody = describeFailure("http-500", { body: '{"error":"Task request failed"}' });
  assertUserFacing(withBody, "http-500(无 id,有 body)");
  assert.match(withBody.hint, /Task request failed/);
  assert.match(withBody.hint, /联系服务商/);

  const withoutBody = describeFailure("http-502");
  assertUserFacing(withoutBody, "http-502(无 id 无 body)");
  assert.match(withoutBody.hint, /联系服务商/);
});

test("cooldown → 冷却中，说明会自动恢复、不用手动操作", () => {
  const result = describeFailure("cooldown");
  assertUserFacing(result, "cooldown");
  assert.equal(result.title, "冷却中");
  assert.match(result.hint, /冷却/);
  assert.match(result.hint, /自动恢复/);
});

test("其余原因（4xx / auth-failed / no-key / invalid-json）→ 请求失败，带 reason 原文", () => {
  for (const reason of ["http-400", "http-401", "http-404", "auth-failed", "no-key", "invalid-json"]) {
    const result = describeFailure(reason);
    assertUserFacing(result, reason);
    assert.equal(result.title, "请求失败", `${reason} 的标题`);
    assert.match(result.hint, new RegExp(reason), `${reason} 原文要保留，用户才能搜到对应文档`);
  }
});

test("describeFailure 对缺失/异常入参也不抛错，且始终返回可用文案", () => {
  const cases = [undefined, null, "", "  ", 500, {}, [], Symbol("timeout")];
  for (const reason of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = describeFailure(reason);
    }, `describeFailure(${String(reason)}) 不该抛错`);
    assertUserFacing(result, `reason=${String(reason)}`);
  }
  // extra 传错类型时也不能炸。
  for (const extra of [null, undefined, 42, "oops", []]) {
    const result = describeFailure("network-error", extra);
    assertUserFacing(result, `extra=${String(extra)}`);
  }
});

test("响应体里的审计字段与裸小数不会漏进用户文案", () => {
  const result = describeFailure("http-500", {
    body: 'risk=0.87 p=0.42 Database error',
    requestId: "",
  });
  assertUserFacing(result, "http-500(脏响应体)");
  assert.doesNotMatch(result.hint, /risk=/);
  assert.doesNotMatch(result.hint, /p=/);
});
