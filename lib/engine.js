/**
 * 决策点执行引擎。
 *
 * 「工具授权」那一个点是手写的，因为它要处理 ask/deny 这类改变行为的返回。
 * 另外八个点如果各写一遍「查模式 → 发请求 → 校验答案 → 写遥测」，
 * 八份重复代码里迟早有一份漏掉降级分支——而漏掉降级分支的后果是工具调用被卡住。
 *
 * 所以这里把那条链路收成一个 `ask()`：
 *
 *   模式 off        → 不发请求，返回 { mode: 'off' }
 *   冷却/no-key → client 已降级为 null，这里记一条 degraded 遥测
 *   答案形状不符     → 记 answer-shape-mismatch，按「不改变行为」处理
 *   有裁决           → 记一条 action 遥测，返回 action 交给适配器执行
 *
 * 适配器只负责两件事：给出 state/questions（spec.build），以及把 action 变成
 * 真实的副作用。所有决策点共用同一套超时、缓存与降级语义。
 *
 * @module dsh-decision-engine/engine
 */

/** 一个决策点在某次触发下「什么都不做」的结果。 */
const NOOP = Object.freeze({ mode: "off", action: undefined });

/**
 * @param options.getConfig - 返回当前合并配置的取值函数（配置每次现读）。
 * @param options.client - StartluxClient 实例。
 * @param options.logger - 宿主 logger，可缺省。
 * @param options.modeOf - `(cfg, id) => 'off'|'observe'|'enforce'`。
 * @param options.log - `(entry) => Promise<void>`，写 telemetry.jsonl。
 * @param options.specOf - `(id) => spec`，从注册表取 build/parse/decide。
 * @param options.recordDetail - 可选。`(record) => void`，写 decisions.jsonl
 *   （「决策历史」页的数据源）。缺省时不写——单元测试里的 runner 只关心
 *   裁决语义，不该被明细存储拖进来。
 */
export function createDecisionRunner(options) {
  const { getConfig, client, logger, modeOf, log, specOf } = options;
  /**
   * 记一条决策明细（可缺省）。
   *
   * 与 `log`（遥测）是**两条独立的旁路**，语义不同：
   *
   *   - `log` 写的是「服务端说了什么」的结论（谁、哪家、裁决、token），
   *     会被 `backfillFromTelemetry` 消费，因此字段口径不能变；
   *   - `recordDetail` 写的是本地的决策**现场**（问了什么、答了什么、
   *     属于哪个会话），只给「决策历史」页看，从不进网络。
   *
   * 两条都失败也不影响裁决——旁路永远是旁路。
   */
  const recordDetail = options.recordDetail ?? (() => {});

  /**
   * 从现场取会话 id。
   *
   * 接受**两种形态**，因为各决策点的现场不一样：
   *
   *   - 对象（`agent.session` / `exec.agent.session`）：适配器手里本来就有的
   *     宿主 Session，由这里集中读 `.id` 并兜底——让每个适配器各自去 `.id`
   *     会在 session 形状变化时各自抛错；
   *   - 字符串（`spec.sessionId`）：思维链翻译点只拿得到 `TranslationSpec`，
   *     它直接给了一个 id 字符串，没有 Session 对象可传。
   *
   * 异常一律退化成空串（= 不可归属），绝不向外抛。
   *
   * @param session - Session 对象、id 字符串，或 undefined。
   * @returns 会话 id；拿不到返回空串。
   */
  function sessionIdOf(session) {
    try {
      if (typeof session === "string") return session;
      const id = session?.id;
      return typeof id === "string" ? id : "";
    } catch {
      return "";
    }
  }

  /**
   * 记一条带裁决的统计（可缺省）。
   *
   * 统计必须由**拿到裁决的一方**来写：`classify()` 返回时裁决还不存在
   * （裁决是 `spec.decide()` 的产物）。因此这里把「消耗事实」与「裁决」
   * 合起来交给客户端写盘，统计里才不会有永远为空的裁决维度。
   *
   * 缺省时统计不写（单元测试里的假 client 没有 statsStore）。
   */
  const recordDecision = options.recordDecision ?? (() => false);

  /** 决策点当前模式。读不到即 off —— 宁可少判断一次，也不要在热路径上意外发请求。 */
  function modeOfPoint(id) {
    try {
      return modeOf(getConfig(), id) ?? "off";
    } catch {
      return "off";
    }
  }

  /**
   * 问一次决策模型并给出处置。
   *
   * @param id - 决策点 id（同时是遥测里的 `point` 字段）。
   * @param input - 传给 spec.build 的现场数据。
   * @param extra - 可选：signal / tool / degradeHint。
   *
   * 软缓存（同类复用）不在引擎层开启：决策点的裁决要么与完整 state 一一
   * 对应（精确键），要么干脆不复用。归一化签名会丢掉现场内容，任何
   * 「同类」复用都可能把一次裁决扩散到参数不同的调用上，因此这里不提供
   * signatureText / softCacheable 的传递通道。
   * @returns
   *   `{ mode: 'off' }`            该点没开启，未发请求；
   *   `{ mode, action, ... }`      有裁决（observe 时 action 仍返回，供只记录不执行）；
   *   `{ mode, degraded: reason }` 降级，调用方必须按原生行为继续。
   */
  async function ask(id, input, extra = {}) {
    const mode = modeOfPoint(id);
    if (mode === "off") return NOOP;

    const spec = specOf(id);
    if (spec === undefined) {
      // 注册表里有、规格却没实现，属于接线错误：按降级处理并留痕，绝不抛。
      logger?.warn?.(`dsh-decision-engine: 决策点 ${id} 缺少规格实现，已按不介入处理`);
      return { mode, degraded: "no-spec" };
    }

    const cfg = getConfig();
    const sessionId = sessionIdOf(extra.session);
    /**
     * 写一条决策明细。
     *
     * 单独抽出来是因为「明细」有四次写入点（降级、答案畸形、有裁决、
     * 缓存命中），而它们的公共字段完全一样；不抽出来的话，每加一个
     * 字段就要改四处，漏一处就是那个分支的记录在页面上缺一块。
     *
     * @param outcome - `{ action, detail, degraded, latencyMs, provider, model,
     *   cached, inputTokens, outputTokens, scores }`。
     * @param answeredPart - 决策模型的原始回包；降级时为 undefined。
     */
    const noteDetail = (builtState, builtQuestions, outcome, answeredPart) => {
      try {
        recordDetail({
          ts: new Date().toISOString(),
          sessionId,
          point: id,
          tag: id,
          mode,
          topMode: cfg.mode,
          provider: outcome.provider,
          model: outcome.model,
          action: outcome.action,
          detail: outcome.detail,
          cached: outcome.cached === true,
          degraded: outcome.degraded === true,
          latencyMs: outcome.latencyMs,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          ...(extra.tool === undefined ? {} : { tool: extra.tool }),
          ...(extra.turn === undefined ? {} : { turn: extra.turn }),
          ...(extra.step === undefined ? {} : { step: extra.step }),
          ...(outcome.scores === undefined ? {} : { scores: outcome.scores }),
          // 内容一律交原始三件套；截断与脱敏在存储层做（它知道配置上限，
          // 也负责「只落本地」的那条边界）。
          content: {
            state: builtState,
            questions: builtQuestions,
            ...(answeredPart === undefined ? {} : { answers: answeredPart }),
          },
        });
      } catch (error) {
        // 明细是旁路：写不进去只留一行警告，绝不影响裁决。
        logger?.warn?.(
          `dsh-decision-engine: ${id} 决策明细写入失败（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    };

    let built;
    try {
      built = spec.build(input);
    } catch (error) {
      logger?.warn?.(
        `dsh-decision-engine: ${id} 构造 state 失败（${error instanceof Error ? error.message : String(error)}）`,
      );
      return { mode, degraded: "build-error" };
    }
    if (built === undefined || built.questions === undefined) return { mode, degraded: "no-questions" };

    const result = await client.classify({
      point: id,
      tag: id,
      mode: cfg.mode,
      /**
       * 决策点**此刻的三态模式**（observe / enforce / off）。
       *
       * 与上面的 `mode`（旧的顶层 shadow/enforce）不是一回事：后者只用于
       * 遥测的兼容字段，前者才是决定「这次记录是否计入节省量」的依据。
       *
       * 为什么统计需要它：节省量是**反事实**数字，只有在观察模式下才有
       * 实测意义——那时「普通 LLM 路径」与「决策模型路径」跑在同一批工作
       * 上，两边比的是同一批活。生效模式下普通 LLM 路径根本没发生，
       * 「省了多少」只能是事后估算，不能与观察模式的实测数字混在一起
       * （详见 lib/stats.js 顶部的说明）。
       */
      pointMode: mode,
      ...(extra.tool === undefined ? {} : { tool: extra.tool }),
      state: built.state,
      questions: built.questions,
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    });
    // classify 返回 null 就是已经降级并写过遥测了，这里不能再记一遍。
    if (result === null) {
      // 明细仍要留一条：页面必须能回答「这次为什么没有裁决」。
      // provider / model 在这种情况拿不到（classify 已把它们写进遥测但不回传），
      // 所以这里只记决策点与降级事实，不编造归属。
      noteDetail(built.state, built.questions, {
        action: "degraded",
        detail: "classify",
        degraded: true,
      });
      return { mode, degraded: "classify" };
    }

    const parsed = spec.parse(result.answers);
    if (parsed === undefined) {
      await log({
        ts: new Date().toISOString(),
        point: id,
        tag: id,
        mode: cfg.mode,
        ...(extra.tool === undefined ? {} : { tool: extra.tool }),
        action: "degraded",
        detail: "answer-shape-mismatch",
        latencyMs: result.latencyMs,
        model: result.model,
        // 遥测带 provider：它是回填历史统计时唯一可靠的归因来源。
        ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
      });
      // 答案形状不符 = 这次**没有裁决**。统计要照实记：消耗照记，
      // 裁决维度留空（它会落在「未裁决」那格里），不能悄悄不写。
      recordDecision({
        facts: result.statsFacts,
        action: "degraded",
        detail: "answer-shape-mismatch",
        degraded: true,
      });
      // 明细里同样留一条：页面要能解释「为什么这次没有裁决」。
      noteDetail(built.state, built.questions, {
        action: "degraded",
        detail: "answer-shape-mismatch",
        degraded: true,
        latencyMs: result.latencyMs,
        provider: result.provider,
        model: result.model,
        cached: result.cached,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      }, result.answers);
      return { mode, degraded: "answer-shape-mismatch" };
    }

    const action = spec.decide(parsed, cfg, input);
    // 裁决出来了，这时候才记统计：消耗 + 裁决一起写，统计里才有
    // 「allow / ask / reject」这一维。
    recordDecision({
      facts: result.statsFacts,
      action: action.kind,
      detail: action.reason ?? action.kind,
    });
    await log({
      ts: new Date().toISOString(),
      point: id,
      tag: id,
      mode: cfg.mode,
      ...(extra.tool === undefined ? {} : { tool: extra.tool }),
      model: result.model,
      // 遥测带 provider：它是回填历史统计时唯一可靠的归因来源。
      ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
      action: action.kind,
      detail: action.reason ?? action.kind,
      latencyMs: result.latencyMs,
      cached: result.cached,
      ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      scores: parsed,
    });
    noteDetail(built.state, built.questions, {
      action: action.kind,
      detail: action.reason ?? action.kind,
      latencyMs: result.latencyMs,
      provider: result.provider,
      model: result.model,
      cached: result.cached,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      scores: parsed,
    }, result.answers);

    return { mode, action, parsed, latencyMs: result.latencyMs, cached: result.cached };
  }

  return {
    ask,
    modeOf: modeOfPoint,
    /** 该点此刻是否允许真正改变行为。observe 只记录。 */
    enforces(id) {
      return modeOfPoint(id) === "enforce";
    },
    /** 该点此刻是否参与（observe 或 enforce）。 */
    participates(id) {
      const mode = modeOfPoint(id);
      return mode === "observe" || mode === "enforce";
    },
  };
}
