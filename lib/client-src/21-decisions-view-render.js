      /**
       * 头部 = 人工审核比例面板（DEC-036 之后**只剩**这一块）。
       *
       * 原先这里还有一排「会话 xxx · 共 N 条决策 · 刷新」——用户明确要求删掉
       * 整排：会话名对一个「只显示本会话」的页面是废话，条数每 5 秒自己变、
       * 刷新也有轮询兜着。删掉后列表直接顶到页首，纵向空间全留给记录。
       *
       * 一次包成 `header`（而不是几条返回路径各写一遍）：这个组件有四个
       * 提前 return（关闭 / 错误 / 加载中 / 空态），漏掉任何一处都会让滑块
       * 在某些状态下凭空消失——而「空态」恰恰是用户最想调低档位的那一刻。
       * 没有 tolerance 下发时整块不渲染，不留一个空的包裹层。
       */
      const header = toleranceBlock === null
        ? null
        : h(
            "div",
            { key: "toolbar" },
            toleranceBlock,
          );

      if (error.length > 0) {
        return h(
          "div",
          { style: S.decisionsWrap },
          header,
          h("div", { style: S.decisionsEmpty }, t("读取决策历史失败：{error}", { error })),
        );
      }
      if (loading && entries.length === 0) {
        return h("div", { style: S.decisionsWrap }, header, h("div", { style: S.decisionsEmpty }, "…"));
      }
      if (entries.length === 0) {
        return h(
          "div",
          { style: S.decisionsWrap },
          header,
          h("div", { style: S.decisionsEmpty }, t("本会话还没有决策记录")),
          h("div", { style: { ...S.decisionsEmpty, opacity: 0.5 } }, t("决策点都处于「关闭」时不会产生记录")),
        );
      }

      const rows = [];
      // 表格主体按**当前排序列**排；默认是「时间降序」（最新在上，DEC-044）。
      // 计数与展开判定都基于同一份顺序，避免出现「看的是排好的、
      // 点下去展开的是另一行」。
      const ordered = sortDecisionEntries(entries, sort, pointLabels);
      // 这一批里要播入场动画的记录（由 `load` 在取数时算出，与排序无关）。
      const newIdSet = new Set(Array.isArray(newIds) ? newIds : []);
      for (let index = 0; index < ordered.length; index += 1) {
        const entry = ordered[index];
        const id = entryIdOf(entry, index);
        rows.push(renderRow(entry, index, newIdSet.has(id)));
        // 展开的详情插在这条记录之后——表格里不能直接放 div，因此用
        // colspan 的行承载。
        //
        // 判定用的身份必须与 `renderRow` 里的**完全一致**（同一个 `entryIdOf`）：
        // 两处各算一套（曾经一处用 seq、一处用 index）就会出现「点这行、展开
        // 那行」的错位。
        if (expanded === id) {
          rows.push(
            h(
              "tr",
              { key: `detail-${id}` },
              h(
                "td",
                { style: { ...S.decisionsTd, whiteSpace: "normal", padding: "0 6px 8px" }, colSpan: 7 },
                renderDetail(entry),
              ),
            ),
          );
        }
      }

      return h(
        "div",
        { style: S.decisionsWrap },
        // 头部（人工审核比例）在滚动区之外：它不该跟着表格一起滚走。
        header,
        // 表头粘的就是这一层。它**一定会滚**（maxHeight 与父级高度无关），
        // 所以 `th { position: sticky }` 总能找到一个真正会滚的祖先，
        // 不必赌宿主那条链里有没有 `overflow:hidden`。
        h(
          "div",
          { style: S.decisionsScroll, key: "scroll" },
          h(
            "table",
            { style: S.decisionsTable },
            h(
              "thead",
              { key: "head" },
              h(
                "tr",
                { key: "tr" },
                // 每一列都可点排序。箭头只画在当前列上——否则「哪一列在起作用」
                // 只能靠猜。首次点某一列一律从**降序**起（DEC-044 与整页默认排序
                // 对齐）：时间列 = 最新在上，耗时列 = 最慢在上，文字列 = 从后往前。
                // 想反向再点一次。
                ...DECISION_COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  const arrow = active ? (sort.dir === "desc" ? " ↓" : " ↑") : "";
                  return h(
                    "th",
                    {
                      key: `th-${column.key}`,
                      style: S.decisionsTh,
                      title: t("按「{label}」排序", { label: t(column.label) }),
                      onClick: () => setSort(
                        active
                          ? { key: column.key, dir: sort.dir === "desc" ? "asc" : "desc" }
                          : { key: column.key, dir: "desc" },
                      ),
                    },
                    t(column.label) + arrow,
                  );
                }),
              ),
            ),
            h("tbody", { key: "body" }, rows),
          ),
          // 截断提示与文件路径放在表格之后、滚动区内：它们是表格的附注，
          // 跟着表格滚才自然（钉在外面会挤掉最后几行）。
          page?.truncated === true
            ? h("div", { style: S.statsNote }, t("还有更多记录没有显示"))
            : null,
          typeof page?.file === "string" && page.file.length > 0
            ? h("div", { style: S.meta }, t("记录文件：{path}", { path: page.file }))
            : null,
        ),
      );
    }

