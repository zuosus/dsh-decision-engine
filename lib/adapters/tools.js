/**
 * 检索必要性 + 技能选择的 tools/pre-execute 适配器。
 *
 * 这两个点都挂在 `tools/pre-execute` 上，但只对「特定工具」生效：
 *
 *   检索必要性  只有 web_search / web_fetch / research 等检索工具才判断。
 *               其余工具一行 `includes` 就返回，零请求零延迟。
 *   技能选择    只有 `skill` 工具、且候选清单非空时才判断。
 *
 * 「只对特定工具生效」不是优化，而是必要条件：这两个点在注册表里都是
 * 非热路径，但 `tools/pre-execute` 本身是每次工具调用都会走的，
 * 若不按工具名过滤，就等于给每个 bash/read/edit 都加 2 秒。
 *
 * 两者的生效方式不同：
 *   检索  deny 直接拦下（这是唯一能真省下搜索 token 的方式）
 *   技能  deny 会给出更匹配的名字（拦掉错的、指对对的）
 *
 * @module dsh-decision-engine/adapters/tools
 */

/** 检索类工具名（默认值；可在配置里用 retrievalTools 覆盖）。 */
export const DEFAULT_RETRIEVAL_TOOLS = ["web_search", "web_fetch", "research", "multi_search", "advanced_search"];

/** 技能加载工具名。 */
export const SKILL_TOOL = "skill";

/**
 * 判断一次工具调用是不是检索。
 * @param name - 工具名。
 * @param tools - 配置里的检索工具名集合。
 * @returns 是否按检索处理。
 */
export function isRetrievalTool(name, tools) {
  return typeof name === "string" && tools.has(name);
}

/**
 * 从工具参数里摘出「这次要检索什么」。
 *
 * 不同检索工具的参数名不一样（web_search 用 queries，web_fetch 用 url，
 * research 用 question），逐个认；认不出来就退回整段参数预览。
 * 这个字符串同时是软缓存的签名——同一个问题问第二遍应该命中缓存。
 *
 * @param args - 工具参数。
 * @returns 用于 state 与缓存的查询文本。
 */
export function retrievalQuery(args) {
  if (args === null || typeof args !== "object") return "";
  const candidates = [args.query, args.question, args.url, args.prompt];
  if (Array.isArray(args.queries)) candidates.push(args.queries.join(" | "));
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  try {
    return JSON.stringify(args).slice(0, 400);
  } catch {
    return "";
  }
}

/**
 * 时效性意图：出现这些词就说明用户要的是**此刻**的事实。
 *
 * 中文用子串匹配（没有词边界这回事），英文用 `\b` 防止 "known" 里的 "now"、
 * "download" 里的 "load" 之类的假命中。
 */
export const TIME_SENSITIVE_PATTERN =
  /最新|今天|当前|目前|现在|版本|发布|价格|新闻|实时|\b(?:latest|today|current|currently|version|versions|release|released|price|prices|pricing|news|now)\b/i;

/** 查询里出现它就说明这次要抓的是一个**具体地址**。 */
const URL_PATTERN = /(?:https?:\/\/|www\.)/i;

/**
 * 「这类检索绝不能交给模型决定跳过」的确定性判据。
 *
 * 为什么需要它：retrieval 点的 skip 在 enforce 下会变成 deny（真的把调用拦下来）。
 * 模型的判断依据只有「recent 里是否已覆盖」和「再搜是否有新信息」，而下面三种
 * 情况下这个依据**在原理上就不成立**：
 *
 *   1. web_fetch：调用方给的是一条具体 URL。要判断「这份文档已经在上下文里了」
 *      需要内容指纹，我们没有；模型只能凭 URL 猜。
 *   2. 查询里带 URL：同上——用户明确要抓这个地址，不是要「一般性的知识」。
 *   3. 时效性关键词（最新/今天/版本/发布/价格……）：这类问题**天然**需要重新
 *      检索，哪怕上下文里提过一次——「上次的答案」正是它要更新的东西。
 *      `would_add` 问的是「再搜会不会有新信息」，对这一类几乎必然答「会」，
 *      可一旦模型答错，代价是一次被判死的检索，而用户完全无法理解为什么。
 *
 * @param name - 工具名。
 * @param query - `retrievalQuery()` 摘出来的查询文本。
 * @returns 命中的保护类别；不命中返回 undefined（= 可以交给模型裁决）。
 */
export function retrievalGuardReason(name, query) {
  if (name === "web_fetch") return "explicit-url";
  const text = typeof query === "string" ? query : "";
  if (URL_PATTERN.test(text)) return "url-in-query";
  if (TIME_SENSITIVE_PATTERN.test(text)) return "time-sensitive";
  return undefined;
}

/**
 * 挂载检索必要性 + 技能选择两个监听器。
 *
 * 两者合成一个 `tools/pre-execute` 监听器而不是注册两个：一个监听器里先按
 * 工具名分派，省掉一次 dispatch 往返，也让「这次调用归哪个点管」在日志里
 * 只有一个明确答案（不会出现两个点同时记录同一次调用）。
 *
 * @param ctx - cordis 插件上下文。
 * @param deps - 运行期依赖。
 */
export function mountToolPoints(ctx, deps) {
  const { runner, getConfig, digestRecent, telemetry } = deps;

  const listener = async (exec, next) => {
    if (exec?.agent === undefined) return next();
    const name = exec.name;
    const cfg = getConfig();

    // ---- 技能选择 ------------------------------------------------------
    if (name === SKILL_TOOL && runner.participates("skillPick")) {
      try {
        const requested = typeof exec.arguments?.name === "string" ? exec.arguments.name : "";
        const candidates = await loadSkillCandidates(ctx, exec, cfg, requested);
        // 候选太少时挑选没有意义，直接放行——别为一次「只有一个选项」付费。
        if (candidates.length >= 2) {
          const result = await runner.ask(
            "skillPick",
            {
              requested,
              candidates,
              recent: digestRecent(exec.agent.session, cfg.recentMessages, cfg.recentMessageChars),
            },
            // session 只给「决策历史」明细用，不参与裁决。
            { tool: name, signal: exec.signal, session: exec.agent.session },
          );
          // observe 只记录；enforce 且判出更匹配的技能时才改写这次调用。
          if (runner.enforces("skillPick") && result.action?.kind === "redirect") {
            const suggest = result.action.suggest;
            if (typeof suggest === "string" && suggest.length > 0 && suggest !== requested) {
              /**
               * 修之前这里直接采用模型给的 suggest，不校验它是不是候选之一。
               * 模型偶尔会答一个「听起来更对」的名字（甚至是被截断掉、根本没
               * 进候选的那个），于是这次调用被 deny 并指去一个**不存在的技能**：
               * 模型照着原因再试一次只会再错一次，一次本来正确的调用被拖成
               * 两次失败。候选清单就在手里，白名单校验是零成本的。
               *
               * 不合法就按「没有更匹配的」处理（放行），并留一条记录——
               * 否则这类模型漂移在用户侧完全不可见（他只会看到偶发的怪错误）。
               */
              if (!candidates.some((item) => item.name === suggest)) {
                await telemetry.log({
                  ts: new Date().toISOString(),
                  point: "skillPick",
                  tag: "adapter/skillPick",
                  action: "degraded",
                  detail: "skill-suggest-unlisted",
                  latencyMs: 0,
                  cached: false,
                });
                return next();
              }
              // 不改写参数（那会替模型做决定），而是拦下并告知更匹配的那个：
              // 模型看到原因后可以自己重发，避免「装错再换」付两遍正文 token。
              return {
                kind: "deny",
                reason: `${result.action.reason}。若要装该技能，请改用以 skill(name: "${suggest}") 重试。`,
                info: { name: "StartluxSkillPickError", code: "STARTLUX_SKILLPICK_REDIRECT", suggest },
              };
            }
          }
        }
      } catch (error) {
        telemetry.noteAdapterError("skillPick", error, ctx);
      }
      return next();
    }

    // ---- 检索必要性 ----------------------------------------------------
    if (runner.participates("retrieval") && isRetrievalTool(name, deps.retrievalTools())) {
      try {
        const query = retrievalQuery(exec.arguments);
        /**
         * 确定性保护：命中就**不问模型**，直接放行。
         *
         * 修之前这里无条件交给模型判断，模型说 skip 就 deny。于是一次抓取
         * 还没读过的 URL、或一句「查一下最新版本」，都可能因为 recent 里恰好
         * 提过相关字眼被判死——而且 enforce 下是真的拦下，模型连重试的机会
         * 都没有。这不是省钱，是把「不确定」变成了「确定地不检索」。
         *
         * 这里不写遥测：它根本不是一次裁决（没有问、没有答），写进
         * telemetry.jsonl 会让「服务端说了什么」的流水账里多出没有服务端的行。
         */
        if (retrievalGuardReason(name, query) !== undefined) return next();
        const result = await runner.ask(
          "retrieval",
          {
            tool: name,
            query,
            recent: digestRecent(exec.agent.session, cfg.recentMessages, cfg.recentMessageChars),
          },
          {
            tool: name,
            signal: exec.signal,
            // session 只给「决策历史」明细用，不参与裁决。
            session: exec.agent.session,
            // 软缓存（同类复用）默认关闭；此前误传 softCacheable 会把「检索
            // 有必要」的裁决跨不同查询复用，与「skip 永不复用」的意图相反。
            // 该点的裁决要么跟着完整 state 走精确键，要么不复用。
          },
        );
        if (runner.enforces("retrieval") && result.action?.kind === "skip") {
          return {
            kind: "deny",
            reason: result.action.reason,
            info: { name: "StartluxRetrievalError", code: "STARTLUX_RETRIEVAL_SKIP" },
          };
        }
      } catch (error) {
        telemetry.noteAdapterError("retrieval", error, ctx);
      }
      return next();
    }

    return next();
  };

  ctx.on("tools/pre-execute", listener);
}

/**
 * 取当前可见的技能候选清单（名称 + 描述）。
 *
 * 只带名字和一行描述，绝不带正文：决策模型每次约 1.9k token，把技能正文
 * 塞进 state 会让这个「省钱的点」变成主要花销。正文只在模型真正加载时付费。
 *
 * @param ctx - 插件上下文（用于 `ctx.get('skills')`）。
 * @param exec - 待执行的工具调用（提供 agent scope 与 cwd）。
 * @param cfg - 当前配置。
 * @param requested - 这次调用请求的技能名（保证它不会被截断掉）。
 * @returns 候选数组；取不到时返回空数组。
 */
async function loadSkillCandidates(ctx, exec, cfg, requested) {
  const skills = ctx.get?.("skills");
  if (skills === undefined || typeof skills.list !== "function") return [];
  let summaries;
  try {
    summaries = await skills.list({
      cwd: exec.agent?.session?.header?.cwd,
      signal: exec.signal,
      scope: exec.agent,
    });
  } catch {
    return [];
  }
  // 决策模型每次只有很小的一段 state；候选超过上限就截断，宁可少挑不可超长。
  const limit = Math.max(2, cfg.skillPickCandidates ?? 8);
  /**
   * 先规范化 + 去重。
   *
   * 去重不是洁癖：同名技能在 list 里出现两次时，state 会白花一行，
   * 而且 choice 的 criteria 是按键名索引的对象——同名条目会互相覆盖，
   * 模型看到两个候选、实际只有一份描述。
   * 没有名字的条目直接丢掉：它既不能出现在 criteria 里，也不可能被选中。
   */
  const seen = new Set();
  const unique = [];
  for (const summary of summaries ?? []) {
    const nameValue = String(summary?.name ?? "");
    if (nameValue.length === 0 || seen.has(nameValue)) continue;
    seen.add(nameValue);
    unique.push({ name: nameValue, description: String(summary?.description ?? "").slice(0, 160) });
  }
  const head = unique.slice(0, limit);
  /**
   * 用户当前请求的那个技能必须留在候选里。
   *
   * 修之前是直接 `summaries.slice(0, limit)`，而 skills.list() 的顺序与本次
   * 请求无关。技能多的环境里（超过上限）请求第 9 个技能时，它根本不在候选
   * 里，模型只能从「别的技能」里挑一个——一次完全正确的调用被判成错误并改写，
   * 这比不做技能选择坏得多（用户看到的是「我请求的技能被告知不存在」）。
   *
   * 替换最后一项而不是追加：候选上限是给决策模型 state 的长度预算，
   * 追加会突破预算。替换掉的那一项排在最后，本来就最可能是被截断的边界项。
   */
  if (head.length > 0 && seen.has(requested) && !head.some((item) => item.name === requested)) {
    const wanted = unique.find((item) => item.name === requested);
    if (wanted !== undefined) head[head.length - 1] = wanted;
  }
  return head;
}
