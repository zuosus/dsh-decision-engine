/**
 * 「免费模型兜底」（backup model）的**判断层**测试。
 *
 * 这个功能只有两条承诺，而它们都能被纯函数断言：
 *
 *   1. **哪些失败值得换一次兜底**。答错的两个方向都很贵：漏掉 429/402 就
 *      等于功能没生效（用户明明有免费通道却在额度不足时静默降级）；把
 *      timeout / network-error 也算进来，则单次决策的最坏等待从 2×timeout
 *      抬到 3×timeout，而这两类本来就已有专门的「冷启动重试」（见
 *      lib/resilience.js 的实测依据）。
 *   2. **兜底此刻到底可不可用**。不可用时不能发请求（那是白烧一次往返），
 *      但必须能说清原因——「为什么这次没兜底」正是用户最会问的那句话。
 *
 * 因此这里不拉插件运行时、不打网络，只测 lib/backup-model.js。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKUP_REFRESH_MARGIN_MS,
  backupPlanOf,
  shouldFallback,
} from "../lib/backup-model.js";

// ---------------------------------------------------------- 1. 触发范围

test("4xx 一律触发兜底：429 额度不足 / 402 欠费 / 400 / 404 / 401 / 403", () => {
  // 需求原话是「不管是 429 insufficient balance 还是其他 4xx/5xx」，
  // 因此这里逐个钉住，而不是只测一个代表值。
  for (const status of [400, 401, 402, 403, 404, 429]) {
    assert.equal(
      shouldFallback({ reason: `http-${status}`, status }),
      true,
      `HTTP ${status} 应当触发兜底`,
    );
  }
});

test("5xx 一律触发兜底：500 / 502 / 503 / 530", () => {
  for (const status of [500, 502, 503, 530]) {
    assert.equal(
      shouldFallback({ reason: `http-${status}`, status }),
      true,
      `HTTP ${status} 应当触发兜底`,
    );
  }
});

test("鉴权失败（401/403 单独归类）也触发：换一套 key 正是兜底的意义", () => {
  // classify() 把 401/403 归成 auth-failed 而不是 http-401。它是「这把 key
  // 不能用」——而兜底换的正是 key，所以它必须在触发集合里。
  assert.equal(shouldFallback({ reason: "auth-failed", status: 401 }), true);
  assert.equal(shouldFallback({ reason: "auth-failed", status: 403 }), true);
  // 没有状态码时按 reason 判断（引擎某些路径不含 status）。
  assert.equal(shouldFallback({ reason: "auth-failed" }), true);
});

test("200 但响应体不可用：invalid-json / invalid-response / missing-answers 都触发", () => {
  // 这三种是「端点活着但没给出可用答案」。它们与 4xx/5xx 一样属于
  // 「这家模型此刻不可用」，用户拿不到裁决。
  for (const reason of ["invalid-json", "invalid-response", "missing-answers"]) {
    assert.equal(shouldFallback({ reason }), true, `${reason} 应当触发兜底`);
  }
});

test("超时与网络错误**不**触发兜底（它们已有冷启动重试）", () => {
  // 关键取舍：resilience.js 实测「首发被超时掐断时服务端已被焐热，第二发
  // 1–2 秒必中」，所以 timeout / network-error 已有专门的重试。再叠一次
  // 兜底会把最坏等待抬到 3×timeout，而换一家服务商并不解决本机链路问题。
  for (const reason of ["timeout", "network-error"]) {
    assert.equal(shouldFallback({ reason }), false, `${reason} 不该触发兜底`);
  }
});

test("调用方主动取消与冷却中**不**触发兜底", () => {
  // caller-aborted：调用方已经不想要这次决策了，兜底等于无视取消。
  // cooldown：它是本地保护机制，不是「模型不可用」。
  assert.equal(shouldFallback({ reason: "caller-aborted" }), false);
  assert.equal(shouldFallback({ reason: "cooldown" }), false);
});

test("配置类失败（地址非法 / 没 key）不在触发集合里：那是本地配置问题", () => {
  // invalid-base-url 与 no-key 发生在**发出请求之前**，而且 classify() 在
  // 那之前就已经降级了。写在这里是防止将来有人把它们误加进触发集合——
  // 换兜底 provider 并不能修复「你填的地址不合法」。
  for (const reason of ["invalid-base-url", "no-key"]) {
    assert.equal(shouldFallback({ reason }), false, `${reason} 不该触发兜底`);
  }
});

test("畸形输入一律不触发、也不抛错", () => {
  // 它在热路径上被调用，一个坏 reason 不该把决策打挂。
  for (const value of [undefined, null, {}, "", 0, "http-", "http-abc"]) {
    assert.doesNotThrow(() => shouldFallback(value), `shouldFallback(${String(value)}) 不该抛`);
    assert.equal(shouldFallback(value), false, `shouldFallback(${String(value)}) 应为 false`);
  }
});

test("http-4xx / http-5xx 的**状态码本身**足以触发，不依赖 reason 文本", () => {
  // 这是为了防漂移：将来若有人改了 classify() 的 reason 命名（例如把
  // http-429 改成 rate-limited），状态码仍在，功能不该静默失效。
  assert.equal(shouldFallback({ reason: "whatever", status: 429 }), true);
  assert.equal(shouldFallback({ reason: "whatever", status: 503 }), true);
  // 但 2xx 不该触发（status 传进来时以它为准）。
  assert.equal(shouldFallback({ reason: "http-200", status: 200 }), false);
});

// ---------------------------------------------------------- 2. 可用性判断

test("未开启时不可用，原因是 off（界面据此显示「关闭」文案）", () => {
  const plan = backupPlanOf({ enabled: false, serverProvider: false, serverValue: undefined });
  assert.equal(plan.available, false);
  assert.equal(plan.blocked, "off");
});

test("「使用免费模型」已开时兜底无意义：原因是 primary-is-free", () => {
  // 那时免费模型**就是主模型**，失败了再拿同一份配置重问一遍毫无意义，
  // 只会让每次失败多打一次请求。
  const plan = backupPlanOf({
    enabled: true,
    serverProvider: true,
    serverValue: { baseUrl: "https://api.example.com/v1", key: "sk-x", model: "Kev-4B" },
  });
  assert.equal(plan.available, false);
  assert.equal(plan.blocked, "primary-is-free");
});

test("从未取到免费配置时不可用：原因是 no-config", () => {
  const plan = backupPlanOf({ enabled: true, serverProvider: false, serverValue: undefined });
  assert.equal(plan.available, false);
  assert.equal(plan.blocked, "no-config");
});

test("配置已过期时不可用：原因是 expired（与「从没取到」分开）", () => {
  // 两者排查方向完全不同：过期说明这台机器曾经工作过（查网络/服务端），
  // 从没取到更像「从没配对」。界面上必须能区分。
  const plan = backupPlanOf({
    enabled: true,
    serverProvider: false,
    serverValue: { baseUrl: "https://api.example.com/v1", key: "sk-x", model: "Kev-4B" },
    expired: true,
  });
  assert.equal(plan.available, false);
  assert.equal(plan.blocked, "expired");
});

test("下发的 baseUrl 非法时不可用：原因是 no-config（不拿坏地址去试）", () => {
  // 与 classify() 的 invalid-base-url 同一原则：宁可降级，也不打到一个
  // 猜出来的地址上——「静默 404」是本插件最难自查的故障。
  const plan = backupPlanOf({
    enabled: true,
    serverProvider: false,
    serverValue: { baseUrl: "ftp://nope.example.com/v1", key: "sk-x", model: "Kev-4B" },
  });
  assert.equal(plan.available, false);
  assert.equal(plan.blocked, "no-config");
});

test("开关打开、配置在有效期内且地址合法 → 可用", () => {
  const plan = backupPlanOf({
    enabled: true,
    serverProvider: false,
    serverValue: { baseUrl: "https://api.example.com/v1", key: "sk-x", model: "Kev-4B" },
  });
  assert.equal(plan.available, true);
  assert.equal(plan.blocked, "");
});

test("plan 里**永远不含明文 key**（它会被下发到界面与日志）", () => {
  const secret = "sk-BACKUP-CANARY-0123456789abcdef";
  const plan = backupPlanOf({
    enabled: true,
    serverProvider: false,
    serverValue: { baseUrl: "https://api.example.com/v1", key: secret, model: "Kev-4B" },
  });
  assert.equal(
    JSON.stringify(plan).includes(secret),
    false,
    "plan 的任何字段都不该带明文 key",
  );
});

test("畸形输入一律不抛，且退化成不可用", () => {
  for (const value of [undefined, null, {}, { enabled: "true" }]) {
    assert.doesNotThrow(() => backupPlanOf(value), `backupPlanOf(${String(value)}) 不该抛`);
    assert.equal(backupPlanOf(value).available, false);
  }
});

// ---------------------------------------------------------- 3. 预取余量

test("预取余量是个正的有穷毫秒数（临近过期要提前刷新）", () => {
  // 没有余量就会撞上「正好在过期窗口里失败 → 兜底不可用」。
  assert.equal(typeof BACKUP_REFRESH_MARGIN_MS, "number");
  assert.ok(Number.isFinite(BACKUP_REFRESH_MARGIN_MS) && BACKUP_REFRESH_MARGIN_MS > 0);
});
