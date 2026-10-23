/**
 * dsh-startlux-decision 前端面板（浏览器端 bundle）。
 *
 * 加载协议与 DSH 其他插件一致：`window.__ModuleLoader__.load({ id, factory })`，
 * `factory` 内用 `require()` 拿 react，导出 `apply` / `inject`。
 *
 * 关键取舍：**不碰 settings 服务**。旧插件正是在 `settings.installSection`
 * （DSH 中不存在的方法）上抛错被吞，导致面板里永远看不到表单。
 * 这里全部走本插件自己的 `/api/startlux-guard/*`：状态、保存、测试、日志。
 */
window.__ModuleLoader__.load({
  id: "dsh-startlux-decision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // 诊断探针：确认 client bundle 是否真的被执行（浏览器 Console 可见）
    try {
      console.log("[dsh-startlux-decision] client bundle loaded");
      globalThis.__STARTLUX_CLIENT_LOADED__ = true;
    } catch { /* 忽略 */ }

    const react = require("react");
    const h = react.createElement;

    /** 侧边栏与主面板共用的命名空间 / id。 */
    const NS = "startluxGuard";
    const PANEL_ID = "startlux-guard";
    const BASE = "/api/startlux-guard";

    const S = {
      wrap: {
        maxWidth: "620px",
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
        padding: "20px 24px",
        fontSize: "13px",
      },
      title: { margin: "0 0 4px", fontSize: "16px", fontWeight: 600 },
      sub: { margin: "0 0 16px", fontSize: "12px", opacity: 0.6 },
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
      /** 保存按钮。 */
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
    };

    /** 统一 fetch：带 content-type、no-store，并把错误转成可展示文本。 */
    async function call(path, init) {
      const response = await fetch(BASE + path, {
        ...init,
        headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (!response.ok) throw new Error(typeof data === "object" ? data.error ?? `HTTP ${response.status}` : String(data));
      return data;
    }

    /** 主面板：配置 + 状态 + 一键测试 + 最近决策。 */
    /**
     * 配置页：仿照内置 dsh-rewind-plugin 的卡片布局——
     * 每行左侧是「标题 + 灰色说明」，右侧是开关；底部一个「保存」按钮。
     *
     * 数据全部走本插件自己的 `/api/startlux-guard/*`，**不用** settings 服务
     *（旧插件死在 `settings.installSection` 上）。保存即改写 startlux.yml。
     *
     * @param props - 槽位属性；`view === "summary"` 时只渲染一行摘要文本。
     */
    function StartluxPage(props) {
      const [status, setStatus] = react.useState(null);
      const [keyInput, setKeyInput] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      const [draft, setDraft] = react.useState({ enabled: false, mode: "shadow" });
      const [dirty, setDirty] = react.useState(false);
      // 可选模型列表：从 /models 拉取（只含决策端点真正接受的模型）。
      const [models, setModels] = react.useState([]);
      const [modelsState, setModelsState] = react.useState("idle");

      // 用 ref 保存「用户是否有未保存改动」，使 refresh 不因 dirty 变化而重建。
      // 否则保存时 setDirty(false) → refresh 换新引用 → useEffect 再跑一次，
      // 与 save 里的 setStatus 竞争，可能用旧值把刚保存的开关覆盖回去（表现为回弹）。
      const dirtyRef = react.useRef(false);
      const savingRef = react.useRef(false);

      const refresh = react.useCallback(async () => {
        // 保存进行中不拉状态，避免用旧快照覆盖刚写入的结果。
        if (savingRef.current === true) return;
        try {
          const next = await call("/status");
          setStatus(next);
          if (dirtyRef.current !== true) {
            setDraft({ enabled: next.enabled === true, mode: next.mode ?? "shadow", model: next.rawModel ?? next.model ?? "" });
          }
          setMsg(null);
        } catch (error) {
          setMsg({ ok: false, text: error.message });
        } finally {
          setLoading(false);
        }
      }, []);

      react.useEffect(() => {
        refresh();
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

      // summary 视图只输出一行纯文本（插件列表/包详情用它做摘要）。
      if (props !== null && props !== undefined && props.view === "summary") {
        return "StartLux 守卫";
      }

      const save = react.useCallback(
        async (patch) => {
          setBusy("save");
          setMsg(null);
          savingRef.current = true;
          try {
            const next = await call("/config", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(patch),
            });
            setStatus(next);
            setDraft({ enabled: next.enabled === true, mode: next.mode ?? "shadow", model: next.rawModel ?? next.model ?? "" });
            setDirty(false);
            dirtyRef.current = false;
            setMsg({ ok: true, text: "已保存" });
            if (Object.hasOwn(patch, "apiKey")) setKeyInput("");
          } catch (error) {
            setMsg({ ok: false, text: error.message });
          } finally {
            savingRef.current = false;
            setBusy("");
          }
        },
        [],
      );

      const runTest = react.useCallback(async () => {
        setBusy("test");
        setMsg(null);
        try {
          const result = await call("/test", { method: "POST" });
          setMsg({
            ok: result.ok === true,
            text: result.ok === true ? "端点连通 ✅" : "端点返回失败，请检查 API Key 与 Base URL",
          });
        } catch (error) {
          setMsg({ ok: false, text: error.message });
        } finally {
          setBusy("");
        }
      }, []);

      // 即使状态还没加载回来（或 API 失败），也**照常渲染表单**——
      // API Key 输入框必须在任何情况下都可见可填，否则一旦 status 请求失败
      // 用户就永远看不到输入框。status 缺失时用安全默认值兜底。
      const view = status ?? {
        enabled: false,
        mode: "shadow",
        baseUrl: "https://api.bamboonode.dev/v1/decisions",
        model: "startlux-decision-27b-autothink",
        timeoutMs: 20000,
        keyConfigured: false,
        keyHint: "",
        stats: { requests: 0, cached: 0 },
      };

      /** 一行：左标题+说明，右控件。 */
      const row = (title, hint, control, key) =>
        h(
          "div",
          { style: S.rowLine, key },
          h(
            "div",
            { style: S.rowText },
            h("div", { style: S.rowTitle }, title),
            hint === null ? null : h("div", { style: S.rowHint }, hint),
          ),
          control,
        );

      /** 开关：仿内置样式（轨道 + 圆点）。 */
      const toggle = (on, onClick) =>
        h(
          "button",
          {
            type: "button",
            onClick,
            disabled: busy !== "",
            style: {
              ...S.track,
              background: on ? "rgba(74,222,128,.55)" : "rgba(128,128,128,.28)",
            },
            "aria-pressed": on,
          },
          h("span", {
            style: { ...S.knob, transform: on ? "translateX(16px)" : "translateX(0)" },
          }),
        );

      const keyOk = view.keyConfigured === true;

      return h(
        "div",
        { style: S.wrap },
        // 1) 启用开关
        row(
          "启用守卫",
          "开启后在每次工具调用前做风险判断",
          toggle(draft.enabled === true, () => {
            const next = draft.enabled !== true;
            setDraft({ ...draft, enabled: next });
            setDirty(true);
            dirtyRef.current = true;
          }),
          "enabled",
        ),
        // 2) 拦截开关（shadow / enforce 等价于「只记录」与「真拦截」）
        row(
          "真正拦截",
          "关闭时只记录判断结果（shadow）；开启后按判断执行 deny / ask",
          toggle(draft.mode === "enforce", () => {
            const next = draft.mode === "enforce" ? "shadow" : "enforce";
            setDraft({ ...draft, mode: next });
            setDirty(true);
            dirtyRef.current = true;
          }),
          "mode",
        ),
        // 3) 模型：下拉选择，含「自动（服务端默认）」
        row(
          "模型",
          modelsState === "ok"
            ? "从服务商实时获取；选「自动」则由服务端决定，换名也不会失效"
            : modelsState === "loading"
              ? "正在获取模型列表…"
              : modelsState === "error"
                ? "获取失败，可手填或留空用服务端默认"
                : "未获取到列表，可手填或留空用服务端默认",
          h(
            "div",
            { style: { display: "flex", gap: "6px", alignItems: "center", flex: 1, minWidth: 0 } },
            h(
              "select",
              {
                style: { ...S.input, minWidth: "220px" },
                value: draft.model ?? "",
                onChange: (event) => {
                  setDraft({ ...draft, model: event.target.value });
                  setDirty(true);
                  dirtyRef.current = true;
                },
              },
              h("option", { value: "" }, "自动（服务端默认）"),
              // 当前值不在列表里时也保留，避免下拉把已配置的值吞掉。
              ...(models.some((item) => item.id === (draft.model ?? "")) || (draft.model ?? "") === ""
                ? []
                : [h("option", { value: draft.model, key: draft.model }, `${draft.model}（自定义）`)]),
              ...models.map((item) => h("option", { value: item.id, key: item.id }, item.id)),
            ),
            h(
              "button",
              {
                type: "button",
                onClick: loadModels,
                disabled: modelsState === "loading",
                style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
              },
              modelsState === "loading" ? "…" : "获取",
            ),
          ),
          "model",
        ),
        // 4) API Key
        row(
          `API Key${keyOk ? `（已配置 ${view.keyHint}）` : "（未配置）"}`,
          "留空则不修改；粘贴新 key 后点保存",
          h("input", {
            type: "password",
            style: S.input,
            placeholder: keyOk ? "sk-…（留空不改）" : "sk-…",
            value: keyInput,
            onChange: (event) => setKeyInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && keyInput.trim().length >= 10) {
                void save({ apiKey: keyInput.trim() });
              }
            },
          }),
          "key",
        ),
        // 4) 保存按钮（同时提交开关与 key）
        h(
          "div",
          { style: { display: "flex", gap: "8px", margin: "14px 0 4px" }, key: "actions" },
          h(
            "button",
            {
              type: "button",
              disabled: busy !== "" || (dirty !== true && keyInput.trim().length < 10),
              onClick: () => {
                const patch = { enabled: draft.enabled === true, mode: draft.mode, model: (draft.model ?? "").trim() };
                if (keyInput.trim().length >= 10) patch.apiKey = keyInput.trim();
                void save(patch);
              },
              style: {
                ...S.saveBtn,
                opacity: busy !== "" || (dirty !== true && keyInput.trim().length < 10) ? 0.5 : 1,
                cursor: busy !== "" ? "default" : "pointer",
              },
            },
            busy === "save" ? "保存中…" : "保存",
          ),
          h(
            "button",
            {
              type: "button",
              disabled: busy !== "",
              onClick: runTest,
              style: { ...S.saveBtn, background: "transparent", color: "inherit" },
            },
            busy === "test" ? "测试中…" : "测试端点",
          ),
        ),
        // 5) 状态信息（紧凑）
        h(
          "div",
          { style: S.meta, key: "meta" },
          `端点 ${view.baseUrl}`,
          h("br", null),
          `模型 ${view.model} · 超时 ${view.timeoutMs}ms · 请求 ${view.stats?.requests ?? 0} 次（缓存 ${view.stats?.cached ?? 0}）`,
        ),
        msg !== null
          ? h(
              "div",
              {
                style: {
                  ...S.meta,
                  marginTop: "10px",
                  color: msg.ok ? "#4ade80" : "#f87171",
                },
                key: "msg",
              },
              msg.text,
            )
          : null,
      );
    }

    /**
     * 兜底区块：注册到 `plugins.detail.section`（list，无 key）。
     *
     * 该槽位会在**每一个**插件的详情页被渲染，因此必须自己判断
     * 「当前 subject 是不是本插件」，否则会给所有插件页塞一个 StartLux 面板。
     *
     * subject 的三种形态（见 plugin-manager 的 packageRef / rowRef）：
     *   { kind: "bundle", pkg: { name, rows: [...] } }
     *   { kind: "row",    row: { ... } }
     *   { kind: "item",   id }
     * 只要其中任一处的名字/entryKey 命中本插件，就渲染。
     *
     * @param props - 含 subject 的槽位属性。
     */
    function StartluxDetailSection(props) {
      const subject = props?.subject;
      if (!belongsToThisPlugin(subject)) return null;
      return h(StartluxPage, null);
    }

    /**
     * 判断一个 detail subject 是否属于本插件。
     * @param subject - 插件管理页传入的 subject。
     * @returns 是否渲染本插件的区块。
     */
    function belongsToThisPlugin(subject) {
      if (subject === null || subject === undefined || typeof subject !== "object") return false;
      const names = [];
      const collect = (value) => {
        if (typeof value === "string" && value.length > 0) names.push(value);
      };
      // bundle 视图
      collect(subject.pkg?.name);
      collect(subject.name);
      // item 视图
      collect(subject.id);
      // row 视图
      collect(subject.row?.entryId);
      collect(subject.row?.rowId);
      collect(subject.row?.name);
      collect(subject.entryKey);
      // 包内每个 row 的 entryId（bundle 视图会带 rows）
      for (const row of subject.pkg?.rows ?? []) {
        collect(row?.entryId);
        collect(row?.rowId);
        collect(row?.name);
      }
      return names.some((name) => name === PACKAGE_NAME || name === PANEL_ID || name.startsWith(`${PACKAGE_NAME}:`));
    }

    const inject = ["slots", "locale"];

    /** 本插件的包名：`plugins.bundle.config` 用包名作为 key 匹配。 */
    const PACKAGE_NAME = "dsh-startlux-decision";
    /** `plugins.row.config` 的 key：`<包名>#<cordis.patch.yml 里的行 id>`。 */
    const ROW_CONFIG_KEY = `${PACKAGE_NAME}#startlux-guard`;

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
     * 为什么同时注册两个 slot（都指向同一个页面组件）：
     * 插件管理页有三种详情视图，各自渲染不同的配置槽位——
     *   - 包详情（截图那个页面，最外层）→ `plugins.bundle.config`，key = 包名
     *   - 行详情（单个 entry）      → `plugins.row.config`，   key = entryKey
     *   - 列表项详情                → `plugins.item`，         id  = 条目 id
     * 三者都还会渲染 `plugins.detail.section`（list，无 key）。
     * 只注册 `plugins.item` 时，用户从「已安装」点进包详情是看不到任何东西的，
     * 这正是「还是没看到」的原因。因此这里以 `bundle.config` 为主入口
     *（精确对应包详情页），再用 `detail.section` 兜底覆盖其余视图。
     */
    function apply(ctx) {
      const log = (...args) => { try { console.log("[dsh-startlux-decision]", ...args); } catch { /* 忽略 */ } };
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

          // 3) 行配置页（rc.1 起第三方可用的行级配置槽位）
          try {
            yield ctx.slots.inject("plugins.row.config", () => {
              log("inject fired for plugins.row.config");
              return ctx.slots.register(
                { name: "plugins.row.config", key: ROW_CONFIG_KEY, locale: NS },
                (slotProps) =>
                  slotProps !== null && slotProps !== undefined && slotProps.view === "summary"
                    ? "StartLux 守卫 · 查看配置"
                    : h(StartluxPage, null),
              );
            });
            log("row.config mounted, key =", ROW_CONFIG_KEY);
          } catch (error) {
            log("row.config mount failed:", error?.message ?? String(error));
          }
        },
        "dsh-startlux-decision client lifecycle",
      );
    }

    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
