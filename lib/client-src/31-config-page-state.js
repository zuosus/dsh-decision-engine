    /**
     * 配置页：仿照内置 dsh-rewind-plugin 的卡片布局——
     * 每行左侧是「标题 + 灰色说明」，右侧是控件。
     *
     * **改完即保存，没有「保存」按钮**：
     *   - 开关 / 下拉 / 分段控件：点一下就落盘；
     *   - 文本框（地址、请求头）：停手 `AUTOSAVE_DELAY_MS` 后落盘，失焦立刻落盘；
     *   - API Key：失焦或回车才落盘（见 `commitKey`）。
     * 落盘状态显示在底部一行（保存中 / 已保存 / 失败原因 + 重试），
     * 取代了原来那个按钮。
     *
     * 数据全部走本插件自己的 `/api/decision-engine/*`，**不用** settings 服务
     *（旧插件死在 `settings.installSection` 上）。落盘即改写 config.yml。
     *
     * @param props - 槽位属性；`view === "summary"` 时只渲染一行摘要文本。
     */
    function StartluxPage(props) {
      const [status, setStatus] = react.useState(null);
      // 密钥输入按 provider 分槽（键 = provider id）：切到别的 provider 时，
      // 这一格不该带过去，否则容易把 A 的 key 存到 B 名下。槽位不预置名单——
      // 读的时候一律 `?? ""`，新增 provider 不必再改这里。
      const [keyInputs, setKeyInputs] = react.useState({});
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      // 草稿初值是 null（= 还没有用户改动）。渲染时从服务端状态派生，
      // 而不是在这里写一份硬编码默认：否则「status 已回来但 useEffect 还没跑」
      // 的那一帧会显示错的值（例如把 custom 显示成 systemone）。
      const [draftState, setDraft] = react.useState(null);
      // provider 草稿：与主配置分开保存，因为 custom 的五个字段是「先填后切」，
      // 混进主 draft 会让「只切 provider」也顺手把没填完的 custom 值写进去。
      const [providerDraftState, setProviderDraft] = react.useState(null);
      // 保存位置：credentials（默认）| config
      const [storageDraft, setStorageDraft] = react.useState(null);
      // 服务端校验失败的原因（如 base URL 非法）单独展示，与「已保存」区分。
      const [providerError, setProviderError] = react.useState("");
      // 可选模型列表：从 /models 拉取（只含决策端点真正接受的模型）。
      const [models, setModels] = react.useState([]);
      const [modelsState, setModelsState] = react.useState("idle");
      // 决策点：元数据与实测分账都由服务端下发，前端不硬编码清单。
      const [decisions, setDecisions] = react.useState(null);
      // 待保存的模式改动（id → mode）；null 表示该行未改动，沿用服务端值。
      const [pointsDraft, setPointsDraft] = react.useState({});
      // ---- 统计与对比 ----
      // 统计结果：null = 还没拉过；对象 = 拉到了（区间内可能没数据）。
      const [stats, setStats] = react.useState(null);
      // 统计请求的失败原因。
      const [statsError, setStatsError] = react.useState("");
      // 当前统计的筛选条件：范围预设 + 自定义起止 + 排序。
      // 用一个对象存，改动时整体替换——比六个独立 state 好管。
      const [statsFilter, setStatsFilter] = react.useState({
        preset: "today",
        start: "",
        end: "",
        sort: "inputTokens",
        dir: "desc",
      });
      /**
       * 当前 tab：`config` | `stats`。
       *
       * 统计从配置页里搬出来独立成一页：一张十列的对比表挤在表单末尾，
       * 既看不清，也让本来就长的配置页更难用。
       */
      const [tab, setTab] = react.useState("config");
      /**
       * 统计页的静态元数据（可选范围清单 + 标签），与每次查询的结果分开存。
       *
       * 分开存的原因：`stats` 在「自定义范围还没填完」时会被清成 null，
       * 如果预设清单也只从 `stats` 取，那一行的按钮会全部消失——用户既看不到
       * 可选范围，也切不回别的预设，被卡在自己没填完的表单里。
       * 清单与标签是不随查询变的元数据，拿到一次就该留着。
       */
      const [statsMeta, setStatsMeta] = react.useState({ presets: [], labels: {} });

      // 用 ref 保存「用户是否有未保存改动」，使 refresh 不因状态变化而重建。
      // 否则落盘时 setDirty(false) → refresh 换新引用 → useEffect 再跑一次，
      // 与 flush 里的 setStatus 竞争，可能用旧值把刚保存的开关覆盖回去（表现为回弹）。
      const dirtyRef = react.useRef(false);
      const savingRef = react.useRef(false);
      // 落盘状态：null（无提示）| "saving" | "saved" | { error }。取代原来的保存按钮。
      const [saveState, setSaveState] = react.useState(null);
      /**
       * 配置页四个分组的展开状态（DEC-051）`{ connection, guard, record, model }`。
       *
       * 纯 UI 偏好，**不进 config.yml**：那份文件是给别的进程读的运行配置，
       * 往里塞「用户上次折叠了哪一组」只会让配置多一条与运行无关的键。
       * 初值从 localStorage 读——刷新页面后分组不该自己弹回来。
       *
       * 放在所有 useState 的**最后**（与 `saveState` 相邻、`useLang` 之前是
       * 同一段「末尾区」）：本文件的渲染测试按「第 n 个 useState」注入状态，
       * 插在中间会把后面所有槽位挪位，那是改一行红一片的事故。
       */
      const [sectionOpen, setSectionOpen] = react.useState(() => readSectionOpen());
      /**
       * 图表模块就绪状态（见 loadCharts）。
       *
       * 同样放在所有 useState 的**末尾**（理由见上一条）：测试按
       * 「第 n 个 useState」注入状态，插在中间会把既有槽位全部挪位。
       * 这是本次改动唯一新增的状态槽位，排在最后，既有槽位序号不变。
       *
       * 初值不是 `null` 而是当前已加载的模块：用户切走再切回统计页时，
       * 分块早已缓存，直接拿到模块即可，不必再经历一次 loading。
       */
      const [chartsReady, setChartsReady] = react.useState(() => chartsModule);
      /**
       * 圆环里被**手动隐藏**的决策点 id 集合。
       *
       * 为什么需要这个功能：「工具授权」这类决策点常年占 95% 以上，圆环上
       * 它一格吃掉几乎整个圆周，其余几个点挤成一条几像素的细边——于是
       * 「它们之间的相对比例」这件事在图上彻底读不出来。隐藏掉那个巨无霸后，
       * 剩下的点会**重新归一化**（各自占比按剩余总量算），彼此的比例才看得清。
       *
       * 存的是「被排除的」而不是「被选中的」：默认全显示，用户点掉不想看的
       * 那一个。若存「被选中」，区间换了、决策点集合变了时默认值就会变成
       * 「什么都不显示」——那是一屏空白，而不是一份正常的图。
       *
       * 为什么是 Set 而不是数组：判断「这个点是否隐藏」在每次渲染里对每个
       * 决策点各做一次，数组的 includes 是线性查找；Set 的 has 是常数级。
       */
      const [hiddenPoints, setHiddenPoints] = react.useState(() => new Set());

      /**
       * 走势图的**当前点读数**（hover 移动 / 点击钉住时更新）。
       *
       * 为什么需要它自己一份状态：交互版图型把「当前是第几个点」放在**组件
       * 内部**，外部拿不到——只能通过 `onActive` / `onSelect` 回调把值带出来。
       * 没有这块读数，交互就只剩下一根会动的线：读者看到高亮圆点，却不知道
       * 那个点是多少。
       *
       * 存成 `{ label, value, index }` 而不是裸数字：要显示的是「14时 · 128 次」，
       * 时间标签与数值必须一起带出来。
       */
      const [trendReadout, setTrendReadout] = react.useState(null);

      /**
       * 切换某个决策点在圆环里的显示/隐藏。
       *
       * 用新 Set 而不是就地 mutate：React 靠引用比较判断要不要重绘，
       * 就地 `add`/`delete` 会得到同一个引用，界面不更新（点了没反应）。
       */
      const togglePointHidden = react.useCallback((pointId) => {
        setHiddenPoints((previous) => {
          const next = new Set(previous);
          if (next.has(pointId)) next.delete(pointId);
          else next.add(pointId);
          return next;
        });
      }, []);
      // 切到统计页时确保图表分块已开始加载；加载完成（或失败）时重绘一次。
      //
      // 依赖 `tab`：没人打开统计页就不下载分块——那是「只有统计页用得上」
      // 的东西，在配置页提前下载等于让所有人为一个可能不打开的 tab 付费。
      react.useEffect(() => {
        if (tab !== "stats") return;
        if (chartsReady !== null) return;
        let alive = true;
        const unsubscribe = subscribeCharts((mod) => {
          if (alive === true) setChartsReady(mod);
        });
        // `require` 由 factory 注入，这里通过闭包拿到（见 apply 的 factory 参数）。
        void loadCharts(factoryRequire).then((mod) => {
          if (alive === true && mod !== null) setChartsReady(mod);
        });
        return () => {
          alive = false;
          unsubscribe();
        };
      }, [tab, chartsReady]);
      // 分组折叠的样式表（竖线与语义色）注进 document.head。
      // 与「决策历史」页的入场动画同一套路：注不上就不注（Node 测试环境
      // 没有 document），分组照样渲染、照样能展开收起，只是少了竖线。
      react.useEffect(() => {
        ensureCfgSectionCss();
      }, []);
      // 语言变化时重绘本页。放在所有 useState 之后：测试是按「第 n 个
      // useState」注入状态的，插在中间会把后面的槽位全部挪位。
      useLang();
      /**
       * 待落盘值的唯一真源。
       *
       * 不能用渲染闭包里的 `draft`：`setState` 是异步的，一次事件里改完立刻
       * 发请求时闭包里还是旧值（会把改动存丢）。因此所有控件先同步写这里，
       * 再 setState 触发重绘；flush 只读这里。
       */
      const valuesRef = react.useRef(null);
      /** 每次改动自增：用来判断「响应回来时用户是否又改过」，避免旧快照覆盖新输入。 */
      const editSeqRef = react.useRef(0);
      /** 防抖计时器。 */
      const timerRef = react.useRef(null);
      /** 本次待落盘是否要连配置一起写（仅决策点改动时为 false）。 */
      const pendingRef = react.useRef(null);
      /**
       * 明确提交密钥的 provider（失焦 / 回车）。
       *
       * 与普通改动分开：密钥不能随防抖自动提交，否则打字途中每停一下都会把
       * 半截 key 写进凭据文件；这里记下「这一次是用户按下提交」，flush 时
       * 才把它并进 patch，成功后清空。
       */
      const keyCommitRef = react.useRef(null);

      const refresh = react.useCallback(async () => {
        // 保存进行中不拉状态，避免用旧快照覆盖刚写入的结果。
        if (savingRef.current === true) return;
        try {
          const next = await call("/status");
          setStatus(next);
          if (dirtyRef.current !== true) {
            // 字段表与首屏 / 保存成功后共用一份（draftFromStatus）：
            // 此前三处各手写一份，refresh 这一处漏了 telemetryLevel，于是
            // 「关掉匿名统计 → 退出配置页 → 再进来」下拉又显示 daily。
            setDraft(draftFromStatus(next));
            // provider 回显：保存后重新打开必须看到自己选的那一项与 custom 值。
            // 全部来自服务端 status，前端不缓存、不推断。
            setProviderDraft(providerDraftFromStatus(next));
            setProviderError(next.providerValid === false ? next.providerError ?? "配置不可用" : "");
          }
          setMsg(null);
        } catch (error) {
          setMsg({ ok: false, text: error.message });
        } finally {
          setLoading(false);
        }
      }, []);

      // 决策点与模型列表都拉一次；失败不阻塞页面渲染。
      react.useEffect(() => {
        refresh();
        loadDecisions();
      }, [refresh]);

      /** 拉取可用决策模型；失败不阻塞页面，只标记状态供 UI 提示。 */
      const loadModels = react.useCallback(async () => {
        setModelsState("loading");
        try {
          const result = await call("/models");
          const list = Array.isArray(result.models) ? result.models : [];
          setModels(list);
          setModelsState(list.length > 0 ? "ok" : "empty");
        } catch {
          setModels([]);
          setModelsState("error");
        }
      }, []);

      /** 拉决策点总览（含每个点的实测 token / 延迟 / 缓存）。 */
      const loadDecisions = react.useCallback(async () => {
        try {
          const result = await call("/decisions");
          setDecisions(result);
        } catch {
          // 拉不到就不显示这一节，而不是显示一排空值误导用户。
          setDecisions(null);
        }
      }, []);

      /**
       * 拉统计数据。
       *
       * 筛选条件全部走**查询参数**发给服务端，前端不做任何聚合计算：
       * 口径（省了多少、基线是什么）只有服务端一处定义，前端再算一遍
       * 必然出现「界面与导出数据对不上」。
       *
       * @param filter - 范围预设、起止、排序字段与方向。
       */
      const loadStats = react.useCallback(async (filter) => {
        // 自定义范围没填全时不发请求：服务端只会回「需要合法的起止时间」，
        // 而那是用户还没填完，不是出错了——把没填完显示成错误很误导。
        if (filter.preset === "custom" && (filter.start.length === 0 || filter.end.length === 0)) {
          setStats(null);
          setStatsError("");
          return;
        }
        const query = new URLSearchParams();
        query.set("preset", filter.preset);
        if (filter.preset === "custom") {
          query.set("start", filter.start);
          query.set("end", filter.end);
        }
        query.set("sort", filter.sort);
        query.set("dir", filter.dir);
        try {
          const result = await call(`/stats?${query.toString()}`);
          setStats(result);
          // 元数据单独留一份：清掉 stats 时预设清单不能跟着消失。
          setStatsMeta({
            presets: Array.isArray(result.presets) ? result.presets : [],
            labels: result.labels ?? {},
          });
          setStatsError("");
        } catch (error) {
          // 拉不到就显示原因，而不是留一张空表让人以为「这段时间没用过」。
          setStatsError(error instanceof Error ? error.message : String(error));
        }
      }, []);

      /**
       * 条件或 tab 变化时重查。
       *
       * 只在统计 tab 打开时才发这一请求：配置 tab 下没人看它，而它每次都要
       * 读完整个统计文件（几万条时不是零成本）。
       */
      react.useEffect(() => {
        if (tab !== "stats") return;
        void loadStats(statsFilter);
      }, [loadStats, statsFilter, tab]);

      // summary 视图只输出一行纯文本（插件列表/包详情用它做摘要）。
      if (props !== null && props !== undefined && props.view === "summary") {
        return "Decision Engine 守卫";
      }

