/**
 * 端点与地址：base URL 的规范化、校验、端点拼接与候选端点。
 *
 * 为什么单独一个文件：这一块是**纯字符串处理**（规范化 / 校验 / 拼路径 /
 * 记忆化），与「哪个 provider、用谁的 key、请求体长什么样」没有关系。
 * `providers.js` 改动前已 927 行，超过单文件预算；把这块搬出来之后它回到
 * 458 行，本文件 309 行，两边都在「一个文件一个主题」的范围内。
 *
 * 三条不变式（搬动时逐字保留，行为未变）：
 *
 *   1. 规范化永远返回字符串（可能仍非法）；**校验**才决定能不能存。
 *      两者失败语义不同，不能合并。
 *   2. 端点拼接只在两种情况下追加路径：只有 origin 时补 `/v1/<段>`，
 *      已有路径时只追加最后一段（避免 `/v1/v1/decisions`）。
 *   3. 地址已自带 `/decisions` 或 `/systemone` 时原样使用、只给一个候选——
 *      用户填了完整端点就是明确决定，不该被自动改写。
 *
 * 本模块零 I/O，可在裸 Node 下直接单测。
 *
 * @module dsh-decision-engine/provider-endpoint
 */

/** 端点风格 → 追加的路径段。 */
const STYLE_SEGMENT = { decisions: "decisions", systemone: "systemone" };

/**
 * 两条路径风格互为「另一条」。
 *
 * 用于 404 回退：路径不存在时换另一条再试一次。
 */
const ALTERNATE_STYLE = { decisions: "systemone", systemone: "decisions" };

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
export function endpointPlanOf(baseUrl, style) {
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
export const EMPTY_PLAN = { endpoint: "", candidates: EMPTY_CANDIDATES };

/**
 * 列出「同一个 base URL 下所有值得一试的端点」，按优先级排列。
 *
 * 背景（2026-10-25 实测）：路径后缀由**服务商**决定，不由模型决定——
 * SiliconFlow 的 Kev-4B 只认 `/v1/systemone`（`/v1/decisions` 回 404），
 * 而部分服务两条路径都能用。因此「只拼一条路径」在换服务商
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
