        // 4.4) 走势（图表）：区间内的节奏。
        //
        // 放在汇总卡片之后、裁决之前：卡片给的是**总量**，走势回答的是
        // 「这些量是怎么分布的」——是先忙后闲，还是中间掉过一段。
        // 总量与节奏是两个问题，顺序上也该照着这两个问题排。
        //
        // `charts === null` 时整块不渲染（降级成只有卡片与表格）：
        // 拿不到图表库不影响任何数字的呈现，只是少了一层形状。
        charts !== null && seriesBuckets.length > 1 && totals !== null
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "走势"),
              h(
                "div",
                { style: { ...S.pointMeta, marginTop: "-2px" } },
                t("按{bucket}分桶，共 {count} 个桶；空桶补 0，掉到零就是真的没有请求。", {
                  bucket: series.bucket === "hour" ? t("小时") : series.bucket === "day" ? t("天") : t("月"),
                  count: groupDigits(seriesBuckets.length),
                }),
              ),
              /**
               * 有未来段时才补这一句，没有就整行不出现。
               *
               * 为什么要单列一行而不是拼进上面那句：上面那句讲的是**口径**
               * （空桶补 0），这句讲的是**线型**（虚线 = 还没到）。两件事混在
               * 一句里，读者会把「掉到零就是真的没有请求」也用到大区间尾部那段
               * 平线上——而那段可能压根还没发生。
               * 反过来，没有未来段时这话是多余的，还会让人以为「图上有虚线」。
               *
               * `trendHasData` 这个前提**不能省**：区间全零时每张图都退成了
               * 「本区间没有数据」占位，屏幕上没有虚线可解释（见它上方注释）。
               */
              seriesFutureCount > 0 && trendHasData
                ? h(
                    "div",
                    { style: { ...S.pointMeta, marginTop: "-4px" } },
                    t("虚线段是区间内还没到的时间，不计入读数。"),
                  )
                : null,
              ...(
                [
                  { key: "requests", label: "请求次数" },
                  { key: "inputTokens", label: "input token" },
                  { key: "durationMs", label: "总耗时" },
                ]
              ).map((item) =>
                h(
                  "div",
                  { key: `trend-block/${item.key}`, style: S.chartTrendBlock },
                  h(
                    "div",
                    { style: S.chartTrendLabel },
                    h("span", null, t(item.label)),
                    h("span", { style: { fontFamily: "ui-monospace, Menlo, monospace" } },
                      item.key === "durationMs"
                        ? formatMs(totals.durationMs)
                        : groupDigits(totals[item.key])),
                  ),
                  renderTrend(charts, series.series?.[item.key] ?? [], {
                    label: t(item.label),
                    summary: t("{label}随时间变化", { label: t(item.label) }),
                    buckets: seriesBuckets,
                    /**
                     * 「第一个还没开始的桶」的下标，原样透传服务端那个字段。
                     *
                     * 不在这里做校验、也不在这里换算成「有没有未来段」：
                     * `renderTrend` 里的 `sparkFutureIndex` 是唯一口径，两处都判
                     * 就会出现「图切了、说明没切」这类对不上的情况。
                     */
                    nowIndex: series?.nowIndex,
                    /**
                     * hover / 点选时把当前点报上来。
                     *
                     * `onActive` 是「鼠标移过」——移动时读数跟着走；
                     * `onSelect` 是「点一下钉住」——钉住后移动鼠标也不再变，
                     * 再点一次取消。两者都要，因为读数气泡本身很小，
                     * 钉住才看得到准数。
                     */
                    onActive: (datum) => {
                      if (datum === null || datum === undefined) {
                        setTrendReadout(null);
                        return;
                      }
                      setTrendReadout({
                        label: shortBucketLabel(seriesBuckets[datum.index] ?? ""),
                        value: datum.value,
                        index: datum.index,
                        metric: item.label,
                      });
                    },
                    onSelect: (datum) => {
                      // 点空白处（datum 为 null）= 取消钉住。
                      if (datum === null || datum === undefined) {
                        setTrendReadout(null);
                        return;
                      }
                      setTrendReadout({
                        label: shortBucketLabel(seriesBuckets[datum.index] ?? ""),
                        value: datum.value,
                        index: datum.index,
                        metric: item.label,
                      });
                    },
                    /**
                     * 图下方的读数行：当前点的「时间 · 数值」。
                     *
                     * 没有当前点时显示一句提示，告诉读者「可以移上去看」——
                     * 空白会让读者以为图是死的。
                     */
                    readout: () =>
                      trendReadout !== null && trendReadout.metric === item.label
                        ? h(
                            "div",
                            { style: S.chartReadout },
                            h("span", { style: { opacity: 0.7 } }, trendReadout.label),
                            h(
                              "span",
                              { style: { fontVariantNumeric: "tabular-nums", fontWeight: 600 } },
                              item.key === "durationMs"
                                ? formatMs(trendReadout.value)
                                : groupDigits(trendReadout.value),
                            ),
                          )
                        : h(
                            "div",
                            { style: { ...S.chartReadout, opacity: 0.5 } },
                            t("把鼠标移到图上看某一格的具体值"),
                          ),
                  }),
                ),
              ),
            )
          : null,
