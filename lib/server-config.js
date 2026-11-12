/**
 * 服务端下发的 provider 配置源（DEC-030）。
 *
 * 为什么需要这一层：
 *
 * 用户的地址与 key 此前只能来自本地 config.yml / .credentials.yaml。团队或
 * 企业部署时，管理员希望「一处改、所有客户端下次刷新即生效」，而不是逐个
 * 指导用户改配置。授权服务因此额外下发一份 provider 配置（地址、模型、
 * 端点风格、key），本模块负责把它取回来、校验、缓存在内存里并给出状态。
 *
 * 三条设计红线：
 *
 *   1. **不落盘**。本模块只在内存里放值：缓存是易失的，进程结束即消失，
 *      服务端下发的明文 key 属于服务端账号，不该在用户机器上留下副本。
 *      因此这里不读也不写任何持久化文件（连读取都交给调用方注入）。
 *   2. **绝不抛错**。`refresh()` 是热路径上的后台动作，任何失败只能降级成
 *      「状态变了」；守卫是 fail-open 的，把异常抛进调用方等于静默失效。
 *   3. **绝不外泄 key**。`status()` 会进日志与界面，只给 keyHint（末四位）；
 *      明文只在 `value()` 里，调用方拿到后直接用于请求头。
 *
 * @module dsh-decision-engine/server-config
 */

import { ENDPOINT_STYLES, validateBaseUrl } from "./providers.js";

/** 授权服务的配置下发端点。换地址只改这一处。 */
export const SERVER_CONFIG_ENDPOINT = "https://dsh.zuos.us/api/provider-config";

/** 未给 ttl 时的缓存时长（10 分钟）：够久到不必频繁请求，也够短到改动能及时生效。 */
export const DEFAULT_TTL_SECONDS = 600;

/** TTL 下限：太短会让每次工具调用都去刷配置，把网络往返加到决策热路径上。 */
export const MIN_TTL_SECONDS = 60;

/** TTL 上限：太长会让管理员改完服务端配置后，用户一小时内看不到变化。 */
export const MAX_TTL_SECONDS = 3600;

/** 单次请求超时：配置下发是后台动作，不能让一个卡住的连接拖住决策路径。
 *  实测 dsh.zuos.us 下发接口在慢时会到 ~7s，原来 5s 会被判超时并静默回落到本地配置，
 *  因此放宽到 15000ms 以容纳慢响应。仍是后台动作，失败只降级、不阻塞决策路径。 */
export const REQUEST_TIMEOUT_MS = 15000;

/** 失败重试下限：网络抖动时不必每次调用都补一发，30 秒后自然恢复重试。 */
export const RETRY_FLOOR_MS = 30000;

/**
 * 超时检查的轮询间隔（模块私有，不导出）。
 *
 * 为什么不是「一次 setTimeout(5000) 就完事」：超时必须能被注入的 clock
 * 观测到，否则测试要么真的等满 5 秒，要么根本覆盖不到超时路径。这里每
 * 50ms 检查一次「注入 clock 或真实时间」是否越界——生产环境两者同步前进，
 * 行为与单个 5 秒定时器一致。
 */
const TIMEOUT_POLL_MS = 50;

/**
 * 校验并归一服务端下发的配置体。
 *
 * 纯函数，任何输入都不抛错：下发内容来自网络，形状完全不可信。
 * 整笔拒绝（而不是逐字段兜底）只用在「兜底会猜错方向」的地方——
 * `endpointStyle` 非法时静默改成 auto，会去猜一条路径，猜错就是一次 404，
 * 而 404 在本插件里表现为静默失效；宁可这一笔配置不生效。
 *
 * @param value - 解析后的 JSON 体（任意类型）。
 * @returns `{ ok: true, value }` 或 `{ ok: false, error }`（中文，可直接展示）。
 */
export function parseServerConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "服务端配置不是 JSON 对象" };
  }
  if (value.ok !== true) {
    return { ok: false, error: "服务端配置未标记为成功（ok 不是 true）" };
  }
  // 版本号只做等值判断，刻意不回显原值：错误文案会进日志，回显等于把
  // 一个未校验的字段（万一它就是 key）原样抄进日志。
  if (value.v !== 1) {
    return { ok: false, error: "不支持的服务端配置版本（期望 1）" };
  }
  const checked = validateBaseUrl(value.baseUrl);
  if (!checked.ok) {
    return { ok: false, error: `服务端下发的 base URL 不可用：${checked.error}` };
  }
  // key 缺失或全是空白时整笔拒绝：没有 key 的配置只会换来一次 401，
  // 反而不如让上层继续用本地配置。
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (key.length === 0) {
    return { ok: false, error: "服务端配置缺少 API key" };
  }
  // model 允许空串：它表示「省略 model 字段、由服务端回填默认模型」，与本地
  // provider 的语义一致（见 providers.js 的 buildRequestBody）。
  const model = typeof value.model === "string" ? value.model.trim() : "";
  let endpointStyle = "auto";
  if (value.endpointStyle !== undefined) {
    if (!ENDPOINT_STYLES.includes(value.endpointStyle)) {
      return { ok: false, error: "服务端下发的 endpointStyle 不是合法取值" };
    }
    endpointStyle = value.endpointStyle;
  }
  // TTL 只影响本地缓存时长，写偏了不值得整笔拒绝：夹到 [下限, 上限] 即可。
  // 但类型不对（字符串、NaN、Infinity）无法猜出意图，按缺省处理。
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (value.ttlSeconds !== undefined) {
    if (typeof value.ttlSeconds !== "number" || !Number.isFinite(value.ttlSeconds)) {
      return { ok: false, error: "服务端下发的 ttlSeconds 不是有穷数字" };
    }
    ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, value.ttlSeconds));
  }
  return { ok: true, value: { baseUrl: checked.value, model, endpointStyle, key, ttlSeconds } };
}

/**
 * 一次失败的可展示文案。
 *
 * 只保留一行并截断：异常消息可能带换行（响应体片段），原样进日志会把
 * 日志刷爆。注意调用方只会把它用在**自家生成的固定文案**或运行时错误上，
 * 解析响应体的原文一律不从这里透出（见 `#request`）。
 */
function describeError(err) {
  const raw = err instanceof Error && typeof err.message === "string" ? err.message : "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 200) : "未知错误";
}

/**
 * 服务端配置的内存缓存源。
 *
 * 生命周期：`refresh()` 取回值（失败保留未过期的旧值）→ 上层在 `usable()`
 * 期间直接用 `value()` 里的地址与 key → 过期后 `status()` 变为 error，
 * 上层回落到本地 provider。
 */
export class ServerConfigSource {
  #endpoint;
  #token;
  #fetchImpl;
  #clock;
  #logger;

  #value;
  #error = "";
  #fetchedAt = 0;
  #expiresAt = 0;
  #lastAttemptAt = 0;
  #attempted = false;
  #inFlight = null;
  /** 换代号：clear() 时自增，用来丢弃「清空之前发出、之后才返回」的在途结果。 */
  #generation = 0;
  #warned = false;

  /**
   * @param options.endpoint - 配置下发地址，默认 SERVER_CONFIG_ENDPOINT。
   * @param options.token - 下发的鉴权令牌（可选，非空时作为 x-provider-token 发送）。
   * @param options.fetchImpl - 注入的 fetch；缺省时**调用时**才取 globalThis.fetch，
   *   这样测试可以在构造之后再打桩（见 test/server-config.test.js）。
   * @param options.clock - 注入的时钟，默认 `Date.now`。
   * @param options.logger - 注入的日志器（只用 `warn`）。
   */
  constructor({ endpoint, token, fetchImpl, clock, logger } = {}) {
    const configured = typeof endpoint === "string" ? endpoint.trim() : "";
    this.#endpoint = configured.length > 0 ? configured : SERVER_CONFIG_ENDPOINT;
    this.#token = typeof token === "string" ? token.trim() : "";
    this.#fetchImpl = typeof fetchImpl === "function" ? fetchImpl : undefined;
    this.#clock = typeof clock === "function" ? clock : Date.now;
    this.#logger = logger;
  }

  /** 有值且尚未过期。上层据此决定「用服务端下发」还是「回落到本地配置」。 */
  usable() {
    if (this.#value === undefined) return false;
    return this.#clock() < this.#expiresAt;
  }

  /**
   * 原始配置值（**只有它含明文 key**）；从未取到或被 clear() 后为 undefined。
   *
   * 刻意在过期后仍返回旧值：状态展示要用它回显「上一份是什么」，而
   * 「能不能用」由 usable() 单独回答。调用方必须先用 usable() 过滤。
   */
  value() {
    return this.#value;
  }

  /**
   * 供界面/日志使用的状态快照，**任何路径都不含明文 key**。
   *
   * 状态判定顺序即优先级：在途 → loading（旧值仍可用时也报 loading，
   * 因为调用方更关心「正在刷新」）；可用 → ready；有失败原因 → error；
   * 只剩「有值但过期」→ error 并补一句可展示的过期文案；否则 idle。
   */
  status() {
    const hasValue = this.#value !== undefined;
    const usable = this.usable();
    const expired = hasValue && !usable;
    // 过期文案是**算出来的**，不写回 #error：否则它会一直留在内存里，
    // 下一次刷新成功时还得专门记得擦掉它。
    let error = this.#error;
    if (error === "" && expired) error = "服务端配置已过期";
    const status = this.#inFlight !== null
      ? "loading"
      : usable
        ? "ready"
        : error !== ""
          ? "error"
          : "idle";
    return {
      status,
      usable,
      error,
      // 末四位是「够确认是哪把 key」与「不能反推出 key」之间的折中。
      keyHint: hasValue ? `…${this.#value.key.slice(-4)}` : "",
      baseUrl: hasValue ? this.#value.baseUrl : "",
      model: hasValue ? this.#value.model : "",
      endpointStyle: hasValue ? this.#value.endpointStyle : "",
      fetchedAt: this.#fetchedAt,
      expiresAt: this.#expiresAt,
      expired,
    };
  }

  /**
   * 取一次服务端配置。**绝不抛错**：失败只体现在返回值与 status() 上。
   *
   * @param options.force - 忽略失败重试下限（用户手动点「刷新」时用）。
   * @returns `{ ok, error }`；ok 为 true 时 error 为 ""。
   */
  async refresh(options = {}) {
    const force = options?.force === true;
    // 并发去重：已有在途请求就直接复用它的 promise，同一时刻只打一发。
    // 这里必须在任何 await 之前完成赋值，否则同一 tick 的两次调用会各打一发。
    if (this.#inFlight !== null) return this.#inFlight;
    const now = this.#clock();
    // 失败重试下限：刚失败过就不再打，避免服务端故障时每次决策都补一发请求。
    if (!force && this.#attempted && now - this.#lastAttemptAt < RETRY_FLOOR_MS) {
      return { ok: false, error: "retry-floor" };
    }
    const generation = this.#generation;
    const run = this.#run(generation);
    this.#inFlight = run;
    // 收尾统一走 finally：错误路径也不能让 #inFlight 永久占位，否则后续
    // 刷新会一直复用一个已经结束的 promise（表现为「再也不刷新」）。
    void run.finally(() => {
      if (this.#inFlight === run) this.#inFlight = null;
    });
    return run;
  }

  /** 清空全部内存字段（用户主动断开服务端下发时用）。 */
  clear() {
    this.#generation += 1;
    this.#value = undefined;
    this.#error = "";
    this.#fetchedAt = 0;
    this.#expiresAt = 0;
    this.#lastAttemptAt = 0;
    this.#attempted = false;
    this.#inFlight = null;
  }

  /** 一次刷新的完整流程：取数 → 落状态。绝不 reject。 */
  async #run(generation) {
    let value;
    try {
      value = await this.#request();
    } catch (err) {
      // clear() 已换代：这次失败不该污染新状态（否则清空后状态会显示 error）。
      if (generation !== this.#generation) return { ok: false, error: "cleared" };
      // 失败**不改 #value**：未过期的旧值仍然可用，比「一失败就没配置」好得多。
      this.#attempted = true;
      this.#lastAttemptAt = this.#clock();
      this.#error = describeError(err);
      this.#warn(`服务端配置刷新失败（端点 ${this.#endpoint}）：${this.#error}`);
      return { ok: false, error: this.#error };
    }
    // clear() 之后才返回的结果属于上一代，直接丢弃，否则「清空」会看起来没生效。
    if (generation !== this.#generation) return { ok: false, error: "cleared" };
    const now = this.#clock();
    this.#value = value;
    this.#fetchedAt = now;
    this.#expiresAt = now + value.ttlSeconds * 1000;
    this.#error = "";
    // 刻意**不**更新 #lastAttemptAt：它是「失败重试下限」的锚点，成功之后
    // 没有理由让紧接着的一次刷新被自己的下限挡住。
    return { ok: true, error: "" };
  }

  /** 真正的网络请求：超时、状态码、JSON、字段校验全部在这里收敛成异常。 */
  async #request() {
    const controller = new AbortController();
    let timer;
    // 超时用「与 fetch 赛跑」而不是只给 abort signal：真实 fetch 收到 abort
    // 会立刻 reject，但测试桩（永不 resolve）不会，赛跑保证任何实现下
    // refresh 都会在 REQUEST_TIMEOUT_MS 后返回，而不是永远挂着。
    const timeout = new Promise((_, reject) => {
      const clockDeadline = this.#clock() + REQUEST_TIMEOUT_MS;
      const realDeadline = Date.now() + REQUEST_TIMEOUT_MS;
      const tick = () => {
        // 任一「时钟」越界即超时：注入 clock 让测试可以毫秒级覆盖超时路径，
        // 真实时间兜底保证即使 clock 被冻结也一定会返回。
        if (this.#clock() >= clockDeadline || Date.now() >= realDeadline) {
          controller.abort();
          reject(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）`));
          return;
        }
        timer = setTimeout(tick, TIMEOUT_POLL_MS);
      };
      timer = setTimeout(tick, TIMEOUT_POLL_MS);
    });
    try {
      // 惰性解析：测试要在**构造之后**替换 globalThis.fetch 来模拟各种失败。
      const fetchImpl = this.#fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有可用的 fetch");
      const headers = { accept: "application/json" };
      if (this.#token.length > 0) headers["x-provider-token"] = this.#token;
      const response = await Promise.race([
        fetchImpl(this.#endpoint, { method: "GET", headers, signal: controller.signal }),
        timeout,
      ]);
      const httpStatus = Number(response?.status ?? 0);
      if (!(httpStatus >= 200 && httpStatus < 300)) {
        // 只报状态码，不回显响应体：失败响应里可能就带着 key。
        throw new Error(`服务端返回 HTTP ${httpStatus}`);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        // 固定文案：JSON 解析错的原文会带响应体片段，而响应体正是 key
        // 可能出现的地方——错误文案会进日志与 status()，不能从这里漏。
        throw new Error("服务端响应不是合法 JSON");
      }
      const parsed = parseServerConfig(body);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 一次告警：同一实例只提示一次，避免后台反复失败把日志刷爆
   * （与 lib/telemetry.js 的 #warn 同思路）。日志里只有状态与端点，没有 key。
   */
  #warn(message) {
    if (this.#warned) return;
    this.#warned = true;
    try {
      this.#logger?.warn?.(`dsh-decision-engine: ${message}`);
    } catch {
      // 日志器是外部注入的，它抛错不能反过来把刷新流程打挂。
    }
  }
}