/**
 * 「危险权限申请」的裁决支持（DEC-089）。
 *
 * ## 这件功能解决什么
 *
 * 宿主的沙箱升权链是**独立于本插件**的一条审批通道：
 *
 *   `dsh-tool-bash` / `dsh-tool-fs` → `dsh-sandbox` 的 `approveEscalation()`
 *   → `ctx.approval.request({ reason: 'escalate sandbox to danger-full-access: <理由>' })`
 *   → `approval/request` waterfall → 交互式应答者（UI）弹卡
 *
 * 于是出现一个反直觉的结果：用户把本插件的「工具授权」点调成 enforce、
 * 又把「人工审核比例」拨到自治，工具调用确实不再被本插件拦了——**但升权
 * 卡照弹**。原因不是本插件失灵，而是那张卡根本不走 `tools/pre-execute`：
 * 它是沙箱层自己发起的审批 ask。Auto 权限预设本身就是
 * `sandbox: danger-full-access` + `approval: ask`，所以「开了自治还老弹」
 * 是这条链路的必然结果。
 *
 * ## 接管方式与边界
 *
 * 本模块注册一个 `approval/request` 应答者（waterfall 的第一个监听器），
 * 只在**同时**满足下面几条时才自己作答：
 *
 *   1. 配置里显式打开了 `dangerFullAccessDecider`（默认关）；
 *   2. 这次 ask 的目标模式确实是 `danger-full-access`——只认宿主固定文案
 *      `escalate sandbox to <mode>: <justification>`，解析不出来一律让位；
 *   3. 「工具授权」决策点处于 enforce（observe 只记录，不替用户做决定）。
 *
 * 而且它**只会放行，不会拒绝**：裁决词是 `ask` / `deny` 时一律 `next()`，
 * 把卡交还给用户。理由不是保守，是诚实——宿主把非 `allowed-once` 的结果
 * 报给模型时写的是「**用户**拒绝了」；用模型的一次判断顶掉用户，还在
 * 模型面前冒充用户，会把「谁做了这个决定」这条审计事实说错。
 *
 * ## 失败方向
 *
 * 任何异常、降级、答案形状不符 → `next()`：这张卡照旧弹给用户。本模块
 * 最多让用户少看一张卡，绝不替用户挡掉一次他会同意的操作。
 *
 * @module dsh-decision-engine/sandbox-escalation
 */

/** 唯一会被接管的升权目标；更窄的 `workspace-write` 仍由用户决定。 */
export const DANGER_FULL_ACCESS = "danger-full-access";

/**
 * 宿主 `approveEscalation()` 的固定 reason 文案。
 *
 * 形状见 `@deepseek-ai/dsh-sandbox` 的 `escalation.ts`：
 * `escalate sandbox to ${mode}: ${justification}`。
 * 这里允许引号与大小写变体，但**不猜别的形状**——认不出来就让位，
 * 宁可多弹一张卡，也不能把别的审批（比如 auto-review 的拒绝回执）误当成升权。
 */
const ESCALATION_REASON = /escalate sandbox to\s+"?([a-z-]+)"?\s*:\s*([\s\S]*)$/i;

/**
 * 解析一次升权审批的 reason。
 *
 * @param reason - `ApprovalRequest.reason` 原文。
 * @returns `{mode, justification}`；不是升权文案时返回 `null`。
 */
export function parseEscalationReason(reason) {
  if (typeof reason !== "string") return null;
  const matched = ESCALATION_REASON.exec(reason);
  if (matched === null) return null;
  return {
    mode: matched[1].toLowerCase(),
    justification: matched[2].trim(),
  };
}

/**
 * 这次审批是不是「升权到 danger-full-access」。
 *
 * @param request - `approval/request` 的事件参数。
 * @returns `{mode, justification}`；不是该类型时返回 `null`。
 */
export function dangerEscalationOf(request) {
  if (request === null || typeof request !== "object") return null;
  const parsed = parseEscalationReason(request.reason);
  if (parsed === null || parsed.mode !== DANGER_FULL_ACCESS) return null;
  return parsed;
}

/**
 * 裁决结果 → 审批应答。
 *
 * 只把「决策模型说放行」翻译成 `allowed-once`；其余一律 `delegate`（让位给
 * 交互式应答者）。observe 档同样让位——它的语义是「记录本该怎样」，不是
 * 「按它执行」。
 *
 * @param options.kind - `decideGuard()` 的裁决词（delegate / ask / deny）。
 * @param options.pointMode - 「工具授权」决策点此刻的三态。
 * @returns `'grant'` 或 `'delegate'`。
 */
export function escalationVerdict({ kind, pointMode }) {
  if (pointMode !== "enforce") return "delegate";
  return kind === "delegate" ? "grant" : "delegate";
}

/**
 * 造一个 `approval/request` 应答者。
 *
 * 依赖从 `lib/index.js` 注入（那里才有配置、模型客户端与校验函数），
 * 本模块只负责顺序与失败方向——这样这段安全逻辑能被单测直接驱动，
 * 不必起整个插件。
 *
 * @param deps - 依赖集合（见下面每一项的说明）。
 * @returns `async (request, next) => ApprovalOutcome`。
 */
export function createEscalationApprover(deps) {
  /**
   * @param request - 待决审批（agent / toolName / callId / reason / signal）。
   * @param next - waterfall 的下一环（交互式应答者）。
   * @returns 审批结果：`allowed-once` 只在本模块真的接管时出现。
   */
  return async function approveDangerEscalation(request, next) {
    try {
      // 配置每次现读：改 config.yml 立即生效，不必重启宿主。
      await deps.reloadOwnConfig();
      const cfg = deps.getConfig();
      if (cfg.enabled !== true) return next();
      if (cfg.dangerFullAccessDecider !== true) return next();
      const escalation = dangerEscalationOf(request);
      if (escalation === null) return next();
      const pointMode = deps.pointModeOf(cfg);
      // off = 这个点压根不参与；连请求都不发，省一次模型往返。
      if (pointMode === "off") return next();

      const state = deps.stateOf(request, escalation);
      const questions = deps.questions();
      const result = await deps.classify({
        point: "authorize",
        tag: "escalation",
        mode: cfg.mode,
        pointMode,
        tool: request.toolName,
        state,
        questions,
        signal: request.signal,
      });
      if (result === null || (result && result.degraded)) {
        deps.record({
          request,
          escalation,
          pointMode,
          state,
          questions,
          result,
          action: "degraded",
          detail: result && typeof result.degraded === "string" ? result.degraded : "classify",
          degraded: true,
        });
        return next();
      }
      const answers = deps.extractAnswers(result.answers);
      if (answers === undefined) {
        deps.record({
          request,
          escalation,
          pointMode,
          state,
          questions,
          result,
          action: "degraded",
          detail: "answer-shape-mismatch",
          degraded: true,
        });
        return next();
      }
      const adjudicated = deps.adjudicate({
        answers,
        result,
        tool: request.toolName,
        args: deps.argumentsOf(request),
      });
      deps.record({
        request,
        escalation,
        pointMode,
        state,
        questions,
        result,
        action: adjudicated.action.kind,
        detail: adjudicated.action.reason ?? "delegate",
        scores: adjudicated.scores,
      });
      return escalationVerdict({
        kind: adjudicated.action.kind,
        pointMode,
      }) === "grant"
        ? "allowed-once"
        : next();
    } catch (error) {
      // 守卫类旁路的老规矩：自己出问题就放行到下一环，绝不把用户卡在这里。
      deps.logger?.warn?.(
        `dsh-decision-engine: 权限申请裁决异常已让位（${error instanceof Error ? error.message : String(error)}）`,
      );
      return next();
    }
  };
}
