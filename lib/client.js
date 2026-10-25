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
    const h = react.createElement;

    /** 侧边栏与主面板共用的命名空间 / id。 */
    const NS = "decisionEngine";
    const PANEL_ID = "decision-engine";
    const BASE = "/api/decision-engine";

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
     * 数据全部走本插件自己的 `/api/decision-engine/*`，**不用** settings 服务
     *（旧插件死在 `settings.installSection` 上）。保存即改写 startlux.yml。
     *
     * @param props - 槽位属性；`view === "summary"` 时只渲染一行摘要文本。
     */
    function StartluxPage(props) {
      const [status, setStatus] = react.useState(null);
      // 密钥输入按 provider 分槽：切到别的 provider 时，这一格不该带过去，
      // 否则容易把 A 的 key 存到 B 名下。
      const [keyInputs, setKeyInputs] = react.useState({ systemone: "", bamboonode: "", custom: "" });
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      // 草稿初值是 null（= 还没有用户改动）。渲染时从服务端状态派生，
      // 而不是在这里写一份硬编码默认：否则「status 已回来但 useEffect 还没跑」
      // 的那一帧会显示错的值（例如把 custom 显示成 bamboonode）。
      const [draftState, setDraft] = react.useState(null);
      const [dirty, setDirty] = react.useState(false);
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
            setDraft({
              enabled: next.enabled === true,
              mode: next.mode ?? "shadow",
              model: next.rawModel ?? "",
              systemoneModel: next.rawSystemoneModel ?? "",
            });
            // provider 回显：保存后重新打开必须看到自己选的那一项与 custom 值。
            // 全部来自服务端 status，前端不缓存、不推断。
            setProviderDraft({
              provider: next.provider ?? "bamboonode",
              customBaseUrl: next.customBaseUrl ?? "",
              customEndpointStyle: next.customEndpointStyle ?? "auto",
              customModel: next.customModel ?? "",
              customHeaders: next.customHeaders ?? "",
              customApiKeyEnv: next.customApiKeyEnv ?? "",
            });
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
        return "Decision Engine 守卫";
      }

      // 即使状态还没加载回来（或 API 失败），也**照常渲染表单**——
      // API Key 输入框必须在任何情况下都可见可填，否则一旦 status 请求失败
      // 用户就永远看不到输入框。status 缺失时用安全默认值兜底。
      //
      // 兜底值刻意**不含任何具体服务商地址**：地址一律由服务端按 provider
      // 预设下发（providerCatalog / baseUrl）。前端自己写一份默认地址，
      // 就会出现「界面显示 A、实际请求 B」这类最难排查的偏差。
      const view = status ?? {
        enabled: false,
        mode: "shadow",
        provider: "bamboonode",
        providerLabel: "bamboonode",
        providerValid: true,
        providerError: "",
        providerCatalog: [],
        baseUrl: "",
        model: "",
        timeoutMs: 20000,
        keyConfigured: false,
        keyHint: "",
        keyStorage: "credentials",
        keyStatus: {},
        stats: { requests: 0, cached: 0 },
      };

      /** 生效草稿：没有用户改动时一律从服务端状态派生。 */
      const draft = draftState ?? {
        enabled: view.enabled === true,
        mode: view.mode ?? "shadow",
        model: view.rawModel ?? "",
        systemoneModel: view.rawSystemoneModel ?? "",
      };
      const providerDraft = providerDraftState ?? {
        provider: view.provider ?? "bamboonode",
        customBaseUrl: view.customBaseUrl ?? "",
        customEndpointStyle: view.customEndpointStyle ?? "auto",
        customModel: view.customModel ?? "",
        customHeaders: view.customHeaders ?? "",
        customApiKeyEnv: view.customApiKeyEnv ?? "",
      };

      /**
       * 把服务端返回的完整状态写回本地草稿。
       *
       * 保存成功后**必须**用它而不是各自 setDraft：否则 provider、custom 字段、
       * 主配置三处会各自漂移，表现为「保存后界面显示的还是旧值」。
       */
      const applyServerState = (next) => {
        setStatus(next);
        setDraft({
          enabled: next.enabled === true,
          mode: next.mode ?? "shadow",
          model: next.rawModel ?? "",
          systemoneModel: next.rawSystemoneModel ?? "",
        });
        setProviderDraft({
          provider: next.provider ?? "bamboonode",
          customBaseUrl: next.customBaseUrl ?? "",
          customEndpointStyle: next.customEndpointStyle ?? "auto",
          customModel: next.customModel ?? "",
          customHeaders: next.customHeaders ?? "",
          customApiKeyEnv: next.customApiKeyEnv ?? "",
        });
        setProviderError(next.providerValid === false ? next.providerError ?? "配置不可用" : "");
        setDirty(false);
        dirtyRef.current = false;
      };

      /**
       * provider 相关改动是否待保存。
       *
       * 逐字段比较而不是维护一个独立的 dirty 标记：切到 custom 又切回来、
       * 或者填了字又删掉，都应当回到「无改动」而不是永远亮着保存按钮。
       */
      const providerChanged = (() => {
        const server = {
          provider: view.provider ?? "bamboonode",
          customBaseUrl: view.customBaseUrl ?? "",
          customEndpointStyle: view.customEndpointStyle ?? "auto",
          customModel: view.customModel ?? "",
          customHeaders: view.customHeaders ?? "",
          customApiKeyEnv: view.customApiKeyEnv ?? "",
        };
        const storageChanged = storageDraft !== null && storageDraft !== (view.keyStorage ?? "credentials");
        const draftChanged = Object.keys(server).some(
          (key) => (providerDraft[key] ?? "") !== (server[key] ?? ""),
        );
        return draftChanged || storageChanged;
      })();

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
            applyServerState(next);
            setMsg({ ok: true, text: "已保存" });
            if (Object.hasOwn(patch, "apiKey")) setKeyInput("");
          } catch (error) {
            // 校验失败（非法 URL / 缺必填）走这里：保留用户已填内容，
            // 只把原因显示出来——清空表单会让用户重填一遍。
            setMsg({ ok: false, text: error.message });
            setProviderError(error.message);
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
        setProviderError("");
        try {
          const patch = {
            enabled: draft.enabled === true,
            mode: draft.mode,
            // 模型字段只写当前 provider 自己那一格（model / systemoneModel /
            // customModel）。混写会让「切过去再切回来」丢掉原值，也会把
            // bamboonode 的模型名发给别的服务。
            ...(providerDraft.provider === "custom"
              ? { customModel: (providerDraft.customModel ?? "").trim() }
              : providerDraft.provider === "systemone"
                ? { systemoneModel: (draft.systemoneModel ?? "").trim() }
                : { model: (draft.model ?? "").trim() }),
            provider: providerDraft.provider,
            // custom 的字段**总是**一起提交：用户可能先填地址再切 provider，
            // 分两次保存会让中间状态被当成最终配置。值为空也照写，
            // 便于用户清空后立刻纠正（服务端只在 provider=custom 时校验必填）。
            customBaseUrl: (providerDraft.customBaseUrl ?? "").trim(),
            customEndpointStyle: providerDraft.customEndpointStyle ?? "auto",
            customHeaders: (providerDraft.customHeaders ?? "").trim(),
            customApiKeyEnv: (providerDraft.customApiKeyEnv ?? "").trim(),
          };
          // 只提交「当前 provider」那一格：切过去时不会顺手存下别的 provider 的 key。
          const activeKey = (keyInputs[providerDraft.provider] ?? "").trim();
          if (activeKey.length >= 10) {
            if (providerDraft.provider === "systemone") patch.systemoneApiKey = activeKey;
            else if (providerDraft.provider === "custom") patch.customApiKey = activeKey;
            else patch.bamboonodeApiKey = activeKey;
          }
          // 保存位置：只在用户改过时才提交，避免每次保存都覆盖。
          if (storageDraft !== null) patch.keyStorage = storageDraft;
          const next = await call("/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          applyServerState(next);
          if (Object.hasOwn(patch, "systemoneApiKey") || Object.hasOwn(patch, "bamboonodeApiKey") || Object.hasOwn(patch, "customApiKey")) {
            setKeyInputs({ ...keyInputs, [providerDraft.provider]: "" });
          }
          await saveDecisions();
          setMsg({ ok: true, text: "已保存" });
        } catch (error) {
          setMsg({ ok: false, text: error.message });
          setProviderError(error.message);
        } finally {
          savingRef.current = false;
          setBusy("");
        }
      }, [draft, keyInputs, storageDraft, providerDraft, saveDecisions]);

      const runTest = react.useCallback(async () => {
        setBusy("test");
        setMsg(null);
        setProviderError("");
        try {
          const result = await call("/test", { method: "POST" });
          // 服务端返回的整段诊断（provider / 端点 / HTTP 码 / 请求 id / 响应体）
          // 原样展示：只报「失败」而不给细节，用户无法判断该改地址还是改 key。
          setMsg({
            ok: result.ok === true,
            text: result.ok === true ? `端点连通 ✅\n${result.text ?? ""}` : `${result.text ?? "端点返回失败"}`,
          });
          if (result.ok !== true) setProviderError("端点不可用：请对照上方诊断检查 provider、base URL 与 API key");
        } catch (error) {
          setMsg({ ok: false, text: error.message });
          setProviderError(error.message);
        } finally {
          setBusy("");
        }
      }, []);

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

      /**
       * 密钥保存位置：用户改过就用草稿，否则用服务端的值。
       *
       * 默认 credentials —— 与 DSH 其他服务统一托管，不必在插件目录留第二份明文。
       */
      const storageValue = storageDraft ?? view.keyStorage ?? "credentials";

      // 每个 provider 自己的 key 状态（服务端下发的 keyStatus）。
      const keyStatusOf = (id) => (view.keyStatus ?? {})[id] ?? null;
      const activeKeyStatus = keyStatusOf(providerDraft.provider);
      const keyOk = activeKeyStatus !== null ? activeKeyStatus.configured === true : view.keyConfigured === true;

      /** provider 预设清单（服务端下发；拿不到时只显示当前项）。 */
      const catalog = Array.isArray(view.providerCatalog) ? view.providerCatalog : [];
      const activeProvider = catalog.find((item) => item.id === providerDraft.provider) ?? null;
      const isCustom = providerDraft.provider === "custom";

      /**
       * 模型字段按 provider 分派。
       *
       *   bamboonode  -> model          （老版本唯一的模型键）
       *   systemone   -> systemoneModel
       *   custom      -> customModel
       *
       * 三者分开存，切换 provider 才不会把 A 的模型名发给 B。
       */
      const isSystemOne = providerDraft.provider === "systemone";
      const modelValue = isCustom
        ? providerDraft.customModel ?? ""
        : isSystemOne
          ? draft.systemoneModel ?? ""
          : draft.model ?? "";
      const setModelValue = (value) => {
        if (isCustom) setProviderDraft({ ...providerDraft, customModel: value });
        else if (isSystemOne) setDraft({ ...draft, systemoneModel: value });
        else setDraft({ ...draft, model: value });
        setDirty(true);
        dirtyRef.current = true;
      };

      /**
       * 展示用的错误文案：本地保存失败的提示优先，其次是服务端回报的
       * 「当前配置不可用」。后者必须能在首帧就显示——它是升级后配置坏掉的
       * 唯一线索，等用户点一次保存才出现就太晚了。
       */
      const providerErrorText =
        providerError.length > 0
          ? providerError
          : view.providerValid === false
            ? view.providerError ?? "当前 provider 配置不可用"
            : "";

      /**
       * 本地预校验：与服务端同规则，只是为了让用户在点保存之前就看到问题。
       * 服务端仍会独立校验（前端校验不可信），这里只求「早一点提示」。
       */
      const customUrlError = (() => {
        if (!isCustom) return "";
        const raw = (providerDraft.customBaseUrl ?? "").trim();
        if (raw.length === 0) return "必填：请填写 system-one 风格服务的 base URL";
        if (/\s/.test(raw)) return "不能包含空格或换行";
        if (!/^https?:\/\//i.test(raw)) return "必须以 http:// 或 https:// 开头";
        try {
          const url = new URL(raw);
          if (url.search.length > 0) return "不要带查询串（? 之后的部分）";
        } catch {
          return "不是合法地址（示例：https://api.example.com/v1）";
        }
        return "";
      })();

      /** provider 提示文案：优先用服务端下发的说明，避免前端另写一份。 */
      const providerHint =
        loading === true
          ? "正在读取服务端配置…"
          : activeProvider === null
            ? "服务端未返回 provider 列表；当前选择仍会生效"
            : isCustom
              ? "自定义 system-one 风格服务：自建 llama.cpp / vLLM、企业网关或第三方中转"
              : activeProvider.hint ?? "";

      return h(
        "div",
        { style: S.wrap },
        // 0) 服务提供方：最高层的选择，决定地址与鉴权从哪来
        row(
          "服务提供方",
          providerHint,
          h(
            "select",
            {
              style: { ...S.input, minWidth: "180px", flex: "none" },
              value: providerDraft.provider,
              disabled: busy !== "",
              onChange: (event) => {
                const next = event.target.value;
                setProviderDraft({ ...providerDraft, provider: next });
                // 切换 provider 只改「当前用哪个」，不动其它 provider 已保存的值：
                // custom 的字段留在 providerDraft 里，切回来还在。
                setProviderError("");
                setDirty(true);
                dirtyRef.current = true;
              },
            },
            ...(catalog.length === 0
              ? [h("option", { value: providerDraft.provider, key: providerDraft.provider }, providerDraft.provider)]
              : catalog.map((item) =>
                  h("option", { value: item.id, key: item.id }, item.label),
                )),
          ),
          "provider",
        ),
        // 0.1) 当前 provider 的生效端点：让「实际打到哪」始终可见
        row(
          "生效端点",
          isCustom
            ? "由上方 base URL + 端点风格拼接；已带 /decisions 或 /systemone 时原样使用"
            : "内置预设的默认地址（可用 startlux.yml 的 baseUrl 覆盖 bamboonode）",
          h(
            "span",
            { style: { ...S.v, fontSize: "11px", opacity: 0.75, maxWidth: "300px" } },
            view.providerValid === false
              ? "配置不可用"
              : view.baseUrl || "(服务端未返回)",
          ),
          "endpoint",
        ),
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
        // custom 用自己那一格（customModel），内置预设共用 model——
        // 分开存才能做到「切 provider 不覆盖其它 provider 已保存的模型」。
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
                value: modelValue ?? "",
                onChange: (event) => setModelValue(event.target.value),
              },
              h("option", { value: "" }, "自动（服务端默认）"),
              // 当前值不在列表里时也保留，避免下拉把已配置的值吞掉。
              ...((modelValue ?? "") === "" || models.some((item) => item.id === modelValue)
                ? []
                : [h("option", { value: modelValue, key: "current-model" }, `${modelValue}（当前值）`)]),
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
        // 4) API Key：每个 provider 一格，各自保存各自的 key
        row(
          `API Key${keyOk ? `（已配置 ${activeKeyStatus?.hint ?? view.keyHint ?? ""}）` : "（未配置）"}`,
          activeKeyStatus !== null && activeKeyStatus.refName
            ? `存到「${storageValue === "config" ? "插件配置" : ".credentials.yaml"}」的 ${activeKeyStatus.refName}`
            : "留空则不修改；粘贴新 key 后点保存",
          h("input", {
            type: "password",
            style: S.input,
            placeholder: keyOk ? "sk-…（留空不改）" : "sk-…",
            value: keyInputs[providerDraft.provider] ?? "",
            onChange: (event) =>
              setKeyInputs({ ...keyInputs, [providerDraft.provider]: event.target.value }),
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              if ((keyInputs[providerDraft.provider] ?? "").trim().length >= 10) void saveAll();
            },
          }),
          "key",
        ),
        // 4.1) 密钥保存位置：默认托管到 .credentials.yaml
        row(
          "密钥保存位置",
          storageValue === "config"
            ? "存进插件配置 startlux.yml（自包含，便于随目录备份；注意是明文）"
            : "存进 ~/.dsh/.credentials.yaml（默认，与其他服务统一托管）",
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: storageValue,
              disabled: busy !== "",
              onChange: (event) => {
                setStorageDraft(event.target.value);
                setDirty(true);
                dirtyRef.current = true;
              },
            },
            h("option", { value: "credentials" }, ".credentials.yaml（默认）"),
            h("option", { value: "config" }, "插件配置 startlux.yml"),
          ),
          "keyStorage",
        ),
        // 5) custom 专属字段：只有选了 custom 才出现，避免内置预设被无用输入干扰
        isCustom
          ? h(
              "div",
              { key: "custom" },
              h("div", { style: S.sectionTitle }, "自定义 provider"),
              row(
                "Base URL（必填）",
                customUrlError.length > 0
                  ? customUrlError
                  : "任意 system-one 风格服务；末尾斜杠会自动规范化，端点段不会重复",
                h("input", {
                  type: "text",
                  style: {
                    ...S.input,
                    borderColor: customUrlError.length > 0 ? "rgba(248,113,113,.75)" : "rgba(128,128,128,.32)",
                  },
                  placeholder: "https://api.example.com/v1",
                  value: providerDraft.customBaseUrl ?? "",
                  onChange: (event) => {
                    setProviderDraft({ ...providerDraft, customBaseUrl: event.target.value });
                    setProviderError("");
                    setDirty(true);
                    dirtyRef.current = true;
                  },
                }),
                "custom-url",
              ),
              row(
                "端点风格",
                "auto：地址已带 /decisions 或 /systemone 就原样用，否则按 /decisions 拼；也可强制指定",
                h(
                  "select",
                  {
                    style: { ...S.input, minWidth: "150px", flex: "none" },
                    value: providerDraft.customEndpointStyle ?? "auto",
                    onChange: (event) => {
                      setProviderDraft({ ...providerDraft, customEndpointStyle: event.target.value });
                      setDirty(true);
                      dirtyRef.current = true;
                    },
                  },
                  h("option", { value: "auto" }, "auto（自动）"),
                  h("option", { value: "decisions" }, "decisions"),
                  h("option", { value: "systemone" }, "systemone"),
                ),
                "custom-style",
              ),
              row(
                "附加请求头",
                "可留空。格式 `名称: 值`，多项用分号分隔；authorization / content-type 由插件固定",
                h("input", {
                  type: "text",
                  style: S.input,
                  placeholder: "X-Tenant: team-a; X-Trace: dsh",
                  value: providerDraft.customHeaders ?? "",
                  onChange: (event) => {
                    setProviderDraft({ ...providerDraft, customHeaders: event.target.value });
                    setDirty(true);
                    dirtyRef.current = true;
                  },
                }),
                "custom-headers",
              ),
              row(
                "密钥变量名",
                "可留空。填了就从这个环境变量或 ~/.dsh/.credentials.yaml 的 refs 段取 key",
                h("input", {
                  type: "text",
                  style: S.input,
                  placeholder: "MY_DECISION_API_KEY",
                  value: providerDraft.customApiKeyEnv ?? "",
                  onChange: (event) => {
                    setProviderDraft({ ...providerDraft, customApiKeyEnv: event.target.value });
                    setDirty(true);
                    dirtyRef.current = true;
                  },
                }),
                "custom-env",
              ),
            )
          : null,
        // 6) provider 校验错误：必须显式显示，否则用户只会看到「保存失败」
        providerErrorText.length > 0
          ? h(
              "div",
              {
                key: "provider-error",
                style: {
                  ...S.pointHint,
                  marginTop: "8px",
                  color: "#f87171",
                  fontSize: "12px",
                  opacity: 1,
                },
              },
              providerErrorText,
            )
          : null,
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
        // 4) 保存按钮（同时提交开关、provider 与 key）
        h(
          "div",
          { style: { display: "flex", gap: "8px", margin: "14px 0 4px" }, key: "actions" },
          h(
            "button",
            {
              type: "button",
              // 保存按钮的可用条件必须包含 providerChanged 与 custom key：
              // 少一项就会出现「改了 provider 但按钮是灰的」。
              disabled:
                busy !== "" ||
                (dirty !== true &&
                  (keyInputs[providerDraft.provider] ?? "").trim().length < 10 &&
                  decisionsChanged !== true &&
                  providerChanged !== true),
              onClick: () => void saveAll(),
              style: {
                ...S.saveBtn,
                opacity:
                  busy !== "" ||
                  (dirty !== true &&
                    (keyInputs[providerDraft.provider] ?? "").trim().length < 10 &&
                    decisionsChanged !== true &&
                    providerChanged !== true)
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
          `提供方 ${view.providerLabel ?? view.provider ?? "-"} · 端点 ${view.baseUrl || "(未配置)"}`,
          h("br", null),
          `模型 ${view.model || "(服务端默认)"} · 超时 ${view.timeoutMs}ms · 请求 ${view.stats?.requests ?? 0} 次（缓存 ${view.stats?.cached ?? 0}）`,
          // 密钥来源一律取「当前 provider 自己那一条」：用顶层 keyEnvName 会
          // 在切换后短暂显示上一家的名字（服务端字段与本地选择不同步时）。
          activeKeyStatus?.refName ? h("br", null) : null,
          activeKeyStatus?.refName
            ? `密钥来源 ${activeKeyStatus.refName}${activeKeyStatus.configured === true ? "" : "（未读到）"}`
            : null,
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
        "dsh-decision-engine client lifecycle",
      );
    }

    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
