/**
 * Provider 配置模型 —— 所有决策请求的唯一构造入口。
 *
 * 为什么要单独一层：
 *
 * 早期版本把 `https://api.bamboonode.dev/v1/decisions` 硬编码在请求路径、
 * 配置页默认值和探测脚本三处。这带来两个问题：
 *
 *   1. 想接 TypeSafe 的 `/v1/systemone`、自建 llama.cpp 决策服务、
 *      或者任何提供同类决策端点的网关时，只能改源码。
 *   2. 三处硬编码会各自漂移：改了一处，配置页仍显示旧地址，用户以为没生效。
 *
 * 现在所有 provider 差异（base URL、端点风格、环境变量名、默认模型）都收在
 * 本模块的预设表里，`index.js` / `client.js` / 探测脚本只消费解析结果。
 * 本模块**零依赖、零 I/O**：不读文件、不读环境变量、不发请求，因此可以
 * 在裸 Node 下直接单测（见 test/providers.test.js）。
 *
 * 决策端点的约定（本模块据此固定请求形状，不随 provider 变化）：
 *
 *   POST <base>/decisions   或   POST <base>/systemone
 *   headers: authorization: Bearer <key> / content-type: application/json
 *   body:    { model?, state, questions, think_mode }
 *   resp:    { answers, model?, usage? }
 *
 * 也就是说 provider 只决定「往哪发、用谁的 key、默认哪个模型」，
 * 请求体与响应结构对所有 provider 完全一致——这样换 provider 不会改变
 * 上层各决策点的解析逻辑。
 *
 * @module dsh-decision-engine/providers
 */

/**
 * 可选的 provider 标识。
 *
 * `systemone` / `bamboonode` / `siliconflow` / `siliconflow-intl` /
 * `perplexity` / `openrouter` 是内置预设（默认地址与参数由本模块提供）；
 * `custom` 使用用户在设置界面填写的 base URL 与鉴权信息。
 *
 * 顺序即设置界面下拉的顺序：常用项在前，`custom` 收尾（它要填的东西最多）。
 */
export const PROVIDER_IDS = [
  "systemone",
  "bamboonode",
  "siliconflow",
  "siliconflow-intl",
  "perplexity",
  "openrouter",
  "custom",
];

/** 默认 provider。刻意选 bamboonode：老用户的 `startlux.yml` 里没有 provider 键，
 *  必须继续走原来的地址与端点风格，升级不能改变既有行为。 */
export const DEFAULT_PROVIDER = "bamboonode";

/**
 * 服务端下发 provider 的标识与显示名。
 *
 * 它**刻意不进 `PROVIDER_IDS`**：那份清单是用户能在设置界面选的本地预设，
 * 而 `server` 不可选——它是服务端配置源生效期间的一层临时覆盖。若把它写进
 * 预设表，用户就能在 config.yml 里写 `provider: server`，从而留下一个指向
 * 「服务端下发地址」的持久配置；一旦下发失效，这个 provider 就变成一个
 * 没有任何地址来源的空壳。
 *
 * 标签分中英两份，与预设表保持同一形状，界面才不必为它写特例。
 */
export const SERVER_PROVIDER_ID = "server";
export const SERVER_PROVIDER_LABEL = "服务端下发";
export const SERVER_PROVIDER_LABEL_EN = "Server-provided";

/**
 * 自定义 base URL 的端点风格。
 *
 *   auto       已指向 /decisions 或 /systemone 就原样用，否则先试 decisions
 *   decisions  POST <base>/decisions
 *   systemone  POST <base>/systemone
 *
 * 注意：这是**首选**路径，不是唯一路径。路径后缀由服务商决定（实测
 * SiliconFlow 的 Kev-4B 只通 /v1/systemone，bamboonode 两条都通），
 * 因此 404 时会换另一条再试——见 endpointCandidates()。
 */
export const ENDPOINT_STYLES = ["auto", "decisions", "systemone"];

/** 端点风格 → 追加的路径段。 */
const STYLE_SEGMENT = { decisions: "decisions", systemone: "systemone" };

/**
 * 两条路径风格互为「另一条」。
 *
 * 用于 404 回退：路径不存在时换另一条再试一次。
 */
const ALTERNATE_STYLE = { decisions: "systemone", systemone: "decisions" };

/**
 * 合法的思考模式（与 startlux 服务的 `think_mode` 取值一致）。
 *
 *   never   不思考——最省延迟（实测约 1.9s vs 7.2s），默认值
 *   auto    仅在模型自己判断需要时思考
 *   always  总是思考——判断更充分，但热路径上每次多等约 5s
 *
 * 单独导出是为了让校验、前端下拉、文档三处只有一份取值来源。
 */
export const THINK_MODES = ["never", "auto", "always"];

/** 思考模式的默认值：热路径上优先保证不拖慢每次工具调用。 */
export const DEFAULT_THINK_MODE = "never";

/**
 * 把配置里的 thinkMode 归一成合法取值。
 *
 * 为什么需要它：本插件的配置来自**自研的极简 YAML 解析器**，完全绕过
 * Schemastery 的 `z.union([...])` 校验（那是 profile 层的 config 才走的路径）。
 * 于是 `thinkMode: sometimes` 这种手写错误会被原样发到服务端，得到 400 后
 * 静默降级放行——正是本插件最忌讳的「配了没反应」。
 *
 * 特别注意**空字符串**：`parseConfigText` 刻意把 `key:` 解析成 `""`
 *（那是 `model:` 表示「自动」的语义），但 `""` 对 think_mode 是非法的。
 * 因此这里不能用 `??` 兜底（它只挡 null/undefined），必须显式判空。
 *
 * @param raw - 配置里的原始值（可能是任意类型）。
 * @returns 合法取值；非法一律回退默认值。
 */
export function normalizeThinkMode(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  return THINK_MODES.includes(value) ? value : DEFAULT_THINK_MODE;
}

/**
 * 内置预设。
 *
 * 每个预设必须给出：显示名称、默认 base URL、端点风格、环境变量名、
 * 默认模型与三个配置字段名。用户选了预设就用这里的值，不需要在设置界面
 * 重复填写。
 *
 * 两个可选标记（都是「按服务商实测」得出的，不是风格偏好）：
 *
 *   - `requiresModel: true`：该端点**不接受**省略 model 的请求（实测
 *     SiliconFlow 的 /v1/systemone 省略或空串都回 400
 *     `Model field is required.`）。这类预设在模型留空时回落到
 *     `defaultModel`，而不是沿用「留空 = 省略字段」的通用规则——
 *     那会导致一次注定 400 的请求，而守卫是 fail-open 的，表现为静默失效。
 *     其余服务商（bamboonode / system one）省略 model 会由服务端回填默认
 *     模型，保留省略语义才能在它们改名时不失效。
 *   - `knownModels`：该服务 `/v1/models` 会一并返回大量**非决策**模型且不带
 *     `supported_endpoint_types`（实测 SiliconFlow 返回 98 个，其中 chat
 *     模型打到 /v1/systemone 是 400 `Model does not exist.`）。
 *     列了这份清单就按它筛，不让下拉里出现「选了就失败」的选项。
 */
export const PROVIDER_PRESETS = {
  systemone: {
    id: "systemone",
    label: "system one",
    labelEn: "system one",
    baseUrl: "https://api.typesafe.ai/v1",
    endpointStyle: "systemone",
    // 每个 provider 用**自己的** key 名：同一台机器上很可能同时配好了
    // TypeSafe 与 bamboonode，共用一格会互相覆盖，切换时还得重填。
    apiKeyEnv: "TYPESAFE_API_KEY",
    legacyApiKeyEnvs: [],
    keyField: "systemoneApiKey",
    defaultModel: "jev-latest",
    modelField: "systemoneModel",
    keyEnvField: "systemoneApiKeyEnv",
    hint: "TypeSafe / Jev 的 System One 协议（POST /v1/systemone），"
      + "也是 llama.cpp、vLLM 等自建决策服务通用的线协议",
    hintEn: "TypeSafe / Jev System One protocol (POST /v1/systemone); "
      + "the same wire format used by llama.cpp and vLLM decision servers",
  },
  bamboonode: {
    id: "bamboonode",
    label: "bamboonode",
    labelEn: "bamboonode",
    baseUrl: "https://api.bamboonode.dev/v1",
    endpointStyle: "decisions",
    // bamboonode 保留它一直以来的名字（不是"统一成一个新名"）：
    // 一个 key 名对应一个服务，这才是用户能自主管理多套凭据的方式。
    // DECISION_ENGINE_KEY 只作为**回退**：上一版曾短暂改用它，
    // 用户可能已经把 key 存在那里，升级后不该让 key 突然读不到。
    apiKeyEnv: "BAMBOO_API_KEY",
    legacyApiKeyEnvs: ["DECISION_ENGINE_KEY"],
    keyField: "bamboonodeApiKey",
    defaultModel: "startlux-decision-v1.1-27b-autothink",
    modelField: "model",
    keyEnvField: "bamboonodeApiKeyEnv",
    hint: "StartLux 官方端点（POST /v1/decisions），本插件的原有默认值",
    hintEn: "StartLux official endpoint (POST /v1/decisions); the original default",
  },
  siliconflow: {
    id: "siliconflow",
    label: "硅基流动",
    labelEn: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    // 实测（2026-10-25，真实 key）：该站只认 /systemone，/v1/decisions 回 404。
    // 因此这里直接给 systemone，不必让 404 回退先烧一次请求。
    endpointStyle: "systemone",
    // 两个 SiliconFlow 站点是**两套账号**，key 互不通用，因此各占一格。
    apiKeyEnv: "SILICONFLOW_API_KEY",
    legacyApiKeyEnvs: [],
    keyField: "siliconflowApiKey",
    // 实测省略 model 会 400 `Model field is required.`，而 bamboonode 省略会
    // 由服务端回填默认模型。因此这个 provider 必须**总带着一个模型名**——
    // 留空时回落到下面的 defaultModel，而不是省略字段（见 resolveProvider）。
    // 这正是「只填一个 API key 就能用」的前提：模型名是预设给好的。
    requiresModel: true,
    // /v1/models 里这条就叫 Kev-4B（官方文档两处分别写作 Kev-4b 与 Kev-4B，
    // 实测三种大小写都 200），取服务返回的写法，免得下拉里出现两条同模型。
    defaultModel: "Kev-4B",
    // 官方只支持这两个决策模型；/v1/models 却会一并返回 98 个 chat 模型且
    // 不带 supported_endpoint_types（实测把 chat 模型打过来是 400
    // `Model does not exist.`），所以按这份清单筛，不让下拉里出现选了就坏的项。
    knownModels: ["Kev-4B", "SemIf"],
    modelField: "siliconflowModel",
    keyEnvField: "siliconflowApiKeyEnv",
    hint: "硅基流动（国内站）的 System One 端点（POST /v1/systemone）；可用模型 Kev-4B / SemIf，默认 Kev-4B，只填一个 API key 即可使用",
    hintEn: "SiliconFlow China (POST /v1/systemone); models Kev-4B / SemIf, default Kev-4B — just add an API key",
  },
  "siliconflow-intl": {
    id: "siliconflow-intl",
    label: "Silicon Flow",
    labelEn: "Silicon Flow",
    baseUrl: "https://api.siliconflow.com/v1",
    // 同样只认 /systemone：实测打 /v1/decisions 回 404 Not Found。
    endpointStyle: "systemone",
    // 与国内站分开：两套账号的 key 不能共用一格，否则切过去就 401，
    // 而用户看不出是「拿错了 key」还是「key 失效」。
    apiKeyEnv: "SILICONFLOW_INTL_API_KEY",
    legacyApiKeyEnvs: [],
    keyField: "siliconflowIntlApiKey",
    requiresModel: true,
    defaultModel: "Kev-4B",
    knownModels: ["Kev-4B", "SemIf"],
    modelField: "siliconflowIntlModel",
    keyEnvField: "siliconflowIntlApiKeyEnv",
    hint: "Silicon Flow（国际站）的 System One 端点（POST /v1/systemone）；与国内站账号不通用，可用模型 Kev-4B / SemIf，默认 Kev-4B，只填一个 API key 即可使用",
    hintEn: "Silicon Flow global (POST /v1/systemone); separate account from the CN site, models Kev-4B / SemIf, default Kev-4B — just add an API key",
  },
  perplexity: {
    id: "perplexity",
    label: "Perplexity Decider",
    labelEn: "Perplexity Decider",
    // 地址与默认模型**未经实测**（2026-11-04 接入时按 Perplexity 公开的 API
    // 地址写的）：该端点接受 /decisions 还是 /systemone 尚未验证，因此给
    // auto，由 404 回退按顺序试两条路径。跑通一次后应把风格钉死成实测值，
    // 参照 siliconflow 的做法省掉一次注定 404 的探测请求。
    baseUrl: "https://api.perplexity.ai",
    endpointStyle: "auto",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    legacyApiKeyEnvs: [],
    keyField: "perplexityApiKey",
    // Perplexity 的公开 API 把 model 列为必填，因此按 requiresModel 处理：
    // 留空回落到下面的默认，而不是发出注定 400 的省略请求。默认模型同样是
    // 占位值，未实测。
    requiresModel: true,
    defaultModel: "sonar",
    modelField: "perplexityModel",
    keyEnvField: "perplexityApiKeyEnv",
    hint: "Perplexity Decider 端点（api.perplexity.ai）；地址与默认模型待实测，接通后建议把端点风格钉死",
    hintEn: "Perplexity Decider endpoint (api.perplexity.ai); base URL and default model are placeholders until verified",
  },
  openrouter: {
    id: "openrouter",
    label: "Openrouter",
    labelEn: "Openrouter",
    // 同上：地址按 OpenRouter 公开的 API base 写，端点风格未实测，先给 auto。
    baseUrl: "https://openrouter.ai/api/v1",
    endpointStyle: "auto",
    apiKeyEnv: "OPENROUTER_API_KEY",
    legacyApiKeyEnvs: [],
    keyField: "openrouterApiKey",
    // OpenRouter 的请求体必须带 model slug（省略即 400），因此同样
    // requiresModel；默认 slug 是占位值，未实测，换模型直接改配置即可。
    requiresModel: true,
    defaultModel: "openai/gpt-4o-mini",
    modelField: "openrouterModel",
    keyEnvField: "openrouterApiKeyEnv",
    hint: "OpenRouter 端点（openrouter.ai/api/v1）；模型填 OpenRouter 的 slug，地址与默认模型待实测",
    hintEn: "OpenRouter endpoint (openrouter.ai/api/v1); model takes an OpenRouter slug — base URL and default model are placeholders until verified",
  },
  custom: {
    id: "custom",
    label: "custom",
    labelEn: "custom",
    baseUrl: "",
    endpointStyle: "auto",
    // custom 的变量名由用户填（customApiKeyEnv）；这里给出兜底默认名，
    // 用户不填时也能在 .credentials.yaml 里用这个键存 key。
    apiKeyEnv: "DECISION_ENGINE_CUSTOM_KEY",
    legacyApiKeyEnvs: [],
    keyField: "customApiKey",
    defaultModel: "",
    modelField: "customModel",
    keyEnvField: "customApiKeyEnv",
    hint: "任意提供决策端点的服务：自建 llama.cpp / vLLM、企业网关、第三方中转",
    hintEn: "Any service exposing a decision endpoint: self-hosted llama.cpp / vLLM, a gateway, or a relay",
  },
};

/**
 * 预编译的正则（模块级常量）。
 *
 * 为什么要提出来：这几个模式在**每一次决策**的 provider 解析里都会用到
 *（normalizeBaseUrl / validateBaseUrl / buildEndpoint / endpointCandidates
 * 各用一次），写在函数体里就是每请求重新构造一次 RegExp 对象。
 * 另一个好处是「规则只有一份」：结尾斜杠的判定不可能在两处漂移。
 */
const TRAILING_SLASHES_RE = /\/+$/;
/** 是否含任意空白——URL 里出现空白一定是填错了。 */
const HAS_WHITESPACE_RE = /\s/;
/** scheme 段。这里刻意放宽到「任意合法 scheme」，具体协议由 validateBaseUrl 再拒。 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 自定义头名的合法字符集（RFC 7230 的 token）。 */
const HEADER_TOKEN_RE = /^[A-Za-z0-9!#$%&\'*+.^_`|~-]+$/;
/** customHeaders 的分隔符：分号或换行。 */
const HEADER_SEPARATOR_RE = /[;\n]/;

/**
 * provider 标识的快速 membership 表。
 *
 * 与 `PROVIDER_IDS` 同源（就是它构造出来的），顺序仍是那份清单的顺序；
 * 这里只是把「每请求一次的数组 includes」换成 Set 查表。
 */
const PROVIDER_ID_SET = new Set(PROVIDER_IDS);

/**
 * 「纯派生值」的备忘录缓存（模块私有）。
 *
 * 为什么可以缓存：`validateBaseUrl` 与端点拼接都是 base URL 字符串的**纯函数**，
 * 输入相同则输出必然相同，缓存不可能引入陈旧状态。
 * 这与「provider 每请求重新解析」的设计原则**不冲突**：缓存键就是输入本身，
 * 配置一改（哪怕只改一个字符），键就变了，新地址必然重新解析一遍。
 * 每请求仍然重新读 cfg、重新解析 provider——省掉的只是「把同一个地址再拼一次」。
 *
 * 上限刻意很小：custom 的地址由用户任意填写，必须防止无界增长。
 * 满了就整体丢弃（同时在用的地址屈指可数，命中率高到不需要 LRU）。
 */
const DERIVED_CACHE_LIMIT = 64;
/** 已校验过的 base URL：规范化文本 → `{ ok, value | error }`。 */
const VALIDATED_BASE_URLS = new Map();
/** 端点派生结果：`<风格>\0<规范化 base URL>` → `{ endpoint, candidates }`。 */
const ENDPOINT_PLANS = new Map();
/** 共享的空候选数组：只读，省掉「地址为空 / 地址非法」时每请求新建数组。 */
const EMPTY_CANDIDATES = [];

/**
 * 写入备忘录：超过上限先整体丢弃，保证内存有界。
 *
 * @param cache - 目标 Map。
 * @param key - 由输入拼出的键。
 * @param value - 派生结果（之后只读）。
 */
function remember(cache, key, value) {
  if (cache.size >= DERIVED_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * 去掉首尾空白与结尾斜杠，统一成可安全拼接的 base URL。
 *
 * 只做规范化，不做合法性判断——判断交给 `validateBaseUrl`，因为两者
 * 的失败语义不同：规范化永远返回字符串（可能仍非法），校验才决定能不能存。
 *
 * @param raw - 用户填写的地址。
 * @returns 去掉结尾斜杠的地址；输入为空时返回 ""。
 */
export function normalizeBaseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return "";
  // 多个结尾斜杠一并去掉，避免拼出 `//decisions` 这种空段路径。
  return text.replace(TRAILING_SLASHES_RE, "");
}

/**
 * 校验 base URL 是否可用。
 *
 * 规则刻意严格，因为「地址写错」是本插件最难自查的故障：请求会打到一个
 * 不存在的路径，服务端多半回 404，而降级是静默的——用户只看到「守卫没反应」。
 *
 * @param raw - 用户填写的地址。
 * @returns `{ ok: true, value }` 或 `{ ok: false, error }`（error 为可直接展示的中文）。
 */
export function validateBaseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return { ok: false, error: "base URL 不能为空" };
  // 同一个地址字符串只解析一次（见 VALIDATED_BASE_URLS 的注释）。
  //
  // 命中缓存时返回**副本**，不返回缓存里的那个对象：本函数是导出的公共 API，
  // 调用方拿到 `{ok,value,error}` 后完全可能就地改写（打标记、改文案）。若
  // 把缓存对象直接交出去，一次改写就会污染之后所有同地址的校验结果——那是
  // 一个只在「有人恰好改了它」时才出现、且极难复现的 bug。三个字段的浅拷贝
  // 比一次 URL 解析便宜得多，用它把这类风险关掉。
  const hit = VALIDATED_BASE_URLS.get(text);
  if (hit !== undefined) return { ...hit };
  const fresh = checkBaseUrlShape(text);
  remember(VALIDATED_BASE_URLS, text, fresh);
  // 返回值再拷一份：缓存里那份从此不与外部共享。
  return { ...fresh };
}

/**
 * 逐条判断地址形状。
 *
 * 拆出来只是因为 `validateBaseUrl` 加了缓存层，规则本身与错误文案一字未改。
 *
 * @param text - 已经 trim 过的地址文本（非空）。
 * @returns `{ ok: true, value }` 或 `{ ok: false, error }`。
 */
function checkBaseUrlShape(text) {
  if (HAS_WHITESPACE_RE.test(text)) return { ok: false, error: "base URL 不能包含空格或换行" };
  if (!SCHEME_RE.test(text)) {
    return { ok: false, error: "base URL 必须以 http:// 或 https:// 开头" };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "base URL 不是合法地址（示例：https://api.example.com/v1）" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `base URL 只支持 http/https，当前是 ${url.protocol}` };
  }
  if (url.hostname.length === 0) return { ok: false, error: "base URL 缺少主机名" };
  // 只允许「地址 + 路径」，带查询串会让端点拼接结果不可预测。
  if (url.search.length > 0) return { ok: false, error: "base URL 不要带查询串（? 之后的部分）" };
  // text 已经 trim 过，这里等价于 normalizeBaseUrl(text)。
  return { ok: true, value: text.replace(TRAILING_SLASHES_RE, "") };
}

/**
 * 判断某个路径是否已经是完整决策端点。
 *
 * @param path - URL 的 pathname（可含结尾斜杠）。
 * @returns "decisions" / "systemone" / undefined。
 */
export function endpointStyleOfPath(path) {
  return styleOfNormalizedPath(String(path ?? "").replace(TRAILING_SLASHES_RE, ""));
}

/**
 * 取「已去掉结尾斜杠」路径的最后一段并判断是否是决策端点。
 *
 * 与 `endpointStyleOfPath` 等价的快速版本：调用方手里的 pathname 已经去过
 * 结尾斜杠，所以不必再 replace/split/filter，一次 lastIndexOf 就够。
 *（空段不影响结果：`//decisions` 的最后一段仍是 `decisions`。）
 *
 * @param path - 去过结尾斜杠的路径。
 * @returns "decisions" / "systemone" / undefined。
 */
function styleOfNormalizedPath(path) {
  const slash = path.lastIndexOf("/");
  const tail = slash < 0 ? path : path.slice(slash + 1);
  if (tail === "decisions" || tail === "systemone") return tail;
  return undefined;
}

/**
 * 把 base URL 拼成可直接 POST 的完整端点。
 *
 * 这是本插件的核心可用性修复点：旧实现把配置原样 POST，用户按各家 SDK 的
 * 习惯填 `.../v1` 就必然 404（`Invalid URL (POST /v1)`）。现在的规则：
 *
 *   - 已经以 `/decisions` 或 `/systemone` 结尾 → 原样使用（用户填了完整端点）
 *   - 只有 origin（没有路径）→ 补 `/v1/<段>`（对齐各家的 `/v1/...` 约定）
 *   - 其它路径（`/v1`、`/api/v1`、`/openai/v1`）→ 追加 `/<段>`，不重复、不丢段
 *
 * 结尾斜杠在拼接前统一去掉，因此 `.../v1/` 与 `.../v1` 得到同一结果。
 *
 * @param baseUrl - base URL（可含结尾斜杠，可缺 scheme 的旧配置由调用方补齐）。
 * @param style - `decisions` / `systemone` / `auto`。
 * @returns 完整端点；输入为空时返回 ""。
 */
export function buildEndpoint(baseUrl, style = "decisions") {
  return endpointPlanOf(baseUrl, style).endpoint;
}

/**
 * 一次解析算出「这个地址在该风格下的端点与候选端点」。
 *
 * 为什么要合并：`buildEndpoint` 与 `endpointCandidates` 过去各自把同一个地址
 * 重新 `new URL()` 一遍，而 `resolveProvider` 每次请求都会连着调用它们
 *（外加 `validateBaseUrl`，一次决策要解析同一个字符串 4~5 次）。
 * 合并后每个不同的「地址 + 风格」组合只解析一次，结果进 `ENDPOINT_PLANS`。
 *
 * 非法 URL 的处理与旧版逐字一致：`endpoint` 原样返回（让调用方拿到明确的
 * fetch 失败而不是猜），`candidates` 为空（不构造候选，交给调用方报错）。
 *
 * @param baseUrl - base URL（可含结尾斜杠）。
 * @param style - `decisions` / `systemone` / `auto`。
 * @returns `{ endpoint, candidates }`；candidates 是缓存里的数组，**只读**。
 */
function endpointPlanOf(baseUrl, style) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.length === 0) return EMPTY_PLAN;
  const key = `${style}\u0000${normalized}`;
  const hit = ENDPOINT_PLANS.get(key);
  if (hit !== undefined) return hit;
  return remember(ENDPOINT_PLANS, key, buildEndpointPlan(normalized, style));
}

/**
 * 真正做解析与拼接的地方（只被 `endpointPlanOf` 的缓存未命中路径调用）。
 *
 * @param normalized - 已规范化的 base URL（非空）。
 * @param style - 端点风格。
 * @returns `{ endpoint, candidates }`。
 */
function buildEndpointPlan(normalized, style) {
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return { endpoint: normalized, candidates: EMPTY_CANDIDATES };
  }
  const path = url.pathname.replace(TRAILING_SLASHES_RE, "");
  // 1) 已经指向决策端点：原样使用，不再叠加，也不给第二条候选
  //（用户填了完整端点就是明确决定，不该被自动改写）。
  const existing = styleOfNormalizedPath(path);
  if (existing !== undefined) {
    url.pathname = path;
    const endpoint = url.toString();
    return { endpoint, candidates: [endpoint] };
  }
  // 两条路径段：首选由风格决定，另一条用于 404 回退。
  // auto 与无法识别的取值都按 decisions 处理（与历史行为一致）。
  const primary = style === "systemone" ? "systemone" : "decisions";
  const secondary = ALTERNATE_STYLE[primary];
  const candidates = [];
  // 2) 只有 origin：补 /v1/<段>；3) 已有路径：只追加最后一段，避免 /v1/v1。
  // 两条候选共用同一个已解析的 URL 对象，只改 pathname，不再解析第二次。
  url.pathname = path.length === 0 ? `/v1/${primary}` : `${path}/${primary}`;
  const endpoint = url.toString();
  candidates.push(endpoint);
  url.pathname = path.length === 0 ? `/v1/${secondary}` : `${path}/${secondary}`;
  const other = url.toString();
  if (other !== endpoint) candidates.push(other);
  return { endpoint, candidates };
}

/** 空地址的计划（`endpointPlanOf` 的短路返回值，避免每请求新建对象）。 */
const EMPTY_PLAN = { endpoint: "", candidates: EMPTY_CANDIDATES };

/**
 * 列出「同一个 base URL 下所有值得一试的端点」，按优先级排列。
 *
 * 背景（2026-10-25 实测）：路径后缀由**服务商**决定，不由模型决定——
 * SiliconFlow 的 Kev-4B 只认 `/v1/systemone`（`/v1/decisions` 回 404），
 * 而 bamboonode 的决策模型两条路径都能用。因此「只拼一条路径」在换服务商
 * 时必然踩空，而守卫是 fail-open 的，踩空表现为**静默失效**。
 *
 * 候选规则：
 *
 *   - 地址**已自带**端点段（`.../v1/decisions` 或 `.../v1/systemone`）→
 *     只返回它自己。用户填了完整端点就是明确决定，不该被自动改写。
 *   - `auto` → 先试 `decisions`（与历史行为一致），再试 `systemone`。
 *   - 显式 `decisions` / `systemone` → 先试它自己，**再试另一条**。
 *
 * 最后一条是关键：显式指定只是「首选」，不是「唯一」。显式指定错路径时
 * 同样会 404，届时仍应回退到另一条——否则「选错了就只能手动改」这种
 * 死胡同会被用户当成插件的 bug。
 *
 * @param baseUrl - base URL。
 * @param style - `decisions` / `systemone` / `auto`。
 * @returns 候选端点数组（去重，优先级从高到低）。
 */
export function endpointCandidates(baseUrl, style = "auto") {
  const plan = endpointPlanOf(baseUrl, style);
  // 计划里的数组是共享的，返回副本以免调用方排序/改写污染缓存
  //（endpointMemory.order 会重排候选顺序）。
  return plan.candidates.length === 0 ? [] : [...plan.candidates];
}

/**
 * 端点风格 → 它对应的路径段（用于回显「当前用的是哪条路径」）。
 *
 * @param style - 风格取值。
 * @returns `decisions` / `systemone`；无法识别时返回 "decisions"。
 */
export function styleSegment(style) {
  return STYLE_SEGMENT[style] ?? "decisions";
}

/**
 * 解析 `customHeaders` 配置。
 *
 * 存储形态是 `Name: Value; Name2: Value2` 的单行字符串——本插件的配置读取器
 * 是极简 YAML 子集（只认标量与 `[a, b]` 数组），嵌套映射读不出来；用分号
 * 分隔既能在 `config.yml` 里手写，也能被面板原样回显。
 *
 * 受保护的头（`authorization` / `content-type` / `host`）会被忽略：鉴权方式
 * 必须与决策端点约定保持一致，否则换 provider 就可能悄悄换掉认证协议。
 *
 * @param raw - 字符串或字符串数组。
 * @returns 可直接并入 fetch headers 的对象（可能为空对象）。
 */
export function parseCustomHeaders(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  const entries = Array.isArray(raw) ? raw.map((item) => String(item ?? "")) : String(raw ?? "").split(/[;\n]/);
  for (const entry of entries) {
    const line = entry.trim();
    if (line.length === 0) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (name.length === 0 || value.length === 0) continue;
    // 头名只接受 RFC 7230 的 token 字符，避免把说明文字当成头。
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "content-type" || lower === "host") continue;
    out[name] = value;
  }
  return out;
}

/**
 * 解析某个 provider 此刻生效的完整配置。
 *
 * 这是全插件唯一的「provider → 请求参数」解析点。`classify()`、探测、
 * 模型列表、状态接口都调它，因此三处不可能再各写一套地址规则。
 *
 * 解析顺序（内置预设）：预设默认值打底，`config.yml` 里显式写的值覆盖。
 * 对 bamboonode 额外保留 `baseUrl` 的覆盖语义——那是老版本唯一的地址字段，
 * 用户可能已经指向自建的 bamboonode 兼容服务，升级不能把它改回官方地址。
 *
 * @param cfg - 已合并的配置对象（可能缺字段）。
 * @param options.server - 服务端下发的覆盖值（`{ baseUrl, model, endpointStyle }`）。
 *   存在时整段走覆盖分支，本地配置一律不读：服务端下发代表**当前权威配置**，
 *   若还让本地字段参与覆盖，用户机器上残留的旧地址就会盖掉管理员的改动。
 * @returns 生效配置；`valid=false` 时 `error` 是可展示的中文原因。
 */
export function resolveProvider(cfg = {}, options = {}) {
  // 只有拿到对象才算「服务端下发了配置」：null / 字符串等一律视为没有，
  // 完全走既有逻辑。既有调用方只传 cfg，因此升级后行为逐字不变。
  const server = options?.server;
  if (server !== null && typeof server === "object") return buildServerProvider(server);

  const requested = typeof cfg.provider === "string" ? cfg.provider.trim() : "";
  const id = PROVIDER_ID_SET.has(requested) ? requested : DEFAULT_PROVIDER;
  const preset = PROVIDER_PRESETS[id];

  if (id === "custom") {
    const rawBase = typeof cfg.customBaseUrl === "string" ? cfg.customBaseUrl : "";
    const checked = validateBaseUrl(rawBase);
    const style = ENDPOINT_STYLES.includes(cfg.customEndpointStyle) ? cfg.customEndpointStyle : "auto";
    const baseUrl = checked.ok ? checked.value : normalizeBaseUrl(rawBase);
    // checked 不通过时地址不可用，计划退化为空端点/空候选（与旧版一致）。
    const plan = checked.ok ? endpointPlanOf(baseUrl, style) : EMPTY_PLAN;
    const model = typeof cfg.customModel === "string" ? cfg.customModel.trim() : "";
    return {
      id,
      label: preset.label,
      preset,
      source: "custom",
      baseUrl,
      // 端点与候选端点来自同一次解析（见 endpointPlanOf）。
      endpoint: plan.endpoint,
      candidates: [...plan.candidates],
      endpointStyle: style,
      model,
      defaultModel: "",
      thinkMode: normalizeThinkMode(cfg.thinkMode),
      apiKeyEnv: firstNonEmpty(cfg.customApiKeyEnv, preset.apiKeyEnv),
      legacyApiKeyEnvs: [...(preset.legacyApiKeyEnvs ?? [])],
      explicitKey: typeof cfg[preset.keyField] === "string" ? cfg[preset.keyField].trim() : "",
      headers: parseCustomHeaders(cfg.customHeaders),
      valid: checked.ok,
      error: checked.ok ? undefined : `自定义 provider 的 base URL 不可用：${checked.error}`,
    };
  }

  // 内置预设：预设默认打底，配置覆盖。
  const presetBase = preset.baseUrl;
  const legacyBase =
    id === "bamboonode" && typeof cfg.baseUrl === "string" ? normalizeBaseUrl(cfg.baseUrl) : "";
  let baseUrl = legacyBase.length > 0 ? legacyBase : presetBase;
  // 老配置允许省略 scheme（`api.x.dev/v1`），预设值自带 scheme，这里只补缺。
  if (baseUrl.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
  const checked = validateBaseUrl(baseUrl);
  const plan = checked.ok ? endpointPlanOf(baseUrl, preset.endpointStyle) : EMPTY_PLAN;
  // 模型按 provider 分开读：`model` 属于 bamboonode（老版本唯一的模型字段），
  // `systemoneModel` 属于 system one。共用一格会把 bamboonode 的模型名发给
  // TypeSafe，得到 400 `model not served`——「切 provider 就坏」的典型来源。
  const modelField = preset.modelField;
  const rawModel = typeof cfg[modelField] === "string" ? cfg[modelField].trim() : "";
  // 模型留空有两种含义，取决于该服务商的端点接不接受「不带 model」的请求：
  //
  //   - requiresModel（SiliconFlow 实测）：省略或空串都回 400
  //     `Model field is required.`，因此留空必须回落到预设的 defaultModel
  //     ——不发一个注定失败的请求，守卫才不会又一次静默失效。
  //   - 其余服务商：留空 = 省略字段，由服务端回填默认模型。保留省略语义，
  //     服务商将来给模型改名时本配置不会失效（反过来把模型名钉死在这里
  //     才是最脆的那种配法）。
  const model =
    rawModel.length > 0 ? rawModel : preset.requiresModel === true ? preset.defaultModel : "";
  // 密钥变量名：`apiKeyEnv` 是**历史字段**，只对 bamboonode 有覆盖意义
  //（老版本只有这一个 provider，用户可能已经在里面写了自己的变量名）。
  // 若让它参与 system one 的解析，会盖掉 TYPESAFE_API_KEY——切到 system one
  // 却拿 bamboonode 的 key 去请求，得到 401 而用户完全看不出为什么。
  //
  // 历史字段里若写的是「旧默认名」或「旧环境变量」，不算用户自定义，
  // 由 `normalizeKeyEnvOverride` 过滤掉——否则改名永远不生效。
  const legacyKeyEnv = id === "bamboonode" ? normalizeKeyEnvOverride(cfg.apiKeyEnv, preset) : undefined;
  // 新名优先，旧名仅作回退。旧名不能出现在 apiKeyEnv 里
  //（那是「当前生效变量」的展示来源）。
  const configuredKeyEnv = firstNonEmpty(cfg[preset.keyEnvField], legacyKeyEnv, preset.apiKeyEnv);
  const fallbackKeyEnvs = [...(preset.legacyApiKeyEnvs ?? [])].filter(
    (name) => name !== configuredKeyEnv,
  );
  return {
    id,
    label: preset.label,
    preset,
    source: legacyBase.length > 0 ? "legacy" : "preset",
    baseUrl: checked.ok ? checked.value : baseUrl,
    // 端点与候选端点来自同一次解析：预设自己的路径优先，404 时换另一条再试。
    // 实测 bamboonode 两条路径都通，SiliconFlow 只通 /systemone。
    endpoint: plan.endpoint,
    candidates: [...plan.candidates],
    endpointStyle: preset.endpointStyle,
    model,
    defaultModel: preset.defaultModel,
    thinkMode: normalizeThinkMode(cfg.thinkMode),
    apiKeyEnv: configuredKeyEnv,
    legacyApiKeyEnvs: fallbackKeyEnvs,
    // 显式 key 也按 provider 分开存：切到 system one 时不会拿 bamboonode 的
    // 明文 key 去请求。历史共享字段 `apiKey` 仅对 bamboonode 做一次兼容读取
    //（老版本的 yml 里只有这一个 key 字段）。
    explicitKey: firstNonEmpty(
      cfg[preset.keyField],
      id === "bamboonode" ? cfg.apiKey : undefined,
    ),
    headers: {},
    valid: checked.ok,
    error: checked.ok ? undefined : `provider ${id} 的 base URL 不可用：${checked.error}`,
  };
}

/**
 * 由服务端下发值构造 provider（`resolveProvider` 的 server 分支）。
 *
 * 与本地预设的关键差异：
 *
 *   1. 没有预设表条目，所以 `preset` 为 undefined；`model` 留空表示「省略
 *      model 字段」，不当成「回落到某个默认模型」——默认模型由下发方决定。
 *   2. key 不在本地解析：服务端是连同 key 一起下发的（见 server-config.js），
 *      因此这里 `explicitKey` 为空、`apiKeyEnv` 也为空。刻意不留本地变量名：
 *      留了就会在下发失效时退回用户自己的 key 打向服务端地址，那是拿错了
 *      账号的 key，而守卫是 fail-open 的，表现为静默失效。宁可「没有 key」。
 *
 * base URL 非法时不抛错，只把 `valid` 置 false 并给出中文原因：解析点遍布
 * 请求路径，抛错会把一次「配置暂时不可用」放大成决策失败。
 *
 * @param server - 服务端下发的覆盖值，字段可能缺失或类型不对。
 * @returns 与预设分支同形状的 provider 对象。
 */
function buildServerProvider(server) {
  const checked = validateBaseUrl(server.baseUrl);
  // 风格必须是三者之一；缺失或非法回落 auto，避免拼出 `/undefined` 这类路径。
  const endpointStyle = ENDPOINT_STYLES.includes(server.endpointStyle) ? server.endpointStyle : "auto";
  const model = typeof server.model === "string" ? server.model.trim() : "";
  const baseUrl = checked.ok ? checked.value : normalizeBaseUrl(server.baseUrl);
  const plan = checked.ok ? endpointPlanOf(baseUrl, endpointStyle) : EMPTY_PLAN;
  return {
    id: SERVER_PROVIDER_ID,
    label: SERVER_PROVIDER_LABEL,
    preset: undefined,
    source: "server",
    baseUrl,
    // 端点与候选端点同样按优先级来自同一次解析：
    // 服务端指错路径时仍有一条退路（见 DEC-002）。
    endpoint: plan.endpoint,
    candidates: [...plan.candidates],
    endpointStyle,
    model,
    headers: {},
    apiKeyEnv: "",
    legacyApiKeyEnvs: [],
    explicitKey: "",
    valid: checked.ok,
    error: checked.ok ? undefined : `服务端下发的 base URL 不可用：${checked.error}`,
  };
}

/**
 * 按 provider 解析生效的 API key。
 *
 * 优先级与旧版本一致，只是「显式 key / 环境变量名」现在由 provider 决定：
 *
 *   0. `options.memoryKey`——服务端随配置一起下发的 key（最高优先级）
 *   1. 该 provider 的显式 key（`apiKey` 或 `customApiKey`）
 *   2. `~/.dsh/.credentials.yaml` 的 `refs:` 段（推荐，与其他服务统一托管）
 *   3. 环境变量
 *
 * 第 0 项排在本地一切来源之前：服务端下发是一整套配置（地址 + key），
 * 只取地址而拿本地 key 去打，等于用另一个账号的凭据请求，几乎必然 401，
 * 而用户看不出是「key 不对」还是「地址不对」。
 *
 * 凭据读取由调用方注入，因此本模块不碰文件系统，可在裸 Node 下单测。
 *
 * @param provider - `resolveProvider()` 的结果。
 * @param options.memoryKey - 服务端下发的明文 key（可省略）。
 * @param options.credentialReader - `(ref) => string | undefined`。
 * @param options.env - 环境变量表，默认 `process.env`。
 * @returns 密钥，或 undefined。
 */
export function resolveKeyFor(provider, options = {}) {
  // 空串必须当作「没有」：把 "" 当已配置会发出 `Bearer ` 这种注定 401 的请求。
  const memoryKey = typeof options.memoryKey === "string" ? options.memoryKey.trim() : "";
  if (memoryKey.length > 0) return memoryKey;
  if (provider.explicitKey.length > 0) return provider.explicitKey;
  const reader = options.credentialReader;
  const env = options.env ?? process.env;

  // 变量名按「新名 → 旧名」依次尝试。旧名只做回退：用户把 key 存在
  // BAMBOO_API_KEY 里的旧安装，升级后不必重填就能继续工作。
  const names = [provider.apiKeyEnv, ...(provider.legacyApiKeyEnvs ?? [])].filter(
    (name) => typeof name === "string" && name.length > 0,
  );
  for (const envName of names) {
    if (typeof reader === "function") {
      const fromCredentials = reader(envName);
      if (typeof fromCredentials === "string" && fromCredentials.length > 0) return fromCredentials;
    }
    const fromEnv = env?.[envName];
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  }
  return undefined;
}

/**
 * 解析生效的 API key（可省略已解析 provider 的便捷版本）。
 *
 * 与 `resolveKeyFor` 的唯一差别是允许把 cfg 一起传进来；凭据文件读取仍然
 * 只能由调用方经 `options.credentialReader` 注入——本模块是零 I/O 的，
 * 一旦自己去读文件，就无法在裸 Node 下单独验证优先级。
 *
 * @param cfg - 当前配置。
 * @param provider - 可选的已解析 provider；缺省时按 cfg 与 options 解析。
 * @param options - 原样透传给 `resolveKeyFor`（memoryKey / credentialReader / env）。
 *   同时透给 `resolveProvider`，这样 `{ server }` 也能在这里生效。
 * @returns 密钥，或 undefined。
 */
export function resolveKey(cfg, provider, options = {}) {
  const resolved = provider ?? resolveProvider(cfg, options);
  return resolveKeyFor(resolved, options);
}

/**
 * 构造请求头。
 *
 * `authorization` 与 `content-type` 最后写入，因此自定义头无法覆盖它们——
 * 鉴权方式必须对所有 provider 一致（Bearer），这是响应结构一致性的前提。
 *
 * @param provider - `resolveProvider()` 的结果。
 * @param key - 已解析的 API key。
 * @returns fetch headers。
 */
export function buildHeaders(provider, key) {
  return {
    ...provider.headers,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

/**
 * 构造请求体（决策端点线协议，对所有 provider 相同）。
 *
 * `model` 为空时**省略字段**而不是发空串：实测端点对 `"model": ""` 回
 * 400 `model must be a nonempty string`，而省略字段会回填服务端默认模型。
 *
 * @param provider - `resolveProvider()` 的结果。
 * @param payload.state - 决策上下文。
 * @param payload.questions - 问题集。
 * @param payload.thinkMode - 覆盖 provider 上的 thinkMode（探测用）。
 * @returns 可直接 JSON.stringify 的对象。
 */
export function buildRequestBody(provider, payload) {
  const model = (provider.model ?? "").trim();
  return {
    ...(model.length > 0 ? { model } : {}),
    state: payload.state,
    questions: payload.questions,
    think_mode: normalizeThinkMode(payload.thinkMode ?? provider.thinkMode),
  };
}

/**
 * 供设置界面展示的 provider 清单。
 *
 * 由服务端下发而不是前端硬编码：新增预设只改本文件一处，界面自动多一个选项。
 * `keyField` / `modelField` 也一并下发——界面写回配置时必须知道「这一格在
 * config.yml 里叫什么」，而这个名字只有预设表知道；让前端自己再抄一份，
 * 就是「界面显示存到 A、实际写进 B」这种最难自查的偏差。
 *
 * @returns 每个预设的 id / 显示名 / 默认地址 / 字段名 / 说明。
 */
export function providerCatalog() {
  return PROVIDER_IDS.map((id) => {
    const preset = PROVIDER_PRESETS[id];
    return {
      id,
      label: preset.label,
      labelEn: preset.labelEn,
      baseUrl: preset.baseUrl,
      endpointStyle: preset.endpointStyle,
      defaultModel: preset.defaultModel,
      apiKeyEnv: preset.apiKeyEnv,
      // 该 provider 的显式 key 字段名（`bamboonodeApiKey` 等）。
      // 界面用它说明「key 存在配置文件的哪一格」——只报变量名会让人
      // 以为 key 在 .credentials.yaml 里，而实际生效的可能是配置文件。
      keyField: preset.keyField,
      // 该 provider 的模型字段名（`model` / `systemoneModel` / …）。
      // 模型输入框按它写回配置，切 provider 不会把 A 的模型名写进 B 那一格。
      modelField: preset.modelField,
      // 「模型」那一行的语义全靠这两项：端点是否强制要 model（决定留空的
      // 写法是「预设默认」还是「服务端默认」），以及能选的模型有哪些。
      // 都由预设表下发，前端不必知道任何一家服务商的脾气。
      requiresModel: preset.requiresModel === true,
      knownModels: [...(preset.knownModels ?? [])],
      hint: preset.hint,
      hintEn: preset.hintEn,
      customizable: id === "custom",
    };
  });
}

/**
 * 判断历史字段 `apiKeyEnv` 的值算不算「用户自定义」。
 *
 * 老版本只有 bamboonode 一个 provider，yam 里写的是旧默认名
 * （`BAMBOO_API_KEY`）或对应的**旧环境变量**。这两种都不算用户自定义——
 * 前者是默认值残留，后者是改名前的变量名——因此一律返回 undefined，
 * 让预设自己的默认名接管。
 *
 * 只有用户填了**别的**变量名（例如 `MY_KEY`）才认为是他主动指定的，予以保留。
 *
 * @param raw - 配置里的 apiKeyEnv。
 * @param preset - 该 provider 的预设。
 * @returns 需要尊重的自定义变量名，或 undefined。
 */
function normalizeKeyEnvOverride(raw, preset) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) return undefined;
  // 等于预设的当前默认名：不是自定义。
  if (name === preset.apiKeyEnv) return undefined;
  // 等于该预设的旧名：是老默认值，不算自定义（改名要能生效）。
  if ((preset.legacyApiKeyEnvs ?? []).includes(name)) return undefined;
  return name;
}

/** 取第一个非空字符串。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
