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

    /** 侧边栏与主面板共用的命名空间 / id。 */
    const NS = "decisionEngine";
    const PANEL_ID = "decision-engine";
    const BASE = "/api/decision-engine";

    /**
     * 项目主页（文档站）地址。
     *
     * 配置页顶部给出这个链接：插件信息页里没有「文档在哪」的入口，用户想看
     * 决策点说明、provider 清单或版本更新时只能自己去搜。放在最上面一行的
     * 理由是它是**入口**，不是附注——埋到表单末尾等于没有。
     */
    const SITE_URL = "https://dsh.zuos.us/dsh-decision-engine/";

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
     *    说明、错误标签都由服务端下发（`/decisions`、`/stats` 的
     *    `labels`、`client-errors.js` 的 label）。按 key 翻译就得让服务端
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
      "生效端点": "Effective endpoint",
      "由上方 base URL + 端点风格拼接；已带 /decisions 或 /systemone 时原样使用": "Built from the base URL above plus the endpoint style; kept as-is when it already contains /decisions or /systemone",
      "内置预设的默认地址（可用 config.yml 的 baseUrl 覆盖 bamboonode）": "Built-in preset default address (config.yml's baseUrl can override bamboonode)",
      "(服务端未返回)": "(not returned by the server)",
      "端点不可用：请对照上方诊断检查 provider、base URL 与 API key": "Endpoint unavailable: check the provider, base URL and API key against the diagnostics above",
      "端点返回失败": "The endpoint returned a failure",
      "端点风格": "Endpoint style",
      "路径后缀由服务商决定（实测 SiliconFlow 只通 /systemone，bamboonode 两条都通）。这里是「首选」：若首选路径返回 404，插件会自动改用另一条再试一次": "The path suffix is decided by the provider (measured: SiliconFlow only accepts /systemone, bamboonode accepts both). This is the preferred path: on a 404 the plugin automatically retries with the other one",
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
      "判断计数": "Judgement count",
      "开启后在每轮回复尾部显示本轮判断次数，点开看逐决策点分账；关闭则完全不留记录":
        "When on, each turn's footer shows how many judgements it made (click for the per-point breakdown); when off, nothing is recorded at all",
      "真正拦截": "Actually block",
      "关闭时只记录判断结果（shadow）；开启后按判断执行 deny / ask": "When off, verdicts are only recorded (shadow); when on, deny / ask are enforced",
      "思考模式": "Thinking mode",
      "总是思考：判断更充分，但每次工具调用约多等 5 秒": "Always think: fuller judgement, but roughly 5 extra seconds per tool call",
      "仅在模型自己判断需要时思考（折中）": "Think only when the model itself decides it is needed (middle ground)",
      "不思考：最快（约 1.9s），热路径首选": "Never think: fastest (about 1.9s), the hot-path default",
      "never（不思考）": "never (no thinking)",
      "auto（按需思考）": "auto (think when needed)",
      "always（总是思考）": "always (always think)",
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
      "未保存：密钥太短（至少 10 个字符）": "Not saved: the key is too short (at least 10 characters)",
      "测试端点失败": "Endpoint test failed",
    };

    /** i18n:stats —— 统计页（表头、口径说明、区间、裁决分账）。 */
    const EN_STATS = {
      // —— 表头 ——
      "未知（历史）": "Unknown (legacy)",
      "次数": "Calls",
      "总耗时": "Total time",
      "均耗时": "Avg time",
      "实际 input（观察）": "Actual input (observe)",
      "省 input": "Saved input",
      "实际 output（观察）": "Actual output (observe)",
      "省 output": "Saved output",
      "实际耗时（观察）": "Actual time (observe)",
      "省耗时": "Saved time",
      "节省比例": "Savings ratio",
      "请求次数": "Requests",
      "命中缓存": "Cache hits",
      "均耗时（真实请求）": "Avg time (real requests)",
      "省 input token（观察）": "Saved input tokens (observe)",
      "省 output token（观察）": "Saved output tokens (observe)",
      "省时间（观察）": "Saved time (observe)",
      "节省比例（观察）": "Savings ratio (observe)",
      // —— 页面标题与说明 ——
      "用量统计与对比": "Usage & comparison",
      "重新读取": "Reload",
      "按 provider × model 独立统计；区间为左闭右开，相邻范围不会重复计入。": "Counted separately per provider × model; ranges are half-open, so adjacent ranges never double-count.",
      "节省量只统计「观察」模式。": "Savings count only \"observe\" mode.",
      " 观察模式下决策模型只记录、不改变行为，于是同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活，这个对比才成立。「生效」模式下普通 LLM 路径并没有真的发生，「省了多少」只能是事后估算，因此不计入。": " In observe mode the decision model only records and never changes behaviour, so the same work has both the ordinary LLM's actual cost and what the decision model \"would have done\" — the comparison only holds because both sides measure the same work. In \"enforce\" mode the ordinary LLM path never actually happened, so \"how much was saved\" can only be an estimate afterwards and is excluded.",
      "但没有一条来自观察模式——现在看到的节省量 0 是「没有可比对的数据」，": "but none came from observe mode — the 0 savings you see means \"no comparable data\",",
      "不是「一点也没省」。把相关决策点切到「观察」后即可看到对比。": "not \"nothing was saved\". Switch the relevant decision points to \"observe\" to see the comparison.",
      "时间范围": "Time range",
      "正在读取可选范围…": "Reading available ranges…",
      "至": "to",
      // —— 裁决统计 ——
      "裁决统计（allow / ask / reject）": "Verdicts (allow / ask / reject)",
      "决策模型的裁决结果：放行 = 动作照常进行；询问 = 升级人工确认；拦截 = 动作被拦下。": "Decision-model verdicts: allow = the action proceeds; ask = escalated to a human; reject = the action is stopped.",
      "放行 allow": "allow",
      "询问 ask": "ask",
      "拦截 reject": "reject",
      "未裁决": "Undecided",
      "决策点": "Decision point",
      "放行": "Allow",
      "询问": "Ask",
      "拦截": "Reject",
      "。这是新增决策点或裁决词后忘了登记导致的。": ". This happens when a new decision point or verdict word is added without registering it.",
      "横向对比（provider × model）": "Side by side (provider × model)",
      "节省量对比（观察模式：基线 → 实际）": "Savings (observe mode: baseline → actual)",
      "这段时间没有观察模式的记录，无法对比普通 LLM 路径与决策模型路径。": "No observe-mode records in this period, so the ordinary LLM path and the decision-model path cannot be compared.",
      "把相关决策点切到「观察」后，这里才会出现可比对的节省量。": "Switch the relevant decision points to \"observe\" and comparable savings will appear here.",
      "观察模式下决策模型只记录、不改变行为，因此同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活。": "In observe mode the decision model only records and never changes behaviour, so the same work has both the ordinary LLM's actual cost and what the decision model \"would have done\" — both measured on the same work.",
      "请填写完整的起止时间。": "Fill in both the start and end time.",
      "正在读取统计…": "Reading statistics…",
      "该时间范围内没有统计记录。统计从插件记录决策请求时开始累积。": "No records in this range. Statistics accumulate once the plugin starts recording decision requests.",
      "按决策点分账": "Breakdown by decision point",
      "节省量只统计「观察」模式的记录。观察模式下决策模型只记录、不改变行为，于是同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活，这个对比才成立。在「生效」模式下普通 LLM 路径并没有真的发生，「省了多少」只能是事后估算，因此不计入本表。": "Savings count observe-mode records only. In observe mode the decision model only records and never changes behaviour, so the same work has both the ordinary LLM's actual cost and what the decision model \"would have done\" — the comparison only holds because both sides measure the same work. In \"enforce\" mode the ordinary LLM path never actually happened, so \"how much was saved\" can only be estimated afterwards and is excluded from this table.",
      "基线 = 不启用本插件的缓存与上下文压缩时，同样的工作本应消耗的 token 与时间。节省量相对基线计算（比例的分母是基线）；没有可归因的优化时节省量为 0。平均耗时按**真实请求**计算，不含缓存命中（那一次根本没发请求）。思考模式（think_mode）是用户配置而非插件优化，刻意不计入节省。": "Baseline = the tokens and time the same work would have cost without this plugin's cache and context compaction. Savings are measured against the baseline (the ratio's denominator is the baseline); with no attributable optimization the savings are 0. Average time covers **real requests** only and excludes cache hits (those never sent a request). Thinking mode (think_mode) is a user setting, not a plugin optimization, and is deliberately excluded from savings.",
      "只有「观察」的记录参与节省量计算。": "Only \"observe\" records take part in the savings calculation.",
      "provider 按模型名反推（startlux→bamboonode、Kev/SemIf→硅基流动），但 output token 与耗时基线仍是推算值，耗时基线取同组真实请求的均值。": "The provider is inferred from the model name (startlux→bamboonode, Kev/SemIf→SiliconFlow), but output tokens and the time baseline are still estimated; the time baseline is the mean of real requests in the same group.",
      // —— 服务端下发的区间标签 ——
      "当日": "Today",
      "本周": "This week",
      "本月": "This month",
      "本年": "This year",
      "自定义": "Custom",
    };

    /** i18n:misc —— 页面外壳（tab、主页链接、错误尾部、校验提示）。 */
    const EN_MISC = {
      "项目主页 ↗": "Project home ↗",
      "配置": "Config",
      "统计与对比": "Stats & comparison",
      "决策": "Decision",
      // —— 错误尾部（client-errors.js 的 label 与 errors.js 的分类名） ——
      "未配置 API key": "No API key configured",
      "端点连续失败，已进入冷却": "Endpoint keeps failing, now cooling down",
      "决策请求超时": "Decision request timed out",
      "无法连接决策端点": "Cannot reach the decision endpoint",
      "鉴权被拒": "Authentication rejected",
      "触发限流": "Rate limited",
      "端点返回错误状态": "Endpoint returned an error status",
      "响应不是合法 JSON": "Response is not valid JSON",
      "响应格式不对": "Response shape is wrong",
      "响应缺少 answers 字段": "Response is missing the answers field",
      "答案形状与预期不符": "Answer shape does not match expectations",
      "适配器异常（已忽略）": "Adapter error (ignored)",
      "调用被取消": "Call cancelled",
      // —— 决策点中文名（POINT_LABELS，与 lib/points/spec.js 同源） ——
      "工具授权": "Tool authorization",
      "模型路由": "Model routing",
      "子任务分派": "Subtask delegation",
      "上下文压缩": "Context compaction",
      "轮次延续": "Turn continuation",
      "检索必要性": "Retrieval necessity",
      "技能选择": "Skill pick",
      "思维链翻译": "COT translation",
      "决策引擎": "Decision engine",
      "StartLux 守卫": "StartLux Guard",
      // —— 判断计数与浮层（DEC-019）——
      // 浮层组件自己的 `t` 只认 key，但同一批中文以**文案形态**再登记一份：
      // 静态扫描（test/i18n-coverage.test.js）不区分两种翻译通路，源码里凡是
      // 会落进渲染树的中文都必须在 EN_*/T_* 有英文，否则英文界面冒中文。
      // 关闭按钮特意不叫「关闭」：EN_CONFIG 已有「关闭」= Off（提供方开关），
      // 浮层右上角 × 的语义是关卡片，不是关闸。
      "本轮判断": "Judgements this turn",
      "点开看这一轮的判断都花在哪些决策点上": "Open to see which decision points this turn's judgements went to",
      "关闭浮层": "Close panel",
      "这一轮没有记录": "Nothing recorded for this turn",
      "降级": "Degraded",
    };

    /** i18n:labels —— 服务端下发、且本文件别处没有同名词的中文文案。 */
    const EN_LABELS = {
      // provider 展示名来自服务端（lib/providers.js 的 providerCatalog）。
      // 不收进 EN_CONFIG/EN_STATS，因为它是**服务端数据**：将来新增带中文名
      // 的预设，只要在这里补一行；界面在渲染边界统一翻译，不用改调用点。
      "硅基流动": "SiliconFlow",
      // —— /decisions 的决策点元数据（lib/decision-points.js） ——
      // label：思维链点的服务端名比客户端 POINT_LABELS（EN_MISC）多「门槛」二字
      "思维链翻译门槛": "COT translation gate",
      // summary（决策点说明，渲染在 S.pointHint）
      "判断这次工具调用能否放行。可替代 auto-review——后者把完整会话历史发给主模型，每次工具调用都跑一遍。": "Decide whether this tool call may proceed. Can replace auto-review, which sends the full session history to the main model on every call.",
      "逐步判断这一步值不值得用强模型：机械步骤（读结果、改格式、重试）下沉到便宜模型。": "Decide per step whether the strong model is warranted; route mechanical steps (reading results, reformatting, retries) to a cheaper model.",
      "判断该自己接着做、开 subagent、还是组 agent team。每开一个子代理都等于新开一整个上下文。": "Decide whether to continue inline, spawn a subagent, or form an agent team. Each spawn costs a whole fresh context.",
      "判断现在该摘要压缩，还是只丢掉几条已经没用的工具结果——后者不花摘要的钱。": "Decide whether to summarize now, or simply drop a few stale tool results without paying for a summary.",
      "判断再来一轮还有没有增量价值，避免空转一整轮。": "Decide whether another round adds value, avoiding a wasted full turn.",
      "判断这条信息是否已经知道、或能否直接推断，避免不必要的搜索与抓取。": "Decide whether the information is already known or inferable, avoiding needless searches and fetches.",
      "判断该装哪个技能。装错再换等于付两遍技能正文的 token。": "Decide which skill to load; a wrong pick pays the skill body twice.",
      "判断这条内容是否真的需要翻译，避免逐条调用翻译模型。": "Decide whether content truly needs translation, avoiding a model call per message.",
      // gate（渲染在 t("触发闸：{gate}")，参数值会过 tr）
      "每轮最多判断前 N 步；同一 provider/model 连续多步只问一次": "Judges at most the first N steps per turn; consecutive steps on the same provider/model are asked once",
      "仅每轮第一步且带新用户输入时判断（分派决策只在这一刻可能改变）": "Only on the first step of a turn with new user input (the delegation decision can only change at that moment)",
      "仅当实测 token 已达阈值触发线的 70% 才问（compaction-basic 的 0.8 阈值）": "Only asked once measured tokens reach 70% of the threshold trigger line (the 0.8 threshold of compaction-basic)",
      "同一轮最多续一次（steer 次数上限），避免无限自续": "Continues at most once per turn (the steer cap), preventing endless self-continuation",
      "仅检索类工具（web_search/web_fetch/research 等）才问；其余工具零开销": "Only asked for retrieval tools (web_search/web_fetch/research etc.); zero overhead for other tools",
      "仅 `skill` 工具加载时问，且候选清单非空才问": "Only asked when the `skill` tool loads, and only when candidates are non-empty",
      "超长文本采样头部判断；同一文本摘要命中缓存即复用": "Judged from a head sample of long texts; cached summaries of the same text are reused",
      // trigger（插值进决策点 meta 行，值会过 tr）
      "每次工具调用": "every tool call",
      "每次模型请求": "every model request",
      "每步": "every step",
      "接近上下文阈值": "near the context threshold",
      "每轮结束": "every turn end",
      "每次搜索/抓取": "every search / fetch",
      "每次加载技能": "every skill load",
      "每条消息": "every message",
      // —— providerCatalog 的 hint（lib/providers.js；custom 的服务端 hint 不被
      // 渲染——前端对 custom 用自己的文案，故不收录） ——
      "TypeSafe / Jev 的 System One 协议（POST /v1/systemone），也是 llama.cpp、vLLM 等自建决策服务通用的线协议": "TypeSafe / Jev System One protocol (POST /v1/systemone); the same wire format used by llama.cpp, vLLM and other self-hosted decision servers",
      "StartLux 官方端点（POST /v1/decisions），本插件的原有默认值": "StartLux official endpoint (POST /v1/decisions); the original default of this plugin",
      "硅基流动（国内站）的 System One 端点（POST /v1/systemone）；可用模型 Kev-4B / SemIf，默认 Kev-4B，只填一个 API key 即可使用": "SiliconFlow China System One endpoint (POST /v1/systemone); models Kev-4B / SemIf, default Kev-4B — just add an API key",
      "Silicon Flow（国际站）的 System One 端点（POST /v1/systemone）；与国内站账号不通用，可用模型 Kev-4B / SemIf，默认 Kev-4B，只填一个 API key 即可使用": "Silicon Flow global System One endpoint (POST /v1/systemone); separate account from the CN site, models Kev-4B / SemIf, default Kev-4B — just add an API key",
      // —— 服务端校验错误（lib/providers.js validateBaseUrl，经 providerErrorText 渲染） ——
      "base URL 不能为空": "Base URL must not be empty",
      "base URL 不能包含空格或换行": "Base URL must not contain spaces or line breaks",
      "base URL 必须以 http:// 或 https:// 开头": "Base URL must start with http:// or https://",
      "base URL 不是合法地址（示例：https://api.example.com/v1）": "Base URL is not a valid address (example: https://api.example.com/v1)",
      "base URL 缺少主机名": "Base URL is missing a hostname",
      "base URL 不要带查询串（? 之后的部分）": "Base URL must not include a query string (the part after ?)",
      // —— /stats 的错误（参数进 t("统计读取失败：{error}") 时会过 tr） ——
      "自定义范围需要合法的起止时间（YYYY-MM-DDTHH:mm）": "Custom range needs a valid start and end time (YYYY-MM-DDTHH:mm)",
      "结束时间必须晚于开始时间": "End time must be later than the start time",
      // —— 密钥来源（lib/index.js keySourceLabel，参数进 t("密钥来源 {source}") 时会过 tr） ——
      // 字段名/变量名被服务端拼死在句子里，只能按已知 provider 逐个登记；
      // 新增 provider 时这里要跟着补（漏了就是那一句保持中文）。
      "未配置": "Not configured",
      "配置文件 config.yml 的 systemoneApiKey": "config.yml field systemoneApiKey",
      "配置文件 config.yml 的 bamboonodeApiKey": "config.yml field bamboonodeApiKey",
      "配置文件 config.yml 的 siliconflowApiKey": "config.yml field siliconflowApiKey",
      "配置文件 config.yml 的 siliconflowIntlApiKey": "config.yml field siliconflowIntlApiKey",
      "配置文件 config.yml 的 customApiKey": "config.yml field customApiKey",
      "~/.dsh/.credentials.yaml 的 TYPESAFE_API_KEY": "TYPESAFE_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 BAMBOO_API_KEY": "BAMBOO_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 SILICONFLOW_API_KEY": "SILICONFLOW_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 SILICONFLOW_INTL_API_KEY": "SILICONFLOW_INTL_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 DECISION_ENGINE_CUSTOM_KEY": "DECISION_ENGINE_CUSTOM_KEY in ~/.dsh/.credentials.yaml",
      "环境变量 TYPESAFE_API_KEY": "env var TYPESAFE_API_KEY",
      "环境变量 BAMBOO_API_KEY": "env var BAMBOO_API_KEY",
      "环境变量 SILICONFLOW_API_KEY": "env var SILICONFLOW_API_KEY",
      "环境变量 SILICONFLOW_INTL_API_KEY": "env var SILICONFLOW_INTL_API_KEY",
      "环境变量 DECISION_ENGINE_CUSTOM_KEY": "env var DECISION_ENGINE_CUSTOM_KEY",
    };


    const EN = Object.assign(Object.create(null), EN_CONFIG, EN_STATS, EN_MISC, EN_LABELS);

    /**
     * 参数化文案表：中文模板 → 英文模板，占位写成 `{name}`。
     *
     * 与静态表分开，是因为模板里带着变量hole，整段永远不可能命中；
     * 调用点必须显式写 `t("按「{label}」排序", { label })`。
     */
    /** i18n:templates:config */
    const T_CONFIG = {
      "配置未保存：{problem}": "Configuration not saved: {problem}",
      "端点连通 ✅\n{text}": "Endpoint reachable ✅\n{text}",
      "已验证可用：{endpoint}": "Verified working: {endpoint}",
      "该端点 model 必填；留空 = 用预设默认 {model}（可改填 SemIf）": "This endpoint requires a model; leaving it empty uses the preset default {model} (SemIf also works)",
      "默认（{model}）": "Default ({model})",
      "{model}（当前值）": "{model} (current)",
      "（已配置 {hint}）": "(configured {hint})",
      "存到插件配置 config.yml 的 {field}（明文）": "Stored in the plugin config config.yml under {field} (plaintext)",
      "存到 .credentials.yaml 的 {ref}": "Stored in .credentials.yaml as {ref}",
      "存进插件配置 config.yml 的 {field}（自包含，便于随目录备份；注意是明文）": "Stored in the plugin config config.yml under {field} (self-contained, easy to back up with the directory; note it is plaintext)",
      " · 已判 {requests} 次，缓存 {cached}，{tokens} token，均 {latency}ms": " · {requests} judged, {cached} cached, {tokens} tokens, avg {latency}ms",
      "触发闸：{gate}": "Gate: {gate}",
      "缓存 {size} 条 · 精确命中 {hits} · 命中率 {rate}%": "{size} cached · {hits} exact hits · hit rate {rate}%",
      "提供方 {provider} · 端点 {endpoint}": "Provider {provider} · endpoint {endpoint}",
      "模型 {model} · 超时 {timeout}ms · 请求 {requests} 次（缓存 {cached}）": "Model {model} · timeout {timeout}ms · {requests} requests ({cached} cached)",
      "密钥来源 {source}": "API key from {source}",
    };

    /** i18n:templates:stats */
    const T_STATS = {
      "按「{label}」排序": "Sort by “{label}”",
      "本区间共 {count} 条记录，但没有一条来自观察模式——现在看到的节省量 0 是「没有可比对的数据」，不是「一点也没省」。把相关决策点切到「观察」后即可看到对比。": "{count} records in this range, but none from observe mode — the 0 savings you see means \"no comparable data\", not \"nothing was saved\". Switch the relevant decision points to \"observe\" and the comparison will appear.",
      "实际区间：{start} → {end}": "Actual range: {start} → {end}",
      "统计读取失败：{error}": "Failed to load statistics: {error}",
      "有 {count} 条裁决未归类：": "{count} unclassified verdicts: ",
      "本节只统计「观察」模式的记录（本次 {count} 条）。": "This section counts observe-mode records only ({count} this time).",
      "这段时间没有观察模式的记录，无法对比普通 LLM 路径与决策模型路径。把相关决策点切到「观察」后，这里才会出现可比对的节省量。": "No observe-mode records in this period, so the ordinary LLM path and the decision-model path cannot be compared. Switch the relevant decision points to \"observe\" and comparable savings will appear here.",
      "{verdict}（{count}）": "{verdict} ({count})",
      "、": ", ",
      "本区间按模式分账：观察 {observe} 条": "This range by mode: observe {observe}",
      " · 生效 {enforce} 条": " · enforce {enforce}",
      " · 关闭 {off} 条": " · off {off}",
      " · 未知模式（历史） {unknown} 条。": " · unknown mode (legacy) {unknown}.",
      "含 {count} 条由旧遥测推算的历史记录：": "Includes {count} legacy records inferred from old telemetry: ",
      "统计文件：{path}": "Stats file: {path}",
      " · 已写 {count} 条": " · written {count}",
      " · 写盘失败 {count} 条": " · write failures {count}",
      " · 队列溢出丢弃 {count} 条": " · dropped on queue overflow {count}",
      // —— 判断计数（DEC-019）：带变量的模板以文案形态再登记一份，理由
      // 同 EN_CONFIG 里的浮层文案注释——静态扫描不区分 key 与字面量。 ——
      "{n} 次判断": "{n} judgements",
      "判断 {n}": "judged {n}",
    };


    /** i18n:templates:misc */
    const T_MISC = {
      "（{detail}）": "({detail})",
      "· {tool}": "· {tool}",
    };

    const T = Object.assign(Object.create(null), T_CONFIG, T_STATS, T_MISC);

    /**
     * 把任意宿主/浏览器语言标号归一到 `zh` | `en`。
     *
     * 只有两种语言，所以规则是「带 zh 前缀算中文，其余算英文」：宿主将来
     * 加第三种语言时，本面板继续显示英文而不是回落到中文。
     */
    function normalizeLang(value) {
      if (typeof value !== "string" || value === "") return null;
      const id = value.toLowerCase().replace(/_/g, "-");
      return id === "zh" || id.startsWith("zh-") ? "zh" : "en";
    }

    /**
     * 设置界面语言。
     *
     * `force === true` 时即使值没变也通知一遍：宿主刚注册完字典、面板已经
     * 渲染过一次的情况下，需要一次重绘把新词表用上去。
     */
    function setLang(next, force) {
      const normalized = normalizeLang(next) || "zh";
      const changed = normalized !== lang;
      lang = normalized;
      if (!changed && force !== true) return;
      for (const notify of langListeners) {
        try {
          notify();
        } catch {
          /* 某个组件已经卸载：忽略，不影响其他订阅者 */
        }
      }
    }

    /** 中文 → 当前语言。只认整段命中。 */
    function tr(text) {
      if (typeof text !== "string" || text === "" || lang === "zh") return text;
      const hit = EN[text];
      return typeof hit === "string" ? hit : text;
    }

    /**
     * 参数化文案：先按模板查英文，再把 `{name}` 填回去。
     *
     * 填进去的值也过一遍 `tr`：统计页的「按「{label}」排序」里 label 是
     * 中文列名，不翻译会翻出「Sort by “总耗时”」这种半英半中的句子。
     */
    function t(template, params) {
      let text = template;
      if (lang !== "zh") {
        const hit = T[template] ?? EN[template];
        if (typeof hit === "string") text = hit;
      }
      if (params === undefined || params === null) return text;
      return text.replace(/\{(\w+)\}/g, (all, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? tr(String(params[key])) : all,
      );
    }

    /**
     * 会被翻译的文本类属性。
     *
     * 只列白名单，不做「凡是字符串都翻」：`value` / `href` / `style` 这些
     * 属性里的字符串是数据或标识，翻了就改坏行为。
     */
    const TRANSLATED_PROPS = new Set(["title", "placeholder", "alt", "aria-label", "label"]);

    function translateProps(props) {
      if (!props || typeof props !== "object") return props;
      let changed = false;
      const next = {};
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (typeof value === "string" && TRANSLATED_PROPS.has(key)) {
          const text = tr(value);
          next[key] = text;
          if (text !== value) changed = true;
        } else {
          next[key] = value;
        }
      }
      return changed ? next : props;
    }

    function translateChild(child) {
      if (typeof child === "string") return tr(child);
      if (Array.isArray(child)) return child.map(translateChild);
      return child;
    }

    /**
     * 渲染入口：`createElement` 的翻译包装。
     *
     * 组件里照旧写中文，文本一落到虚拟 DOM 就按当前语言换一次；`t()` 的
     * 结果也会经过这里，但英文串不在词典里，等于原样通过。
     */
    function h(type, props, ...children) {
      return createElement(type, translateProps(props), ...children.map(translateChild));
    }

    /**
     * 订阅语言变化的钩子。
     *
     * 返回值没有用于取值渲染（`tr` 读的是模块级 `lang`），它的**唯一作用是
     * 在宿主切语言时把这个组件重绘一次**。所以调用位置固定在所有
     * `useState` 之后——测试用「useState 第 n 个槽位」注入状态，多插一个
     * 槽位会把后面的槽位全部挪位。
     */
    function useLang() {
      const [value, setValue] = react.useState(lang);
      react.useEffect(() => {
        const notify = () => setValue(lang);
        langListeners.add(notify);
        notify();
        return () => {
          langListeners.delete(notify);
        };
      }, []);
      return value;
    }

    /**
     * 读宿主语言。
     *
     * 宿主的 `locale` 服务（dsh-client-locale）挂着 LocaleFace：
     * `getSnapshot()` 返回冻结的 `{ active, locales, revision }`，
     * active 就是生效中的 locale id（内置只有 `"zh"` 与 `"en"`）。
     * 读不到快照时退回试直接属性——宿主各版本未必都装好了 face。
     */
    function readHostLang(ctx) {
      const locale = ctx && ctx.locale;
      if (!locale) return null;
      const candidates = [];
      try {
        const snapshot = typeof locale.getSnapshot === "function" ? locale.getSnapshot() : null;
        if (snapshot) candidates.push(snapshot.active, snapshot.locale);
      } catch {
        /* 快照不可用：继续试直接属性 */
      }
      candidates.push(locale.active, locale.current, locale.language, locale.locale);
      for (const candidate of candidates) {
        const normalized = normalizeLang(typeof candidate === "function" ? candidate() : candidate);
        if (normalized) return normalized;
      }
      return null;
    }

    /**
     * 跟随宿主语言变化。
     *
     * `ctx.locale.subscribe(fn)` 在**每次快照变化**时回调（切语言与注册词典
     * 都会推进 revision），返回值就是退订函数——正是本函数要 yield 给
     * cordis 的 disposer。备用通道 `ctx.on("locale/change", fn)` 只在切换时
     * 发（词典注册不发），payload 是同一个快照；老宿主没有 subscribe 时靠它。
     *
     * 注意：回调里不用 force——setLang 只在语言真的变了才通知，宿主启动时
     * 注册词典引起的几次快照变化不值得整页重绘。
     *
     * @returns 撤销订阅的函数（没有订阅时是空函数）
     */
    function watchHostLang(ctx) {
      const apply = () => setLang(readHostLang(ctx) ?? browserLang());
      const locale = ctx && ctx.locale;
      if (!locale) return () => {};
      const disposers = [];
      try {
        if (typeof locale.subscribe === "function") {
          const result = locale.subscribe(apply);
          if (typeof result === "function") disposers.push(result);
        }
      } catch {
        /* 不支持 subscribe：继续试事件 */
      }
      try {
        if (typeof ctx.on === "function") {
          const result = ctx.on("locale/change", apply);
          if (typeof result === "function") disposers.push(result);
        }
      } catch {
        /* 不支持事件：到此为止 */
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 撤销失败不影响其余订阅 */
          }
        }
      };
    }

    /** 浏览器语言：宿主没给语言时的依据（与宿主的 zh/en 二分口径一致）。 */
    function browserLang() {
      try {
        const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
        for (const item of list) {
          const normalized = normalizeLang(item);
          if (normalized) return normalized;
        }
      } catch {
        /* 没有 navigator（Node 里的渲染测试）：按中文 */
      }
      return "zh";
    }

    /* i18n 内部状态：给测试与浏览器控制台留的口。 */
    const i18n = { EN, T, tr, t, setLang, normalizeLang, readHostLang, browserLang, get lang() { return lang; } };

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
      /**
       * 顶部的项目主页链接。
       *
       * 颜色沿用面板里的强调色（与选中态同一个靛蓝），下划线保留：这是个
       * 会跳到站外的链接，形状上就该像链接，不能只靠颜色区分。
       */
      siteLink: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        // 下边距 = 链接与 tab 栏的间距（原先这段距离挂在 tabBar 上，
        // 现在链接插到了 tab 栏上面，间距跟着挪过来，两处不叠加）。
        margin: "0 0 16px",
        fontSize: "12px",
        lineHeight: 1.4,
        color: "#818cf8",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        wordBreak: "break-all",
      },
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
      /** 小按钮（获取模型 / 测试端点 / 重试）。 */
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
      // —— 统计与对比 ——
      /** 统计表格。 */
      statsTable: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "11px",
        marginTop: "8px",
      },
      /** 表头单元格。 */
      statsTh: {
        textAlign: "right",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.28)",
        opacity: 0.7,
        fontWeight: 500,
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
      },
      /** 表格里的普通单元格。 */
      statsTd: {
        textAlign: "right",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      },
      /** 名称列（左对齐）。 */
      statsNameTd: {
        textAlign: "left",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        whiteSpace: "nowrap",
      },
      /** 节省量用绿色标出。 */
      savedTd: {
        textAlign: "right",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
        color: "#7dd3a0",
      },
      /** 汇总卡片。 */
      statsCards: {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        marginTop: "8px",
      },
      /** 单个汇总块。 */
      statsCard: {
        flex: "1 1 120px",
        minWidth: "120px",
        padding: "8px 10px",
        borderRadius: "7px",
        border: "1px solid rgba(128,128,128,.2)",
        background: "rgba(128,128,128,.05)",
      },
      statsCardLabel: { fontSize: "10px", opacity: 0.55, marginBottom: "3px" },
      statsCardValue: {
        fontSize: "14px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      },
      /**
       * 顶层 tab 栏。
       *
       * 贴着下边框（而不是做成胶囊组）：tab 是**页面级**导航，要和页面内
       * 的分段控件（三态模式、时间范围）在视觉层级上分开——两者都做成
       * 胶囊时，用户分不清哪个切换的是整页、哪个只是本页的一个筛选条件。
       */
      tabBar: {
        display: "flex",
        gap: "2px",
        margin: "0 0 16px",
        borderBottom: "1px solid rgba(128,128,128,.24)",
      },
      tab: (active) => ({
        padding: "7px 16px",
        marginBottom: "-1px",
        borderRadius: "7px 7px 0 0",
        border: active ? "1px solid rgba(128,128,128,.32)" : "1px solid transparent",
        borderBottom: active ? "1px solid transparent" : "none",
        background: active ? "rgba(128,128,128,.14)" : "transparent",
        color: "inherit",
        fontSize: "13px",
        fontWeight: active ? 600 : 450,
        cursor: "pointer",
        opacity: active ? 1 : 0.6,
      }),
      /** 统计页容器：比配置页宽——对比表有十来列，620px 装不下。 */
      statsWrap: {
        maxWidth: "1000px",
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
        padding: "20px 24px",
        fontSize: "13px",
      },
      /** 页面内的分段控件（时间范围预设）。 */
      tabItem: (active) => ({
        padding: "5px 12px",
        borderRadius: "6px",
        border: active ? "1px solid rgba(128,128,128,.42)" : "1px solid rgba(128,128,128,.18)",
        background: active ? "rgba(128,128,128,.22)" : "transparent",
        color: "inherit",
        fontSize: "12px",
        cursor: "pointer",
        opacity: active ? 1 : 0.65,
      }),
      /** 口径脚注：解释数字是怎么算出来的，必须显眼但不抢主表的注意力。 */
      statsNote: {
        marginTop: "14px",
        padding: "10px 12px",
        borderRadius: "7px",
        border: "1px dashed rgba(128,128,128,.3)",
        fontSize: "11px",
        lineHeight: 1.6,
        opacity: 0.7,
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

    /**
     * 自动保存的防抖时长：文本框停手多久之后落盘。
     *
     * 太短会把打字过程中的半截值写进 yml（每个字符一次请求），太长则
     * 「改完立刻关掉面板」会丢改动。700ms 是这两者之间的常见折中。
     */
    const AUTOSAVE_DELAY_MS = 700;

    /**
     * 自定义 base URL 的问题描述，空串表示可用。
     *
     * 规则与服务端 `validateProviderPatch` 一致：本地先判，是为了让「打字打到一半
     * 的非法地址」停在本地（显示红字），而不是每停一下就发一次注定 400 的请求。
     *
     * @param rawUrl - 用户填写的地址（未 trim）。
     * @param provider - 当前 provider；只有 custom 时空地址才是「必填缺失」。
     */
    function customUrlProblem(rawUrl, provider) {
      const url = (rawUrl ?? "").trim();
      if (url.length === 0) {
        return provider === "custom" ? "必填：请填写决策服务的 base URL" : "";
      }
      if (/\s/.test(url)) return "不能包含空格或换行";
      if (!/^https?:\/\//i.test(url)) return "必须以 http:// 或 https:// 开头";
      try {
        const parsed = new URL(url);
        if (parsed.search.length > 0) return "不要带查询串（? 之后的部分）";
      } catch {
        return "不是合法地址（示例：https://api.example.com/v1）";
      }
      return "";
    }

    /**
     * 待落盘的决策点改动，没有改动时返回 null。
     *
     * 与 `/decisions` 的 PUT body 同形（`{ points? }`）：
     * 服务端对空 body 直接 400，所以「没改动就不发」必须由调用方保证。
     */
    function pendingDecisions(values, decisions) {
      const changed = {};
      for (const [id, mode] of Object.entries(values.pointsDraft ?? {})) {
        const original = (decisions?.points ?? []).find((item) => item.id === id);
        if (original !== undefined && original.mode !== mode) changed[id] = mode;
      }
      if (Object.keys(changed).length === 0) return null;
      return { points: changed };
    }

    /**
     * 当前 provider 的字段名与模型策略。
     *
     * **全部由服务端下发**（`providerCatalog` 的 `modelField` / `keyField` /
     * `requiresModel` / `knownModels`），前端不抄一份。理由与 provider 下拉
     * 那条一致：名字只有 providers.js 的预设表知道，前端再写一份就是
     * 「界面显示存到 A、实际写进 B」这种最难自查的偏差。
     *
     * @param providerId - 当前 provider 的 id。
     * @param view - `/status` 回显。
     * @returns catalog 条目；拿不到（状态未加载）时返回 null。
     */
    function providerFieldsOf(providerId, view) {
      const item = (view?.providerCatalog ?? []).find((row) => row.id === providerId);
      // 字段名是写回配置的前提，少了它宁可不写——见 flush() 里的延后处理。
      if (item === undefined || typeof item.modelField !== "string" || typeof item.keyField !== "string") {
        return null;
      }
      return item;
    }

    /**
     * 各模型字段的原值，键就是 config.yml 里的字段名。
     *
     * 服务端下发 `rawModels`（按字段名）；老服务端只有三个散字段，
     * 一并并入，于是「回显」与「比较有没有改动」都只有一种写法，
     * 不会因为少了一格而漏判改动（漏判 = 改了不保存 = 静默）。
     */
    function rawModelsOf(view) {
      return {
        model: view?.rawModel ?? "",
        systemoneModel: view?.rawSystemoneModel ?? "",
        customModel: view?.customModel ?? "",
        ...(view?.rawModels ?? {}),
      };
    }

    /**
     * 由「当前值」拼出 `/config` 的 PUT patch。
     *
     * 与旧版「点保存」时提交的内容逐字一致，只是取值来源从渲染闭包换成了
     * `valuesRef`（setState 是异步的，自动保存必须读到刚改完的值）。
     *
     * @param values - `{ draft, providerDraft, keyInputs, storageDraft }`。
     * @param keyCommit - 用户明确提交密钥的 provider（失焦/回车），否则 null。
     * @param modelFields - 当前 provider 的字段（providerFieldsOf 结果，非 null）。
     * @param keyFields - 提交密钥的那个 provider 的字段；本次没提交时为 null。
     */
    function configPatchOf(values, keyCommit, modelFields, keyFields) {
      const draft = values.draft;
      const provider = values.providerDraft;
      const patch = {
        enabled: draft.enabled === true,
        mode: draft.mode,
        // 判断计数总是提交：它是全局项（与 provider 无关），服务端还会再校验。
        judgementCount: draft.judgementCount !== false,
        // 思考模式总是提交：它是全局项（与 provider 无关），服务端还会再校验一次。
        thinkMode: draft.thinkMode ?? "never",
        // 模型只写当前 provider 自己那一格（字段名叫什么由 fields 给）。
        // 混写会让「切过去再切回来」丢掉原值，也会把 bamboonode 的模型名
        // 发给别的服务。
        [modelFields.modelField]: (draft[modelFields.modelField] ?? "").trim(),
        provider: provider.provider,
        customEndpointStyle: provider.customEndpointStyle ?? "auto",
        // custom 的字段总是带上：用户可能先填地址再切 provider，
        // 分开提交会让中间状态被当成最终配置。
        customHeaders: (provider.customHeaders ?? "").trim(),
        customApiKeyEnv: (provider.customApiKeyEnv ?? "").trim(),
      };
      // customBaseUrl 只在**合法**时提交。空串对内置 provider 是合法的
      //（等于不覆盖），对 custom 则是必填缺失——那种情况整笔延后，见 flush()。
      // 不合法的值一律不发：服务端会拒，而打字途中的每一次拒绝都是噪音。
      const url = (provider.customBaseUrl ?? "").trim();
      if (customUrlProblem(url, provider.provider) === "") patch.customBaseUrl = url;
      // 保存位置：只在用户改过时才提交，避免每次保存都覆盖。
      if (values.storageDraft !== null && values.storageDraft !== undefined) {
        patch.keyStorage = values.storageDraft;
      }
      // 密钥：只有用户明确提交（失焦 / 回车）且长度够时才带上。
      // 否则打字过程中每停一下都会把半截 key 写进凭据文件。
      //
      // 写到哪一格按**提交时的 provider**（keyCommit）而不是当前选中的 provider：
      // 提交与落盘之间可能隔了几百毫秒（防抖、上一次保存还在飞），期间用户
      // 完全可以切走。按当前选中项写，就会把硅基流动的 key 存进 bamboonode 的
      // 格子——正是「存了 key 却说没配 key」的来源。
      if (keyCommit !== null && keyCommit !== undefined && keyFields !== null) {
        const raw = (values.keyInputs[keyCommit] ?? "").trim();
        if (raw.length >= 10) patch[keyFields.keyField] = raw;
      }
      return patch;
    }

    /**
     * patch 是否真的与服务端当前状态不同。
     *
     * 自动保存会频繁调用：不做这个比较，用户改一个决策点也会重写一次
     * config.yml（白改 mtime、白触发一次热加载）。比较对象是 status 回显，
     * 也就是「服务端认为的值」——与旧版「保存按钮的可用条件」同一语义。
     *
     * @param patch - `configPatchOf` 拼出的 patch。
     * @param view - `/status` 回显（缺字段时用安全默认）。
     */
    function patchDiffersFromServer(patch, view, fields) {
      const pairs = [
        ["enabled", view.enabled === true],
        ["mode", view.mode ?? "shadow"],
        ["judgementCount", view.judgementCount !== false],
        ["thinkMode", view.thinkMode ?? "never"],
        ["provider", view.provider ?? "bamboonode"],
        ["customBaseUrl", view.customBaseUrl ?? ""],
        ["customEndpointStyle", view.customEndpointStyle ?? "auto"],
        ["customHeaders", view.customHeaders ?? ""],
        ["customApiKeyEnv", view.customApiKeyEnv ?? ""],
        ["keyStorage", view.keyStorage ?? "credentials"],
        // 模型字段逐格比较：键就是 config.yml 里的字段名（rawModels 下发）。
        // 用一张表而不是逐个 provider 写死，新增预设才不用改这里——漏一格
        // 的后果是「改了模型却不触发保存」。
        ...Object.entries(rawModelsOf(view)),
      ];
      for (const [key, server] of pairs) {
        if (Object.hasOwn(patch, key) && String(patch[key] ?? "") !== String(server ?? "")) return true;
      }
      // 密钥字段一出现就代表「有新 key 要写」：服务端只回传掩码，没法比较，
      // 而且重复写同一个 key 是无害的（幂等覆盖）。字段名由服务端下发。
      return Object.hasOwn(patch, fields.keyField);
    }

    /**
     * 千分位分组。
     *
     * 不用 `toLocaleString()`：它的分组与分隔符随运行环境的 locale 变
     * （Node 与 Electron 的默认 locale 未必一致），同一份数据在两个地方
     * 显示成两种数字，正是最难核对的那类问题。
     */
    function groupDigits(value) {
      const n = Number(value ?? 0);
      if (!Number.isFinite(n)) return "0";
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 毫秒的可读化。
     *
     * 「1067032ms」没法读，而统计里时间跨度正好横跨毫秒到分钟量级，
     * 所以按量级切换单位；小于 1 秒保留 ms（那正是本插件关心的粒度）。
     */
    function formatMs(value) {
      const n = Number(value ?? 0);
      if (!Number.isFinite(n) || n <= 0) return "0ms";
      if (n < 1000) return `${Math.round(n)}ms`;
      if (n < 60000) return `${Math.round(n / 100) / 10}s`;
      return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
    }

    /** 比例（0–1）显示成百分数；一位小数足够，再多就是假精确。 */
    function formatRatio(value) {
      const n = Number(value ?? 0);
      if (!Number.isFinite(n) || n <= 0) return "0%";
      return `${Math.round(n * 1000) / 10}%`;
    }

    /** ISO 串显示成本地「MM-DD HH:mm」，让用户看见预设解析成的真实边界。 */
    function formatLocalTime(iso) {
      const ms = Date.parse(String(iso ?? ""));
      if (Number.isNaN(ms)) return "";
      const d = new Date(ms);
      const pad = (v) => String(v).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** 可排序表头：点击切到该字段，再点切换升降序。 */
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
     * 统计 tab 的整页内容。
     *
     * 为什么写成独立一节而不是配置页里的一小块：统计要回答的是「钱花在
     * 哪个 provider 的哪个模型上」「比不开插件省了多少」，这两件事都需要
     * 一整屏的横向空间（对比表十来列）。挤在表单末尾时既看不清，也让
     * 本来就长的配置页更难用。
     *
     * 这里是**纯渲染**：不碰任何状态、不发请求。聚合口径全部在服务端
     * （lib/stats.js），前端只负责把结果排出来——前端再算一遍必然出现
     * 「界面与导出数据对不上」。
     *
     * @param props.stats - `/stats` 的响应；null 表示还在读。
     * @param props.error - 读取失败的原因。
     * @param props.filter - 当前筛选（preset / start / end / sort / dir）。
     * @param props.setFilter - 替换筛选（新对象，触发重查）。
     * @param props.reload - 用当前筛选强制重查。
     * @param props.pointLabels - 决策点 id → 中文名。
     * @param props.providerLabels - provider id → 展示名。
     */
    function renderStatsTab(props) {
      const stats = props.stats;
      const error = props.error;
      const filter = props.filter;
      const setFilter = props.setFilter;
      const pointLabels = props.pointLabels ?? {};
      const providerLabels = props.providerLabels ?? {};
      const rows = Array.isArray(stats?.rows) ? stats.rows : [];
      const totals = stats?.totals ?? null;
      const range = stats?.range ?? null;
      /**
       * 裁决统计（allow / ask / reject）。
       *
       * 单独一块，不与用量表合并：用量回答「钱花在哪」，裁决回答
       * 「模型拦下了多少、惊动了用户多少次」。两套口径互不换算。
       *
       * `outcomes` 可能是 undefined——服务端是旧版本或数据文件为空时。
       * 这时整块不渲染，而不是渲染一张全零的表（那看着像「一次都没拦过」，
       * 而真实情况可能是根本没数据）。
       */
      const outcomes = stats?.outcomes ?? null;
      const outcomePoints = Array.isArray(outcomes?.byPoint) ? outcomes.byPoint : [];
      // 预设清单与标签：优先用「拿到过一次就留着」的元数据，回退到本次响应。
      //
      // 标签不能用 `props.meta?.labels ?? stats?.labels`：元数据的初值是
      // `{}`（不是 null），`??` 永远不跳到右边，于是标签永远是空的，
      // 按钮显示成 `today` 而不是「当日」。所以要和 presets 一样按
      // 「非空才用」判断。
      const metaPresets = Array.isArray(props.meta?.presets) ? props.meta.presets : [];
      const metaLabels = props.meta?.labels ?? {};
      const presets = metaPresets.length > 0
        ? metaPresets
        : Array.isArray(stats?.presets)
          ? stats.presets
          : [];
      const labels = Object.keys(metaLabels).length > 0 ? metaLabels : (stats?.labels ?? {});
      /**
       * 自定义范围还没填完：这不是「没有数据」，也不该显示成读取失败。
       * 单独判一次，因为下面几个分支都只看 `stats === null`，而没填完时
       * 我们刻意不发请求、把 stats 留空——照 `stats === null` 走会显示
       * 「正在读取统计…」，可它根本没在读，用户会一直等。
       */
      const customIncomplete =
        filter.preset === "custom" && (filter.start.length === 0 || filter.end.length === 0);
      const change = (patch) => setFilter({ ...filter, ...patch });
      /** provider 展示名：没下发映射时退回 id，不显示空白。 */
      const providerName = (id) => providerLabels[id] ?? (id === "unknown" ? "未知（历史）" : id);
      /** 组合列的第一行：provider 展示名 + id，避免同名不同源看不出。 */
      const comboName = (row) => `${providerName(row.provider)}`;

      const compareColumns = [
        { key: "requests", label: "次数" },
        { key: "inputTokens", label: "input" },
        { key: "outputTokens", label: "output" },
        { key: "durationMs", label: "总耗时" },
        { key: "avgDurationMs", label: "均耗时" },
      ];
      /**
       * 节省量对比表的列。
       *
       * 「实际」三列显示的是**观察模式**那部分的实际消耗，与旁边的
       * 「省」列同源：两者必须来自同一批记录，否则读者会拿生效模式的
       * 消耗去减观察模式的节省，得出一个毫无意义的数。
       */
      const savedColumns = [
        { key: "observeInputTokens", label: "实际 input（观察）", actual: true },
        { key: "savedInputTokens", label: "省 input" },
        { key: "observeOutputTokens", label: "实际 output（观察）", actual: true },
        { key: "savedOutputTokens", label: "省 output" },
        { key: "observeDurationMs", label: "实际耗时（观察）", actual: true },
        { key: "savedDurationMs", label: "省耗时" },
        { key: "savedRatio", label: "节省比例" },
      ];

      /**
       * 节省量的元信息。
       *
       * 节省量只由**观察模式**的记录贡献（服务端口径，见 lib/stats.js）：
       * 只有那时「普通 LLM 路径」与「决策模型路径」跑在同一批工作上，
       * 两边比的是同一批活，反事实才成立。生效模式下普通 LLM 路径根本
       * 没发生，「省了多少」只能是事后估算。
       *
       * `unavailable` = 这段时间没有观察模式的记录。此时界面上**不能**显示
       * 一个 0 的节省量——那会被读成「一点也没省」，而真相是「没有可比
       * 的数据」。两者的行动建议完全不同，所以必须分开说。
       */
      const savingsMeta = stats?.savings ?? null;
      const savingsUnavailable = savingsMeta?.unavailable === true;
      const observeRequests = Number(savingsMeta?.observeRequests ?? totals?.observeRequests ?? 0);

      const summaryCards =
        totals === null
          ? []
          : [
              { label: "请求次数", value: groupDigits(totals.requests) },
              { label: "命中缓存", value: groupDigits(totals.cached) },
              { label: "input token", value: groupDigits(totals.inputTokens) },
              { label: "output token", value: groupDigits(totals.outputTokens) },
              { label: "总耗时", value: formatMs(totals.durationMs) },
              // 写清「真实请求」：缓存命中的耗时是 0，混进分母会让这个
              // 数字随命中率变好看，读的人以为请求变快了。
              { label: "均耗时（真实请求）", value: formatMs(totals.avgDurationMs) },
              // ---- 节省量（观察模式）----
              //
              // 卡片标题里写明「观察」：这几个数字的来源必须一眼可见，
              // 否则读者会把它们当成「插件整体省了多少」。
              {
                label: "省 input token（观察）",
                value: groupDigits(totals.savedInputTokens),
                saved: true,
              },
              {
                label: "省 output token（观察）",
                value: groupDigits(totals.savedOutputTokens),
                saved: true,
              },
              { label: "省时间（观察）", value: formatMs(totals.savedDurationMs), saved: true },
              { label: "节省比例（观察）", value: formatRatio(totals.savedRatio), saved: true },
            ];

      return h(
        "div",
        { key: "stats-page" },
        // 1) 标题 + 强制重查。统计是读文件算出来的，不跟着配置页的自动刷新，
        //    所以必须留一个手动入口——否则用户改完配置回来看，数字没动过。
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "10px" } },
          h("div", { style: S.title }, "用量统计与对比"),
          h(
            "button",
            {
              type: "button",
              onClick: props.reload,
              style: { ...S.saveBtn, marginLeft: "auto", flex: "none" },
            },
            "重新读取",
          ),
        ),
        h(
          "div",
          { style: S.sub },
          "按 provider × model 独立统计；区间为左闭右开，相邻范围不会重复计入。",
        ),
        /**
         * 节省量的口径提示条。
         *
         * 为什么放在页面最上面而不是只放在脚注：节省量是这页最容易误读的
         * 数字——它是**反事实**（普通 LLM vs 决策模型），而且**只在观察
         * 模式下有实测意义**。放在脚注里等于没说：看表的人先看表。
         *
         * 提示条的颜色随「本区间有没有观察模式的记录」变化：有数据时是
         * 中性的说明，没数据时是橙色警告（读者需要知道为什么节省量是 0）。
         */
        stats !== null && savingsMeta !== null
          ? h(
              "div",
              {
                style: {
                  marginTop: "8px",
                  padding: "8px 10px",
                  borderRadius: "7px",
                  border: "1px solid rgba(128,128,128,.22)",
                  background: "rgba(128,128,128,.05)",
                  fontSize: "11px",
                  lineHeight: 1.55,
                  color: savingsUnavailable ? "#f5b26b" : "inherit",
                },
              },
              h(
                "div",
                null,
                h("strong", null, "节省量只统计「观察」模式。"),
                " 观察模式下决策模型只记录、不改变行为，于是同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活，这个对比才成立。「生效」模式下普通 LLM 路径并没有真的发生，「省了多少」只能是事后估算，因此不计入。",
              ),
              savingsUnavailable
                ? h(
                    "div",
                    { style: { marginTop: "4px" } },
                    t("本区间共 {count} 条记录，但没有一条来自观察模式——现在看到的节省量 0 是「没有可比对的数据」，不是「一点也没省」。把相关决策点切到「观察」后即可看到对比。", {
                      count: groupDigits(savingsMeta.totalRequests),
                    }),
                  )
                : null,
            )
          : null,
        // 2) 时间范围。预设清单与标签都由服务端下发（stats.presets / labels），
        //    前端不抄一份——新增一个周期只改 lib/stats.js 一处。
        h(
          "div",
          { style: S.card },
          h("div", { style: S.sectionTitle }, "时间范围"),
          presets.length === 0
            ? h("div", { style: S.pointMeta }, "正在读取可选范围…")
            : h(
                "div",
                { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                ...presets.map((preset) =>
                  h(
                    "button",
                    {
                      type: "button",
                      key: preset,
                      onClick: () => change({ preset }),
                      style: S.tabItem(filter.preset === preset),
                    },
                    labels[preset] ?? preset,
                  ),
                ),
              ),
          // 自定义：精确到分钟的起止时刻。两个都要填全才发请求
          //（缺一个时服务端只会回「需要合法的起止时间」，而那是没填完，不是错）。
          filter.preset === "custom"
            ? h(
                "div",
                { style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "10px", flexWrap: "wrap" } },
                h("input", {
                  type: "datetime-local",
                  style: { ...S.input, flex: "none", minWidth: "190px" },
                  value: filter.start,
                  onChange: (event) => change({ start: event.target.value }),
                }),
                h("span", { style: { fontSize: "11px", opacity: 0.5 } }, "至"),
                h("input", {
                  type: "datetime-local",
                  style: { ...S.input, flex: "none", minWidth: "190px" },
                  value: filter.end,
                  onChange: (event) => change({ end: event.target.value }),
                }),
              )
            : null,
          // 把预设解析成的真实边界写出来：否则「本周」到底是哪几天，
          // 用户只能猜，跨时区或跨月时更是无从核对。
          range !== null && typeof range.start === "string" && range.start.length > 0
            ? h(
                "div",
                { style: { ...S.pointMeta, marginTop: "8px" } },
                t("实际区间：{start} → {end}", {
                  start: formatLocalTime(range.start),
                  end: formatLocalTime(range.end),
                }),
              )
            : null,
        ),
        // 3) 读取失败：给出原因，而不是留一排空值。
        error.length > 0
          ? h(
              "div",
              { style: { ...S.card, borderColor: "rgba(248,113,113,.5)" } },
              h(
                "div",
                { style: { color: "#f87171", fontSize: "12px" } },
                t("统计读取失败：{error}", { error }),
              ),
            )
          : null,
        // 4) 汇总。
        summaryCards.length > 0
          ? h(
              "div",
              { style: S.statsCards },
              ...summaryCards.map((item) =>
                h(
                  "div",
                  { style: S.statsCard, key: item.label },
                  h("div", { style: S.statsCardLabel }, item.label),
                  h(
                    "div",
                    { style: item.saved === true ? { ...S.statsCardValue, color: "#7dd3a0" } : S.statsCardValue },
                    item.value,
                  ),
                ),
              ),
            )
          : null,
        // 4.5) 裁决统计：allow / ask / reject。
        //
        // 与上面的用量统计是**两套口径**：用量回答「钱花在哪」，裁决回答
        // 「模型到底拦下了多少、惊动了用户多少次」。两者不能互相换算——
        // 一次降级没有裁决却花了时间，一次缓存命中的裁决照常计入却没花钱。
        outcomes !== null && (outcomes.decided > 0 || outcomes.none > 0)
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "裁决统计（allow / ask / reject）"),
              h(
                "div",
                { style: { fontSize: "11px", opacity: 0.6, marginTop: "-2px" } },
                "决策模型的裁决结果：放行 = 动作照常进行；询问 = 升级人工确认；拦截 = 动作被拦下。",
              ),
              h(
                "div",
                { style: S.statsCards },
                ...[
                  { label: "放行 allow", value: outcomes.allow, color: "#7dd3a0" },
                  { label: "询问 ask", value: outcomes.ask, color: "#f5b26b" },
                  { label: "拦截 reject", value: outcomes.reject, color: "#e8797f" },
                  { label: "未裁决", value: outcomes.none },
                ].map((item) =>
                  h(
                    "div",
                    { style: S.statsCard, key: item.label },
                    h("div", { style: S.statsCardLabel }, item.label),
                    h(
                      "div",
                      {
                        style:
                          item.color === undefined
                            ? S.statsCardValue
                            : { ...S.statsCardValue, color: item.color },
                      },
                      groupDigits(item.value),
                    ),
                  ),
                ),
              ),
              // 按决策点分：哪个点在拦、在问，一目了然。
              outcomePoints.length > 0
                ? h(
                    "div",
                    { style: { overflowX: "auto", marginTop: "10px" } },
                    h(
                      "table",
                      { style: S.statsTable },
                      h(
                        "thead",
                        null,
                        h(
                          "tr",
                          null,
                          h("th", { style: { ...S.statsTh, textAlign: "left" } }, "决策点"),
                          h("th", { style: S.statsTh }, "放行"),
                          h("th", { style: S.statsTh }, "询问"),
                          h("th", { style: S.statsTh }, "拦截"),
                          h("th", { style: S.statsTh }, "未裁决"),
                        ),
                      ),
                      h(
                        "tbody",
                        null,
                        ...outcomePoints.map((point) =>
                          h(
                            "tr",
                            { key: `outcome/${point.point}` },
                            h("td", { style: S.statsNameTd }, pointLabels[point.point] ?? point.point),
                            h("td", { style: S.statsTd }, groupDigits(point.allow)),
                            h("td", { style: S.statsTd }, groupDigits(point.ask)),
                            h("td", { style: S.statsTd }, groupDigits(point.reject)),
                            h("td", { style: S.statsTd }, groupDigits(point.none)),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              // 漏登记的裁决必须显式提示：否则它只是让数字**偏小**，
              // 而偏小的数字看着仍然合理——这是最难自查的一类错。
              outcomes.otherVerdictCount > 0
                ? h(
                    "div",
                    { style: { marginTop: "8px", fontSize: "11px", color: "#f5b26b" } },
                    t("有 {count} 条裁决未归类：", { count: groupDigits(outcomes.otherVerdictCount) })
                      + outcomes.otherVerdicts.map((item) => t("{verdict}（{count}）", { verdict: item.verdict, count: groupDigits(item.count) })).join(t("、"))
                      + t("。这是新增决策点或裁决词后忘了登记导致的。"),
                  )
                : null,
            )
          : null,
        // 5) 横向对比 + 节省量对比。区间内没有记录时说明原因，
        //    而不是显示一张空表让人以为统计坏了。
        rows.length > 0
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "横向对比（provider × model）"),
              h(
                "div",
                { style: { overflowX: "auto" } },
                h(
                  "table",
                  { style: S.statsTable },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", { style: { ...S.statsTh, textAlign: "left" } }, "provider / model"),
                      ...compareColumns.map((column) => sortableTh(column, filter, setFilter)),
                      // 缓存命中单独给出：它是「本插件省了多少」的直接来源，
                      // 混在次数里就看不出节省是从哪来的。
                      h("th", { style: S.statsTh, key: "cached" }, "命中缓存"),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...rows.map((row) =>
                      h(
                        "tr",
                        { key: `${row.provider}/${row.model}` },
                        h(
                          "td",
                          { style: S.statsNameTd },
                          h("div", null, comboName(row)),
                          h("div", { style: { opacity: 0.55, fontSize: "10px" } }, row.model),
                        ),
                        h("td", { style: S.statsTd }, groupDigits(row.requests)),
                        h("td", { style: S.statsTd }, groupDigits(row.inputTokens)),
                        h("td", { style: S.statsTd }, groupDigits(row.outputTokens)),
                        h("td", { style: S.statsTd }, formatMs(row.durationMs)),
                        h("td", { style: S.statsTd }, formatMs(row.avgDurationMs)),
                        h("td", { style: S.statsTd }, groupDigits(row.cached)),
                      ),
                    ),
                  ),
                ),
              ),
              h(
                "div",
                { style: { ...S.sectionTitle, marginTop: "16px" } },
                "节省量对比（观察模式：基线 → 实际）",
              ),
              /**
               * 这一节的说明必须紧贴表格。
               *
               * 表格上方一句「节省量只统计观察模式」——读者在看到数字的
               * **那一刻**就知道它的来源，而不是要翻到页面底部的脚注。
               * 放到脚注里等于没说：看表的人不会先读完脚注。
               */
              h(
                "div",
                { style: { ...S.pointHint, marginTop: "2px" } },
                savingsUnavailable
                  ? t("这段时间没有观察模式的记录，无法对比普通 LLM 路径与决策模型路径。把相关决策点切到「观察」后，这里才会出现可比对的节省量。")
                  : t("本节只统计「观察」模式的记录（本次 {count} 条）。", { count: groupDigits(observeRequests) })
                    + t("观察模式下决策模型只记录、不改变行为，因此同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活。"),
              ),
              h(
                "div",
                { style: { overflowX: "auto" } },
                h(
                  "table",
                  { style: S.statsTable },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", { style: { ...S.statsTh, textAlign: "left" } }, "provider / model"),
                      ...savedColumns.map((column) => sortableTh(column, filter, setFilter)),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...rows.map((row) =>
                      h(
                        "tr",
                        { key: `saved/${row.provider}/${row.model}` },
                        h(
                          "td",
                          { style: S.statsNameTd },
                          h("div", null, comboName(row)),
                          h("div", { style: { opacity: 0.55, fontSize: "10px" } }, row.model),
                        ),
                        // 「实际」两列也只显示观察模式的部分——它们与旁边的
                        // 「省」列必须同源，否则读者会拿生效模式的消耗去
                        // 减观察模式的节省，得出一个毫无意义的数。
                        h("td", { style: S.statsTd }, groupDigits(row.observeInputTokens ?? 0)),
                        h("td", { style: S.savedTd }, groupDigits(row.savedInputTokens)),
                        h("td", { style: S.statsTd }, groupDigits(row.observeOutputTokens ?? 0)),
                        h("td", { style: S.savedTd }, groupDigits(row.savedOutputTokens)),
                        h("td", { style: S.statsTd }, formatMs(row.observeDurationMs ?? 0)),
                        h("td", { style: S.savedTd }, formatMs(row.savedDurationMs)),
                        h("td", { style: S.savedTd }, formatRatio(row.savedRatio)),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : customIncomplete
            ? h(
                "div",
                { style: S.card },
                h("div", { style: S.pointMeta }, "请填写完整的起止时间。"),
              )
            : stats === null
              ? h("div", { style: S.pointMeta }, "正在读取统计…")
              : h(
                  "div",
                  { style: S.card },
                  h(
                    "div",
                    { style: S.pointMeta },
                    "该时间范围内没有统计记录。统计从插件记录决策请求时开始累积。",
                  ),
                ),
        // 6) 按决策点分账：同一个 provider/model 上，哪个点在花钱一目了然。
        Array.isArray(stats?.byPoint) && stats.byPoint.length > 0
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "按决策点分账"),
              h(
                "div",
                { style: { overflowX: "auto" } },
                h(
                  "table",
                  { style: S.statsTable },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      h("th", { style: { ...S.statsTh, textAlign: "left" } }, "决策点"),
                      h("th", { style: S.statsTh }, "次数"),
                      h("th", { style: S.statsTh }, "input"),
                      h("th", { style: S.statsTh }, "output"),
                      h("th", { style: S.statsTh }, "总耗时"),
                      h("th", { style: S.statsTh }, "均耗时"),
                      h("th", { style: S.statsTh }, "命中缓存"),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    ...stats.byPoint.map((point) =>
                      h(
                        "tr",
                        { key: `point/${point.point}` },
                        h("td", { style: S.statsNameTd }, pointLabels[point.point] ?? point.point),
                        h("td", { style: S.statsTd }, groupDigits(point.requests)),
                        h("td", { style: S.statsTd }, groupDigits(point.inputTokens)),
                        h("td", { style: S.statsTd }, groupDigits(point.outputTokens)),
                        h("td", { style: S.statsTd }, formatMs(point.durationMs)),
                        h("td", { style: S.statsTd }, formatMs(point.avgDurationMs)),
                        h("td", { style: S.statsTd }, groupDigits(point.cached)),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,
        // 7) 口径脚注。用户必须知道「省了多少」是相对什么算的，否则会把
        //    估算当成实测——那是最难发现也最难解释的偏差。
        stats !== null
          ? h(
              "div",
              { style: S.statsNote },
              h(
                "div",
                null,
                "节省量只统计「观察」模式的记录。观察模式下决策模型只记录、不改变行为，于是同一批工作既有普通 LLM 的实际消耗，也有决策模型「本该怎么跑」的结果——两者比的是同一批活，这个对比才成立。在「生效」模式下普通 LLM 路径并没有真的发生，「省了多少」只能是事后估算，因此不计入本表。",
              ),
              h(
                "div",
                { style: { marginTop: "6px" } },
                "基线 = 不启用本插件的缓存与上下文压缩时，同样的工作本应消耗的 token 与时间。节省量相对基线计算（比例的分母是基线）；没有可归因的优化时节省量为 0。平均耗时按**真实请求**计算，不含缓存命中（那一次根本没发请求）。思考模式（think_mode）是用户配置而非插件优化，刻意不计入节省。",
              ),
              /**
               * 模式分账：让用户一眼看出「节省为 0」的原因。
               *
               * 「观察模式下确实没省」与「这段时间根本没在观察模式跑」是
               * 两件完全不同的事，而它们的数字都是 0。没有这张分账，
               * 读者只能靠猜。
               */
              savingsMeta !== null
                ? h(
                    "div",
                    { style: { marginTop: "6px", opacity: 0.55 } },
                    t("本区间按模式分账：观察 {observe} 条", { observe: groupDigits(savingsMeta.byMode?.observe ?? 0) })
                      + t(" · 生效 {enforce} 条", { enforce: groupDigits(savingsMeta.byMode?.enforce ?? 0) })
                      + t(" · 关闭 {off} 条", { off: groupDigits(savingsMeta.byMode?.off ?? 0) })
                      + t(" · 未知模式（历史） {unknown} 条。", { unknown: groupDigits(savingsMeta.byMode?.unknown ?? 0) })
                      + t("只有「观察」的记录参与节省量计算。"),
                  )
                : null,
              stats.legacy?.included === true
                ? h(
                    "div",
                    { style: { marginTop: "6px", color: "#f5b26b", opacity: 1 } },
                    t("含 {count} 条由旧遥测推算的历史记录：", { count: groupDigits(stats.legacy.count) })
                      + t("provider 按模型名反推（startlux→bamboonode、Kev/SemIf→硅基流动），但 output token 与耗时基线仍是推算值，耗时基线取同组真实请求的均值。"),
                  )
                : null,
              stats.store !== null && stats.store !== undefined
                ? h(
                    "div",
                    { style: { marginTop: "6px", opacity: 0.55 } },
                    t("统计文件：{path}", { path: stats.store.path })
                      + t(" · 已写 {count} 条", { count: groupDigits(stats.store.written) })
                      + (stats.store.failed > 0 ? t(" · 写盘失败 {count} 条", { count: groupDigits(stats.store.failed) }) : "")
                      + (stats.store.dropped > 0 ? t(" · 队列溢出丢弃 {count} 条", { count: groupDigits(stats.store.dropped) }) : ""),
                  )
                : null,
            )
          : null,
      );
    }


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
      // 的那一帧会显示错的值（例如把 custom 显示成 bamboonode）。
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
            setDraft({
              enabled: next.enabled === true,
              mode: next.mode ?? "shadow",
              thinkMode: next.thinkMode ?? "never",
              // 判断计数也要回显：漏了它，重开页面时草稿里没有这个键，
              // 开关按「!== false」回落成 ON——用户明明关掉了却看到开着。
              judgementCount: next.judgementCount !== false,
              // 模型各 provider 一格：键就是 config.yml 里的字段名（rawModels
              // 下发），因此新增预设不必再改前端。切 provider 也不会把 A 的
              // 模型名带进 B 那一格。
              ...rawModelsOf(next),
            });
            // provider 回显：保存后重新打开必须看到自己选的那一项与 custom 值。
            // 全部来自服务端 status，前端不缓存、不推断。模型不在这里——
            // 它按字段名放在 draft（见 rawModelsOf）。
            setProviderDraft({
              provider: next.provider ?? "bamboonode",
              customBaseUrl: next.customBaseUrl ?? "",
              customEndpointStyle: next.customEndpointStyle ?? "auto",
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
        // 探测出的可用路径：status 失败时留空（界面不显示那一行）。
        detectedEndpoint: "",
        model: "",
        timeoutMs: 20000,
        keyConfigured: false,
        keyHint: "",
        keyStorage: "credentials",
        keyStatus: {},
        // 兜底也要给出思考模式取值：status 请求失败时下拉框仍要能显示。
        thinkMode: "never",
        thinkModes: ["never", "auto", "always"],
        stats: { requests: 0, cached: 0 },
      };

      /** 生效草稿：没有用户改动时一律从服务端状态派生。 */
      const draft = draftState ?? {
        enabled: view.enabled === true,
        mode: view.mode ?? "shadow",
        // 思考模式也走 draft：与其它控件一致，改完即自动落盘。
        thinkMode: view.thinkMode ?? "never",
        // 判断计数开关同样走 draft：status 旧版没有这个字段时按默认开处理
        //（与服务端 `cfg.judgementCount !== false` 的回显口径一致）。
        judgementCount: view.judgementCount !== false,
        // 模型一格一个 provider，键 = config.yml 字段名（见 rawModelsOf）。
        ...rawModelsOf(view),
      };
      // provider 草稿：与主配置分开保存，因为 custom 的字段是「先填后切」，
      // 混进主 draft 会让「只切 provider」也顺手把没填完的自定义地址写进去。
      // 模型不在这里——它跟模型行走，与 provider 切换同步刷新。
      const providerDraft = providerDraftState ?? {
        provider: view.provider ?? "bamboonode",
        customBaseUrl: view.customBaseUrl ?? "",
        customEndpointStyle: view.customEndpointStyle ?? "auto",
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
          thinkMode: next.thinkMode ?? "never",
          // 同 refresh() 的 setDraft：这一键漏了，保存成功后的回显就会回到 ON。
          judgementCount: next.judgementCount !== false,
          // 模型各 provider 一格：键就是 config.yml 里的字段名（rawModels
          // 下发），因此新增预设不必再改前端。切 provider 也不会把 A 的
          // 模型名带进 B 那一格。
          ...rawModelsOf(next),
        });
        setProviderDraft({
          provider: next.provider ?? "bamboonode",
          customBaseUrl: next.customBaseUrl ?? "",
          customEndpointStyle: next.customEndpointStyle ?? "auto",
          customHeaders: next.customHeaders ?? "",
          customApiKeyEnv: next.customApiKeyEnv ?? "",
        });
        setProviderError(next.providerValid === false ? next.providerError ?? "配置不可用" : "");
        dirtyRef.current = false;
      };

      // 每次渲染把「当前值」同步进 ref：控件在事件里读它，flush 也读它。
      // 放在渲染期赋值（而不是 useEffect）是必须的——useEffect 在提交之后才跑，
      // 而事件处理器可能在它之前就读到 ref，那样拿到的还是上一次的值。
      valuesRef.current = { draft, providerDraft, keyInputs, storageDraft, pointsDraft };

      /**
       * 自动保存引擎。
       *
       * 三个动作：
       *   - `scheduleSave(partial, immediate)`：控件改动后调用。先**同步**并入
       *     `valuesRef`，再按需立即（开关/下拉）或防抖（文本框）落盘。
       *   - `flush()`：真正发请求。串行、合并，按需分两次（`/config` + `/decisions`）。
       *   - `commitKey(provider)`：密钥的「明确提交」（失焦 / 回车）。
       *
       * 三条不变量（都是这个界面反复踩过的坑）：
       *
       *   1. 同一时刻只有一个请求在飞（`savingRef`）。期间的改动只并入
       *      `valuesRef`，等这次回来再发——并发保存会让两次快照互相覆盖。
       *   2. 响应回来时若用户又改过（`editSeqRef` 变了），**不覆盖草稿**，
       *      只刷新服务端状态。否则「保存中的输入被旧快照冲掉」= 回弹。
       *   3. 失败不丢输入、也不自动重试：原因写进状态行，等用户改或点重试。
       *      自动重试一个注定 400 的请求只会刷屏。
       */
      const flushRef = react.useRef(null);

      /** 同步记录一次改动，并安排落盘（`immediate` 用于离散控件）。 */
      const scheduleSave = (partial, immediate) => {
        valuesRef.current = { ...valuesRef.current, ...(partial ?? {}) };
        editSeqRef.current += 1;
        dirtyRef.current = true;
        // 防抖窗口里就先把状态改成「待保存」：否则这一小段时间还挂着上一次的
        // 「已保存」，用户会以为刚才那一下已经落盘了。
        setSaveState("pending");
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (immediate === true) {
          void flushRef.current();
          return;
        }
        // 文本框：停手 AUTOSAVE_DELAY_MS 之后再落盘，避免每敲一个字符一次请求。
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void flushRef.current();
        }, AUTOSAVE_DELAY_MS);
      };

      /**
       * 明确提交密钥（失焦 / 回车）。
       *
       * 密钥刻意**不**跟着防抖走：粘贴后停一下就把半截 key 写进凭据文件，
       * 是比多点一次更糟的体验。这里只记「这一次是用户按下提交」。
       */
      const commitKey = (provider) => {
        const raw = (valuesRef.current.keyInputs[provider] ?? "").trim();
        // 留空 = 不修改（与旧版一致）；太短的多半是没贴完，不落盘，给一句提示。
        if (raw.length === 0) return;
        if (raw.length < 10) {
          setSaveState({ error: "未保存：密钥太短（至少 10 个字符）" });
          return;
        }
        keyCommitRef.current = provider;
        editSeqRef.current += 1;
        dirtyRef.current = true;
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        void flushRef.current();
      };

      /**
       * 落盘一次。
       *
       * 决策点走独立的 `/decisions` 而不是复用 `/config`：那两份配置的校验规则
       * 不同（决策点要拒绝未实装的点），混在一起容易互相放宽。
       */
      const flush = async () => {
        if (savingRef.current === true) return;
        if (dirtyRef.current !== true) return;
        const values = valuesRef.current;
        const seq = editSeqRef.current;
        const keyCommit = keyCommitRef.current;
        const decisionsBody = pendingDecisions(values, decisions);
        // 打字途中的非法地址：整笔延后（服务端必然拒绝，那一次 400 只是噪音）。
        // 决策点与地址无关，仍然照常落盘——否则改个决策点也会被地址卡住。
        const urlProblem = customUrlProblem(
          values.providerDraft.customBaseUrl,
          values.providerDraft.provider,
        );
        // 服务端还没给出字段映射（配置页刚打开、status 尚未回来）。此时无法
        // 知道「模型与 key 该写进 config.yml 的哪一格」，猜一个名字就是把
        // siliconflow 的 key 写进 bamboonode 的格子——宁可延后并说明原因，
        // 也不能猜着写。状态回来后 dirty 仍为 true，改动会自动补发。
        const modelFields = providerFieldsOf(values.providerDraft.provider, view);
        // 密钥按提交时的 provider 取字段（见 configPatchOf 里的说明）。
        const keyFields =
          keyCommit === null || keyCommit === undefined
            ? null
            : providerFieldsOf(keyCommit, view);
        const mapProblem =
          modelFields === null || (keyCommit != null && keyFields === null)
            ? "配置尚未就绪（服务端未返回 provider 字段映射），请稍后重试"
            : "";
        const problem = urlProblem.length > 0 ? urlProblem : mapProblem;
        const configDeferred = problem.length > 0;
        if (configDeferred === true && decisionsBody === null) {
          setSaveState({ error: t("配置未保存：{problem}", { problem }) });
          return;
        }

        const patch =
          modelFields === null ? {} : configPatchOf(values, keyCommit, modelFields, keyFields);
        // 只要带了 key 就必须写配置：key 不能因为「其它字段没变」被漏掉。
        const keyWritten = keyFields !== null && Object.hasOwn(patch, keyFields.keyField);
        const configNeeded =
          configDeferred !== true
          && (keyWritten === true || patchDiffersFromServer(patch, view, modelFields) === true);

        savingRef.current = true;
        setSaveState("saving");
        setMsg(null);
        setProviderError("");
        /** 失败的到底是哪一半：只有配置那一半才该显示成「provider 配置不可用」。 */
        let failing = "config";
        try {
          if (configNeeded === true) {
            const next = await call("/config", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(patch),
            });
            // 用户又改过：只刷新服务端状态，草稿保留给下一次 flush。
            if (seq === editSeqRef.current) applyServerState(next);
            else setStatus(next);
          }
          failing = "decisions";
          if (decisionsBody !== null) {
            const next = await call("/decisions", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(decisionsBody),
            });
            setDecisions(next);
            // 期间又有改动时不清草稿：那些改动还没落盘，清掉就等于吞了。
            if (seq === editSeqRef.current) {
              setPointsDraft({});
            }
          }
          if (seq !== editSeqRef.current) {
            // 期间的改动由 finally 接着发，这里保持「保存中」。
            setSaveState("saving");
          } else if (configDeferred === true) {
            // 决策点存了，配置那一半还欠着（等地址补全或配置就绪）：**保持 dirty**，
            // 否则原因消失之后没人会再发请求，改动就悄悄丢了。
            dirtyRef.current = true;
            setSaveState({ error: t("配置未保存：{problem}", { problem }) });
          } else {
            dirtyRef.current = false;
            if (keyWritten === true) {
              keyCommitRef.current = null;
              // 存完就清空输入框：与旧版「粘贴 → 保存 → 框变空」一致，
              // 也让「已配置」的提示能立刻反映新值。
              setKeyInputs({ ...values.keyInputs, [keyCommit]: "" });
            }
            setSaveState("saved");
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          // 校验失败（非法 URL / 请求头格式）走这里：保留用户已填内容，
          // 只把原因显示出来——清空表单会让用户重填一遍。
          // dirty 保持 true：失败的那一半（可能是决策点）还没落盘，
          // 重试按钮与后续编辑都要能把它带上。
          dirtyRef.current = true;
          setSaveState({ error: text });
          if (failing === "config") setProviderError(text);
        } finally {
          savingRef.current = false;
          // 保存期间用户又改过：立刻再发一次，不等防抖（他已经停手了）。
          if (dirtyRef.current === true && seq !== editSeqRef.current) void flush();
        }
      };
      flushRef.current = flush;

      /** 状态行的「重试」：把上一次失败的值原样再发一遍。 */
      const retrySave = () => {
        dirtyRef.current = true;
        void flushRef.current();
      };

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
            text: result.ok === true
              ? t("端点连通 ✅\n{text}", { text: result.text ?? "" })
              : tr(result.text ?? "") || t("端点返回失败"),
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
       * 模型字段按 provider 分派：字段名叫什么由服务端下发（`modelField`），
       * 前端不再逐个 provider 写 if/else——否则新增预设就得同步改前端，
       * 漏改就是「A 的模型名写进了 B 的格子」。
       *
       *   bamboonode       -> model            （老版本唯一的模型键）
       *   systemone        -> systemoneModel
       *   siliconflow      -> siliconflowModel
       *   siliconflow-intl -> siliconflowIntlModel
       *   custom           -> customModel
       *
       * 各格分开存，切换 provider 才不会把 A 的模型名发给 B。
       */
      const activeFields = providerFieldsOf(providerDraft.provider, view);
      const modelField = activeFields?.modelField ?? "model";
      const modelValue = draft[modelField] ?? "";
      const setModelValue = (value) => {
        const next = { ...draft, [modelField]: value };
        setDraft(next);
        // 下拉是离散控件：选完即存。
        scheduleSave({ draft: next }, true);
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
       * 本地预校验：与服务端同规则（见模块级 `customUrlProblem`），
       * 只是为了让用户在落盘之前就看到问题。服务端仍会独立校验（前端校验不可信）。
       */
      const customUrlError = isCustom ? customUrlProblem(providerDraft.customBaseUrl, "custom") : "";

      /** provider 提示文案：优先用服务端下发的说明，避免前端另写一份。 */
      const providerHint =
        loading === true
          ? "正在读取服务端配置…"
          : activeProvider === null
            ? "服务端未返回 provider 列表；当前选择仍会生效"
            : isCustom
              ? "自定义决策服务：自建 llama.cpp / vLLM、企业网关或第三方中转"
              : activeProvider.hint ?? "";

      // 配置 tab 的全部内容。
      //
      // 它是一个**数组**而不是直接 return 出去的 children：顶层还要按当前
      // tab 在「配置」与「统计」之间二选一，把内容先攒成值才能分支渲染。
      const configBody = [
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
                // 下拉是离散控件：选完即存。切到 custom 但地址还没填时，
                // flush 会整笔延后并提示（见 flush 里的 urlProblem），
                // 地址补全后自动落盘，不需要再点一次。
                scheduleSave({ providerDraft: { ...providerDraft, provider: next } }, true);
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
            : "内置预设的默认地址（可用 config.yml 的 baseUrl 覆盖 bamboonode）",
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "3px", maxWidth: "320px" } },
            h(
              "span",
              { style: { ...S.v, fontSize: "11px", opacity: 0.75, wordBreak: "break-all" } },
              view.providerValid === false
                ? "配置不可用"
                : view.baseUrl || "(服务端未返回)",
            ),
            // 探测出的实际可用路径：路径后缀由服务商决定（实测 SiliconFlow
            // 只通 /systemone），必须让用户看见「最后打的是哪条」。
            typeof view.detectedEndpoint === "string" && view.detectedEndpoint.length > 0
              ? h(
                  "span",
                  { style: { ...S.v, fontSize: "11px", opacity: 0.85, color: "#7dd3a0" } },
                  t("已验证可用：{endpoint}", { endpoint: view.detectedEndpoint }),
                )
              : null,
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
            // 开关是离散控件：拨一下就落盘。
            scheduleSave({ draft: { ...draft, enabled: next } }, true);
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
            scheduleSave({ draft: { ...draft, mode: next } }, true);
          }),
          "mode",
        ),
        // 2.0) 判断计数开关（DEC-019）：关掉后每轮不再发布判断记录，
        // 消息尾部那个「N 次判断」也就消失（没有记录 → 组件渲染 null）。
        // 关闭意味着**零会话足迹**——连事件都不发，而不只是界面上藏起来。
        row(
          "判断计数",
          "开启后在每轮回复尾部显示本轮判断次数，点开看逐决策点分账；关闭则完全不留记录",
          toggle(draft.judgementCount !== false, () => {
            const next = draft.judgementCount === false;
            setDraft({ ...draft, judgementCount: next });
            // 开关是离散控件：拨一下就落盘。
            scheduleSave({ draft: { ...draft, judgementCount: next } }, true);
          }),
          "judgementCount",
        ),
        // 2.1) 思考模式：never 最省延迟，always 判断更充分但每次多等约 5s。
        // 这一项以前只能手改配置文件，界面没有入口（后端一直支持三档）。
        row(
          "思考模式",
          draft.thinkMode === "always"
            ? "总是思考：判断更充分，但每次工具调用约多等 5 秒"
            : draft.thinkMode === "auto"
              ? "仅在模型自己判断需要时思考（折中）"
              : "不思考：最快（约 1.9s），热路径首选",
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: draft.thinkMode ?? "never",
              disabled: busy !== "",
              onChange: (event) => {
                const next = { ...draft, thinkMode: event.target.value };
                setDraft(next);
                // 下拉是离散控件：选完即存。
                scheduleSave({ draft: next }, true);
              },
            },
            // 选项由服务端下发（thinkModes），前端不硬编码取值，避免漂移。
            ...(Array.isArray(view.thinkModes) && view.thinkModes.length > 0
              ? view.thinkModes
              : ["never", "auto", "always"]
            ).map((value) =>
              h(
                "option",
                { key: value, value },
                value === "never"
                  ? "never（不思考）"
                  : value === "auto"
                    ? "auto（按需思考）"
                    : "always（总是思考）",
              ),
            ),
          ),
          "thinkMode",
        ),
        // 3) 模型：下拉选择，含「留空」项
        // 每个 provider 用自己那一格（modelField 由服务端下发），分开存才能做到
        // 「切 provider 不覆盖其它 provider 已保存的模型」。
        //
        // 「留空」的含义由该端点的脾气决定：多数端点接受省略 model（服务端选
        // 默认）；而 SiliconFlow 的 /systemone 把 model 列为必填（实测省略回
        // 400 `Model field is required.`），留空时插件改用预设默认 Kev-4B。
        // 文案必须说清楚，否则用户会以为「留空 = 让服务端挑」。
        row(
          "模型",
          (activeFields?.requiresModel ?? false) === true
            ? t("该端点 model 必填；留空 = 用预设默认 {model}（可改填 SemIf）", { model: activeFields.defaultModel })
            : modelsState === "ok"
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
              (activeFields?.requiresModel ?? false) === true
                ? h("option", { value: "" }, t("默认（{model}）", { model: activeFields.defaultModel }))
                : h("option", { value: "" }, "自动（服务端默认）"),
              // 当前值不在列表里时也保留，避免下拉把已配置的值吞掉。
              ...((modelValue ?? "") === "" || models.some((item) => item.id === modelValue)
                ? []
                : [h("option", { value: modelValue, key: "current-model" }, t("{model}（当前值）", { model: modelValue }))]),
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
        // 4) API Key：每个 provider 一格，各自保存各自的 key。
        //    密钥**只**在失焦或回车时落盘（commitKey）：打字途中自动保存会把
        //    半截 key 写进凭据文件，比多一步确认更危险。
        row(
          "API Key" + (keyOk
            ? t("（已配置 {hint}）", { hint: activeKeyStatus?.hint ?? view.keyHint ?? "" })
            : t("（未配置）")),
          activeKeyStatus !== null
            ? storageValue === "config"
              // 存到配置文件时，目标是该 provider 的显式字段名（如
              // bamboonodeApiKey），而不是凭据变量名——两者是不同的位置，
              // 混着说会让人去 .credentials.yaml 里找 key。
              ? t("存到插件配置 config.yml 的 {field}（明文）", { field: activeKeyStatus.keyField || t("显式 key 字段") })
              : t("存到 .credentials.yaml 的 {ref}", { ref: activeKeyStatus.refName })
            : "留空则不修改；粘贴新 key 后失焦或回车即保存",
          h("input", {
            type: "password",
            style: S.input,
            placeholder: keyOk ? "sk-…（留空不改）" : "sk-…",
            value: keyInputs[providerDraft.provider] ?? "",
            onChange: (event) => {
              const next = { ...keyInputs, [providerDraft.provider]: event.target.value };
              setKeyInputs(next);
              // 同步进 ref：commitKey 读的是它。回车可能紧贴最后一次按键，
              // 等重绘就来不及了。
              valuesRef.current = { ...valuesRef.current, keyInputs: next };
            },
            // 密钥只在「明确提交」时落盘：失焦或回车。
            onBlur: () => commitKey(providerDraft.provider),
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              commitKey(providerDraft.provider);
            },
          }),
          "key",
        ),
        // 4.1) 密钥保存位置：默认托管到 .credentials.yaml
        row(
          "密钥保存位置",
          storageValue === "config"
            ? t("存进插件配置 config.yml 的 {field}（自包含，便于随目录备份；注意是明文）", { field: activeKeyStatus?.keyField || t("显式 key 字段") })
            : "存进 ~/.dsh/.credentials.yaml（默认，与其他服务统一托管）",
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: storageValue,
              disabled: busy !== "",
              onChange: (event) => {
                setStorageDraft(event.target.value);
                // 下拉是离散控件：选完即存。
                scheduleSave({ storageDraft: event.target.value }, true);
              },
            },
            h("option", { value: "credentials" }, ".credentials.yaml（默认）"),
            h("option", { value: "config" }, "插件配置 config.yml"),
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
                  : "任意提供决策端点的服务；末尾斜杠会自动规范化，端点段不会重复",
                h("input", {
                  type: "text",
                  style: {
                    ...S.input,
                    borderColor: customUrlError.length > 0 ? "rgba(248,113,113,.75)" : "rgba(128,128,128,.32)",
                  },
                  placeholder: "https://api.example.com/v1",
                  value: providerDraft.customBaseUrl ?? "",
                  onChange: (event) => {
                    const next = { ...providerDraft, customBaseUrl: event.target.value };
                    setProviderDraft(next);
                    setProviderError("");
                    // 文本框：停手防抖落盘（打字途中的非法地址会被 flush 整笔延后）。
                    scheduleSave({ providerDraft: next });
                  },
                  onBlur: () => scheduleSave(null, true),
                }),
                "custom-url",
              ),
              row(
                "端点风格",
                t("路径后缀由服务商决定（实测 SiliconFlow 只通 /systemone，bamboonode 两条都通）。这里是「首选」：若首选路径返回 404，插件会自动改用另一条再试一次"),
                h(
                  "select",
                  {
                    style: { ...S.input, minWidth: "150px", flex: "none" },
                    value: providerDraft.customEndpointStyle ?? "auto",
                    onChange: (event) => {
                      const next = { ...providerDraft, customEndpointStyle: event.target.value };
                      setProviderDraft(next);
                      // 下拉是离散控件：选完即存。
                      scheduleSave({ providerDraft: next }, true);
                    },
                  },
                  h("option", { value: "auto" }, "auto（先 /decisions）"),
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
                    const next = { ...providerDraft, customHeaders: event.target.value };
                    setProviderDraft(next);
                    scheduleSave({ providerDraft: next });
                  },
                  onBlur: () => scheduleSave(null, true),
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
                    const next = { ...providerDraft, customApiKeyEnv: event.target.value };
                    setProviderDraft(next);
                    scheduleSave({ providerDraft: next });
                  },
                  onBlur: () => scheduleSave(null, true),
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
                // 点完即存：这个角标只在「请求还在路上」的那一小会儿出现。
                const changed = Object.hasOwn(pointsDraft, point.id) && pointsDraft[point.id] !== point.mode;
                const st = point.stats ?? {};
                // 「可用」与「已挂载」是两件事：点已实装（available），但宿主
                // 缺少它依赖的服务时挂载会失败（mounted=false）。两者都真才能切。
                const dim = point.available !== true || point.mounted === false;
                const meta =
                  `${point.hook} · ${point.trigger}` +
                  (st.requests
                    ? t(" · 已判 {requests} 次，缓存 {cached}，{tokens} token，均 {latency}ms", {
                        requests: st.requests,
                        cached: st.cached,
                        tokens: st.tokens,
                        latency: st.avgLatencyMs,
                      })
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
                      : h("div", { style: S.pointHint }, t("触发闸：{gate}", { gate: point.gate })),
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
                              onClick: () => {
                                const next = { ...pointsDraft, [point.id]: mode };
                                setPointsDraft(next);
                                // 三态分段是离散控件：点一下就落盘。
                                scheduleSave({ pointsDraft: next }, true);
                              },
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
                  changed ? h("span", { style: { ...S.badge, borderStyle: "solid", opacity: 0.9 } }, "保存中") : null,
                );
              }),
              // 缓存命中：0 命中说明白名单外的调用每次都真发请求，是主要浪费。
              // 只展示精确命中——「同类复用」软层已改为显式启用（默认关闭，
              // 授权点永久禁用），命中率里若含软层命中，通常是某个点显式开了。
              h(
                "div",
                { style: S.pointMeta, key: "cache" },
                t("缓存 {size} 条 · 精确命中 {hits} · 命中率 {rate}%", {
                  size: decisions.cache?.size ?? 0,
                  hits: decisions.cache?.exactHits ?? 0,
                  rate: Math.round((decisions.cache?.hitRate ?? 0) * 100),
                }),
              ),
            ),
        // 4) 自动保存状态行：**没有「保存」按钮**，改动即落盘。
        //    这一行回答的是「刚才那一下到底存没存」：进行中 / 已存 /
        //    失败原因（附重试）。原来那个按钮的「保存中…」搬到这里。
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center", margin: "14px 0 4px" }, key: "actions" },
          // 常驻说明：让第一次进来的人知道不需要找保存按钮。
          h(
            "span",
            { style: { ...S.meta, marginTop: 0, flex: 1, opacity: 0.55 } },
            saveState === "pending"
              ? "待保存…"
              : saveState === "saving"
                ? "保存中…"
                : saveState === "saved"
                  ? "已保存（改动即生效，无需点保存）"
                  : saveState !== null && typeof saveState === "object" && typeof saveState.error === "string"
                    ? null
                    : "改动即保存",
          ),
          // 失败：原因直接给出来，另配「重试」——不能让用户只看到「保存失败」
          // 而不知道该改什么、能不能再试一次。
          saveState !== null && typeof saveState === "object" && typeof saveState.error === "string"
            ? h(
                "span",
                {
                  style: {
                    ...S.meta,
                    marginTop: 0,
                    flex: 1,
                    color: "#f87171",
                    opacity: 1,
                  },
                },
                // `saveState.error` 已经是**完整的句子**（写入 state 时就带上了
                // 「未保存：」前缀，且可能已由 t() 译好）。这里只翻译它、不再套
                // 前缀，否则会得到「Not saved: 未保存：…」这种重复。
                tr(saveState.error),
              )
            : null,
          saveState !== null && typeof saveState === "object" && typeof saveState.error === "string"
            ? h(
                "button",
                {
                  type: "button",
                  disabled: busy !== "",
                  onClick: retrySave,
                  style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
                },
                "重试",
              )
            : null,
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
          t("提供方 {provider} · 端点 {endpoint}", {
            provider: view.providerLabel ?? view.provider ?? "-",
            endpoint: view.baseUrl || t("（未配置）"),
          }),
          h("br", null),
          t("模型 {model} · 超时 {timeout}ms · 请求 {requests} 次（缓存 {cached}）", {
            model: view.model || t("(服务端默认)"),
            timeout: view.timeoutMs,
            requests: view.stats?.requests ?? 0,
            cached: view.stats?.cached ?? 0,
          }),
          // 密钥来源一律取「当前 provider 自己那一条」：用顶层 keyEnvName 会
          // 在切换后短暂显示上一家的名字（服务端字段与本地选择不同步时）。
          //
          // 显示的是**真实命中的来源**（sourceLabel，服务端算好），而不是
          // `apiKeyEnv`。后者只是「若走凭据文件时该查哪个变量名」，
          // 在 keyStorage=config 时根本没被读取——照它显示会让人以为
          // key 存在 .credentials.yaml 里，甚至误判它过期了。
          activeKeyStatus !== null ? h("br", null) : null,
          activeKeyStatus !== null
            ? t("密钥来源 {source}", {
                source: activeKeyStatus.sourceLabel ?? activeKeyStatus.refName ?? t("未知"),
              }) + (activeKeyStatus.configured === true ? "" : t("（未读到）"))
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
      ];

      /** 决策点 id → 中文名：统计页的分账表用它，取不到就退回显示 id。 */
      const pointLabels = {};
      for (const point of decisions?.points ?? []) {
        if (typeof point?.id === "string") pointLabels[point.id] = point.label ?? point.id;
      }

      /**
       * provider id → 展示名。
       *
       * 数据来自服务端下发的 providerCatalog（`siliconflow` 显示成「硅基流动」）。
       * 统计页按 provider 分组，只显示裸 id 会让用户对着 `siliconflow-intl`
       * 想这是哪家；而前端自己抄一份名字表，就会和服务端的名字漂移。
       */
      const providerLabels = {};
      for (const item of catalog) {
        if (typeof item?.id === "string") providerLabels[item.id] = item.label ?? item.id;
      }

      /**
       * 项目主页链接：放在 tab 栏**上面**。
       *
       * 为什么在 tab 上面而不是配置页表单的最上面：它是**页面级**入口，
       * 和 tab 栏同属页面头部，不该只属于「配置」这一个 tab。放在上面，
       * 切到「统计与对比」时链接依然在——文档在哪是整个面板的事，
       * 不是某一页的事。
       */
      const siteLink = h(
        "a",
        {
          key: "site-link",
          href: SITE_URL,
          // 站外链接：新标签页打开，并断开 opener（避免目标页反向操纵本页）。
          target: "_blank",
          rel: "noreferrer noopener",
          title: SITE_URL,
          style: S.siteLink,
        },
        "项目主页 ↗",
      );

      /**
       * 顶层两个 tab：配置 / 统计。
       *
       * 统计不再挤在配置页末尾当一小块——它有自己的整页空间，因为
       * 「钱花在哪、比不开省了多少」是要认真看的，不是顺手扫一眼的。
       * 配置页的表单本来就长，再挂一张十列的表只会让两边都难用。
       */
      const tabBar = h(
        "div",
        { style: S.tabBar, key: "tabs" },
        ...[
          { id: "config", label: "配置" },
          { id: "stats", label: "统计与对比" },
        ].map((item) =>
          h(
            "button",
            {
              type: "button",
              key: item.id,
              onClick: () => setTab(item.id),
              style: S.tab(tab === item.id),
            },
            item.label,
          ),
        ),
      );

      // 统计页更宽：对比表有十来列，配置页那个 620px 的容器放不下。
      return h(
        "div",
        { style: tab === "stats" ? S.statsWrap : S.wrap },
        siteLink,
        tabBar,
        tab === "stats"
          ? renderStatsTab({
              stats,
              error: statsError,
              filter: statsFilter,
              setFilter: setStatsFilter,
              reload: () => void loadStats(statsFilter),
              pointLabels,
              providerLabels,
              meta: statsMeta,
            })
          : configBody,
      );
    }

    // ---------------------------------------------------------------- 错误尾部
    //
    // 把决策引擎的降级/异常显示在**对应那条消息的尾部**，就像内置的
    // token 统计那样。
    //
    // 链路（与 DSH 自带的 llm/retry 完全同构）：
    //
    //   宿主 session.append("decision-engine/error", {turn, …})
    //     → 本插件的 conversation Definition 按事件类型匹配、折叠成轮次数据
    //       → conversation.chat.turnTail 槽位用 owner.turn.data 读回本轮数据
    //
    // 之所以走会话事件而不是轮询 HTTP 接口：只有会话事件带 turn，
    // 前端才知道该把错误挂在哪条消息下面（详见 lib/client-errors.js）。
    //
    // 注意：下面这份逻辑与 lib/client-errors.js 是**两份**——客户端 bundle
    // 是独立的加载单元（window.__ModuleLoader__），它的 require() 只能拿到
    // 已注册的模块（react 等），拿不到同目录的兄弟文件。改一处就要改另一处，
    // test/client-errors.test.js 会盯着两份是否一致。

    /**
     * 本插件发布到会话的错误事件类型（必须与宿主 lib/publish.js 一致）。
     *
     * `plugin:` 前缀是宿主的插件记录语法：这类事件自带 `ignorable` 标记，
     * 不认识它的旧版 DSH 会保留并跳过，而不是拒绝打开会话。
     */
    const ERROR_EVENT_TYPE = "plugin:decision-engine/error";

    /** 轮次数据的键名（必须与 Definition 的 key 一致）。 */
    const TURN_DATA_KEY = "decision-engine-error";

    /** 错误分类 → 中文名（与宿主 lib/errors.js 的 ERROR_LABELS 一致）。 */
    const ERROR_LABELS = {
      "invalid-base-url": "地址不合法",
      "no-key": "未配置 API key",
      cooldown: "端点连续失败，已进入冷却",
      timeout: "决策请求超时",
      "network-error": "无法连接决策端点",
      "auth-failed": "鉴权被拒",
      "rate-limited": "触发限流",
      "http-error": "端点返回错误状态",
      "invalid-json": "响应不是合法 JSON",
      "invalid-response": "响应格式不对",
      "missing-answers": "响应缺少 answers 字段",
      "answer-shape-mismatch": "答案形状与预期不符",
      "adapter-error": "适配器异常（已忽略）",
      "caller-aborted": "调用被取消",
    };

    /** 决策点 id → 中文名（用于「哪个点坏了」）。 */
    const POINT_LABELS = {
      authorize: "工具授权",
      route: "模型路由",
      delegate: "子任务分派",
      compact: "上下文压缩",
      turnStop: "轮次延续",
      retrieval: "检索必要性",
      skillPick: "技能选择",
      cotTranslate: "思维链翻译",
      unknown: "决策引擎",
    };

    /**
     * 渲染边界翻译决策点名（EN_CONFIG 里有对应词条）。
     *
     * 浮层的行名直接写中文 label（DEC-018：中文是源语言），在 `h()` 的渲染
     * 边界统一换成当前语言。不查 `POINT_LABELS_EN`：那两份表是给测试与错误
     * 尾部对照用的，真正的翻译入口只有这一个。
     *
     * @param {string} point - 决策点 id。
     * @returns 决策点中文名；没有登记的 id 原样返回（不猜）。
     */
    function pointLabel(point) {
      return tr(POINT_LABELS[point] ?? point);
    }

    /**
     * 把一条宿主事件归一化成可展示的错误。
     *
     * @param {object} event - 会话事件。
     * @returns 归一化后的错误，或 null（这条不是错误事件）。
     */
    function errorFromEvent(event) {
      if (event === null || typeof event !== "object") return null;
      if (event.type !== ERROR_EVENT_TYPE) return null;
      const data = event.data;
      if (data === null || typeof data !== "object") return null;
      const turn = data.turn;
      if (!Number.isSafeInteger(turn) || turn < 0) return null;
      const code = typeof data.code === "string" && ERROR_LABELS[data.code] !== undefined
        ? data.code
        : "adapter-error";
      return {
        turn,
        point: typeof data.point === "string" ? data.point : "unknown",
        code,
        label: ERROR_LABELS[code],
        ...(typeof data.detail === "string" && data.detail.length > 0 ? { detail: data.detail } : {}),
        ...(typeof data.hint === "string" && data.hint.length > 0 ? { hint: data.hint } : {}),
        ...(typeof data.tool === "string" && data.tool.length > 0 ? { tool: data.tool } : {}),
      };
    }

    /**
     * conversation Definition：把错误事件折叠成「这一轮的错误」。
     *
     * `id` 用轮次号——同一轮里的多条错误要折进**同一个**上下文，
     * 否则每条错误各成一轮，界面上会出现一串重复卡片。
     *
     * @returns Definition 对象（传给 `ctx.uiConversation.events.register`）。
     */
    function createErrorDefinition() {
      return {
        kind: TURN_DATA_KEY,
        target: "chat",
        /**
         * 匹配错误事件与轮次起点。
         *
         * `id` 用轮次号——同一轮里的多条错误要折进**同一个**上下文，
         * 否则每条错误各成一轮，界面上会出现一串重复卡片。
         *
         * `turn/start` 必须匹配为 `start` 角色：对话层要求每个上下文先有
         * 一个 start 匹配，之后才能收 update 匹配——只匹配错误事件
         * （全是 update）会撞上「received an update before its start Match」。
         */
        match: (event) => {
          if (event.type === "turn/start") {
            const turn = event.data?.turn;
            if (!Number.isSafeInteger(turn) || turn < 0) return null;
            return { id: String(turn), role: "start" };
          }
          const error = errorFromEvent(event);
          if (error === null) return null;
          return { id: String(error.turn), role: "update" };
        },
        // 以 turn/start 为起点：轮次号从那时起才有意义。
        start: (_context, match) => {
          const turn = Number(match.id);
          return { turn: Number.isSafeInteger(turn) ? turn : 0, errors: [] };
        },
        // 同一轮同一分类只留一条（保留最后一条的说明）——一轮里若多个决策点
        // 连续降级，逐条渲染会在消息尾部堆出四五行几乎一样的红字。
        update: (context, match) => {
          const error = errorFromEvent(match.event);
          if (error === null) return context.state;
          const errors = context.state.errors.filter((candidate) => candidate.code !== error.code);
          errors.push(error);
          return { ...context.state, errors };
        },
        // 把这一轮的错误发布成轮次数据，供 turnTail 读取。
        // previous 不变时原样返回——宿主靠引用相等判断「没变」。
        buildLocationData: (context, scope, previous) => {
          if (scope !== "turn" || context.state === undefined) return null;
          const errors = context.state.errors;
          if (
            previous?.kind === "turn" &&
            previous.turn === context.state.turn &&
            previous.key === TURN_DATA_KEY &&
            previous.value.errors === errors
          ) {
            return previous;
          }
          return {
            kind: "turn",
            turn: context.state.turn,
            key: TURN_DATA_KEY,
            value: { errors },
          };
        },
      };
    }

    /**
     * 从 turnTail 的 owner 里取出「这一轮的错误」。
     *
     * 读的是**值**而不是包装——宿主的 `MutableLocationDataStore.get` 返回
     * `entries.get(key)?.value`，`data` 就是值本身（详见 judgementsOfTurn
     * 的注释与 lib/client-errors.js 的同名函数）。
     */
    function errorsOfTurn(owner) {
      const value = owner?.turn?.data?.get?.(TURN_DATA_KEY);
      // 值本身就是 {errors}；兼容一层包装不算错，但也不能只认包装。
      const errors = Array.isArray(value?.errors) ? value.errors : value?.value?.errors;
      return Array.isArray(errors) ? errors : [];
    }

    /** 错误尾部的样式：低调、紧凑，不抢消息正文的注意力。 */
    const ES = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        margin: "6px 0 2px",
        fontSize: "12px",
        lineHeight: 1.5,
      },
      row: {
        display: "flex",
        alignItems: "baseline",
        gap: "6px",
        color: "var(--dsw-alias-state-error-primary, #e06c6c)",
        wordBreak: "break-word",
      },
      badge: {
        flexShrink: 0,
        padding: "0 5px",
        borderRadius: "4px",
        border: "1px solid currentColor",
        fontSize: "10px",
        opacity: 0.85,
        whiteSpace: "nowrap",
      },
      point: { fontWeight: 500, whiteSpace: "nowrap" },
      label: { whiteSpace: "nowrap" },
      detail: { opacity: 0.75 },
      hint: { opacity: 0.65, fontStyle: "italic" },
    };

    /**
     * 渲染这一轮的错误。
     *
     * 没有错误时返回 null——槽位的约定是「没有内容就不占位」，
     * 所以正常的轮次完全看不到这一段。
     *
     * @param props - turnTail 槽位给的 owner（含 turn / seq / openFile）。
     * @returns 错误行；无错误时 null。
     */
    function DecisionErrorTail(props) {
      // 钩子必须在任何 early return 之前：本组件在「这一轮没有错误」时返回
      // null，钩子写在 return 之后会让 React 报「渲染的 hook 数量变少」。
      useLang();
      const errors = errorsOfTurn(props);
      if (errors.length === 0) return null;
      return h(
        "div",
        { style: ES.root, "data-decision-engine-errors": true },
        errors.map((error) =>
          h(
            "div",
            { key: `${error.code}-${error.point}`, style: ES.row, title: error.hint ?? error.detail ?? "" },
            h("span", { style: ES.badge }, "决策"),
            h("span", { style: ES.point }, POINT_LABELS[error.point] ?? error.point),
            h("span", { style: ES.label }, error.label),
            error.detail !== undefined && error.detail !== error.label
              ? h("span", { style: ES.detail }, t("（{detail}）", { detail: error.detail }))
              : null,
            error.tool !== undefined ? h("span", { style: ES.detail }, t("· {tool}", { tool: error.tool })) : null,
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- 判断计数
    //
    // 与上面错误尾部**同一条链路、同一个槽位**，只是 id 不同：
    //
    //   宿主 session.append("decision-engine/judgement", {turn, point, mode, action})
    //     → 另一个 conversation Definition 折成轮次数据
    //       → conversation.chat.turnTail 的第二个格子渲染「N 次判断」
    //
    // 两者刻意**不合并**：错误是例外（一次降级就该让人去修），判断计数是
    // 常态（一轮里判断十次完全正常）。塞进同一个格子，要么把十次正常判断
    // 渲染成十条红字，要么为了不吵而把降级也一起藏掉。
    //
    // 同样的两份实现问题：下面这份逻辑与 lib/client-judgements.js 是**两份**，
    // 客户端 bundle 拿不到兄弟文件，改一处就要改另一处，
    // test/judgement-ui.test.js 会盯着两份是否一致。

    /** 本插件发布到会话的判断事件类型（必须与 lib/judgements.js 一致）。 */
    const JUDGEMENT_EVENT_TYPE = "plugin:decision-engine/judgement";

    /** 轮次数据的键名（必须与下面 Definition 的 key 一致）。 */
    const JUDGEMENT_DATA_KEY = "decision-engine-judgement";

    /**
     * （决策点, 裁决词）→ 裁决结果。
     *
     * 与 lib/outcomes.js 的 OUTCOME_MATRIX 逐字一致（一致性测试盯着）。
     * 按 **（point, kind）** 而不是只按 kind：同一个词在不同点上含义相反——
     * `retrieval.skip` 真的拦下了一次检索，`cotTranslate.skip` 只是没翻译
     * 一句话。混在一起算「拦截次数」，得到的数字没有意义。
     */
    const VERDICT_MATRIX = {
      authorize: { delegate: "allow", ask: "ask", deny: "reject" },
      route: { keep: "allow", switch: "allow" },
      delegate: { inline: "allow", advise: "allow" },
      compact: { summarize: "allow", prune: "allow" },
      turnStop: { continue: "allow", stop: "allow" },
      retrieval: { allow: "allow", skip: "reject" },
      skillPick: { allow: "allow", redirect: "reject" },
      cotTranslate: { translate: "allow", skip: "allow" },
    };

    /** unknown point 的老记录兜底（与 LEGACY_UNKNOWN_POINT_OUTCOMES 一致）。 */
    const LEGACY_UNKNOWN_POINT_VERDICTS = { delegate: "allow", ask: "ask", deny: "reject" };

    /**
     * 决策点的**显示顺序**（与 lib/decision-points.js 的 DECISION_POINTS 一致）。
     *
     * 浮层里的行按这个固定顺序排，而不是按出现顺序：出现顺序随这一轮先碰到
     * 哪个决策点而变，同一份数据在两轮之间跳来跳去，用户没法形成肌肉记忆。
     */
    const POINT_ORDER = [
      "authorize",
      "route",
      "delegate",
      "compact",
      "turnStop",
      "retrieval",
      "skillPick",
      "cotTranslate",
    ];

    /**
     * 把一条宿主事件归一化成一条判断记录。
     *
     * 事件有两种形状（二选一）：裁决 `{turn, point, mode, action}`、
     * 降级 `{turn, point, mode, degraded}`。两种都收——降级不是判断，但要进
     * 降级桶（理由见文件顶部那段）。
     *
     * 归一化失败一律返回 null：**不猜**。一条看不懂的记录挂到界面上会变成
     * 一个来源不明的数字；丢掉它，最坏的结果只是数字偏小。
     */
    function judgementFromEvent(event) {
      if (event === null || typeof event !== "object") return null;
      if (event.type !== JUDGEMENT_EVENT_TYPE) return null;
      const data = event.data;
      if (data === null || typeof data !== "object") return null;
      const turn = data.turn;
      if (!Number.isSafeInteger(turn) || turn < 0) return null;
      const point = typeof data.point === "string" && data.point.length > 0 ? data.point : "unknown";
      // 模式只认 observe / enforce。没写模式按 observe 处理：那是「记录了但
      // 没管控」的默认语义，比丢掉整条记录更接近事实。
      const mode = data.mode === "enforce" ? "enforce" : "observe";
      const at = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined;
      const action = typeof data.action === "string" && data.action.length > 0 ? data.action : undefined;
      const degraded = typeof data.degraded === "string" && data.degraded.length > 0 ? data.degraded : undefined;
      // 既没有裁决词也没有降级原因：这条记录什么都没说，丢掉。
      if (action === undefined && degraded === undefined) return null;
      return {
        turn,
        point,
        mode,
        ...(action !== undefined ? { action } : {}),
        ...(degraded !== undefined ? { degraded } : {}),
        ...(at !== undefined ? { at } : {}),
      };
    }

    /** 查一条记录的裁决分类；查不到返回 "none"（不猜）。 */
    function verdictOf(point, kind) {
      if (typeof point !== "string" || typeof kind !== "string" || kind.length === 0) return "none";
      const bucket = VERDICT_MATRIX[point];
      if (bucket !== undefined) {
        const verdict = bucket[kind];
        if (verdict === "allow" || verdict === "ask" || verdict === "reject") return verdict;
        return "none";
      }
      if (point === "unknown") {
        const fallback = LEGACY_UNKNOWN_POINT_VERDICTS[kind];
        if (fallback === "allow" || fallback === "ask" || fallback === "reject") return fallback;
      }
      return "none";
    }

    /**
     * 把一轮的记录折叠成浮层要显示的那几行。
     *
     * 按决策点聚合，而不是逐个事件列：用户点开「3 次判断」想问的是「这 3 次
     * 花在哪些决策点上」。同一决策点在一轮里被问十次完全正常，那十行会把
     * 真正的信息（哪个点最活跃）淹没掉。
     *
     * `total` **只数判决、不数降级**：降级没有产生任何结论，混进去会让这个
     * 数字随网络抖动忽大忽小，而用户正是拿它跟「决策引擎有没有在工作」对照。
     */
    function summarizeTurn(entries) {
      const list = Array.isArray(entries) ? entries : [];
      const buckets = new Map();
      let total = 0;
      let firstAt;
      let lastAt;
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const point = typeof entry.point === "string" && entry.point.length > 0 ? entry.point : "unknown";
        // 先判「这条对界面有没有贡献」：既没有裁决词也没有降级原因的记录
        // 什么都数不出来，给它建一行只会显示「判断 0」——那一行是噪音。
        const contributes =
          (typeof entry.degraded === "string" && entry.degraded.length > 0) ||
          (typeof entry.action === "string" && entry.action.length > 0);
        if (!contributes) continue;
        let row = buckets.get(point);
        if (row === undefined) {
          row = {
            point,
            judged: 0,
            observe: 0,
            enforce: 0,
            allow: 0,
            ask: 0,
            reject: 0,
            degraded: 0,
            degradedReasons: [],
          };
          buckets.set(point, row);
        }
        const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : undefined;
        if (at !== undefined) {
          if (firstAt === undefined || at < firstAt) firstAt = at;
          if (lastAt === undefined || at > lastAt) lastAt = at;
        }
        const degraded = typeof entry.degraded === "string" && entry.degraded.length > 0 ? entry.degraded : undefined;
        if (degraded !== undefined) {
          row.degraded += 1;
          // 同一个原因重复出现只留一条：一轮里连续三次超时，浮层里应是
          // 「降级 3（超时）」而不是「超时 超时 超时」。
          if (!row.degradedReasons.includes(degraded)) row.degradedReasons.push(degraded);
          continue;
        }
        const action = typeof entry.action === "string" && entry.action.length > 0 ? entry.action : undefined;
        if (action === undefined) continue;
        row.judged += 1;
        total += 1;
        if (entry.mode === "enforce") row.enforce += 1;
        else row.observe += 1;
        const verdict = verdictOf(point, action);
        if (verdict === "allow" || verdict === "ask" || verdict === "reject") row[verdict] += 1;
      }
      const rows = [];
      for (const point of POINT_ORDER) {
        const row = buckets.get(point);
        if (row !== undefined) rows.push(row);
        buckets.delete(point);
      }
      // 没登记的点（含 unknown）排在最后。
      for (const row of buckets.values()) rows.push(row);
      return {
        total,
        ...(firstAt !== undefined ? { firstAt } : {}),
        ...(lastAt !== undefined ? { lastAt } : {}),
        rows,
      };
    }

    /**
     * conversation Definition：把判断事件折叠成「这一轮的判断」。
     *
     * 理由与错误那条完全一样（见 lib/client-errors.js）：Definition 是对话层
     * 官方的扩展位，它维护每个轮次的上下文并发布轮次数据。自己订阅会话事件
     * 再自己归位，就得重做一遍「事件属于哪一轮」的判断——那个判断错了，
     * 判断数就会挂到别人的消息下面。
     */
    function createJudgementDefinition() {
      return {
        kind: JUDGEMENT_DATA_KEY,
        target: "chat",
        /**
         * 匹配判断事件与轮次起点。
         *
         * `turn/start` 必须是 `start` 角色——对话层要求每个上下文先有一个
         * start 匹配，之后才收 update 匹配。
         */
        match: (event) => {
          if (event === null || typeof event !== "object") return null;
          if (event.type === "turn/start") {
            const turn = event.data?.turn;
            if (!Number.isSafeInteger(turn) || turn < 0) return null;
            return { id: String(turn), role: "start" };
          }
          const judgement = judgementFromEvent(event);
          if (judgement === null) return null;
          return { id: String(judgement.turn), role: "update" };
        },
        // 以 turn/start 为起点：轮次号从那时起才有意义。
        start: (_context, match) => {
          const turn = Number(match.id);
          return { turn: Number.isSafeInteger(turn) ? turn : 0, entries: [] };
        },
        // 同一轮的记录**全部**累加（与错误不同，不去重）：计数要的就是次数。
        update: (context, match) => {
          const judgement = judgementFromEvent(match.event);
          if (judgement === null || context.state === undefined) return context.state;
          const entry = { point: judgement.point, mode: judgement.mode };
          if (judgement.action !== undefined) entry.action = judgement.action;
          if (judgement.degraded !== undefined) entry.degraded = judgement.degraded;
          if (judgement.at !== undefined) entry.at = judgement.at;
          return { ...context.state, entries: [...context.state.entries, entry] };
        },
        // 发布成轮次数据，供 turnTail 读取。previous 不变时原样返回——
        // 宿主靠引用相等判断「没变」，每次都造新对象会让界面白白重渲染。
        buildLocationData: (context, scope, previous) => {
          if (scope !== "turn" || context.state === undefined) return null;
          const entries = context.state.entries;
          if (
            previous?.kind === "turn" &&
            previous.turn === context.state.turn &&
            previous.key === JUDGEMENT_DATA_KEY &&
            previous.value.entries === entries
          ) {
            return previous;
          }
          const summary = summarizeTurn(entries);
          return {
            kind: "turn",
            turn: context.state.turn,
            key: JUDGEMENT_DATA_KEY,
            value: {
              turn: context.state.turn,
              entries,
              ...(summary.firstAt !== undefined ? { firstAt: summary.firstAt } : {}),
              ...(summary.lastAt !== undefined ? { lastAt: summary.lastAt } : {}),
            },
          };
        },
      };
    }

    /**
     * 从 turnTail 的 owner 里取出「这一轮的判断记录」。
     *
     * ## 读的是**值**，不是包装（2026-11-02 修）
     *
     * 宿主的轮次数据存取口（`MutableLocationDataStore.get`）返回的是
     * **发布出去的那个值本身**，不是 `{kind, turn, key, value}` 这层包装：
     *
     *   get(key) { return this.entries.get(key)?.value; }
     *
     * 宿主自己的消费者就是这么读的（`turn.data.get("turn-tail")?.closing`，
     * closing 是值里的字段）。按包装读会让 `data` **就是**值、`.value`
     * 为 undefined，于是记录恒为空——计数器在界面上永远不出现。
     *
     * 发布侧是对的：`buildLocationData` 必须返回 `{kind, turn, key, value}`
     * （宿主校验 `key === context.kind`），错的只是读法。
     */
    function judgementsOfTurn(owner) {
      const value = owner?.turn?.data?.get?.(JUDGEMENT_DATA_KEY);
      // 值本身就是 {entries}；兼容一层包装不算错，但也不能只认包装。
      const entries = Array.isArray(value?.entries) ? value.entries : value?.value?.entries;
      return Array.isArray(entries) ? entries : [];
    }

    /** 判断浮层的样式：与宿主的 token 统计浮层同一套视觉语言。 */
    const JS = {
      row: { display: "flex", alignItems: "baseline", gap: "6px", margin: "2px 0 0" },
      trigger: {
        padding: 0,
        border: "none",
        background: "none",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        lineHeight: 1.5,
        opacity: 0.6,
        cursor: "pointer",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
      },
      // 遮罩：铺满视口，点它关闭。z-index 1100 与宿主菜单 / toast /
      // 它自己的统计浮层同一层——不用 retrace 那种 140（会被菜单盖住）
      // 或 2147483001（逃出整个层级，与宿主模态互相压）。
      scrim: {
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.32))",
      },
      panel: {
        position: "relative",
        zIndex: 1100,
        boxSizing: "border-box",
        minWidth: "260px",
        maxWidth: "min(440px, 100vw - 24px)",
        padding: "14px 16px",
        borderRadius: "var(--dsw-radius-lg, 10px)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))",
        background: "var(--dsw-specific-menu, rgba(30,30,34,.96))",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.32))",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontSize: "12px",
        lineHeight: 1.6,
        cursor: "default",
      },
      header: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "16px",
        marginBottom: "8px",
        color: "var(--dsw-alias-label-primary, inherit)",
        fontWeight: 500,
      },
      range: { fontWeight: 400, opacity: 0.6 },
      table: { display: "grid", gridTemplateColumns: "minmax(84px, auto) minmax(0, 1fr)", gap: "4px 14px", margin: 0 },
      name: { whiteSpace: "nowrap" },
      counts: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
      close: {
        position: "absolute",
        top: "6px",
        right: "8px",
        padding: "0 4px",
        border: "none",
        background: "none",
        color: "inherit",
        fontSize: "14px",
        lineHeight: 1,
        opacity: 0.55,
        cursor: "pointer",
      },
    };

    /**
     * 把毫秒时间格式化成 `HH:MM`。
     *
     * 不用 `toLocaleTimeString()`：它的格式随运行环境 locale 变（Node 与
     * Electron 的默认 locale 未必一致），而浮层里这段只是「这一轮大致发生在
     * 什么时间段」，精度到分钟足够。
     */
    function clockOf(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "";
      const date = new Date(value);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 一行「判断 3 · 观察 1 / 生效 2 · 放行 2 / 拦截 1」这类分账。 */
    function judgementBreakdown(row, t) {
      const parts = [`${t("judgement.countShort", { n: row.judged })}`];
      if (row.observe > 0) parts.push(`${t("judgement.observe")} ${row.observe}`);
      if (row.enforce > 0) parts.push(`${t("judgement.enforce")} ${row.enforce}`);
      if (row.allow > 0) parts.push(`${t("judgement.allow")} ${row.allow}`);
      if (row.ask > 0) parts.push(`${t("judgement.ask")} ${row.ask}`);
      if (row.reject > 0) parts.push(`${t("judgement.reject")} ${row.reject}`);
      if (row.degraded > 0) {
        const reasons = row.degradedReasons.length > 0 ? `（${row.degradedReasons.join("、")}）` : "";
        parts.push(`${t("judgement.degraded")} ${row.degraded}${reasons}`);
      }
      return parts.join(" · ");
    }

    /**
     * 判断浮层：**只看这一轮**。
     *
     * 为什么自己画一个 portal 浮层，而不是用宿主那个 `Modal`：
     * `Modal` 是居中全屏遮罩（宽度还固定 380px），而这里要的是「点一下小字、
     * 在附近弹出一张小卡片」——宿主自己的 token 统计浮层正是这么做的
     * （`useAnchoredPosition` + `createPortal` + z-index 1100）。跟着宿主在
     * 同一位置用同一种形态，用户学一次就够了。
     *
     * 关闭有三条路：点遮罩、按 Esc、点右上角 × —— 与宿主统计浮层一致。
     *
     * 关闭有三条路：点遮罩、按 Esc、点右上角 ×。
     *
     * Esc 用 `document.addEventListener("keydown")` 而不是 React 的 `onKeyDown`：
     * 卡片挂在 `document.body` 上（portal），键盘事件要从 document 这一层收，
     * 依赖 React 的事件冒泡会漏掉焦点不在卡片内的情形。宿主自己的统计浮层
     * 与 dsh-retrace 的确认框都是这么做的。
     *
     * 为什么用它而不用宿主的 `useModalLayer`（`Modal` 内部那个焦点/Esc 引擎）：
     * 那个引擎会把浮层登记进宿主的模态栈，随后宿主任何模态（设置、确认框）
     * 打开时都会先关它——可我们的卡片是**非模态**的注解，用户正应该能点开
     * 别的东西而不丢掉这张卡片。自己收 Esc 就没有这个副作用。
     *
     * @param props - `{summary, t, onClose}`。
     */
    function JudgementOverlay(props) {
      const summary = props.summary;
      // 文案翻译有两条路：宿主注入的 `t`（key 形态）与本模块自己的 i18n
      // （文案形态，DEC-018）。后者不依赖槽位声明与宿主行为——rendering 测试
      // 或宿主没把 `t` 塞进 props 时，组件仍然跟随当前语言，而不是卡在中文。
      // `pointLabel` 与下面这些 fallback `tr` 走的都是第二条路。
      const fallbackT = typeof props.t === "function" ? props.t : (key) => tr(JUDGEMENT_ZH[key] ?? key);
      const t = fallbackT;
      const onClose = props.onClose;
      react.useEffect(() => {
        if (typeof onClose !== "function" || typeof document === "undefined") return undefined;
        const onKeyDown = (event) => {
          if (event?.key === "Escape") onClose();
        };
        try {
          document.addEventListener("keydown", onKeyDown);
        } catch {
          return undefined;
        }
        return () => {
          try {
            document.removeEventListener("keydown", onKeyDown);
          } catch { /* 已经卸载：忽略 */ }
        };
      }, [onClose]);
      const rows = Array.isArray(summary?.rows) ? summary.rows : [];
      const range = clockOf(summary?.firstAt);
      const last = clockOf(summary?.lastAt);
      return h(
        "div",
        { style: JS.panel, role: "dialog", "aria-label": t("judgement.title"), "data-decision-engine-judgements": true },
        h(
          "div",
          { style: JS.header },
          h("span", null, `${t("judgement.title")} ${summary?.total ?? 0}`),
          range !== "" ? h("span", { style: JS.range }, range === last ? range : `${range}–${last}`) : null,
        ),
        h(
          "button",
          { type: "button", style: JS.close, "aria-label": t("judgement.close"), onClick: onClose },
          "×",
        ),
        rows.length === 0
          ? h("div", { style: JS.range }, t("judgement.empty"))
          : h(
              "dl",
              { style: JS.table },
              rows.map((row) =>
                h(
                  "div",
                  { key: row.point, style: JS.row },
                  h("dt", { style: JS.name }, pointLabel(row.point)),
                  h("dd", { style: JS.counts }, judgementBreakdown(row, t)),
                ),
              ),
            ),
      );
    }

    /**
     * 浮层外面那层遮罩：点它就关。
     *
     * 用 `event.target === event.currentTarget` 而不是「点任何地方都关」：
     * 卡片本身在遮罩里面，不加这个判断，用户点卡片里的 × 之外的任何地方
     * （比如想选中一行文字）都会把卡片关掉。
     */
    function JudgementScrim(props) {
      const onClose = props.onClose;
      return h(
        "div",
        {
          style: JS.scrim,
          "data-decision-engine-judgement-scrim": true,
          onClick: (event) => {
            if (event?.target === event?.currentTarget) onClose?.();
          },
        },
        props.children,
      );
    }

    /**
     * 把浮层挂到 `document.body` 上（拿不到 portal 时原地渲染）。
     *
     * 挂在 body 上的理由见 `createPortal` 那段：消息尾部的容器可能有自己的
     * 层叠上下文，在里面 `position: fixed` 会被祖先夹住。
     *
     * 拿不到 `react-dom` 就退回原地渲染：那时卡片仍然有关闭按钮与 Esc，
     * 只是理论上可能被祖先的层叠上下文夹住——那也比因为一次 require 失败
     * 把整条消息尾部弄没要好。
     */
    function renderJudgementOverlay(props) {
      const panel = h(JudgementScrim, { onClose: props.onClose }, h(JudgementOverlay, props));
      if (createPortal === null || typeof document === "undefined" || document.body === undefined) return panel;
      try {
        return createPortal(panel, document.body);
      } catch {
        return panel;
      }
    }

    /**
     * 订阅「这一轮的判断记录」，让晚到的记录也能把计数刷新出来。
     *
     * ## 为什么必须订阅
     *
     * `turn.data.get(key)` 是**非响应式**的读：它拿到的是当下的值，不会因为
     * 之后又来了一条记录而让组件重绘。宿主的轮次数据存取口为此另给了
     * `source(key)`——一个 `useSyncExternalStore` 形状的订阅源
     * （`subscribe` / `getSnapshot`），宿主自己的消费端就走它。
     *
     * 不用订阅会漏掉**晚到的记录**：`turnStop` 那一类判断发生在轮次收尾时，
     * 它的记录可能排在轮次尾部节点渲染之后才落进日志（实测：`turnStop` 的
     * 记录 seq 2333，轮次结束 seq 2335——顺序通常没问题的反面是**恰好
     * 交错**的情况，那时不订阅就永远停在旧数字）。
     *
     * 没有 `source`（老宿主 / 测试桩）时退回非响应式读：那时能显示已有的
     * 记录，只是不追新记录——比整个组件不渲染强。
     *
     * @param owner - turnTail 槽位给的 owner（含 turn.data）。
     * @returns 本轮的记录数组（订阅变化时重绘）。
     */
    function useTurnJudgements(owner) {
      const store = owner?.turn?.data;
      const source = typeof store?.source === "function" ? store.source(JUDGEMENT_DATA_KEY) : undefined;
      // useSyncExternalStore 需要稳定的 subscribe/getSnapshot；源不存在时
      // 用一个恒定的假源，值走下面的非响应式读。
      const snapshot = react.useSyncExternalStore(
        source?.subscribe ?? (() => () => {}),
        source?.getSnapshot ?? (() => undefined),
        source?.getSnapshot ?? (() => undefined),
      );
      const entries = snapshot?.entries;
      if (Array.isArray(entries)) return entries;
      return judgementsOfTurn(owner);
    }

    /**
     * 消息尾部的判断计数器。
     *
     * 没有记录时返回 null——槽位的约定是「没有内容就不占位」，所以判断计数
     * 关掉（或这一轮压根没判断过）的轮次完全看不到这一段。
     *
     * 整个组件包在 try/catch 里：**报告通路坏了也不能影响聊天**。计数是给人
     * 看的注解，它出错时正确做法是「这一轮不显示计数」，而不是让消息尾部
     * 整块崩掉。
     *
     * @param props - turnTail 槽位给的 owner（含 turn / seq / openFile / t）。
     * @returns 计数器（含浮层）；无记录时 null。
     */
    function DecisionJudgementCount(props) {
      const [open, setOpen] = react.useState(false);
      const close = react.useCallback(() => setOpen(false), []);
      try {
        const entries = useTurnJudgements(props);
        if (entries.length === 0) return null;
        const t = typeof props.t === "function" ? props.t : (key) => key;
        const summary = summarizeTurn(entries);
        if (summary.total === 0 && summary.rows.length === 0) return null;
        const label = t("judgement.count", { n: summary.total });
        return h(
          "div",
          { style: JS.row, "data-decision-engine-judgement-count": String(summary.total) },
          h(
            "button",
            {
              type: "button",
              style: JS.trigger,
              "aria-haspopup": "dialog",
              "aria-expanded": open,
              title: t("judgement.hint"),
              onClick: () => setOpen(!open),
            },
            label,
          ),
          open ? renderJudgementOverlay({ summary, t, onClose: close }) : null,
        );
      } catch (error) {
        try {
          console.warn("[dsh-decision-engine] judgement count render failed:", error?.message ?? String(error));
        } catch { /* 连 console 都不可用时更不能让它冒出去 */ }
        return null;
      }
    }

    /**
     * `react-dom` 的 `createPortal`（**可选**）。
     *
     * 浮层要挂在 `document.body` 上：消息尾部那个容器有自己的层叠上下文，
     * 在里面画一张 `position: fixed` 的卡片，遇到祖先有 `transform` /
     * `filter` / `contain` 就会被当成定位祖先，卡片跟着消息一起滚走。
     *
     * 这里是**尽力而为**：拿不到 `react-dom`（宿主没把它 seed 进来、或测试
     * 环境里没有 DOM）就退回「原地渲染」。退回时卡片仍然 `fixed` 定位、
     * 仍然有关闭按钮与 Esc，只是理论上可能被祖先的层叠上下文夹住——
     * 那也比因为一次 require 失败把整条消息尾部弄没要好。
     */
    const createPortal = (() => {
      try {
        const reactDom = require("react-dom");
        return typeof reactDom?.createPortal === "function" ? reactDom.createPortal : null;
      } catch {
        return null;
      }
    })();

    /**
     * 客户端要注入的服务。
     *
     * `uiConversation` 是错误尾部的数据入口：宿主把错误写成会话事件后，
     * 由本插件注册的 conversation Definition 折成「这一轮的错误」，
     * 再由 `conversation.chat.turnTail` 槽位读出来渲染。
     *
     * 宿主没有这个服务时，客户端运行时会把插件**停泊**（park）而不是
     * 报错——那意味着错误尾部整体不生效。考虑到错误尾部是增强功能，
     * 而配置页才是本插件的主入口，这里接受这个结果：宿主缺 ui-chat 就
     * 说明那个版本的 DSH 没有消息尾部这个位置可挂。
     */
    const inject = ["slots", "locale", "uiConversation"];

    /** 本插件的包名：`plugins.bundle.config` 用包名作为 key 匹配。 */
    const PACKAGE_NAME = "dsh-decision-engine";

    /**
     * 判断浮层的文案（中文是源语言）。
     *
     * 单独一张表而不是散在组件里：`t` 是宿主按命名空间注入的翻译函数，组件
     * 里只写 key，文案集中才看得住两份语言是否齐全（漏一条英文的后果是界面
     * 上突然冒出一句中文，而那句中文在英文界面里没人看得懂）。
     */
    const JUDGEMENT_ZH = {
      "judgement.count": "{n} 次判断",
      "judgement.countShort": "判断 {n}",
      "judgement.title": "本轮判断",
      "judgement.hint": "点开看这一轮的判断都花在哪些决策点上",
      // 「关闭浮层」而不是「关闭」：EN_CONFIG 已把「关闭」登记成 "Off"
      // （提供方开关的档位名），同一句中文两处语义不同，文案形态只能有一个
      // 英文——按钮的 aria-label 换成不会撞车的说法。
      "judgement.close": "关闭浮层",
      "judgement.empty": "这一轮没有记录",
      "judgement.observe": "观察",
      "judgement.enforce": "生效",
      "judgement.allow": "放行",
      "judgement.ask": "询问",
      "judgement.reject": "拦截",
      "judgement.degraded": "降级",
    };

    const JUDGEMENT_EN = {
      "judgement.count": "{n} judgements",
      "judgement.countShort": "judged {n}",
      "judgement.title": "Judgements this turn",
      "judgement.hint": "Open to see which decision points this turn's judgements went to",
      "judgement.close": "Close panel",
      "judgement.empty": "Nothing recorded for this turn",
      "judgement.observe": "observe",
      "judgement.enforce": "enforce",
      "judgement.allow": "allow",
      "judgement.ask": "ask",
      "judgement.reject": "reject",
      "judgement.degraded": "degraded",
    };

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
            // 判断浮层的文案与配置页同一个命名空间：宿主按 `locale: NS`
            // 注入 `t` 时，一个命名空间对应一个字典，再开一个就要再注册一次。
            yield ctx.locale.register(NS, {
              zh: { title: "StartLux 守卫", ...JUDGEMENT_ZH },
              en: { title: "StartLux Guard", ...JUDGEMENT_EN },
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

          // 3) 错误尾部：把降级/异常显示在对应那条消息的末尾。
          //
          // 槽位是 `conversation.chat.turnTail`——宿主给「已完成轮次」的
          // 尾部留的扩展位（内置的 token 统计面板也落在这里）。
          //
          // 用 `id` 而不是 `key`：这是**列表型**槽位，用自己的 id 就是
          // 「在旁边加一个格子」，不会覆盖别人的格子。
          try {
            yield ctx.slots.inject("conversation.chat.turnTail", () => {
              log("inject fired for conversation.chat.turnTail");
              return ctx.slots.register(
                { name: "conversation.chat.turnTail", id: "decision-engine-errors", order: 30, locale: NS },
                DecisionErrorTail,
              );
            });
            log("turnTail mounted");
          } catch (error) {
            log("turnTail mount failed:", error?.message ?? String(error));
          }

            // 3b) 判断计数：同一槽位的**第二个格子**，order 20（排在错误尾部的 30
            // 之前）。用户要的是「这一轮判断了几次」这个常态数字，它应该在红字之上——
            // 红字是例外，例外不该压住常态。
            //
            // 同样要 `locale: NS`：宿主的槽位渲染器只在注册项声明了 `locale` 时才把
            // `t` 塞进 props（dsh-client-ui-renderer 的 `standardKit`：
            // `if (entry.locale !== undefined) kit["t"] = …`）。少了它，组件拿到的
            // `t` 是 undefined，文案会整块消失——而这类错误不报错，只是界面上什么都不显示。
            try {
              yield ctx.slots.inject("conversation.chat.turnTail", () => {
                log("inject fired for judgement count");
                return ctx.slots.register(
                  { name: "conversation.chat.turnTail", id: "decision-engine-judgements", order: 20, locale: NS },
                  DecisionJudgementCount,
                );
              });
              log("judgement count mounted");
            } catch (error) {
              log("judgement count mount failed:", error?.message ?? String(error));
            }
        },
        "dsh-decision-engine client lifecycle",
      );

      // 4) conversation Definition：把宿主的错误事件折叠成「这一轮的错误」。
      //
      // 必须单独注册（不在上面的 generator 里）：它属于 `uiConversation`
      // 服务，而不是 `slots`——两者的挂载方式与生命周期不同。
      //
      // 缺了这个服务（宿主版本没有 ui-chat / ui-conversation）时静默跳过：
      // 错误尾部是增强功能，不该因为它把整个插件搞挂。
      try {
        ctx.effect(() => ctx.uiConversation.events.register(createErrorDefinition()), "decision-engine: error definition");
        log("error definition registered");
      } catch (error) {
        log("error definition not registered:", error?.message ?? String(error));
      }

      // 5) 判断计数的 conversation Definition。
      //
      // 与上面那条**同型不同名**：Definition 的名字（`kind`）就是它发布的
      // 轮次数据的命名空间，两个事件两套数据必须分开，否则「这一轮的错误」
      // 会把「这一轮的判断」顶掉——两者用的是同一个 `key` 规则（轮次号）。
      //
      // 同样静默跳过：判断计数是增强功能，不该因为它把整个插件搞挂。
      try {
        ctx.effect(() => ctx.uiConversation.events.register(createJudgementDefinition()), "decision-engine: judgement definition");
        log("judgement definition registered");
      } catch (error) {
        log("judgement definition not registered:", error?.message ?? String(error));
      }
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
    return module.exports;
  },
});
