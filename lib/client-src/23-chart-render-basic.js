    /**
     * 走势图（单指标随时间）。
     *
     * 空数据 / 全零时**不画图**：一条贴底的直线会被读成「一直很平稳」，
     * 而事实是「这段时间没有请求」。两种情况必须分开——这正是本插件
     * 在统计口径上反复强调的那条原则（0 与「无数据」不是一回事）。
     *
     * 未来段（`options.nowIndex` 起）画成淡色虚线：过去段交库时置 null 断掉，
     * 虚线段自己画，详见上面「走势图几何」那段注释。
     *
     * @param charts - 图表模块。
     * @param values - 与 buckets 等长的数值序列。
     * @param options.label - 中文指标名（用于摘要与标题）。
     * @param options.width - 视口宽（默认 260，统计页卡片内的一整行）。
     * @param options.nowIndex - 服务端下发的「第一个还没开始的桶」下标；缺省时完全没有未来段。
     */
    function renderTrend(charts, values, options) {
      const series = Array.isArray(values) ? values : [];
      const hasData = series.some((value) => Number(value) > 0);
      if (hasData !== true) {
        return h(
          "div",
          { key: `trend-empty/${options.label}`, style: S.chartEmpty },
          t("{label}：本区间没有数据", { label: options.label }),
        );
      }
      /**
       * 每个点的**时间标签**。
       *
       * 交互版的图型支持 `labels`：把「第几个点」说成「几点几分」而不是
       * 「第 7 个点」。没有它，hover 读数只会念一个没有信息量的序号——
       * 而读者真正想知道的是「那个尖峰是几点的事」。
       *
       * 桶键形如 `2026-11-10T14`（小时）、`2026-11-10`（天）、`2026-11`（月），
       * 这里统一缩成「14时」「10日」「11月」这类短标签——viewBox 只有 260px
       * 宽，长时间戳放不进读数气泡。
       */
      const labels = (Array.isArray(options.buckets) ? options.buckets : []).map((key) =>
        shortBucketLabel(key),
      );
      const width = options.width ?? 260;
      const height = options.height ?? 34;
      // 库的 `fill` 同时是它的 `zero`：面积图的基线必须是 0，值域才会把 0 收进去。
      const zero = options.fill === true;
      const length = series.length;
      const futureFrom = sparkFutureIndex(options.nowIndex, length);
      /**
       * 只有 `1 <= futureFrom < length` 才切分过去 / 未来。
       *
       * - `futureFrom === length`（含字段缺失、非法值）：没有未来段，行为与
       *   以前**逐字节相同**，这是向后兼容的那条路。
       * - `futureFrom === 0`：整段都在未来，一个「已发生」的点都没有。虚线段
       *   的规矩是**从最后一个已发生的点起笔**，这里没有起笔点；退回旧行为
       *   而不是凭空造一个起点、也不把整张图画成虚线——区间都已经过去时读者
       *   要的是形状，「全是虚的」既不成立也没有信息量。
       * - `length <= 1`：单个点谈不上「段」，切了只是把一个点改画成两种线型。
       */
      const splitFuture = length > 1 && futureFrom >= 1 && futureFrom < length;
      const futureCount = splitFuture ? length - futureFrom : 0;
      /**
       * 交给库的序列：未来索引处置 `null`。
       *
       * 库把非有限值当断点，所以实线停在边界；同时 `onActive` 的候选点集合里
       * 只剩过去的桶，hover 与键盘漫游**自动跳过**未来的桶（没发生的时间不该
       * 给出「0 次」的读数）——这两条都是我们要的副作用。
       * 不复制、不 null 化时（`splitFuture === false`）连数组都不新建。
       */
      const data = splitFuture
        ? series.map((value, index) => (index >= futureFrom ? null : value))
        : series;
      /**
       * 值域与虚线段。
       *
       * `domain` 由我们**显式传给库**：不传的话库会拿 null 化之后的序列自己算，
       * 于是过去段的缩放随「后面挂了几格未来」漂移，实线与虚线也不是同一套缩放。
       * 值域始终按**原始** `series` 算，未来的 0 照样参与缩放（旧行为如此，
       * 形状不因这次改动而变）。
       */
      const domain = splitFuture ? sparkDomain(series, zero) : null;
      // 虚线段覆盖 [futureFrom - 1, length - 1]：多取前面那一个已发生的点，
      // 好让它与实线段严丝合缝地接上；未来的值本身不是有限数时照样断成子路径。
      const futurePathD = splitFuture
        ? sparkTrendPath(
            sparkTrendGeometry(series, { width, height, domain }).points.slice(futureFrom - 1),
          )
        : "";
      /**
       * 走势图 + 读数行。
       *
       * **读数必须是图表的兄弟节点，绝不能塞进 `chartBox` 的第三个参数。**
       * `chartBox(key, children, extra)` 的第三个参数是**样式对象**：
       * 曾经把 `options.readout()` 的 React 元素传进去，结果那个元素被展开进
       * `style`（`{...S.chartBox, ...element}`），style 里出现了 `type`/`props`/`children`
       * 这类非法键——React 设置样式时抛异常，整棵组件树被卸载，用户看到的
       * 就是「点统计页，连配置 tab 一起消失」。
       */
      return h(
        "div",
        { key: `trend/${options.label}`, style: { display: "flex", flexDirection: "column", minWidth: 0 } },
        chartBox(
          "trend-chart",
          h(charts.Sparkline, {
            data,
            width,
            height,
            fill: zero,
            dots: "auto",
            label: "none",
            // 见上面的注释：值域必须由我们给定，两边才共用同一套缩放。
            domain: domain ?? undefined,
            /**
             * 顶点数必须等于桶数：库默认 `maxPoints = 200`，超过就做 min/max
             * 抽稀，`linePoints` 的顶点就不再逐桶对应，我们画的虚线在长区间
             * （year + 日桶 = 365 格）上会和实线错开好几天。桶键上限是 400
             * （lib/stats.js 的 `bucketKeys` MAX_KEYS），400 个顶点完全画得动。
             *
             * 只在**有未来段**时才关抽稀：没有虚线要接的时候，库自己的抽稀是
             * 它一直以来的画法，这里不动它——「没有未来段 = 旧行为完全不变」是
             * 这次改动的向后兼容底线。
             */
            maxPoints: splitFuture ? length : undefined,
          // 中文摘要：库的默认摘要是英文（"Trending up 400%…"），
          // 在这个全中文的界面里会显得突兀，读屏用户也会困惑。
            summary:
              (options.summary ?? `${options.label}走势`) +
              // 读屏用户看不见线型，虚线的含义只能写进摘要里。
              (futureCount > 0
                ? t("（虚线为未来 {count} 个桶，尚未发生）", { count: groupDigits(futureCount) })
                : ""),
            title: options.label,
          /**
           * 交互能力：hover 出读数、点选钉住、键盘可漫游。
           *
           * `labels` 让读数念出时间而不是序号；`onActive` / `onSelect` 把
           * 当前点回传给调用方（用于在图下方显示「14时：128 次」）。
           * 传 `null`（而不是不传）会关掉回调——不传的话库会用内部默认值，
           * 我们拿不到当前点的信息。
           */
            labels: labels.length === series.length ? labels : undefined,
            onActive: typeof options.onActive === "function" ? options.onActive : undefined,
            onSelect: typeof options.onSelect === "function" ? options.onSelect : undefined,
            /**
             * 未来段那条虚线：一个 `<path>` 子节点，由库原样渲染进同一个 svg
             * （交互版把 `children` 转给静态图型，静态图型把它排在图形之后）。
             *
             * 为什么用 `data-mc-ink="muted"` 而不是自己写颜色：vendored 样式里
             * 已有 `:where(.mc-root [data-mc-ink=muted]){fill:none;stroke:var(--mc-neutral)}`
             * 与 `:where(.mc-spark-interactive [data-mc-ink=muted]){stroke-dasharray:1.5 2}`。
             * 而 `--mc-neutral` 在本插件的主题覆盖里接的是 DSH 的
             * `--dsw-alias-label-tertiary`（淡色）， muted 又**没有**设 stroke-width
             * （库只给 `[data-mc-ink=data]` 设 `--mc-sw`），于是线宽从 1.5 降到默认 1。
             * **淡色 + 虚线 + 略细**三条一次满足，深色 / 浅色 / 高对比
             * （forced-colors 下 muted → GrayText）全都自动成立。
             * 硬编码颜色会在深色主题或高对比模式下变成看不见的线，所以这里不写。
             *
             * 唯一显式写下的 `fill:none` 是给 forced-colors 兜底的：那一档里库把
             * muted 规则改成 `fill:GrayText`（那是给矩形/圆点这类标记准备的），
             * 一条敞口的折线被填充就会变成一块实心灰斑。内联样式压得过那条规则，
             * 普通模式下 muted 本来就是 fill:none，所以没有任何视觉变化。
             */
            children: splitFuture && futurePathD !== ""
              ? h("path", { "data-mc-ink": "muted", style: { fill: "none" }, d: futurePathD })
              : undefined,
          }),
        ),
        // 有回调时，图下方显示当前点的具体读数（hover 移动、点击钉住）。
        typeof options.readout === "function" ? options.readout() : null,
      );
    }

    /**
     * 把桶键缩成短标签：`2026-11-10T14` → `14时`。
     *
     * 为什么不用原始键：`2026-11-10T14` 有 13 个字符，viewBox 只有 260px，
     * 读数气泡放不下；而且读出来是机器格式，读者要自己在脑子里换算成
     * 「下午两点」。按桶粒度取最有意义的那一段：
     *   小时 → `14时`    天 → `10日`    月 → `11月`
     *
     * @param key - 桶键（见 lib/stats.js 的 bucketKey）。
     * @returns 短标签；格式不认识时原样返回。
     */
    function shortBucketLabel(key) {
      const text = String(key ?? "");
      if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(text)) return `${text.slice(11, 13)}时`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${Number(text.slice(8, 10))}日`;
      if (/^\d{4}-\d{2}$/.test(text)) return `${Number(text.slice(5, 7))}月`;
      return text;
    }

    /**
     * 占比构成条（allow / ask / reject）。
     *
     * 这三个数天然构成一个整数：每次裁决必然落在其中一格。用分段条
     * 而不是饼图是刻意的——饼在这么窄的卡片里角度差读不出来，而
     * 并排的分段条能直接比长度。
     *
     * 全零时不画：一条纯背景色的空条会让读者以为「裁决了但全是别的东西」。
     */
    function renderOutcomeBar(charts, outcomes, options) {
      /**
       * `options` 可省略：调用方只想要「一张构成条」时不必传回调。
       *
       * 这里曾经漏掉这个形参，函数体里却引用 `options.onActive`——那是一个
       * **未声明变量**，在严格模式下直接抛 ReferenceError。React 渲染期
       * 一抛异常就会卸载整棵树，于是用户看到的是「点统计页，连配置 tab
       * 一起消失」。测试没抓到，是因为测试注入的是图表替身、且 `outcomes`
       * 多为空，这条分支没被走到。
       */
      const opts = options ?? {};
      const allow = Number(outcomes?.allow ?? 0);
      const ask = Number(outcomes?.ask ?? 0);
      const reject = Number(outcomes?.reject ?? 0);
      const total = allow + ask + reject;
      if (total <= 0) {
        return h(
          "div",
          { key: "outcome-bar/empty", style: S.chartEmpty },
          t("本区间没有裁决记录"),
        );
      }
      return chartBox(
        "outcome-bar",
        h(charts.SegmentedBar, {
          data: [
            { label: t("放行"), value: allow },
            { label: t("询问"), value: ask },
            { label: t("拦截"), value: reject },
          ],
          /**
           * 交互：hover/点选某一段时，那一段会高亮，并给出读数。
           * 静态图上三段并列，读者要靠长度猜「哪段是 ask」；交互后指针
           * 指到哪段就明确是哪段。
           */
          onActive: (datum) => {
            if (typeof opts.onActive === "function") opts.onActive(datum);
          },
          onSelect: (datum) => {
            if (typeof opts.onSelect === "function") opts.onSelect(datum);
          },
          // 顺序固定成 allow→ask→reject（从绿到红），不按大小重排：
          // 这三格是**固定语义**而不是「谁多谁少」，重排会让同一格
          // 在不同区间换颜色，读者没法跨区间对比。
          order: "data",
          width: 260,
          height: 20,
          label: "percent",
          summary: t("裁决构成：放行 {allow}、询问 {ask}、拦截 {reject}", {
            allow: groupDigits(allow),
            ask: groupDigits(ask),
            reject: groupDigits(reject),
          }),
          title: t("裁决构成"),
        }),
      );
    }

