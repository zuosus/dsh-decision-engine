      statsTd: {
        textAlign: "right",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      },
      /** 名称列（左对齐）。 */
      statsNameTd: {
        textAlign: "left",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        whiteSpace: "nowrap",
      },
      /** 节省量用绿色标出。 */
      savedTd: {
        textAlign: "right",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
        color: "#7dd3a0",
      },
      // —— 决策历史（DEC-022）：会话标签页的样式 ——
      /**
       * 标签页容器：**一个普通块级盒子，自己不滚，也不裁溢出**。
       *
       * 这一版是**修正**。上一版写成 `height:100%` + flex 列 + `overflow:hidden`，
       * 想「让表格自己滚、工具条固定」。真机上表头根本不粘，三条原因叠在一起：
       *
       *   1. **`height:100%` 在这里拿不到参照高度**。这个 view 挂在宿主的
       *      `conversation.view` 槽位里，而宿主那条布局链是
       *      `flex:1 0 auto; min-height:auto`——**会一直长到内容高度**。
       *      「是 flex 就能用 height:100%」这个假设只在父级高度确定时成立；
       *      父级不确定时 `height:100%` 退化成 `auto`，于是我的内层滚动区
       *      永远长到全部内容高度、永远不产生自己的滚动条。
       *   2. **于是真正滚的是宿主的容器**。`position:sticky` 只认「最近的
       *      滚动祖先」——宿主那个容器才是滚动容器。我的 `th` 粘的是一个
       *      从不滚动的内层盒子，表现就是「跟着一起滚走」。
       *   3. **`overflow:hidden` 会吃掉 sticky**。它把本元素变成 sticky 的
       *      裁剪/滚动祖先，sticky 子元素只会在它内部粘；而它高度等于内容
       *      高度、又从不滚动，于是粘性彻底失效。
       *
       * 但**不能反过来只靠宿主滚动**：sticky 认「最近的滚动祖先」，而宿主
       * 那条链里只要有任何一层是 `overflow:hidden`（宿主布局的常见写法），
       * 粘性就被那一层吃掉——表现同样是「表头跟着一起滚走」。宿主内部结构
       * 我看不到、也不该赌。
       *
       * 所以现在是第三条路：**自己造一个一定会滚的容器**，给它视口相关的
       * `maxHeight`（见 `decisionsScroll`）而不是 `height:100%`：
       *
       *   - `height:100%` 要父级有确定高度，而宿主那条链会**长到内容高度**，
       *     于是它退化成 auto，内层永远不出滚动条，等于没设；
       *   - `maxHeight: calc(100vh - Npx)` 与父级高度**无关**，块级盒自己
       *     算得出来，内容一超就自己滚。sticky 于是总能找到一个真会滚的祖先。
       *
       * 也不学 dsh-retrace 用 `ResizeObserver` 量高度：那条路要读
       * `window.innerHeight`、监听 resize、还必须在 flex 环境里手工改
       * `flex:none`——为「表头别滚走」引入一整套尺寸编排，反而成了以后最
       * 容易坏的地方（宿主布局一改就失效）。
       */
      decisionsWrap: {
        maxWidth: "860px",
        boxSizing: "border-box",
        padding: "16px 20px",
        fontSize: "13px",
        // 刻意**不写** overflow / height：这一层一旦变成滚动或裁剪祖先，
        // 表头就改粘它，而它从不滚动，粘性等于没写。
      },
      /**
       * 决策历史页上的人工审核比例面板（DEC-035）。
       *
       * 与工具条一起放在滚动区之外：滑块不该跟着表格滚走——用户往下翻记录
       * 时正是最容易想改档位的时候。
       *
       * 用一条虚线框把它与工具条分开：这两块说的是不同的事（「这一页在看什么」
       * 与「聊天被问多频繁」），不加边框时滑块看起来像工具条的一部分。
       */
      decisionsTolerance: {
        marginBottom: "12px",
        padding: "9px 11px",
        borderRadius: "8px",
        border: "1px dashed rgba(128,128,128,.28)",
        background: "rgba(128,128,128,.04)",
      },
      /**
       * 列表的滚动容器：**表头粘的就是这一层**。
       *
       * 用 `maxHeight` 而非 `height:100%`，理由见 `decisionsWrap` 的注释。
       *
       * 高度写成 `max(160px, 100vh - 200px)` 而不是裸 `100vh - 200px`：
       * 窗口很矮时后者会变成**零甚至负数**，列表直接看不见。用 CSS `max()`
       * 兜一个下限，同时避免另一种写法 `minHeight` 的副作用——那会在只有一
       * 两行记录时于表格下方强行留出一片空白。
       *
       * 200px 是给宿主 chrome（标题栏 / tab 栏 / 本页内边距）留的余量。
       */
      decisionsScroll: {
        maxHeight: "max(160px, calc(100vh - 200px))",
        overflowY: "auto",
      },
      /** 明细表：左对齐为主（内容列要能读）。 */
      decisionsTable: {
        width: "100%",
        /**
         * **必须 `separate`，不能 `collapse`。**
         *
         * `border-collapse: collapse` 会让表头单元格的 `position:sticky`
         * 在 Chrome / Safari 上**直接失效**（边框被合并到表格元素上，单元格
         * 不再是独立的粘性盒子）。这是 sticky thead 最常见的坑，也是上一版
         * 表头不粘的直接原因之一。改成 `separate` 后每格自己的
         * `borderBottom` 照常显示，视觉不变。
         */
        borderCollapse: "separate",
        borderSpacing: 0,
        fontSize: "11px",
      },
      /**
       * 表头单元格：粘在 `decisionsScroll` 的顶部。
       *
       * 三个条件缺一个就不生效：
       *
       *   1. `top: 0` —— 粘到滚动容器上沿；
       *   2. 最近的滚动祖先**必须真的会滚** —— 由 `decisionsScroll` 的
       *      `maxHeight + overflowY:auto` 保证，且它上面（`decisionsWrap`）
       *      刻意不设 overflow，不去截胡；
       *   3. 背景**不透明** —— 否则下面的行会从表头底下透上来。
       *
       * 刻意**不用 `opacity` 压低文字**：`opacity` 作用在整个元素上，会连
       * 背景一起变半透明，正好破坏第 3 条。改用次要文字色令牌把文字压暗，
       * 背景走基色令牌，浅色/深色主题都对。
       *
       * `zIndex` 要给足：宿主的行/卡片有自己的层级，低了会被盖住。
       */
      decisionsTh: {
        textAlign: "left",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.28)",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        position: "sticky",
        top: 0,
        zIndex: 5,
        background: "var(--dsw-alias-bg-base, #1b1b1b)",
        // 表头可点排序：光标与「不选中文字」给出可点的暗示。
        cursor: "pointer",
        userSelect: "none",
      },
      decisionsTd: {
        textAlign: "left",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
        verticalAlign: "top",
      },
      /** 可点击展开的那一行。 */
      decisionsRow: {
        cursor: "pointer",
      },
      /**
       * 新增行的入场动画（DEC-044；DEC-057 把时长 300ms → 600ms，翻倍）。
       *
       * **只在「这一批比上一批多出来的行」上叠这一条**，已有行一律不带——
       * 每 5 秒轮询一次，整页重绘时若也带上动画，用户看到的会是整页在闪。
       *
       * 动画本体（`@keyframes`：opacity / 位移 / 新增行的背景色淡出）写在注入
       * 的 `<style>` 里（见 `ensureRowEnterCss`）：内联样式能写 `animation`，
       * 但**写不出** `@keyframes`，两者必须分开落地。
       */
      decisionsRowEnter: {
        animation: `${DECISION_ROW_ENTER_KEYFRAMES} 600ms ease-out both`,
      },
      /** 展开后的详情块：等宽字体 + 允许换行（内容可能是长 JSON）。 */
      decisionsDetail: {
        margin: "6px 0 10px",
        padding: "10px 12px",
        borderRadius: "7px",
        border: "1px solid rgba(128,128,128,.22)",
        background: "rgba(128,128,128,.04)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11px",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        maxHeight: "420px",
        overflowY: "auto",
      },
      /** 空态 / 提示行。 */
      decisionsEmpty: {
        padding: "18px 4px",
        fontSize: "12px",
        opacity: 0.65,
        lineHeight: 1.7,
      },
      /** 裁决词的小标签。 */
      decisionsVerdict: (color) => ({
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: "9px",
        fontSize: "10px",
        border: `1px solid ${color}`,
        color,
        whiteSpace: "nowrap",
      }),
      /** 汇总卡片。 */
      statsCards: {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        marginTop: "8px",
      },
      /** 单个汇总块。 */
      statsCard: {
        flex: "1 1 120px",
        minWidth: "120px",
        padding: "8px 10px",
        borderRadius: "7px",
        border: "1px solid rgba(128,128,128,.2)",
        background: "rgba(128,128,128,.05)",
      },
      statsCardLabel: { fontSize: "10px", opacity: 0.55, marginBottom: "3px" },
      statsCardValue: {
        fontSize: "14px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      },
      /**
       * 顶层 tab 栏。
       *
       * 贴着下边框（而不是做成胶囊组）：tab 是**页面级**导航，要和页面内
       * 的分段控件（三态模式、时间范围）在视觉层级上分开——两者都做成
       * 胶囊时，用户分不清哪个切换的是整页、哪个只是本页的一个筛选条件。
       */
      tabBar: {
        display: "flex",
        gap: "2px",
        margin: "0 0 16px",
        borderBottom: "1px solid rgba(128,128,128,.24)",
      },
      tab: (active) => ({
        padding: "7px 16px",
        marginBottom: "-1px",
        borderRadius: "7px 7px 0 0",
        border: active ? "1px solid rgba(128,128,128,.32)" : "1px solid transparent",
        borderBottom: active ? "1px solid transparent" : "none",
        background: active ? "rgba(128,128,128,.14)" : "transparent",
        color: "inherit",
        fontSize: "13px",
        fontWeight: active ? 600 : 450,
        cursor: "pointer",
        opacity: active ? 1 : 0.6,
      }),
      /**
       * 统计页容器：与配置页一样**不设最大宽度**（DEC-040）。
       *
       * 原来的 1000px 是为了「比配置页的 620px 宽——对比表有十来列」，但它同样
       * 落在一个 `overflowY: auto` 的盒子上，于是超过 1000px 的部分也得左右拖。
       * 十列表格现在直接吃满宿主给的宽度；两张表还各自包在 `overflowX: auto`
       * 里，窗口很窄时依然可以自己滚，不会因为放开限制而被裁掉。
       */
