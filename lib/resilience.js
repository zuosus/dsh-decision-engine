/**
 * 韧性策略：哪些失败值得重试、冷却如何退避、失败如何翻译给用户看。
 *
 * 为什么单独成一个模块
 * --------------------
 * 这个插件把每一次工具调用先发给远端「决策小模型」判断，决策端点是外部服务
 * （例如 https://api.bamboonode.dev/v1/decisions）。外部服务会超时、会断链、
 * 会自己报 500，而这些失败**不能**让主流程停摆——所以每次失败最终都会降级
 * （fail-open）。降级本身是对的，问题是降级之后用户只看到一句「决策失败」，
 * 完全不知道自己该改什么。
 *
 * 生产遥测里 358 次降级的构成（2026 年，真实数据）：
 *
 *   - timeout        83 次   卡在 8000ms 预算线上
 *   - network-error  84 次   fetch failed / ECONNRESET，多在 5004–5557ms 后失败
 *   - http-500       95 次   服务端自己报 Database error / Task request failed
 *   - cooldown       93 次   连续 3 次失败后 60s 内全部快速失败，是前几类的放大
 *
 * 关键实测规律（4 组独立实验一致）：服务端冷启动时首发要 7–16 秒；但**首发
 * 即使被超时掐断，也已经把服务端焐热了**，紧接着的第二发 1.1–1.7 秒必中。
 * 所以对 timeout / network-error 重试一次收益极大；而 4xx/5xx 重试毫无意义
 * （4xx 是配置错，5xx 是服务端故障，重试只是多烧额度）。本模块把这条规律
 * 固化成三个纯函数，让调用方不必各自记一遍。
 *
 * 为什么独立存在
 * --------------
 * 这里只有纯函数：不 import 任何东西、不读环境变量、不发网络请求、不读时钟
 * （时间由调用方传入，连 `Date.now()` 都没有）。因此它可以被裸 Node 直接
 * 单测（见 test/resilience.test.js），不需要拉起插件运行时、不需要 node_modules。
 *
 * @module dsh-decision-engine/resilience
 */

/**
 * 值得重试的失败原因（冻结，防止调用方就地改写）。
 *
 * 只包含两类「重试真能变好」的失败：
 *   - `timeout`：冷启动首发被掐断时，服务端已经被唤醒，第二发通常 1–2 秒返回。
 *   - `network-error`：连接层的瞬时抖动（ECONNRESET / fetch failed）重发一次
 *     常常就通了。
 *
 * 刻意**不包含** http-5xx：那是服务商侧故障，重试只会多烧一次额度；也不包含
 * 任何 4xx：地址、模型名、密钥配错了，重试一千次还是同样的错。
 *
 * @type {ReadonlyArray<string>}
 */
export const RETRYABLE_REASONS = Object.freeze(["timeout", "network-error"]);

/**
 * 判断一个降级原因是否值得重试。
 *
 * 只做精确匹配，不做大小写归一：reason 是插件内部生成的审计字段（`timeout`、
 * `http-500` …），大小写写错说明调用方拿错了字段，静默纠正反而会掩盖 bug。
 *
 * @param {unknown} reason - 降级原因（通常来自遥测的 reason 字段）。
 * @returns {boolean} 是否属于 {@link RETRYABLE_REASONS}。
 */
export function isRetryableReason(reason) {
  return typeof reason === "string" && RETRYABLE_REASONS.includes(reason);
}

/**
 * 判断「刚失败的那一次」之后还要不要再打一次。
 *
 * `attempt` 是**刚失败那次**的 0 基序号（第一次请求 attempt=0），因此重试条件
 * 写成 `attempt + 1 < maxAttempts`：maxAttempts 是总尝试次数上限，含首发。
 *
 * 预算判断用 `elapsedMs < maxBudgetMs`（严格小于）：预算已经用满时再发一次，
 * 只会在调用方等不到结果之后才失败，等于把一次失败拖成一次更慢的失败。注意
 * 这里看的是**整轮已耗时**，不是单次 timeout——单次超时预算再大，整轮预算也
 * 可能已经耗尽。
 *
 * 参数缺失或类型不对一律返回 false，绝不抛错：这个函数在失败路径上被调用，
 * 它自己再抛异常会把「降级」变成「崩溃」，比不重试严重得多。
 *
 * @param {object} options - 判断所需的全部输入（全部由调用方传入，本函数不读时钟）。
 * @param {string} options.reason - 刚失败的降级原因。
 * @param {number} options.attempt - 刚失败那次的 0 基序号。
 * @param {number} options.elapsedMs - 整轮已耗时（毫秒）。
 * @param {number} [options.timeoutMs] - 单次请求的超时预算；仅为让调用方把同一次
 *   请求的时序参数原样传进来而保留，**不参与判断**（见上：重试看的是整轮预算）。
 * @param {number} options.maxAttempts - 总尝试次数上限（含首发）。
 * @param {number} options.maxBudgetMs - 整轮时间预算（毫秒）。
 * @returns {boolean} true 表示应该再打一次。
 */
export function shouldRetry(options) {
  try {
    if (options === null || typeof options !== "object") return false;
    const { reason, attempt, elapsedMs, maxAttempts, maxBudgetMs } = options;
    if (!isRetryableReason(reason)) return false;
    // attempt 必须是 0 基非负整数：负数或小数说明调用方把序号算错了。
    if (!Number.isInteger(attempt) || attempt < 0) return false;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return false;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
    if (!Number.isFinite(maxBudgetMs) || maxBudgetMs <= 0) return false;
    // 已经没有下一次了。
    if (attempt + 1 >= maxAttempts) return false;
    // 预算已经用完（等于也算用完）：再发一次只会更慢地失败。
    if (elapsedMs >= maxBudgetMs) return false;
    return true;
  } catch {
    // 例如调用方传了带 getter 的怪对象：失败路径上宁可放弃重试，也不能抛错。
    return false;
  }
}

/**
 * 计算第 `streak` 轮冷却应该等多久。
 *
 * 为什么不是固定 60s：遥测里 cooldown 有 93 次，是前三类失败的**放大**——
 * 连续 3 次失败后进入 60s 冷却，这 60s 内的每一次决策都快速失败。固定时长
 * 在服务端长时间故障时只会把「失败一次」放大成「失败一整分钟」。指数退避
 * 让连续故障时等待逐轮变长，服务端恢复后又能很快回到正常节奏；封顶则避免
 * 等待时间无限增长到用户以为插件坏了。
 *
 * 实现上**不加抖动**（no jitter）：本模块是纯函数，同一输入必须得到同一输出，
 * 否则没法单测，也没法在遥测里解释「这次为什么等了这么久」。
 *
 * 参数归一规则（契约里「非法输入返回 base」的落地方式）：
 *   - `baseCooldownMs` 不是正有限数 → 返回 0（base 本身不可用，不能把 NaN 传出去）。
 *   - `streak` 不是有限数（undefined / NaN / 字符串…）→ 按 1 处理，即返回 base。
 *   - `streak <= 0` → 按 1 处理；小数向下取整。
 *   - `maxCooldownMs` 不是正有限数 → 不封顶（但仍不会返回 Infinity）。
 *
 * @param {object} options - 退避参数。
 * @param {number} options.baseCooldownMs - 第一轮冷却时长（毫秒）。
 * @param {number} options.streak - 连续进入冷却的轮次，从 1 起。
 * @param {number} [options.maxCooldownMs] - 冷却时长上限（毫秒）。
 * @returns {number} 本轮应冷却的毫秒数。
 */
export function nextCooldownMs(options = {}) {
  const { baseCooldownMs, streak, maxCooldownMs } = options ?? {};
  const base =
    typeof baseCooldownMs === "number" && Number.isFinite(baseCooldownMs) && baseCooldownMs > 0
      ? baseCooldownMs
      : 0;
  if (base === 0) return 0;
  const rounds = typeof streak === "number" && Number.isFinite(streak) ? Math.max(1, Math.floor(streak)) : 1;
  const cap =
    typeof maxCooldownMs === "number" && Number.isFinite(maxCooldownMs) && maxCooldownMs > 0
      ? maxCooldownMs
      : Number.MAX_SAFE_INTEGER;
  let waitMs = base;
  for (let round = 1; round < rounds; round += 1) {
    if (waitMs >= cap) break;
    waitMs *= 2;
  }
  return Math.min(waitMs, cap);
}

/**
 * 从响应体或调用方给的字段里找服务商的请求 id。
 *
 * 为什么值得单独找：5xx 是服务商侧故障，本地配置改不了任何东西，**请求 id 是
 * 用户唯一能拿给服务商定位问题的抓手**。各家名字不同（实测 bamboonode 走
 * `x-oneapi-request-id`，SiliconFlow 走 `x-siliconcloud-trace-id`），所以这里
 * 用一组常见键名去匹配，而不是写死一家。
 *
 * @param {object} extra - describeFailure 的第二参数。
 * @returns {string} 找到的 id，找不到时为空串。
 */
function pickRequestId(extra) {
  const direct = typeof extra.requestId === "string" ? extra.requestId.trim() : "";
  if (direct.length > 0) return direct;
  const body = extra.body;
  const text = typeof body === "string" ? body : body !== null && typeof body === "object" ? safeJson(body) : "";
  if (text.length === 0) return "";
  const pattern =
    /(?:x-oneapi-request-id|x-siliconcloud-trace-id|request[_-]?id|trace[_-]?id)["']?\s*[:=]\s*["']?([A-Za-z0-9._:-]{4,})/i;
  const match = pattern.exec(text);
  return match === null ? "" : match[1];
}

/** 把对象安全地转成一行文本（循环引用或不可序列化时返回空串）。 */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * 抹掉文本里的审计字段与换行。
 *
 * 遥测里的 `risk=` / `p=` 是内部审计字段，用户看到只会困惑；服务商返回的错误体
 * 又常带换行，塞进一句 hint 会破坏排版。这里统一压成一行并去掉这两类字段。
 *
 * @param {unknown} value - 任意待展示文本。
 * @returns {string} 清洗后的文本（可能为空串）。
 */
function scrub(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b(?:risk|p)\s*=\s*[^\s,;&}]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 截取响应体摘要，供 5xx 的 hint 使用。
 *
 * @param {unknown} body - 服务商响应体（字符串或对象）。
 * @returns {string} 最长 300 字符的摘要，取不到时为空串。
 */
function bodyExcerpt(body) {
  const text = typeof body === "string" ? body : body !== null && typeof body === "object" ? safeJson(body) : "";
  const cleaned = scrub(text);
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

/**
 * 把降级原因翻译成给用户看的中文：一句标题 + 一句可执行的下一步。
 *
 * 为什么不能直接把 reason 抛给用户：遥测里的 reason（`timeout`、`http-500`、
 * `cooldown`…）是给机器看的审计字段，用户看到「http-500」并不知道该改什么。
 * 而这四类失败的**修复动作完全不同**：
 *
 *   - timeout         → 调大 timeoutMs 或关掉 thinkMode（服务冷启动）
 *   - network-error   → 查链路 / DNS / 代理（本机问题）
 *   - http-5xx        → 什么都不用改，找服务商（服务端故障）
 *   - cooldown        → 等冷却结束，别手动干预（保护机制）
 *
 * 混成一句「决策失败」等于让用户自己猜，这正是本模块存在的理由。
 *
 * 输出约束：title 与 hint 里不出现审计字段名（`risk=`、`p=`）和裸小数，
 * 也不出现毫秒级的小数延迟——这些是日志语言，不是用户语言。
 *
 * @param {unknown} reason - 降级原因，如 `timeout` / `http-500` / `cooldown`。
 * @param {object} [extra] - 可选上下文。
 * @param {string} [extra.message] - 网络层原始错误信息（network-error 分支会附上）。
 * @param {string} [extra.requestId] - 服务商请求 id（5xx 分支优先使用）。
 * @param {string|object} [extra.body] - 服务商响应体（5xx 分支从中找请求 id 或作为摘要附上）。
 * @param {number} [extra.timeoutMs] - 本次超时预算（仅用于让提示更贴近现场）。
 * @returns {{ title: string, hint: string }} 中文标题与可执行提示。
 */
export function describeFailure(reason, extra = {}) {
  const info = extra !== null && typeof extra === "object" ? extra : {};
  const reasonText =
    typeof reason === "string" && reason.trim().length > 0
      ? reason.trim()
      : reason === undefined || reason === null
        ? "未知"
        : String(reason);

  if (reasonText === "timeout") {
    // 取整后再写进文案：给用户看的句子里不放裸小数。
    const budget =
      typeof info.timeoutMs === "number" && Number.isFinite(info.timeoutMs) && info.timeoutMs > 0
        ? `这次用的是 ${Math.round(info.timeoutMs)}ms 的预算。`
        : "";
    return {
      title: "请求超时",
      hint:
        `决策请求在超时预算内没有返回。${budget}这是服务端冷启动的典型表现：服务刚被唤醒时首发通常要 7–16 秒，` +
        `但这次超时的请求已经把服务端焐热，紧接着重发一次通常 1–2 秒内就能返回。` +
        `可以把 timeoutMs 调大（默认 20000），或把 thinkMode 设为 never 让服务端跳过思考阶段。`,
    };
  }

  if (reasonText === "network-error") {
    const detail = scrub(info.message);
    return {
      title: "网络连接失败",
      hint:
        `请求没有到达服务端（fetch failed / ECONNRESET 一类，实测多在 5004–5557ms 后失败）。` +
        `这通常是本机链路、DNS 或代理问题，与服务商的模型配置无关：先确认能否直连该端点，` +
        `如果本机必须走系统代理，用 NODE_USE_ENV_PROXY=1 让 Node 读取代理环境变量。` +
        (detail.length > 0 ? `底层错误：${detail}` : ""),
    };
  }

  const statusMatch = /^http-(\d{3})$/i.exec(reasonText);
  const status = statusMatch === null ? undefined : Number(statusMatch[1]);
  if (status !== undefined && status >= 500 && status <= 599) {
    const requestId = pickRequestId(info);
    const excerpt = bodyExcerpt(info.body);
    const cause =
      `决策服务端自己返回了错误（HTTP ${status}）。这是服务商侧的故障（例如 Database error / ` +
      `Task request failed），本地配置无需改动；重试也不会变好，只会多烧一次额度。`;
    const hint =
      requestId.length > 0
        ? `${cause}请求 id：${requestId}，把它提供给服务商，他们可以据此定位这次请求。`
        : excerpt.length > 0
          ? `${cause}这次没拿到请求 id，请联系服务商并附上响应体：${excerpt}`
          : `${cause}这次没拿到请求 id，请联系服务商并附上响应体与发生时间。`;
    return { title: "服务端内部错误", hint };
  }

  if (reasonText === "cooldown") {
    return {
      title: "冷却中",
      hint:
        `前几次失败已经触发了冷却保护，冷却期间不再向服务端发请求，以免连续失败把额度烧光。` +
        `冷却结束后会自动恢复，不需要手动操作；如果冷却反复出现，先按上一次失败的原因排查（超时、网络或服务端故障）。`,
    };
  }

  // 其余原因（http-4xx、auth-failed、no-key、invalid-json 等）：保留 reason 原文，
  // 它是用户搜文档、贴给服务商时唯一能对上的标识。
  return {
    title: "请求失败",
    hint:
      `决策请求没有成功（原因：${reasonText}）。请检查端点地址、模型名与 API key 是否匹配：` +
      `地址要指向决策接口，模型名要与该服务商可用列表一致，密钥要与服务商对应。` +
      `修正后重试一次；如果这个原因持续出现，把原因和端点地址一起反馈给服务商。`,
  };
}
