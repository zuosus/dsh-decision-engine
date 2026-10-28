/**
 * 决策引擎的「错误可见化」通道：把一次降级/异常归到**具体哪一轮**，
 * 并让前端能在那条消息的尾部直接看到它。
 *
 * ## 为什么需要这一层
 *
 * 本插件的全部设计前提是 **fail-open**：决策模型挂了、地址错了、key 没配，
 * 一切都放行。这对「不打断用户」是对的，但对「用户能修」是错的——
 * 降级发生时界面上什么都不显示，用户只会觉得「这个插件好像没生效」。
 *
 * 宿主日志（`ctx.logger.warn`）能看见，但那是**另一个界面**（终端 / 日志文件），
 * 用户在聊天窗口里看不到；而统计页只给聚合数字，看不出「哪一轮出的问题」。
 *
 * 所以这里做一条**从错误到界面**的通路：
 *
 *   决策点出错 → 记一条「本轮的错误」（本模块的 `noteError`）
 *             → 宿主把错误写成一条会话事件（`decision-engine/error`）
 *             → 客户端的 conversation Definition 折叠出「这一轮有哪些错误」
 *             → `conversation.chat.turnTail` 槽位把它渲染在消息尾部
 *
 * ## 为什么走「会话事件」而不是 HTTP 接口
 *
 * 候选方案是让前端定期轮询 `/api/decision-engine/log`：
 *
 *   - 轮询拿不到「轮次」这一维。HTTP 接口知道错误发生在什么时刻，
 *     但**不知道那条错误属于哪一轮**——除非额外传一个 sessionId+turn，
 *     而前端并不知道当前界面正在显示第几轮（那是会话索引的内部结构）。
 *   - 轮询还有延迟与「历史错误反复出现在新消息尾部」的归属问题。
 *
 * 而会话事件自带 `turn` 字段，且**由会话索引按轮次归位**：
 * 客户端的 conversation 层会把同轮的事件折进同一个 Turn 的上下文里，
 * 前端拿到的就是「这一轮的错误列表」，天然不会张冠李戴。
 *
 * 这条通路还有一个附带好处：**会话被重放时错误跟着重放**。
 * 用户翻看历史对话时，那一轮当时的错误仍然显示在原处，
 * 而不是「现在的错误列表」里混着三天前的故障。
 *
 * ## 事件类型名与 `ignorable`
 *
 * 事件类型取 `decision-engine/error`——**不在** DSH 宿主的事件词表里。
 * 宿主的持久化读路径遇到不认识的事件类型时，只在事件带上
 * `ignorable: true` 标记时才肯跳过它（否则它无法判断「跳过这条会不会
 * 重建出一个错的会话」，宁可报错）。
 *
 * 这个标记由**宿主**在写日志时补上（见 `lib/index.js` 里的发布逻辑），
 * 不是插件能控制的事——所以本模块只管产出「这条错误是什么」，
 * 发布时怎么落盘是宿主的事。
 *
 * @module dsh-decision-engine/errors
 */

/**
 * 一次决策错误的展示文案。
 *
 * 字段刻意做得很窄：界面上只放「哪个点出了什么事」和「用户下一步该做什么」。
 * 端点、请求体、响应体这些都进遥测（`telemetry.jsonl`），不进界面——
 * 界面上放一整段 HTTP 响应会把消息尾部撑得很长，而用户真正要看的
 * 往往只是「API key 没配」这一句。
 */
export const ERROR_LABELS = {
  "invalid-base-url": "地址不合法",
  "no-key": "未配置 API key",
  cooldown: "端点连续失败，已进入冷却",
  timeout: "决策请求超时",
  "network-error": "无法连接决策端点",
  "auth-failed": "鉴权被拒",
  "rate-limited": "触发限流",
  "http-error": "端点返回错误状态",
  "invalid-json": "响应不是合法 JSON",
  "invalid-response": "响应格式不对",
  "missing-answers": "响应缺少 answers 字段",
  "answer-shape-mismatch": "答案形状与预期不符",
  "adapter-error": "适配器异常（已忽略）",
  "caller-aborted": "调用被取消",
};

/** 默认的错误分类顺序（界面按这个顺序渲染，便于同类聚集）。 */
export const ERROR_CODES = Object.keys(ERROR_LABELS);

/**
 * 把一次降级/异常归一化成一条可展示的错误。
 *
 * @param {object} input - 归一化输入。
 * @param {string} input.point - 决策点 id（`authorize` / `retrieval` …）。
 * @param {string} input.code - 错误分类（见 `ERROR_LABELS` 的键）。
 * @param {string} [input.detail] - 更细的说明（如具体的 HTTP 状态码）。
 * @param {string} [input.hint] - 给用户的修复建议。
 * @param {number} [input.turn] - 这次错误属于第几轮。
 * @param {string} [input.tool] - 触发这次错误的工具名。
 * @returns 归一化后的错误对象；`code` 不认识时归到 `adapter-error`。
 */
export function normalizeError(input) {
  const code = typeof input?.code === "string" && ERROR_LABELS[input.code] !== undefined
    ? input.code
    : "adapter-error";
  const text = (value, limit) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
  };
  return {
    point: typeof input?.point === "string" && input.point.length > 0 ? input.point : "unknown",
    code,
    label: ERROR_LABELS[code],
    ...(text(input?.detail, 120) === undefined ? {} : { detail: text(input.detail, 120) }),
    ...(text(input?.hint, 200) === undefined ? {} : { hint: text(input.hint, 200) }),
    ...(Number.isSafeInteger(input?.turn) && input.turn >= 0 ? { turn: input.turn } : {}),
    ...(text(input?.tool, 60) === undefined ? {} : { tool: text(input.tool, 60) }),
  };
}

/**
 * 每会话的错误账本：按轮次归拢本轮发生的错误。
 *
 * ## 为什么按轮次而不是按条
 *
 * 一轮里可能连续降级好几次（每个决策点各一次）。若每条都单独渲染，
 * 消息尾部会出现四五行几乎一样的红字，反而看不清「这一轮到底坏在哪」。
 *
 * 所以按 `turn` 归拢，**同一轮同一分类**只留一条（保留最后一条的说明），
 * 不同分类各占一行。这样一轮最坏情况是「每个决策点一行」，
 * 而实际上同一轮里出问题的通常只有一个点。
 *
 * ## 容量上限
 *
 * 账本是常驻内存的：会话可能跑很久，每轮都留一条会无界增长。
 * 因此只保留**最近若干轮**（默认 20 轮）——用户能回看的范围远小于此，
 * 而更早的错误仍在遥测文件里，需要时去查。
 */
export function createErrorLedger(options = {}) {
  const maxTurns = Math.max(1, options.maxTurns ?? 20);
  /** turn → Map<code, error>。同一轮同一分类只留一条。 */
  const byTurn = new Map();

  /**
   * 记一条错误。
   *
   * @param {object} error - 已归一化的错误。
   * @returns 归一化后的错误（便于调用方直接透传）。
   */
  function note(error) {
    const turn = Number.isSafeInteger(error?.turn) ? error.turn : undefined;
    if (turn === undefined) return error;
    let bucket = byTurn.get(turn);
    if (bucket === undefined) {
      bucket = new Map();
      byTurn.set(turn, bucket);
    }
    // 同一轮同一分类只留一条：后来的覆盖先来的（它通常带更具体的说明）。
    bucket.set(error.code, error);
    // 容量控制：只留最近 maxTurns 轮。Map 保持插入序，
    // 因此最早插入的那几轮就是最旧的。
    while (byTurn.size > maxTurns) {
      const oldest = byTurn.keys().next();
      if (oldest.done) break;
      byTurn.delete(oldest.value);
    }
    return error;
  }

  /**
   * 取某一轮的错误列表。
   *
   * @param {number} turn - 轮次号。
   * @returns 该轮的错误数组（按分类固定顺序）；没有则空数组。
   */
  function errorsOf(turn) {
    const bucket = byTurn.get(turn);
    if (bucket === undefined) return [];
    return ERROR_CODES.filter((code) => bucket.has(code)).map((code) => bucket.get(code));
  }

  /** 清空账本（会话结束 / 插件卸载时用）。 */
  function clear() {
    byTurn.clear();
  }

  return { note, errorsOf, clear };
}

/**
 * 从会话的事件流里读出「当前是第几轮」。
 *
 * ## 为什么需要它
 *
 * 有一类决策点的触发载荷里**没有**轮次号——`tools/pre-execute` 只给
 * 工具名、参数和 agent，没有 turn。而错误必须归到具体那一轮，
 * 否则前端挂不上（见 lib/publish.js）。
 *
 * 轮次号只能从会话日志里读：宿主的 `turn/start` 事件带着 `data.turn`，
 * 且**编号从 1 开始**（实测会话日志里第一轮就是 `"turn":1`）。
 * 往前找最近一条 `turn/start` 就是当前轮。
 *
 * 读不到时返回 undefined——那就不带轮次，错误只进遥测、不进界面。
 * 宁可界面上少显示一条，也不能把错误挂到**错误的**那条消息下面：
 * 那比不显示更糟（用户会照着一条假线索去排查）。
 *
 * @param {object} session - 宿主会话（有 `events` 数组）。
 * @returns 当前轮次号，或 undefined（读不到时）。
 */
export function currentTurnOf(session) {
  let events;
  try {
    events = session?.events ?? [];
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "turn/start") continue;
    const turn = event?.data?.turn;
    if (Number.isSafeInteger(turn) && turn >= 0) return turn;
  }
  return undefined;
}

/**
 * 从一段遥测记录里读出「这一轮的错误」，用于回填。
 *
 * 遥测文件里的记录没有 turn 字段（决策点当时不知道轮次），
 * 所以回填只覆盖**有 turn 的**记录——也就是本插件自己写的那些。
 *
 * @param {object} record - 一条遥测记录。
 * @returns 可展示的错误，或 null（这条不是错误 / 没有轮次）。
 */
export function errorFromTelemetry(record) {
  if (record === null || typeof record !== "object") return null;
  if (record.action !== "degraded") return null;
  if (!Number.isSafeInteger(record.turn) || record.turn < 0) return null;
  const detail = typeof record.detail === "string" ? record.detail : undefined;
  // adapter-error 是适配器自己记的，detail 固定是 "adapter-error"，
  // 真正的说明在 extra.message 里。
  const extra = record.extra !== null && typeof record.extra === "object" ? record.extra : undefined;
  const code = detail !== undefined && ERROR_LABELS[detail] !== undefined
    ? detail
    : detail === "adapter-error"
      ? "adapter-error"
      : undefined;
  if (code === undefined) return null;
  return normalizeError({
    point: typeof record.point === "string" ? record.point : "unknown",
    code,
    ...(detail === "adapter-error" && typeof extra?.message === "string" ? { detail: extra.message } : {}),
    ...(detail !== undefined && detail !== "adapter-error" ? { detail } : {}),
    turn: record.turn,
    ...(typeof record.tool === "string" ? { tool: record.tool } : {}),
  });
}
