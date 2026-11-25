      toleranceDot: (active, passed) => ({
        width: active ? "14px" : "10px",
        height: active ? "14px" : "10px",
        borderRadius: "50%",
        border: active ? "2px solid #818cf8" : "1px solid rgba(128,128,128,.45)",
        background: active
          ? "rgba(99,102,241,.85)"
          : passed
            ? "rgba(128,128,128,.42)"
            : "transparent",
        transition: "width .12s ease, height .12s ease, background .12s ease",
        boxSizing: "border-box",
      }),
      /**
       * 落点标签：当前档位高亮，其余淡出。
       *
       * `whiteSpace: nowrap` 是硬约束——中文标签一旦允许换行，窄容器下会
       * 变成「轻 / 松」两行，四个段互相叠压，整个控件就读不出顺序了。
       */
      toleranceLabel: (active) => ({
        fontSize: active ? "12px" : "11px",
        fontWeight: active ? 600 : 400,
        color: active ? "#818cf8" : "inherit",
        opacity: active ? 1 : 0.58,
        whiteSpace: "nowrap",
        lineHeight: 1.35,
      }),
      /** 「即将支持」角标。 */
      badge: {
        flexShrink: 0,
        alignSelf: "center",
        padding: "3px 8px",
        borderRadius: "6px",
        border: "1px dashed rgba(128,128,128,.4)",
        fontSize: "10px",
        opacity: 0.55,
        whiteSpace: "nowrap",
      },
      pre: {
        margin: "8px 0 0",
        padding: "8px 10px",
        borderRadius: "6px",
        background: "rgba(0,0,0,.22)",
        fontSize: "11px",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        maxHeight: "180px",
        overflow: "auto",
      },
      // —— 统计与对比 ——
      /** 统计表格。 */
      /**
       * 图表容器（见 `chartBox`）。
       *
       * `minWidth: 0` 是必须的：这些图表画在 flex 布局的行里，
       * 默认的 `min-width: auto` 会让 SVG 撑破容器而不是收缩。
       */
      chartBox: {
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "middle",
        lineHeight: 0,
        minWidth: 0,
      },
      /**
       * 圆环图例的一行：色块 + 名称 + 占比。
       *
       * 名称用 `ellipsis` 而不是换行：决策点名字长度不一，换行会让各行
       * 高度参差，色块在视觉上对不齐，读者反而更难跟着颜色找行。
       */
      chartLegendRow: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "11px",
        lineHeight: 1.5,
        minWidth: 0,
      },
      /**
       * 图例项（可点击的按钮）：色块 + 名称 + 占比。
       *
       * 做成按钮是因为它是**可操作控件**（切换该决策点是否参与圆环），
       * 键盘与读屏用户必须能用。样式上刻意压成「一行文字」而不是按钮外观：
       * 它属于图例，不该抢走圆环的注意力；hover 时才给一点底色提示可点。
       */
      chartLegendBtn: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        width: "100%",
        padding: "2px 4px",
        margin: 0,
        border: 0,
        borderRadius: "4px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "11px",
        lineHeight: 1.5,
        textAlign: "left",
        cursor: "pointer",
      },
      /**
       * 走势图下方的读数行：当前 hover/选中的那一格。
       *
       * 固定高度（`minHeight`）而不是随内容跳动：读数一变高度就变，
       * 下面整块内容会跟着上下抖，读数本身反而看不清。
       */
      chartReadout: {
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
        minHeight: "16px",
        marginTop: "3px",
        fontSize: "11px",
        fontVariantNumeric: "tabular-nums",
      },
      /** 图例色块：与圆环同色（由调用方按索引给出 `--mc-cat-N`）。 */
      chartLegendSwatch: {
        flex: "none",
        width: "9px",
        height: "9px",
        borderRadius: "2px",
      },
      /**
       * 横向排序条：一行一项（名称 / 条 / 数值 / 占比）。
       *
       * 用网格而不是 flex：名称列与数值列必须**等宽对齐**，否则每行的
       * 条形起点参差，长度就没法横向比较——而那正是这张图唯一的用处。
       */
      chartRankList: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        marginTop: "8px",
        position: "relative",
      },
      chartRankRow: {
        display: "grid",
        // 名称自适应（最少 84px）→ 条形占满剩余 → 数值/占比按内容宽。
        gridTemplateColumns: "minmax(84px, 1.1fr) minmax(60px, 2.4fr) auto auto",
        alignItems: "center",
        gap: "8px",
        fontSize: "11px",
        lineHeight: 1.4,
      },
      /** 名称列：单行省略，避免长模型名把条形挤没了。 */
      chartRankLabel: {
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: 0.85,
      },
      /** 条形槽：底色是「满格」，于是条与满格之差就是差距。 */
      chartRankTrack: {
        display: "block",
        position: "relative",
        height: "9px",
        borderRadius: "3px",
        background: "rgba(128,128,128,.18)",
        overflow: "hidden",
      },
      /** 条形本体：宽度由调用方按比例给。 */
      chartRankBar: {
        display: "block",
        height: "100%",
        borderRadius: "3px",
        transition: "width .2s ease",
      },
      /** 数值列：等宽数字，右对齐，方便上下串着读。 */
      chartRankValue: {
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
        whiteSpace: "nowrap",
        minWidth: "42px",
      },
      /** 占比列：次要信息，压暗。 */
      chartRankShare: {
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
        whiteSpace: "nowrap",
        minWidth: "38px",
        opacity: 0.55,
      },
      /** 图表位的空态文案（没有数据时替代图形，而不是留一块空白）。 */
      chartEmpty: {
        fontSize: "11px",
        opacity: 0.5,
        lineHeight: 1.5,
        padding: "4px 0",
      },
