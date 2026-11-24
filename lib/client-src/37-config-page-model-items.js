        // 与升级前逐字节一致；代价是宿主将来对那块 UI 的改进我们也收不到。
        row(
          "审批卡正文可读化",
          draft.approvalDetailReadable !== false
            ? t("接管宿主的命令块：显示「几步、哪几步危险」的摘要，原文默认收起、可展开；保留换行，长命令限高滚动")
            : t("关闭时完全沿用宿主的渲染：命令原文原样铺满整个块，换行会被折叠"),
          toggle(draft.approvalDetailReadable !== false, () => {
            const next = draft.approvalDetailReadable === false;
            setDraft({ ...draft, approvalDetailReadable: next });
            scheduleSave({ draft: { ...draft, approvalDetailReadable: next } }, true);
          }),
          "approvalDetailReadable",
        ),
      ];

      /**
       * 读**当前生效模型**的能力表：`capabilities.<key>`，缺省 true。
       *
       * 服务端在 catalog 里同时下发 provider 级与模型级能力。模型级是
       * 「provider 打底、模型覆盖、协议兜底」之后的结果（见
       * `effectiveCapabilities`），选中哪个模型就按哪张表显示——同一家
       * decisionmodels 的 s1-fast 与 s1-pro 上限不同，未来也可能只有某一款
       * 接受某个参数。前端不重复实现合并规则，只读合并后的结果。
       *
       * 老服务端不下发 `modelCapabilities` 时回落到 provider 级表，再没有
       * 才按 true：行为与改前逐字一致（宁可让老用户继续看到那一行，也不要
       * 因为字段缺失就把它禁掉）。
       */
      const capabilityOf = (key) => {
        if (activeProvider === null) return true;
        const selected =
          activeProvider.modelCapabilities !== null &&
          typeof activeProvider.modelCapabilities === "object"
            ? activeProvider.modelCapabilities[modelValue]
            : undefined;
        const table =
          selected !== null && selected !== undefined && typeof selected === "object"
            ? selected
            : activeProvider.capabilities;
        if (table === null || typeof table !== "object") return true;
        return table[key] !== false;
      };
      const supportsThinkMode = capabilityOf("thinkMode");

      const modelItems = [
        // ④ 模型与统计：调优（思考模式）与匿名统计。
        //   设一次就忘的项放最后，且默认收起。
        // 4a) 思考模式：never 最省延迟，always 判断更充分但每次多等约 5s。
        // 这一项以前只能手改配置文件，界面没有入口（后端一直支持三档）。
        //
        // **不支持该字段的 provider 上禁用而不是隐藏**：藏起来会让用户以为
        // 这项设置丢了；禁用 + 说明才能回答「为什么我选的 always 没反应」。
        // 这正是本插件最忌讳的「配了没反应」。
        row(
          "思考模式",
          supportsThinkMode
            ? draft.thinkMode === "always"
              ? "总是思考：判断更充分，但每次工具调用约多等 5 秒"
              : draft.thinkMode === "auto"
                ? "仅在模型自己判断需要时思考（折中）"
                : "不思考：最快（约 1.9s），热路径首选"
            : t("当前 provider 不支持思考模式：该端点没有 think_mode 字段，选了也不会生效"),
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: draft.thinkMode ?? "never",
              disabled: busy !== "" || !supportsThinkMode,
              onChange: (event) => {
                const next = { ...draft, thinkMode: event.target.value };
                setDraft(next);
                // 下拉是离散控件：选完即存。
                scheduleSave({ draft: next }, true);
              },
            },
            // 选项由服务端下发（thinkModes），前端不硬编码取值，避免漂移。
            ...(Array.isArray(view.thinkModes) && view.thinkModes.length > 0
              ? view.thinkModes
              : ["never", "auto", "always"]
            ).map((value) =>
              h(
                "option",
                { key: value, value },
                value === "never"
                  ? "never（不思考）"
                  : value === "auto"
                    ? "auto（按需思考）"
                    : "always（总是思考）",
              ),
            ),
          ),
          "thinkMode",
        ),
        // 4b) 匿名使用统计（DEC-020）：三档，默认 daily（install 会让 DAU 恒为 0）。
        // 放在「思考模式」之后：它同样是「一次性选择、改完即存」的下拉，
        // 与上面的开关/下拉一组，不与 provider 表格混在一起。
        row(
          "匿名统计",
          draft.telemetryLevel === "daily"
            ? "每天上报一次：匿名安装 id、版本、平台与当日决策数"
            : draft.telemetryLevel === "off"
              ? "已关闭：任何情况下都不联网"
              : "仅首次运行上报一次「安装了」，之后不再联网",
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: draft.telemetryLevel ?? "daily",
              disabled: busy !== "",
              onChange: (event) => {
                const next = { ...draft, telemetryLevel: event.target.value };
                setDraft(next);
                scheduleSave({ draft: next }, true);
              },
            },
            (Array.isArray(view.telemetryLevels) && view.telemetryLevels.length > 0
              ? view.telemetryLevels
              : ["off", "install", "daily"]
            ).map((value) =>
              h(
                "option",
                { key: value, value },
                value === "off"
                  ? "off（不联网）"
                  : value === "install"
                    ? "install（仅首次）"
                    : "daily（每天一次，默认）",
              ),
            ),
          ),
          "telemetryLevel",
        ),
      ];

      const footerItems = [
        // 页脚常驻在所有分组之下，**只回答一件事**：「刚才那一下存没存」。
        //   它与页面哪一组展开无关，所以不能跟着某一组折叠掉。
        //
        //   状态信息（提供方 / 端点 / 模型 / 密钥来源）与诊断结果已经搬进
        //   「连接方式」分组：它们回答的是「连的这家通不通」，与「测试端点」
        //   按钮是同一个问题的两面，留在页脚会让用户配完地址后要跨半个页面
        //   去对照结果。
        // 4g) 自动保存状态行：**没有「保存」按钮**，改动即落盘。
        //    这一行回答的是「刚才那一下到底存没存」：进行中 / 已存 /
        //    失败原因（附重试）。原来那个按钮的「保存中…」搬到这里。
        h(
          "div",
          { className: "de-cfg__actions", role: "status", "aria-live": "polite", style: { display: "flex", gap: "8px", alignItems: "center", margin: "14px 0 4px" }, key: "actions" },
          // 常驻说明：让第一次进来的人知道不需要找保存按钮。
          h(
            "span",
            { style: { ...S.meta, marginTop: 0, flex: 1, opacity: 0.55 } },
            saveState === "pending"
              ? "待保存…"
              : saveState === "saving"
                ? "保存中…"
                : saveState === "saved"
                  ? "已保存（改动即生效，无需点保存）"
                  : saveState !== null && typeof saveState === "object" && typeof saveState.error === "string"
                    ? null
                    : "改动即保存",
          ),
          // 失败：原因直接给出来，另配「重试」——不能让用户只看到「保存失败」
          // 而不知道该改什么、能不能再试一次。
          saveState !== null && typeof saveState === "object" && typeof saveState.error === "string"
            ? h(
                "span",
                {
                  style: {
                    ...S.meta,
                    marginTop: 0,
                    flex: 1,
                    color: "#f87171",
                    opacity: 1,
                  },
                },
