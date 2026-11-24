/**
 * dsh-decision-engine 前端面板（浏览器端 bundle）。
 *
 * 加载协议与 DSH 其他插件一致：`window.__ModuleLoader__.load({ id, factory })`，
 * `factory` 内用 `require()` 拿 react，导出 `apply` / `inject`。
 *
 * 关键取舍：**不碰 settings 服务**。旧插件正是在 `settings.installSection`
 * （DSH 中不存在的方法）上抛错被吞，导致面板里永远看不到表单。
 * 这里全部走本插件自己的 `/api/decision-engine/*`：状态、保存、测试、日志。
 */
window.__ModuleLoader__.load({
  id: "dsh-decision-engine",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // 诊断探针：确认 client bundle 是否真的被执行（浏览器 Console 可见）
    try {
      console.log("[dsh-decision-engine] client bundle loaded");
      globalThis.__DECISION_ENGINE_CLIENT_LOADED__ = true;
    } catch { /* 忽略 */ }

    const react = require("react");
    const createElement = react.createElement;
    /**
     * factory 收到的 `require`，留一份给图表分块加载用（见 loadCharts）。
     *
     * 为什么要留：`require` 是**宿主在 factory 调用时**给我们的，它的
     * `require.async` 才能加载包内分块；组件里（异步回调、effect）拿不到
     * 这个参数，必须在外层存一份。改名成 `factoryRequire` 是为了让
     * 「这是宿主的 loader，不是 Node 的 require」在调用处一眼可辨。
     */
    const factoryRequire = require;

    /** 侧边栏与主面板共用的命名空间 / id。 */
    const NS = "decisionEngine";
    const PANEL_ID = "decision-engine";
    const BASE = "/api/decision-engine";

    /**
     * DSH 插件市场地址（dsh.zuos.us 首页）。
     *
     * 面板顶部给出这个链接，用来宣传插件市场：用户从这里发现、安装其它插件
     * （含本插件）。它是页面级入口，切到统计页也一直在。放在最上面一行的
     * 理由是它是**入口**，不是附注——埋到表单末尾等于没有。
     */
    const MARKET_URL = "https://dsh.zuos.us/";

