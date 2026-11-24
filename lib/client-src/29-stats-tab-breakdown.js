        // 6) 按决策点分账：同一个 provider/model 上，哪个点在花钱一目了然。
        Array.isArray(stats?.byPoint) && stats.byPoint.length > 0
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "按决策点分账"),
              /**
               * 圆环：哪个决策点在花钱、占多大比重。
               *
               * 为什么这一块特别需要图：表格里七行数字，读者要靠心算才知道
               * 「工具授权占了快一半」——而那正是这一节最该一眼看出的事。
               *
               * 排序口径用**请求次数**而不是 token：次数是最同质的量（一次
               * 就是一次），token 跨决策点能差好几个数量级，小的会被压成
               * 一根看不见的细线。token 的构成在下面的表里逐行可查。
               *
               * 图例与图型共用**同一个已排序数组**：先排序再同时喂给两者，
               * 颜色和名字才不会错位（错位不报错，只会让人读错决策点）。
               */
              charts !== null && Array.isArray(stats?.byPoint) && stats.byPoint.length > 0
                ? renderPointDonut(
                    charts,
                    [...stats.byPoint]
                      .filter((point) => Number(point.requests ?? 0) > 0)
                      .sort((a, b) => Number(b.requests ?? 0) - Number(a.requests ?? 0))
                      .map((point) => ({
                        // `id` 与 `label` 分开：id 用于「隐藏了哪一个」与
                        // 「颜色绑定在谁身上」，label 只用于显示。用 label 当键
                        // 会在两个决策点同名时互相串掉（服务端下发的名字若重复）。
                        id: point.point,
                        label: pointLabels[point.point] ?? point.point,
                        value: Number(point.requests ?? 0),
                      })),
                    {
                      totalLabel: "请求次数",
                      hidden: hiddenPoints,
                      onToggle: togglePointHidden,
                      /**
                       * 不传 `onActive` / `onSelect` / `readout`。
                       *
                       * 交互版圆环自带读数气泡：指针停在楔形上时，图上方会浮出
                       * 「工具授权 75%, 120」。所以界面**不需要**再在图下面加
                       * 一行说明——那行以前是自己实现的一份重复读数（还要额外
                       * 维护一份 React state 与两个回调），而它说的事图已经说了。
                       */
                    },
                  )
                : null,
              h(
                "div",
                { style: { overflowX: "auto" } },
                h(
                  "table",
                  { style: S.statsTable },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", { style: { ...S.statsTh, textAlign: "left" } }, "决策点"),
                      h("th", { style: S.statsTh }, "次数"),
                      h("th", { style: S.statsTh }, "input"),
                      h("th", { style: S.statsTh }, "output"),
                      h("th", { style: S.statsTh }, "总耗时"),
                      h("th", { style: S.statsTh }, "均耗时"),
                      h("th", { style: S.statsTh }, "命中缓存"),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...stats.byPoint.map((point) =>
                      h(
                        "tr",
                        { key: `point/${point.point}` },
                        h("td", { style: S.statsNameTd }, pointLabels[point.point] ?? point.point),
                        h("td", { style: S.statsTd }, groupDigits(point.requests)),
                        h("td", { style: S.statsTd }, groupDigits(point.inputTokens)),
                        h("td", { style: S.statsTd }, groupDigits(point.outputTokens)),
                        h("td", { style: S.statsTd }, formatMs(point.durationMs)),
                        h("td", { style: S.statsTd }, formatMs(point.avgDurationMs)),
                        h("td", { style: S.statsTd }, groupDigits(point.cached)),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,
        // 7) 口径脚注。用户必须知道「省了多少」是相对什么算的，否则会把
        //    估算当成实测——那是最难发现也最难解释的偏差。
        stats !== null
          ? h(
              "div",
              { style: S.statsNote },
              h(
                "div",
                null,
                "节省量只统计「观察」模式的记录。观察模式下决策模型只记录、不改变行为，于是同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活，这个对比才成立。在「生效」模式下普通 LLM 路径并没有真的发生，「省了多少」只能是事后估算，因此不计入本表。",
              ),
              h(
                "div",
                { style: { marginTop: "6px" } },
                "基线 = 不启用本插件的缓存与上下文压缩时，同样的工作本应消耗的 token 与时间。节省量相对基线计算（比例的分母是基线）；没有可归因的优化时节省量为 0。平均耗时按**真实请求**计算，不含缓存命中（那一次根本没发请求）。思考模式（think_mode）是用户配置而非插件优化，刻意不计入节省。",
              ),
              /**
               * 模式分账：让用户一眼看出「节省为 0」的原因。
               *
               * 「观察模式下确实没省」与「这段时间根本没在观察模式跑」是
               * 两件完全不同的事，而它们的数字都是 0。没有这张分账，
               * 读者只能靠猜。
               */
              savingsMeta !== null
                ? h(
                    "div",
                    { style: { marginTop: "6px", opacity: 0.55 } },
                    t("本区间按模式分账：观察 {observe} 条", { observe: groupDigits(savingsMeta.byMode?.observe ?? 0) })
                      + t(" · 生效 {enforce} 条", { enforce: groupDigits(savingsMeta.byMode?.enforce ?? 0) })
                      + t(" · 关闭 {off} 条", { off: groupDigits(savingsMeta.byMode?.off ?? 0) })
                      + t(" · 未知模式（历史） {unknown} 条。", { unknown: groupDigits(savingsMeta.byMode?.unknown ?? 0) })
                      + t("只有「观察」的记录参与节省量计算。"),
                  )
                : null,
              stats.legacy?.included === true
                ? h(
                    "div",
                    { style: { marginTop: "6px", color: "#f5b26b", opacity: 1 } },
                    t("含 {count} 条由旧遥测推算的历史记录：", { count: groupDigits(stats.legacy.count) })
                      + t("provider 按模型名反推（Kev/SemIf→硅基流动），未知模型保留未知；但 output token 与耗时基线仍是推算值，耗时基线取同组真实请求的均值。"),
                  )
                : null,
              stats.store !== null && stats.store !== undefined
                ? h(
                    "div",
                    { style: { marginTop: "6px", opacity: 0.55 } },
                    t("统计文件：{path}", { path: stats.store.path })
                      + t(" · 已写 {count} 条", { count: groupDigits(stats.store.written) })
                      + (stats.store.failed > 0 ? t(" · 写盘失败 {count} 条", { count: groupDigits(stats.store.failed) }) : "")
                      + (stats.store.dropped > 0 ? t(" · 队列溢出丢弃 {count} 条", { count: groupDigits(stats.store.dropped) }) : ""),
                  )
                : null,
            )
          : null,
      );
    }


