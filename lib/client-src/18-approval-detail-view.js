    /**
     * 审批卡正文：接管宿主的 `conversation.approval.detail` 槽位（DEC-042）。
     *
     * ## 宿主原来给了什么
     *
     * 审批卡上，标题下面是宿主的 `ApprovalCommand` 渲染的一块等宽文本：它按
     * `callId` 从 chat 快照里找到那次工具调用，取出 `args.command` **原样**
     * 显示。样式是 `word-break: break-all` 且**没有** `white-space: pre-wrap`，
     * 于是换行被折叠——一条十几行的 `python3 - <<'PY'` 会糊成一整块既不分行、
     * 也看不出在做什么的墙。截图里真实出现过。
     *
     * ## 我们接管后要做到的三件事
     *
     * 1. **摘要**：用 `summarizeCommand()` 把命令切成步骤，列出「这条命令有
     *    几步、其中几步是危险动作」。决策端点只有 choice / score / noul 三种
     *    题型、没有自由文本，所以这件事只能确定性做，不能问小模型。
     * 2. **原文保真**：展开态里显示的仍是 `args.command` 的**原文**，只是
     *    换行不再被折叠（`pre-wrap`）、长 token 不撑破容器（`break-word`）、
     *    并且限高滚动。摘要与原文不一致就是欺骗——用户按「允许」后真正执行
     *    的是原文。
     * 3. **默认收起**：卡片的默认高度从「满屏」降到几行，需要核对的人再展开。
     *
     * ## 为什么命令原文要自己从 chat 快照里捞
     *
     * 宿主是这么做的（`ApprovalCommand`：按 `callId` 找 `tool-call` 节点、
     * 取 `argsRaw` 再 `JSON.parse` 出 `command`）。我们注册在同一个 session
     * 作用域，`ctx.uiSession.provide({ hooks: ["chat"] })` 把 `useChat` 合成到
     * 每个 session-scope entry 上（`standardHookPropName("chat") === "useChat"`），
     * 所以这里拿得到**同一个**快照源。
     *
     * `useChat` 拿不到（宿主改版、或别的组合没有 chat）：不抛，退化成只显示
     * 摘要那一行占位——卡片照常能用，最坏情况等于原来什么都没做。
     *
     * @param props.callId - 本次审批关联的工具调用 id（宿主给的）。
     * @param props.useChat - session 作用域合成的 chat 快照选择器钩子。
     */
    function ApprovalDetailView(props) {
      const callId = typeof props?.callId === "string" ? props.callId : "";
      const useChat = props?.useChat;
      /**
       * 从 chat 快照里捞这条调用的命令原文。
       *
       * 与宿主 `commandOf()` 同一条路：遍历节点找 `callId` 匹配、`phase ===
       * "start"` 的 tool-call，解析 `argsRaw` 取 `command`。任何一步失败都返回
       * undefined——这是展示层，不能因为拿不到原文就把审批卡搞崩。
       */
      const readCommand = () => {
        if (callId.length === 0 || typeof useChat !== "function") return undefined;
        try {
          // 没有 useChat 的合成上下文时（例如 Node 渲染测试），宿主会直接
          // 把值传进来，这里统一次调用形态。
          const snapshot = useChat((value) => value);
          const nodes = snapshot?.nodes;
          if (nodes === null || typeof nodes !== "object" || typeof nodes.values !== "function") return undefined;
          for (const node of nodes.values()) {
            const root = node?.kind === "tool-call" ? node.data?.root : undefined;
            if (root === undefined || root.callId !== callId || "kind" in root || root.phase !== "start") continue;
            const args = JSON.parse(root.argsRaw);
            if (typeof args?.command === "string" && args.command.length > 0) return args.command;
          }
        } catch {
          return undefined;
        }
        return undefined;
      };
      const command = readCommand();
      /** 展开态：默认收起原文（DEC-042 的第三条）。 */
      const [open, setOpen] = react.useState(false);
      // 拿不到原文：什么都不改，把这一步交还给宿主的默认渲染。
      if (command === undefined) return null;

      const result = summarizeCommand(command);
      const parts = [];
      if (result.script === null) {
        parts.push(t("{steps} 个步骤", { steps: result.total }));
      } else if (result.script.kind === "heredoc") {
        parts.push(t("执行一段脚本（{lines} 行）", { lines: result.script.lines }));
      } else {
        parts.push(t("执行一段内联脚本（{lines} 行）", { lines: result.script.lines }));
      }
      if (result.danger !== null) {
        parts.push(t(" · 含 {count} 个危险动作", { count: result.dangerCount }));
      }
      if (result.truncated) {
        parts.push(t(" · 另有 {count} 个步骤未展开", { count: result.total - MAX_SUMMARY_STEPS }));
      }

      return h(
        "div",
        { style: S.approvalSummary },
        h(
          "div",
          { style: S.approvalSummaryLine },
          h("strong", null, t("命令摘要")),
          t("：{summary}", { summary: parts.join("") }),
        ),
        h(
          "div",
          { style: S.approvalSummaryLine },
          t("自动归纳，仅供参考；真正执行的是下方原文"),
        ),
        result.steps.length > 0 && !open
          ? h(
              "ul",
              { style: S.approvalStepList },
              result.steps.map((step, index) =>
                h(
                  "li",
                  { style: S.approvalStep, key: `step-${index}` },
                  h("span", { style: { opacity: 0.5 } }, `${index + 1}.`),
                  h("span", { style: S.approvalStepText }, step.text),
                  step.danger !== null
                    ? h("span", { style: S.approvalDanger }, t("含危险动作"))
                    : null,
                ),
              ),
            )
          : null,
        h(
          "button",
          {
            type: "button",
            style: S.approvalToggle,
            onClick: () => setOpen(!open),
          },
          open ? t("收起原文") : t("展开原文"),
        ),
        open ? h("div", { style: S.approvalRaw }, command) : null,
      );
    }

    /**
     * 决策历史视图（会话里的「决策历史」标签页）。
     *
     * 挂在 `conversation.view` 槽位上，与内置的「对话」「轨迹」并排。
     * 数据来自 `/api/decision-engine/session-decisions`——**按会话过滤**，
     * 因此这里只会看到本会话的记录。
     *
     * ## 为什么这个组件不引入类组件、也不依赖 error boundary
     *
     * 宿主把我们的组件渲染在**它自己的 React 树**里。一个抛异常的组件会
     * 把整个会话区搞挂——那比「决策历史显示不出来」严重得多。
     *
     * 因此这里不引入 `class extends React.Component`：本插件的测试桩只有
     * `createElement/useState/useCallback/useRef/useEffect/useMemo`，类组件
     * 会直接把 `test/client-ui.test.js` 与 `test/client-i18n.test.js` 打挂。
     * 改成「所有数据派生都包 try/catch + 渲染失败就退化成一张静态说明卡」，
     * 效果等价，且不破坏测试环境。
     *
     * @param props.sessionId - 当前会话 id（`conversation.view` 的标准 prop）。
     * @param props.pointLabels - 决策点 id → 中文名。
     */
