      /**
       * 把一条记录渲染成行。
       *
       * **整体包 try/catch**：任何一条记录格式不对（老版本文件、手工改过）
       * 都不该让整页崩掉——跳过那一条即可。
       *
       * @param entry - 记录。
       * @param index - 在**当前顺序**里的位置（只用于 id 兜底）。
       * @param isNew - 这条是这一轮刚出现的（DEC-044）：叠一条入场动画。
       */
      const renderRow = (entry, index, isNew = false) => {
        try {
          // 行身份用 `id`（全局唯一），**不是 `seq`**（进程内计数器，重启后
          // 会与旧记录撞车）。重复 key 会让点击落到错的行上。
          const id = entryIdOf(entry, index);
          const action = typeof entry?.action === "string" ? entry.action : "";
          const color = VERDICT_COLORS[action] ?? DEFAULT_VERDICT_COLOR;
          const point = typeof entry?.point === "string" ? entry.point : "";
          const time = typeof entry?.ts === "string" ? entry.ts : "";
          // 本地时间（不是 UTC 挂钟）：见 formatLocalDateTime 的说明。
          const local = formatLocalDateTime(time);
          return h(
            "tr",
            {
              key: `row-${id}`,
              // 新增行叠一条入场动画；已有行**不带**这条样式，否则每 5 秒
              // 一次的整页重绘会变成整页闪动。
              style: isNew ? { ...S.decisionsRow, ...S.decisionsRowEnter } : S.decisionsRow,
              onClick: () => setExpanded(expanded === id ? null : id),
            },
            h("td", { style: S.decisionsTd }, local),
            h("td", { style: S.decisionsTd }, pointLabels[point] ?? point),
            h("td", { style: S.decisionsTd }, entry?.provider ?? ""),
            h("td", { style: S.decisionsTd }, entry?.model ?? ""),
            h(
              "td",
              { style: S.decisionsTd },
              action.length > 0
                ? h(
                    "span",
                    // `title` 留**原始机器词**：明细文件与遥测里就是它，
                    // 需要对照时停一下鼠标就能看到。
                    { style: S.decisionsVerdict(color), title: action },
                    VERDICT_LABELS[action] ?? action,
                  )
                : "",
            ),
            h("td", { style: S.decisionsTd }, `${Number(entry?.latencyMs) || 0}ms`),
            // 「内容」列：这次到底存没存内容。判据是 `capture` 字段——
            // `meta` 只可能来自超限裁剪（DEC-029 之后没有「只记元数据」的档位）。
            h(
              "td",
              { style: S.decisionsTd },
              entry?.capture === "meta" ? t("仅元数据") : t("有内容"),
            ),
            // 「标记」列：缓存命中 / 已降级（与「内容」是两件事，见 DECISION_COLUMNS）。
            //
            // 降级不能只写「已降级」：用户扫表时要能直接看出这次请求是 404 还是 401。
            // 这里把降级原因（detail，如 http-404 / auth-failed）与 HTTP 状态码一并写出；
            // 排序走 decisionSortValue 的 0/1/2 分组、不依赖本列文本，故不影响排序。
            // 失败原因也仍保留在展开后的详情里。
            h(
              "td",
              { style: S.decisionsTd },
              entry?.cached === true
                ? t("缓存命中")
                : entry?.backup === true
                  // 兜底：主模型失败后由免费模型答的。与「已降级」并列在同一列，
                  // 因为它回答的也是「这一行有什么特别」。
                  ? t("免费兜底")
                  : entry?.degraded === true
                  ? (() => { const dt = entry?.detail, st = entry?.status; const base = dt && String(dt).length > 0 ? t("已降级") + " · " + String(dt) : t("已降级"); return (typeof st === "number" && st > 0 && !(dt && String(dt).includes(String(st)))) ? base + " (HTTP " + st + ")" : base; })()
                  : "",
            ),
          );
        } catch {
          // 单条记录渲染失败：返回空行，不影响其余记录。
          return h("tr", { key: `bad-${index}` }, h("td", { style: S.decisionsTd }, "—"));
        }
      };

      /**
       * 展开后的详情：裁决原因、现场、问题、回答、分数。
       *
       * `entry.detail` 是**原始审计文本**（服务端写的中文原因），不是界面
       * 文案，因此**原样输出、不过 t()**——它是记录的一部分，翻译它等于
       * 篡改审计记录。这也是「英文界面零中文」断言里唯一允许残留中文的
       * 位置（它是数据，不是 UI）。
       */
      const renderDetail = (entry) => {
        try {
          const content = entry?.content ?? null;
          const scores = entry?.scores ?? null;
          const parts = [];
          if (entry?.detail !== undefined && String(entry.detail).length > 0) {
            parts.push(`${t("内容")}\n${String(entry.detail)}`);
          }
          if (content !== null && typeof content === "object") {
            if (content.state !== undefined) {
              parts.push(`${t("内容")}\n${safeJson(content.state)}`);
            }
            if (content.questions !== undefined) {
              parts.push(`${t("问题")}\n${safeJson(content.questions)}`);
            }
            if (content.answers !== undefined) {
              parts.push(`${t("回答")}\n${safeJson(content.answers)}`);
            }
          }
          if (scores !== null && typeof scores === "object") {
            parts.push(`${t("分数")}\n${safeJson(scores)}`);
          }
          // 只有**真的没有内容**时才说「只存了元数据」。判据是 `capture`
          // 字段与 content 是否存在——不能拿「parts 为空」当判据：一条只带
          // 裁决原因、没存 state 的记录不是「只有元数据」，直接说会误导。
          const metaOnly =
            entry?.capture === "meta" || (content === null || content === undefined);
          if (metaOnly) {
            parts.push(t("这条记录只保存了元数据（未保存决策内容）"));
          }
          return h("div", { style: S.decisionsDetail }, parts.join("\n\n"));
        } catch {
          return h("div", { style: S.decisionsDetail }, t("这条记录只保存了元数据（未保存决策内容）"));
        }
      };

      // `entries` 在上面「新增行的入场动画」那一节之前已备好（同一份 `page.entries`）。
      if (sessionId.length === 0) {
        return h(
          "div",
          { style: S.decisionsWrap },
          h("div", { style: S.decisionsEmpty }, t("该插件的决策历史已在设置里关闭")),
        );
      }

      /**
       * 人工审核比例（DEC-035）：**决策历史页也要有**。
       *
       * 为什么放在这个页面：用户是在这里看到「刚才又问我了」的，于是想调
       * 频率的那个瞬间就在这个页面。让他为此切到插件配置页，等于承认这两处
       * 说的是同一件事却要跳一次。
       *
       * 数据来自 `page.tolerance`（`/session-decisions` 下发，服务端与配置页
       * 用的是同一个 `tolerancePayload()`，因此两处永远一致）。
       *
       * 这里**直接 PUT `/config`**（档位唯一的写入口），不做防抖——点一下就是
       * 一次明确的决定，没有「打字打到一半」的中间态。
       */
      const currentTolerance = toleranceDraft ?? page?.tolerance ?? null;
      const toleranceBlock =
        currentTolerance === null || page?.tolerance === undefined || page?.tolerance === null
          ? null
          : h(
              "div",
              { style: { ...S.decisionsTolerance, key: "tolerance-panel" } },
              h(
                "div",
                { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                h(
                  "span",
                  { style: { fontSize: "12px", fontWeight: 600 } },
                  t("人工审核比例"),
                ),
                toleranceSaving
                  ? h("span", { style: { fontSize: "11px", opacity: 0.6 } }, t("保存中…"))
                  : null,
                toleranceError.length > 0
                  ? h(
                      "span",
                      { style: { fontSize: "11px", color: "#f87171" } },
                      toleranceError,
                    )
                  : null,
              ),
              ToleranceSlider({
                tolerance: page.tolerance,
                level: currentTolerance.level ?? page.tolerance.level,
                disabled: toleranceSaving,
                compact: true,
                onSelect: (level) => {
                  // 先落草稿（界面立刻跟手），再发请求；失败时退回服务端值。
                  setToleranceDraft({ ...page.tolerance, level });
                  setToleranceError("");
                  setToleranceSaving(true);
                  void (async () => {
                    try {
                      await call("/config", {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ tolerance: level }),
                      });
                      // 成功后重新取一页：档位可能与服务端归一化的结果不同，
                      // 且校准信息（阈值、样本数）在档位切换后会变。
                      await load();
                    } catch (cause) {
                      setToleranceError(
                        t("保存失败：{error}", {
                          error: cause instanceof Error ? cause.message : String(cause),
                        }),
                      );
                      // 退回服务端值：不能显示一个实际没落盘的档位。
                      setToleranceDraft(null);
                    } finally {
                      setToleranceSaving(false);
                    }
                  })();
                },
              }),
            );

