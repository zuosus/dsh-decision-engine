/**
 * 免费模型兜底（backup model）的判断层。
 *
 * ## 它解决什么
 *
 * 用户配的是自己的决策服务（本地预设 / custom base URL），但插件还带一条
 * **免费通道**（`使用免费模型`，DEC-030/037/062：从授权服务下发地址、模型与
 * key）。这个开关让免费通道多一个角色：平时不用它，**只有当主模型出错时**
 * 才用它把那一次决策重问一遍。于是「我自己的额度用光了」不再等于「守卫
 * 整段静默失效」，也不等于要为此把主通道切到免费（那会改变常态成本）。
 *
 * 默认**关闭**：它会在失败时多打一次网络请求，而且要求插件提前去取免费
 * 配置。这与 DEC-062「不替用户改开关」是同一条约束——升级不能悄悄多出
 * 网络行为。
 *
 * ## 为什么判断单独成一个模块
 *
 * 与 `endpoint-fallback.js` / `resilience.js` / `server-config.js` 同一分层：
 * 这里只有**纯函数**（不 import 任何东西、不读环境变量、不发网络请求、不读
 * 时钟），因此可以在裸 Node 下直接单测。真正的接线（什么时候发请求、拿什么
 * 配置）留在 `lib/index.js` 的 `StartluxClient` 里。
 *
 * ## 两个判断，各自对应一条承诺
 *
 *   1. `shouldFallback()`：**哪些失败值得换一次兜底**；
 *   2. `backupPlanOf()`  ：**兜底此刻到底可不可用**（不可用时要说得出原因）。
 *
 * @module dsh-decision-engine/backup-model
 */

/**
 * 临近过期时提前刷新的余量（毫秒）。
 *
 * 为什么需要它：下发配置带 TTL（默认 600 秒）。若只在「已过期」时才刷新，
 * 就会出现「失败恰好发生在过期窗口里 → 兜底不可用」——而那正是最需要它的
 * 时刻。留 2 分钟余量：足够覆盖一次慢刷新（实测下发接口慢时可到 ~7 秒），
 * 又短到不会让每次决策都去刷配置。
 *
 * @type {number}
 */
export const BACKUP_REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * 触发兜底的失败原因。
 *
 * 集合的边界就是本功能的语义边界，两个方向都有代价：
 *
 * **必须包含**（用户会遇到的「这家模型/账号此刻不能用」）：
 *   - `http-4xx` 全族：429 额度不足 / 402 欠费 / 400 请求不合法 / 404 路径错。
 *   - `http-5xx` 全族：服务商侧故障。
 *   - `auth-failed`：classify() 把 401/403 单列成这一类（「key 不对」而不是
 *     「地址不对」）。**换一套 key 正是兜底的意义**，漏掉它等于功能对
 *     「key 失效」这个最常见场景不生效。
 *   - `invalid-json` / `invalid-response` / `missing-answers`：端点活着但没给出
 *     可用答案——用户同样拿不到裁决。
 *
 * **必须排除**：
 *   - `timeout` / `network-error`：它们已有专门的冷启动重试（见
 *     `resilience.js` 顶部：首发被超时掐断时服务端已被焐热，第二发 1–2 秒
 *     必中）。再叠一次兜底会把单次决策的最坏等待从 2×timeout 抬到 3×timeout，
 *     而换一家服务商并不解决本机链路问题。
 *   - `caller-aborted`：调用方已经不想要这次决策了，兜底等于无视取消。
 *   - `cooldown`：本地保护机制，不是「模型不可用」。
 *   - `invalid-base-url` / `no-key`：发生在**发出请求之前**的本地配置问题，
 *     换兜底 provider 并不能修复「你填的地址不合法」。
 *
 * @type {ReadonlyArray<string>}
 */
export const BACKUP_TRIGGER_REASONS = Object.freeze([
  "auth-failed",
  "invalid-json",
  "invalid-response",
  "missing-answers",
]);

/**
 * 这次失败是否值得换兜底再试一次。
 *
 * 判定顺序刻意是「状态码优先，reason 兜底」：状态码是硬事实，而 reason 的
 * 命名可能随重构漂移（例如 `http-429` 将来若改名，功能不该静默失效）。
 *
 * @param options - `{ reason, status }`（`status` 可缺省）。
 * @returns 是否触发兜底。任何畸形输入都返回 false，绝不抛错——它在热路径上。
 */
export function shouldFallback(options) {
  if (options === null || typeof options !== "object") return false;
  const status = typeof options.status === "number" && Number.isFinite(options.status)
    ? options.status
    : undefined;
  // 状态码是硬事实：4xx/5xx 一律触发，2xx 一律不触发（那是别的问题）。
  if (status !== undefined) {
    if (status >= 400 && status <= 599) return true;
    if (status >= 200 && status < 300) return false;
  }
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (reason.length === 0) return false;
  // 没有状态码时按 reason 前缀/白名单判断：http-4xx / http-5xx 与已知原因。
  if (/^http-[45]\d\d$/.test(reason)) return true;
  return BACKUP_TRIGGER_REASONS.includes(reason);
}

/**
 * 兜底此刻可不可用，不可用时为什么。
 *
 * 四道闸，任何一道不过都返回 `available: false` 并给出 `blocked` 原因——
 * 「为什么这次没兜底」是用户最会问的那句话，界面上必须能直接显示。
 *
 * @param options - `{ enabled, serverProvider, serverValue, expired }`：
 *   - `enabled`：用户是否打开了兜底开关（`cfg.backupModel`）；
 *   - `serverProvider`：`使用免费模型` 是否也开着；
 *   - `serverValue`：此刻生效的下发值（含**明文 key**，只在本进程内存里）；
 *   - `expired`：下发值是否已过期（调用方按 `usable()` 判定）。
 * @returns `{ available, blocked }`：`blocked` 为 `""` 表示可用，否则是
 *   `off` / `primary-is-free` / `no-config` / `expired` 之一。
 */
export function backupPlanOf(options) {
  const off = (blocked) => ({ available: false, blocked });
  if (options === null || typeof options !== "object") return off("off");
  // 只认严格的 true：「true」字符串或 1 落盘后会让界面显示开、实际不走兜底。
  if (options.enabled !== true) return off("off");

  // 免费模型**已经是主模型**了，失败后再拿同一份配置重问一遍毫无意义，
  // 只会让每次失败多打一次请求。不自动替用户关掉任何开关（DEC-062），
  // 只如实报出这个状态。
  if (options.serverProvider === true) return off("primary-is-free");

  const value = options.serverValue;
  if (value === null || typeof value !== "object") return off("no-config");
  // 地址必须是 http/https：宁可降级，也不打到一个猜出来的地址上——
  // 「静默 404」是本插件最难自查的故障（见 classify 的 invalid-base-url 分支）。
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) return off("no-config");
  // key 同理：没有 key 的配置只会换来一次 401，而 401 又会再触发一次兜底
  // 判定 —— 直接把「没 key」当成不可用，别去发那个注定失败的请求。
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (key.length === 0) return off("no-config");
  // 过期判定放在最后：它只在「本来可用」的配置上才有意义，
  // 也避免把一份从没取到的配置说成「已过期」（两者排查方向不同）。
  if (options.expired === true) return off("expired");

  // 返回体**绝不含 key**：这个对象会被下发到界面与日志（见 lib/index.js 的
  // statusPayload）。这里只回答「能不能用、为什么不能」。
  return { available: true, blocked: "" };
}
