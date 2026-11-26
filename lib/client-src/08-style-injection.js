    const i18n = { EN, T, tr, t, setLang, normalizeLang, readHostLang, browserLang, get lang() { return lang; } };
    /* ============================================================
     * 新增行的入场动效（DEC-044；DEC-057 把时长翻倍并加了背景色淡出）
     *
     * 三条约定，缺一条这个动画就是错的：
     *
     * 1. **`@keyframes` 只能落在样式表里**。本面板的样式全是内联对象
     *    （`S.xxx`），内联能写 `animation`，却写不出 `@keyframes`——于是
     *    必须往 `document.head` 注一个 `<style>`。
     * 2. **注不上也不能把行搞没**。用的是 `animation: <name> …`：浏览器里
     *    找不到同名 keyframes 时整条 animation 直接失效，行按平常样子出现。
     *    这是**故意**的失败方向——动画没了只是少了个提示，行不显示是这个
     *    页面的故障。所以既不用 `transition` + 挂载后置位的写法（那种做
     *    法是「先透明再变实」，effect 一没跑成就永久透明），也不用 `opacity`
     *    先置 0。
     * 3. **尊重系统的「减弱动态效果」**。动画只在系统没要求减弱时加；判定
     *    放在这里而不是写进样式表的 `@media`，因为内联样式的优先级高于
     *    样式表——`@media (prefers-reduced-motion)` 盖不住内联的 `animation`。
     * ============================================================ */

    /** keyframes 名；`S.decisionsRowEnter` 的 `animation` 引用它。 */
    const DECISION_ROW_ENTER_KEYFRAMES = "dsh-decision-row-enter";
    /** 注入的那个 `<style>` 的 id：用它做幂等判定。 */
    const DECISION_ROW_ENTER_STYLE_ID = "dsh-decision-row-enter-css";
    /**
     * 入场关键帧（DEC-044；DEC-057 加了背景色淡出）。
     *
     * 新增行起始带一层靛蓝高亮底色，随整段动画逐渐褪到同色相的 alpha=0
     * ——也就是行默认的「无背景色」。颜色只写在关键帧里、不写成行内联
     * `background`：样式表注不上时整条 `animation` 失效，高亮随之消失，
     * 行按默认背景出现，绝不会卡在一层底色上（见上面第 2 条约定）。
     * 收尾用 `rgba(...,0)` 而非 `transparent` 关键字，避免部分引擎把透明
     * 色按 `rgba(0,0,0,0)` 插值、中途透出灰调。
     */
    const DECISION_ROW_ENTER_CSS =
      `@keyframes ${DECISION_ROW_ENTER_KEYFRAMES}{` +
      "from{opacity:0;transform:translateY(-4px);background-color:rgba(99,102,241,.28)}" +
      "to{opacity:1;transform:translateY(0);background-color:rgba(99,102,241,0)}}";

    /**
     * 幂等地把 keyframes 注进 `document.head`。
     *
     * 全程包 try/catch 并返回布尔：没有 `document`（Node 里的渲染测试）、
     * 页面 CSP 挡了 `<style>`、head 还没挂上——任何一种都**不该**冒到渲染
     * 路径上。注不上就是不动画，行照常出现。
     */
    function ensureRowEnterCss() {
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
        const parent = document.head ?? document.body;
        if (!parent) return false;
        if (typeof document.getElementById === "function" && document.getElementById(DECISION_ROW_ENTER_STYLE_ID)) return true;
        const tag = document.createElement("style");
        tag.id = DECISION_ROW_ENTER_STYLE_ID;
        // 与宿主自带的插件样式标签同一个识别口径（`data-plugin-css`），
        // 将来排查「这条样式是谁注的」时能一眼看到包名。
        tag.dataset.plugin = "dsh-decision-engine";
        tag.dataset.pluginCss = DECISION_ROW_ENTER_STYLE_ID;
        tag.textContent = DECISION_ROW_ENTER_CSS;
        parent.appendChild(tag);
        return true;
      } catch {
        return false;
      }
    }

    /** 系统是否要求「减弱动态效果」。读不到就按不减弱（照常动画）。 */
    function prefersReducedMotion() {
      try {
        if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
          return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
        }
      } catch {
        /* 读不到就当没要求 */
      }
      return false;
    }

    /**
     * 把 `rgb(r, g, b)` / `rgba(r, g, b, a)` 解析成三个通道；读不懂返回 `null`。
     *
     * 只认**计算后**的颜色格式（样式表算完就是 rgb/rgba），别的一律当
     * 「没探到」：宁可退回浏览器默认，也不拿一个猜出来的深浅去上色。
     * alpha 太低的底（`transparent`、`rgba(0,0,0,0)`）同样返回 `null`——
     * 半透明的底看不出深浅，用它判主题只会判错。
     */
    function parseCssRgb(text) {
      if (typeof text !== "string") return null;
      const match = /^rgba?\(([^)]+)\)$/i.exec(text.trim());
      if (match === null) return null;
      const parts = match[1].split(/[\s,/]+/).filter((part) => part !== "");
      if (parts.length < 3) return null;
      const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
      if (channels.some((value) => !Number.isFinite(value))) return null;
      const alpha = parts.length >= 4 ? Number.parseFloat(parts[3]) : 1;
      if (!Number.isFinite(alpha) || alpha < 0.5) return null;
      return channels;
    }

    /**
     * 宿主此刻是深色还是浅色主题：`"dark"` / `"light"`，探不到返回 `null`。
     *
     * 为什么必须真探一次：原生 `<select>` 的**弹层**是浏览器自己画的一层，
     * 它既不继承页面的透明底，也不吃 `color: inherit`——弹层底色只看
     * `color-scheme`（默认浅色 = 白），而选项文字继承的是页面文字色。
     * 深色主题下于是变成**白底白字**：几个选项一个都看不见，只剩一条
     * 蓝色高亮（DEC-091）。
     *
     * 为什么不用 `prefers-color-scheme`：那个只反映操作系统偏好。用户可以在
     * DSH 里单独切主题，两者不一致时它就会答错——而答错的后果正是这次
     * 要修的那个不可读状态。这里改问宿主自己：造一个 0 尺寸的探针挂上
     * 宿主的基色令牌（`--dsw-alias-bg-base`），读它的**计算值**再算亮度。
     *
     * 探不到就返回 `null`（Node 渲染测试没有 `document`、宿主没定义该令牌、
     * 探针被 CSP 拦下）：调用方退回 `color-scheme: light dark`，交回浏览器
     * 按系统偏好判——不比现状更糟，也绝不写死一个颜色。
     */
    function hostColorScheme() {
      try {
        if (typeof document === "undefined" || typeof getComputedStyle !== "function") return null;
        if (typeof document.createElement !== "function") return null;
        const host = document.body ?? document.documentElement;
        if (!host || typeof host.appendChild !== "function") return null;
        const probe = document.createElement("span");
        // 0 尺寸 + 固定定位：不参与布局、不出滚动条、不挡点击。
        probe.style.cssText =
          "position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;background:var(--dsw-alias-bg-base, transparent)";
        host.appendChild(probe);
        let raw = "";
        try {
          raw = getComputedStyle(probe).backgroundColor ?? "";
        } finally {
          // 探针必须收掉：留在 DOM 里会多一个节点（宿主的无障碍树也会看见它）。
          if (typeof probe.remove === "function") probe.remove();
          else if (typeof host.removeChild === "function") host.removeChild(probe);
        }
        const channels = parseCssRgb(raw);
        if (channels === null) return null;
        // 相对亮度的简化算法（WCAG 的 0.2126R + 0.7152G + 0.0722B，按 0–255 归一）。
        // 只需要分「深底 / 浅底」，不必做伽马校正。
        const luminance = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
        return luminance > 0.5 ? "light" : "dark";
      } catch {
        /* 探针失败一律当「没探到」：调用方会走浏览器默认 */
        return null;
      }
    }

    /* ============================================================
     * 配置页的分组折叠（DEC-051）
     *
     * 样式参考 @xbzbing/dsh-git-panel 的插件配置页：分组标题是一行
     * 可点的按钮（chevron 指示开合），正文挂在标题下面；标题左侧有
     * 一个色块图标，色块与正文左侧的竖线用同一个语义色，一眼能看出
     * 「下面这些行属于这一组」。
     *
     * 为什么必须用样式表而不是内联对象：本面板的样式全是内联的
     * （`S.xxx`），内联能写 `display:flex`，却写不出
     * `border-left: 2px solid var(--tone)` 这种**依赖祖先变量**的规则
     * ——tone 定义在 section 元素上，正文是它的后代，内联样式给不了
     * 祖先到后代的关系。样式表里的 `.de-cfg__section-body` 才能用
     * `var(--de-cfg-tone)` 继承到分隔竖线上。
     *
     * 失败方向是安全的：样式表注不上（Node 测试环境 / CSP 挡住）时，
     * 分组照样渲染、照样能展开收起，只是没有那条语义竖线与 hover 底色。
     * ============================================================ */

    // BEGIN CONFIG CONTROLS
    // 构建期由 lib/client.config-controls.js 覆盖（勿在此处编辑）。
    // 这里刻意不留副本：两份实现必然漂移，而产物只认配置源那一份。
    // END CONFIG CONTROLS

    /** 分组折叠样式的 style 标签 id（幂等判定用）。 */
    const CFG_SECTION_STYLE_ID = "dsh-decision-engine-cfg-section-css";
    const CFG_SECTION_CSS = `
/* 构建期由 lib/client.config.css 覆盖（勿在此处编辑）。 */
`;

    /**
     * 幂等地把分组折叠样式注进 `document.head`。
     *
     * 与 `ensureRowEnterCss` 同一套路：注不上就**不注**（不抛错），
     * 分组照样渲染——只是少了竖线与 hover 底色，不影响功能。
     */
    function ensureCfgSectionCss() {
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
        const parent = document.head ?? document.body;
        if (!parent) return false;
        if (typeof document.getElementById === "function" && document.getElementById(CFG_SECTION_STYLE_ID)) return true;
        const tag = document.createElement("style");
        tag.id = CFG_SECTION_STYLE_ID;
        tag.dataset.plugin = "dsh-decision-engine";
        tag.dataset.pluginCss = CFG_SECTION_STYLE_ID;
        tag.textContent = CFG_SECTION_CSS;
        parent.appendChild(tag);
        return true;
      } catch {
        return false;
      }
    }

    /* ============================================================
     * 统计页图表（microcharts）——按需加载 + 降级
     *
     * 统计页原来全是表格。表格能回答「谁多谁少」，却很难一眼看出
     * 「构成是不是偏了」「走势有没有掉下去」——那两类问题本来就要看形状，
     * 而形状正是图表擅长、而数字不擅长的事。所以这一版给统计页补上图型，
     * **表格保留**（精确核对仍然要靠数字）。
     *
     * 三条硬约束决定了这里的实现形态：
     *
     * 1. **不能进首屏 bundle**。microcharts 是第三方库，只有统计页用得上；
     *    内联进 client.js 等于让每个打开设置页的人都为它付体积。因此走
     *    宿主的包内分块机制（`require.async("./client.charts.js")`），
     *    切到统计页才下载，下载完就缓存。
     *
     * 2. **加载失败不能让统计页坏掉**。分块可能因为宿主版本、缓存、
     *    网络任何一环失败。此时统计页必须**照常显示表格**——图表是增强，
     *    不是前提。`charts === null` 就是那条降级路径，不报错、不空白。
     *
     * 3. **测试环境没有分块加载器**。渲染测试里 `require` 只有 react，
     *    `require.async` 不存在。那时同样走降级（只渲染表格），
     *    于是「有没有图表」不会影响既有断言的稳定性。
     * ============================================================ */

