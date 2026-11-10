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
      "生效端点": "Effective endpoint",
      "由上方 base URL + 端点风格拼接；已带 /decisions 或 /systemone 时原样使用": "Built from the base URL above plus the endpoint style; kept as-is when it already contains /decisions or /systemone",
      "内置预设的默认地址（可用 config.yml 的 baseUrl 覆盖 bamboonode）": "Built-in preset default address (config.yml's baseUrl can override bamboonode)",
      "自动（不发送 model 字段）": "Auto (omit the model field)",
      "从自定义服务实时获取；「自动」表示不发送 model 字段，若该服务要求指定模型请从列表选择": "Fetched live from your custom service; 'Auto' omits the model field — pick one from the list if the service requires an explicit model",
      "获取失败或暂无列表，可手填模型名": "Fetch failed or no list yet; type a model id manually",
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
      "真正拦截": "Actually block",
      "关闭时只记录判断结果（shadow）；开启后按判断执行 deny / ask": "When off, verdicts are only recorded (shadow); when on, deny / ask are enforced",
      "思考模式": "Thinking mode",
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
      // —— 图表（统计页）——
      "走势": "Trend",
      "请求次数对比": "Requests compared",
      "裁决构成": "Verdict mix",
      "小时": "hour",
      "天": "day",
      "月": "month",
      "本区间没有裁决记录": "No verdicts in this range",
      "input token": "input tokens",
      "output token": "output tokens",
      "请求次数": "Requests",
    };

    /** i18n:misc —— 页面外壳（tab、主页链接、校验提示）。 */
    const EN_MISC = {
      "项目主页 ↗": "Project home ↗",
      "配置": "Config",
      "统计与对比": "Stats & comparison",
      "决策": "Decision",
      // —— 配置页的四个分组标题（DEC-051）——
      "连接方式": "Connection",
      "守卫行为": "Guard behavior",
      "记录与展示": "Records & display",
      "模型与统计": "Model & telemetry",
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
      // —— 决策历史（DEC-022）：会话标签页与它的表头 ——
      "决策历史": "Decisions",
      "时间": "Time",
      "提供方": "Provider",
      "裁决": "Verdict",
      "耗时": "Latency",
      "展开": "Expand",
      "收起": "Collapse",
      "内容": "Content",
      "问题": "Questions",
      "回答": "Answers",
      "分数": "Scores",
      "缓存命中": "Cache hit",
      "已降级": "Degraded",
      "有内容": "Has content",
      "仅元数据": "Metadata only",
      "标记": "Flags",
      "本会话还没有决策记录": "No decision records in this session yet",
      "决策点都处于「关闭」时不会产生记录": "No records are produced while every decision point is off",
      "这条记录只保存了元数据（未保存决策内容）": "This record kept metadata only (the decision content was not saved)",
      "还有更多记录没有显示": "More records are not shown",
      "记录文件：{path}": "Records file: {path}",
      "共 {count} 条": "{count} total",
      "读取决策历史失败：{error}": "Failed to load decision history: {error}",
      "该插件的决策历史已在设置里关闭": "Decision history is turned off in this plugin's settings",
      // —— 审批卡正文可读化（DEC-042，approval detail 接管）——
      "命令摘要": "Command summary",
      "完整命令": "Full command",
      "这条命令会执行一段脚本": "This command runs a script",
      "按原文原样执行": "Runs exactly as written",
      "含危险动作": "risky action(s)",
      "自动归纳，仅供参考；真正执行的是下方原文": "Auto-summarised for orientation only; the text below is what actually runs",
      "展开原文": "Show the original",
      "收起原文": "Hide the original",
      "这段脚本按原文原样执行": "This script runs exactly as written",
      "审批卡正文可读化": "Readable approval-card command block",
      "接管宿主的命令块：显示「几步、哪几步危险」的摘要，原文默认收起、可展开；保留换行，长命令限高滚动": "Take over the host's command block: show a summary of how many steps there are and which look risky, with the original collapsed by default and expandable; line breaks preserved and long commands scrolling inside a fixed height",
      "关闭时完全沿用宿主的渲染：命令原文原样铺满整个块，换行会被折叠": "When off, the host's rendering is used unchanged: the raw command fills the whole block and its line breaks are collapsed",
      // —— 人工审核比例（DEC-035）：配置页与决策历史页共用的滑块 ——
      "人工审核比例": "Review tolerance",
      "自治": "Autonomous",
      "轻松": "Relaxed",
      "默认": "Default",
      "谨慎": "Cautious",
      "自治（从不询问）": "Autonomous (never asks)",
      "轻松（只问最前 1%）": "Relaxed (top 1% only)",
      "默认（当前行为）": "Default (current behaviour)",
      "谨慎（更保守）": "Cautious (more conservative)",
      "自治：从不询问用户，只有高风险调用会被直接拦下": "Autonomous: never asks the user; only high-risk calls are blocked outright",
      "轻松：只有严重度排在最前的 1% 才询问用户": "Relaxed: only the top 1% by severity asks the user",
      "默认：按决策模型自己的判断提问（当前的默认行为）": "Default: asks according to the decision model's own judgement (current behaviour)",
      "谨慎：在默认判断之外，再把严重度靠前的 25% 也拿来询问": "Cautious: beyond the default judgement, also asks for the top 25% by severity",
      "按比例校准这个模型的打扰频率。换决策模型不需要重调阈值：设定是模型无关的，插件会按该模型最近的分数量自己换算。": "Calibrates how often this model interrupts you. Switching decision models needs no re-tuning: the setting is model-agnostic, and the plugin converts it against that model's recent score distribution.",
      "自治档不按比例：从不询问用户": "Autonomous ignores proportionality: it never asks the user",
      "这一档沿用决策模型自己的判断，不需要校准": "This level follows the decision model's own judgement and needs no calibration",
      "高风险调用一律直接拦下（不打扰用户，四档一致）": "High-risk calls are always blocked outright (no interruption; the same in all four levels)",
      "分位数窗口按 provider × model 分开，换模型会重新校准": "The percentile window is kept per provider × model, so switching models re-calibrates",
    };

    /** i18n:labels —— 服务端下发、且本文件别处没有同名词的中文文案。 */
    const EN_LABELS = {
      // provider 展示名来自服务端（lib/providers.js 的 providerCatalog）。
      // 不收进 EN_CONFIG/EN_STATS，因为它是**服务端数据**：将来新增带中文名
      // 的预设，只要在这里补一行；界面在渲染边界统一翻译，不用改调用点。
      "硅基流动": "SiliconFlow",
      // —— 裁决词的中文名（客户端 VERDICT_LABELS）——
      // 值就是**机器词本身**：英文界面翻回去的还是 `delegate` / `inline` 这些
      // 原词，与改前逐字一致。`degraded` 复用上面已有的「已降级」。
      "照常放行": "allow",
      "保留原模型": "keep",
      "交给主模型": "delegate",
      "换模型": "switch",
      "改用别的技能": "redirect",
      "建议分派": "advise",
      "裁剪结果": "prune",
      "摘要压缩": "summarize",
      "续一轮": "continue",
      "翻译": "translate",
      "收束本轮": "stop",
      "自己接着做": "inline",
      "跳过": "skip",
      "让位给用户": "defer",
      "转人工确认": "ask",
      "拒绝执行": "deny",
      "降级未裁决": "degraded",
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
      "配置文件 config.yml 的 bamboonodeApiKey": "config.yml field bamboonodeApiKey",
      "配置文件 config.yml 的 systemoneApiKey": "config.yml field systemoneApiKey",
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
      // —— 使用免费模型（DEC-030，原名「跟随服务端下发」，DEC-037 改名） ——
      "服务端下发：{baseUrl} · 模型 {model} · 密钥 {hint}": "Server-issued: {baseUrl} · model {model} · key {hint} (in memory only, never written to disk)",
      "服务端不可用：{error}；已回落到本地手动配置": "Server unavailable: {error}; fell back to the local manual configuration",
      " · 获取于 {time}": " · fetched at {time}",
      "；当前生效的是服务端下发的密钥": "; the API key currently in effect comes from the server",
      // —— 人工审核比例（DEC-035） ——
      "校准中 {samples}/{min} 次授权决策（当前用冷启动阈值 {fallback}）": "Calibrating {samples}/{min} authorization decisions (using the cold-start threshold {fallback})",
      "已按这个模型校准：最前的 {percent}% ≈ 严重度 {threshold}（{samples} 个样本）": "Calibrated for this model: top {percent}% ≈ severity {threshold} ({samples} samples)",
      "人工审核比例已设为「{level}」": "Review tolerance set to \"{level}\"",
      "保存失败：{error}": "Save failed: {error}",
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
      // —— 图表（统计页）——
      "{label}：本区间没有数据": "{label}: no data in this range",
      "{label}随时间变化": "{label} over time",
      "{label}：没有可对比的基线": "{label}: no baseline to compare against",
      "{label}：本区间没有可对比的变化": "{label}: no comparable change in this range",
      "{label}：{value}": "{label}: {value}",
      "{label}：实际 {real}，基线 {base}": "{label}: actual {real}, baseline {base}",
      "{label}（实际 vs 基线）": "{label} (actual vs baseline)",
      "裁决构成：放行 {allow}、询问 {ask}、拦截 {reject}": "Verdict mix: allow {allow}, ask {ask}, reject {reject}",
      "按{bucket}分桶，共 {count} 个桶；空桶补 0，掉到零就是真的没有请求。": "Bucketed by {bucket}, {count} buckets; empty buckets are zero-filled, so a drop to zero really means no requests.",
      "前 {count} 个组合的请求次数对比": "Requests for the top {count} combinations",
      "按决策点分账：{parts}": "Breakdown by decision point: {parts}",
      "{label}对比：{parts}": "{label} compared: {parts}",
      "已隐藏": "hidden",
      "所有决策点都被隐藏了，点击下面的图例可以重新显示。": "All decision points are hidden. Click a legend item below to show one again.",
      "点击重新显示「{label}」": "Click to show \"{label}\" again",
      "点击隐藏「{label}」，方便查看其他决策点的比例": "Click to hide \"{label}\" so the other decision points' shares are easier to compare",
      "已隐藏 {count} 个决策点（占全量 {share}），图中的比例按剩余部分重新计算。": "{count} decision points hidden ({share} of the total); the shares in the chart are recalculated from what remains.",
    };


    /** i18n:templates:misc */
    const T_MISC = {
      "（{detail}）": "({detail})",
      "· {tool}": "· {tool}",
      // —— 决策历史（DEC-022）——
      "记录文件：{path}": "Records file: {path}",
      "读取决策历史失败：{error}": "Failed to load decision history: {error}",
      "只落本地，永不外传": "Stored locally only, never sent anywhere",
      "把本会话里经本插件做出的每次决策按时间记下来，并在会话里新增一个「决策历史」标签页": "Record every decision this plugin made in this session, and add a \"Decisions\" tab to the session",
      "关闭后不写任何明细文件（不采集内容、不占磁盘）": "When off, no detail file is written at all (no content is captured, no disk is used)",
      // —— 人工审核比例（DEC-035）：当前档位的比例说明 ——
      // 落点标签只用档位名（宽度所限，见 toleranceShortLabel 的注释），
      // 比例放轨道下方那一行，所以这里是**整句**而不是肢解的片段。
      "当前档位只问最前 {percent}% 的调用": "This level asks only on the top {percent}% of calls",
      "分位数窗口按 provider × model 分开，换模型会重新校准；高风险调用一律直接拦下（四档一致）": "The percentile window is kept per provider × model, so switching models re-calibrates; high-risk calls are always blocked outright (the same in all four levels)",
      // —— 审批卡正文可读化（DEC-042）：带数字的摘要行 ——
      "命令摘要：{summary}": "Command summary: {summary}",
      "{steps} 个步骤": "{steps} steps",
      " · 含 {count} 个危险动作": " · {count} risky actions",
      " · 另有 {count} 个步骤未展开": " · {count} more steps not expanded",
      "执行一段脚本（{lines} 行）": "Runs a script ({lines} lines)",
      "执行一段内联脚本（{lines} 行）": "Runs an inline script ({lines} lines)",
      "：{summary}": ": {summary}",
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
      // 中文界面下 `tr()` 是恒等函数（开头 `lang === "zh"` 直接返回原文），
      // 因此 `translateProps` 必然原样返回 props、`translateChild` 必然原样
      // 返回每个 child——但两者仍会：`Object.keys(props)` 建一个键数组、
      // `props` 有文本属性时建一份副本、`children.map()` 建一个新数组。
      // 一次决策历史渲染是三千多个元素，这些全是纯垃圾。
      //
      // `lang` 是模块级可变状态（切语言会改它），所以这个判断必须**每次调用
      // 现读**，不能在加载时固化。
      if (lang === "zh") {
        return children.length === 0
          ? createElement(type, props)
          : createElement(type, props, ...children);
      }
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
    /* ============================================================
     * 新增行的入场动效（DEC-044）
     *
     * 三条约定，缺一条这个动画就是错的：
     *
     * 1. **`@keyframes` 只能落在样式表里**。本面板的样式全是内联对象
     *    （`S.xxx`），内联能写 `animation`，却写不出 `@keyframes`——于是
     *    必须往 `document.head` 注一个 `<style>`。
     * 2. **注不上也不能把行搞没**。用的是 `animation: <name> …`：浏览器里
     *    找不到同名 keyframes 时整条 animation 直接失效，行按平常样子出现。
     *    这是**故意**的失败方向——动画没了只是少了个提示，行不显示是这个
     *    页面的故障。所以既不用 `transition` + 挂载后置位的写法（那种做
     *    法是「先透明再变实」，effect 一没跑成就永久透明），也不用 `opacity`
     *    先置 0。
     * 3. **尊重系统的「减弱动态效果」**。动画只在系统没要求减弱时加；判定
     *    放在这里而不是写进样式表的 `@media`，因为内联样式的优先级高于
     *    样式表——`@media (prefers-reduced-motion)` 盖不住内联的 `animation`。
     * ============================================================ */

    /** keyframes 名；`S.decisionsRowEnter` 的 `animation` 引用它。 */
    const DECISION_ROW_ENTER_KEYFRAMES = "dsh-decision-row-enter";
    /** 注入的那个 `<style>` 的 id：用它做幂等判定。 */
    const DECISION_ROW_ENTER_STYLE_ID = "dsh-decision-row-enter-css";
    const DECISION_ROW_ENTER_CSS =
      `@keyframes ${DECISION_ROW_ENTER_KEYFRAMES}{` +
      "from{opacity:0;transform:translateY(-4px)}" +
      "to{opacity:1;transform:translateY(0)}}";

    /**
     * 幂等地把 keyframes 注进 `document.head`。
     *
     * 全程包 try/catch 并返回布尔：没有 `document`（Node 里的渲染测试）、
     * 页面 CSP 挡了 `<style>`、head 还没挂上——任何一种都**不该**冒到渲染
     * 路径上。注不上就是不动画，行照常出现。
     */
    function ensureRowEnterCss() {
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
        const parent = document.head ?? document.body;
        if (!parent) return false;
        if (typeof document.getElementById === "function" && document.getElementById(DECISION_ROW_ENTER_STYLE_ID)) return true;
        const tag = document.createElement("style");
        tag.id = DECISION_ROW_ENTER_STYLE_ID;
        // 与宿主自带的插件样式标签同一个识别口径（`data-plugin-css`），
        // 将来排查「这条样式是谁注的」时能一眼看到包名。
        tag.dataset.plugin = "dsh-decision-engine";
        tag.dataset.pluginCss = DECISION_ROW_ENTER_STYLE_ID;
        tag.textContent = DECISION_ROW_ENTER_CSS;
        parent.appendChild(tag);
        return true;
      } catch {
        return false;
      }
    }

    /** 系统是否要求「减弱动态效果」。读不到就按不减弱（照常动画）。 */
    function prefersReducedMotion() {
      try {
        if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
          return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
        }
      } catch {
        /* 读不到就当没要求 */
      }
      return false;
    }

    /* ============================================================
     * 配置页的分组折叠（DEC-051）
     *
     * 样式参考 @xbzbing/dsh-git-panel 的插件配置页：分组标题是一行
     * 可点的按钮（chevron 指示开合），正文挂在标题下面；标题左侧有
     * 一个色块图标，色块与正文左侧的竖线用同一个语义色，一眼能看出
     * 「下面这些行属于这一组」。
     *
     * 为什么必须用样式表而不是内联对象：本面板的样式全是内联的
     * （`S.xxx`），内联能写 `display:flex`，却写不出
     * `border-left: 2px solid var(--tone)` 这种**依赖祖先变量**的规则
     * ——tone 定义在 section 元素上，正文是它的后代，内联样式给不了
     * 祖先到后代的关系。样式表里的 `.de-cfg__section-body` 才能用
     * `var(--de-cfg-tone)` 继承到分隔竖线上。
     *
     * 失败方向是安全的：样式表注不上（Node 测试环境 / CSP 挡住）时，
     * 分组照样渲染、照样能展开收起，只是没有那条语义竖线与 hover 底色。
     * ============================================================ */

    /** 分组折叠样式的 style 标签 id（幂等判定用）。 */
    const CFG_SECTION_STYLE_ID = "dsh-decision-engine-cfg-section-css";
    const CFG_SECTION_CSS = `
.de-cfg{display:flex;flex-direction:column;gap:0}
.de-cfg__section{display:flex;flex-direction:column;gap:10px;padding:14px 0}
.de-cfg__section:first-child{padding-top:0}
.de-cfg__section:last-child{padding-bottom:0}
.de-cfg__section+.de-cfg__section{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32))}
.de-cfg__section-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 -8px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:14px;font-weight:600;text-align:left;cursor:pointer}
.de-cfg__section-hd:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));color:var(--dsw-alias-state-business-primary,inherit)}
.de-cfg__section-hd:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#818cf8);outline-offset:2px}
.de-cfg__section-left{display:flex;align-items:center;gap:8px;min-width:0}
.de-cfg__section-ic{display:flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14))}
.de-cfg__section-ic svg{color:var(--dsw-alias-label-secondary,inherit)}
.de-cfg__section--business{--de-cfg-tone:color-mix(in srgb,var(--dsw-alias-state-business-primary,#818cf8) 35%,transparent)}
.de-cfg__section--success{--de-cfg-tone:color-mix(in srgb,var(--dsw-alias-state-success-primary,#4ade80) 35%,transparent)}
.de-cfg__section--warn{--de-cfg-tone:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 35%,transparent)}
.de-cfg__section--neutral{--de-cfg-tone:var(--dsw-alias-border-l2,rgba(128,128,128,.32))}
.de-cfg__section-ic--business{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#818cf8) 14%,transparent)}
.de-cfg__section-ic--business svg{color:var(--dsw-alias-state-business-primary,#818cf8)}
.de-cfg__section-ic--success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#4ade80) 14%,transparent)}
.de-cfg__section-ic--success svg{color:var(--dsw-alias-state-success-primary,#4ade80)}
.de-cfg__section-ic--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent)}
.de-cfg__section-ic--warn svg{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.de-cfg__section-ic--neutral{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14))}
.de-cfg__section-body{display:flex;flex-direction:column;gap:0;margin-left:11px;padding:4px 0 4px 20px;border-left:2px solid var(--de-cfg-tone)}
.de-cfg__section-body[hidden]{display:none}
.de-cfg__chevron{flex:none;color:var(--dsw-alias-label-tertiary,inherit);transition:transform .15s ease}
.de-cfg__chevron--open{transform:rotate(90deg)}
`;

    /**
     * 幂等地把分组折叠样式注进 `document.head`。
     *
     * 与 `ensureRowEnterCss` 同一套路：注不上就**不注**（不抛错），
     * 分组照样渲染——只是少了竖线与 hover 底色，不影响功能。
     */
    function ensureCfgSectionCss() {
      try {
        if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
        const parent = document.head ?? document.body;
        if (!parent) return false;
        if (typeof document.getElementById === "function" && document.getElementById(CFG_SECTION_STYLE_ID)) return true;
        const tag = document.createElement("style");
        tag.id = CFG_SECTION_STYLE_ID;
        tag.dataset.plugin = "dsh-decision-engine";
        tag.dataset.pluginCss = CFG_SECTION_STYLE_ID;
        tag.textContent = CFG_SECTION_CSS;
        parent.appendChild(tag);
        return true;
      } catch {
        return false;
      }
    }

    /* ============================================================
     * 统计页图表（microcharts）——按需加载 + 降级
     *
     * 统计页原来全是表格。表格能回答「谁多谁少」，却很难一眼看出
     * 「构成是不是偏了」「走势有没有掉下去」——那两类问题本来就要看形状，
     * 而形状正是图表擅长、而数字不擅长的事。所以这一版给统计页补上图型，
     * **表格保留**（精确核对仍然要靠数字）。
     *
     * 三条硬约束决定了这里的实现形态：
     *
     * 1. **不能进首屏 bundle**。microcharts 是第三方库，只有统计页用得上；
     *    内联进 client.js 等于让每个打开设置页的人都为它付体积。因此走
     *    宿主的包内分块机制（`require.async("./client.charts.js")`），
     *    切到统计页才下载，下载完就缓存。
     *
     * 2. **加载失败不能让统计页坏掉**。分块可能因为宿主版本、缓存、
     *    网络任何一环失败。此时统计页必须**照常显示表格**——图表是增强，
     *    不是前提。`charts === null` 就是那条降级路径，不报错、不空白。
     *
     * 3. **测试环境没有分块加载器**。渲染测试里 `require` 只有 react，
     *    `require.async` 不存在。那时同样走降级（只渲染表格），
     *    于是「有没有图表」不会影响既有断言的稳定性。
     * ============================================================ */

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

    const S = {
      /**
       * 配置页容器：**不设最大宽度**（DEC-040）。
       *
       * 原来是 `maxWidth: 620px`，而这一层同时是 `overflowY: auto`。CSS 规范里
       * 「一个轴不是 visible，另一个轴的 visible 就按 auto 处理」，于是 620px
       * 变成了**硬裁剪**：只要有一行比它宽（长端点地址、四段滑块、带 nowrap 的
       * 控件），容器里就多出一条横向滚动条，用户得左右拖动才看得全。
       *
       * 取消限制后容器等于宿主给它的宽度，内容多宽就摊多宽，那条横向滚动条
       * 连根消失。仍然留着 `overflowY: auto`：竖向滚动是这一层自己该管的事。
       */
      wrap: {
        maxWidth: "none",
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
      /**
       * 行说明下面的小字（DEC-037）。
       *
       * 比 hint 再小一档、再淡一档：它是「风险 / 代价」这一层的信息，读不读
       * 取决于用户，但必须摆在同一行里——离得太远就等于没写。
       */
      rowNote: { fontSize: "11px", opacity: 0.5, lineHeight: 1.4 },
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
      /**
       * 人工审核比例的分段滑块（DEC-035）。
       *
       * 为什么是「分段 + 滑块」而不是下拉：
       *
       *   - 四档是一条**单调的轴**（从不问 → 更常问），下拉会把这条轴压成
       *     四个互不相干的选项，用户看不出「往右更保守」；
       *   - 拖动/点击的即时反馈让「大概每多少次问一次」这层语义可感知，
       *     而选下拉时用户得先在脑子里换算；
       *   - 滑块能同时画出**当前位置附近的校准信息**（最前 1% 落在哪个分数），
       *     那是下拉的每一行都放不下的。
       *
       * 轨道用一条横线、四个等距落点。落点本身是按钮（可点击），因此键盘与
       * 鼠标都能用；没有引入真正的 `<input type="range">`，因为它的值域是
       * 数字而四档是离散语义，映射回去反而要处理「拖到两档之间」的中间态。
       */
      /** 人工审核比例的整块容器（配置页）：竖排，占满一整行。 */
      toleranceSection: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "12px 0",
        borderBottom: "1px solid rgba(128,128,128,.14)",
      },
      toleranceTrack: {
        position: "relative",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        // 兜底：窗口极窄时允许横向排布而不是把中文竖着挤成一列。
        flexWrap: "nowrap",
        gap: "0",
        padding: "14px 4px 2px",
        margin: "2px 0 0",
        minHeight: "34px",
      },
      /**
       * 轨道本体：一条贯穿四个落点的细线。
       *
       * 绝对定位，左右内缩 = 半个段宽：落点在各段**居中对齐**，若轨道从
       * 容器边缘开始，两端会各多出一截「通向无处」的线。
       */
      toleranceRail: {
        position: "absolute",
        left: "12.5%",
        right: "12.5%",
        top: "21px",
        height: "2px",
        borderRadius: "1px",
        background: "rgba(128,128,128,.28)",
        pointerEvents: "none",
      },
      /**
       * 一个落点：圆点 + 下方标签，四个等宽等距。
       *
       * `flex: "1 1 0"` 让四段等宽，但**必须配 `minWidth: max-content`**：
       * 纯 `minWidth: 0` 会让中文标签在窄容器里逐字换行，四个段叠成一团
       * 竖排（真机上就是这么坏的）。`max-content` 保证标签永不换行，容器
       * 太窄时宁可整体溢出也不要把字拆开。
       */
      toleranceStop: (active, passed) => ({
        position: "relative",
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "6px",
        flex: "1 1 0",
        minWidth: "max-content",
        padding: "0 4px",
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "11px",
        whiteSpace: "nowrap",
      }),
      /** 落点的圆点。`passed` = 在当前档位的左边或就是当前档位（已走过的部分）。 */
      toleranceDot: (active, passed) => ({
        width: active ? "14px" : "10px",
        height: active ? "14px" : "10px",
        borderRadius: "50%",
        border: active ? "2px solid #818cf8" : "1px solid rgba(128,128,128,.45)",
        background: active
          ? "rgba(99,102,241,.85)"
          : passed
            ? "rgba(128,128,128,.42)"
            : "transparent",
        transition: "width .12s ease, height .12s ease, background .12s ease",
        boxSizing: "border-box",
      }),
      /**
       * 落点标签：当前档位高亮，其余淡出。
       *
       * `whiteSpace: nowrap` 是硬约束——中文标签一旦允许换行，窄容器下会
       * 变成「轻 / 松」两行，四个段互相叠压，整个控件就读不出顺序了。
       */
      toleranceLabel: (active) => ({
        fontSize: active ? "12px" : "11px",
        fontWeight: active ? 600 : 400,
        color: active ? "#818cf8" : "inherit",
        opacity: active ? 1 : 0.58,
        whiteSpace: "nowrap",
        lineHeight: 1.35,
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
      /**
       * 图表容器（见 `chartBox`）。
       *
       * `minWidth: 0` 是必须的：这些图表画在 flex 布局的行里，
       * 默认的 `min-width: auto` 会让 SVG 撑破容器而不是收缩。
       */
      chartBox: {
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "middle",
        lineHeight: 0,
        minWidth: 0,
      },
      /**
       * 圆环图例的一行：色块 + 名称 + 占比。
       *
       * 名称用 `ellipsis` 而不是换行：决策点名字长度不一，换行会让各行
       * 高度参差，色块在视觉上对不齐，读者反而更难跟着颜色找行。
       */
      chartLegendRow: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "11px",
        lineHeight: 1.5,
        minWidth: 0,
      },
      /**
       * 图例项（可点击的按钮）：色块 + 名称 + 占比。
       *
       * 做成按钮是因为它是**可操作控件**（切换该决策点是否参与圆环），
       * 键盘与读屏用户必须能用。样式上刻意压成「一行文字」而不是按钮外观：
       * 它属于图例，不该抢走圆环的注意力；hover 时才给一点底色提示可点。
       */
      chartLegendBtn: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        width: "100%",
        padding: "2px 4px",
        margin: 0,
        border: 0,
        borderRadius: "4px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "11px",
        lineHeight: 1.5,
        textAlign: "left",
        cursor: "pointer",
      },
      /** 图例色块：与圆环同色（由调用方按索引给出 `--mc-cat-N`）。 */
      chartLegendSwatch: {
        flex: "none",
        width: "9px",
        height: "9px",
        borderRadius: "2px",
      },
      /**
       * 横向排序条：一行一项（名称 / 条 / 数值 / 占比）。
       *
       * 用网格而不是 flex：名称列与数值列必须**等宽对齐**，否则每行的
       * 条形起点参差，长度就没法横向比较——而那正是这张图唯一的用处。
       */
      chartRankList: {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        marginTop: "8px",
        position: "relative",
      },
      chartRankRow: {
        display: "grid",
        // 名称自适应（最少 84px）→ 条形占满剩余 → 数值/占比按内容宽。
        gridTemplateColumns: "minmax(84px, 1.1fr) minmax(60px, 2.4fr) auto auto",
        alignItems: "center",
        gap: "8px",
        fontSize: "11px",
        lineHeight: 1.4,
      },
      /** 名称列：单行省略，避免长模型名把条形挤没了。 */
      chartRankLabel: {
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: 0.85,
      },
      /** 条形槽：底色是「满格」，于是条与满格之差就是差距。 */
      chartRankTrack: {
        display: "block",
        position: "relative",
        height: "9px",
        borderRadius: "3px",
        background: "rgba(128,128,128,.18)",
        overflow: "hidden",
      },
      /** 条形本体：宽度由调用方按比例给。 */
      chartRankBar: {
        display: "block",
        height: "100%",
        borderRadius: "3px",
        transition: "width .2s ease",
      },
      /** 数值列：等宽数字，右对齐，方便上下串着读。 */
      chartRankValue: {
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
        whiteSpace: "nowrap",
        minWidth: "42px",
      },
      /** 占比列：次要信息，压暗。 */
      chartRankShare: {
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
        whiteSpace: "nowrap",
        minWidth: "38px",
        opacity: 0.55,
      },
      /** 图表位的空态文案（没有数据时替代图形，而不是留一块空白）。 */
      chartEmpty: {
        fontSize: "11px",
        opacity: 0.5,
        lineHeight: 1.5,
        padding: "4px 0",
      },
      /**
       * 走势区块：一整行的趋势图，上方一行小标题说明它画的是什么。
       *
       * 三块（请求量 / token / 耗时）竖排而不是横排：横排时每块只剩
       * 八十来像素宽，走势会被压成噪声；竖排各占一整行，起伏才看得出。
       */
      chartTrendBlock: {
        marginTop: "10px",
        padding: "8px 10px",
        borderRadius: "7px",
        border: "1px solid rgba(128,128,128,.18)",
        background: "rgba(128,128,128,.04)",
      },
      chartTrendLabel: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "8px",
        fontSize: "11px",
        opacity: 0.65,
        marginBottom: "2px",
      },
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
      // —— 决策历史（DEC-022）：会话标签页的样式 ——
      /**
       * 标签页容器：**一个普通块级盒子，自己不滚，也不裁溢出**。
       *
       * 这一版是**修正**。上一版写成 `height:100%` + flex 列 + `overflow:hidden`，
       * 想「让表格自己滚、工具条固定」。真机上表头根本不粘，三条原因叠在一起：
       *
       *   1. **`height:100%` 在这里拿不到参照高度**。这个 view 挂在宿主的
       *      `conversation.view` 槽位里，而宿主那条布局链是
       *      `flex:1 0 auto; min-height:auto`——**会一直长到内容高度**。
       *      「是 flex 就能用 height:100%」这个假设只在父级高度确定时成立；
       *      父级不确定时 `height:100%` 退化成 `auto`，于是我的内层滚动区
       *      永远长到全部内容高度、永远不产生自己的滚动条。
       *   2. **于是真正滚的是宿主的容器**。`position:sticky` 只认「最近的
       *      滚动祖先」——宿主那个容器才是滚动容器。我的 `th` 粘的是一个
       *      从不滚动的内层盒子，表现就是「跟着一起滚走」。
       *   3. **`overflow:hidden` 会吃掉 sticky**。它把本元素变成 sticky 的
       *      裁剪/滚动祖先，sticky 子元素只会在它内部粘；而它高度等于内容
       *      高度、又从不滚动，于是粘性彻底失效。
       *
       * 但**不能反过来只靠宿主滚动**：sticky 认「最近的滚动祖先」，而宿主
       * 那条链里只要有任何一层是 `overflow:hidden`（宿主布局的常见写法），
       * 粘性就被那一层吃掉——表现同样是「表头跟着一起滚走」。宿主内部结构
       * 我看不到、也不该赌。
       *
       * 所以现在是第三条路：**自己造一个一定会滚的容器**，给它视口相关的
       * `maxHeight`（见 `decisionsScroll`）而不是 `height:100%`：
       *
       *   - `height:100%` 要父级有确定高度，而宿主那条链会**长到内容高度**，
       *     于是它退化成 auto，内层永远不出滚动条，等于没设；
       *   - `maxHeight: calc(100vh - Npx)` 与父级高度**无关**，块级盒自己
       *     算得出来，内容一超就自己滚。sticky 于是总能找到一个真会滚的祖先。
       *
       * 也不学 dsh-retrace 用 `ResizeObserver` 量高度：那条路要读
       * `window.innerHeight`、监听 resize、还必须在 flex 环境里手工改
       * `flex:none`——为「表头别滚走」引入一整套尺寸编排，反而成了以后最
       * 容易坏的地方（宿主布局一改就失效）。
       */
      decisionsWrap: {
        maxWidth: "860px",
        boxSizing: "border-box",
        padding: "16px 20px",
        fontSize: "13px",
        // 刻意**不写** overflow / height：这一层一旦变成滚动或裁剪祖先，
        // 表头就改粘它，而它从不滚动，粘性等于没写。
      },
      /**
       * 决策历史页上的人工审核比例面板（DEC-035）。
       *
       * 与工具条一起放在滚动区之外：滑块不该跟着表格滚走——用户往下翻记录
       * 时正是最容易想改档位的时候。
       *
       * 用一条虚线框把它与工具条分开：这两块说的是不同的事（「这一页在看什么」
       * 与「聊天被问多频繁」），不加边框时滑块看起来像工具条的一部分。
       */
      decisionsTolerance: {
        marginBottom: "12px",
        padding: "9px 11px",
        borderRadius: "8px",
        border: "1px dashed rgba(128,128,128,.28)",
        background: "rgba(128,128,128,.04)",
      },
      /**
       * 列表的滚动容器：**表头粘的就是这一层**。
       *
       * 用 `maxHeight` 而非 `height:100%`，理由见 `decisionsWrap` 的注释。
       *
       * 高度写成 `max(160px, 100vh - 200px)` 而不是裸 `100vh - 200px`：
       * 窗口很矮时后者会变成**零甚至负数**，列表直接看不见。用 CSS `max()`
       * 兜一个下限，同时避免另一种写法 `minHeight` 的副作用——那会在只有一
       * 两行记录时于表格下方强行留出一片空白。
       *
       * 200px 是给宿主 chrome（标题栏 / tab 栏 / 本页内边距）留的余量。
       */
      decisionsScroll: {
        maxHeight: "max(160px, calc(100vh - 200px))",
        overflowY: "auto",
      },
      /** 明细表：左对齐为主（内容列要能读）。 */
      decisionsTable: {
        width: "100%",
        /**
         * **必须 `separate`，不能 `collapse`。**
         *
         * `border-collapse: collapse` 会让表头单元格的 `position:sticky`
         * 在 Chrome / Safari 上**直接失效**（边框被合并到表格元素上，单元格
         * 不再是独立的粘性盒子）。这是 sticky thead 最常见的坑，也是上一版
         * 表头不粘的直接原因之一。改成 `separate` 后每格自己的
         * `borderBottom` 照常显示，视觉不变。
         */
        borderCollapse: "separate",
        borderSpacing: 0,
        fontSize: "11px",
      },
      /**
       * 表头单元格：粘在 `decisionsScroll` 的顶部。
       *
       * 三个条件缺一个就不生效：
       *
       *   1. `top: 0` —— 粘到滚动容器上沿；
       *   2. 最近的滚动祖先**必须真的会滚** —— 由 `decisionsScroll` 的
       *      `maxHeight + overflowY:auto` 保证，且它上面（`decisionsWrap`）
       *      刻意不设 overflow，不去截胡；
       *   3. 背景**不透明** —— 否则下面的行会从表头底下透上来。
       *
       * 刻意**不用 `opacity` 压低文字**：`opacity` 作用在整个元素上，会连
       * 背景一起变半透明，正好破坏第 3 条。改用次要文字色令牌把文字压暗，
       * 背景走基色令牌，浅色/深色主题都对。
       *
       * `zIndex` 要给足：宿主的行/卡片有自己的层级，低了会被盖住。
       */
      decisionsTh: {
        textAlign: "left",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.28)",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        position: "sticky",
        top: 0,
        zIndex: 5,
        background: "var(--dsw-alias-bg-base, #1b1b1b)",
        // 表头可点排序：光标与「不选中文字」给出可点的暗示。
        cursor: "pointer",
        userSelect: "none",
      },
      decisionsTd: {
        textAlign: "left",
        padding: "5px 6px",
        borderBottom: "1px solid rgba(128,128,128,.12)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
        verticalAlign: "top",
      },
      /** 可点击展开的那一行。 */
      decisionsRow: {
        cursor: "pointer",
      },
      /**
       * 新增行的入场动画（DEC-044）。
       *
       * **只在「这一批比上一批多出来的行」上叠这一条**，已有行一律不带——
       * 每 5 秒轮询一次，整页重绘时若也带上动画，用户看到的会是整页在闪。
       *
       * 动画本体（`@keyframes`）写在注入的 `<style>` 里（见
       * `ensureRowEnterCss`）：内联样式能写 `animation`，但**写不出**
       * `@keyframes`，两者必须分开落地。
       */
      decisionsRowEnter: {
        animation: `${DECISION_ROW_ENTER_KEYFRAMES} 300ms ease-out both`,
      },
      /** 展开后的详情块：等宽字体 + 允许换行（内容可能是长 JSON）。 */
      decisionsDetail: {
        margin: "6px 0 10px",
        padding: "10px 12px",
        borderRadius: "7px",
        border: "1px solid rgba(128,128,128,.22)",
        background: "rgba(128,128,128,.04)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11px",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        maxHeight: "420px",
        overflowY: "auto",
      },
      /** 空态 / 提示行。 */
      decisionsEmpty: {
        padding: "18px 4px",
        fontSize: "12px",
        opacity: 0.65,
        lineHeight: 1.7,
      },
      /** 裁决词的小标签。 */
      decisionsVerdict: (color) => ({
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: "9px",
        fontSize: "10px",
        border: `1px solid ${color}`,
        color,
        whiteSpace: "nowrap",
      }),
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
      /**
       * 统计页容器：与配置页一样**不设最大宽度**（DEC-040）。
       *
       * 原来的 1000px 是为了「比配置页的 620px 宽——对比表有十来列」，但它同样
       * 落在一个 `overflowY: auto` 的盒子上，于是超过 1000px 的部分也得左右拖。
       * 十列表格现在直接吃满宿主给的宽度；两张表还各自包在 `overflowX: auto`
       * 里，窗口很窄时依然可以自己滚，不会因为放开限制而被裁掉。
       */
      statsWrap: {
        maxWidth: "none",
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
      /**
       * 审批卡正文（DEC-042）：接管 `conversation.approval.detail` 之后的样式。
       *
       * 宿主原来把 `args.command` 原文直接塞进一个等宽块（`.ImxglW_command`），
       * 样式是 `word-break: break-all` 且**没有** `white-space: pre-wrap`——
       * 换行被折叠，一条十几行的 heredoc 脚本于是糊成一整块不可读的墙。
       *
       * 这里的取舍：
       *   - 摘要区用普通正文字体（不是等宽）：它是给人读的导读，不是要照抄的命令；
       *   - 原文区用等宽 + `white-space: pre-wrap`（**保留换行**）+ `word-break:
       *     break-word`（长 URL 之类的超长 token 仍然不撑破容器）+ 限高滚动；
       *   - 默认**收起**原文：卡片的默认高度从「满屏」降到几行，想核对的人点开。
       */
      approvalSummary: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        marginTop: "2px",
      },
      approvalSummaryLine: {
        fontSize: "13px",
        lineHeight: 1.5,
        opacity: 0.85,
      },
      /** 危险动作提示：用警示色，但要能与正文区分开（不改字号）。 */
      approvalDanger: {
        color: "var(--dsw-alias-state-warn-primary, #d9822b)",
        fontWeight: 600,
      },
      /** 步骤清单：每条一行，前面一个小圆点。 */
      approvalStepList: {
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
      },
      approvalStep: {
        display: "flex",
        gap: "6px",
        alignItems: "baseline",
        fontSize: "12px",
        lineHeight: 1.5,
      },
      approvalStepText: {
        fontFamily: "var(--ds-font-family-code)",
        fontSize: "12px",
        wordBreak: "break-word",
      },
      approvalToggle: {
        alignSelf: "flex-start",
        padding: "2px 0",
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontSize: "12px",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        cursor: "pointer",
      },
      /**
       * 原文区。三个属性缺一不可：
       *   `whiteSpace: pre-wrap` —— 保住换行（宿主原来最致命的那一点）；
       *   `wordBreak: break-word` —— 长 token 不撑破容器（不用 `break-all`，
       *     那会把单词从中间劈开，比现在更难读）；
       *   `maxHeight` + `overflowY: auto` —— 长命令也不把卡片撑满屏。
       */
      approvalRaw: {
        marginTop: "4px",
        padding: "8px 10px",
        borderRadius: "6px",
        background: "var(--dsw-specific-input-major, rgba(128,128,128,.08))",
        color: "var(--dsw-alias-label-tertiary, inherit)",
        fontFamily: "var(--ds-font-family-code)",
        fontSize: "12px",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: "220px",
        overflowY: "auto",
        boxSizing: "border-box",
      },
    };
    /** 统一 fetch：带 content-type、no-store，并把错误转成可展示文本。 */
    /* ============================================================
       审批卡正文可读化（DEC-042）：宿主 detail 块内的命令归纳。

       这段实现与 `lib/approval-detail.js` **逐字同源**（那边是 Node 侧
       单测入口，这边是浏览器 bundle 里真正跑的那份）。为什么内联：client
       bundle 的 `require` 只解析 shell 的共享模块表，加载不了本包的其它
       文件，所以这里必须有一份实体实现。

       同源性由 `test/approval-detail.test.js` 的「两份实现逐字一致」用例守住。
       ============================================================ */
    /**
     * 审批卡正文那块命令的可读化：**把一条 shell 命令拆成能读的几条**。
     *
     * ## 为什么需要这个模块
     *
     * 宿主审批卡（`conversation.approval.detail`）只把 `args.command` 原文原样
     * 放进一个等宽字体块里，样式是 `word-break: break-all` 且**没有**
     * `white-space: pre-wrap`——换行全被折叠。于是一条十几行的 `python3 - <<'PY'`
     * 会把整张卡撑成一坨既不分行、也看不出在干什么的墙。
     *
     * 我们接管那个 slot 之后就能自己渲染，但「能读」不等于「格式化好看」：
     * 用户真正想知道的是**这条命令都做了哪些事、其中哪些是危险动作**。
     * 决策端点只有 choice / score / noul 三种题型、没有自由文本，所以这件事
     * 不能交给小模型，只能在这里用**确定性**的切分规则做。
     *
     * ## 设计上的三条原则
     *
     * 1. **绝不改写原文**：摘要只是「在原文之上加一层导读」，原文必须能原样展开
     *    看到。用户按「允许」之后真正执行的是原文，摘要与原文不一致就是欺骗。
     * 2. **宁可少说，不要乱说**：切分只看确定的结构（换行、`;`、`&&`、`||`、
     *    管道、heredoc 包裹），猜不到的一律不猜。识别不出的部分归到最后一段，
     *    而不是假装它是某条命令。
     * 3. **纯函数**：不发请求、不读文件、不碰 DOM。所以它能在 Node 里单测，
     *    也能被 client bundle 直接引用。
     *
     * @module dsh-decision-engine/client (inlined)
     */

    /** 一条命令最多列几条摘要；超出的合并成「还有 N 条」。 */
    const MAX_SUMMARY_STEPS = 12;

    /** 每条摘要最多显示多少个字符，超出截断。 */
    const MAX_STEP_CHARS = 72;

    /**
     * 危险动作的识别规则：命中即给该条摘要标一个警示级别。
     *
     * 这些判断刻意**粗**——它们是提示，不是判据。真正的拦截在守卫的
     * `decideGuard()` 里，这里只负责让用户一眼看到「这条命令里有 rm -rf」。
     *
     * 顺序有意义：先匹配更高危的规则，同一条命令只取最严重的那级。
     */
    const DANGER_RULES = [
      {
        // 递归删除、强删、磁盘级写：破坏性最强。
        level: "high",
        pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$\w+|\*)/,
      },
      { level: "high", pattern: /\b(?:mkfs|dd\s+if=|>\/dev\/sd)\b/ },
      { level: "high", pattern: /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/ },
      // 把远端内容直接交给 shell 执行：等价于执行任意代码。
      { level: "high", pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/ },
      // 提权。
      { level: "medium", pattern: /\bsudo\b/ },
      // 覆盖面大的批量移动 / 删除。
      { level: "medium", pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/ },
      { level: "medium", pattern: /\bmv\s+.*\s+(?:\/|~)(?:\s|$)/ },
      // 进程 / 服务级改动。
      { level: "medium", pattern: /\b(?:kill|killall|pkill|shutdown|reboot)\b/ },
      // 会改仓库/系统状态、但不是破坏性的。
      { level: "low", pattern: /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-zA-Z]*f)\b/ },
      { level: "low", pattern: /\b(?:pip|npm|pnpm|yarn|cargo|gem|brew)\s+(?:install|add|uninstall|remove)\b/ },
      { level: "low", pattern: /\b(?:apt|apt-get|yum|dnf|apk)\s+(?:install|remove|update|upgrade)\b/ },
    ];

    /**
     * 危险级别的排序权重（数字越大越严重）。
     * @param level - 级别 id。
     * @returns 权重。
     */
    function dangerWeight(level) {
      if (level === "high") return 3;
      if (level === "medium") return 2;
      if (level === "low") return 1;
      return 0;
    }

    /**
     * 判断一条命令片段的危险级别。
     * @param text - 单条命令片段。
     * @returns 最严重的级别 id，或 null（没命中任何规则）。
     */
    function dangerLevelOf(text) {
      const value = typeof text === "string" ? text : "";
      let worst = null;
      for (const rule of DANGER_RULES) {
        if (rule.pattern.test(value) && dangerWeight(rule.level) > dangerWeight(worst)) {
          worst = rule.level;
        }
      }
      return worst;
    }

    /**
     * 压成一行：把连续空白折叠成单个空格，去掉首尾空白。
     * @param text - 任意文本。
     * @returns 单行文本。
     */
    function oneLine(text) {
      return String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }

    /**
     * 把一段超长文本截断到 `MAX_STEP_CHARS`。
     * @param text - 单行文本。
     * @returns 截断后的文本。
     */
    function clip(text) {
      if (text.length <= MAX_STEP_CHARS) return text;
      return `${text.slice(0, MAX_STEP_CHARS - 1)}…`;
    }

    /**
     * 找出「被包裹起来的整段脚本」：heredoc、`python3 -c "…"`、引号内的长字符串。
     *
     * 这类命令的重点不是它内部的语法，而是**它在执行一段多行脚本**——所以摘要
     * 应该说「执行 python 脚本（N 行）」，而不是把脚本正文当成几条命令切开。
     *
     * @param command - 原始命令。
     * @returns `{kind, lines}`，不是整段脚本时返回 null。
     */
    function wrappedScriptOf(command) {
      // heredoc：`<<'PY'` / `<<-"EOF"` 等，正文在下一个分隔符行之间。
      const heredoc = command.match(/<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (heredoc !== null) {
        const marker = heredoc[2];
        const bodyStart = command.indexOf("\n", heredoc.index);
        const bodyEnd = bodyStart < 0 ? -1 : command.indexOf(marker, bodyStart);
        const body = bodyStart < 0 ? "" : command.slice(bodyStart, bodyEnd < 0 ? undefined : bodyEnd);
        const lines = body.split("\n").filter((line) => line.trim().length > 0).length;
        return { kind: "heredoc", lines };
      }
      // 单行的 `python3 -c "…"` / `sh -c "…"`：也算「执行一段脚本文本」。
      if (/\b(?:python[0-9.]*|node|ruby|perl|sh|bash|zsh)\s+-[cce]\b/.test(command) && command.includes("\n")) {
        const lines = command.split("\n").filter((line) => line.trim().length > 0).length;
        return { kind: "inline-script", lines };
      }
      return null;
    }

    /**
     * 把一条 shell 命令切成若干「步骤」。
     *
     * 切分只看**确定的分隔符**：换行、`;`、`&&`、`||`、`|`。引号与括号内部
     * 的分隔符不切（否则 `echo "a; b"` 会被错误地拆成两条）。heredoc 的正文
     * 整段保留，因为它是同一个命令的输入——但**摘要里只留它的开头一行**：
     * 「python3 - <<'PY'」本身已经说明了一切，把那 4 行脚本正文压缩进一条摘要
     * 只会重新变成一坨不可读的东西（正文在展开态里照原样显示）。
     *
     * 刻意**不**做完整的 shell 解析：真正的解析要处理转义、变量展开、子 shell、
     * 函数定义……那是一整个 parser 的工作量，而这里只需要一个「大致看清有几步」
     * 的导读。切不准时宁可把剩余部分并成一条。
     *
     * @param command - 原始命令文本。
     * @returns 步骤数组：`{text, line}`，line 是它大致来自第几行（1 起）。
     */
    function stepsOf(command) {
      const source = typeof command === "string" ? command : "";
      if (source.trim().length === 0) return [];

      const steps = [];
      let buffer = "";
      let line = 1;
      let bufferLine = 1;
      // 引号状态：单引号、双引号各一个开关；heredoc 另算（见下）。
      let inSingle = false;
      let inDouble = false;
      let heredocMarker = null;
      /** heredoc 命中时，它开头那一行的文本（摘要要留这一行）。 */
      let heredocHeader = "";

      const flush = () => {
        const text = oneLine(buffer);
        if (text.length > 0) steps.push({ text, line: bufferLine });
        buffer = "";
      };

      for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];

        // heredoc：从命中 `<<'X'` 到分隔符行，整段不切。
        if (heredocMarker === null) {
          const rest = source.slice(index);
          const heredocMatch = rest.match(/^<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
          if (heredocMatch !== null && !inSingle && !inDouble) {
            heredocMarker = heredocMatch[2];
            // 记下「本步骤到 heredoc 标记为止」的文本作为摘要；正文丢掉。
            buffer += heredocMatch[0];
            heredocHeader = buffer;
            index += heredocMatch[0].length - 1;
            continue;
          }
        } else {
          if (char === "\n") {
            line += 1;
            // 日分隔符单独成行才算结束。
            const lineEnd = source.indexOf("\n", index + 1);
            const currentLine = source.slice(index + 1, lineEnd < 0 ? undefined : lineEnd).trim();
            if (currentLine === heredocMarker) {
              // 整段脚本结束：把「开头一行」作为这一步的摘要，正文不进去。
              buffer = heredocHeader;
              heredocMarker = null;
              heredocHeader = "";
              flush();
              // 跳过正文与分隔符行，避免它们进入下一步骤。
              index = lineEnd < 0 ? source.length - 1 : lineEnd - 1;
              bufferLine = line;
              continue;
            }
          }
          // 正文一律不写进 buffer（它由 summarizedCommand 的 script.lines 计数）。
          continue;
        }

        if (char === "\n") {
          flush();
          line += 1;
          bufferLine = line;
          continue;
        }
        if (char === "'" && !inDouble) {
          inSingle = !inSingle;
          buffer += char;
          continue;
        }
        if (char === '"' && !inSingle) {
          inDouble = !inDouble;
          buffer += char;
          continue;
        }
        // 只在引号外切分。`;` 与 `&&` / `||` / `|` 都是步骤边界。
        if (!inSingle && !inDouble) {
          const isPipeline = char === "|" && next === "|";
          const isAnd = char === "&" && next === "&";
          const isPipe = char === "|" && !isPipeline;
          if ((char === ";" || isAnd || isPipeline || isPipe) && buffer.trim().length > 0) {
            flush();
            if (isAnd || isPipeline) index += 1;
            bufferLine = line;
            continue;
          }
          // 开头就是分隔符（例如 `; ls`）时丢掉它，不要产生空步骤。
          if (char === ";" || isAnd || isPipeline || isPipe) continue;
        }
        buffer += char;
      }
      // 收尾：heredoc 没找到结束标记时（命令被截断），把开头一行留下。
      if (heredocMarker !== null) buffer = heredocHeader;
      flush();
      return steps;
    }

    /**
     * 归纳一条命令：步骤清单 + 危险标记 + 是否整段脚本。
     *
     * 危险级别算**两次**：一次对整条原文（`danger`），一次对每个步骤（`steps[].danger`）。
     * 为什么不能只算步骤：像 `curl https://x.sh | sh` 这种「把远端脚本喂给 shell」的
     * 形态，切分后会变成 `curl https://x.sh` 与 `sh` 两条，单独看哪条都无害——
     * 危险恰恰在它们的**组合**里。所以整条原文必须单独过一遍规则。
     *
     * @param command - 原始命令文本。
     * @returns `{steps, script, danger, total, truncated, lines, dangerCount}`：
     *   - `steps`：`{text, line, danger}` 数组（已按 MAX_SUMMARY_STEPS 截断）；
     *   - `script`：整段脚本的识别结果（`{kind, lines}` 或 null）——它决定标题怎么措辞；
     *   - `danger`：**整条命令**最严重的危险级别（null = 没命中任何规则）；
     *   - `total`：切出来的总步骤数（未截断前）；
     *   - `truncated`：是否因为条数上限被截断；
     *   - `lines`：原文行数；
     *   - `dangerCount`：带危险标记的步骤数（整条命中而步骤都没命中时至少为 1）。
     */
    function summarizeCommand(command) {
      const source = typeof command === "string" ? command : "";
      const script = wrappedScriptOf(source);
      const raw = stepsOf(source);
      const total = raw.length;
      const kept = raw.slice(0, MAX_SUMMARY_STEPS);
      const steps = kept.map((step) => ({
        text: clip(step.text),
        line: step.line,
        danger: dangerLevelOf(step.text),
      }));
      const danger = dangerLevelOf(source);
      const flagged = steps.filter((step) => step.danger !== null).length;
      return {
        steps,
        script,
        danger,
        total,
        truncated: total > MAX_SUMMARY_STEPS,
        lines: source.split("\n").length,
        dangerCount: flagged === 0 && danger !== null ? 1 : flagged,
      };
    }



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
     * 滑块落点上的**短标签**（只有档位名）。
     *
     * 为什么不在落点上带语义尾注（「轻松（只问最前 1%）」）：
     *
     *   - 落点上带尾注时，四段等宽，每段只剩标签本身那点宽度：当年容器还限死
     *     620px，每段只有 ~140px，「轻松（只问最前 1%）」放不下，只能换行或溢出，
     *     而换行会让四个段叠成一团（真机上就是这么坏的）。容器如今不限宽
     *     （DEC-040），但这条不翻案：窗口窄的时候它照样成立。
     *   - 尾注只对**当前档位**有意义：用户要确认的是「我选的这档到底多频繁」，
     *     另外三档的具体比例在他点过去之后才知道就行了。
     *
     * 因此尾注移到轨道**下方那行说明**里（见 toleranceActiveSummary），
     * 落点上只留档位名——这也是分段控件的常规形态。
     *
     * @param preset - 服务端下发的一档元数据。
     * @returns 档位名（已过语言）。
     */
    function toleranceShortLabel(preset) {
      return tr(preset.label ?? preset.id ?? "");
    }

    /**
     * 当前档位的**语义尾注**（轨道下方一行）。
     *
     * 只写「轻松」用户看不出它比默认更少打扰还是更多，所以这一行必须说清
     * 「只问最前 1%」。比例由 `percentile` 算，因此加一档只改 tolerance.js。
     *
     * @param preset - 当前档位元数据。
     * @returns 带比例的说明；不按比例的档位返回其 summary。
     */
    function toleranceActiveSummary(preset) {
      if (preset === null || preset === undefined) return "";
      if (preset.percentile === null || preset.percentile === undefined) {
        return tr(preset.summary ?? "");
      }
      const percent = Math.round((1 - preset.percentile) * 100);
      return t("当前档位只问最前 {percent}% 的调用", { percent });
    }

    /**
     * 人工审核比例滑块——**配置页与决策历史页共用这一个组件**（DEC-035）。
     *
     * 两处放同一个控件不是重复：用户看到「刚才又问我了」的地方（决策历史）
     * 正是他想调频率的地方，而配置页是「这个插件的设定」的正式入口。
     *
     * 组件只做渲染与回调，**不自己发请求**：两处的保存链路完全不同
     * （配置页走自动保存 flush，决策历史页没有那条链路），把 IO 留在调用方，
     * 这个组件才能在两个上下文里都用得上。
     *
     * @param props.tolerance - 服务端下发的 `tolerance` 对象。
     * @param props.level - 当前生效档位（草稿优先）。
     * @param props.onSelect - `(level) => void`，用户点了一个落点。
     * @param props.disabled - 是否禁用（保存进行中）。
     * @param props.compact - 紧凑模式（决策历史页的头部空间更紧）。
     */
    function ToleranceSlider(props) {
      const data = props?.tolerance ?? null;
      const presets = Array.isArray(data?.presets) ? data.presets : [];
      const levels = Array.isArray(data?.levels) && data.levels.length > 0
        ? data.levels
        : presets.map((item) => item.id);
      const current = typeof props?.level === "string" ? props.level : data?.level ?? "default";
      const index = Math.max(0, levels.indexOf(current));
      const calibration = data?.calibration ?? null;

      if (levels.length === 0) return null;

      const stops = levels.map((id, i) => {
        const preset = presets.find((item) => item.id === id)
          ?? { id, label: id, labelEn: id, percentile: null };
        const active = id === current;
        return h(
          "button",
          {
            type: "button",
            key: `tol-${id}`,
            disabled: props?.disabled === true,
            title: tr(preset.summary ?? ""),
            "aria-pressed": active,
            onClick: () => {
              if (active || props?.disabled === true) return;
              props?.onSelect?.(id);
            },
            style: S.toleranceStop(active, i <= index),
          },
          h("span", { style: S.toleranceDot(active, i <= index) }),
          h("span", { style: S.toleranceLabel(active) }, toleranceShortLabel(preset)),
        );
      });

      /**
       * 校准脚注：只在「这一档真的按比例走」时才说分位数。
       *
       * 自治 / 默认两档不按比例（`percentile === null`），此时说「校准中」
       * 会让用户以为它还没生效——而它本来就该用模型自己的判断。
       */
      let note = "";
      if (calibration !== null && typeof calibration === "object") {
        const preset = presets.find((item) => item.id === current);
        if (preset?.percentile === null || preset?.percentile === undefined) {
          note = current === "autonomous"
            ? t("自治档不按比例：从不询问用户")
            : t("这一档沿用决策模型自己的判断，不需要校准");
        } else if (calibration.ready === true && typeof calibration.threshold === "number") {
          note = t("已按这个模型校准：最前的 {percent}% ≈ 严重度 {threshold}（{samples} 个样本）", {
            percent: Math.round((1 - preset.percentile) * 100),
            threshold: calibration.threshold.toFixed(3),
            samples: calibration.samples ?? 0,
          });
        } else {
          note = t("校准中 {samples}/{min} 次授权决策（当前用冷启动阈值 {fallback}）", {
            samples: calibration.samples ?? 0,
            min: calibration.minSamples ?? 50,
            fallback: typeof calibration.fallbackSeverity === "number"
              ? calibration.fallbackSeverity.toFixed(2)
              : "—",
          });
        }
      }

      const activePreset = presets.find((item) => item.id === current) ?? null;
      const activeSummary = toleranceActiveSummary(activePreset);

      return h(
        "div",
        { style: { marginTop: props?.compact === true ? "6px" : "4px" } },
        h(
          "div",
          { style: S.toleranceTrack },
          h("span", { style: S.toleranceRail }),
          ...stops,
        ),
        // 当前档位的语义（带比例）：它取代了原本挤在落点上的尾注。
        activeSummary.length > 0
          ? h("div", { style: { ...S.pointHint, marginTop: "8px", opacity: 0.78 } }, activeSummary)
          : null,
        note.length > 0
          ? h("div", { style: { ...S.pointHint, marginTop: "3px", opacity: 0.55 } }, note)
          : null,
        // 两条总则合成一行：拆成两行会在配置页占掉太多纵向空间，而它们
        // 是「前提」而不是「主信息」，挤在一行里读起来仍然成立。
        h(
          "div",
          { style: { ...S.pointHint, marginTop: "3px", opacity: 0.42 } },
          t("分位数窗口按 provider × model 分开，换模型会重新校准；高风险调用一律直接拦下（四档一致）"),
        ),
      );
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
        // 思考模式总是提交：它是全局项（与 provider 无关），服务端还会再校验一次。
        thinkMode: draft.thinkMode ?? "never",
        // 匿名统计档位也总是提交。
        //
        // 这一项此前**漏在这里**，同时也没进服务端的 PUT 白名单，于是那个
        // 下拉能点、能显示「已保存」，但值从来没落盘——用户以为关掉了统计，
        // 实际每天照发。隐私开关静默失效是最严重的一类问题，这里补上。
        telemetryLevel: draft.telemetryLevel ?? "daily",
        // 模型只写当前 provider 自己那一格（字段名叫什么由 fields 给）。
        // 混写会让「切过去再切回来」丢掉原值，也会把 bamboonode 的模型名
        // 发给别的服务。
        [modelFields.modelField]: (draft[modelFields.modelField] ?? "").trim(),
        provider: provider.provider,
        customEndpointStyle: provider.customEndpointStyle ?? "auto",
        // 决策历史（DEC-022）：这个开关**总是**提交（不是「只在改过时提交」）。
        //
        // 为什么总是提交：它是「关掉就不再记录」的性质，服务端读到
        // 什么就按什么执行。若只在改动时提交，那么「服务端是关、界面显示关」
        // 之后用户碰别的字段触发一次保存，patch 里没有这个键，服务端仍
        // 保持关——这是对的；反过来「服务端是开、界面显示开」也没问题。
        // 真正需要小心的是**默认值**：服务端 DEFAULTS 是 true，配置文件里
        // 可能根本没有这一项。因此提交**生效值**（而不是 undefined），
        // 保证「界面上看到的状态」与「落盘的状态」永远一致。
        decisionsTabEnabled: draft.decisionsTabEnabled !== false,
        // 审批卡正文可读化（DEC-042 / DEC-043）：与决策历史同款——**总是**提交
        // 生效值。服务端 DEFAULTS 现在是 true，配置文件里可能没写这一项，
        // 「没写」等于「开」，所以这里必须按 `!== false` 折算：否则拨了开关也会
        // 因为 patch 里是这个键的 undefined 而被服务端当成没提交。
        approvalDetailReadable: draft.approvalDetailReadable !== false,
        // 跟随服务端下发（DEC-030）：与上面的决策历史同款——**总是**提交
        // 生效值，而不是「只在改过时提交」。
        //
        // 为什么总是提交：服务端读到什么就按什么执行（开着就取下发值、关着
        // 就用本地手动配置）。若只在改动时提交，那么「服务端是关、界面显示关」
        // 之后用户碰别的字段触发一次保存，patch 里没有这个键，服务端仍保持关
        // ——这是对的；但配置文件里可能根本没有这一项（服务端默认关），
        // 提交 undefined 会让「界面显示的状态」与「落盘的状态」在一段时间内
        // 不一致。提交 `=== true` 得到的是确定的布尔值，两种状态都对得上。
        serverProvider: draft.serverProvider === true,
        // 人工审核比例（DEC-035）：与上面两个开关同款——**总是**提交生效值。
        //
        // 为什么总是提交：配置文件里可能根本没有这一项（服务端默认 `default`），
        // 提交 undefined 会让「界面显示的档位」与「落盘的档位」在一段时间内
        // 不一致。档位是离散字符串，回填一个确定的取值，两种状态都对得上。
        //
        // 没拿到服务端下发的档位元数据时（首帧、接口失败）**不提交**：
        // 此时 `draft.tolerance` 也是 undefined，硬塞一个 `default` 会把用户
        // 已经存好的「自治」覆盖掉——那正是「保存后档位回弹」的来源。
        ...(typeof draft.tolerance === "string" ? { tolerance: draft.tolerance } : {}),
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
        ["thinkMode", view.thinkMode ?? "never"],
        // 匿名统计档位：与生效值比，否则改档位不会触发保存。
        ["telemetryLevel", view.telemetryLevel ?? "daily"],
        ["provider", view.provider ?? "bamboonode"],
        ["customBaseUrl", view.customBaseUrl ?? ""],
        ["customEndpointStyle", view.customEndpointStyle ?? "auto"],
        ["customHeaders", view.customHeaders ?? ""],
        ["customApiKeyEnv", view.customApiKeyEnv ?? ""],
        ["keyStorage", view.keyStorage ?? "credentials"],
        // 决策历史（DEC-022）：与服务端的生效值比。服务端回传的是
        // `cfg.decisionsTabEnabled !== false` 这种**生效值**（不是原值），
        // 因此这里与它比是对的。
        ["decisionsTabEnabled", view.decisionsTabEnabled !== false],
        // 审批卡正文可读化（DEC-042 / DEC-043）：同样是生效值比较（缺省 = 开），
        // 否则拨了开关不触发保存。
        ["approvalDetailReadable", view.approvalDetailReadable !== false],
        // 跟随服务端下发（DEC-030）：与服务端回传的**生效值**比（服务端回
        // `enabled === true` 归一化后的布尔值），否则拨开关不会触发保存。
        ["serverProvider", view.serverProvider?.enabled === true],
        // 人工审核比例（DEC-035）：与服务端的生效值比，否则点滑块不触发保存。
        ["tolerance", view.tolerance?.level ?? "default"],
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

    /**
     * ISO 串显示成本地「YYYY-MM-DD HH:mm:ss」，给决策历史的「时间」列用。
     *
     * 与上面的 `formatLocalTime` 是两个用途：那个渲染统计页的区间边界（分钟
     * 粒度足够），这个渲染逐条决策的流水——**必须带秒**，因为同一次工具调用
     * 链里的几条决策可能落在同一分钟，省掉秒会让它们看起来同时发生。
     *
     * 为什么要专门写一个：这里原来只是把 ISO 串切一刀
     * （`ts.replace("T"," ").replace(/\.\d+Z$/,"")`），看着像本地时间，其实
     * 显示的是 **UTC 挂钟**——用户看到的时间与自己差 8 小时（2026-11-03 反馈
     * 「时间是 UTC，切换为运行环境本地时间」）。ISO 串必须经 `Date` 解析后
     * 用本地取值器渲染，才真的是本地时间。
     */
    function formatLocalDateTime(iso) {
      const ms = Date.parse(String(iso ?? ""));
      if (Number.isNaN(ms)) return "";
      const d = new Date(ms);
      const pad = (v) => String(v).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * 毫秒时间戳显示成本地「MM-DD HH:mm」。
     *
     * 与 `formatLocalTime` 同一显示习惯，区别只在入参：那个收 ISO 串
     * （统计区间的服务端值），这个收毫秒数（服务端下发值的 `fetchedAt`）。
     * 不引任何日期库：两个 `pad` 就够了。
     */
    function formatLocalMs(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return "";
      const d = new Date(n);
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
    * 裁决词 → 颜色。
    *
    * 颜色只是辅助：**不能只靠颜色区分**（色觉障碍用户看不到）。因此每个裁决词
    * 本身也写在标签里，颜色只是让它一眼可辨。
    *
    * 配色规则（用户要求「区分大一些」，2026-11-03）：
    *
    *   1. **一个裁决词一个色相**，不再让 delegate / allow / keep 共用绿色、
    *      stop / inline / skip 共用灰色——共用色相时「扫一眼」读不出区别，
    *      而这个页面的全部用途就是扫一眼看出哪几次被拦了。
    *   2. **语义上靠近的放同族色**：放行类（allow / keep / delegate）落在
    *      绿—青—蓝这一段，改写行为类（switch / redirect / advise / prune /
    *      summarize / continue）落在紫—粉段，中性不动作（stop / inline /
    *      skip / translate）落在灰—棕段，`ask` / `deny` / `degraded` 三个
    *      「要人看一眼」的独占橙 / 红 / 主文本色。
    *   3. **全部取 400–500 明度的浅色**：面板常年跑在深色主题上，深色在这个
    *      底上等于看不见。
    *
    * `degraded` 特例：用户要的是「黑色」，但纯黑在深色主题下不可读。这里用
    * 主题的**主文本色令牌**——浅色主题下它就是黑，深色主题下自动翻成浅色，
    * 语义（最中性、不带任何色相的一种状态）保住，可见性也保住。
    */
    const VERDICT_COLORS = {
      // —— 放行族 ——
      allow: "#22c55e",            // 绿：通过
      keep: "#2dd4bf",             // 青绿：保留原模型
      delegate: "#3b82f6",         // 蓝：交给主模型
      // —— 改写行为族 ——
      switch: "#0ea5e9",           // 天蓝：换模型
      redirect: "#8b5cf6",         // 紫：改用别的技能
      advise: "#d946ef",           // 品红：建议分派
      prune: "#a3e635",            // 黄绿：只裁剪工具结果
      summarize: "#fb923c",        // 浅橙：走摘要压缩
      continue: "#c084fc",         // 淡紫：续一轮
      translate: "#f472b6",        // 粉：需要翻译
      // —— 中性：什么都不改 ——
      stop: "#94a3b8",             // 灰蓝：收束本轮
      inline: "#9ca3af",           // 灰：自己接着做
      skip: "#eab308",             // 黄：跳过（不检索 / 不翻译）
      // —— 要人看一眼的三种 ——
      ask: "#f59e0b",              // 橙：升级人工确认
      deny: "#ef4444",             // 红：拦截
      degraded: "var(--dsw-alias-label-primary, #111111)", // 主文本色（浅色主题=黑）
    };

    /** 裁决词的兜底颜色：未登记的词用它，不至于看起来像出了错。 */
    const DEFAULT_VERDICT_COLOR = "#64748b";

    /**
     * 裁决词 → 中文名。
     *
     * 裁决词是**机器词**：`action` 字段写进明细文件、上报遥测、出现在
     * `detail` 的原因串里，全都是这个英文词。界面此前把它**原样**摆在
     * 「裁决」列，于是中文界面里这一列整片是英文（`delegate` / `inline` /
     * `advise` …），而它左右两列都是中文——中文用户读这张表时，最需要
     * 一眼读懂的恰恰就是这一格。
     *
     * 做法：**只在渲染边界换成中文**，数据一个字节都不动。
     *
     *   - 中文名同时登记进 `EN_LABELS`（值 = 机器词本身），所以英文界面
     *     经 `tr()` 翻回的正是原来那个词——英文界面与改前逐字一致，
     *     「英文零中文」那条断言不受影响。
     *   - 原始机器词仍然挂在 `title` 上：要对照明细文件、日志或
     *     `/session-decisions` 响应时，鼠标停上去就是那个词。
     *   - 词表与 `VERDICT_COLORS` 一一对应（同 16 个词），
     *     `test/client-decisions-view.test.js` 断言两表键集相同——
     *     新增裁决词时漏了哪一张表都会立刻变红，而不是悄悄掉回英文。
     *
     * 中文名沿用 `VERDICT_COLORS` 注释里那套说法（「交给主模型」「自己接着做」
     * 「改用别的技能」…），不另发明一套术语：那张注释已经是这套词的口径。
     */
    const VERDICT_LABELS = {
      // —— 放行族 ——
      allow: "照常放行",
      keep: "保留原模型",
      delegate: "交给主模型",
      // —— 改写行为族 ——
      switch: "换模型",
      redirect: "改用别的技能",
      advise: "建议分派",
      prune: "裁剪结果",
      summarize: "摘要压缩",
      continue: "续一轮",
      translate: "翻译",
      // —— 中性：什么都不改 ——
      stop: "收束本轮",
      inline: "自己接着做",
      skip: "跳过",
      // 让位（DEC-045）：这一轮在等用户决定，插件主动退出，不代替用户选。
      defer: "让位给用户",
      // —— 要人看一眼的三种 ——
      ask: "转人工确认",
      deny: "拒绝执行",
      // 与「标记」列的「已降级」刻意不同词：那一列说的是**这次请求**降级了，
      // 这一格说的是**这次根本没有裁决**（统计里它进「未裁决」那一格）。
      degraded: "降级未裁决",
    };

    /**
     * 一条明细记录的稳定标识。
     *
     * 服务端（`DecisionStore.readForSession`）一定会补齐 `id`，这里再兜一层，
     * 防止夹具或老服务端没带。
     *
     * **不能用 `seq` 当标识**：它只是服务端的**进程内**计数器，DSH 每重启一次
     * 就从 1 重数——实测用户的明细文件里 307 条记录只有 119 个不同的 `seq`。
     * 拿它当 React `key` 会造成重复 key，事件处理器被对到错的行上：真机现象
     * 就是「点第二个，展开的是第三个」（2026-11-03）。
     */
    function entryIdOf(entry, index) {
      if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
      return `${entry?.ts ?? ""}#${entry?.seq ?? index}`;
    }

    /**
     * 决策历史表格的列定义。
     *
     * `key` 同时是**排序键**与 React key 的一部分，`label` 走 `t()`。
     * 每一列都可点：用户要的是「表头每一个都能排序」。
     */
    const DECISION_COLUMNS = [
      { key: "ts", label: "时间" },
      { key: "point", label: "决策点" },
      { key: "provider", label: "提供方" },
      { key: "model", label: "模型" },
      { key: "action", label: "裁决" },
      { key: "latencyMs", label: "耗时" },
      // 「内容」列回答的是**这次到底存没存内容**：有内容(1) → 只有元数据(0)。
      //
      // 它此前渲染的是「缓存命中 / 已降级」标记——表头叫「内容」，排的却又是
      // 有没有内容，名与实与排序键三样对不上（DEC-028 也把这两件事混写了）。
      // 缓存/降级标记是**另一件事**，单独给一列「标记」（DEC-029）。
      { key: "capture", label: "内容" },
      // 「标记」列：缓存命中 / 已降级。排序值按状态分组（无 → 已降级 → 缓存），
      // 让「哪几次花了钱、哪几次是降级放行」各自聚在一起。
      { key: "flags", label: "标记" },
    ];

    /** 取一条记录在某一列上的排序值。 */
    function decisionSortValue(entry, key, pointLabels) {
      switch (key) {
        case "ts":
          return String(entry?.ts ?? "");
        case "point": {
          const id = String(entry?.point ?? "");
          // 按**显示名**排，不按内部 id：用户看到的是中文名，
          // 按 id 排会出现「工具授权 / 检索必要性 / 轮次延续」乱序。
          return String(pointLabels[id] ?? id);
        }
        case "provider":
          return String(entry?.provider ?? "");
        case "model":
          return String(entry?.model ?? "");
        case "action": {
          const word = String(entry?.action ?? "");
          // 按**显示名**排，不按机器词：这一列现在写的是中文，按英文词排
          // 会出现「放行类被 adv/allow/deny 的字母序打散」。与「决策点」列同
          // 一口径；机器词未登记时退回原词，不会排成空串。
          return String(VERDICT_LABELS[word] ?? word);
        }
        case "latencyMs":
          return Number(entry?.latencyMs) || 0;
        case "capture":
          return entry?.capture === "meta" ? 0 : 1;
        case "flags":
          // 无 = 0 / 已降级 = 1 / 缓存命中 = 2：升序把同一状态聚在一起。
          if (entry?.cached === true) return 2;
          if (entry?.degraded === true) return 1;
          return 0;
        default:
          return "";
      }
    }

    /**
     * 按列排序记录。
     *
     * 同值时**退回时间升序、再退回原始顺序**：列表每 5 秒会被轮询刷新，
     * 如果同值行每次渲染都在彼此之间跳，用户读到一半就会串行。稳定的
     * 次级键比「看起来更随机」重要。
     *
     * 一个例外（DEC-044）：主键本身就是「时间」时，原始顺序这一档**跟着主键
     * 方向走**。`ts` 只到毫秒，同一毫秒里可以有好几条记录（存储层正是为此
     * 才留了进程内 `seq`）；默认降序时若把它们排成写入顺序升序，一批同时
     * 发生的记录就会与整列的方向反着。
     */
    function sortDecisionEntries(entries, sort, pointLabels) {
      const key = DECISION_COLUMNS.some((column) => column.key === sort?.key) ? sort.key : "ts";
      const direction = sort?.dir === "desc" ? -1 : 1;
      return entries
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => {
          const a = decisionSortValue(left.entry, key, pointLabels);
          const b = decisionSortValue(right.entry, key, pointLabels);
          const primary = typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b));
          if (primary !== 0) return primary * direction;
          const byTime = String(left.entry?.ts ?? "").localeCompare(String(right.entry?.ts ?? ""));
          if (byTime !== 0) return byTime;
          return (left.index - right.index) * (key === "ts" ? direction : 1);
        })
        .map((item) => item.entry);
    }

    /**
     * 把任意值序列化成可读文本。
     *
     * 循环引用之类的问题不该让整页崩掉——序列化失败时给一句话说明。
     */
    function safeJson(value) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }

    /**
     * 审批卡正文：接管宿主的 `conversation.approval.detail` 槽位（DEC-042）。
     *
     * ## 宿主原来给了什么
     *
     * 审批卡上，标题下面是宿主的 `ApprovalCommand` 渲染的一块等宽文本：它按
     * `callId` 从 chat 快照里找到那次工具调用，取出 `args.command` **原样**
     * 显示。样式是 `word-break: break-all` 且**没有** `white-space: pre-wrap`，
     * 于是换行被折叠——一条十几行的 `python3 - <<'PY'` 会糊成一整块既不分行、
     * 也看不出在做什么的墙。截图里真实出现过。
     *
     * ## 我们接管后要做到的三件事
     *
     * 1. **摘要**：用 `summarizeCommand()` 把命令切成步骤，列出「这条命令有
     *    几步、其中几步是危险动作」。决策端点只有 choice / score / noul 三种
     *    题型、没有自由文本，所以这件事只能确定性做，不能问小模型。
     * 2. **原文保真**：展开态里显示的仍是 `args.command` 的**原文**，只是
     *    换行不再被折叠（`pre-wrap`）、长 token 不撑破容器（`break-word`）、
     *    并且限高滚动。摘要与原文不一致就是欺骗——用户按「允许」后真正执行
     *    的是原文。
     * 3. **默认收起**：卡片的默认高度从「满屏」降到几行，需要核对的人再展开。
     *
     * ## 为什么命令原文要自己从 chat 快照里捞
     *
     * 宿主是这么做的（`ApprovalCommand`：按 `callId` 找 `tool-call` 节点、
     * 取 `argsRaw` 再 `JSON.parse` 出 `command`）。我们注册在同一个 session
     * 作用域，`ctx.uiSession.provide({ hooks: ["chat"] })` 把 `useChat` 合成到
     * 每个 session-scope entry 上（`standardHookPropName("chat") === "useChat"`），
     * 所以这里拿得到**同一个**快照源。
     *
     * `useChat` 拿不到（宿主改版、或别的组合没有 chat）：不抛，退化成只显示
     * 摘要那一行占位——卡片照常能用，最坏情况等于原来什么都没做。
     *
     * @param props.callId - 本次审批关联的工具调用 id（宿主给的）。
     * @param props.useChat - session 作用域合成的 chat 快照选择器钩子。
     */
    function ApprovalDetailView(props) {
      const callId = typeof props?.callId === "string" ? props.callId : "";
      const useChat = props?.useChat;
      /**
       * 从 chat 快照里捞这条调用的命令原文。
       *
       * 与宿主 `commandOf()` 同一条路：遍历节点找 `callId` 匹配、`phase ===
       * "start"` 的 tool-call，解析 `argsRaw` 取 `command`。任何一步失败都返回
       * undefined——这是展示层，不能因为拿不到原文就把审批卡搞崩。
       */
      const readCommand = () => {
        if (callId.length === 0 || typeof useChat !== "function") return undefined;
        try {
          // 没有 useChat 的合成上下文时（例如 Node 渲染测试），宿主会直接
          // 把值传进来，这里统一次调用形态。
          const snapshot = useChat((value) => value);
          const nodes = snapshot?.nodes;
          if (nodes === null || typeof nodes !== "object" || typeof nodes.values !== "function") return undefined;
          for (const node of nodes.values()) {
            const root = node?.kind === "tool-call" ? node.data?.root : undefined;
            if (root === undefined || root.callId !== callId || "kind" in root || root.phase !== "start") continue;
            const args = JSON.parse(root.argsRaw);
            if (typeof args?.command === "string" && args.command.length > 0) return args.command;
          }
        } catch {
          return undefined;
        }
        return undefined;
      };
      const command = readCommand();
      /** 展开态：默认收起原文（DEC-042 的第三条）。 */
      const [open, setOpen] = react.useState(false);
      // 拿不到原文：什么都不改，把这一步交还给宿主的默认渲染。
      if (command === undefined) return null;

      const result = summarizeCommand(command);
      const parts = [];
      if (result.script === null) {
        parts.push(t("{steps} 个步骤", { steps: result.total }));
      } else if (result.script.kind === "heredoc") {
        parts.push(t("执行一段脚本（{lines} 行）", { lines: result.script.lines }));
      } else {
        parts.push(t("执行一段内联脚本（{lines} 行）", { lines: result.script.lines }));
      }
      if (result.danger !== null) {
        parts.push(t(" · 含 {count} 个危险动作", { count: result.dangerCount }));
      }
      if (result.truncated) {
        parts.push(t(" · 另有 {count} 个步骤未展开", { count: result.total - MAX_SUMMARY_STEPS }));
      }

      return h(
        "div",
        { style: S.approvalSummary },
        h(
          "div",
          { style: S.approvalSummaryLine },
          h("strong", null, t("命令摘要")),
          t("：{summary}", { summary: parts.join("") }),
        ),
        h(
          "div",
          { style: S.approvalSummaryLine },
          t("自动归纳，仅供参考；真正执行的是下方原文"),
        ),
        result.steps.length > 0 && !open
          ? h(
              "ul",
              { style: S.approvalStepList },
              result.steps.map((step, index) =>
                h(
                  "li",
                  { style: S.approvalStep, key: `step-${index}` },
                  h("span", { style: { opacity: 0.5 } }, `${index + 1}.`),
                  h("span", { style: S.approvalStepText }, step.text),
                  step.danger !== null
                    ? h("span", { style: S.approvalDanger }, t("含危险动作"))
                    : null,
                ),
              ),
            )
          : null,
        h(
          "button",
          {
            type: "button",
            style: S.approvalToggle,
            onClick: () => setOpen(!open),
          },
          open ? t("收起原文") : t("展开原文"),
        ),
        open ? h("div", { style: S.approvalRaw }, command) : null,
      );
    }

    /**
     * 决策历史视图（会话里的「决策历史」标签页）。
     *
     * 挂在 `conversation.view` 槽位上，与内置的「对话」「轨迹」并排。
     * 数据来自 `/api/decision-engine/session-decisions`——**按会话过滤**，
     * 因此这里只会看到本会话的记录。
     *
     * ## 为什么这个组件不引入类组件、也不依赖 error boundary
     *
     * 宿主把我们的组件渲染在**它自己的 React 树**里。一个抛异常的组件会
     * 把整个会话区搞挂——那比「决策历史显示不出来」严重得多。
     *
     * 因此这里不引入 `class extends React.Component`：本插件的测试桩只有
     * `createElement/useState/useCallback/useRef/useEffect/useMemo`，类组件
     * 会直接把 `test/client-ui.test.js` 与 `test/client-i18n.test.js` 打挂。
     * 改成「所有数据派生都包 try/catch + 渲染失败就退化成一张静态说明卡」，
     * 效果等价，且不破坏测试环境。
     *
     * @param props.sessionId - 当前会话 id（`conversation.view` 的标准 prop）。
     * @param props.pointLabels - 决策点 id → 中文名。
     */
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
       * 而登记之后立刻会有一次重绘——300ms 的动画被掐在第 3 帧里，用户看到的仍然
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
      }, []);

      /**
       * 把一条记录渲染成行。
       *
       * **整体包 try/catch**：任何一条记录格式不对（老版本文件、手工改过）
       * 都不该让整页崩掉——跳过那一条即可。
       *
       * @param entry - 记录。
       * @param index - 在**当前顺序**里的位置（只用于 id 兜底）。
       * @param isNew - 这条是这一轮刚出现的（DEC-044）：叠一条入场动画。
       */
      const renderRow = (entry, index, isNew = false) => {
        try {
          // 行身份用 `id`（全局唯一），**不是 `seq`**（进程内计数器，重启后
          // 会与旧记录撞车）。重复 key 会让点击落到错的行上。
          const id = entryIdOf(entry, index);
          const action = typeof entry?.action === "string" ? entry.action : "";
          const color = VERDICT_COLORS[action] ?? DEFAULT_VERDICT_COLOR;
          const point = typeof entry?.point === "string" ? entry.point : "";
          const time = typeof entry?.ts === "string" ? entry.ts : "";
          // 本地时间（不是 UTC 挂钟）：见 formatLocalDateTime 的说明。
          const local = formatLocalDateTime(time);
          return h(
            "tr",
            {
              key: `row-${id}`,
              // 新增行叠一条入场动画；已有行**不带**这条样式，否则每 5 秒
              // 一次的整页重绘会变成整页闪动。
              style: isNew ? { ...S.decisionsRow, ...S.decisionsRowEnter } : S.decisionsRow,
              onClick: () => setExpanded(expanded === id ? null : id),
            },
            h("td", { style: S.decisionsTd }, local),
            h("td", { style: S.decisionsTd }, pointLabels[point] ?? point),
            h("td", { style: S.decisionsTd }, entry?.provider ?? ""),
            h("td", { style: S.decisionsTd }, entry?.model ?? ""),
            h(
              "td",
              { style: S.decisionsTd },
              action.length > 0
                ? h(
                    "span",
                    // `title` 留**原始机器词**：明细文件与遥测里就是它，
                    // 需要对照时停一下鼠标就能看到。
                    { style: S.decisionsVerdict(color), title: action },
                    VERDICT_LABELS[action] ?? action,
                  )
                : "",
            ),
            h("td", { style: S.decisionsTd }, `${Number(entry?.latencyMs) || 0}ms`),
            // 「内容」列：这次到底存没存内容。判据是 `capture` 字段——
            // `meta` 只可能来自超限裁剪（DEC-029 之后没有「只记元数据」的档位）。
            h(
              "td",
              { style: S.decisionsTd },
              entry?.capture === "meta" ? t("仅元数据") : t("有内容"),
            ),
            // 「标记」列：缓存命中 / 已降级（与「内容」是两件事，见 DECISION_COLUMNS）。
            //
            // 降级不能只写「已降级」：用户扫表时要能直接看出这次请求是 404 还是 401。
            // 这里把降级原因（detail，如 http-404 / auth-failed）与 HTTP 状态码一并写出；
            // 排序走 decisionSortValue 的 0/1/2 分组、不依赖本列文本，故不影响排序。
            // 失败原因也仍保留在展开后的详情里。
            h(
              "td",
              { style: S.decisionsTd },
              entry?.cached === true
                ? t("缓存命中")
                : entry?.degraded === true
                  ? (() => { const dt = entry?.detail, st = entry?.status; const base = dt && String(dt).length > 0 ? t("已降级") + " · " + String(dt) : t("已降级"); return (typeof st === "number" && st > 0 && !(dt && String(dt).includes(String(st)))) ? base + " (HTTP " + st + ")" : base; })()
                  : "",
            ),
          );
        } catch {
          // 单条记录渲染失败：返回空行，不影响其余记录。
          return h("tr", { key: `bad-${index}` }, h("td", { style: S.decisionsTd }, "—"));
        }
      };

      /**
       * 展开后的详情：裁决原因、现场、问题、回答、分数。
       *
       * `entry.detail` 是**原始审计文本**（服务端写的中文原因），不是界面
       * 文案，因此**原样输出、不过 t()**——它是记录的一部分，翻译它等于
       * 篡改审计记录。这也是「英文界面零中文」断言里唯一允许残留中文的
       * 位置（它是数据，不是 UI）。
       */
      const renderDetail = (entry) => {
        try {
          const content = entry?.content ?? null;
          const scores = entry?.scores ?? null;
          const parts = [];
          if (entry?.detail !== undefined && String(entry.detail).length > 0) {
            parts.push(`${t("内容")}\n${String(entry.detail)}`);
          }
          if (content !== null && typeof content === "object") {
            if (content.state !== undefined) {
              parts.push(`${t("内容")}\n${safeJson(content.state)}`);
            }
            if (content.questions !== undefined) {
              parts.push(`${t("问题")}\n${safeJson(content.questions)}`);
            }
            if (content.answers !== undefined) {
              parts.push(`${t("回答")}\n${safeJson(content.answers)}`);
            }
          }
          if (scores !== null && typeof scores === "object") {
            parts.push(`${t("分数")}\n${safeJson(scores)}`);
          }
          // 只有**真的没有内容**时才说「只存了元数据」。判据是 `capture`
          // 字段与 content 是否存在——不能拿「parts 为空」当判据：一条只带
          // 裁决原因、没存 state 的记录不是「只有元数据」，直接说会误导。
          const metaOnly =
            entry?.capture === "meta" || (content === null || content === undefined);
          if (metaOnly) {
            parts.push(t("这条记录只保存了元数据（未保存决策内容）"));
          }
          return h("div", { style: S.decisionsDetail }, parts.join("\n\n"));
        } catch {
          return h("div", { style: S.decisionsDetail }, t("这条记录只保存了元数据（未保存决策内容）"));
        }
      };

      // `entries` 在上面「新增行的入场动画」那一节之前已备好（同一份 `page.entries`）。
      if (sessionId.length === 0) {
        return h(
          "div",
          { style: S.decisionsWrap },
          h("div", { style: S.decisionsEmpty }, t("该插件的决策历史已在设置里关闭")),
        );
      }

      /**
       * 人工审核比例（DEC-035）：**决策历史页也要有**。
       *
       * 为什么放在这个页面：用户是在这里看到「刚才又问我了」的，于是想调
       * 频率的那个瞬间就在这个页面。让他为此切到插件配置页，等于承认这两处
       * 说的是同一件事却要跳一次。
       *
       * 数据来自 `page.tolerance`（`/session-decisions` 下发，服务端与配置页
       * 用的是同一个 `tolerancePayload()`，因此两处永远一致）。
       *
       * 这里**直接 PUT `/config`**（档位唯一的写入口），不做防抖——点一下就是
       * 一次明确的决定，没有「打字打到一半」的中间态。
       */
      const currentTolerance = toleranceDraft ?? page?.tolerance ?? null;
      const toleranceBlock =
        currentTolerance === null || page?.tolerance === undefined || page?.tolerance === null
          ? null
          : h(
              "div",
              { style: { ...S.decisionsTolerance, key: "tolerance-panel" } },
              h(
                "div",
                { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                h(
                  "span",
                  { style: { fontSize: "12px", fontWeight: 600 } },
                  t("人工审核比例"),
                ),
                toleranceSaving
                  ? h("span", { style: { fontSize: "11px", opacity: 0.6 } }, t("保存中…"))
                  : null,
                toleranceError.length > 0
                  ? h(
                      "span",
                      { style: { fontSize: "11px", color: "#f87171" } },
                      toleranceError,
                    )
                  : null,
              ),
              ToleranceSlider({
                tolerance: page.tolerance,
                level: currentTolerance.level ?? page.tolerance.level,
                disabled: toleranceSaving,
                compact: true,
                onSelect: (level) => {
                  // 先落草稿（界面立刻跟手），再发请求；失败时退回服务端值。
                  setToleranceDraft({ ...page.tolerance, level });
                  setToleranceError("");
                  setToleranceSaving(true);
                  void (async () => {
                    try {
                      await call("/config", {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ tolerance: level }),
                      });
                      // 成功后重新取一页：档位可能与服务端归一化的结果不同，
                      // 且校准信息（阈值、样本数）在档位切换后会变。
                      await load();
                    } catch (cause) {
                      setToleranceError(
                        t("保存失败：{error}", {
                          error: cause instanceof Error ? cause.message : String(cause),
                        }),
                      );
                      // 退回服务端值：不能显示一个实际没落盘的档位。
                      setToleranceDraft(null);
                    } finally {
                      setToleranceSaving(false);
                    }
                  })();
                },
              }),
            );

      /**
       * 头部 = 人工审核比例面板（DEC-036 之后**只剩**这一块）。
       *
       * 原先这里还有一排「会话 xxx · 共 N 条决策 · 刷新」——用户明确要求删掉
       * 整排：会话名对一个「只显示本会话」的页面是废话，条数每 5 秒自己变、
       * 刷新也有轮询兜着。删掉后列表直接顶到页首，纵向空间全留给记录。
       *
       * 一次包成 `header`（而不是几条返回路径各写一遍）：这个组件有四个
       * 提前 return（关闭 / 错误 / 加载中 / 空态），漏掉任何一处都会让滑块
       * 在某些状态下凭空消失——而「空态」恰恰是用户最想调低档位的那一刻。
       * 没有 tolerance 下发时整块不渲染，不留一个空的包裹层。
       */
      const header = toleranceBlock === null
        ? null
        : h(
            "div",
            { key: "toolbar" },
            toleranceBlock,
          );

      if (error.length > 0) {
        return h(
          "div",
          { style: S.decisionsWrap },
          header,
          h("div", { style: S.decisionsEmpty }, t("读取决策历史失败：{error}", { error })),
        );
      }
      if (loading && entries.length === 0) {
        return h("div", { style: S.decisionsWrap }, header, h("div", { style: S.decisionsEmpty }, "…"));
      }
      if (entries.length === 0) {
        return h(
          "div",
          { style: S.decisionsWrap },
          header,
          h("div", { style: S.decisionsEmpty }, t("本会话还没有决策记录")),
          h("div", { style: { ...S.decisionsEmpty, opacity: 0.5 } }, t("决策点都处于「关闭」时不会产生记录")),
        );
      }

      const rows = [];
      // 表格主体按**当前排序列**排；默认是「时间降序」（最新在上，DEC-044）。
      // 计数与展开判定都基于同一份顺序，避免出现「看的是排好的、
      // 点下去展开的是另一行」。
      const ordered = sortDecisionEntries(entries, sort, pointLabels);
      // 这一批里要播入场动画的记录（由 `load` 在取数时算出，与排序无关）。
      const newIdSet = new Set(Array.isArray(newIds) ? newIds : []);
      for (let index = 0; index < ordered.length; index += 1) {
        const entry = ordered[index];
        const id = entryIdOf(entry, index);
        rows.push(renderRow(entry, index, newIdSet.has(id)));
        // 展开的详情插在这条记录之后——表格里不能直接放 div，因此用
        // colspan 的行承载。
        //
        // 判定用的身份必须与 `renderRow` 里的**完全一致**（同一个 `entryIdOf`）：
        // 两处各算一套（曾经一处用 seq、一处用 index）就会出现「点这行、展开
        // 那行」的错位。
        if (expanded === id) {
          rows.push(
            h(
              "tr",
              { key: `detail-${id}` },
              h(
                "td",
                { style: { ...S.decisionsTd, whiteSpace: "normal", padding: "0 6px 8px" }, colSpan: 7 },
                renderDetail(entry),
              ),
            ),
          );
        }
      }

      return h(
        "div",
        { style: S.decisionsWrap },
        // 头部（人工审核比例）在滚动区之外：它不该跟着表格一起滚走。
        header,
        // 表头粘的就是这一层。它**一定会滚**（maxHeight 与父级高度无关），
        // 所以 `th { position: sticky }` 总能找到一个真正会滚的祖先，
        // 不必赌宿主那条链里有没有 `overflow:hidden`。
        h(
          "div",
          { style: S.decisionsScroll, key: "scroll" },
          h(
            "table",
            { style: S.decisionsTable },
            h(
              "thead",
              { key: "head" },
              h(
                "tr",
                { key: "tr" },
                // 每一列都可点排序。箭头只画在当前列上——否则「哪一列在起作用」
                // 只能靠猜。首次点某一列一律从**降序**起（DEC-044 与整页默认排序
                // 对齐）：时间列 = 最新在上，耗时列 = 最慢在上，文字列 = 从后往前。
                // 想反向再点一次。
                ...DECISION_COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  const arrow = active ? (sort.dir === "desc" ? " ↓" : " ↑") : "";
                  return h(
                    "th",
                    {
                      key: `th-${column.key}`,
                      style: S.decisionsTh,
                      title: t("按「{label}」排序", { label: t(column.label) }),
                      onClick: () => setSort(
                        active
                          ? { key: column.key, dir: sort.dir === "desc" ? "asc" : "desc" }
                          : { key: column.key, dir: "desc" },
                      ),
                    },
                    t(column.label) + arrow,
                  );
                }),
              ),
            ),
            h("tbody", { key: "body" }, rows),
          ),
          // 截断提示与文件路径放在表格之后、滚动区内：它们是表格的附注，
          // 跟着表格滚才自然（钉在外面会挤掉最后几行）。
          page?.truncated === true
            ? h("div", { style: S.statsNote }, t("还有更多记录没有显示"))
            : null,
          typeof page?.file === "string" && page.file.length > 0
            ? h("div", { style: S.meta }, t("记录文件：{path}", { path: page.file }))
            : null,
        ),
      );
    }

    /* ============================================================
     * 统计页的图型封装
     *
     * 这一层只做三件事，刻意不含任何统计口径：
     *   1. 把服务端给的字段**原样**喂给图型（不在这里重算、不四舍五入后再算）；
     *   2. 给每个图型一个可读的中文无障碍摘要（库默认是英文，读者会莫名其妙）；
     *   3. 统一尺寸与容器（统计页里图与数字并排，尺寸不一致会看到参差的基线）。
     *
     * 为什么不在渲染里内联 `charts.Sparkline({...})`：同一张图在统计页出现
     * 三处（走势、对比、节省），尺寸和摘要文案必须一致；散在三个地方写，
     * 改一次尺寸要改三处，很快就会有两处忘记改。
     * ============================================================ */

    /**
     * 图型容器：把图表包成一个 inline-flex 的中性盒子。
     *
     * `aria-hidden` **不加**——图型自己带 `role="img"` 与摘要，
     * 那是给读屏用户的正式内容，藏起来等于把图里的信息只留给看得见的人。
     */
    function chartBox(key, children, extra) {
      return h(
        "span",
        { key, className: "de-chart mc-theme", style: { ...S.chartBox, ...(extra ?? {}) } },
        children,
      );
    }

    /**
     * 走势图（单指标随时间）。
     *
     * 空数据 / 全零时**不画图**：一条贴底的直线会被读成「一直很平稳」，
     * 而事实是「这段时间没有请求」。两种情况必须分开——这正是本插件
     * 在统计口径上反复强调的那条原则（0 与「无数据」不是一回事）。
     *
     * @param charts - 图表模块。
     * @param values - 与 buckets 等长的数值序列。
     * @param options.label - 中文指标名（用于摘要与标题）。
     * @param options.width - 视口宽（默认 260，统计页卡片内的一整行）。
     */
    function renderTrend(charts, values, options) {
      const series = Array.isArray(values) ? values : [];
      const hasData = series.some((value) => Number(value) > 0);
      if (hasData !== true) {
        return h(
          "div",
          { key: `trend-empty/${options.label}`, style: S.chartEmpty },
          t("{label}：本区间没有数据", { label: options.label }),
        );
      }
      return chartBox(
        `trend/${options.label}`,
        h(charts.Sparkline, {
          data: series,
          width: options.width ?? 260,
          height: options.height ?? 34,
          fill: options.fill === true,
          dots: "auto",
          label: "none",
          // 中文摘要：库的默认摘要是英文（"Trending up 400%…"），
          // 在这个全中文的界面里会显得突兀，读屏用户也会困惑。
          summary: options.summary ?? `${options.label}走势`,
          title: options.label,
        }),
      );
    }

    /**
     * 占比构成条（allow / ask / reject）。
     *
     * 这三个数天然构成一个整数：每次裁决必然落在其中一格。用分段条
     * 而不是饼图是刻意的——饼在这么窄的卡片里角度差读不出来，而
     * 并排的分段条能直接比长度。
     *
     * 全零时不画：一条纯背景色的空条会让读者以为「裁决了但全是别的东西」。
     */
    function renderOutcomeBar(charts, outcomes) {
      const allow = Number(outcomes?.allow ?? 0);
      const ask = Number(outcomes?.ask ?? 0);
      const reject = Number(outcomes?.reject ?? 0);
      const total = allow + ask + reject;
      if (total <= 0) {
        return h(
          "div",
          { key: "outcome-bar/empty", style: S.chartEmpty },
          t("本区间没有裁决记录"),
        );
      }
      return chartBox(
        "outcome-bar",
        h(charts.SegmentedBar, {
          data: [
            { label: t("放行"), value: allow },
            { label: t("询问"), value: ask },
            { label: t("拦截"), value: reject },
          ],
          // 顺序固定成 allow→ask→reject（从绿到红），不按大小重排：
          // 这三格是**固定语义**而不是「谁多谁少」，重排会让同一格
          // 在不同区间换颜色，读者没法跨区间对比。
          order: "data",
          width: 260,
          height: 20,
          label: "percent",
          summary: t("裁决构成：放行 {allow}、询问 {ask}、拦截 {reject}", {
            allow: groupDigits(allow),
            ask: groupDigits(ask),
            reject: groupDigits(reject),
          }),
          title: t("裁决构成"),
        }),
      );
    }

    /**
     * 横向比较条（一个指标在若干组合之间的大小）。
     *
     * 为什么用 MiniBar 而不是给每行画一根独立进度条：MiniBar 共用一条
     * 比例尺，于是「A 是 B 的两倍」在图上真的表现为两倍长；每行独立的
     * 进度条各自归一化，长度差异不再有意义。
     *
     * @param items - `[{ label, value }]`，调用方已排好序。
     */
    /**
     * 横向排序条：每一项一行，含**名称 + 比例条 + 数值**。
     *
     * 为什么不用 `charts.MiniBar`：实测它在横向模式下
     *   - 不画任何标签（`label` 只有纵向的 `"max"` 一种），于是那些柱子
     *     只有长度、没有身份——读者不知道哪根是哪个 provider；
     *   - 每一条共用**同一套**填充色，无法按条上色；
     *   - 给单条数据配 `domain` 也不能得到「按比例的长条」（实测三条不同
     *     数值画出来都是满宽），因此没法把多根柱拼成一张对齐的图。
     * 结果就是用户看到的「一排白条，没有文字、没有比例」。
     *
     * 所以这里自己画：一行一个 flex 容器，条形宽度 = value / max，
     * 名称与数值直接写在行内。形状是内联 div 而不是 SVG——这一处的信息
     * 是「文字 + 一根条」，用 DOM 排版比拼 SVG 更简单可靠，也天然支持
     * 文本溢出省略与深色主题继承。
     *
     * @param items - `[{ label, value }]`，调用方给的是**已排序**的数组。
     */
    function renderRanking(charts, items, options) {
      const data = Array.isArray(items) ? items.filter((item) => Number(item.value) > 0) : [];
      if (data.length === 0) {
        return h(
          "div",
          { key: `rank-empty/${options.label}`, style: S.chartEmpty },
          t("{label}：本区间没有数据", { label: options.label }),
        );
      }
      /**
       * 比例尺上限取**最大值**，不是总和：这里回答的是「谁最大、彼此差多少」，
       * 按总和归一化会让所有条都缩到左侧一小截，反而看不出差距。
       */
      const max = data.reduce((top, item) => Math.max(top, Number(item.value)), 0) || 1;
      const total = data.reduce((sum, item) => sum + Number(item.value), 0);
      return h(
        "div",
        { key: `rank/${options.label}`, style: S.chartRankList },
        ...data.map((item, index) =>
          h(
            "div",
            { key: `rank-row/${item.label}/${index}`, style: S.chartRankRow },
            // 名称：固定一列宽，保证所有条形的起点对齐（对齐才能比长度）。
            h(
              "span",
              {
                style: S.chartRankLabel,
                title: item.label,
              },
              item.label,
            ),
            // 条形槽：底色是满格，里面一条按比例着色，于是「差多少」看得见。
            h(
              "span",
              { style: S.chartRankTrack },
              h("span", {
                style: {
                  ...S.chartRankBar,
                  width: `${Math.max(1, (Number(item.value) / max) * 100)}%`,
                  /**
                   * 颜色按索引循环取 `--mc-cat-N`，与圆环用同一套色序：
                   * 同一个 provider/model 在两处看到的是同一种颜色语义。
                   */
                  background: `var(--mc-cat-${(index % 6) + 1})`,
                },
              }),
            ),
            // 数值 + 占比：光有长度读不出具体数，两列都给。
            h(
              "span",
              { style: S.chartRankValue },
              options.format === "ms" ? formatMs(item.value) : groupDigits(item.value),
            ),
            h(
              "span",
              { style: S.chartRankShare },
              formatRatio(total > 0 ? Number(item.value) / total : 0),
            ),
          ),
        ),
        // 屏幕阅读器需要一句汇总：上面是纯视觉的条，读屏软件读不到长度。
        h(
          "span",
          { style: { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" } },
          options.summary ?? t("{label}对比：{parts}", {
            label: options.label,
            parts: data
              .map((item) => `${item.label} ${formatRatio(total > 0 ? Number(item.value) / total : 0)}`)
              .join("、"),
          }),
        ),
      );
    }

    /**
     * 按决策点分账的圆环图（含**必需的**文字图例）。
     *
     * 为什么用圆环而不是饼图：microcharts **故意不提供饼图**。官方文档把
     * 饼图列为「词级尺寸下不可读」的一类并给了替代品。圆环（micro-donut）
     * 是库给的折中——保住「一个整体切成几份」的直觉，洞用来放总数。
     *
     * 为什么必须自己补图例：这个图型**不画分块标签、也不生成图例**，
     * 只看颜色根本分不出哪块是哪个决策点。没有图例的圆环等于一张装饰画
     * ——有「形」没有「义」。图例与颜色**按同一个索引取色**（`cat-N`
     * 循环），所以读者按顺序对得上。
     *
     * 为什么颜色不交给库自己分配：库按数据顺序取 `--mc-cat-N`；如果我在
     * 组件里再 sort 一次而图例没跟着 sort，颜色和名字就会错位——那种错位
     * 不报错，只会让人把「上下文压缩」读成「工具授权」。所以这里先排序、
     * 再用**同一个数组**同时喂给图例与图型。
     *
     * @param items - `[{ label, value }]`，调用方给的是**已排序**的数组。
     * @param options.totalLabel - 环心总数的标题（如「请求」）。
     */
    function renderPointDonut(charts, items, options) {
      const all = Array.isArray(items) ? items.filter((item) => Number(item.value) > 0) : [];
      const hidden = options.hidden instanceof Set ? options.hidden : new Set();
      const onToggle = typeof options.onToggle === "function" ? options.onToggle : null;

      if (all.length === 0) {
        return h(
          "div",
          { key: `donut-empty/${options.totalLabel}`, style: S.chartEmpty },
          t("{label}：本区间没有数据", { label: options.totalLabel }),
        );
      }

      /**
       * **颜色按「决策点 id」固定分配，不按当前显示顺序分配。**
       *
       * 这是本功能能不能用的关键：如果颜色跟着「第几个可见项」走，用户
       * 隐藏掉「工具授权」之后，原本第二名的「模型路由」会从橙色变成绿色，
       * 第三名跟着变——每一次点击整张图换一套颜色，读者就再也无法在两次
       * 操作之间比较。颜色必须绑定在**实体**上（决策点 id），而不是绑在
       * 位置序号上。
       *
       * 索引取的是 `all`（完整列表，已按次数降序）里的位置，隐藏项也占位，
       * 所以同一个决策点在显示/隐藏之间切换时颜色不变。
       */
      const colorById = new Map();
      all.forEach((item, index) => {
        colorById.set(item.id ?? item.label, `var(--mc-cat-${(index % 6) + 1})`);
      });

      const visible = all.filter((item) => hidden.has(item.id ?? item.label) !== true);
      /**
       * 隐藏项可能把可见项清空：此时不能画一个空环（那会被读成「没有数据」），
       * 而应明确提示「你把所有决策点都排除了」——那是一个可撤销的操作结果，
       * 与「这段时间没有数据」是两件事。
       */
      if (visible.length === 0) {
        return h(
          "div",
          { key: `donut-allhidden/${options.totalLabel}`, style: S.chartEmpty },
          t("所有决策点都被隐藏了，点击下面的图例可以重新显示。"),
        );
      }

      /**
       * 占比的**分母跟着可见项走**。
       *
       * 这是隐藏功能的意义所在：排除「工具授权」之后，剩下几个点的占比
       * 应该重新归一到 100%，读者才能看出「它们之间」谁大谁小。若分母
       * 始终用全量总和，隐藏后留下的会是一堆 2%、3% 的小数——比例关系
       * 依然读不出来，功能就白做了。
       *
       * 同时把「被隐藏的部分占全量多少」单独算出来，在环心与提示里说明，
       * 免得读者以为看到的就是全集。
       */
      const visibleTotal = visible.reduce((sum, item) => sum + Number(item.value), 0);
      const allTotal = all.reduce((sum, item) => sum + Number(item.value), 0);
      const hiddenTotal = allTotal - visibleTotal;
      const hiddenCount = all.length - visible.length;

      return h(
        "div",
        {
          key: `donut/${options.totalLabel}`,
          /**
           * `mc-theme` **必须挂在这一层**，不能只挂在里面的 `chartBox` 上。
           *
           * `--mc-cat-N` 在 `.mc-theme` 作用域里被重新定义（接的是 DSH 的
           * 语义色）；图例的色块在这个 div 的子节点里，却在 chartBox 的
           * **外面**——只有这一层带 mc-theme，色块才与圆环取到同一套颜色。
           * 否则图例按库的默认调色板画、圆环按主题色画，同一个决策点会显示
           * 成两种颜色，读者对不上号（而且是静默错位：图上好看，只是错的）。
           */
          className: "mc-theme",
          style: { display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap", marginTop: "8px" },
        },
        chartBox(
          "donut-chart",
          h(charts.MicroDonut, {
            data: visible.map((item) => ({ label: item.label, value: Number(item.value) })),
            /**
             * 颜色显式按 id 传进去（顺序与 `data` 对齐）。
             *
             * 不传 `colors` 时库按「第几个」取 `--mc-cat-N`，隐藏一个点之后
             * 后面所有点的颜色都会前移一位——那正是上面说的「每次点击整张
             * 图换一套颜色」。显式传就把颜色钉在实体上。
             */
            colors: visible.map((item) => colorById.get(item.id ?? item.label)),
            size: 132,
            label: "total",
            /**
             * 不传 `weight`：实测这个参数只在**缺省**时取默认厚度（5），
             * 显式传任何值都会塌成 1px——环变成一根几乎看不见的细线。
             * 这是库的 bug，绕过方式是不传。
             */
            // 长尾不合并：决策点最多 8 个，全都该有自己的颜色与图例项。
            // 合并成 Other 会让「某个决策点到底花了多少」这个问题失去答案。
            maxWedges: 12,
            summary: t(
              "按决策点分账：{parts}",
              {
                parts: visible
                  .map((item) => `${item.label} ${formatRatio(visibleTotal > 0 ? Number(item.value) / visibleTotal : 0)}`)
                  .join("、"),
              },
            ),
            title: options.totalLabel,
          }),
        ),
        // ---- 图例：可点击切换，圆环没有它就等于没有信息 ----
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1 1 170px" } },
          ...all.map((item) => {
            const id = item.id ?? item.label;
            const isHidden = hidden.has(id) === true;
            /**
             * 占比始终相对**可见总量**显示，与圆环一致；隐藏项显示它自己
             * 的绝对值（次数），并附「已隐藏」——让读者知道这块被排除了、
             * 原值是多少，而不是让它凭空消失。
             */
            const share = visibleTotal > 0 ? Number(item.value) / visibleTotal : 0;
            return h(
              "button",
              {
                type: "button",
                key: `donut-legend/${id}`,
                /**
                 * 用 `<button>` 而不是带 onClick 的 `<div>`：图例项是**可操作的
                 * 控件**，键盘用户必须能用 Tab 走到、用 Enter/Space 触发。
                 * 用 div 就只能用鼠标，而且读屏软件不会念成「按钮」。
                 */
                onClick: onToggle === null ? undefined : () => onToggle(id),
                disabled: onToggle === null,
                title: isHidden
                  ? t("点击重新显示「{label}」", { label: item.label })
                  : t("点击隐藏「{label}」，方便查看其他决策点的比例", { label: item.label }),
                "aria-pressed": isHidden !== true,
                style: {
                  ...S.chartLegendBtn,
                  opacity: isHidden ? 0.4 : 1,
                },
              },
              h("span", {
                style: {
                  ...S.chartLegendSwatch,
                  background: colorById.get(id),
                  // 隐藏项留一个空心方块：颜色还在（提示「这是哪个点」），
                  // 但不再是实心（提示「它当前不在图里」）。
                  opacity: isHidden ? 0.35 : 1,
                },
                "aria-hidden": "true",
              }),
              h(
                "span",
                {
                  style: {
                    flex: "1 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textDecoration: isHidden ? "line-through" : "none",
                  },
                },
                item.label,
              ),
              h(
                "span",
                { style: { opacity: 0.6, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } },
                isHidden ? t("已隐藏") : formatRatio(share),
              ),
            );
          }),
        ),
        /**
         * 有隐藏项时把「被排除掉的那部分」写出来。
         *
         * 不给这句的话，读者看到的是一张看起来完整的圆环（重新归一化后
         * 依然是 100%），却不知道它只覆盖了全量的一部分——那是这页最容易
         * 被误读成「这就是全部」的地方。
         */
        hiddenCount > 0
          ? h(
              "div",
              { style: { flexBasis: "100%", fontSize: "11px", opacity: 0.6, marginTop: "2px" } },
              t("已隐藏 {count} 个决策点（占全量 {share}），图中的比例按剩余部分重新计算。", {
                count: hiddenCount,
                share: formatRatio(allTotal > 0 ? hiddenTotal / allTotal : 0),
              }),
            )
          : null,
      );
    }

    /**
     * 目标达成条（实际 vs 基线）。
     *
     * 节省量天然是这个形状：基线是「本该花多少」，实际是「真的花了多少」。
     * Bullet 把两个数画在同一条轴上，于是「省了多少」是**看得见的长度差**，
     * 而不是要心算的两个数字。
     */
    function renderSavingsBullet(charts, baseline, actual, label) {
      const base = Number(baseline ?? 0);
      const real = Number(actual ?? 0);
      if (base <= 0) {
        return h(
          "div",
          { key: `bullet-empty/${label}`, style: S.chartEmpty },
          t("{label}：没有可对比的基线", { label }),
        );
      }
      return chartBox(
        `bullet/${label}`,
        h(charts.Bullet, {
          value: real,
          target: base,
          domain: [0, Math.max(base, real)],
          width: 260,
          height: 20,
          label: "both",
          color: "currentColor",
          summary: t("{label}：实际 {real}，基线 {base}", {
            label,
            real: groupDigits(real),
            base: groupDigits(base),
          }),
          title: label,
        }),
      );
    }

    /**
     * 有符号变化（节省比例这类 +/- 数字）。
     *
     * `positive:"down"` 是刻意的：这里的 value 是「消耗相对基线的变化」，
     * 消耗下降才是好事，颜色语义必须跟着这个方向，否则「省了 30%」会
     * 被染成警示色。
     */
    function renderDelta(charts, value, label) {
      const number = Number(value ?? 0);
      if (!Number.isFinite(number) || number === 0) {
        return h(
          "div",
          { key: `delta-empty/${label}`, style: S.chartEmpty },
          t("{label}：本区间没有可对比的变化", { label }),
        );
      }
      return chartBox(
        `delta/${label}`,
        h(charts.Delta, {
          value: number,
          positive: "down",
          summary: t("{label}：{value}", {
            label,
            value: formatRatio(number),
          }),
        }),
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
       * 图表模块。`null` 表示还没加载好 / 加载失败 / 测试环境没有分块加载器。
       *
       * 三种情况都走同一条**降级路径**：只渲染表格，不渲染图表。
       * 图表是让数字更好读的增强，不是统计页能不能用的前提——所以
       * 任何一环没就绪都不该让页面报错、空白或卡在加载态。
       */
      const charts = props.charts ?? null;
      /**
       * 时间序列（服务端算好的，见 lib/stats.js 的 buildSeries）。
       *
       * 与 `rows` 并列，不是从 `rows` 推出来的：`rows` 已经按
       * provider × model 聚合掉时间维度了，前端手上没有时间戳可用。
       */
      const series = stats?.series ?? null;
      const seriesBuckets = Array.isArray(series?.buckets) ? series.buckets : [];
      /**
       * 圆环的「隐藏了哪些决策点」与切换函数由调用方传入。
       *
       * 为什么不能在这里直接引用 `hiddenPoints`：本函数（`renderStatsTab`）
       * 在组件**外面**定义，是纯渲染函数；`hiddenPoints` 是 `StartluxPage`
       * 里的 useState，跨作用域取不到（会抛 ReferenceError）。这类错误在
       * 渲染测试里表现为「整页崩掉」，而不是「圆环不显示」——所以必须走 props。
       */
      const hiddenPoints = props.hiddenPoints instanceof Set ? props.hiddenPoints : new Set();
      const togglePointHidden =
        typeof props.togglePointHidden === "function" ? props.togglePointHidden : null;
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
        // 4.4) 走势（图表）：区间内的节奏。
        //
        // 放在汇总卡片之后、裁决之前：卡片给的是**总量**，走势回答的是
        // 「这些量是怎么分布的」——是先忙后闲，还是中间掉过一段。
        // 总量与节奏是两个问题，顺序上也该照着这两个问题排。
        //
        // `charts === null` 时整块不渲染（降级成只有卡片与表格）：
        // 拿不到图表库不影响任何数字的呈现，只是少了一层形状。
        charts !== null && seriesBuckets.length > 1 && totals !== null
          ? h(
              "div",
              { style: S.card },
              h("div", { style: S.sectionTitle }, "走势"),
              h(
                "div",
                { style: { ...S.pointMeta, marginTop: "-2px" } },
                t("按{bucket}分桶，共 {count} 个桶；空桶补 0，掉到零就是真的没有请求。", {
                  bucket: series.bucket === "hour" ? t("小时") : series.bucket === "day" ? t("天") : t("月"),
                  count: groupDigits(seriesBuckets.length),
                }),
              ),
              ...(
                [
                  { key: "requests", label: "请求次数" },
                  { key: "inputTokens", label: "input token" },
                  { key: "durationMs", label: "总耗时" },
                ]
              ).map((item) =>
                h(
                  "div",
                  { key: `trend-block/${item.key}`, style: S.chartTrendBlock },
                  h(
                    "div",
                    { style: S.chartTrendLabel },
                    h("span", null, t(item.label)),
                    h("span", { style: { fontFamily: "ui-monospace, Menlo, monospace" } },
                      item.key === "durationMs"
                        ? formatMs(totals.durationMs)
                        : groupDigits(totals[item.key])),
                  ),
                  renderTrend(charts, series.series?.[item.key] ?? [], {
                    label: t(item.label),
                    summary: t("{label}随时间变化", { label: t(item.label) }),
                  }),
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
              /**
               * 裁决构成条：三格占比一眼可见。
               *
               * 放在卡片**之后**：卡片给的是三个绝对数（要核对具体数字时
               * 看它），这条给的是三者的**比例形状**（要判断「是不是被拦
               * 得太多」时看图）。先数字后形状，符合「先核对再判断」的顺序。
               *
               * 「未裁决」刻意不进这条：它不是第四种裁决结果，而是
               * 「这次根本没产生裁决」（降级、答案形状不符）。把它和
               * allow/ask/reject 拼成一条 100% 的条，会让「降级很多」
               * 看起来像「模型总是在拦/放」，那是两种完全不同的状况。
               */
              charts !== null && outcomes.decided > 0
                ? h(
                    "div",
                    { style: { marginTop: "10px" } },
                    renderOutcomeBar(charts, outcomes),
                  )
                : null,
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
              /**
               * 排序条：谁花得多、一眼可见（表格之前）。
               *
               * 为什么用「次数」而不是 token：行数一多（十几个组合很常见），
               * 横向条的标签会挤在一起；次数是最短、量级最同质的指标，
               * 排出来的长度差最容易读。token 的绝对值跨模型差好几个数量级，
               * 画在同一根轴上会让小模型缩成看不见的一根线。
               *
               * 只取前 8 个：多出来的会让条形密到读不出标签，而**表格里
               * 全都在**——图表负责「看出头部」，表格负责「查具体值」。
               */
              charts !== null && rows.length > 0
                ? h(
                    "div",
                    { style: { marginTop: "8px" } },
                    renderRanking(
                      charts,
                      [...rows]
                        .sort((a, b) => Number(b.requests ?? 0) - Number(a.requests ?? 0))
                        .slice(0, 8)
                        .map((row) => ({
                          label: `${comboName(row)} · ${row.model}`,
                          value: Number(row.requests ?? 0),
                        })),
                      {
                        label: "请求次数对比",
                        summary: t("前 {count} 个组合的请求次数对比", { count: Math.min(8, rows.length) }),
                      },
                    ),
                  )
                : null,
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
              /**
               * 节省量的形状：基线 vs 实际（右侧竖线是基线，条是实际）。
               *
               * 节省量最容易误读的地方是「它到底相对什么」——表格里两列
               * 数字并排，读者得心算才知道省了多少，而且很容易把两个
               * 不同口径的数相减（比如拿生效模式的消耗去减观察模式的节省）。
               * 画在同一条轴上之后，「省了多少」是看得见的长度差，
               * 基线就是那条刻度的右端，口径不需要再解释。
               *
               * `savingsUnavailable` 时整块不画：这时候没有观察模式的
               * 记录，画一条「实际 = 基线」的满格条会被读成「一点没省」。
               */
              charts !== null && savingsUnavailable !== true && totals !== null
                ? h(
                    "div",
                    { style: { marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" } },
                    ...(
                      [
                        {
                          key: "inputTokens",
                          label: "input token",
                          baseline: Number(totals.observeBaseInputTokens ?? 0),
                          actual: Number(totals.observeInputTokens ?? 0),
                        },
                        {
                          key: "outputTokens",
                          label: "output token",
                          baseline: Number(totals.observeBaseOutputTokens ?? 0),
                          actual: Number(totals.observeOutputTokens ?? 0),
                        },
                      ]
                    ).map((item) =>
                      h(
                        "div",
                        { key: `savings-bullet/${item.key}` },
                        h("div", { style: { fontSize: "11px", opacity: 0.6, marginBottom: "1px" } },
                          t("{label}（实际 vs 基线）", { label: t(item.label) })),
                        renderSavingsBullet(charts, item.baseline, item.actual, t(item.label)),
                      ),
                    ),
                  )
                : null,
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
              /**
               * 圆环：哪个决策点在花钱、占多大比重。
               *
               * 为什么这一块特别需要图：表格里七行数字，读者要靠心算才知道
               * 「工具授权占了快一半」——而那正是这一节最该一眼看出的事。
               *
               * 排序口径用**请求次数**而不是 token：次数是最同质的量（一次
               * 就是一次），token 跨决策点能差好几个数量级，小的会被压成
               * 一根看不见的细线。token 的构成在下面的表里逐行可查。
               *
               * 图例与图型共用**同一个已排序数组**：先排序再同时喂给两者，
               * 颜色和名字才不会错位（错位不报错，只会让人读错决策点）。
               */
              charts !== null && Array.isArray(stats?.byPoint) && stats.byPoint.length > 0
                ? renderPointDonut(
                    charts,
                    [...stats.byPoint]
                      .filter((point) => Number(point.requests ?? 0) > 0)
                      .sort((a, b) => Number(b.requests ?? 0) - Number(a.requests ?? 0))
                      .map((point) => ({
                        // `id` 与 `label` 分开：id 用于「隐藏了哪一个」与
                        // 「颜色绑定在谁身上」，label 只用于显示。用 label 当键
                        // 会在两个决策点同名时互相串掉（服务端下发的名字若重复）。
                        id: point.point,
                        label: pointLabels[point.point] ?? point.point,
                        value: Number(point.requests ?? 0),
                      })),
                    {
                      totalLabel: "请求次数",
                      hidden: hiddenPoints,
                      onToggle: togglePointHidden,
                    },
                  )
                : null,
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
     * 分组元数据：id → { title, tone }。
     *
     * tone 决定图标底色与正文竖线的颜色，四组各一色：
     *   business（连接方式）/ warn（守卫行为）/ success（记录与展示）/ neutral（模型与统计）。
     *
     * 为什么最后一组是 neutral 而不是第四种色：四组里三组已经是
     * 「强调 / 警示 / 正向」这三档语义色，再加一档等于把颜色当成
     * 装饰。第四组是「调优与诊断」，中性最贴切——它的颜色不该读成
     * 任何一种状态。
     */
    const SECTION_META = {
      connection: { title: "连接方式", tone: "business" },
      guard: { title: "守卫行为", tone: "warn" },
      record: { title: "记录与展示", tone: "success" },
      model: { title: "模型与统计", tone: "neutral" },
    };

    /** 分组展开状态在 localStorage 里的键。 */
    const SECTION_OPEN_KEY = "dsh-decision-engine:cfg-sections";

    /**
     * 读出上次的展开状态。
     *
     * 读不到（隐私模式 / 首次访问 / 解析失败）时回落到默认值：
     * **第一组默认展开，其余收起**。理由是「连接方式」是第一次进来
     * 最可能要动的那一组，而守卫与模型那些项设一次就忘，铺开只是
     * 加长页面。
     */
    const readSectionOpen = () => {
      const fallback = { connection: true, guard: false, record: false, model: false };
      try {
        if (typeof localStorage === "undefined") return fallback;
        const raw = localStorage.getItem(SECTION_OPEN_KEY);
        if (typeof raw !== "string" || raw === "") return fallback;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return fallback;
        const out = {};
        for (const id of Object.keys(SECTION_META)) {
          out[id] = parsed[id] === true;
        }
        return out;
      } catch {
        return fallback;
      }
    };

    /** 把展开状态写回 localStorage。写不进去（配额满 / 隐私模式）就忽略。 */
    const writeSectionOpen = (next) => {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(SECTION_OPEN_KEY, JSON.stringify(next));
      } catch {
        /* 写不进去不影响使用：本次会话内仍然折叠正常 */
      }
    };

    // 展开状态的读写挂在 `i18n` 探针上：渲染测试需要一个口来验证
    // 「记住了上次的选择」这条行为，而模拟 `document` + 重渲染只为测
    // 两个纯函数不值当。与 `tr` / `t` 挂在一起，控制台排查时也在同一处。
    i18n.readSectionOpen = readSectionOpen;
    i18n.writeSectionOpen = writeSectionOpen;
    i18n.SECTION_OPEN_KEY = SECTION_OPEN_KEY;
    i18n.SECTION_META = SECTION_META;

    /**
     * 分组图标（DEC-051）：折叠状态下也要一眼认出这一组是什么。
     *
     * 为什么自己画 SVG 而不用图标库：本插件的 `client.js` 不注入
     * `@deepseek-ai/dsh-client-ui-primitives`，多引一个包就多一份宿主
     * 版本耦合；这四个图形是纯装饰（`aria-hidden`），自己画几行 path
     * 就够，也免得宿主换图标集时形状突变。
     *
     * 形状按语义选，不是随手配的：
     *   - business（连接方式）：插头——连到哪儿；
     *   - warn（守卫行为）：盾牌——拦不拦；
     *   - success（记录与展示）：书页——记不记；
     *   - neutral（模型与统计）：滑块——调什么参数。
     */
    function SectionIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 14;
      const tone = props?.tone;
      // 描边属性是四条 path 共用的：抽出来只写一次，改线宽只改这里。
      const stroke = {
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      };
      // 每个图形是一组 <path>/<circle>，用 key 保证同一 tone 下重绘稳定。
      const paths = {
        // 插头：两个脚 + 一个身（「连到哪儿」）。
        business: [
          h("path", { key: "a", ...stroke, d: "M6 2v4M10 2v4" }),
          h("path", { key: "b", ...stroke, d: "M4 6h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4z" }),
          h("path", { key: "c", ...stroke, d: "M8 13v2" }),
        ],
        // 盾牌：中间一道竖线（守卫的「拦截」语义）。
        warn: [
          h("path", { key: "a", ...stroke, d: "M8 2l5 2v4c0 3-2.2 5.3-5 6-2.8-.7-5-3-5-6V4z" }),
          h("path", { key: "b", ...stroke, d: "M8 6v4" }),
        ],
        // 书页：翻开的纸（「记不记」）。
        success: [
          h("path", { key: "a", ...stroke, d: "M2.5 3.5A1.5 1.5 0 0 1 4 2h3.5v11H4a1.5 1.5 0 0 0-1.5 1.5z" }),
          h("path", { key: "b", ...stroke, d: "M13.5 3.5A1.5 1.5 0 0 0 12 2H8.5v11H12a1.5 1.5 0 0 1 1.5 1.5z" }),
        ],
        // 滑块：两条轨道 + 两个把手（「调什么参数」）。
        neutral: [
          h("path", { key: "a", ...stroke, d: "M2.5 5.5h11M2.5 10.5h11" }),
          h("circle", { key: "b", ...stroke, cx: 6, cy: 5.5, r: 1.8 }),
          h("circle", { key: "c", ...stroke, cx: 10.5, cy: 10.5, r: 1.8 }),
        ],
      };
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" },
        },
        ...(paths[tone] ?? paths.neutral),
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
            setDraft({
              enabled: next.enabled === true,
              mode: next.mode ?? "shadow",
              thinkMode: next.thinkMode ?? "never",
              // 决策历史（DEC-022）：与服务端一致，默认开。
              decisionsTabEnabled: next.decisionsTabEnabled !== false,
              // 审批卡正文可读化（DEC-042 / DEC-043）：与服务端一致（缺省 = 开），
              // 否则打开后回弹。
              approvalDetailReadable: next.approvalDetailReadable !== false,
              // 跟随服务端下发（DEC-030）：默认关；与服务端保持一致，
              // 否则保存后开关会回弹。
              serverProvider: next.serverProvider?.enabled === true,
              // 人工审核比例（DEC-035）：同样从服务端派生，否则点滑块后回弹。
              tolerance: next.tolerance?.level ?? "default",
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
        // 匿名统计的兜底：status 失败时下拉仍要能显示正确档位。
        telemetryLevel: "daily",
        telemetryLevels: ["off", "install", "daily"],
        // 决策历史（DEC-022）的兜底：默认**开**，与服务端 DEFAULTS 一致。
        // 兜底成 false 会让 status 失败那一帧显示成「关」，用户可能顺手拨一下
        // 把开关存成 false——那正是「开关自己弹回去」的来源。
        decisionsTabEnabled: true,
        // 审批卡正文可读化（DEC-042 / DEC-043）的兜底：默认**开**，与服务端
        // DEFAULTS 一致。兜底成 false 会让 status 失败那一帧把开关画成「关」，
        // 用户顺手拨一下就把 false 存下去了——与上面那个开关同一类事故。
        approvalDetailReadable: true,
        // 跟随服务端下发（DEC-030）的兜底：默认**关**，字段与冻结契约一致。
        //
        // 兜底成「开」会让 status 失败那一帧显示成「正在用服务端值」，而实际
        // 生效的是本地手动配置——用户据此以为不必填 key，实际每次请求都失败。
        // 默认关与「后端还没接线」时的真实行为也一致。
        serverProvider: {
          enabled: false,
          active: false,
          endpoint: "",
          label: "服务端下发",
          status: "idle",
          usable: false,
          error: "",
          keyHint: "",
          baseUrl: "",
          model: "",
          endpointStyle: "",
          fetchedAt: 0,
          expiresAt: 0,
          expired: false,
        },
        stats: { requests: 0, cached: 0 },
      };

      /** 生效草稿：没有用户改动时一律从服务端状态派生。 */
      const draft = draftState ?? {
        enabled: view.enabled === true,
        mode: view.mode ?? "shadow",
        // 思考模式也走 draft：与其它控件一致，改完即自动落盘。
        thinkMode: view.thinkMode ?? "never",
        // 决策历史（DEC-022）：与服务端一致，默认开。
        decisionsTabEnabled: view.decisionsTabEnabled !== false,
        // 审批卡正文可读化（DEC-042 / DEC-043）：同样默认开。缺了这一格，
        // 首屏会在服务端说「开」的同时把开关画成「关」。
        approvalDetailReadable: view.approvalDetailReadable !== false,
        // 跟随服务端下发（DEC-030）：默认关（与服务端 DEFAULTS 一致）。
        serverProvider: view.serverProvider?.enabled === true,
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

      // 模型列表自动拉取：打开配置页就该看到当前服务可选的模型，
      // 而不是等用户发现并点「获取」（此前 loadModels 只有按钮一个调用点，
      // 迁移到 custom 的用户打开页面只会看到「自动」一项——正是反馈的问题）。
      // 触发点：状态首次加载完成 + provider / 生效地址变化（切预设、custom
      // base URL 保存后都会变）。/models 只在配置页打开时调用，服务端有
      // 独立超时，不占决策路径。
      const statusLoaded = status !== null && status !== undefined;
      const modelsKey = (view.provider ?? "") + "\u0000" + (view.baseUrl ?? "");
      react.useEffect(() => {
        if (!statusLoaded) return;
        loadModels();
      }, [loadModels, statusLoaded, modelsKey]);

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
          // 匿名统计档位：必须从服务端状态派生，否则首屏会落到兜底值，
          // 用户看到的档位与实际生效的不一致。
          telemetryLevel: next.telemetryLevel ?? "daily",
          // 决策历史（DEC-022）：同样必须从服务端派生，否则保存后开关会回弹。
          decisionsTabEnabled: next.decisionsTabEnabled !== false,
          // 审批卡正文可读化（DEC-042 / DEC-043）：必须从服务端派生。这个函数
          // 在**保存成功之后**才跑，缺了这一格，草稿丢掉的就不只是个显示值：
          // 开关当场画成「关」，下一次保存又把 `false` 提交上去——开关自己
          // 弹回去（DEC-037 记过同一类事故）。
          approvalDetailReadable: next.approvalDetailReadable !== false,
          // 跟随服务端下发（DEC-030）：同样是「生效值」，必须从服务端派生。
          serverProvider: next.serverProvider?.enabled === true,
          // 人工审核比例（DEC-035）：同样必须从服务端派生，否则保存后回弹。
          tolerance: next.tolerance?.level ?? "default",
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

      /**
       * 「重新获取」（DEC-030）：强制服务端刷新一次下发值。
       *
       * 为什么要一条单独的路由：保存配置时服务端按缓存与过期时间决定拉不拉
       * （没过期就复用），而用户点这个按钮表达的是「现在就要一份新的」。
       * 返回形状与 `/status` 相同，所以直接走 `applyServerState`——草稿与
       * 服务端状态一次对齐，不会出现「界面显示旧值、服务端已是新值」。
       */
      const reloadServerProvider = async () => {
        setBusy("serverProvider");
        setMsg(null);
        try {
          const next = await call("/server-provider", { method: "POST" });
          applyServerState(next);
        } catch (error) {
          setMsg({ ok: false, text: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy("");
        }
      };

      /**
       * 一行：左标题+说明，右控件。
       *
       * 第 5 个参数 `note` 是**可选**的：一行更小、更淡的补充说明，渲染在
       * 说明（hint）下面。它是给「这句话是风险声明、不属于正文说明」用的
       * ——例如「使用免费模型」下面的「可能会失效」：它是这件事的代价，
       * 与「这个开关干什么」不是同一层信息，压成同一段会让人读漏。
       * 不给 note 时行为与之前逐字一致（向后兼容，老调用点不用改）。
       */
      const row = (title, hint, control, key, note) =>
        h(
          "div",
          { style: S.rowLine, key },
          h(
            "div",
            { style: S.rowText },
            h("div", { style: S.rowTitle }, title),
            hint === null ? null : h("div", { style: S.rowHint }, hint),
            note === null || note === undefined ? null : h("div", { style: S.rowNote }, note),
          ),
          control,
        );

      /* ------------------------------------------------------------
       * 分组折叠（DEC-051）
       *
       * 形状参考 @xbzbing/dsh-git-panel 的插件配置页：
       *   - 标题是一行**按钮**（整行可点），右边一个 chevron 指示开合；
       *   - 标题左边一个 24px 的色块图标，色块颜色 = 这一组的语义色；
       *   - 正文挂在标题下面，左侧有一条同色的竖线，把「下面这些行属于
       *     这一组」这件事画出来。
       *
       * 折叠状态**记在 localStorage**：用户关掉「守卫行为」这一组，
       * 下次打开面板不该又弹回来。这一组的状态是纯 UI 偏好，不该
       * 跟配置一起落盘（config.yml 是给别的进程读的）。
       * ------------------------------------------------------------ */

      /**
       * 渲染一个可折叠分组。
       *
       * @param id - 分组 id（同时是 localStorage 里的键）。
       * @param title - 分组标题（中文源文案，渲染边界翻译）。
       * @param tone - 语义色：business / warn / success / neutral。
       * @param items - 这一组的正文元素数组。
       */
      const sectionBlock = (id, tone, title, items) => {
        const open = sectionOpen[id] === true;
        const bodyId = `de-cfg-sec-${id}`;
        return h(
          "section",
          {
            key: `section-${id}`,
            className: `de-cfg__section de-cfg__section--${tone}`,
            "data-section": id,
          },
          // 标题行：整行可点，按钮语义（aria-expanded / aria-controls）。
          h(
            "button",
            {
              type: "button",
              key: "hd",
              className: "de-cfg__section-hd",
              "aria-expanded": open ? "true" : "false",
              "aria-controls": bodyId,
              onClick: () => {
                const next = { ...sectionOpen, [id]: !open };
                setSectionOpen(next);
                writeSectionOpen(next);
              },
            },
            h(
              "span",
              { key: "left", className: "de-cfg__section-left" },
              // 色块图标：折叠状态下也能一眼认出这一组是什么。
              h(
                "span",
                {
                  key: "ic",
                  className: `de-cfg__section-ic de-cfg__section-ic--${tone}`,
                  "aria-hidden": "true",
                },
                h(SectionIcon, { tone, size: 14 }),
              ),
              h("span", { key: "t" }, title),
            ),
            // chevron：闭合时朝右，展开时转 90° 朝下。旋转**只由 CSS 类**决定
            // （`.de-cfg__chevron--open`），否则两态长得一样，指示就失效了。
            // 纯装饰，语义由 aria-expanded 承担。
            h(
              "span",
              {
                key: "chevron",
                className: `de-cfg__chevron${open ? " de-cfg__chevron--open" : ""}`,
                "aria-hidden": "true",
              },
              "›",
            ),
          ),
          // 正文：折叠时是 `hidden`（不是卸载），这样控件的草稿值不会丢。
          h(
            "div",
            {
              key: "body",
              id: bodyId,
              className: "de-cfg__section-body",
              hidden: open ? undefined : true,
            },
            ...items,
          ),
        );
      };

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
       *   perplexity      -> perplexityModel
       *   openrouter      -> openrouterModel
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

      /**
       * 「使用免费模型」那一行的说明（DEC-030，DEC-037 改名）。
       *
       * 各状态都要**说清现在到底在用谁**：用户最怕的是「界面说已生效、实际
       * 打的是本地旧地址」这类静默偏差，所以 ready 状态把地址、模型与密钥
       * 末四位都摆出来，不可用时明确写「已回落到本地手动配置」。
       *
       * 为什么不用顶层 `view.keyHint`：顶层回传的是**生效值**，服务端不生效
       * 时它就是本地 key 的末四位——两把 key 挤在同一字段里，提示会指向错的
       * 那一把。这里只认 `serverProvider.keyHint`。
       */
      const serverHint = (() => {
        const sp = view.serverProvider ?? {};
        if (sp.enabled !== true) return t("关闭：使用下方的本地配置（与现在完全一致）");
        if (sp.status === "ready") {
          const model =
            typeof sp.model === "string" && sp.model.length > 0 ? sp.model : t("自动（服务端默认）");
          const when = formatLocalMs(sp.fetchedAt);
          return (
            t("服务端下发：{baseUrl} · 模型 {model} · 密钥 {hint}", {
              baseUrl: sp.baseUrl ?? "",
              model,
              hint: sp.keyHint || t("未下发"),
            }) + (when.length > 0 ? t(" · 获取于 {time}", { time: when }) : "")
          );
        }
        if (sp.status === "idle") return t("尚未获取（保存后自动获取）");
        if (sp.status === "loading") return t("正在获取…");
        const reason =
          typeof sp.error === "string" && sp.error.length > 0
            ? tr(sp.error)
            : t("尚未获取（保存后自动获取）");
        return (
          t("服务端不可用：{error}；已回落到本地手动配置", { error: reason }) +
          (sp.expired === true ? t("（服务端下发的值已过期）") : "")
        );
      })();

      /**
       * 模型行（DEC-031 反馈）：
       *
       *   - 内置预设：留在通用区域（预设的默认模型由插件兜底，「自动」语义明确）；
       *   - custom：**移入下方「自定义 provider」区**——模型清单来自用户自己的
       *     服务，与 Base URL / 端点风格是一组的；放在通用区域会让人以为
       *     「自动」也是插件兜底的，而自定义服务不一定有默认模型，「自动」
       *     （省略 model 字段）未必是正确选择。
       */
      const requiresModelPreset = (activeFields?.requiresModel ?? false) === true;
      const modelHint = requiresModelPreset
        ? t("该端点 model 必填；留空 = 用预设默认 {model}（可改填 SemIf）", { model: activeFields.defaultModel })
        : isCustom
          ? modelsState === "ok"
            ? t("从自定义服务实时获取；「自动」表示不发送 model 字段，若该服务要求指定模型请从列表选择")
            : modelsState === "loading"
              ? "正在获取模型列表…"
              : "获取失败或暂无列表，可手填模型名"
          : modelsState === "ok"
            ? "从服务商实时获取；选「自动」则由服务端决定，换名也不会失效"
            : modelsState === "loading"
              ? "正在获取模型列表…"
              : modelsState === "error"
                ? "获取失败，可手填或留空用服务端默认"
                : "未获取到列表，可手填或留空用服务端默认";
      const autoOptionLabel = requiresModelPreset
        ? t("默认（{model}）", { model: activeFields.defaultModel })
        : isCustom
          ? "自动（不发送 model 字段）"
          : "自动（服务端默认）";
      const modelRow = row(
        "模型",
        modelHint,
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
            h("option", { value: "" }, autoOptionLabel),
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
      );

      // 配置 tab 的全部内容（DEC-051：从「一条长表单 + 三条分隔线」改成
      // **四组可展开的分组**）。
      //
      // 四个 `*Items` 数组分别是四组的正文；下面的 `configBody` 用
      // `sectionBlock()` 把它们各自包成一个可折叠的 `<section>`：标题行
      // 整行可点、带 chevron，展开状态记在 localStorage（见 readSectionOpen）。
      //
      // 分组顺序与理由：
      //   ① 连接方式——连到哪、用谁的 key（地址来源是其余一切的前提）
      //   ② 守卫行为——判不判、拦不拦、问得多不多、决策模型进哪些环节
      //   ③ 记录与展示——记不记、审批卡长什么样
      //   ④ 模型与统计——思考模式与匿名统计（设一次就忘，默认收起）
      //
      // 页脚（保存状态 / 测试端点 / 状态信息）**不进任何分组**：它是所有
      // 分组的共同结论（刚才存没存、端点通不通），收进某一组反而会被误读。
      const connectionItems = [
        // ① 连接方式：地址从哪来、发给谁、用谁的 key、怎么存。
        //   第一行的「使用免费模型」是这一组的总开关：它决定下面这些项
        //   是服务端下发还是用户自己填，所以必须排在最前。
        // 1) 使用免费模型（DEC-030，原名「跟随服务端下发」；DEC-037 改名并置顶）：
        //    地址 / 模型 / key 都改由服务端下发，不必自己填。
        //
        // 放在整页的最上面：它是**地址来源**的决定——「用免费的，还是自己配」。
        // 下面每一组的每一项都取决于它（发给谁、用谁的 key、守卫跑在哪家模型上），
        // 所以它必须先被读到。
        //
        // 说明下面那行小字「可能会失效」是这件事的代价，不是附注：免费通道随时
        // 可能停用，用户得知道本地手动配置仍是可靠后路。改名也是为了让用户先看到
        // 「免费」这个能感知的事实，而不是「服务端下发」这个实现细节。
        //
        // 默认关：不打开时本插件的行为与之前逐字一致（全部走本地手动配置）。
        row(
          "使用免费模型",
          serverHint,
          h(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center", flex: "none" } },
            // 「重新获取」只在开着时出现：关着的时候它什么也不会变，摆在那里
            // 只会让人以为这个功能坏了。
            view.serverProvider?.enabled === true
              ? h(
                  "button",
                  {
                    type: "button",
                    key: "server-refetch",
                    onClick: reloadServerProvider,
                    disabled: busy !== "",
                    style: { ...S.saveBtn, flexShrink: 0, padding: "6px 10px" },
                  },
                  busy === "serverProvider" ? "…" : t("重新获取"),
                )
              : null,
            toggle(draft.serverProvider === true, () => {
              const next = draft.serverProvider !== true;
              const fresh = { ...draft, serverProvider: next };
              setDraft(fresh);
              // 开关是离散控件：拨一下就落盘。服务端据它决定是否去取下发值。
              scheduleSave({ draft: fresh }, true);
            }),
          ),
          "serverProvider",
          "可能会失效",
        ),
        // 2a) 服务提供方：最高层的选择，决定地址与鉴权从哪来
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
        // 2b) 模型行：custom 时移入下方「自定义 provider」区（见 modelRow 的说明）。
        // 每个 provider 用自己那一格（modelField 由服务端下发），分开存才能做到
        // 「切 provider 不覆盖其它 provider 已保存的模型」。
        ...(isCustom ? [] : [modelRow]),
        // 2c) API Key：每个 provider 一格，各自保存各自的 key。
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
        // 2d) 当前 provider 的生效端点：让「实际打到哪」始终可见
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
            // 服务端下发生效时给这行一个来源角标：地址看起来「凭空变了」时，
            // 用户要能立刻知道这是下发值而不是自己配的值。
            view.serverProvider?.active === true
              ? h(
                  "span",
                  { style: { ...S.v, fontSize: "11px", opacity: 0.9, color: "#93c5fd" } },
                  t("（地址与密钥来自服务端下发）"),
                )
              : null,
          ),
          "endpoint",
        ),
        // 4c) 密钥保存位置：默认托管到 .credentials.yaml（DEC-037 从 API Key 紧邻处
        //     下移到这里：它讲的是「这把 key 存到哪个文件」，不是「怎么连上服务」，
        //     夹在连接组中间会打断 provider → 模型 → key → 端点这条阅读线；
        //     而且它平时不用改，属于「设一次就忘」的项）
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
        // 4d) custom 专属字段：只有选了 custom 才出现，避免内置预设被无用输入干扰
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
              // 模型行也属于 custom 区：清单来自这个服务，「自动」的含义
              // （省略 model 字段）只有结合这里的端点才说得清。
              modelRow,
            )
          : null,
        // 4e) provider 校验错误：必须显式显示，否则用户只会看到「保存失败」
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
      ];

      const guardItems = [
        // ② 守卫行为：判不判、拦不拦、问得多不多、让决策模型进哪些环节。
        //   这一组直接改变插件的干预强度，所以标题用警示色。
        // 3a) 启用开关
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
        // 3b) 拦截开关（shadow / enforce 等价于「只记录」与「真拦截」）
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
        // 3d) 人工审核比例（DEC-035）：**配置页的正式入口**。
        //
        // 放在「守卫行为」组的末尾——它与这一组里那几个开关是一对：
        // 「启用守卫 / 真正拦截」决定**判不判、拦不拦**，这一项决定**多频繁问你**。
        // 放在同一组，用户一眼就能看懂「问了什么、问得多不多」。
        //（DEC-051 之后它不再需要「夹在分隔线 3 之前」这类版面说明：分组本身就是边界。）
        //
        // 为什么是滑块而不是下拉：见 S.toleranceTrack 的注释——四档是一条
        // 单调的轴，下拉会把「往右更保守」这层语义压掉。
        //
        // 数据来自 `/decisions`（与决策点清单一同下发），那是服务端
        // `tolerancePayload()` 的真源；拿不到时整块消失而不是画一个空滑块。
        // 排版**必须自成一块**，不能塞进 row() 的右半边。
        //
        // row() 是「左标题 / 右控件」的两列布局（`justify-content:
        // space-between`），滑块作为右控件时会被压成一列竖线：四个段挤在
        // `maxWidth: 420px` 之内、又各自 `flex: 1 1 0` + `minWidth: 0`，
        // 结果是每个段只剩一个字宽，中文竖排叠成一团（真机截图见过）。
        //
        // 滑块本身是一整行宽度的控件（四个段要横向铺开），所以这里不用
        // row()，而是自己拼「上面标题+说明、下面整宽滑块」的竖排布局。
        decisions?.tolerance === undefined || decisions?.tolerance === null
          ? null
          : h(
              "div",
              { key: "tolerance", style: S.toleranceSection },
              h(
                "div",
                { style: S.rowText },
                h("div", { style: S.rowTitle }, t("人工审核比例")),
                h(
                  "div",
                  { style: S.rowHint },
                  t("按比例校准这个模型的打扰频率。换决策模型不需要重调阈值：设定是模型无关的，插件会按该模型最近的分数量自己换算。"),
                ),
              ),
              ToleranceSlider({
                tolerance: decisions.tolerance,
                level: draft.tolerance ?? decisions.tolerance.level,
                disabled: busy !== "",
                onSelect: (level) => {
                  const next = { ...draft, tolerance: level };
                  setDraft(next);
                  // 离散控件：点一下就落盘（与决策点三态同一处理）。
                  scheduleSave({ draft: next }, true);
                },
              }),
            ),
        // 4f) 决策点：让决策模型进入哪些环节
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
      ];

      const recordItems = [
        // ③ 记录与展示：决策历史记不记，审批卡长什么样。
        //   与「判不判」是两件事——观察模式下往往才是用户真正想要的。
        // 3c) 决策历史（DEC-022 / DEC-026）：会话里的那个标签页。
        //
        // 放在「真正拦截」之后、「人工审核比例」之前：它与守卫的开关是**两件事**
        // ——守卫决定「判不判」，这个决定「记不记」，后者在观察模式下往往
        // 才是用户真正想要的。
        //
        // **一个开关管全部**（DEC-026 / DEC-029）：曾经这里还有一个「决策内容」
        // 子开关，只在上面这个开着时出现。两个开关表达的是同一件事（「这个功能
        // 要不要用」），却要求用户先做一次「记不记」的决策、再做一次「记多细」的
        // 决策——而后者根本不是日常选择。现在合成一个：开 = 记录明细（含内容）
        // 并挂标签页；关 = 完全不写文件。
        //
        // DEC-029 把这个合并做彻底了：那个「只存元数据」的隐藏档位（`config.yml`
        // 的 `decisionsCapture`）已退役。它不在配置页出现，却能在暗处把每一条
        // 记录降级成元数据——用户看到的开关和真实行为不一致，这正是缺陷本身。
        // 现在没有第二个档位：开关开着就一定带内容，不想要内容就把功能关掉。
        //
        // 关闭时服务端**完全不写**明细文件（不是「写了藏起来」）：用户说不
        // 记录，就该真的不落盘。
        row(
          "决策历史",
          draft.decisionsTabEnabled === true
            ? t("把本会话里经本插件做出的每次决策按时间记下来，并在会话里新增一个「决策历史」标签页")
            : t("关闭后不写任何明细文件（不采集内容、不占磁盘）"),
          toggle(draft.decisionsTabEnabled === true, () => {
            const next = draft.decisionsTabEnabled !== true;
            setDraft({ ...draft, decisionsTabEnabled: next });
            scheduleSave({ draft: { ...draft, decisionsTabEnabled: next } }, true);
          }),
          "decisionsTabEnabled",
        ),
        // 3c2) 审批卡正文可读化（DEC-042，DEC-043 起默认开启）。
        //
        // 放在「决策历史」之后、「人工审核比例」之前：它与上面那些是**同一类**
        // 用户可见体验（审批卡长什么样），而不是守卫的判据。
        //
        // 默认开启：宿主把命令原文塞进一个会折叠换行的块里，heredoc 脚本读不出
        // 结构，而「读得懂」正是本插件的用途。仍可关掉——关掉就回到宿主渲染，
        // 与升级前逐字节一致；代价是宿主将来对那块 UI 的改进我们也收不到。
        row(
          "审批卡正文可读化",
          draft.approvalDetailReadable !== false
            ? t("接管宿主的命令块：显示「几步、哪几步危险」的摘要，原文默认收起、可展开；保留换行，长命令限高滚动")
            : t("关闭时完全沿用宿主的渲染：命令原文原样铺满整个块，换行会被折叠"),
          toggle(draft.approvalDetailReadable !== false, () => {
            const next = draft.approvalDetailReadable === false;
            setDraft({ ...draft, approvalDetailReadable: next });
            scheduleSave({ draft: { ...draft, approvalDetailReadable: next } }, true);
          }),
          "approvalDetailReadable",
        ),
      ];

      const modelItems = [
        // ④ 模型与统计：调优（思考模式）与匿名统计。
        //   设一次就忘的项放最后，且默认收起。
        // 4a) 思考模式：never 最省延迟，always 判断更充分但每次多等约 5s。
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
        // 4b) 匿名使用统计（DEC-020）：三档，默认 daily（install 会让 DAU 恒为 0）。
        // 放在「思考模式」之后：它同样是「一次性选择、改完即存」的下拉，
        // 与上面的开关/下拉一组，不与 provider 表格混在一起。
        row(
          "匿名统计",
          draft.telemetryLevel === "daily"
            ? "每天上报一次：匿名安装 id、版本、平台与当日决策数"
            : draft.telemetryLevel === "off"
              ? "已关闭：任何情况下都不联网"
              : "仅首次运行上报一次「安装了」，之后不再联网",
          h(
            "select",
            {
              style: { ...S.input, minWidth: "190px", flex: "none" },
              value: draft.telemetryLevel ?? "daily",
              disabled: busy !== "",
              onChange: (event) => {
                const next = { ...draft, telemetryLevel: event.target.value };
                setDraft(next);
                scheduleSave({ draft: next }, true);
              },
            },
            (Array.isArray(view.telemetryLevels) && view.telemetryLevels.length > 0
              ? view.telemetryLevels
              : ["off", "install", "daily"]
            ).map((value) =>
              h(
                "option",
                { key: value, value },
                value === "off"
                  ? "off（不联网）"
                  : value === "install"
                    ? "install（仅首次）"
                    : "daily（每天一次，默认）",
              ),
            ),
          ),
          "telemetryLevel",
        ),
      ];

      const footerItems = [
        // 页脚常驻在所有分组之下：保存状态、测试端点、状态信息与诊断结果。
        //   它回答的是「刚才那一下存没存」，与页面哪一组展开无关。
        // 4g) 自动保存状态行：**没有「保存」按钮**，改动即落盘。
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
        // 4h) 状态信息（紧凑）
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

      // 配置 tab 的全部内容。
      //
      // **四组可折叠分组**（DEC-051：从「一条长表单 + 三条分隔线」改成分组的
      // 展开/收起）。四个数组分别是四组的正文，下面用 sectionBlock 包成
      // `<section>`：标题行可点、可折叠，展开状态记在 localStorage。
      //
      // 分组顺序与理由：先定「连到哪」（连接方式）→ 再定「怎么干预我」
      //（守卫行为）→ 再定「记不记、长什么样」（记录与展示）→ 剩下是调优与
      // 统计。前一组的问题回答不了，后一组的项就没有意义。
      //
      // 页脚**不进任何分组**：它是所有分组的共同结论（刚才存没存、端点通不通）。
      //
      // 外面包一层 `.de-cfg`：分组之间的顶边细线用 `.de-cfg__section +
      // `.de-cfg__section` 表达，只有当分组**是同一个父元素的兄弟**时才生效；
      // 摊平到页面根节点会把 footerItems 夹在中间，相邻关系就不成立了。
      const configBody = h(
        "div",
        { className: "de-cfg", key: "config-body" },
        sectionBlock("connection", SECTION_META.connection.tone, SECTION_META.connection.title, connectionItems),
        sectionBlock("guard", SECTION_META.guard.tone, SECTION_META.guard.title, guardItems),
        sectionBlock("record", SECTION_META.record.tone, SECTION_META.record.title, recordItems),
        sectionBlock("model", SECTION_META.model.tone, SECTION_META.model.title, modelItems),
        // 页脚单独包一层：它不是分组，不该被套上分组竖线与顶边线。
        h("div", { className: "de-cfg__footer", key: "config-footer" }, ...footerItems),
      );

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

      // 两个 tab 共用一个容器宽度（都不再限制最大宽度，DEC-040）：容器换到
      // 哪一层由 tab 决定，样式差异只剩内边距与字号。
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
              /**
               * 图表模块（见 loadCharts）。null = 未就绪/失败/测试环境，
               * 统计页照常显示表格，只是没有图形。
               */
              charts: chartsReady,
              /** 圆环里被隐藏的决策点（见 renderPointDonut）与其切换函数。 */
              hiddenPoints,
              togglePointHidden: togglePointHidden,
            })
          : configBody,
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
                    label: () => t("决策历史"),
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
    return module.exports;
  },
});
