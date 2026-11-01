/**
 * 本轮判断计数与浮层明细的**纯逻辑**（客户端侧）。
 *
 * ## 为什么要有这份文件
 *
 * 逻辑要写**两遍**：一遍在 `lib/client.js`（客户端 bundle 里内联），一遍在这里。
 * 这不是偷懒——客户端 bundle 是独立的加载单元（`window.__ModuleLoader__`），
 * 它的 `require()` 只能拿到已注册的模块（react 等），拿不到同目录的兄弟文件。
 * 两者必须逐字同步，否则界面显示的数字与这里算出来的不一致，而**没有任何
 * 地方会报错**。
 *
 * 所以这份文件与 `lib/client-errors.js` 一样：既是 bundle 内联逻辑的**镜像**，
 * 也是测试唯一能直接 import 的对象。test/judgement-ui.test.js 会同时跑两遍
 * （一遍打在 bundle 上，一遍打在这里），保证两份不跑偏。
 *
 * ## 计数的口径
 *
 *   - 「判断」= 请求**真的到了端点**并拿回可用答案的一次决策模型调用，
 *     `observe` 与 `enforce` 都算。缓存命中不算（那一轮并没有真的判断）。
 *   - 降级（没 key / 超时 / 404 / 答案形状不符…）**不是**判断，单独进降级桶。
 *     它的意义是「这一轮试过但没拿到答案」——与「判断了几次」混在一个数字里，
 *     用户看到 3 就不知道其中 2 次其实什么都没决定。
 *   - 单位是**轮**（一次完整的回复），不是会话、也不是步。
 *
 * ## 为什么降级也要收进来
 *
 * 用户点开「3 次判断」想知道的是「决策引擎这一轮到底动了几次」。一次超时
 * 重试同样是引擎动了一次——只是没结果。把它丢掉会让数字看起来比实际小，
 * 而小得悄无声息正是这类报告最难发现的问题。
 *
 * @module dsh-decision-engine/client-judgements
 */

/**
 * 本插件发布到会话的判断事件类型（必须与 lib/judgements.js 一致）。
 *
 * `plugin:` 前缀是宿主的插件记录语法：这类事件自带 `ignorable` 标记，
 * 不认识它的旧版 DSH 会保留并跳过，而不是拒绝打开会话。
 */
export const JUDGEMENT_EVENT_TYPE = "plugin:decision-engine/judgement";

/** 轮次数据的键名（必须与 Definition 的 `key` 一致）。 */
export const TURN_DATA_KEY = "decision-engine-judgement";

/** 两种生效模式：记录但不管控 / 真正生效。 */
export const JUDGEMENT_MODES = ["observe", "enforce"];

/** 三分类裁决结果（与 lib/outcomes.js 一致）。 */
export const VERDICT_KINDS = ["allow", "ask", "reject"];

/**
 * （决策点, 裁决词）→ 裁决结果。
 *
 * 与 lib/outcomes.js 的 `OUTCOME_MATRIX` 逐字一致。客户端拿不到那个模块，
 * 只能抄一份；test/judgement-ui.test.js 里有一条一致性测试盯着两份是否相同，
 * 改一处忘了改另一处会立刻红。
 *
 * 为什么按 **（point, kind）** 而不是只按 kind：同一个词在不同点上含义相反——
 * `retrieval.skip` 真的拦下了一次检索，`cotTranslate.skip` 只是没翻译一句话。
 * 混在一起算「拦截次数」，得到的数字没有意义。
 */
export const VERDICT_MATRIX = {
  authorize: { delegate: "allow", ask: "ask", deny: "reject" },
  route: { keep: "allow", switch: "allow" },
  delegate: { inline: "allow", advise: "allow" },
  compact: { summarize: "allow", prune: "allow" },
  turnStop: { continue: "allow", stop: "allow" },
  retrieval: { allow: "allow", skip: "reject" },
  skillPick: { allow: "allow", redirect: "reject" },
  cotTranslate: { translate: "allow", skip: "allow" },
};

/** unknown point 的老记录兜底（与 LEGACY_UNKNOWN_POINT_OUTCOMES 一致）。 */
export const LEGACY_UNKNOWN_POINT_VERDICTS = {
  delegate: "allow",
  ask: "ask",
  deny: "reject",
};

/**
 * 决策点 id → 中文名（与 lib/client-errors.js 的 POINT_LABELS 一致）。
 *
 * 两个界面（错误尾部与判断浮层）显示同一个决策点时，名字必须一致——
 * 否则用户会以为「工具授权」和「工具授权判断」是两件事。
 */
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

/** 决策点 id → 英文名（与 lib/decision-points.js 的 labelEn 基本一致）。 */
export const POINT_LABELS_EN = {
  authorize: "Tool authorization",
  route: "Model routing",
  delegate: "Subtask delegation",
  compact: "Context compaction",
  turnStop: "Turn continuation",
  retrieval: "Retrieval necessity",
  skillPick: "Skill selection",
  cotTranslate: "COT translation gate",
  unknown: "Decision engine",
};

/**
 * 决策点的**显示顺序**（与 lib/decision-points.js 的 DECISION_POINTS 一致）。
 *
 * 浮层里的行按这个顺序排，而不是按出现顺序：出现顺序会随这一轮先碰到哪个
 * 决策点而变，同一份数据在两轮之间跳来跳去，用户没法形成肌肉记忆。
 */
export const POINT_ORDER = [
  "authorize",
  "route",
  "delegate",
  "compact",
  "turnStop",
  "retrieval",
  "skillPick",
  "cotTranslate",
];

/**
 * 把一条宿主事件归一化成一条判断记录。
 *
 * 事件有两种形状（二选一，由 lib/judgements.js 定）：
 *
 *   裁决   `{ turn, point, mode, action }`
 *   降级   `{ turn, point, mode, degraded }`
 *
 * 两种都收：降级不是判断，但要进降级桶（理由见文件顶部）。
 *
 * 归一化失败一律返回 `null`——**不猜**。一条看不懂的记录挂到界面上，
 * 会变成一个来源不明的数字；丢掉它，最坏的结果只是数字偏小。
 *
 * @param {object} event - 会话事件。
 * @returns 归一化后的记录 `{turn, point, mode, action?, degraded?, at}`，或 null。
 */
export function judgementFromEvent(event) {
  if (event === null || typeof event !== "object") return null;
  if (event.type !== JUDGEMENT_EVENT_TYPE) return null;
  const data = event.data;
  if (data === null || typeof data !== "object") return null;
  const turn = data.turn;
  if (!Number.isSafeInteger(turn) || turn < 0) return null;
  const point = typeof data.point === "string" && data.point.length > 0 ? data.point : "unknown";
  // 模式只认 observe / enforce。没写模式的记录按 observe 处理：那是「记录了
  // 但没管控」的默认语义，比丢掉整条记录更接近事实。
  const mode = data.mode === "enforce" ? "enforce" : "observe";
  const at = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined;
  const action = typeof data.action === "string" && data.action.length > 0 ? data.action : undefined;
  const degraded = typeof data.degraded === "string" && data.degraded.length > 0 ? data.degraded : undefined;
  // 既没有裁决词也没有降级原因：这条记录什么都没说，丢掉。
  if (action === undefined && degraded === undefined) return null;
  return { turn, point, mode, ...(action !== undefined ? { action } : {}), ...(degraded !== undefined ? { degraded } : {}), ...(at !== undefined ? { at } : {}) };
}

/**
 * 查一条记录的裁决分类。
 *
 * 与 lib/outcomes.js 的 `outcomeOf` 同构，只是返回值里**没有** `"none"` 之外
 * 的第四态：降级记录压根不走这里（它进降级桶），所以查不到就是 `"none"`。
 *
 * @param point - 决策点 id。
 * @param kind - 裁决词。
 * @returns `"allow"` / `"ask"` / `"reject"` / `"none"`。
 */
export function verdictOf(point, kind) {
  if (typeof point !== "string" || typeof kind !== "string" || kind.length === 0) return "none";
  const bucket = VERDICT_MATRIX[point];
  if (bucket !== undefined) {
    const verdict = bucket[kind];
    if (verdict === "allow" || verdict === "ask" || verdict === "reject") return verdict;
    return "none";
  }
  // point 为 unknown 的老记录：只认授权那三个裁决词（理由见 VERDICT_MATRIX）。
  if (point === "unknown") {
    const fallback = LEGACY_UNKNOWN_POINT_VERDICTS[kind];
    if (fallback === "allow" || fallback === "ask" || fallback === "reject") return fallback;
  }
  return "none";
}

/**
 * 把一轮的记录折叠成浮层要显示的那几行。
 *
 * ## 为什么按决策点聚合
 *
 * 用户点开「3 次判断」，想问的是「这 3 次花在哪些决策点上」。逐个事件列一遍
 * 只能回答「依次发生了什么」，而同一决策点在一轮里被问十次是完全正常的——
 * 那十行会把它真正的信息（哪个点最活跃）淹没掉。
 *
 * ## 为什么 `total` 只数判决、不数降级
 *
 * 尾部那个数字回答的是「判断了几次」。降级不是判断：它没产生任何结论。
 * 混进去会让这个数字随网络抖动忽大忽小，而用户拿它跟「决策引擎有没有在工作」
 * 对照——一个会抖的数字没法当对照。
 *
 * @param {Array<object>} entries - 一轮的记录（`judgementFromEvent` 的产物）。
 * @returns `{ total, firstAt, lastAt, rows }`。
 */
export function summarizeTurn(entries) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {Map<string, object>} */
  const buckets = new Map();
  let total = 0;
  let firstAt;
  let lastAt;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const point = typeof entry.point === "string" && entry.point.length > 0 ? entry.point : "unknown";
    // 先判「这条对界面有没有贡献」：既没有裁决词也没有降级原因的记录
    // 什么都数不出来，给它建一行只会显示「判断 0」——那一行是噪音。
    const contributes =
      (typeof entry.degraded === "string" && entry.degraded.length > 0) ||
      (typeof entry.action === "string" && entry.action.length > 0);
    if (!contributes) continue;
    let row = buckets.get(point);
    if (row === undefined) {
      row = {
        point,
        judged: 0,
        observe: 0,
        enforce: 0,
        allow: 0,
        ask: 0,
        reject: 0,
        degraded: 0,
        degradedReasons: [],
      };
      buckets.set(point, row);
    }
    const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : undefined;
    if (at !== undefined) {
      if (firstAt === undefined || at < firstAt) firstAt = at;
      if (lastAt === undefined || at > lastAt) lastAt = at;
    }
    const degraded = typeof entry.degraded === "string" && entry.degraded.length > 0 ? entry.degraded : undefined;
    if (degraded !== undefined) {
      row.degraded += 1;
      // 同一个原因重复出现只留一条：一轮里连续三次超时，浮层里应该是
      // 「降级 3（超时）」而不是「超时 超时 超时」。
      if (!row.degradedReasons.includes(degraded)) row.degradedReasons.push(degraded);
      continue;
    }
    const action = typeof entry.action === "string" && entry.action.length > 0 ? entry.action : undefined;
    if (action === undefined) continue;
    row.judged += 1;
    total += 1;
    if (entry.mode === "enforce") row.enforce += 1;
    else row.observe += 1;
    const verdict = verdictOf(point, action);
    if (verdict === "allow" || verdict === "ask" || verdict === "reject") row[verdict] += 1;
  }
  // 按决策点的固定顺序排（剩下的 unknown 排在最后）——顺序稳定，
  // 同一份数据在任何一轮里看起来都一样。
  const rows = [];
  for (const point of POINT_ORDER) {
    const row = buckets.get(point);
    if (row !== undefined) rows.push(row);
    buckets.delete(point);
  }
  for (const row of buckets.values()) rows.push(row);
  return { total, ...(firstAt !== undefined ? { firstAt } : {}), ...(lastAt !== undefined ? { lastAt } : {}), rows };
}

/**
 * 建一个 conversation Definition：把判断事件折叠成「这一轮的判断」。
 *
 * ## 为什么用 Definition 而不是直接读会话事件
 *
 * 理由与错误尾部那条通路完全一样（详见 lib/client-errors.js）：Definition
 * 是对话层**官方**给插件的扩展位，它按事件类型匹配、维护每个轮次的上下文、
 * 并在轮次结束时把结果发布成轮次数据。自己订阅会话事件再自己归位，就得重做
 * 一遍「事件属于哪一轮」的判断——而那个判断错了，判断数就会挂到别人的消息下面。
 *
 * @param {string} kind - Definition 的唯一名字。
 * @returns Definition 对象（传给 `ctx.uiConversation.events.register`）。
 */
export function createJudgementDefinition(kind = TURN_DATA_KEY) {
  return {
    kind,
    target: "chat",
    /**
     * 匹配判断事件与轮次起点。
     *
     * `id` 用轮次号：同一轮里的多条记录要折进**同一个**上下文，
     * 否则每条记录各成一轮，界面上会出现一串重复卡片。
     *
     * **`turn/start` 必须匹配为 `start` 角色**：对话层要求每个上下文先有
     * 一个 start 匹配，之后才能收 update 匹配——只匹配判断事件（全是
     * update）会撞上「received an update before its start Match」而抛错。
     */
    match: (event) => {
      if (event === null || typeof event !== "object") return null;
      if (event.type === "turn/start") {
        const turn = event.data?.turn;
        if (!Number.isSafeInteger(turn) || turn < 0) return null;
        return { id: String(turn), role: "start" };
      }
      const judgement = judgementFromEvent(event);
      if (judgement === null) return null;
      return { id: String(judgement.turn), role: "update" };
    },
    /** 该轮的记录列表的初值（以 turn/start 为起点）。 */
    start: (_context, match) => {
      const turn = Number(match.id);
      return { turn: Number.isSafeInteger(turn) ? turn : 0, entries: [] };
    },
    /** 收进一条记录：同一轮的记录**全部**累加（与错误不同，不去重）。 */
    update: (context, match) => {
      const judgement = judgementFromEvent(match.event);
      if (judgement === null || context.state === undefined) return context.state;
      const entry = { point: judgement.point, mode: judgement.mode };
      if (judgement.action !== undefined) entry.action = judgement.action;
      if (judgement.degraded !== undefined) entry.degraded = judgement.degraded;
      if (judgement.at !== undefined) entry.at = judgement.at;
      return { ...context.state, entries: [...context.state.entries, entry] };
    },
    /**
     * 把这一轮的判断发布成轮次数据，供 turnTail 读取。
     *
     * `previous` 不变时原样返回——宿主靠引用相等判断「没变」，
     * 每次都造新对象会让界面白白重渲染。
     */
    buildLocationData: (context, scope, previous) => {
      if (scope !== "turn" || context.state === undefined) return null;
      const entries = context.state.entries;
      if (
        previous?.kind === "turn" &&
        previous.turn === context.state.turn &&
        previous.key === TURN_DATA_KEY &&
        previous.value.entries === entries
      ) {
        return previous;
      }
      const summary = summarizeTurn(entries);
      return {
        kind: "turn",
        turn: context.state.turn,
        key: TURN_DATA_KEY,
        value: {
          turn: context.state.turn,
          entries,
          ...(summary.firstAt !== undefined ? { firstAt: summary.firstAt } : {}),
          ...(summary.lastAt !== undefined ? { lastAt: summary.lastAt } : {}),
        },
      };
    },
  };
}

/**
 * 从 turnTail 的 owner 里取出「这一轮的判断记录」。
 *
 * @param {object} owner - turnTail 槽位给的 owner（`turn` / `seq` / `openFile`）。
 * @returns 记录数组；没有则空数组。
 */
export function judgementsOfTurn(owner) {
  const data = owner?.turn?.data?.get?.(TURN_DATA_KEY);
  const entries = data?.value?.entries;
  return Array.isArray(entries) ? entries : [];
}
