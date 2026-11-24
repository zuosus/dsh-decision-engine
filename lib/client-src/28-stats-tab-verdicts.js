        // 4.5) 裁决统计：allow / ask / reject。
        //
        // 与上面的用量统计是**两套口径**：用量回答「钱花在哪」，裁决回答
        // 「模型到底拦下了多少、惊动了用户多少次」。两者不能互相换算——
        // 一次降级没有裁决却花了时间，一次缓存命中的裁决照常计入却没花钱。
        outcomes !== null && (outcomes.decided > 0 || outcomes.none > 0)
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "裁决统计（allow / ask / reject）"),
              h(
                "div",
                { style: { fontSize: "11px", opacity: 0.6, marginTop: "-2px" } },
                "决策模型的裁决结果：放行 = 动作照常进行；询问 = 升级人工确认；拦截 = 动作被拦下。",
              ),
              /**
               * 裁决构成条：三格占比一眼可见。
               *
               * 放在卡片**之后**：卡片给的是三个绝对数（要核对具体数字时
               * 看它），这条给的是三者的**比例形状**（要判断「是不是被拦
               * 得太多」时看图）。先数字后形状，符合「先核对再判断」的顺序。
               *
               * 「未裁决」刻意不进这条：它不是第四种裁决结果，而是
               * 「这次根本没产生裁决」（降级、答案形状不符）。把它和
               * allow/ask/reject 拼成一条 100% 的条，会让「降级很多」
               * 看起来像「模型总是在拦/放」，那是两种完全不同的状况。
               */
              charts !== null && outcomes.decided > 0
                ? h(
                    "div",
                    { style: { marginTop: "10px" } },
                    renderOutcomeBar(charts, outcomes),
                  )
                : null,
              h(
                "div",
                { style: S.statsCards },
                ...[
                  { label: "放行 allow", value: outcomes.allow, color: "#7dd3a0" },
                  { label: "询问 ask", value: outcomes.ask, color: "#f5b26b" },
                  { label: "拦截 reject", value: outcomes.reject, color: "#e8797f" },
                  { label: "未裁决", value: outcomes.none },
                ].map((item) =>
                  h(
                    "div",
                    { style: S.statsCard, key: item.label },
                    h("div", { style: S.statsCardLabel }, item.label),
                    h(
                      "div",
                      {
                        style:
                          item.color === undefined
                            ? S.statsCardValue
                            : { ...S.statsCardValue, color: item.color },
                      },
                      groupDigits(item.value),
                    ),
                  ),
                ),
              ),
              // 按决策点分：哪个点在拦、在问，一目了然。
              outcomePoints.length > 0
                ? h(
                    "div",
                    { style: { overflowX: "auto", marginTop: "10px" } },
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
                          h("th", { style: S.statsTh }, "放行"),
                          h("th", { style: S.statsTh }, "询问"),
                          h("th", { style: S.statsTh }, "拦截"),
                          h("th", { style: S.statsTh }, "未裁决"),
                        ),
                      ),
                      h(
                        "tbody",
                        null,
                        ...outcomePoints.map((point) =>
                          h(
                            "tr",
                            { key: `outcome/${point.point}` },
                            h("td", { style: S.statsNameTd }, pointLabels[point.point] ?? point.point),
                            h("td", { style: S.statsTd }, groupDigits(point.allow)),
                            h("td", { style: S.statsTd }, groupDigits(point.ask)),
                            h("td", { style: S.statsTd }, groupDigits(point.reject)),
                            h("td", { style: S.statsTd }, groupDigits(point.none)),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              // 漏登记的裁决必须显式提示：否则它只是让数字**偏小**，
              // 而偏小的数字看着仍然合理——这是最难自查的一类错。
              outcomes.otherVerdictCount > 0
                ? h(
                    "div",
                    { style: { marginTop: "8px", fontSize: "11px", color: "#f5b26b" } },
                    t("有 {count} 条裁决未归类：", { count: groupDigits(outcomes.otherVerdictCount) })
                      + outcomes.otherVerdicts.map((item) => t("{verdict}（{count}）", { verdict: item.verdict, count: groupDigits(item.count) })).join(t("、"))
                      + t("。这是新增决策点或裁决词后忘了登记导致的。"),
                  )
                : null,
            )
          : null,
        // 5) 横向对比 + 节省量对比。区间内没有记录时说明原因，
        //    而不是显示一张空表让人以为统计坏了。
        rows.length > 0
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "横向对比（provider × model）"),
              /**
               * 排序条：谁花得多、一眼可见（表格之前）。
               *
               * 为什么用「次数」而不是 token：行数一多（十几个组合很常见），
               * 横向条的标签会挤在一起；次数是最短、量级最同质的指标，
               * 排出来的长度差最容易读。token 的绝对值跨模型差好几个数量级，
               * 画在同一根轴上会让小模型缩成看不见的一根线。
               *
               * 只取前 8 个：多出来的会让条形密到读不出标签，而**表格里
               * 全都在**——图表负责「看出头部」，表格负责「查具体值」。
               */
              charts !== null && rows.length > 0
                ? h(
                    "div",
                    { style: { marginTop: "8px" } },
                    renderRanking(
                      charts,
                      [...rows]
                        .sort((a, b) => Number(b.requests ?? 0) - Number(a.requests ?? 0))
                        .slice(0, 8)
                        .map((row) => ({
                          label: `${comboName(row)} · ${row.model}`,
                          value: Number(row.requests ?? 0),
                        })),
                      {
                        label: "请求次数对比",
                        summary: t("前 {count} 个组合的请求次数对比", { count: Math.min(8, rows.length) }),
                      },
                    ),
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
                      h("th", { style: { ...S.statsTh, textAlign: "left" } }, "provider / model"),
                      ...compareColumns.map((column) => sortableTh(column, filter, setFilter)),
                      // 缓存命中单独给出：它是「本插件省了多少」的直接来源，
                      // 混在次数里就看不出节省是从哪来的。
                      h("th", { style: S.statsTh, key: "cached" }, "命中缓存"),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...rows.map((row) =>
                      h(
                        "tr",
                        { key: `${row.provider}/${row.model}` },
                        h(
                          "td",
                          { style: S.statsNameTd },
                          h("div", null, comboName(row)),
                          h("div", { style: { opacity: 0.55, fontSize: "10px" } }, row.model),
                        ),
                        h("td", { style: S.statsTd }, groupDigits(row.requests)),
                        h("td", { style: S.statsTd }, groupDigits(row.inputTokens)),
                        h("td", { style: S.statsTd }, groupDigits(row.outputTokens)),
                        h("td", { style: S.statsTd }, formatMs(row.durationMs)),
                        h("td", { style: S.statsTd }, formatMs(row.avgDurationMs)),
                        h("td", { style: S.statsTd }, groupDigits(row.cached)),
                      ),
                    ),
                  ),
                ),
              ),
              h(
                "div",
                { style: { ...S.sectionTitle, marginTop: "16px" } },
                "节省量对比（观察模式：基线 → 实际）",
              ),
              /**
               * 这一节的说明必须紧贴表格。
               *
               * 表格上方一句「节省量只统计观察模式」——读者在看到数字的
               * **那一刻**就知道它的来源，而不是要翻到页面底部的脚注。
               * 放到脚注里等于没说：看表的人不会先读完脚注。
               */
              h(
                "div",
                { style: { ...S.pointHint, marginTop: "2px" } },
                savingsUnavailable
                  ? t("这段时间没有观察模式的记录，无法对比普通 LLM 路径与决策模型路径。把相关决策点切到「观察」后，这里才会出现可比对的节省量。")
                  : t("本节只统计「观察」模式的记录（本次 {count} 条）。", { count: groupDigits(observeRequests) })
                    + t("观察模式下决策模型只记录、不改变行为，因此同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活。"),
              ),
              /**
               * 节省量的形状：基线 vs 实际（右侧竖线是基线，条是实际）。
               *
               * 节省量最容易误读的地方是「它到底相对什么」——表格里两列
               * 数字并排，读者得心算才知道省了多少，而且很容易把两个
               * 不同口径的数相减（比如拿生效模式的消耗去减观察模式的节省）。
               * 画在同一条轴上之后，「省了多少」是看得见的长度差，
               * 基线就是那条刻度的右端，口径不需要再解释。
               *
               * `savingsUnavailable` 时整块不画：这时候没有观察模式的
               * 记录，画一条「实际 = 基线」的满格条会被读成「一点没省」。
               */
              charts !== null && savingsUnavailable !== true && totals !== null
                ? h(
                    "div",
                    { style: { marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" } },
                    ...(
                      [
                        {
                          key: "inputTokens",
                          label: "input token",
                          baseline: Number(totals.observeBaseInputTokens ?? 0),
                          actual: Number(totals.observeInputTokens ?? 0),
                        },
                        {
                          key: "outputTokens",
                          label: "output token",
                          baseline: Number(totals.observeBaseOutputTokens ?? 0),
                          actual: Number(totals.observeOutputTokens ?? 0),
                        },
                      ]
                    ).map((item) =>
                      h(
                        "div",
                        { key: `savings-bullet/${item.key}` },
                        h("div", { style: { fontSize: "11px", opacity: 0.6, marginBottom: "1px" } },
                          t("{label}（实际 vs 基线）", { label: t(item.label) })),
                        renderSavingsBullet(charts, item.baseline, item.actual, t(item.label)),
                      ),
                    ),
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
                      h("th", { style: { ...S.statsTh, textAlign: "left" } }, "provider / model"),
                      ...savedColumns.map((column) => sortableTh(column, filter, setFilter)),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...rows.map((row) =>
                      h(
                        "tr",
                        { key: `saved/${row.provider}/${row.model}` },
                        h(
                          "td",
                          { style: S.statsNameTd },
                          h("div", null, comboName(row)),
                          h("div", { style: { opacity: 0.55, fontSize: "10px" } }, row.model),
                        ),
                        // 「实际」两列也只显示观察模式的部分——它们与旁边的
                        // 「省」列必须同源，否则读者会拿生效模式的消耗去
                        // 减观察模式的节省，得出一个毫无意义的数。
                        h("td", { style: S.statsTd }, groupDigits(row.observeInputTokens ?? 0)),
                        h("td", { style: S.savedTd }, groupDigits(row.savedInputTokens)),
                        h("td", { style: S.statsTd }, groupDigits(row.observeOutputTokens ?? 0)),
                        h("td", { style: S.savedTd }, groupDigits(row.savedOutputTokens)),
                        h("td", { style: S.statsTd }, formatMs(row.observeDurationMs ?? 0)),
                        h("td", { style: S.savedTd }, formatMs(row.savedDurationMs)),
                        h("td", { style: S.savedTd }, formatRatio(row.savedRatio)),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : customIncomplete
            ? h(
                "div",
                { style: S.card },
                h("div", { style: S.pointMeta }, "请填写完整的起止时间。"),
              )
            : stats === null
              ? h("div", { style: S.pointMeta }, "正在读取统计…")
              : h(
                  "div",
                  { style: S.card },
                  h(
                    "div",
                    { style: S.pointMeta },
                    "该时间范围内没有统计记录。统计从插件记录决策请求时开始累积。",
                  ),
                ),
