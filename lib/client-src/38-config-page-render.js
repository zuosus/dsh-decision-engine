                // `saveState.error` 已经是**完整的句子**（写入 state 时就带上了
                // 「未保存：」前缀，且可能已由 t() 译好）。这里只翻译它、不再套
                // 前缀，否则会得到「Not saved: 未保存：…」这种重复。
                tr(saveState.error),
              )
            : null,
          saveState !== null && typeof saveState === "object" && typeof saveState.error === "string"
            ? h(
                "button",
                {
                  type: "button",
                  disabled: busy !== "",
                  onClick: retrySave,
                  style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
                },
                "重试",
              )
            : null,
        ),
        // 4h) 状态信息与诊断结果已移入「连接方式」分组（见 connectionItems
        //     的 2f / 2g）：它们和「测试端点」是同一个问题的两面。
      ];

      // 配置 tab 的全部内容。
      //
      // **四组可折叠分组**（DEC-051：从「一条长表单 + 三条分隔线」改成分组的
      // 展开/收起）。四个数组分别是四组的正文，下面用 sectionBlock 包成
      // `<section>`：标题行可点、可折叠，展开状态记在 localStorage。
      //
      // 分组顺序与理由：先定「连到哪」（连接方式）→ 再定「怎么干预我」
      //（守卫行为）→ 再定「记不记、长什么样」（记录与展示）→ 剩下是调优与
      // 统计。前一组的问题回答不了，后一组的项就没有意义。
      //
      // 页脚**不进任何分组**：它是所有分组的共同结论（刚才存没存）。
      //
      // 外面包一层 `.de-cfg`：分组之间的顶边细线用 `.de-cfg__section +
      // `.de-cfg__section` 表达，只有当分组**是同一个父元素的兄弟**时才生效；
      // 摊平到页面根节点会把 footerItems 夹在中间，相邻关系就不成立了。
      const configBody = h(
        "div",
        { className: "de-cfg", key: "config-body" },
        sectionBlock("connection", SECTION_META.connection.tone, SECTION_META.connection.title, connectionItems),
        sectionBlock("guard", SECTION_META.guard.tone, SECTION_META.guard.title, guardItems),
        sectionBlock("record", SECTION_META.record.tone, SECTION_META.record.title, recordItems),
        sectionBlock("model", SECTION_META.model.tone, SECTION_META.model.title, modelItems),
        // 页脚单独包一层：它不是分组，不该被套上分组竖线与顶边线。
        h("div", { className: "de-cfg__footer", key: "config-footer" }, ...footerItems),
      );

      /** 决策点 id → 中文名：统计页的分账表用它，取不到就退回显示 id。 */
      const pointLabels = {};
      for (const point of decisions?.points ?? []) {
        if (typeof point?.id === "string") pointLabels[point.id] = point.label ?? point.id;
      }

      /**
       * provider id → 展示名。
       *
       * 数据来自服务端下发的 providerCatalog（`siliconflow` 显示成「硅基流动」）。
       * 统计页按 provider 分组，只显示裸 id 会让用户对着 `siliconflow-intl`
       * 想这是哪家；而前端自己抄一份名字表，就会和服务端的名字漂移。
       */
      const providerLabels = {};
      for (const item of catalog) {
        if (typeof item?.id === "string") {
          providerLabels[item.id] = providerText(item, "label") || item.id;
        }
      }
      // 免费模型（含兜底）的 provider id 是 "server"，它**不在** providerCatalog
      // 里（那份清单是用户可选的服务商）。不补这一条，统计页会把兜底记录
      // 显示成裸 id "server"，用户读了也不知道那是谁。
      const serverLabel = view.serverProvider?.label;
      if (typeof serverLabel === "string" && serverLabel.length > 0) providerLabels.server = serverLabel;

      /**
       * 插件市场链接：放在 tab 栏**上面**。
       *
       * 为什么在 tab 上面而不是配置页表单的最上面：它是**页面级**入口，
       * 和 tab 栏同属页面头部，不该只属于「配置」这一个 tab。放在上面，
       * 切到「统计与对比」时链接依然在——宣传插件市场是整个面板的事，
       * 不是某一页的事。
       */
      const siteLink = h(
        "a",
        {
          key: "site-link",
          href: MARKET_URL,
          // 站外链接：新标签页打开，并断开 opener（避免目标页反向操纵本页）。
          target: "_blank",
          rel: "noreferrer noopener",
          title: MARKET_URL,
          // 样式全部来自 `client.config.css`：链接在两页的**同一层外壳**里，
          // 内联色值会盖过样式源，让浅色主题下这两页各自漂移（DEC-085）。
          className: "de-settings__site-link",
        },
        "插件市场 ↗",
      );

      /**
       * 「调用持续变慢」是否要提示（DEC-090）。
       *
       * 只认 `active === true`：服务端已经按「连续 N 次超过阈值」判好了，
       * 前端不再自己数一遍——否则页面上会出现「图标亮着、说明里写 3/5」
       * 这种自相矛盾。
       *
       * `null`（还没读到）与 `active: false` 都**不提示**：没读到不是「正常」，
       * 但沉默总比一个可能过时的红灯好——警告的价值全靠「亮的时候确实有事」。
       */
      const slowCallActive = slowCalls !== null && slowCalls !== undefined && slowCalls.active === true;
      /** 图标与悬浮提示共用的那句说明（读数由服务端下发，前端不猜）。 */
      const slowCallSummary = slowCallActive
        ? t("连续 {count} 次决策调用超过 {seconds} 秒", {
            count: Number(slowCalls.streak) || Number(slowCalls.needed) || 0,
            seconds: Math.round((Number(slowCalls.thresholdMs) || 0) / 1000),
          })
        : "";

      /**
       * 顶层两个 tab：配置 / 统计。
       *
       * 统计不再挤在配置页末尾当一小块——它有自己的整页空间，因为
       * 「钱花在哪、比不开省了多少」是要认真看的，不是顺手扫一眼的。
       * 配置页的表单本来就长，再挂一张十列的表只会让两边都难用。
       */
      const tabBar = h(
        "div",
        { className: "de-settings__tabs", key: "tabs" },
        ...[
          { id: "config", label: "配置" },
          { id: "stats", label: "统计与对比" },
        ].map((item) =>
          h(
            "button",
            {
              type: "button",
              key: item.id,
              onClick: () => setTab(item.id),
              // 选中态只由 `aria-current="page"` 表达，视觉由样式源画：
              // tab 是**页面级**导航，与页内的分段控件必须能一眼分开（DEC-070）。
              "aria-current": tab === item.id ? "page" : undefined,
            },
            // 标题文字包一层：图标要贴在文字的**右边**，而按钮是个 flex 容器，
            // 直接并排两个文本节点在窄屏下会被拆到两行（图标孤零零飘到下一行）。
            h("span", { className: "de-tab__label", key: "label" }, item.label),
            // 警告只挂在「统计与对比」上：那个 tab 的内容里写着具体情况，
            // 图标与解释必须在一起（见下面的 slowCallBanner）。
            item.id === "stats" && slowCallActive
              ? h(
                  "span",
                  {
                    className: "de-tab__warn",
                    key: "warn",
                    // `role="img"` + `aria-label`：⚠ 是符号不是文字，读屏器
                    // 直接念出来会变成「警告三角」+ 一堆标点。这里给它一句话。
                    role: "img",
                    "aria-label": slowCallSummary,
                    title: slowCallSummary,
                  },
                  "⚠",
                )
              : null,
          ),
        ),
      );

      /**
       * 顶部说明：图标点出来了，就必须有一句能读的话解释它。
       *
       * 为什么放在 tab 内容的**最上面**（而不是统计页某张表下面）：这是页面
       * 级别的「现在有异常」，与页内某个区块的数字无关。用户点开这个 tab 的
       * 第一眼就该看到它，而不是滚到表格底部才发现里面提了一句。
       */
      const slowCallBanner = slowCallActive
        ? h(
            "div",
            { className: "de-slow", key: "slow-calls", role: "status" },
            h(
              "div",
              { className: "de-slow__title" },
              h("span", { className: "de-slow__icon", "aria-hidden": "true" }, "⚠"),
              "决策调用持续变慢",
            ),
            h(
              "p",
              { className: "de-slow__text" },
              t(
                "最近连续 {count} 次决策调用都超过 {seconds} 秒（最近一次 {last}）。服务商可能正在变慢：工具授权这类判断会拖慢每一步操作。可以降低「人工审核比例」、换一个 provider，或先把耗时最高的决策点关掉。",
                {
                  count: Number(slowCalls.streak) || 0,
                  seconds: Math.round((Number(slowCalls.thresholdMs) || 0) / 1000),
                  last: formatMs(Number(slowCalls.lastDurationMs) || 0),
                },
              ),
            ),
          )
        : null;

      /**
       * 两个 tab 共用**同一个** `de-settings` 外壳（DEC-085）。
       *
       * 之前只有配置 tab 带这个 class：于是统计 tab 落在样式表作用域之外，
       * tab 栏、链接、按钮全部退回内联样式（配色是另一套硬编码的灰与靛蓝），
       * 两页观感不一致。外壳是共享令牌（`--de-space-*` / `--de-border` /
       * `--de-accent`）的**唯一入口**，谁少挂一个 class 谁就漂移。
       *
       * 统计 tab 多一个 `de-stats` 标记：统计页自己的区块、指标格与表格规则
       * 都挂在它的后代上，不会串到配置页。
       */
      return h(
        "div",
        { className: tab === "stats" ? "de-settings de-stats" : "de-settings", style: S.wrap },
        siteLink,
        tabBar,
        // 说明只出现在**带图标的那个 tab** 里，且位于内容最顶端。
        //
        // 不放在 tab 栏上方：那会让它变成「页面级横幅」，与「tab 内容的顶部」
        // 这个诉求不是一回事；而且用户在配置页上会反复看到一段与当前页无关的
        // 文字。图标 + 悬浮提示已经足够让他知道「统计页里有话要说」。
        tab === "stats" ? slowCallBanner : null,
        tab === "stats"
          ? safeRenderStatsTab({
              stats,
              error: statsError,
              filter: statsFilter,
              setFilter: setStatsFilter,
              reload: () => void loadStats(statsFilter),
              pointLabels,
              providerLabels,
              meta: statsMeta,
              /**
               * 图表模块（见 loadCharts）。null = 未就绪/失败/测试环境，
               * 统计页照常显示表格，只是没有图形。
               */
              charts: chartsReady,
              /** 圆环里被隐藏的决策点（见 renderPointDonut）与其切换函数。 */
              hiddenPoints,
              togglePointHidden: togglePointHidden,
              /** 走势图的当前点读数（圆环的读数由图型自己出）。 */
              trendReadout,
              setTrendReadout,
            })
          : configBody,
      );
    }

