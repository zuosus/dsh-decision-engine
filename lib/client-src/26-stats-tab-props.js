    function renderStatsTab(props) {
      const stats = props.stats;
      const error = props.error;
      const filter = props.filter;
      const setFilter = props.setFilter;
      const pointLabels = props.pointLabels ?? {};
      const providerLabels = props.providerLabels ?? {};
      const rows = Array.isArray(stats?.rows) ? stats.rows : [];
      const totals = stats?.totals ?? null;
      const range = stats?.range ?? null;
      /**
       * 图表模块。`null` 表示还没加载好 / 加载失败 / 测试环境没有分块加载器。
       *
       * 三种情况都走同一条**降级路径**：只渲染表格，不渲染图表。
       * 图表是让数字更好读的增强，不是统计页能不能用的前提——所以
       * 任何一环没就绪都不该让页面报错、空白或卡在加载态。
       */
      const charts = props.charts ?? null;
      /**
       * 时间序列（服务端算好的，见 lib/stats.js 的 buildSeries）。
       *
       * 与 `rows` 并列，不是从 `rows` 推出来的：`rows` 已经按
       * provider × model 聚合掉时间维度了，前端手上没有时间戳可用。
       */
      const series = stats?.series ?? null;
      const seriesBuckets = Array.isArray(series?.buckets) ? series.buckets : [];
      /**
       * 走势区间里「还没到的时间」有几个桶。
       *
       * 判定只认服务端下发的 `series.nowIndex`（见 lib/stats.js 的
       * `futureStartIndex`）与 `renderTrend` 用同一条 `sparkFutureIndex`，
       * 两处必须同一个口径，否则说明文字说「有虚线」而图上没有（或相反）。
       * 老响应没这个字段 → 0 → 下面那句补充说明整句不出现，页面与以前一致。
       */
      const seriesFutureFrom = sparkFutureIndex(series?.nowIndex, seriesBuckets.length);
      const seriesFutureCount =
        seriesBuckets.length > 1 &&
        seriesFutureFrom >= 1 &&
        seriesFutureFrom < seriesBuckets.length
          ? seriesBuckets.length - seriesFutureFrom
          : 0;
      /**
       * 走势区块里**是否至少有一张图真的画了出来**。
       *
       * 判据与 `renderTrend` 里那个 `hasData` 逐字相同（`some(v => v > 0)`），
       * 且只看它实际渲染的那三个指标（请求次数 / input token / 总耗时）。
       *
       * 为什么说明行需要这个前提：`seriesFutureCount` 说的是**区间**的事实
       * （区间尾部有几格还没到），而虚线是否存在是**图**的事实。区间全零时
       * （例如本月一条记录都没有）`renderTrend` 会直接返回「本区间没有数据」
       * 占位——图上根本没有线，自然也没有虚线；此时若只按区间判断，就会渲染
       * 出一句「虚线段是区间内还没到的时间」去解释一个屏幕上并不存在的东西。
       * 说明行必须跟着图走。
       */
      const trendHasData = ["requests", "inputTokens", "durationMs"].some((key) =>
        (series?.series?.[key] ?? []).some((value) => Number(value) > 0),
      );
      /**
       * 圆环的「隐藏了哪些决策点」与切换函数由调用方传入。
       *
       * 为什么不能在这里直接引用 `hiddenPoints`：本函数（`renderStatsTab`）
       * 在组件**外面**定义，是纯渲染函数；`hiddenPoints` 是 `StartluxPage`
       * 里的 useState，跨作用域取不到（会抛 ReferenceError）。这类错误在
       * 渲染测试里表现为「整页崩掉」，而不是「圆环不显示」——所以必须走 props。
       */
      const hiddenPoints = props.hiddenPoints instanceof Set ? props.hiddenPoints : new Set();
      const togglePointHidden =
        typeof props.togglePointHidden === "function" ? props.togglePointHidden : null;
      /**
       * 走势图的「当前点读数」同样走 props。
       *
       * 它是组件里的 useState，而本函数在组件**外面**——直接引用会抛
       * ReferenceError，表现为整页崩掉。教训已经吃过一次（hiddenPoints），
       * 这里一次把读数都走 props，别再留跨作用域的引用。
       *
       * 圆环**没有**这一份：交互版圆环自带读数气泡，读数是图型内部的状态，
       * 不需要外传（见 renderPointDonut 里的说明）。
       */
      const trendReadout = props.trendReadout ?? null;
      const setTrendReadout =
        typeof props.setTrendReadout === "function" ? props.setTrendReadout : () => {};
      /**
       * 裁决统计（allow / ask / reject）。
       *
       * 单独一块，不与用量表合并：用量回答「钱花在哪」，裁决回答
       * 「模型拦下了多少、惊动了用户多少次」。两套口径互不换算。
       *
       * `outcomes` 可能是 undefined——服务端是旧版本或数据文件为空时。
       * 这时整块不渲染，而不是渲染一张全零的表（那看着像「一次都没拦过」，
       * 而真实情况可能是根本没数据）。
       */
      const outcomes = stats?.outcomes ?? null;
      const outcomePoints = Array.isArray(outcomes?.byPoint) ? outcomes.byPoint : [];
      // 预设清单与标签：优先用「拿到过一次就留着」的元数据，回退到本次响应。
      //
      // 标签不能用 `props.meta?.labels ?? stats?.labels`：元数据的初值是
      // `{}`（不是 null），`??` 永远不跳到右边，于是标签永远是空的，
      // 按钮显示成 `today` 而不是「当日」。所以要和 presets 一样按
      // 「非空才用」判断。
      const metaPresets = Array.isArray(props.meta?.presets) ? props.meta.presets : [];
      const metaLabels = props.meta?.labels ?? {};
      const presets = metaPresets.length > 0
        ? metaPresets
        : Array.isArray(stats?.presets)
          ? stats.presets
          : [];
      const labels = Object.keys(metaLabels).length > 0 ? metaLabels : (stats?.labels ?? {});
      /**
       * 自定义范围还没填完：这不是「没有数据」，也不该显示成读取失败。
       * 单独判一次，因为下面几个分支都只看 `stats === null`，而没填完时
       * 我们刻意不发请求、把 stats 留空——照 `stats === null` 走会显示
       * 「正在读取统计…」，可它根本没在读，用户会一直等。
       */
      const customIncomplete =
        filter.preset === "custom" && (filter.start.length === 0 || filter.end.length === 0);
      const change = (patch) => setFilter({ ...filter, ...patch });
      /** provider 展示名：没下发映射时退回 id，不显示空白。 */
      const providerName = (id) => providerLabels[id] ?? (id === "unknown" ? "未知（历史）" : id);
      /** 组合列的第一行：provider 展示名 + id，避免同名不同源看不出。 */
      const comboName = (row) => `${providerName(row.provider)}`;

      const compareColumns = [
        { key: "requests", label: "次数" },
        { key: "inputTokens", label: "input" },
        { key: "outputTokens", label: "output" },
        { key: "durationMs", label: "总耗时" },
        { key: "avgDurationMs", label: "均耗时" },
      ];
      /**
       * 节省量对比表的列。
       *
       * 「实际」三列显示的是**观察模式**那部分的实际消耗，与旁边的
       * 「省」列同源：两者必须来自同一批记录，否则读者会拿生效模式的
       * 消耗去减观察模式的节省，得出一个毫无意义的数。
       */
      const savedColumns = [
        { key: "observeInputTokens", label: "实际 input（观察）", actual: true },
        { key: "savedInputTokens", label: "省 input" },
        { key: "observeOutputTokens", label: "实际 output（观察）", actual: true },
        { key: "savedOutputTokens", label: "省 output" },
        { key: "observeDurationMs", label: "实际耗时（观察）", actual: true },
        { key: "savedDurationMs", label: "省耗时" },
        { key: "savedRatio", label: "节省比例" },
      ];

      /**
       * 节省量的元信息。
       *
       * 节省量只由**观察模式**的记录贡献（服务端口径，见 lib/stats.js）：
       * 只有那时「普通 LLM 路径」与「决策模型路径」跑在同一批工作上，
       * 两边比的是同一批活，反事实才成立。生效模式下普通 LLM 路径根本
       * 没发生，「省了多少」只能是事后估算。
       *
       * `unavailable` = 这段时间没有观察模式的记录。此时界面上**不能**显示
       * 一个 0 的节省量——那会被读成「一点也没省」，而真相是「没有可比
       * 的数据」。两者的行动建议完全不同，所以必须分开说。
       */
      const savingsMeta = stats?.savings ?? null;
      const savingsUnavailable = savingsMeta?.unavailable === true;
      const observeRequests = Number(savingsMeta?.observeRequests ?? totals?.observeRequests ?? 0);

      const summaryCards =
        totals === null
          ? []
          : [
              { label: "请求次数", value: groupDigits(totals.requests) },
              { label: "命中缓存", value: groupDigits(totals.cached) },
              { label: "input token", value: groupDigits(totals.inputTokens) },
              { label: "output token", value: groupDigits(totals.outputTokens) },
              { label: "总耗时", value: formatMs(totals.durationMs) },
              // 写清「真实请求」：缓存命中的耗时是 0，混进分母会让这个
              // 数字随命中率变好看，读的人以为请求变快了。
              { label: "均耗时（真实请求）", value: formatMs(totals.avgDurationMs) },
              // ---- 节省量（观察模式）----
              //
              // 卡片标题里写明「观察」：这几个数字的来源必须一眼可见，
              // 否则读者会把它们当成「插件整体省了多少」。
              {
                label: "省 input token（观察）",
                value: groupDigits(totals.savedInputTokens),
                saved: true,
              },
              {
                label: "省 output token（观察）",
                value: groupDigits(totals.savedOutputTokens),
                saved: true,
              },
              { label: "省时间（观察）", value: formatMs(totals.savedDurationMs), saved: true },
              { label: "节省比例（观察）", value: formatRatio(totals.savedRatio), saved: true },
            ];

      return h(
        "div",
        { key: "stats-page" },
        // 1) 标题 + 强制重查。统计是读文件算出来的，不跟着配置页的自动刷新，
        //    所以必须留一个手动入口——否则用户改完配置回来看，数字没动过。
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px" } },
          h("div", { style: S.title }, "用量统计与对比"),
          h(
            "button",
            {
              type: "button",
              onClick: props.reload,
              style: { ...S.saveBtn, marginLeft: "auto", flex: "none" },
            },
            "重新读取",
          ),
        ),
        h(
          "div",
          { style: S.sub },
          "按 provider × model 独立统计；区间为左闭右开，相邻范围不会重复计入。",
        ),
        /**
         * 节省量的口径提示条。
         *
         * 为什么放在页面最上面而不是只放在脚注：节省量是这页最容易误读的
         * 数字——它是**反事实**（普通 LLM vs 决策模型），而且**只在观察
         * 模式下有实测意义**。放在脚注里等于没说：看表的人先看表。
         *
         * 提示条的颜色随「本区间有没有观察模式的记录」变化：有数据时是
         * 中性的说明，没数据时是橙色警告（读者需要知道为什么节省量是 0）。
         */
        stats !== null && savingsMeta !== null
          ? h(
              "div",
              {
                style: {
                  marginTop: "8px",
                  padding: "8px 10px",
                  borderRadius: "7px",
                  border: "1px solid rgba(128,128,128,.22)",
                  background: "rgba(128,128,128,.05)",
                  fontSize: "11px",
                  lineHeight: 1.55,
                  color: savingsUnavailable ? "#f5b26b" : "inherit",
                },
              },
              h(
                "div",
                null,
                h("strong", null, "节省量只统计「观察」模式。"),
                " 观察模式下决策模型只记录、不改变行为，于是同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活，这个对比才成立。「生效」模式下普通 LLM 路径并没有真的发生，「省了多少」只能是事后估算，因此不计入。",
              ),
              savingsUnavailable
                ? h(
                    "div",
                    { style: { marginTop: "4px" } },
                    t("本区间共 {count} 条记录，但没有一条来自观察模式——现在看到的节省量 0 是「没有可比对的数据」，不是「一点也没省」。把相关决策点切到「观察」后即可看到对比。", {
                      count: groupDigits(savingsMeta.totalRequests),
                    }),
                  )
                : null,
            )
          : null,
        // 2) 时间范围。预设清单与标签都由服务端下发（stats.presets / labels），
        //    前端不抄一份——新增一个周期只改 lib/stats.js 一处。
        h(
          "div",
          { style: S.card },
          h("div", { style: S.sectionTitle }, "时间范围"),
          presets.length === 0
            ? h("div", { style: S.pointMeta }, "正在读取可选范围…")
            : h(
                "div",
                { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                ...presets.map((preset) =>
                  h(
                    "button",
                    {
                      type: "button",
                      key: preset,
                      onClick: () => change({ preset }),
                      style: S.tabItem(filter.preset === preset),
                    },
                    labels[preset] ?? preset,
                  ),
                ),
              ),
          // 自定义：精确到分钟的起止时刻。两个都要填全才发请求
          //（缺一个时服务端只会回「需要合法的起止时间」，而那是没填完，不是错）。
          filter.preset === "custom"
            ? h(
                "div",
                { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "10px", flexWrap: "wrap" } },
                h("input", {
                  type: "datetime-local",
                  style: { ...S.input, flex: "none", minWidth: "190px" },
                  value: filter.start,
                  onChange: (event) => change({ start: event.target.value }),
                }),
                h("span", { style: { fontSize: "11px", opacity: 0.5 } }, "至"),
                h("input", {
                  type: "datetime-local",
                  style: { ...S.input, flex: "none", minWidth: "190px" },
                  value: filter.end,
                  onChange: (event) => change({ end: event.target.value }),
                }),
              )
            : null,
          // 把预设解析成的真实边界写出来：否则「本周」到底是哪几天，
          // 用户只能猜，跨时区或跨月时更是无从核对。
          range !== null && typeof range.start === "string" && range.start.length > 0
            ? h(
                "div",
                { style: { ...S.pointMeta, marginTop: "8px" } },
                t("实际区间：{start} → {end}", {
                  start: formatLocalTime(range.start),
                  end: formatLocalTime(range.end),
                }),
              )
            : null,
        ),
        // 3) 读取失败：给出原因，而不是留一排空值。
        error.length > 0
          ? h(
              "div",
              { style: { ...S.card, borderColor: "rgba(248,113,113,.5)" } },
              h(
                "div",
                { style: { color: "#f87171", fontSize: "12px" } },
                t("统计读取失败：{error}", { error }),
              ),
            )
          : null,
        // 4) 汇总。
        summaryCards.length > 0
          ? h(
              "div",
              { style: S.statsCards },
              ...summaryCards.map((item) =>
                h(
                  "div",
                  { style: S.statsCard, key: item.label },
                  h("div", { style: S.statsCardLabel }, item.label),
                  h(
                    "div",
                    { style: item.saved === true ? { ...S.statsCardValue, color: "#7dd3a0" } : S.statsCardValue },
                    item.value,
                  ),
                ),
              ),
            )
          : null,
