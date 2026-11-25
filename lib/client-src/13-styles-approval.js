      /**
       * 口径脚注：解释数字是怎么算出来的，必须显眼但不抢主表的注意力。
       *
       * 只给**会话里的「决策」视图**用（统计页已改走 `de-stats__*` 类名，
       * DEC-085）：那个视图不在 `de-settings` 外壳里，拿不到面板的样式源。
       */
      statsNote: {
        marginTop: "14px",
        padding: "10px 12px",
        borderRadius: "7px",
        border: "1px dashed rgba(128,128,128,.3)",
        fontSize: "11px",
        lineHeight: 1.6,
        opacity: 0.7,
      },
      /**
       * 审批卡正文（DEC-042）：接管 `conversation.approval.detail` 之后的样式。
       *
       * 宿主原来把 `args.command` 原文直接塞进一个等宽块（`.ImxglW_command`），
       * 样式是 `word-break: break-all` 且**没有** `white-space: pre-wrap`——
       * 换行被折叠，一条十几行的 heredoc 脚本于是糊成一整块不可读的墙。
       *
       * 这里的取舍：
       *   - 摘要区用普通正文字体（不是等宽）：它是给人读的导读，不是要照抄的命令；
       *   - 原文区用等宽 + `white-space: pre-wrap`（**保留换行**）+ `word-break:
       *     break-word`（长 URL 之类的超长 token 仍然不撑破容器）+ 限高滚动；
       *   - 默认**收起**原文：卡片的默认高度从「满屏」降到几行，想核对的人点开。
       */
      approvalSummary: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        marginTop: "2px",
      },
      approvalSummaryLine: {
        fontSize: "13px",
        lineHeight: 1.5,
        opacity: 0.85,
      },
      /** 危险动作提示：用警示色，但要能与正文区分开（不改字号）。 */
      approvalDanger: {
        color: "var(--dsw-alias-state-warn-primary, #d9822b)",
        fontWeight: 600,
      },
      /** 步骤清单：每条一行，前面一个小圆点。 */
      approvalStepList: {
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
      },
      approvalStep: {
        display: "flex",
        gap: "6px",
        alignItems: "baseline",
        fontSize: "12px",
        lineHeight: 1.5,
      },
      approvalStepText: {
        fontFamily: "var(--ds-font-family-code)",
        fontSize: "12px",
        wordBreak: "break-word",
      },
      approvalToggle: {
        alignSelf: "flex-start",
        padding: "2px 0",
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontSize: "12px",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        cursor: "pointer",
      },
      /**
       * 原文区。三个属性缺一不可：
       *   `whiteSpace: pre-wrap` —— 保住换行（宿主原来最致命的那一点）；
       *   `wordBreak: break-word` —— 长 token 不撑破容器（不用 `break-all`，
       *     那会把单词从中间劈开，比现在更难读）；
       *   `maxHeight` + `overflowY: auto` —— 长命令也不把卡片撑满屏。
       */
      approvalRaw: {
        marginTop: "4px",
        padding: "8px 10px",
        borderRadius: "6px",
        background: "var(--dsw-specific-input-major, rgba(128,128,128,.08))",
        color: "var(--dsw-alias-label-tertiary, inherit)",
        fontFamily: "var(--ds-font-family-code)",
        fontSize: "12px",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: "220px",
        overflowY: "auto",
        boxSizing: "border-box",
      },
    };
    /** 统一 fetch：带 content-type、no-store，并把错误转成可展示文本。 */
