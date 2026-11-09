/**
 * 读会话事件的**兼容层**。
 *
 * ## 为什么需要这一层
 *
 * 宿主把会话日志从「公开的事件数组」改成了「只能通过快照方法读」：
 *
 *   旧宿主   `session.events` —— 一个可直接遍历的数组
 *   新宿主   `session.snapshotEvents()` —— 物化一段不可变快照
 *
 * 宿主明确标了 `snapshotEvents` / `ownEvents` / `eventAt` 为
 * `@deprecated`（「新调用一律禁止」），但**同时也说了「既有逻辑可以暂不迁移」**。
 * 换句话说：新 API 是推荐用法，旧 API 在当前版本仍可用。
 *
 * 而 `session.events` 在新宿主上**已经不存在**——它不是抛错，是**根本没有
 * 这个成员**。插件原来的写法是 `session.events ?? []`：`??` 兜住了
 * `undefined`，于是**不报错、只是永远拿到空数组**。
 *
 * 后果是静默的：轮次延续点拿到的 `state.last` 恒为 `""`，于是模型是在
 * 对着一句空话判断「这一轮干完了吗」；模型路由点的「有新用户输入」闸门
 * 恒为 false。**没有任何日志说这里出了问题**——用户只会看到插件时灵时不灵。
 * 实测（DEC-045）：28 条轮次延续记录里，`last` 全是空串。
 *
 * 因此这一层做两件事：
 *
 *   1. **优先用新 API**（`snapshotEvents()`）——它是宿主推荐的读法；
 *   2. **保留旧 API 作为回退**——插件要能跑在老宿主上（用户的 DSH 可能
 *      还没升级），不能因为宿主升级就静默失效。
 *
 * @module dsh-decision-engine/session-events
 */

/**
 * 取会话的事件列表（尽力而为）。
 *
 * @param session - 宿主 Session 对象；缺省或不可用时返回空数组。
 * @returns 事件数组（可能是新 API 的冻结快照，也可能是旧 API 的数组）。
 *   拿不到时返回**空数组**而不是 undefined：调用方一律按「没有事件」处理，
 *   不需要到处判空。
 */
export function sessionEventsOf(session) {
  if (session === null || typeof session !== "object") return [];
  // 新宿主：snapshotEvents 是宿主推荐（且未来唯一）的读法。
  try {
    if (typeof session.snapshotEvents === "function") {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    }
  } catch {
    /* 落到旧 API */
  }
  // 旧宿主：公开的 events 数组。
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch {
    /* 读不到就是读不到 */
  }
  return [];
}

/**
 * 找最近一条满足条件的消息事件（从后往前找）。
 *
 * @param session - 宿主 Session 对象。
 * @param predicate - `(event) => boolean`，判断这条事件是不是要找的。
 * @returns 找到的事件，或 undefined。
 */
export function findLastEvent(session, predicate) {
  const events = sessionEventsOf(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(event)) return event;
  }
  return undefined;
}
