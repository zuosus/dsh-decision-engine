        //     折叠用户就看不见刚测出来的结果，所以跟着按钮进这一组。
        h(
          "div",
          { style: S.meta, key: "meta" },
          t("提供方 {provider} · 端点 {endpoint}", {
            provider: (lang === "zh"
              ? view.providerLabel
              : view.providerLabelEn ?? view.providerLabel) ?? view.provider ?? "-",
            endpoint: view.baseUrl || t("（未配置）"),
          }),
          h("br", null),
          t("模型 {model} · 超时 {timeout}ms · 请求 {requests} 次（缓存 {cached}）", {
            model: view.model || t("(服务端默认)"),
            timeout: view.timeoutMs,
            requests: view.stats?.requests ?? 0,
            cached: view.stats?.cached ?? 0,
          }),
          // 密钥来源一律取「当前 provider 自己那一条」：用顶层 keyEnvName 会
          // 在切换后短暂显示上一家的名字（服务端字段与本地选择不同步时）。
          //
          // 显示的是**真实命中的来源**（sourceLabel，服务端算好），而不是
          // `apiKeyEnv`。后者只是「若走凭据文件时该查哪个变量名」，
          // 在 keyStorage=config 时根本没被读取——照它显示会让人以为
          // key 存在 .credentials.yaml 里，甚至误判它过期了。
          activeKeyStatus !== null ? h("br", null) : null,
          activeKeyStatus !== null
            ? t("密钥来源 {source}", {
                source: activeKeyStatus.sourceLabel ?? activeKeyStatus.refName ?? t("未知"),
              }) + (activeKeyStatus.configured === true ? "" : t("（未读到）"))
            : null,
        ),
        // 2g) 诊断结果（测试端点 / 重新获取）：点了按钮就在这组里直接显示，
        //     而不是落到页面最底部、折叠状态之外。
        msg !== null
          ? h(
              "div",
              {
                style: {
                  ...S.meta,
                  marginTop: "10px",
                  color: msg.ok ? "#4ade80" : "#f87171",
                },
                key: "msg",
              },
              msg.text,
            )
          : null,
      ];

      const guardItems = [
        // ② 守卫行为：判不判、拦不拦、问得多不多、让决策模型进哪些环节。
        //   这一组直接改变插件的干预强度，所以标题用警示色。
        // 3a) 启用开关
        row(
          "启用守卫",
          "开启后在每次工具调用前做风险判断",
          toggle(draft.enabled === true, () => {
            const next = draft.enabled !== true;
            setDraft({ ...draft, enabled: next });
            // 开关是离散控件：拨一下就落盘。
            scheduleSave({ draft: { ...draft, enabled: next } }, true);
          }),
          "enabled",
        ),
        // 3b) 拦截开关（shadow / enforce 等价于「只记录」与「真拦截」）
        row(
          "真正拦截",
          "关闭时只记录判断结果（shadow）；开启后按判断执行 deny / ask",
          toggle(draft.mode === "enforce", () => {
            const next = draft.mode === "enforce" ? "shadow" : "enforce";
            setDraft({ ...draft, mode: next });
            scheduleSave({ draft: { ...draft, mode: next } }, true);
          }),
          "mode",
        ),
        // 3c) 危险权限申请交决策模型（DEC-089）
        //
        // 为什么单独一项、且默认关：它替用户跨过的是**整个文件系统**的写边界
        // （宿主的 danger-full-access 升权卡），比「工具调用放不放行」重一个量级。
        // 开关拨到开的那一刻先弹风险提示，用户确认了才落盘——把「已经同意的
        // 用户」和「顺手拨了一下」的人分开。
        row(
          "危险权限申请交给决策模型",
          "宿主的 danger-full-access 升权卡（越出工作区的读写）先由决策模型判断：它同意就自动放行，其余情况照旧弹给你。只放行、不拒绝，也不接管更窄的 workspace-write 升权。",
          toggle(draft.dangerFullAccessDecider === true, () => {
            if (draft.dangerFullAccessDecider === true) {
              // 关：立即生效，不需要任何确认——收紧永远不需要确认。
              const next = { ...draft, dangerFullAccessDecider: false };
              setDraft(next);
              scheduleSave({ draft: next }, true);
              return;
            }
            // 开：先弹风险提示，确认后才落盘（见下面的对话框）。
            setDangerConfirmOpen(true);
          }),
          "dangerFullAccessDecider",
          draft.dangerFullAccessDecider === true
            ? "已开启：模型同意时不会弹卡。关掉后每张卡都会立刻恢复。"
            : "默认关闭。开启前会先显示一次风险与免责说明。",
        ),
        // 风险提示对话框（DEC-089）。
        //
        // 为什么不是 `window.confirm`：一段三段式的风险说明塞进浏览器原生对话框
        // 会被折叠成一行小字，而这里要说清的是「可能整块磁盘被改、后果自负」——
        // 那句话必须真的被读到才叫同意。所以用真正的对话框：标题 + 三段正文 +
        // 两个明确动词的按钮，取消在前（默认动作是「不开」）。
        dangerConfirmOpen === true
          ? h(
              "div",
              {
                className: "de-danger",
                key: "danger-confirm",
                role: "dialog",
                "aria-modal": "true",
                "aria-labelledby": "de-danger-title",
                "aria-describedby": "de-danger-body",
                onKeyDown: (event) => {
                  if (event?.key === "Escape") setDangerConfirmOpen(false);
                },
              },
              h(
                "div",
                { className: "de-danger__card" },
                h("div", { id: "de-danger-title", className: "de-danger__title" }, "开启前请确认风险"),
                h(
                  "div",
                  { id: "de-danger-body", className: "de-danger__body" },
                  h(
                    "p",
                    { className: "de-danger__para" },
                    "开启后，模型可以在你不看卡片的情况下直接批准一次 danger-full-access 升权——那是整个文件系统的读写权限，不再限于当前工作区。",
                  ),
                  h(
                    "p",
                    { className: "de-danger__para" },
                    "判断由一个小模型完成，它会出错：把危险操作当成低风险、忽略命令真正要做的事，或者被命令里的提示词带偏。",
                  ),
                  h(
                    "p",
                    { className: "de-danger__para de-danger__para--warn" },
                    "误删、误改、凭据泄露或数据丢失等后果由你自行承担，本插件及其作者不承担任何责任。",
                  ),
                  h(
                    "p",
                    { className: "de-danger__para" },
                    "随时可以关掉这个开关：关掉后每张卡都会立刻恢复，一张都不会少。",
                  ),
                ),
                h(
                  "div",
                  { className: "de-danger__actions" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "de-danger__btn",
                      disabled: busy !== "",
                      onClick: () => setDangerConfirmOpen(false),
                    },
                    "取消",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "de-danger__btn de-danger__btn--go",
                      disabled: busy !== "",
                      onClick: () => {
                        setDangerConfirmOpen(false);
                        const next = { ...draft, dangerFullAccessDecider: true };
                        setDraft(next);
                        scheduleSave({ draft: next }, true);
                      },
                    },
                    "我了解风险，仍然开启",
                  ),
                ),
              ),
            )
          : null,
        // 3d) 人工审核比例（DEC-035）：**配置页的正式入口**。
        //
        // 放在「守卫行为」组的末尾——它与这一组里那几个开关是一对：
        // 「启用守卫 / 真正拦截」决定**判不判、拦不拦**，这一项决定**多频繁问你**。
        // 放在同一组，用户一眼就能看懂「问了什么、问得多不多」。
        //（DEC-051 之后它不再需要「夹在分隔线 3 之前」这类版面说明：分组本身就是边界。）
        //
        // 为什么是分段按钮而不是下拉：四档是一条单调的轴（从不问 → 更常问），
        // 下拉会把「往右更保守」这层语义压掉（DEC-088 起样式见 client.config.css）。
        //
        // 数据来自 `/decisions`（与决策点清单一同下发），那是服务端
        // `tolerancePayload()` 的真源；拿不到时整块消失而不是画一个空滑块。
        // 排版**必须自成一块**，不能塞进 row() 的右半边。
        //
        // row() 是「左标题 / 右控件」的两列布局（`justify-content:
        // space-between`），滑块作为右控件时会被压成一列竖线：四个段挤在
        // `maxWidth: 420px` 之内、又各自 `flex: 1 1 0` + `minWidth: 0`，
        // 结果是每个段只剩一个字宽，中文竖排叠成一团（真机截图见过）。
        //
        // 滑块本身是一整行宽度的控件（四个段要横向铺开），所以这里不用
        // row()，而是自己拼「上面标题+说明、下面整宽滑块」的竖排布局。
        decisions?.tolerance === undefined || decisions?.tolerance === null
          ? null
          : h(
              "div",
              { key: "tolerance", style: S.toleranceSection },
              h(
                "div",
                { style: S.rowText },
                h("div", { style: S.rowTitle }, t("人工审核比例")),
                h(
                  "div",
                  { style: S.rowHint },
                  t("按比例校准这个模型的打扰频率。换决策模型不需要重调阈值：设定是模型无关的，插件会按该模型最近的分数量自己换算。"),
                ),
              ),
              ToleranceSlider({
                tolerance: decisions.tolerance,
                level: draft.tolerance ?? decisions.tolerance.level,
                disabled: busy !== "",
                onSelect: (level) => {
                  const next = { ...draft, tolerance: level };
                  setDraft(next);
                  // 离散控件：点一下就落盘（与决策点三态同一处理）。
                  scheduleSave({ draft: next }, true);
                },
              }),
            ),
        // 4f) 决策点：让决策模型进入哪些环节
        decisions === null
          ? null
          : h(
              "div",
              { key: "points" },
              h("div", { style: S.sectionTitle }, "决策模型参与点"),
              ...(decisions.points ?? []).map((point) => {
                const current = Object.hasOwn(pointsDraft, point.id) ? pointsDraft[point.id] : point.mode;
                // 点完即存：这个角标只在「请求还在路上」的那一小会儿出现。
                const changed = Object.hasOwn(pointsDraft, point.id) && pointsDraft[point.id] !== point.mode;
                const st = point.stats ?? {};
                // 「可用」与「已挂载」是两件事：点已实装（available），但宿主
                // 缺少它依赖的服务时挂载会失败（mounted=false）。两者都真才能切。
                const dim = point.available !== true || point.mounted === false;
                const meta =
                  `${point.hook} · ${point.trigger}` +
                  (st.requests
                    ? t(" · 已判 {requests} 次，缓存 {cached}，{tokens} token，均 {latency}ms", {
                        requests: st.requests,
                        cached: st.cached,
                        tokens: st.tokens,
                        latency: st.avgLatencyMs,
                      })
                    : "");
                return h(
                  "div",
                  { style: S.pointCard(dim), key: point.id },
                  h(
                    "div",
                    { style: S.pointText },
                    h(
                      "div",
                      { style: S.pointName },
                      point.label,
                      // 热路径标记：这些点每次请求/每步都触发，必须靠配置的闸控量。
                      point.hotPath === true
                        ? h("span", { style: { ...S.badge, marginLeft: "6px", opacity: 0.7 } }, "热路径")
                        : null,
                    ),
                    h("div", { style: S.pointHint }, point.summary),
                    // 闸：为什么这个点不是「每次都问」。用户需要知道它何时真的会发请求。
                    point.gate === undefined || point.gate === null
                      ? null
                      : h("div", { style: S.pointHint }, t("触发闸：{gate}", { gate: point.gate })),
                    h("div", { style: S.pointMeta }, meta),
                  ),
                  dim
                    ? h(
                        "span",
                        { style: S.badge },
                        point.mounted === false ? "宿主缺服务" : "即将支持",
                      )
                    : h(
                        "div",
                        { className: "de-cfg__seg", style: S.seg },
                        ...(decisions.modes ?? ["off", "observe", "enforce"]).map((mode) =>
                          h(
                            "button",
                            {
                              type: "button",
                              key: mode,
                              className: "de-cfg__seg-item",
                              // 三态与 provider / 模型 picker 一样用 aria-pressed
                              // 表达选中：DEC-070 的通用规则
                              // `button:not([aria-pressed]) { background: transparent
                              // !important }` 会吃掉任何没有该属性的按钮的内联
                              // 选中色，所以这里必须带上它（DEC-085）。
                              "aria-pressed": current === mode,
                              "data-tone": mode,
                              disabled: busy !== "",
                              onClick: () => {
                                const next = { ...pointsDraft, [point.id]: mode };
                                setPointsDraft(next);
