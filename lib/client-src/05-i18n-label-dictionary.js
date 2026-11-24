    /** i18n:labels —— 服务端下发、且本文件别处没有同名词的中文文案。 */
    const EN_LABELS = {
      // provider 展示名来自服务端（lib/providers.js 的 providerCatalog）。
      // 不收进 EN_CONFIG/EN_STATS，因为它是**服务端数据**：将来新增带中文名
      // 的预设，只要在这里补一行；界面在渲染边界统一翻译，不用改调用点。
      "硅基流动": "SiliconFlow",
      "书生·端砚": "Intern InkStone",
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
      "书生·端砚（Intern InkStone，上海人工智能实验室）的 System One 端点（POST /v1/systemone）；默认模型 intern-decision-4b，只填一个 API key 即可使用": "Intern InkStone (Shanghai AI Lab) System One endpoint (POST /v1/systemone); default model intern-decision-4b — just add an API key",
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
      "配置文件 config.yml 的 siliconflowApiKey": "config.yml field siliconflowApiKey",
      "配置文件 config.yml 的 siliconflowIntlApiKey": "config.yml field siliconflowIntlApiKey",
      "配置文件 config.yml 的 duanyanApiKey": "config.yml field duanyanApiKey",
      "配置文件 config.yml 的 customApiKey": "config.yml field customApiKey",
      "~/.dsh/.credentials.yaml 的 TYPESAFE_API_KEY": "TYPESAFE_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 SILICONFLOW_API_KEY": "SILICONFLOW_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 SILICONFLOW_INTL_API_KEY": "SILICONFLOW_INTL_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 TOKENPLAN_API_KEY": "TOKENPLAN_API_KEY in ~/.dsh/.credentials.yaml",
      "~/.dsh/.credentials.yaml 的 DECISION_ENGINE_CUSTOM_KEY": "DECISION_ENGINE_CUSTOM_KEY in ~/.dsh/.credentials.yaml",
      "环境变量 TYPESAFE_API_KEY": "env var TYPESAFE_API_KEY",
      "环境变量 SILICONFLOW_API_KEY": "env var SILICONFLOW_API_KEY",
      "环境变量 SILICONFLOW_INTL_API_KEY": "env var SILICONFLOW_INTL_API_KEY",
      "环境变量 TOKENPLAN_API_KEY": "env var TOKENPLAN_API_KEY",
      "环境变量 DECISION_ENGINE_CUSTOM_KEY": "env var DECISION_ENGINE_CUSTOM_KEY",
      // —— 删除当前 provider 的 key（DEC-080）——
      "删除配置": "Delete config",
      "删除当前 provider 的 API Key（保留模型、地址等其它设置）": "Delete this provider's API key (model, endpoint and other settings are kept)",
      "删除中…": "Deleting…",
    };


    const EN = Object.assign(Object.create(null), EN_CONFIG, EN_STATS, EN_MISC, EN_LABELS);

