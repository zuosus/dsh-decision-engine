    /**
     * 图表分块的加载状态。
     *
     * 三种状态，语义各不相同：
     *   `idle`    还没试过（首帧就是它）
     *   `loading` 正在下载
     *   `ready`   拿到了，`charts` 有值
     *   `failed`  试过了但失败——**不再重试**，避免每帧都发一次请求
     *
     * 为什么用模块级变量而不是 useState：图表是统计页的附属资源，
     * 加载完成后所有渲染都要立刻看到它。放在状态里会多一层协调
     * （加载完还要触发重渲染），而模块级 + 订阅回调已经够用，也不必
     * 让配置页的渲染路径为它承担一次多余的 re-render。
     */
    let chartsState = "idle";
    /** 加载完成后的图表模块（`{ Sparkline, SegmentedBar, ... }`）。 */
    let chartsModule = null;
    /** 等待图表就绪的订阅者（统计页挂载时注册）。 */
    const chartsWaiters = new Set();

    /**
     * 把图表样式注进 `document.head`（幂等）。
     *
     * 与 `ensureCfgSectionCss` 同一套路：注不上就不注，图表照样渲染，
     * 只是少了配色与描边（SVG 会退回成光秃秃的默认黑）。
     * 样式内容随分块一起下发（分块导出的 `styles` 字段），由
     * `scripts/build-microcharts.mjs` 从库里拷来并接上 DSH 主题变量。
     */
    const CHARTS_STYLE_ID = "dsh-decision-engine-microcharts-css";
    function ensureChartsCss(source) {
      try {
        if (typeof source !== "string" || source.length === 0) return false;
        if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
        const parent = document.head ?? document.body;
        if (!parent) return false;
        if (typeof document.getElementById === "function" && document.getElementById(CHARTS_STYLE_ID)) return true;
        const tag = document.createElement("style");
        tag.id = CHARTS_STYLE_ID;
        tag.dataset.plugin = "dsh-decision-engine";
        tag.dataset.pluginCss = CHARTS_STYLE_ID;
        tag.textContent = source;
        parent.appendChild(tag);
        return true;
      } catch {
        return false;
      }
    }

    /** 通知所有等待者：图表状态变了（就绪或失败都算）。 */
    function notifyChartsWaiters() {
      for (const waiter of [...chartsWaiters]) {
        try {
          waiter(chartsModule);
        } catch {
          /* 单个订阅者出错不该影响其它订阅者 */
        }
      }
    }

    /**
     * 确保图表分块已加载（幂等，失败后不再重试）。
     *
     * `require` 由宿主在 factory 里给我们，`require.async` 是它提供的
     * 异步分块入口（宿主只认 `./client.<name>.js` 这种相对说明符）。
     * 拿不到 `require.async`（测试环境 / 老宿主）时直接进 `failed`，
     * 统计页退回只显示表格。
     *
     * @param req - factory 收到的 `require`。
     * @returns 图表模块或 null。
     */
    async function loadCharts(req) {
      if (chartsState === "ready") return chartsModule;
      if (chartsState === "failed" || chartsState === "loading") return chartsModule;
      if (typeof req !== "function" || typeof req.async !== "function") {
        chartsState = "failed";
        return null;
      }
      chartsState = "loading";
      try {
        const mod = await req.async("./client.charts.js");
        if (mod === null || mod === undefined) throw new Error("empty charts chunk");
        chartsModule = mod;
        chartsState = "ready";
        // 样式跟着分块一起到：分块与 CSS 是同一份构建的产物，分开取会让
        // 「代码到了、样式没到」的中间态显示成无填充的黑色方块。
        if (typeof mod.styles === "string") ensureChartsCss(mod.styles);
        notifyChartsWaiters();
        return chartsModule;
      } catch (error) {
        chartsState = "failed";
        try {
          // 控制台日志用英文：它不是界面文案，不走词表（词表覆盖测试
          // 只放行「纯展示」的中文，日志混进去会让每次加日志都要补一条词表）。
          // 运维在 Console 里看的是异常对象本身，这句只是路标。
          console.warn("[dsh-decision-engine] charts chunk failed to load; stats page falls back to tables:", error);
        } catch {
          /* 忽略 */
        }
        notifyChartsWaiters();
        return null;
      }
    }

    /**
     * 订阅图表可用性（给统计页用）。
     *
     * 返回值是取消订阅的函数，供 `useEffect` 的清理阶段调用。
     * 为什么需要订阅而不是简单地在渲染里读模块变量：分块是异步的，
     * 就绪那一刻必须触发一次重渲染，否则用户要切走再切回才看得到图表。
     */
    function subscribeCharts(waiter) {
      chartsWaiters.add(waiter);
      return () => {
        chartsWaiters.delete(waiter);
      };
    }

