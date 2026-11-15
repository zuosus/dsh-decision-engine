/**
 * 模型路由：`agent/request` 适配器。
 *
 * 这个点是**热路径**——每步一次模型请求就触发一次。若每次都问决策模型，
 * 等于每步多等约 2 秒，比省下的 token 更贵。因此这里用三道闸把它压下来：
 *
 *   闸1 步数闸    每轮只在前 N 步判断（默认 3）。后续步骤沿用本轮的裁决——
 *                一个任务的「要不要强模型」在开头就定了，逐步重问是浪费。
 *   闸2 路由闸    提议的 config 与上一次实际使用的不同才问。同一 provider/model
 *                连续多步时，裁决已经生效，不必再问。
 *   闸3 机械闸    最近一条相关事件不是用户新输入才问。带新用户输入的步骤
 *                （尤其是新任务的第一步）是新推理，问了也是 keep，还白等一步。
 *
 * 生效方式：返回替换后的 LlmCallConfig。observe 只记录「本该换成什么」。
 *
 * 安全约束（照 `agent/request` 的契约）：这个 waterfall 不能改 messages，
 * 只能改 config。因此这里只动 provider/model 两个字段，其余字段原样透传，
 * 否则会把 maxTokens、reasoningEffort 等宿主已解析的默认值弄丢。
 *
 * @module dsh-decision-engine/adapters/route
 */

import { sessionEventsOf } from "../session-events.js";

/**
 * 挂载模型路由监听器。
 * @param ctx - cordis 插件上下文。
 * @param deps - 运行期依赖。
 */
export function mountRoutePoint(ctx, deps) {
  const { runner, getConfig, digestRecent, telemetry } = deps;

  /**
   * 每轮的路由状态：turn → { askedSteps, lastProvider, lastModel }。
   * 用 WeakMap 挂在 session 上，会话销毁即回收，不担心泄漏。
   */
  const perSession = new WeakMap();

  const stateFor = (session) => {
    let state = perSession.get(session);
    if (state === undefined) {
      state = { turn: -1, askedSteps: new Set(), lastProvider: undefined, lastModel: undefined };
      perSession.set(session, state);
    }
    // 换轮即重置：新的一轮是一个新任务，前一轮的「机械」判断不适用。
    return state;
  };

  /**
   * 最近一条相关事件的**归类**：用户新输入、工具结果，还是什么都没有。
   *
   * 为什么不是一个布尔（旧的 `hasFreshUserInput`）：闸3 要回答的不是
   * 「有没有新输入」，而是「这一步有没有机械延续的证据」。三态才分得清
   * 「明确是新推理」「明确是工具结果之后」「事件读不到」——第三种不能
   * 当成前两种中的任何一个（详见闸3 的注释）。
   *
   * @returns `"after-user-message"` / `"after-tool-result"` / undefined（读不到）。
   */
  const lastRelevantKind = (session) => {
    const events = sessionEventsOf(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = events[index]?.type;
      if (type === "tool/result") return "after-tool-result";
      if (type === "user/message") return "after-user-message";
    }
    return undefined;
  };

  const listener = async (payload, next) => {
    const proposed = await next();
    const agent = payload?.agent;
    if (agent?.session === undefined) return proposed;
    if (!runner.participates("route")) return proposed;

    try {
      const cfg = getConfig();
      // 下沉目标没配就完全不判断：留空等于「不路由」，问一次模型再放弃是纯浪费。
      if (
        typeof cfg.routeCheapProvider !== "string" ||
        cfg.routeCheapProvider.length === 0 ||
        typeof cfg.routeCheapModel !== "string" ||
        cfg.routeCheapModel.length === 0
      ) {
        return proposed;
      }
      const state = stateFor(agent.session);
      if (state.turn !== payload.turn) {
        state.turn = payload.turn;
        state.askedSteps.clear();
      }

      // 闸1：本轮已问够步数就不再问，沿用当前（可能已被替换的）路由。
      if (state.askedSteps.size >= Math.max(1, cfg.routeMaxStepsPerTurn ?? 3)) return proposed;

      // 闸2：路由没变过就不必重问——裁决已经在上一问里生效。
      if (state.lastProvider === proposed.provider && state.lastModel === proposed.model) {
        // 但同一轮里第一次见到这个路由时，还是要问一次。
        if (state.askedSteps.size > 0) return proposed;
      }

      // 闸3 机械闸：最近一条相关事件是用户新输入，就不判断。
      //
      // 修之前这里还要求 `state.askedSteps.size > 0`——「本轮问过步了才拦」。
      // 于是**新用户任务的第一步**（本轮还没问过任何一步）会照常问模型要不要
      // 下沉，而那恰恰是最不该下沉的一步：用户刚提出目标，后文还没展开，
      // `state` 里只有 current/recent、没有任何「下一步是机械活」的证据。
      // 问出来的多半是 keep（白付一次 ~2 秒 / ~1.9k token），**万一**判成机械，
      // 整个新任务就从开局跑在便宜模型上——第一步走偏，后面全在错的前提上继续。
      //
      // 因此去掉「本轮问过步」这个前提：只要最近一条相关事件是 user/message，
      // 这一步就是新推理，一律不判断。剩下的两种事件才允许继续往下走：
      //   tool/result       明确的机械延续（读结果、改格式、重试）；
      //   读不到事件        保持旧行为（问）。读不到 ≠ 有用户新输入，把它当成
      //                     「不判断」会让老宿主上的路由**静默失效**——这正是
      //                     lib/session-events.js 顶部记的那个坑，不能再踩一次。
      const basis = lastRelevantKind(agent.session);
      if (basis === "after-user-message") return proposed;

      // 已经在用便宜模型了，再往下沉没有意义。
      if (
        proposed.provider === cfg.routeCheapProvider &&
        proposed.model === cfg.routeCheapModel
      ) {
        return proposed;
      }

      state.askedSteps.add(payload.step);

      const result = await runner.ask(
        "route",
        {
          turn: payload.turn,
          step: payload.step,
          current: { provider: proposed.provider, model: proposed.model },
          recent: digestRecent(agent.session, cfg.recentMessages, cfg.recentMessageChars),
          // 闸3 凭什么放行这一步：`after-tool-result` = 上一条相关事件是工具
          // 结果；读不到事件时不给这个字段（不编造依据）。
          //
          // 注意：route 规格的 build 目前只取 turn/step/current/recent，
          // 所以它暂时不会出现在决策历史页上——留在这里是为了让「为什么问了
          // 这一步」在请求里可核对（测试按它断言），规格一旦把它纳入 state
          // 就自动生效，不必再改这里。
          ...(basis === undefined ? {} : { basis }),
        },
        // session / turn / step 只给「决策历史」明细用：tab 按会话归属，
        // 轮次与步号让每行能定位到会话里的具体位置。它们不改任何裁决。
        { signal: payload.signal, session: agent.session, turn: payload.turn, step: payload.step },
      );

      if (result.action?.kind !== "switch") return proposed;
      // 校验目标路由确实配好了：留空等于「不路由」，不能真去请求空 provider。
      const provider = result.action.provider;
      const model = result.action.model;
      if (typeof provider !== "string" || provider.length === 0) return proposed;
      if (typeof model !== "string" || model.length === 0) return proposed;
      if (provider === proposed.provider && model === proposed.model) return proposed;

      // observe 到这里就结束：记录已写，但不改路由。
      if (!runner.enforces("route")) return proposed;

      state.lastProvider = provider;
      state.lastModel = model;
      ctx.logger?.info?.(
        `dsh-decision-engine: 第 ${payload.turn}/${payload.step} 步路由 ${proposed.provider}/${proposed.model} → ${provider}/${model}`,
      );
      // 只覆盖 provider/model，其余字段（maxTokens / reasoningEffort / temperature）
      // 原样保留——它们是宿主已解析好的，弄丢会改变请求语义。
      return { ...proposed, provider, model };
    } catch (error) {
      telemetry.noteAdapterError("route", error, ctx);
      return proposed;
    }
  };

  ctx.on("agent/request", listener);
}
