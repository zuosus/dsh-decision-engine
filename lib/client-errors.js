/**
 * 决策引擎的错误在**消息尾部**的呈现（客户端侧）。
 *
 * ## 为什么挂在 `conversation.chat.turnTail`
 *
 * DSH 的聊天界面把「一条助手消息的尾部」做成一个**可扩展的槽位**：
 * `conversation.chat.turnTail`。它是一张「列表型」槽位：每个插件注册
 * 一个条目（用自己的 `id`），宿主按 `order` 排好序，逐个渲染，
 * 没有内容的条目返回 null 就不占位。
 *
 * 这正是用户看到「token 统计在每条消息后面」所用的那类位置——内置的
 * `TurnUsagePanel` 与其它插件的卡片都落在这条链路上。
 *
 * 我们选它而不是自己画浮层，因为：
 *
 *   - 位置是宿主给的，我们不跟它抢布局；
 *   - 它**只对已完成的轮次**渲染，天然就是「这条消息的尾部」；
 *   - 宿主负责 hover / 显隐等交互，我们只管内容。
 *
 * ## 数据从哪来
 *
 * 宿主把每次降级写进会话（事件 `decision-engine/error`，带 `turn`）。
 * 客户端这边由一个 conversation Definition 接住这些事件，折叠成
 * 「这一轮有哪些错误」，通过 `buildLocationData` 发布成**轮次数据**。
 *
 * 然后 turnTail 的组件用 `owner.turn.data.get("decision-engine-error")`
 * 读回自己那一轮的数据——**按轮次取**，所以不会出现「A 轮的错误挂到
 * B 轮消息下面」这种张冠李戴。
 *
 * 这条链路与 DSH 自带的 `llm/retry` 完全同构（宿主 append 事件 →
 * 客户端 Definition 折叠 → 槽位读取），只是事件名与内容不同。
 *
 * @module dsh-decision-engine/client-errors
 */

/**
 * 本插件发布到会话的错误事件类型（必须与宿主 lib/publish.js 一致）。
 *
 * `plugin:` 前缀是宿主的插件记录语法：这类事件自带 `ignorable` 标记，
 * 不认识它的旧版 DSH 会保留并跳过，而不是拒绝打开会话。
 */
export const ERROR_EVENT_TYPE = "plugin:decision-engine/error";

/** 轮次数据的键名（必须与 Definition 的 `key` 一致）。 */
export const TURN_DATA_KEY = "decision-engine-error";

/**
 * 错误分类 → 中文名。
 *
 * 与宿主 lib/errors.js 的 `ERROR_LABELS` 保持一致。这里独立写一份是
 * 因为客户端 bundle 是独立的加载单元（`window.__ModuleLoader__`），
 * 拿不到服务端的模块——两份清单必须同步，改一处就要改另一处。
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

/** 决策点 id → 中文名（用于「哪个点坏了」）。 */
export const POINT_LABELS = {
  authorize: "工具授权",
  route: "模型路由",
  delegate: "子任务分派",
  compact: "上下文压缩",
  turnStop: "轮次延续",
  retrieval: "检索必要性",
  skillPick: "技能选择",
  cotTranslate: "思维链翻译",
  unknown: "决策引擎",
};

/**
 * 把一条宿主事件归一化成可展示的错误。
 *
 * @param {object} event - 会话事件。
 * @returns 归一化后的错误，或 null（这条不是错误事件）。
 */
export function errorFromEvent(event) {
  if (event === null || typeof event !== "object") return null;
  if (event.type !== ERROR_EVENT_TYPE) return null;
  const data = event.data;
  if (data === null || typeof data !== "object") return null;
  const turn = data.turn;
  if (!Number.isSafeInteger(turn) || turn < 0) return null;
  const code = typeof data.code === "string" && ERROR_LABELS[data.code] !== undefined
    ? data.code
    : "adapter-error";
  return {
    turn,
    point: typeof data.point === "string" ? data.point : "unknown",
    code,
    label: ERROR_LABELS[code],
    ...(typeof data.detail === "string" && data.detail.length > 0 ? { detail: data.detail } : {}),
    ...(typeof data.hint === "string" && data.hint.length > 0 ? { hint: data.hint } : {}),
    ...(typeof data.tool === "string" && data.tool.length > 0 ? { tool: data.tool } : {}),
  };
}

/**
 * 建一个 conversation Definition：把错误事件折叠成「这一轮的错误」。
 *
 * ## 为什么用 Definition 而不是直接读会话事件
 *
 * Definition 是 conversation 层**官方**给插件的扩展位：它按事件类型
 * 匹配、维护每个轮次的上下文、并在轮次结束时把结果发布成轮次数据。
 * 自己订阅会话事件再自己归位，就得重做一遍「事件属于哪一轮」的判断——
 * 而那个判断错了，错误就会挂到别人的消息下面。
 *
 * @param {string} kind - Definition 的唯一名字。
 * @returns Definition 对象（传给 `ctx.uiConversation.events.register`）。
 */
export function createErrorDefinition(kind = TURN_DATA_KEY) {
  return {
    kind,
    target: "chat",
    /**
     * 匹配错误事件与轮次起点。
     *
     * `id` 用轮次号：同一轮里的多条错误要折进**同一个**上下文，
     * 否则每条错误各成一轮，界面上会出现一串重复卡片。
     *
     * **`turn/start` 必须匹配为 `start` 角色**：对话层要求每个上下文先有
     * 一个 start 匹配，之后才能收 update 匹配——只匹配错误事件（全是
     * update）会撞上「received an update before its start Match」而抛错。
     *
     * 轮次号也从这里取：`turn/start` 事件的 `data.turn` 是轮次号的
     * 唯一权威来源（会话事件自己带的 `data.turn` 只是我们写进去的副本）。
     */
    match: (event) => {
      if (event.type === "turn/start") {
        const turn = event.data?.turn;
        if (!Number.isSafeInteger(turn) || turn < 0) return null;
        return { id: String(turn), role: "start" };
      }
      const error = errorFromEvent(event);
      if (error === null) return null;
      return { id: String(error.turn), role: "update" };
    },
    /**
     * 该轮的错误列表的初值。
     *
     * 以 `turn/start` 为起点：轮次号从那时起才有意义。
     */
    start: (_context, match) => {
      const turn = Number(match.id);
      return { turn: Number.isSafeInteger(turn) ? turn : 0, errors: [] };
    },
    /**
     * 收进一条错误。
     *
     * 同一轮同一分类只留一条（保留最后一条的说明）——一轮里若多个决策点
     * 连续降级，逐条渲染会在消息尾部堆出四五行几乎一样的红字，
     * 反而看不清「这一轮到底坏在哪」。
     */
    update: (context, match) => {
      const error = errorFromEvent(match.event);
      if (error === null) return context.state;
      const errors = context.state.errors.filter((candidate) => candidate.code !== error.code);
      errors.push(error);
      return { ...context.state, errors };
    },
    /**
     * 把这一轮的错误发布成轮次数据，供 turnTail 读取。
     *
     * `previous` 不变时原样返回——宿主靠引用相等判断「没变」，
     * 每次都造新对象会让界面白白重渲染。
     */
    buildLocationData: (context, scope, previous) => {
      if (scope !== "turn" || context.state === undefined) return null;
      const errors = context.state.errors;
      if (previous?.kind === "turn" && previous.turn === context.state.turn && previous.key === TURN_DATA_KEY && previous.value.errors === errors) {
        return previous;
      }
      return {
        kind: "turn",
        turn: context.state.turn,
        key: TURN_DATA_KEY,
        value: { errors },
      };
    },
  };
}

/**
 * 从 turnTail 的 owner 里取出「这一轮的错误」。
 *
 * @param {object} owner - turnTail 槽位给的 owner（`turn` / `seq` / `openFile`）。
 * @returns 错误数组；没有则空数组。
 */
export function errorsOfTurn(owner) {
  const data = owner?.turn?.data?.get?.(TURN_DATA_KEY);
  const errors = data?.value?.errors;
  return Array.isArray(errors) ? errors : [];
}
