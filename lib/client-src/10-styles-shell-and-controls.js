    const S = {
      /**
       * 配置页容器：**不设最大宽度**（DEC-040）。
       *
       * 原来是 `maxWidth: 620px`，而这一层同时是 `overflowY: auto`。CSS 规范里
       * 「一个轴不是 visible，另一个轴的 visible 就按 auto 处理」，于是 620px
       * 变成了**硬裁剪**：只要有一行比它宽（长端点地址、四段滑块、带 nowrap 的
       * 控件），容器里就多出一条横向滚动条，用户得左右拖动才看得全。
       *
       * 取消限制后容器等于宿主给它的宽度，内容多宽就摊多宽，那条横向滚动条
       * 连根消失。仍然留着 `overflowY: auto`：竖向滚动是这一层自己该管的事。
       */
      wrap: {
        maxWidth: "none",
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
        padding: "20px 24px",
        fontSize: "13px",
      },
      title: { margin: "0 0 4px", fontSize: "16px", fontWeight: 600 },
      sub: { margin: "0 0 16px", fontSize: "12px", opacity: 0.6 },
      /**
       * 顶部的插件市场链接。
       *
       * 颜色沿用面板里的强调色（与选中态同一个靛蓝），下划线保留：这是个
       * 会跳到站外的链接，形状上就该像链接，不能只靠颜色区分。
       */
      siteLink: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        // 下边距 = 链接与 tab 栏的间距（原先这段距离挂在 tabBar 上，
        // 现在链接插到了 tab 栏上面，间距跟着挪过来，两处不叠加）。
        margin: "0 0 16px",
        fontSize: "12px",
        lineHeight: 1.4,
        color: "#818cf8",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        wordBreak: "break-all",
      },
      card: {
        margin: "0 0 12px",
        padding: "12px 14px",
        border: "1px solid rgba(128,128,128,.22)",
        borderRadius: "8px",
        background: "rgba(128,128,128,.04)",
      },
      label: { fontSize: "12px", opacity: 0.85, marginBottom: "6px", display: "block" },
      // —— 仿内置 rewind-plugin 配置卡的布局 ——
      /** 一行：左标题/说明，右控件。 */
      rowLine: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "12px 0",
        borderBottom: "1px solid rgba(128,128,128,.14)",
      },
      rowText: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
      rowTitle: { fontSize: "13px", fontWeight: 500, lineHeight: 1.3 },
      rowHint: { fontSize: "12px", opacity: 0.55, lineHeight: 1.4 },
      /**
       * 行说明下面的小字（DEC-037）。
       *
       * 比 hint 再小一档、再淡一档：它是「风险 / 代价」这一层的信息，读不读
       * 取决于用户，但必须摆在同一行里——离得太远就等于没写。
       */
      rowNote: { fontSize: "11px", opacity: 0.5, lineHeight: 1.4 },
      /** 开关轨道。 */
      track: {
        position: "relative",
        flexShrink: 0,
        width: "38px",
        height: "22px",
        borderRadius: "11px",
        border: "none",
        padding: 0,
        cursor: "pointer",
        transition: "background .15s ease",
      },
      /** 开关圆点。 */
      knob: {
        position: "absolute",
        top: "3px",
        left: "3px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        transition: "transform .15s ease",
      },
      /** 小按钮（获取模型 / 测试端点 / 重试）。 */
      saveBtn: {
        padding: "6px 14px",
        borderRadius: "6px",
        border: "1px solid rgba(128,128,128,.32)",
        background: "rgba(128,128,128,.18)",
        color: "inherit",
        fontSize: "12px",
        fontWeight: 500,
      },
      /** 底部说明文本。 */
      meta: {
        marginTop: "12px",
        fontSize: "11px",
        lineHeight: 1.6,
        opacity: 0.5,
        wordBreak: "break-all",
      },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      input: {
        flex: 1,
        minWidth: "200px",
        padding: "7px 10px",
        borderRadius: "6px",
        border: "1px solid rgba(128,128,128,.32)",
        background: "transparent",
        color: "inherit",
        fontSize: "12px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      btn: (active, tone) => ({
        padding: "6px 12px",
        borderRadius: "6px",
        border: `1px solid ${tone ?? "rgba(128,128,128,.32)"}`,
        background: active ? "rgba(99,102,241,.16)" : "transparent",
        color: active ? "#818cf8" : "inherit",
        cursor: "pointer",
        fontSize: "12px",
      }),
      kv: { display: "flex", gap: "8px", padding: "3px 0", fontSize: "12px" },
      k: { width: "86px", opacity: 0.6, flexShrink: 0 },
      v: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" },
      /** 决策点小节标题。 */
      sectionTitle: {
        marginTop: "18px",
        marginBottom: "4px",
        fontSize: "12px",
        fontWeight: 600,
        opacity: 0.75,
        letterSpacing: ".02em",
      },
      /** 单个决策点卡片。 */
      pointCard: (dim) => ({
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        padding: "9px 10px",
        marginTop: "6px",
        borderRadius: "8px",
        border: "1px solid rgba(128,128,128,.2)",
        background: "rgba(128,128,128,.06)",
        opacity: dim ? 0.5 : 1,
      }),
      pointText: { flex: 1, minWidth: 0 },
      pointName: { fontSize: "12px", fontWeight: 600 },
      pointHint: { fontSize: "11px", opacity: 0.55, lineHeight: 1.45, marginTop: "2px" },
      pointMeta: {
        fontSize: "10px",
        opacity: 0.45,
        marginTop: "3px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      /** 三态分段控件。 */
      seg: {
        display: "flex",
        flexShrink: 0,
        gap: "2px",
        padding: "2px",
        borderRadius: "7px",
        border: "1px solid rgba(128,128,128,.24)",
      },
      segItem: (active, tone) => ({
        padding: "3px 8px",
        borderRadius: "5px",
        border: "none",
        background: active ? (tone ?? "rgba(99,102,241,.28)") : "transparent",
        color: active ? "#fff" : "inherit",
        cursor: "pointer",
        fontSize: "11px",
        whiteSpace: "nowrap",
      }),
      /**
       * 人工审核比例的分段滑块（DEC-035）。
       *
       * 为什么是「分段 + 滑块」而不是下拉：
       *
       *   - 四档是一条**单调的轴**（从不问 → 更常问），下拉会把这条轴压成
       *     四个互不相干的选项，用户看不出「往右更保守」；
       *   - 拖动/点击的即时反馈让「大概每多少次问一次」这层语义可感知，
       *     而选下拉时用户得先在脑子里换算；
       *   - 滑块能同时画出**当前位置附近的校准信息**（最前 1% 落在哪个分数），
       *     那是下拉的每一行都放不下的。
       *
       * 轨道用一条横线、四个等距落点。落点本身是按钮（可点击），因此键盘与
       * 鼠标都能用；没有引入真正的 `<input type="range">`，因为它的值域是
       * 数字而四档是离散语义，映射回去反而要处理「拖到两档之间」的中间态。
       */
      /** 人工审核比例的整块容器（配置页）：竖排，占满一整行。 */
      toleranceSection: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "12px 0",
        borderBottom: "1px solid rgba(128,128,128,.14)",
      },
      toleranceTrack: {
        position: "relative",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        // 兜底：窗口极窄时允许横向排布而不是把中文竖着挤成一列。
        flexWrap: "nowrap",
        gap: "0",
        padding: "14px 4px 2px",
        margin: "2px 0 0",
        minHeight: "34px",
      },
      /**
       * 轨道本体：一条贯穿四个落点的细线。
       *
       * 绝对定位，左右内缩 = 半个段宽：落点在各段**居中对齐**，若轨道从
       * 容器边缘开始，两端会各多出一截「通向无处」的线。
       */
      toleranceRail: {
        position: "absolute",
        left: "12.5%",
        right: "12.5%",
        top: "21px",
        height: "2px",
        borderRadius: "1px",
        background: "rgba(128,128,128,.28)",
        pointerEvents: "none",
      },
      /**
       * 一个落点：圆点 + 下方标签，四个等宽等距。
       *
       * `flex: "1 1 0"` 让四段等宽，但**必须配 `minWidth: max-content`**：
       * 纯 `minWidth: 0` 会让中文标签在窄容器里逐字换行，四个段叠成一团
       * 竖排（真机上就是这么坏的）。`max-content` 保证标签永不换行，容器
       * 太窄时宁可整体溢出也不要把字拆开。
       */
      toleranceStop: (active, passed) => ({
        position: "relative",
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "6px",
        flex: "1 1 0",
        minWidth: "max-content",
        padding: "0 4px",
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "11px",
        whiteSpace: "nowrap",
      }),
      /** 落点的圆点。`passed` = 在当前档位的左边或就是当前档位（已走过的部分）。 */
