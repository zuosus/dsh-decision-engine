    function DecisionsView(props) {
      const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
      const [page, setPage] = react.useState(null);
      const [error, setError] = react.useState("");
      const [loading, setLoading] = react.useState(true);
      // 展开中的记录。值是该记录的 `id`（全局唯一），**不是 `seq`**——
      // seq 只是服务端的进程内计数器，跨重启会重复（见 `entryIdOf` 的注释）。
      const [expanded, setExpanded] = react.useState(null);
      /**
       * 决策点 id → 中文名，由**这个视图自己拉**（`/decisions` 已经在下发）。
       *
       * 为什么不从 props 拿：宿主并不给 `conversation.view` 传这个表，而我在
       * 注册时也没法带（注册发生在 `apply()`，那时还没有任何服务端数据）。
       * 曾经因此把 props 当来源、兜底成 `{}`，结果真机上芯片与「决策点」列
       * 显示的是 `turnStop` 这种**原始 id**，用户根本认不出是哪个决策点。
       * 视图自己拉一次即可，与页面其它部分用的是同一份服务端元数据。
       *
       * **序号即契约**：本文件的渲染测试按「第 n 个 useState」注入状态
       * （`SLOTS`），插在中间会把后面所有槽位挪位，测试会静默断言错对象。
       * 新增的状态一律**追加在末尾**（当前末位是 `newIds`，序号 9）。
       */
      const [labels, setLabels] = react.useState(props?.pointLabels ?? null);
      /**
       * 表格排序：`{ key, dir }`。**默认按时间降序**（最新一条在最上面）。
       *
       * `key` 是列标识（与表头的 `key` 一致），`dir` 是 `"asc"` / `"desc"`。
       *
       * 为什么默认降序（DEC-044，改掉原先的升序）：这个页面看的是「刚才发生了
       * 什么」——数据每 5 秒自己往上长，用户打开它的第一眼要的就是最近那次
       * 裁决。升序时最新记录在列表**底部**，而这里的滚动容器是 `maxHeight` +
       * 自己滚（见 `decisionsScroll`），首屏停在顶部：每次都得滚到底才看得到
       * 刚发生的事，而且新记录从视野下方冒出来，本身就看不见。降序 + 「新增行
       * 入场动画」才是同一个诉求的两半：新的东西出现在眼前，并且看得见它出现。
       *
       * 为什么排序放在**客户端**而不是让服务端排：这个页面读的是**单个会话**
       * 的最近几百条，数据早就在内存里了；再发一次请求去排同一批数据只会多
       * 一次延迟，而且排序方向一变就得重新取数（服务端那边是按时间取尾部的，
       * 排起来还要处理分页语义）。服务端只决定「取哪几百条」，怎么排是视图的事。
       *
       * **序号即契约**（与 `labels` 同理）：测试按 useState 序号注入，
       * 新的状态只能追加在末尾，不要插到它前面。
       */
      const [sort, setSort] = react.useState({ key: "ts", dir: "desc" });

      /**
       * 人工审核比例的本地草稿（DEC-035）。
       *
       * 与排序同一个理由受**序号即契约**约束：测试按 useState 序号注入，插在中间
       * 会把 `labels` / `sort` 之后的所有槽位挪位。
       *
       * 这里**没有**配置页那条自动保存链路（flush / 防抖 / 串行队列）：
       * 决策历史页只有一个控件需要落盘，为它搬一整套机制不值得。直接
       * PUT `/config`（那是对档位唯一的写入口），失败就把草稿退回服务端的值
       * 并显示原因——档位是「点一下就该马上生效」的东西，不能显示一个
       * 实际没落盘的状态。
       */
      const [toleranceDraft, setToleranceDraft] = react.useState(null);
      const [toleranceSaving, setToleranceSaving] = react.useState(false);
      const [toleranceError, setToleranceError] = react.useState("");
      /**
       * **这一批**里刚出现、需要播入场动画的记录 id（DEC-044）。
       *
       * 为什么是 state 而不是渲染时对着 `useRef` 现算：动画挂在**样式**上，样式
       * 活多久动画就播多久。渲染时现算等于「effect 登记完，下一次重绘就不再是新行」，
       * 而登记之后立刻会有一次重绘——整段入场动画被掐在头几帧里，用户看到的仍然
       * 是「行直接出现」。放在 state 上，这份标记**跟着这一批数据活到下一次取数
       * （5 秒后）**，中间无论宿主重绘多少次（切 tab、聊天区更新、翻排序、展开行）
       * 动画都不被打断；5 秒后动画早结束了，标记被下一批覆盖等于无事发生。
       *
       * **序号即契约**（与 `labels` / `sort` 同理）：测试按 useState 序号注入，
       * 这条目前是末位、序号 9——往后再加状态只能往它**后面**追加。
       */
      const [newIds, setNewIds] = react.useState(null);

      /**
       * 「已经取到过哪些记录」——新增判定的基线（DEC-044）。
       *
       * `null` = 还没建立基线，于是**首屏那一整批不动画**：动画说的是「这条是刚
       * 冒出来的」，而首屏的几十条没有一条是刚冒出来的，一起淡入只会变成一次整页
       * 闪动，谁也看不出哪条是新的。
       *
       * 用 `useRef` 而不是 `useState`：它只是取数之间的记忆，不该触发重渲染；
       * 而且**必须在 `load` 里同步更新**（不是在 effect 里事后补），否则同一次
       * 轮询里连着两次重绘会把同一批记录当成两次新增。
       */
      const seenIdsRef = react.useRef(null);

      const pointLabels = labels ?? props?.pointLabels ?? {};

      /**
       * 取一页记录，并**在这次取数里**算出哪些是新增的。
       *
       * 新增判定放在取数、而不是放在渲染里，是因为「新不新」是**这一批数据的属性**
       * （相对上一批多出来的那些），与这一帧怎么排、用户点没点都无关。
       */
      const load = react.useCallback(async () => {
        if (sessionId.length === 0) {
          setLoading(false);
          return;
        }
        try {
          const result = await call(`/session-decisions?sessionId=${encodeURIComponent(sessionId)}`);
          // 身份用 `entryIdOf`：与表格里 React key / 展开判定同一个口径，三处永远
          // 认同一个东西。兜底 id 带位置，所以「没有 id 也没有 seq」的手工记录可能
          // 偶发一次多余动画——只影响一行淡入，不影响任何正确性。
          const ids = (Array.isArray(result?.entries) ? result.entries : []).map(
            (item, index) => entryIdOf(item, index),
          );
          const baseline = seenIdsRef.current;
          const fresh = baseline === null ? [] : ids.filter((id) => !baseline.has(id));
          // 空批**不动**基线：还没取到数据（或这个会话本来就没记录）时把基线立成
          // 空集，等真数据到了就会把整批当成新增，首屏整页动画。
          if (ids.length > 0) seenIdsRef.current = new Set(ids);
          setNewIds(fresh.length > 0 && !prefersReducedMotion() ? fresh : null);
          setPage(result);
          setError("");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setLoading(false);
        }
      }, [sessionId]);

      /**
       * 决策点名表拉一次即可（它是配置，不随会话变化）。
       *
       * 失败不报错：拿不到名表就退回显示原始 id——**功能仍然可用**，
       * 只是名字不好看。为一个「显示名」把整个页面判成错误是本末倒置。
       */
      react.useEffect(() => {
        if (props?.pointLabels !== undefined) return;
        let cancelled = false;
        void (async () => {
          try {
            const result = await call("/decisions");
            const map = {};
            for (const point of result?.points ?? []) {
              if (typeof point?.id === "string") map[point.id] = point.label ?? point.id;
            }
            if (!cancelled) setLabels(map);
          } catch {
            /* 拿不到名表就继续用原始 id */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [props?.pointLabels]);

      // 挂载即拉一次；之后按固定节奏补拉，让新产生的决策自己出现。
      //
      // 拉取失败**不重置**已有数据：一次网络抖动不该把用户正在看的记录清空。
      react.useEffect(() => {
        // 依赖键是 `load`，而 `load` 只在**换会话**时换身份（`useCallback` 的
        // 依赖就是 `sessionId`）——于是这里同时负另一件事：把新增判定的基线清空。
        // 不清的话，宿主复用同一个视图实例切到另一个会话时，那整页记录相对
        // 上一个会话全是「没见过的新行」，会一次全部淡入——正是首屏要避免的
        // 整页闪动。清空之后，新会话的第一批只登记、不动画，与刚打开时一致。
        seenIdsRef.current = null;
        void load();
        // 动态客户端 realm 里裸 setTimeout / setInterval 可能是会抛错的
        // 「教学陷阱」（见 dsh-retrace 的同类做法），因此定时器只走 window.*，
        // 没有 window 时退回 setTimeout。
        const schedule = typeof window !== "undefined" && typeof window.setInterval === "function"
          ? window.setInterval
          : setInterval;
        const timer = schedule(() => {
          void load();
        }, 5000);
        // 与 apply() 里那个兜底轮询同理：定时器不阻止进程退出，
        // 否则在 Node 测试环境里会挂着不退出。
        if (typeof timer?.unref === "function") timer.unref();
        return () => {
          // **从哪里借的定时器，就还给谁**：上面可能是 `window.setInterval`，
          // 这里却调全局 `clearInterval` 的话，两者在浏览器里恰好是同一个函数
          // 所以看不出问题，但在任何把 timer API 换成桩 / 沙箱对象的环境里
          // （测试、隔离 realm）就是「装得上、撤不掉」——旧回调一直活着，换会话
          // 之后新旧两个轮询同时在跑。
          const clear = typeof window !== "undefined" && typeof window.clearInterval === "function"
            ? window.clearInterval
            : clearInterval;
          if (typeof clear === "function") clear(timer);
        };
      }, [load]);

      /* ---------- 新增行的入场动画（DEC-044）：样式表与提前 return 之前的准备工作 ---------- */

      /** 本批记录（`page.entries` 原样，服务端按写入顺序给）。 */
      const entries = Array.isArray(page?.entries) ? page.entries : [];

      // keyframes 注进文档。放这里而不是渲染里：渲染是**纯函数**的位置，
      // 注样式表是副作用（且只在挂载时做一次）。
      react.useEffect(() => {
        ensureRowEnterCss();
        // 「人工审核比例」控件与配置页共用样式源（DEC-088）。本视图不在
        // .de-settings 外壳里，但 token 定义在 .de-tolerance 自己身上，
        // 注入同一份样式表就能拿到相同的线框按钮与选中反色。
        ensureCfgSectionCss();
      }, []);

