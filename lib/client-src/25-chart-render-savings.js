    /**
     * 目标达成条（实际 vs 基线）。
     *
     * 节省量天然是这个形状：基线是「本该花多少」，实际是「真的花了多少」。
     * Bullet 把两个数画在同一条轴上，于是「省了多少」是**看得见的长度差**，
     * 而不是要心算的两个数字。
     */
    function renderSavingsBullet(charts, baseline, actual, label) {
      const base = Number(baseline ?? 0);
      const real = Number(actual ?? 0);
      if (base <= 0) {
        return h(
          "div",
          { key: `bullet-empty/${label}`, style: S.chartEmpty },
          t("{label}：没有可对比的基线", { label }),
        );
      }
      return chartBox(
        `bullet/${label}`,
        h(charts.Bullet, {
          value: real,
          target: base,
          domain: [0, Math.max(base, real)],
          width: 260,
          height: 20,
          label: "both",
          color: "currentColor",
          summary: t("{label}：实际 {real}，基线 {base}", {
            label,
            real: groupDigits(real),
            base: groupDigits(base),
          }),
          title: label,
        }),
      );
    }

    /**
     * 有符号变化（节省比例这类 +/- 数字）。
     *
     * `positive:"down"` 是刻意的：这里的 value 是「消耗相对基线的变化」，
     * 消耗下降才是好事，颜色语义必须跟着这个方向，否则「省了 30%」会
     * 被染成警示色。
     */
    function renderDelta(charts, value, label) {
      const number = Number(value ?? 0);
      if (!Number.isFinite(number) || number === 0) {
        return h(
          "div",
          { key: `delta-empty/${label}`, style: S.chartEmpty },
          t("{label}：本区间没有可对比的变化", { label }),
        );
      }
      return chartBox(
        `delta/${label}`,
        h(charts.Delta, {
          value: number,
          positive: "down",
          summary: t("{label}：{value}", {
            label,
            value: formatRatio(number),
          }),
        }),
      );
    }

    /**
     * 统计 tab 的整页内容。
     *
     * 为什么写成独立一节而不是配置页里的一小块：统计要回答的是「钱花在
     * 哪个 provider 的哪个模型上」「比不开插件省了多少」，这两件事都需要
     * 一整屏的横向空间（对比表十来列）。挤在表单末尾时既看不清，也让
     * 本来就长的配置页更难用。
     *
     * 这里是**纯渲染**：不碰任何状态、不发请求。聚合口径全部在服务端
     * （lib/stats.js），前端只负责把结果排出来——前端再算一遍必然出现
     * 「界面与导出数据对不上」。
     *
     * @param props.stats - `/stats` 的响应；null 表示还在读。
     * @param props.error - 读取失败的原因。
     * @param props.filter - 当前筛选（preset / start / end / sort / dir）。
     * @param props.setFilter - 替换筛选（新对象，触发重查）。
     * @param props.reload - 用当前筛选强制重查。
     * @param props.pointLabels - 决策点 id → 中文名。
     * @param props.providerLabels - provider id → 展示名。
     */
    /**
     * 统计页渲染的**保护壳**：任何异常都变成页面上的一段红字，而不是白屏。
     *
     * 为什么要这一层（这是真机上踩出来的）：
     * 统计页是一个纯渲染大函数，里面画了表格、走势图、圆环、排序条。只要
     * 其中**任何一处**抛出异常，React 就会卸载整棵组件树——用户看到的是
     * 「点一下『统计与对比』，连『配置』tab 一起消失了」，页面变成一片空白。
     *
     * 那种白屏对用户毫无信息，对我们更是**零线索**：Console 里往往只有一句
     * `The above error occurred in…`，看不出是哪一块、哪个字段。而统计页的
     * 数据全部来自服务端（`/stats` 的形状随版本变），一条缺字段的记录就能
     * 让某张图崩掉——这种情况会一直存在，所以必须让它**降级而不是炸掉**。
     *
     * 取舍：这里不试图「修复」异常，只做两件事——
     *   1. 把异常圈在统计页内，配置 tab 与页面外壳照常可用（用户至少能切回去）；
     *   2. 把错误信息**显示在页面上**（含出错组件名与消息），让问题可被看见、
     *      可被截图反馈，而不是逼人去翻 Console。
     *
     * @param props - 透传给 `renderStatsTab` 的全部参数。
     */
    function safeRenderStatsTab(props) {
      try {
        return renderStatsTab(props);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
        try {
          console.error("[dsh-decision-engine] stats page render failed:", error);
        } catch {
          /* 忽略 */
        }
        return h(
          "div",
          { key: "stats-render-failed" },
          h("div", { style: S.title }, t("统计页渲染失败")),
          h(
            "div",
            { style: { ...S.card, borderColor: "rgba(248,113,113,.5)", marginTop: "10px" } },
            h(
              "div",
              { style: { color: "#f87171", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" } },
              message,
            ),
            h(
              "div",
              { style: { ...S.pointMeta, marginTop: "8px" } },
              t("数字本身没有丢：切回「配置」再切回来，或在 Console 里看完整堆栈。这条提示是为了让异常不再表现为整页空白。"),
            ),
            stack.length > 0
              ? h(
                  "details",
                  { style: { marginTop: "8px" } },
                  h("summary", { style: { fontSize: "11px", opacity: 0.6, cursor: "pointer" } }, t("完整堆栈")),
                  h(
                    "pre",
                    {
                      style: {
                        fontSize: "10px",
                        lineHeight: 1.5,
                        opacity: 0.7,
                        maxHeight: "220px",
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        margin: "6px 0 0",
                      },
                    },
                    stack,
                  ),
                )
              : null,
          ),
        );
      }
    }

