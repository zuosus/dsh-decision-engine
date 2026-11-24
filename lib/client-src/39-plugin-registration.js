    const inject = ["slots", "locale"];

    /** 本插件的包名：`plugins.bundle.config` 用包名作为 key 匹配。 */
    const PACKAGE_NAME = "dsh-decision-engine";

    /**
     * 入口注册：**只进插件信息页，不进 Sidebar**。
     *
     * 与内置插件保持一致的交互——配置入口放在插件自身的详情页，而不是在
     * Sidebar 占一格。
     *
     * 为什么不注册 `sidebar.panellist` + `main`：
     * `sidebar.panellist` 的点击会 `selectPanel(id)`，而 layout 的
     * `retainMainPanels` 只在 `main` slot 的 key 已存在时才保留该 id
     *（layout.js: `if (activePanelId !== null && !panelIds.includes(activePanelId)) activePanelId = null`）。
     * 两个 slot 是异步注册的，等 `main` 就位时 activePanelId 已被重置为 null，
     * 于是点 Sidebar 得到一张空白页——这正是要修掉的第二个问题。
     *
     * 只注册包详情自己的配置槽位 `plugins.bundle.config`（key = 包名）。
     *
     * **刻意不注册 `plugins.row.config`**：该槽位会让「包含的组件」列表里的
     * 本插件行变成可点击的「配置」入口，并打开一个独立的行详情页。但本插件是
     * 单一组合包，包详情页本身已经列出了全部组件，再给这一行一个配置入口属于
     * 重复入口，且会让用户误以为它是可单独配置的子组件。因此行标题保持纯文本。
     *
     * 同理不注册 `plugins.item`：那是官方内置插件在「内置插件配置」分组里的
     * 位置，本插件不属于官方内置插件。
     */
    function apply(ctx) {
      const log = (...args) => { try { console.log("[dsh-decision-engine]", ...args); } catch { /* 忽略 */ } };
      log("apply() called");

      /**
       * 完全照搬 `dsh-rewind-plugin`（一个在这台机器上确认可用的插件）的写法：
       *
       *   ctx.effect(function* () {
       *     yield ctx.locale.register(NS, { zh, en });
       *     yield slots.inject("plugins.bundle.config", () => slots.register({...}, Card));
       *   });
       *
       * 三个要点，缺一不可：
       *
       * 1. `ctx.effect` 接收的是 **generator 函数**，不是普通函数。generator 里
       *    `yield` 出去的值由 cordis 作为 disposer 管理——`yield slots.inject(...)`
       *    才是正确的挂载方式。我之前写成普通函数 + 直接调 `inject`，回调
       *    从未被触发（Console 里只有 `apply() called`，没有 `registered`）。
       *
       * 2. `locale.register` 也要 `yield`，且必须在注册槽位之前——`locale: NS`
       *    声明的命名空间需要有字典，否则部分渲染路径拿不到文案。
       *
       * 3. 槽位是 `plugins.bundle.config`，key = 包名。这正是你截图里
       *    dsh-rewind-plugin 那个「快照备份 / 自动清理 / 保存」配置区的槽位，
       *    它渲染在「包含的组件」**上方**。
       */
      ctx.effect(
        function* startluxLifecycle() {
          // 0) 界面语言先对齐宿主，再挂槽位。
          //
          // 顺序很重要：槽位注册后面板可能立刻渲染，语言晚一步就是一帧中文
          // 闪过后变英文。宿主读不到时回落到浏览器语言——至少与用户系统一致。
          setLang(readHostLang(ctx) ?? browserLang(), true);
          // 订阅是 disposer：effect 结束时撤销，插件重载不会留旧订阅。
          yield watchHostLang(ctx);

          // 1) 先注册字典（yield 使其可被回收）
          try {
            yield ctx.locale.register(NS, {
              zh: { title: "StartLux 守卫" },
              en: { title: "StartLux Guard" },
            });
            log("locale registered");
          } catch (error) {
            log("locale.register failed:", error?.message ?? String(error));
          }

          // 2) 主入口：包详情页配置区（与 rewind-plugin 同一槽位、同一写法）
          try {
            yield ctx.slots.inject("plugins.bundle.config", () => {
              log("inject fired for plugins.bundle.config");
              return ctx.slots.register(
                { name: "plugins.bundle.config", key: PACKAGE_NAME, locale: NS },
                StartluxPage,
              );
            });
            log("bundle.config mounted, key =", PACKAGE_NAME);
          } catch (error) {
            log("bundle.config mount failed:", error?.message ?? String(error));
          }

          // 3) 「决策历史」标签页（会话里的第三个 view，与「对话」「轨迹」并排）。
          //
          // 为什么**条件挂载**而不是无条件注册：配置页有一个「决策历史」
          // 开关，用户关掉之后这个标签页就该消失（而不是挂着一个空页）。
          // `conversation.view` 是 list 槽位，注册与注销都是运行时操作，因此
          // 可以按开关的当前值挂载 / 卸载。
          //
          // 为什么用 reconcile 而不是「一次判断」：开关改在**另一个页面**
          // （插件详情页）里，本页不会因此重挂载；而本页的 reconcile 会在
          // 页面重新聚焦时重新读一次 /status，于是开关的改动最终会生效。
          //
          // 为什么不轮询得更勤：60 秒一次足够——这个页面看的是「刚才发生了
          // 什么」，不是秒级监控；而每次 reconcile 都要发一次 /status。
          const VIEW_ID = "decisions";
          // order 15：排在 chat(0)、trajectory(10) 之后，retrace(20)、
          // git-panel(30) 之前——即「紧跟内置的两个 tab」。
          const VIEW_ORDER = 15;
          /** 当前挂载的注销函数；null = 没挂。 */
          let disposeView = null;

          const mountView = () => {
            if (disposeView !== null) return;
            try {
              disposeView = ctx.slots.inject("conversation.view", () => {
                const off = ctx.slots.register(
                  {
                    name: "conversation.view",
                    id: VIEW_ID,
                    order: VIEW_ORDER,
                    locale: NS,
                    // label 用 thunk：宿主每次投影都重新读它，语言切换后
                    // 不必重新注册就能显示新语言的标签名。
                    label: () => t("决策"),
                  },
                  DecisionsView,
                );
                log("conversation.view mounted");
                return off;
              });
              if (typeof disposeView !== "function") disposeView = null;
            } catch (error) {
              log("conversation.view mount failed:", error?.message ?? String(error));
              disposeView = null;
            }
          };

          const unmountView = () => {
            if (disposeView === null) return;
            try {
              disposeView();
            } catch (error) {
              log("conversation.view unmount failed:", error?.message ?? String(error));
            }
            disposeView = null;
          };

          /**
           * 按当前开关值决定挂载还是卸载。
           *
           * 读的是 `/status`——它是**生效值**（服务端已合并 config.yml），
           * 而不是配置文件里的原值。这一点很重要：配置文件里可能根本没写
           * 那一项（默认 true），读原值会得到 undefined → 被当成关闭。
           */
          const reconcileView = async () => {
            try {
              const status = await call("/status");
              if (status?.decisionsTabEnabled === false) unmountView();
              else mountView();
            } catch (error) {
              // 读不到状态时**保持现状**：宁可让标签页留在那儿，也不要因为
              // 一次请求失败就把用户的页面拆掉。
              log("reconcile skipped:", error?.message ?? String(error));
            }
          };

          // 首次挂载：立刻 reconcile 一次。
          void reconcileView();
          // 页面重新聚焦时再 reconcile：用户在插件详情页改了开关，回到会话
          // 时标签页就跟着变。
          const onFocus = () => {
            void reconcileView();
          };
          if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("focus", onFocus);
            yield () => window.removeEventListener("focus", onFocus);
          }
          // 兜底轮询：页面长时间开着、用户切到别的窗口改完配置再切回来时
          // focus 事件有时不触发（Electron 里尤其如此）。
          const schedule = typeof window !== "undefined" && typeof window.setInterval === "function"
            ? window.setInterval
            : setInterval;
          const timer = schedule(() => {
            void reconcileView();
          }, 60000);
          // 定时器**不阻止进程退出**。
          //
          // 在 Node 里（单元测试环境）`setInterval` 返回带 `unref()` 的
          // Timeout；不 unref 的话，这个定时器会让测试进程一直挂着不退出——
          // 测试桩不会调用我们 yield 出去的 disposer（它把 generator 跑完
          // 就收工），于是定时器永远不会被清掉。
          //
          // 浏览器里 `window.setInterval` 返回数字、没有 unref，`?.()` 自然
          // 是空操作，不影响任何行为。
          if (typeof timer?.unref === "function") timer.unref();
          yield () => {
            if (typeof clearInterval === "function") clearInterval(timer);
          };
          // 卸载时把标签页一并摘掉：插件热重载后不该留下一个指向旧
          // 模块的注册项。
          yield () => unmountView();

          // ---- 审批卡正文可读化（DEC-042 / DEC-043，默认开启）---------------
          //
          // 宿主的 `conversation.approval.detail` 是 **single** slot：它只渲染
          // 「同一 priority 下登记最早的那一个 entry」，而且同优先级重复登记会
          // 直接抛错（`SlotCore.register` 的 single 分支）。所以接管必须显式给
          // 一个**更小**的 priority——排序是升序，数值越小越先赢。
          //
          // 为什么默认开启：宿主把 `args.command` 塞进一个会折叠换行的
          // `word-break: break-all` 块里，一段 heredoc 脚本因此读不出结构；
          // 可读的审批卡就是本插件的用途本身。它仍是个开关：关掉就回到宿主
          // 的渲染（与 1.5.x 逐字节一致），只是宿主将来对那块 UI 的改进我们
          // 不会自动跟上——认那套呈现的用户关掉即可。
          //
          // 开关读的是 `/status` 的**生效值**（与 decisionsTabEnabled 同一套），
          // 所以配置文件里没写这一项时不会被误判成「关」。
          const DETAIL_PRIORITY = -1;
          let disposeDetail = null;

          const mountApprovalDetail = () => {
            if (disposeDetail !== null) return;
            try {
              disposeDetail = ctx.slots.inject("conversation.approval.detail", () => {
                const off = ctx.slots.register(
                  {
                    name: "conversation.approval.detail",
                    priority: DETAIL_PRIORITY,
                    locale: NS,
                  },
                  ApprovalDetailView,
                );
                log("conversation.approval.detail mounted (priority", DETAIL_PRIORITY + ")");
                return off;
              });
              if (typeof disposeDetail !== "function") disposeDetail = null;
            } catch (error) {
              // 接管失败不该影响审批本身：宿主原来的 detail 渲染继续生效。
              log("conversation.approval.detail mount failed:", error?.message ?? String(error));
              disposeDetail = null;
            }
          };

          const unmountApprovalDetail = () => {
            if (disposeDetail === null) return;
            try {
              disposeDetail();
            } catch (error) {
              log("conversation.approval.detail unmount failed:", error?.message ?? String(error));
            }
            disposeDetail = null;
          };

          const reconcileApprovalDetail = async () => {
            try {
              const status = await call("/status");
              // 缺字段 = 生效值为开（DEC-043），因此只有明确的 false 才不挂。
              if (status?.approvalDetailReadable !== false) mountApprovalDetail();
              else unmountApprovalDetail();
            } catch (error) {
              // 读不到状态时保持现状：不要因为一次请求失败就把卡片拆掉。
              log("approval detail reconcile skipped:", error?.message ?? String(error));
            }
          };

          void reconcileApprovalDetail();
          const onApprovalFocus = () => {
            void reconcileApprovalDetail();
          };
          if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("focus", onApprovalFocus);
            yield () => window.removeEventListener("focus", onApprovalFocus);
          }
          const approvalTimer = schedule(() => {
            void reconcileApprovalDetail();
          }, 60000);
          if (typeof approvalTimer?.unref === "function") approvalTimer.unref();
          yield () => {
            if (typeof clearInterval === "function") clearInterval(approvalTimer);
          };
          yield () => unmountApprovalDetail();
        },
        "dsh-decision-engine client lifecycle",
      );
    }

    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;
    /**
     * i18n 内部状态的出口：给渲染测试与浏览器控制台留的检查口
     * （`window.__ModuleLoader__` 加载出来的模块里能直接看当前语言与词表）。
     */
    exports.i18n = i18n;
    /**
     * 时间格式化的出口：同样是给测试与浏览器控制台留的检查口。
     *
     * 导出它是为了让「本地时间而不是 UTC」这件事**可断言**：时区相关的行为
     * 没法靠读代码确认，必须在不同的 TZ 下真的渲染一次（见
     * `test/client-decisions-view.test.js` 的时区用例）。
     */
    exports.formatLocalDateTime = formatLocalDateTime;
    exports.formatLocalTime = formatLocalTime;
    /**
     * 走势图几何的出口：**为可测而导出**。
     *
     * 为什么要导出：虚线段是我们自己画的，坐标公式复刻了 vendored 压缩分块里
     * microcharts 的内部布局（pad=2、按全长排 x、按 domain 排 y、2 位小数）。
     * 这类复刻只要库改一个常数就会悄悄错位，而错位只发生在真实浏览器里、肉眼
     * 难辨——所以必须能把「我们算的顶点」和「库在同一份产物上算的顶点」放在一起
     * 比对。见 `test/client-charts-chunk.test.js` 的几何锁定测试：它拿同一份
     * `lib/client.charts.js` 跑 Sparkline，再与这几个函数逐位对齐。
     * 将来重跑 `scripts/build-microcharts.mjs` 升级库，这条测试先红，
     * 而不是让用户先看到虚线与实线断开。
     *
     * 渲染路径本身不读这些出口，改动它们不会影响界面。
     */
    exports.sparkTrendGeometry = sparkTrendGeometry;
    exports.sparkTrendPath = sparkTrendPath;
    exports.sparkDomain = sparkDomain;
    exports.sparkFutureIndex = sparkFutureIndex;
    exports.sparkRound = sparkRound;
    return module.exports;
  },
});
