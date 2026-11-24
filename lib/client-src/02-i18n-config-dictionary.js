    /* ============================================================
     * i18n —— 配置页与统计页的中英文
     *
     * 设计：中文是**源语言**（代码里照旧写中文），英文是一张
     * 「中文原文 → English」的表；语言跟随宿主（DSH 设置里的语言），
     * 宿主没给就读浏览器语言。
     *
     * 为什么在**渲染边界**翻译，而不是把每个 `h(...)` 里的字面量换成
     * key（`t("stats.title")` 那种写法）：
     *
     * 1. 本面板有一半的文案不是写在这里的——决策点名、区间标签、历史数据
     *    说明都由服务端下发（`/decisions`、`/stats` 的 `labels`）。按 key
     *    翻译就得让服务端
     *    也双语化，并给每个接口加语言参数：改动面从 1 个文件变成 5 个，
     *    而且每加一个字段都要两边同步。在渲染边界翻译，服务端下发的中文
     *    和代码里的中文走同一条路。
     * 2. 漏翻的表现更好：按 key 写漏了会显示 `stats.title` 这种字符串，
     *    或直接空白；这里漏了就是那一格保持中文——**是中文，不是乱码，
     *    也不是另一种语言的错译**。
     * 3. 代价是「字符串必须整段命中词典」。带变量的句子做不到整段命中，
     *    所以那 30 多处插值文案改成显式 `t(模板, 参数)`（见 `T_*` 表），
     *    静态文案不用动调用点。
     *
     * 词典分区维护（`EN_CONFIG` / `EN_STATS` / `EN_MISC` / `EN_LABELS`），
     * 每区一张表：单表 300 行时冲突面和阅读成本都不可接受。
     * ============================================================ */

    /** 当前界面语言。初始按中文，`apply()` 拿到宿主语言后立即改写。 */
    let lang = "zh";

    /** 语言变化时要重绘的组件（`useLang` 注册）。 */
    const langListeners = new Set();

    /**
     * 静态文案表：中文原文 → English。
     *
     * 只写英文：中文就是 key 本身，查不到即原样返回，所以新增中文不会因为
     * 忘了登记而坏掉。
     */
    /** i18n:config —— 配置页（provider / 密钥 / 模型 / 阈值 / 保存态）。 */
    const EN_CONFIG = {
      // —— 自定义 provider 与地址校验 ——
      "必填：请填写决策服务的 base URL": "Required: enter the decision service base URL",
      "不能包含空格或换行": "Must not contain spaces or line breaks",
      "必须以 http:// 或 https:// 开头": "Must start with http:// or https://",
      "不要带查询串（? 之后的部分）": "Do not include a query string (the part after ?)",
      "不是合法地址（示例：https://api.example.com/v1）": "Not a valid URL (example: https://api.example.com/v1)",
      "地址不合法": "Invalid URL",
      "配置不可用": "Configuration unavailable",
      "配置尚未就绪（服务端未返回 provider 字段映射），请稍后重试": "Configuration is not ready yet (the server did not return the provider field map). Try again shortly",
      "Decision Engine 守卫": "Decision Engine Guard",
      "当前 provider 配置不可用": "The current provider configuration is unavailable",
      "正在读取服务端配置…": "Reading server configuration…",
      "服务端未返回 provider 列表；当前选择仍会生效": "The server returned no provider list; your current choice still applies",
      "自定义决策服务：自建 llama.cpp / vLLM、企业网关或第三方中转": "Custom decision service: self-hosted llama.cpp / vLLM, corporate gateway, or relay",
      "服务提供方": "Provider",
      "已配置Key": "Key set",
      "生效端点": "Effective endpoint",
      "由上方 base URL + 端点风格拼接；已带 /decisions 或 /systemone 时原样使用": "Built from the base URL above plus the endpoint style; kept as-is when it already contains /decisions or /systemone",
      "内置预设的默认地址（可用 config.yml 的 baseUrl 覆盖当前默认预设）": "Built-in preset default address (config.yml's baseUrl can override the current default preset)",
      "自动（不发送 model 字段）": "Auto (omit the model field)",
      "从自定义服务实时获取；可从列表选择，也可直接手填模型名；留空表示不发送 model 字段": "Fetched live from your custom service; pick one from the list or type a model id — leaving it empty omits the model field",
      "获取失败或暂无列表，可手填模型名": "Fetch failed or no list yet; type a model id manually",
      "(服务端未返回)": "(not returned by the server)",
      "端点不可用：请对照上方诊断检查 provider、base URL 与 API key": "Endpoint unavailable: check the provider, base URL and API key against the diagnostics above",
      "端点返回失败": "The endpoint returned a failure",
      "端点风格": "Endpoint style",
      "路径后缀由服务商决定（实测 SiliconFlow 只通 /systemone）。这里是「首选」：若首选路径返回 404，插件会自动改用另一条再试一次": "The path suffix is decided by the provider (measured: SiliconFlow only accepts /systemone). This is the preferred path: on a 404 the plugin automatically retries with the other one",
      "这里是「首选」：若首选路径返回 404，插件会自动改用另一条再试一次": "This is the preferred path: on a 404 the plugin automatically retries with the other one",
      "附加请求头": "Extra request headers",
      "名称: 值": "Name: value",
      "可留空。格式 `名称: 值`，多项用分号分隔；authorization / content-type 由插件固定": "Optional. Format `Name: value`, separate multiple entries with semicolons; authorization / content-type are fixed by the plugin",
      "密钥变量名": "Key variable name",
      "可留空。填了就从这个环境变量或 ~/.dsh/.credentials.yaml 的 refs 段取 key": "Optional. When filled, the key is read from this environment variable or the refs section of ~/.dsh/.credentials.yaml",
      "Base URL（必填）": "Base URL (required)",
      "任意提供决策端点的服务；末尾斜杠会自动规范化，端点段不会重复": "Any service exposing a decision endpoint; a trailing slash is normalized and the endpoint segment is never duplicated",
      "自定义 provider": "Custom provider",
      // —— 开关与阈值 ——
      "启用守卫": "Enable guard",
      "开启后在每次工具调用前做风险判断": "When on, a risk judgement runs before every tool call",
      "真正拦截": "Actually block",
      "关闭时只记录判断结果（shadow）；开启后按判断执行 deny / ask": "When off, verdicts are only recorded (shadow); when on, deny / ask are enforced",
      "思考模式": "Thinking mode",
      "当前 provider 不支持思考模式：该端点没有 think_mode 字段，选了也不会生效": "This provider does not support thinking mode: the endpoint has no think_mode field, so changing it would have no effect",
      "总是思考：判断更充分，但每次工具调用约多等 5 秒": "Always think: fuller judgement, but roughly 5 extra seconds per tool call",
      "仅在模型自己判断需要时思考（折中）": "Think only when the model itself decides it is needed (middle ground)",
      "不思考：最快（约 1.9s），热路径首选": "Never think: fastest (about 1.9s), the hot-path default",
      "never（不思考）": "never (no thinking)",
      "auto（按需思考）": "auto (think when needed)",
      "always（总是思考）": "always (always think)",
      // —— 匿名使用统计（DEC-020）——
      "匿名统计": "Anonymous stats",
      "每天上报一次：匿名安装 id、版本、平台与当日决策数": "Reports once a day: anonymous install id, version, platform, and today's decision count",
      "已关闭：任何情况下都不联网": "Off: never touches the network",
      "仅首次运行上报一次「安装了」，之后不再联网": "Reports \"installed\" once on first run, then never again",
      "off（不联网）": "off (no network)",
      "install（仅首次）": "install (first run only)",
      "daily（每天一次，默认）": "daily (once a day, default)",
      "auto（先 /decisions）": "auto (/decisions first)",
      // —— 模型 ——
      "模型": "Model",
      "从服务商实时获取；选「自动」则由服务端决定，换名也不会失效": "Fetched live from the provider; \"auto\" leaves the choice to the server and survives renames",
      "正在获取模型列表…": "Fetching the model list…",
      "获取失败，可手填或留空用服务端默认": "Fetch failed — type a name or leave it empty to use the server default",
      "未获取到列表，可手填或留空用服务端默认": "No model list available — type a name or leave it empty to use the server default",
      "自动（服务端默认）": "Auto (server default)",
      "获取": "Fetch",
      "(服务端默认)": "(server default)",
      // —— 密钥 ——
      "（未配置）": "(not configured)",
      "显式 key 字段": "explicit key field",
      "留空则不修改；粘贴新 key 后失焦或回车即保存": "Leave empty to keep the current key; a pasted key is saved on blur or Enter",
      "sk-…（留空不改）": "sk-… (leave empty to keep)",
      "密钥保存位置": "API key storage",
      "存进 ~/.dsh/.credentials.yaml（默认，与其他服务统一托管）": "Store in ~/.dsh/.credentials.yaml (default, managed like other services)",
      ".credentials.yaml（默认）": ".credentials.yaml (default)",
      "插件配置 config.yml": "Plugin config config.yml",
      "未知": "Unknown",
      "（未读到）": "(not read)",
      // —— 决策点清单 ——
      "决策模型参与点": "Decision points",
      "热路径": "hot path",
      "宿主缺服务": "Host service missing",
      "即将支持": "coming soon",
      "关闭": "Off",
      "观察": "Observe",
      "生效": "Enforce",
      "保存中": "Saving",
      "待保存…": "Unsaved…",
      "保存中…": "Saving…",
      "已保存（改动即生效，无需点保存）": "Saved (changes apply immediately, no Save button needed)",
      "改动即保存": "Changes save themselves",
      "重试": "Retry",
      "测试中…": "Testing…",
      "测试端点": "Test endpoint",
      "探测当前生效的决策端点是否可用": "Check whether the currently effective decision endpoint is reachable",
      "未保存：密钥太短（至少 10 个字符）": "Not saved: the key is too short (at least 10 characters)",
      "测试端点失败": "Endpoint test failed",
      // —— 使用免费模型（DEC-030，原名「跟随服务端下发」，DEC-037 改名） ——
      "使用免费模型": "Use the free model",
      "可能会失效": "May stop working",
      "服务端下发": "Server-issued",
      "关闭：使用下方的本地配置（与现在完全一致）": "Off: the local configuration below is used (exactly as before)",
      "正在获取…": "Fetching…",
      "尚未获取（保存后自动获取）": "Not fetched yet (fetched automatically after saving)",
      "重新获取": "Refetch",
      "（服务端下发的值已过期）": " (the server-issued values have expired)",
      "未下发": "Not issued",
      "（地址与密钥来自服务端下发）": " (address and key come from the server)",
      "自动（服务端默认）": "Auto (server default)",
      // —— 免费模型兜底（backup model）：主模型 4xx/5xx 时改用免费模型 ——
      "免费模型兜底": "Free-model fallback",
      "关闭：主模型失败时直接降级放行，与现在完全一致":
        "Off: a failing primary model degrades and lets the call through, exactly as before",
      "已开启「使用免费模型」，兜底不生效（免费模型已是主模型）":
        "“Use the free model” is on, so the fallback is inactive (the free model is already the primary)",
      "主模型失败（4xx/5xx）时改用免费模型 · 已兜底 {n} 次":
        "Falls back to the free model when the primary returns 4xx/5xx · used {n} time(s)",
      "免费模型配置已过期，正在重新获取；期间主模型失败仍直接降级":
        "The free-model config has expired and is being refetched; until then a failing primary still degrades",
      "免费模型配置尚未获取（会自动重试）；期间主模型失败仍直接降级":
        "The free-model config has not been fetched yet (retried automatically); until then a failing primary still degrades",
      "需要提前获取免费模型配置": "Requires fetching the free-model config ahead of time",
    };

