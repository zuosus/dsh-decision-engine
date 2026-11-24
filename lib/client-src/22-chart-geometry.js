    /* ============================================================
     * 统计页的图型封装
     *
     * 这一层只做三件事，刻意不含任何统计口径：
     *   1. 把服务端给的字段**原样**喂给图型（不在这里重算、不四舍五入后再算）；
     *   2. 给每个图型一个可读的中文无障碍摘要（库默认是英文，读者会莫名其妙）；
     *   3. 统一尺寸与容器（统计页里图与数字并排，尺寸不一致会看到参差的基线）。
     *
     * 为什么不在渲染里内联 `charts.Sparkline({...})`：同一张图在统计页出现
     * 三处（走势、对比、节省），尺寸和摘要文案必须一致；散在三个地方写，
     * 改一次尺寸要改三处，很快就会有两处忘记改。
     * ============================================================ */

    /**
     * 图型容器：把图表包成一个 inline-flex 的中性盒子。
     *
     * `aria-hidden` **不加**——图型自己带 `role="img"` 与摘要，
     * 那是给读屏用户的正式内容，藏起来等于把图里的信息只留给看得见的人。
     */
    function chartBox(key, children, extra) {
      /**
       * **第三个参数只能是样式对象，不能是 React 元素。**
       *
       * 真机事故：这里曾被传入 `options.readout()` 返回的元素，`{...extra}`
       * 把元素展开进了 style，style 里出现 `type`/`props`/`children` 这些
       * 非法键。React 设置样式时抛 TypeError → 整棵树被卸载 → 用户看到的是
       * 「点一下统计页，连配置 tab 一起消失」的白屏。
       *
       * 下面这层防御把「误传元素」变成**可读的警告 + 忽略**，而不是让整页崩掉。
       * 它防的是同一类错误再次发生：任何把非样式对象塞进第三个参数的调用，
       * 都不会再拖垮整个页面。
       */
      let styles = extra ?? null;
      if (styles !== null && typeof styles === "object") {
        const looksLikeElement =
          Object.hasOwn(styles, "type") ||
          Object.hasOwn(styles, "props") ||
          Object.hasOwn(styles, "$$typeof");
        if (looksLikeElement) {
          try {
            console.warn(
              "[dsh-decision-engine] chartBox: extra must be a style object, got a React element — ignored.",
            );
          } catch {
            /* 忽略 */
          }
          styles = null;
        }
      }
      return h(
        "span",
        { key, className: "de-chart mc-theme", style: { ...S.chartBox, ...(styles ?? {}) } },
        children,
      );
    }

    /* ============================================================
     * 走势图几何：与 vendored microcharts 的内部布局逐位对齐
     *
     * 为什么这里要自己算坐标：区间上界常常延伸到未来（today → 次日 0 点、
     * month → 月末、year → 年末），尾部那批「还没到的时间」的桶恒为 0。
     * 过去与未来画成同一条同色同粗的实线，读者分不清哪段是真发生过的。
     * 做法是**只把过去段交给库**：未来点在 `data` 里置 `null`，库把非有限
     * 值当断点（线停在边界），hover 与键盘漫游也自动跳过未来的桶——没发生
     * 的时间不该给出「0 次」的读数。未来段由我们自己往 Sparkline 的
     * `children` 里塞一条 `<path data-mc-ink="muted">`。
     *
     * 虚线必须与实线**接在同一个点上**，所以坐标公式只能照抄库的那一套
     * （`le()` 布局 / `Nt()` 值域 / `it()` 缩放 / `g()` 取整 / `ee()` 拼路径）。
     *
     * 做错会怎样：这里与库的布局只要差一点，虚线就会与实线错位或整体平移，
     * 而错位表现为「图看着挺正常，就是两头接不上」——肉眼很难确认，人只会
     * 以为数据有问题。所以下面这几个函数**为可测而导出**（见文件末尾
     * `exports.sparkTrend*`）：`test/client-charts-chunk.test.js` 用**同一份
     * vendored 产物**渲染 Sparkline，把库自己算出的顶点与这里算出的逐位比对。
     * 将来重跑 `scripts/build-microcharts.mjs` 升级 microcharts、库改了 pad
     * 或抽稀规则时，那条测试立刻红，而不是让用户先看到错位的线。
     * ============================================================ */

    /** 库的 `g()`：坐标保留 2 位小数（非有限值原样返回，与库一致）。 */
    function sparkRound(value) {
      const rounded = Math.round(value * 100) / 100;
      return Number.isFinite(rounded) ? rounded : value;
    }

    /** 库的 `L()`：只有有限数字才算「有值」；null / NaN / Infinity 都是断点。 */
    function sparkHasValue(value) {
      return typeof value === "number" && Number.isFinite(value);
    }

    /** 库的 `X(v, fallback)`：宽高必须是正有限数，否则退回默认视口尺寸。 */
    function sparkSize(value, fallback) {
      return Number.isFinite(value) && value > 0 ? value : fallback;
    }

    /**
     * 库的 `Nt(values, zero)`：值域（缩放的两端）。
     *
     * 关键：**必须对原始序列算**，不能对 null 化之后的序列算。库会自动忽略
     * 非有限值，于是「未来段有几格」会改变过去段的形状——同一份数据在有无
     * 未来段时画出两种坡度，那比虚线缺席严重得多（读者的比较基准被偷偷改了）。
     *
     * @param values - 原始数值序列（含未来段）。
     * @param zero - 对应库的 `fill`（面积图必须从 0 起算，否则填色形状不对）。
     * @returns `[min, max]`；一个有限值都没有时是 `[0, 1]`。
     */
    function sparkDomain(values, zero) {
      let low = Infinity;
      let high = -Infinity;
      for (const value of values) {
        if (!sparkHasValue(value)) continue;
        if (value < low) low = value;
        if (value > high) high = value;
      }
      if (low === Infinity) return [0, 1];
      if (zero === true) {
        if (low > 0) low = 0;
        if (high < 0) high = 0;
      }
      if (low === high) {
        // 一条水平线：库给 ±half 的量程把它撑开，全 0 且需要基线时退到 [0, 1]。
        const spread = low === 0 ? 1 : Math.abs(low) * 0.5;
        return zero === true && low === 0 ? [0, spread] : [low - spread, high + spread];
      }
      return [low, high];
    }

    /**
     * 库的 `le()`：在我们这一支配置下（`label:"none"`、无 `band`、没有 label
     * 气泡 → `gutterRight = gutterTop = gutterBottom = 0`）的绘图盒与顶点。
     *
     * @param values - 原始数值序列（**含未来段**）：x 按全长排布，
     *   `n` 必须等于桶数，否则虚线与实线的顶点下标对不上。
     * @param options.width / options.height - 视口尺寸（先过 `sparkSize`）。
     * @param options.domain - 显式值域；不传时按 `sparkDomain(values, zero)`。
     * @param options.zero - 面积模式，只影响自动值域。
     * @returns 与库同序的点数组：`{x, y, value, index}`，非有限值处为 `null`。
     */
    function sparkTrendGeometry(values, options = {}) {
      const width = sparkSize(options.width, 80);
      const height = sparkSize(options.height, 20);
      const domain =
        Array.isArray(options.domain) && options.domain.length === 2
          ? [Number(options.domain[0]), Number(options.domain[1])]
          : sparkDomain(values, options.zero === true);
      const pad = 2;
      const x0 = pad;
      const x1 = width - pad;
      const yTop = pad;
      const yBottom = height - pad;
      const span = domain[1] - domain[0];
      const slope = (yTop - yBottom) / span;
      // 库的 `it()` 在斜率 / 跨度 / 起点任一不持限时整条缩放退化成中线
      // （水平序列或退化值域就是这种情形），这里必须做同样的判断。
      const flat =
        !Number.isFinite(slope) || !Number.isFinite(span) || !Number.isFinite(domain[0]);
      const valueToY = flat
        ? () => (yTop + yBottom) / 2
        : (value) => yBottom + (value - domain[0]) * slope;
      const count = values.length;
      const points = new Array(count);
      for (let index = 0; index < count; index++) {
        const value = values[index];
        if (!sparkHasValue(value)) {
          points[index] = null;
          continue;
        }
        points[index] = {
          x: sparkRound(count > 1 ? x0 + (index * (x1 - x0)) / (count - 1) : (x0 + x1) / 2),
          y: sparkRound(valueToY(value)),
          value,
          index,
        };
      }
      return { points, domain, width, height };
    }

    /**
     * 库的 `ee()`（linear 曲线）：把点串成 `d` 字符串。
     *
     * 分段规则照抄库的 `Yt()`：遇 `null` 收尾一段，**每段各起一个 `M`**，段内
     * 用 `" L"` 连接（分隔符就是字母 L 前面那个空格，不是逗号）。自己拼一套
     * 分隔符，浏览器会整条路径解析失败——表现是虚线根本不出现，且不报错。
     */
    function sparkTrendPath(points) {
      const segments = [];
      let current = [];
      for (const point of points) {
        if (point === null || point === undefined) {
          if (current.length > 0) segments.push(current);
          current = [];
          continue;
        }
        current.push(`${sparkRound(point.x)} ${sparkRound(point.y)}`);
      }
      if (current.length > 0) segments.push(current);
      return segments.map((segment) => `M${segment.join(" L")}`).join(" ");
    }

    /**
     * 把服务端下发的 `series.nowIndex` 收敛成一定能用的下标。
     *
     * `nowIndex` 是「第一个还没开始的桶」的下标，由服务端算好下发（时间运算
     * 只在一处出现，见 lib/stats.js 的 `futureStartIndex`）。
     *
     * 缺失 / 不是整数（字符串、NaN、Infinity、小数）/ 越界 → 一律返回 `length`，
     * 即「没有未来段」。这是**向后兼容的硬要求**：老的服务端响应里根本没有这个
     * 字段，界面必须和以前一模一样——既不能凭空画一段假虚线，也不能抛异常
     * （渲染期一抛就是整页白屏，DEC-056 那种事故）。
     */
    function sparkFutureIndex(nowIndex, length) {
      if (!Number.isInteger(nowIndex)) return length;
      return Math.min(Math.max(nowIndex, 0), length);
    }

