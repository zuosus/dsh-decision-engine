    function sortableTh(column, filter, setFilter) {
      const active = filter.sort === column.key;
      return h(
        "th",
        {
          key: column.key,
          style: active ? { ...S.statsTh, opacity: 1 } : S.statsTh,
          title: t("按「{label}」排序", { label: column.label }),
          onClick: () => {
            setFilter({
              ...filter,
              sort: column.key,
              dir: active && filter.dir === "desc" ? "asc" : "desc",
            });
          },
        },
        column.label + (active ? (filter.dir === "desc" ? " ↓" : " ↑") : ""),
      );
    }

    /**
    * 裁决词 → 颜色。
    *
    * 颜色只是辅助：**不能只靠颜色区分**（色觉障碍用户看不到）。因此每个裁决词
    * 本身也写在标签里，颜色只是让它一眼可辨。
    *
    * 配色规则（用户要求「区分大一些」，2026-11-03）：
    *
    *   1. **一个裁决词一个色相**，不再让 delegate / allow / keep 共用绿色、
    *      stop / inline / skip 共用灰色——共用色相时「扫一眼」读不出区别，
    *      而这个页面的全部用途就是扫一眼看出哪几次被拦了。
    *   2. **语义上靠近的放同族色**：放行类（allow / keep / delegate）落在
    *      绿—青—蓝这一段，改写行为类（switch / redirect / advise / prune /
    *      summarize / continue）落在紫—粉段，中性不动作（stop / inline /
    *      skip / translate）落在灰—棕段，`ask` / `deny` / `degraded` 三个
    *      「要人看一眼」的独占橙 / 红 / 主文本色。
    *   3. **全部取 400–500 明度的浅色**：面板常年跑在深色主题上，深色在这个
    *      底上等于看不见。
    *
    * `degraded` 特例：用户要的是「黑色」，但纯黑在深色主题下不可读。这里用
    * 主题的**主文本色令牌**——浅色主题下它就是黑，深色主题下自动翻成浅色，
    * 语义（最中性、不带任何色相的一种状态）保住，可见性也保住。
    */
    const VERDICT_COLORS = {
      // —— 放行族 ——
      allow: "#22c55e",            // 绿：通过
      keep: "#2dd4bf",             // 青绿：保留原模型
      delegate: "#3b82f6",         // 蓝：交给主模型
      // —— 改写行为族 ——
      switch: "#0ea5e9",           // 天蓝：换模型
      redirect: "#8b5cf6",         // 紫：改用别的技能
      advise: "#d946ef",           // 品红：建议分派
      prune: "#a3e635",            // 黄绿：只裁剪工具结果
      summarize: "#fb923c",        // 浅橙：走摘要压缩
      continue: "#c084fc",         // 淡紫：续一轮
      translate: "#f472b6",        // 粉：需要翻译
      // —— 中性：什么都不改 ——
      stop: "#94a3b8",             // 灰蓝：收束本轮
      inline: "#9ca3af",           // 灰：自己接着做
      skip: "#eab308",             // 黄：跳过（不检索 / 不翻译）
      // —— 要人看一眼的三种 ——
      ask: "#f59e0b",              // 橙：升级人工确认
      deny: "#ef4444",             // 红：拦截
      degraded: "var(--dsw-alias-label-primary, #111111)", // 主文本色（浅色主题=黑）
    };

    /** 裁决词的兜底颜色：未登记的词用它，不至于看起来像出了错。 */
    const DEFAULT_VERDICT_COLOR = "#64748b";

    /**
     * 裁决词 → 中文名。
     *
     * 裁决词是**机器词**：`action` 字段写进明细文件、上报遥测、出现在
     * `detail` 的原因串里，全都是这个英文词。界面此前把它**原样**摆在
     * 「裁决」列，于是中文界面里这一列整片是英文（`delegate` / `inline` /
     * `advise` …），而它左右两列都是中文——中文用户读这张表时，最需要
     * 一眼读懂的恰恰就是这一格。
     *
     * 做法：**只在渲染边界换成中文**，数据一个字节都不动。
     *
     *   - 中文名同时登记进 `EN_LABELS`（值 = 机器词本身），所以英文界面
     *     经 `tr()` 翻回的正是原来那个词——英文界面与改前逐字一致，
     *     「英文零中文」那条断言不受影响。
     *   - 原始机器词仍然挂在 `title` 上：要对照明细文件、日志或
     *     `/session-decisions` 响应时，鼠标停上去就是那个词。
     *   - 词表与 `VERDICT_COLORS` 一一对应（同 16 个词），
     *     `test/client-decisions-view.test.js` 断言两表键集相同——
     *     新增裁决词时漏了哪一张表都会立刻变红，而不是悄悄掉回英文。
     *
     * 中文名沿用 `VERDICT_COLORS` 注释里那套说法（「交给主模型」「自己接着做」
     * 「改用别的技能」…），不另发明一套术语：那张注释已经是这套词的口径。
     */
    const VERDICT_LABELS = {
      // —— 放行族 ——
      allow: "照常放行",
      keep: "保留原模型",
      delegate: "交给主模型",
      // —— 改写行为族 ——
      switch: "换模型",
      redirect: "改用别的技能",
      advise: "建议分派",
      prune: "裁剪结果",
      summarize: "摘要压缩",
      continue: "续一轮",
      translate: "翻译",
      // —— 中性：什么都不改 ——
      stop: "收束本轮",
      inline: "自己接着做",
      skip: "跳过",
      // 让位（DEC-045）：这一轮在等用户决定，插件主动退出，不代替用户选。
      defer: "让位给用户",
      // —— 要人看一眼的三种 ——
      ask: "转人工确认",
      deny: "拒绝执行",
      // 与「标记」列的「已降级」刻意不同词：那一列说的是**这次请求**降级了，
      // 这一格说的是**这次根本没有裁决**（统计里它进「未裁决」那一格）。
      degraded: "降级未裁决",
    };

    /**
     * 一条明细记录的稳定标识。
     *
     * 服务端（`DecisionStore.readForSession`）一定会补齐 `id`，这里再兜一层，
     * 防止夹具或老服务端没带。
     *
     * **不能用 `seq` 当标识**：它只是服务端的**进程内**计数器，DSH 每重启一次
     * 就从 1 重数——实测用户的明细文件里 307 条记录只有 119 个不同的 `seq`。
     * 拿它当 React `key` 会造成重复 key，事件处理器被对到错的行上：真机现象
     * 就是「点第二个，展开的是第三个」（2026-11-03）。
     */
    function entryIdOf(entry, index) {
      if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
      return `${entry?.ts ?? ""}#${entry?.seq ?? index}`;
    }

    /**
     * 决策历史表格的列定义。
     *
     * `key` 同时是**排序键**与 React key 的一部分，`label` 走 `t()`。
     * 每一列都可点：用户要的是「表头每一个都能排序」。
     */
    const DECISION_COLUMNS = [
      { key: "ts", label: "时间" },
      { key: "point", label: "决策点" },
      { key: "provider", label: "提供方" },
      { key: "model", label: "模型" },
      { key: "action", label: "裁决" },
      { key: "latencyMs", label: "耗时" },
      // 「内容」列回答的是**这次到底存没存内容**：有内容(1) → 只有元数据(0)。
      //
      // 它此前渲染的是「缓存命中 / 已降级」标记——表头叫「内容」，排的却又是
      // 有没有内容，名与实与排序键三样对不上（DEC-028 也把这两件事混写了）。
      // 缓存/降级标记是**另一件事**，单独给一列「标记」（DEC-029）。
      { key: "capture", label: "内容" },
      // 「标记」列：缓存命中 / 已降级。排序值按状态分组（无 → 已降级 → 缓存），
      // 让「哪几次花了钱、哪几次是降级放行」各自聚在一起。
      { key: "flags", label: "标记" },
    ];

    /** 取一条记录在某一列上的排序值。 */
    function decisionSortValue(entry, key, pointLabels) {
      switch (key) {
        case "ts":
          return String(entry?.ts ?? "");
        case "point": {
          const id = String(entry?.point ?? "");
          // 按**显示名**排，不按内部 id：用户看到的是中文名，
          // 按 id 排会出现「工具授权 / 检索必要性 / 轮次延续」乱序。
          return String(pointLabels[id] ?? id);
        }
        case "provider":
          return String(entry?.provider ?? "");
        case "model":
          return String(entry?.model ?? "");
        case "action": {
          const word = String(entry?.action ?? "");
          // 按**显示名**排，不按机器词：这一列现在写的是中文，按英文词排
          // 会出现「放行类被 adv/allow/deny 的字母序打散」。与「决策点」列同
          // 一口径；机器词未登记时退回原词，不会排成空串。
          return String(VERDICT_LABELS[word] ?? word);
        }
        case "latencyMs":
          return Number(entry?.latencyMs) || 0;
        case "capture":
          return entry?.capture === "meta" ? 0 : 1;
        case "flags":
          // 无 = 0 / 已降级 = 1 / 缓存命中 = 2：升序把同一状态聚在一起。
          if (entry?.cached === true) return 3;
          if (entry?.backup === true) return 2;
          if (entry?.degraded === true) return 1;
          return 0;
        default:
          return "";
      }
    }

    /**
     * 按列排序记录。
     *
     * 同值时**退回时间升序、再退回原始顺序**：列表每 5 秒会被轮询刷新，
     * 如果同值行每次渲染都在彼此之间跳，用户读到一半就会串行。稳定的
     * 次级键比「看起来更随机」重要。
     *
     * 一个例外（DEC-044）：主键本身就是「时间」时，原始顺序这一档**跟着主键
     * 方向走**。`ts` 只到毫秒，同一毫秒里可以有好几条记录（存储层正是为此
     * 才留了进程内 `seq`）；默认降序时若把它们排成写入顺序升序，一批同时
     * 发生的记录就会与整列的方向反着。
     */
    function sortDecisionEntries(entries, sort, pointLabels) {
      const key = DECISION_COLUMNS.some((column) => column.key === sort?.key) ? sort.key : "ts";
      const direction = sort?.dir === "desc" ? -1 : 1;
      return entries
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => {
          const a = decisionSortValue(left.entry, key, pointLabels);
          const b = decisionSortValue(right.entry, key, pointLabels);
          const primary = typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b));
          if (primary !== 0) return primary * direction;
          const byTime = String(left.entry?.ts ?? "").localeCompare(String(right.entry?.ts ?? ""));
          if (byTime !== 0) return byTime;
          return (left.index - right.index) * (key === "ts" ? direction : 1);
        })
        .map((item) => item.entry);
    }

    /**
     * 把任意值序列化成可读文本。
     *
     * 循环引用之类的问题不该让整页崩掉——序列化失败时给一句话说明。
     */
    function safeJson(value) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }

