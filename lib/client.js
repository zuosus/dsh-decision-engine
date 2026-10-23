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
      /** 「即将支持」角标。 */
      badge: {
        flexShrink: 0,
        alignSelf: "center",
        padding: "3px 8px",
        borderRadius: "6px",
        border: "1px dashed rgba(128,128,128,.4)",
        fontSize: "10px",
        opacity: 0.55,
        whiteSpace: "nowrap",
      },
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
      // 决策点：元数据与实测分账都由服务端下发，前端不硬编码清单。
      const [decisions, setDecisions] = react.useState(null);
      // 待保存的模式改动（id → mode）；null 表示该行未改动，沿用服务端值。
      const [pointsDraft, setPointsDraft] = react.useState({});
      const [budgetDraft, setBudgetDraft] = react.useState(null);

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

      /** 拉决策点总览（含每个点的实测 token / 延迟 / 缓存与自身预算）。 */
      const loadDecisions = react.useCallback(async () => {
        try {
          const result = await call("/decisions");
          setDecisions(result);
        } catch {
          // 拉不到就不显示这一节，而不是显示一排空值误导用户。
          setDecisions(null);
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

      // 决策点/预算是否有待保存改动。必须在 saveDecisions 之前算：
      // useCallback 的依赖数组会在本次渲染立即求值，放到后面会踩 TDZ。
      const pointsChanged = Object.keys(pointsDraft).some((id) => {
        const original = (decisions?.points ?? []).find((item) => item.id === id);
        return original !== undefined && pointsDraft[id] !== original.mode;
      });
      const budgetChanged = budgetDraft !== null && budgetDraft !== (decisions?.budget?.limit ?? 0);
      const decisionsChanged = pointsChanged || budgetChanged;

      /**
       * 保存决策点与预算。
       *
       * 走独立的 `/decisions` 而不是复用 `/config`：那两份配置的校验规则不同
       *（决策点要拒绝未实装的点、预算要 clamp），混在一起容易互相放宽。
       */
      const saveDecisions = react.useCallback(async () => {
        const body = {};
        if (pointsChanged) body.points = pointsDraft;
        if (budgetChanged) body.budgetTokens = budgetDraft;
        if (Object.keys(body).length === 0) return true;
        const next = await call("/decisions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        setDecisions(next);
        setPointsDraft({});
        setBudgetDraft(null);
        return true;
      }, [pointsChanged, budgetChanged, pointsDraft, budgetDraft]);

      /** 一次点击提交两半：主配置 + 决策点。任一失败都要报错，不能静默半保存。 */
      const saveAll = react.useCallback(async () => {
        setBusy("save");
        setMsg(null);
        savingRef.current = true;
        try {
          const patch = { enabled: draft.enabled === true, mode: draft.mode, model: (draft.model ?? "").trim() };
          if (keyInput.trim().length >= 10) patch.apiKey = keyInput.trim();
          const next = await call("/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          setStatus(next);
          setDraft({ enabled: next.enabled === true, mode: next.mode ?? "shadow", model: next.rawModel ?? next.model ?? "" });
          setDirty(false);
          dirtyRef.current = false;
          if (Object.hasOwn(patch, "apiKey")) setKeyInput("");
          await saveDecisions();
          setMsg({ ok: true, text: "已保存" });
        } catch (error) {
          setMsg({ ok: false, text: error.message });
        } finally {
          savingRef.current = false;
          setBusy("");
        }
      }, [draft, keyInput, saveDecisions]);

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
        // 4.5) 决策点：让决策模型进入哪些环节
        decisions === null
          ? null
          : h(
              "div",
              { key: "points" },
              h("div", { style: S.sectionTitle }, "决策模型参与点"),
              ...(decisions.points ?? []).map((point) => {
                const current = Object.hasOwn(pointsDraft, point.id) ? pointsDraft[point.id] : point.mode;
                const changed = Object.hasOwn(pointsDraft, point.id) && pointsDraft[point.id] !== point.mode;
                const st = point.stats ?? {};
                // 「可用」与「已挂载」是两件事：点已实装（available），但宿主
                // 缺少它依赖的服务时挂载会失败（mounted=false）。两者都真才能切。
                const dim = point.available !== true || point.mounted === false;
                const meta =
                  `${point.hook} · ${point.trigger}` +
                  (st.requests
                    ? ` · 已判 ${st.requests} 次，缓存 ${st.cached}，${st.tokens} token，均 ${st.avgLatencyMs}ms`
                    : "");
                return h(
                  "div",
                  { style: S.pointCard(dim), key: point.id },
                  h(
                    "div",
                    { style: S.pointText },
                    h(
                      "div",
                      { style: S.pointName },
                      point.label,
                      // 热路径标记：这些点每次请求/每步都触发，必须靠配置的闸控量。
                      point.hotPath === true
                        ? h("span", { style: { ...S.badge, marginLeft: "6px", opacity: 0.7 } }, "热路径")
                        : null,
                    ),
                    h("div", { style: S.pointHint }, point.summary),
                    // 闸：为什么这个点不是「每次都问」。用户需要知道它何时真的会发请求。
                    point.gate === undefined || point.gate === null
                      ? null
                      : h("div", { style: S.pointHint }, `触发闸：${point.gate}`),
                    h("div", { style: S.pointMeta }, meta),
                  ),
                  dim
                    ? h(
                        "span",
                        { style: S.badge },
                        point.mounted === false ? "宿主缺服务" : "即将支持",
                      )
                    : h(
                        "div",
                        { style: S.seg },
                        ...(decisions.modes ?? ["off", "observe", "enforce"]).map((mode) =>
                          h(
                            "button",
                            {
                              type: "button",
                              key: mode,
                              disabled: busy !== "",
                              onClick: () => setPointsDraft({ ...pointsDraft, [point.id]: mode }),
                              style: S.segItem(
                                current === mode,
                                mode === "enforce"
                                  ? "rgba(74,222,128,.35)"
                                  : mode === "observe"
                                    ? "rgba(245,158,11,.32)"
                                    : void 0,
                              ),
                            },
                            mode === "off" ? "关闭" : mode === "observe" ? "观察" : "生效",
                          ),
                        ),
                      ),
                  changed ? h("span", { style: { ...S.badge, borderStyle: "solid", opacity: 0.9 } }, "待保存") : null,
                );
              }),
              // 自身预算：决策模型自己也烧 token，不设上限会变成主要消耗方。
              h(
                "div",
                { style: { ...S.rowLine, marginTop: "10px" }, key: "budget" },
                h(
                  "div",
                  { style: S.rowText },
                  h("div", { style: S.rowTitle }, "自身 token 预算"),
                  h(
                    "div",
                    { style: S.rowHint },
                    `每小时上限，超出后自动退回启发式并放行（当前已用 ${decisions.budget?.used ?? 0}）`,
                  ),
                ),
                h("input", {
                  type: "number",
                  min: 0,
                  step: 10000,
                  style: { ...S.input, maxWidth: "130px", flex: "none" },
                  defaultValue: decisions.budget?.limit ?? 0,
                  onChange: (event) => {
                    const value = Number(event.target.value);
                    setBudgetDraft(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null);
                  },
                }),
              ),
              // 缓存命中：0 命中说明白名单外的调用每次都真发请求，是主要浪费。
              h(
                "div",
                { style: S.pointMeta, key: "cache" },
                `缓存 ${decisions.cache?.size ?? 0} 条 · 精确命中 ${decisions.cache?.exactHits ?? 0} · ` +
                  `同类复用 ${decisions.cache?.softHits ?? 0} · 命中率 ${Math.round((decisions.cache?.hitRate ?? 0) * 100)}%`,
              ),
            ),
        // 4) 保存按钮（同时提交开关与 key）
        h(
          "div",
          { style: { display: "flex", gap: "8px", margin: "14px 0 4px" }, key: "actions" },
          h(
            "button",
            {
              type: "button",
              disabled:
                busy !== "" ||
                (dirty !== true && keyInput.trim().length < 10 && decisionsChanged !== true),
              onClick: () => void saveAll(),
              style: {
                ...S.saveBtn,
                opacity:
                  busy !== "" || (dirty !== true && keyInput.trim().length < 10 && decisionsChanged !== true)
                    ? 0.5
                    : 1,
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

    const inject = ["slots", "locale"];

    /** 本插件的包名：`plugins.bundle.config` 用包名作为 key 匹配。 */
    const PACKAGE_NAME = "dsh-startlux-decision";

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
