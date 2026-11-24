    /**
     * 横向比较条（一个指标在若干组合之间的大小）。
     *
     * 为什么用 MiniBar 而不是给每行画一根独立进度条：MiniBar 共用一条
     * 比例尺，于是「A 是 B 的两倍」在图上真的表现为两倍长；每行独立的
     * 进度条各自归一化，长度差异不再有意义。
     *
     * @param items - `[{ label, value }]`，调用方已排好序。
     */
    /**
     * 横向排序条：每一项一行，含**名称 + 比例条 + 数值**。
     *
     * 为什么不用 `charts.MiniBar`：实测它在横向模式下
     *   - 不画任何标签（`label` 只有纵向的 `"max"` 一种），于是那些柱子
     *     只有长度、没有身份——读者不知道哪根是哪个 provider；
     *   - 每一条共用**同一套**填充色，无法按条上色；
     *   - 给单条数据配 `domain` 也不能得到「按比例的长条」（实测三条不同
     *     数值画出来都是满宽），因此没法把多根柱拼成一张对齐的图。
     * 结果就是用户看到的「一排白条，没有文字、没有比例」。
     *
     * 所以这里自己画：一行一个 flex 容器，条形宽度 = value / max，
     * 名称与数值直接写在行内。形状是内联 div 而不是 SVG——这一处的信息
     * 是「文字 + 一根条」，用 DOM 排版比拼 SVG 更简单可靠，也天然支持
     * 文本溢出省略与深色主题继承。
     *
     * @param items - `[{ label, value }]`，调用方给的是**已排序**的数组。
     */
    function renderRanking(charts, items, options) {
      const data = Array.isArray(items) ? items.filter((item) => Number(item.value) > 0) : [];
      if (data.length === 0) {
        return h(
          "div",
          { key: `rank-empty/${options.label}`, style: S.chartEmpty },
          t("{label}：本区间没有数据", { label: options.label }),
        );
      }
      /**
       * 比例尺上限取**最大值**，不是总和：这里回答的是「谁最大、彼此差多少」，
       * 按总和归一化会让所有条都缩到左侧一小截，反而看不出差距。
       */
      const max = data.reduce((top, item) => Math.max(top, Number(item.value)), 0) || 1;
      const total = data.reduce((sum, item) => sum + Number(item.value), 0);
      return h(
        "div",
        { key: `rank/${options.label}`, style: S.chartRankList },
        ...data.map((item, index) =>
          h(
            "div",
            { key: `rank-row/${item.label}/${index}`, style: S.chartRankRow },
            // 名称：固定一列宽，保证所有条形的起点对齐（对齐才能比长度）。
            h(
              "span",
              {
                style: S.chartRankLabel,
                title: item.label,
              },
              item.label,
            ),
            // 条形槽：底色是满格，里面一条按比例着色，于是「差多少」看得见。
            h(
              "span",
              { style: S.chartRankTrack },
              h("span", {
                style: {
                  ...S.chartRankBar,
                  width: `${Math.max(1, (Number(item.value) / max) * 100)}%`,
                  /**
                   * 颜色按索引循环取 `--mc-cat-N`，与圆环用同一套色序：
                   * 同一个 provider/model 在两处看到的是同一种颜色语义。
                   */
                  background: `var(--mc-cat-${(index % 6) + 1})`,
                },
              }),
            ),
            // 数值 + 占比：光有长度读不出具体数，两列都给。
            h(
              "span",
              { style: S.chartRankValue },
              options.format === "ms" ? formatMs(item.value) : groupDigits(item.value),
            ),
            h(
              "span",
              { style: S.chartRankShare },
              formatRatio(total > 0 ? Number(item.value) / total : 0),
            ),
          ),
        ),
        // 屏幕阅读器需要一句汇总：上面是纯视觉的条，读屏软件读不到长度。
        h(
          "span",
          { style: { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" } },
          options.summary ?? t("{label}对比：{parts}", {
            label: options.label,
            parts: data
              .map((item) => `${item.label} ${formatRatio(total > 0 ? Number(item.value) / total : 0)}`)
              .join("、"),
          }),
        ),
      );
    }

    /**
     * 按决策点分账的圆环图（含**必需的**文字图例）。
     *
     * 为什么用圆环而不是饼图：microcharts **故意不提供饼图**。官方文档把
     * 饼图列为「词级尺寸下不可读」的一类并给了替代品。圆环（micro-donut）
     * 是库给的折中——保住「一个整体切成几份」的直觉，洞用来放总数。
     *
     * 为什么必须自己补图例：这个图型**不画分块标签、也不生成图例**，
     * 只看颜色根本分不出哪块是哪个决策点。没有图例的圆环等于一张装饰画
     * ——有「形」没有「义」。图例与颜色**按同一个索引取色**（`cat-N`
     * 循环），所以读者按顺序对得上。
     *
     * 为什么颜色不交给库自己分配：库按数据顺序取 `--mc-cat-N`；如果我在
     * 组件里再 sort 一次而图例没跟着 sort，颜色和名字就会错位——那种错位
     * 不报错，只会让人把「上下文压缩」读成「工具授权」。所以这里先排序、
     * 再用**同一个数组**同时喂给图例与图型。
     *
     * @param items - `[{ label, value }]`，调用方给的是**已排序**的数组。
     * @param options.totalLabel - 环心总数的标题（如「请求」）。
     */
    function renderPointDonut(charts, items, options) {
      const all = Array.isArray(items) ? items.filter((item) => Number(item.value) > 0) : [];
      const hidden = options.hidden instanceof Set ? options.hidden : new Set();
      const onToggle = typeof options.onToggle === "function" ? options.onToggle : null;

      if (all.length === 0) {
        return h(
          "div",
          { key: `donut-empty/${options.totalLabel}`, style: S.chartEmpty },
          t("{label}：本区间没有数据", { label: options.totalLabel }),
        );
      }

      /**
       * **颜色按「决策点 id」固定分配，不按当前显示顺序分配。**
       *
       * 这是本功能能不能用的关键：如果颜色跟着「第几个可见项」走，用户
       * 隐藏掉「工具授权」之后，原本第二名的「模型路由」会从橙色变成绿色，
       * 第三名跟着变——每一次点击整张图换一套颜色，读者就再也无法在两次
       * 操作之间比较。颜色必须绑定在**实体**上（决策点 id），而不是绑在
       * 位置序号上。
       *
       * 索引取的是 `all`（完整列表，已按次数降序）里的位置，隐藏项也占位，
       * 所以同一个决策点在显示/隐藏之间切换时颜色不变。
       */
      const colorById = new Map();
      all.forEach((item, index) => {
        colorById.set(item.id ?? item.label, `var(--mc-cat-${(index % 6) + 1})`);
      });

      const visible = all.filter((item) => hidden.has(item.id ?? item.label) !== true);
      /**
       * 隐藏项可能把可见项清空：此时不能画一个空环（那会被读成「没有数据」），
       * 而应明确提示「你把所有决策点都排除了」——那是一个可撤销的操作结果，
       * 与「这段时间没有数据」是两件事。
       */
      if (visible.length === 0) {
        return h(
          "div",
          { key: `donut-allhidden/${options.totalLabel}`, style: S.chartEmpty },
          t("所有决策点都被隐藏了，点击下面的图例可以重新显示。"),
        );
      }

      /**
       * 占比的**分母跟着可见项走**。
       *
       * 这是隐藏功能的意义所在：排除「工具授权」之后，剩下几个点的占比
       * 应该重新归一到 100%，读者才能看出「它们之间」谁大谁小。若分母
       * 始终用全量总和，隐藏后留下的会是一堆 2%、3% 的小数——比例关系
       * 依然读不出来，功能就白做了。
       *
       * 同时把「被隐藏的部分占全量多少」单独算出来，在环心与提示里说明，
       * 免得读者以为看到的就是全集。
       */
      const visibleTotal = visible.reduce((sum, item) => sum + Number(item.value), 0);
      const allTotal = all.reduce((sum, item) => sum + Number(item.value), 0);
      const hiddenTotal = allTotal - visibleTotal;
      const hiddenCount = all.length - visible.length;

      return h(
        "div",
        {
          key: `donut/${options.totalLabel}`,
          /**
           * `mc-theme` **必须挂在这一层**，不能只挂在里面的 `chartBox` 上。
           *
           * `--mc-cat-N` 在 `.mc-theme` 作用域里被重新定义（接的是 DSH 的
           * 语义色）；图例的色块在这个 div 的子节点里，却在 chartBox 的
           * **外面**——只有这一层带 mc-theme，色块才与圆环取到同一套颜色。
           * 否则图例按库的默认调色板画、圆环按主题色画，同一个决策点会显示
           * 成两种颜色，读者对不上号（而且是静默错位：图上好看，只是错的）。
           */
          className: "mc-theme",
          style: { display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap", marginTop: "8px" },
        },
        chartBox(
          "donut-chart",
          h(charts.MicroDonut, {
            data: visible.map((item) => ({ label: item.label, value: Number(item.value) })),
            /**
             * 颜色显式按 id 传进去（顺序与 `data` 对齐）。
             *
             * 不传 `colors` 时库按「第几个」取 `--mc-cat-N`，隐藏一个点之后
             * 后面所有点的颜色都会前移一位——那正是上面说的「每次点击整张
             * 图换一套颜色」。显式传就把颜色钉在实体上。
             */
            colors: visible.map((item) => colorById.get(item.id ?? item.label)),
            size: 132,
            label: "total",
            /**
             * **不接 `onActive` / `onSelect`。**
             *
             * 交互版圆环自带两件事：高亮当前楔形，以及在图上方弹出自己的读数
             * 气泡（`.mc-spark-readout`，内容是「工具授权 75%, 120」——名字、
             * 占比、次数都在里面）。它是图型内部的状态，不需要外部回调。
             *
             * 以前这里额外接了回调，把楔形数据抄到 React state 里，再在**图
             * 下面**自己画一行读数。那是重复：同一件事说两遍，还多占一行版面
             * （而且两处措辞不同时，读者会以为是两个不同的数）。图自己会说，
             * 界面就别抢着再说一遍。
             *
             * 不传 `weight`：实测这个参数只在**缺省**时取默认厚度（5），
             * 显式传任何值都会塌成 1px——环变成一根几乎看不见的细线。
             * 这是库的 bug，绕过方式是不传。
             */
            // 长尾不合并：决策点最多 8 个，全都该有自己的颜色与图例项。
            // 合并成 Other 会让「某个决策点到底花了多少」这个问题失去答案。
            maxWedges: 12,
            summary: t(
              "按决策点分账：{parts}",
              {
                parts: visible
                  .map((item) => `${item.label} ${formatRatio(visibleTotal > 0 ? Number(item.value) / visibleTotal : 0)}`)
                  .join("、"),
              },
            ),
            title: options.totalLabel,
          }),
        ),
        // ---- 图例：可点击切换，圆环没有它就等于没有信息 ----
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1 1 170px" } },
          ...all.map((item) => {
            const id = item.id ?? item.label;
            const isHidden = hidden.has(id) === true;
            /**
             * 占比始终相对**可见总量**显示，与圆环一致；隐藏项显示它自己
             * 的绝对值（次数），并附「已隐藏」——让读者知道这块被排除了、
             * 原值是多少，而不是让它凭空消失。
             */
            const share = visibleTotal > 0 ? Number(item.value) / visibleTotal : 0;
            return h(
              "button",
              {
                type: "button",
                key: `donut-legend/${id}`,
                /**
                 * 用 `<button>` 而不是带 onClick 的 `<div>`：图例项是**可操作的
                 * 控件**，键盘用户必须能用 Tab 走到、用 Enter/Space 触发。
                 * 用 div 就只能用鼠标，而且读屏软件不会念成「按钮」。
                 */
                onClick: onToggle === null ? undefined : () => onToggle(id),
                disabled: onToggle === null,
                title: isHidden
                  ? t("点击重新显示「{label}」", { label: item.label })
                  : t("点击隐藏「{label}」，方便查看其他决策点的比例", { label: item.label }),
                "aria-pressed": isHidden !== true,
                style: {
                  ...S.chartLegendBtn,
                  opacity: isHidden ? 0.4 : 1,
                },
              },
              h("span", {
                style: {
                  ...S.chartLegendSwatch,
                  background: colorById.get(id),
                  // 隐藏项留一个空心方块：颜色还在（提示「这是哪个点」），
                  // 但不再是实心（提示「它当前不在图里」）。
                  opacity: isHidden ? 0.35 : 1,
                },
                "aria-hidden": "true",
              }),
              h(
                "span",
                {
                  style: {
                    flex: "1 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textDecoration: isHidden ? "line-through" : "none",
                  },
                },
                item.label,
              ),
              h(
                "span",
                { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } },
                isHidden ? t("已隐藏") : formatRatio(share),
              ),
            );
          }),
        ),
        /**
         * 有隐藏项时把「被排除掉的那部分」写出来。
         *
         * 不给这句的话，读者看到的是一张看起来完整的圆环（重新归一化后
         * 依然是 100%），却不知道它只覆盖了全量的一部分——那是这页最容易
         * 被误读成「这就是全部」的地方。
         *
         * 注意这里**不再有「当前 hover 的楔形」那一行**：交互版圆环自带
         * 读数气泡（见上面的 onActive 注释），图下方再挂一行是把同一件事
         * 说两遍，还会让人以为两处数字不一致。
         */
        hiddenCount > 0
          ? h(
              "div",
              { style: { flexBasis: "100%", fontSize: "11px", opacity: 0.6, marginTop: "2px" } },
              t("已隐藏 {count} 个决策点（占全量 {share}），图中的比例按剩余部分重新计算。", {
                count: hiddenCount,
                share: formatRatio(allTotal > 0 ? hiddenTotal / allTotal : 0),
              }),
            )
          : null,
      );
    }

