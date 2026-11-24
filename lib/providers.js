/**
 * Provider 配置模型 —— 所有决策请求的唯一构造入口。
 *
 * 为什么要单独一层：
 *
 * 早期版本把服务地址硬编码在请求路径、配置页默认值和探测脚本三处。
 * 这带来两个问题：
 *
 *   1. 想接 TypeSafe 的 `/v1/systemone`、自建 llama.cpp 决策服务、
 *      或者任何提供同类决策端点的网关时，只能改源码。
 *   2. 三处硬编码会各自漂移：改了一处，配置页仍显示旧地址，用户以为没生效。
 *
 * 现在所有 provider 差异（base URL、端点风格、环境变量名、可用模型）都收在
 * `providers.json` 里，`index.js` / `client.js` / 探测脚本只消费解析结果。
 * 本模块只在加载时读这一份数据文件，不读用户配置、不读环境变量、不发请求，
 * 因此可以在裸 Node 下直接单测（见 test/providers.test.js）。
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
 * noul 题统一带 `criteria: { true, false }` 也是这条不变式的一部分：
 * 它是 System One 线协议里 noul 题的标准形状（兄弟插件 dsh-jev-decision-model
 * 一直这么发），端砚等端点缺了就回 400。
 *
 * @module dsh-decision-engine/providers
 */

import { ENDPOINT_STYLES, PROVIDER_LIST, parseProviderPresets } from "./provider-presets.js";
// 地址与端点（规范化 / 校验 / 拼接 / 候选）拆到独立模块：那一块是纯字符串
// 处理，与「哪个 provider、用谁的 key」无关。本文件把出口原样再导出，
// 调用方（index.js、探测脚本、测试）不需要改。
import {
  EMPTY_PLAN,
  buildEndpoint,
  endpointCandidates,
  endpointPlanOf,
  endpointStyleOfPath,
  normalizeBaseUrl,
  parseCustomHeaders,
  styleSegment,
  validateBaseUrl,
} from "./provider-endpoint.js";
// 线协议（请求体 / 鉴权头 / 答案形状）拆到独立模块：一个协议三件事成对
// 出现，放同一处才不会出现「请求按 A 发、答案按 B 读」这种只坏一半的接法。
import {
  DEFAULT_THINK_MODE,
  THINK_MODES,
  buildHeaders,
  buildRequestBody,
  normalizeThinkMode,
  readAnswers,
} from "./wire-protocol.js";

/**
 * 数据层的两个出口原样再导出。
 *
 * `ENDPOINT_STYLES` 一直是本模块的公开常量；`parseProviderPresets` 是新增的
 * 归一入口（测试直接用它造「只改了 JSON」的样本）。调用方不必知道数据层
 * 已拆到 `provider-presets.js`。
 */
export { ENDPOINT_STYLES, parseProviderPresets };

/**
 * 可选的 provider 标识。
 *
 * 全部来自 `providers.json` 的数组顺序，`custom` 收尾（它要填的东西最多）。
 * 新增/删除 provider 只改 JSON，本模块与设置界面都跟着变。
 */
export const PROVIDER_IDS = PROVIDER_LIST.map((preset) => preset.id);

/**
 * 默认 provider：`providers.json` 里标了 `"default": true` 的那一条。
 */
export const DEFAULT_PROVIDER =
  PROVIDER_LIST.find((preset) => preset.default === true)?.id ?? PROVIDER_IDS[0];

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
 * 线协议的出口在这里原样再导出。
 *
 * 调用方（`index.js`、探测脚本、测试）一直从本模块取这几个函数；拆文件是
 * 内部结构变化，对外 API 不变——否则每个调用点都要改，且很容易漏一处。
 */
export { DEFAULT_THINK_MODE, THINK_MODES, buildHeaders, buildRequestBody, normalizeThinkMode, readAnswers };
/**
 * 地址与端点的出口同样原样再导出（`normalizeBaseUrl` / `validateBaseUrl` /
 * `buildEndpoint` / `endpointCandidates` / `endpointStyleOfPath` /
 * `parseCustomHeaders` / `styleSegment`）。
 */
export {
  buildEndpoint,
  endpointCandidates,
  endpointStyleOfPath,
  normalizeBaseUrl,
  parseCustomHeaders,
  styleSegment,
  validateBaseUrl,
};

/**
 * 内置预设。
 *
 * 每个预设必须给出：显示名称、默认 base URL、端点风格、环境变量名、
 * 默认模型与三个配置字段名。用户选了预设就用这里的值，不需要在设置界面
 * 重复填写。
 *
 * 三个可选标记（都是「按服务商实测」得出的，不是风格偏好）：
 *
 *   - `requiresModel: true`：该端点**不接受**省略 model 的请求（实测
 *     SiliconFlow 的 /v1/systemone 省略或空串都回 400
 *     `Model field is required.`）。这类预设在模型留空时回落到
 *     `defaultModel`，而不是沿用「留空 = 省略字段」的通用规则——
 *     那会导致一次注定 400 的请求，而守卫是 fail-open 的，表现为静默失效。
 *     其余服务商省略 model 会由服务端回填默认
 *     模型，保留省略语义才能在它们改名时不失效。
 *   - `models`：该服务真正可用的模型清单（JSON 里的数组）。非空时
 *     `/v1/models` 也按它筛——SiliconFlow 会返回 98 个模型且不带
 *     `supported_endpoint_types`（实测 chat 模型打到决策端点会回 400
 *     `Model does not exist.`），不筛就是「96 个选了就失败的选项」。
 *     空数组表示不限定，由服务端的模型清单决定。`defaultModel` 缺省取
 *     这份清单的第一项。
 *   - `default: true`：不写 provider 时用哪一条。
 *
 * 归一步骤见 `parseProviderPresets()`；字段名缺省时由 id 推导。
 */
export const PROVIDER_PRESETS = Object.fromEntries(
  PROVIDER_LIST.map((preset) => [preset.id, preset]),
);

/**
 * provider 标识的快速 membership 表。
 *
 * 与 `PROVIDER_IDS` 同源（就是它构造出来的），顺序仍是那份清单的顺序；
 * 这里只是把「每请求一次的数组 includes」换成 Set 查表。
 */
const PROVIDER_ID_SET = new Set(PROVIDER_IDS);

/**
 * 解析某个 provider 此刻生效的完整配置。
 *
 * 这是全插件唯一的「provider → 请求参数」解析点。`classify()`、探测、
 * 模型列表、状态接口都调它，因此三处不可能再各写一套地址规则。
 *
 * 解析顺序（内置预设）：预设默认值打底，`config.yml` 里显式写的值覆盖。
 * 对声明了 `legacyBaseUrlField` 的预设保留旧 `baseUrl` 字段覆盖语义，避免
 * 升级时丢失用户已有的自建服务地址。
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

  // 「自己填地址」的 provider 由 JSON 里的 `"customizable": true` 标记，
  // 不在代码里按 id 写死。其余预设走下面的通用路径。
  if (preset.customizable === true) {
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
      protocol: preset.protocol,
      capabilities: { ...preset.capabilities },
      supportsThinkMode: preset.supportsThinkMode === true,
      model,
      defaultModel: preset.defaultModel,
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
  // 历史地址字段：老版本只有一个 `baseUrl` 可写。
  // 哪个字段承载这段兼容由 JSON 的 `legacyBaseUrlField` 声明，新 provider 不必
  // 在代码里再加一个 id 判断。
  const legacyBaseField = preset.legacyBaseUrlField;
  const legacyBase =
    typeof legacyBaseField === "string" && typeof cfg[legacyBaseField] === "string"
      ? normalizeBaseUrl(cfg[legacyBaseField])
      : "";
  let baseUrl = legacyBase.length > 0 ? legacyBase : presetBase;
  // 老配置允许省略 scheme（`api.x.dev/v1`），预设值自带 scheme，这里只补缺。
  if (baseUrl.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
  const checked = validateBaseUrl(baseUrl);
  const plan = checked.ok ? endpointPlanOf(baseUrl, preset.endpointStyle) : EMPTY_PLAN;
  // 模型按 provider 分开读，避免切换 provider 时把一个服务的模型名发给另一家。
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
  // 历史变量名字段：老版本只有 `apiKeyEnv` 一个可写位置。是否参与由 JSON 的
  // `legacyKeyEnvOverride` 声明；字段名本身也可由 `legacyKeyEnvField` 指定。
  const legacyKeyEnvField = preset.legacyKeyEnvField ?? "apiKeyEnv";
  const legacyKeyEnv =
    preset.legacyKeyEnvOverride === true
      ? normalizeKeyEnvOverride(cfg[legacyKeyEnvField], preset)
      : undefined;
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
    // 路径可用性由服务商决定；记住成功路径以避免不必要的回退。
    endpoint: plan.endpoint,
    candidates: [...plan.candidates],
    endpointStyle: preset.endpointStyle,
    protocol: preset.protocol,
    capabilities: { ...preset.capabilities },
    supportsThinkMode: preset.supportsThinkMode === true,
    model,
    defaultModel: preset.defaultModel,
    thinkMode: normalizeThinkMode(cfg.thinkMode),
    apiKeyEnv: configuredKeyEnv,
    legacyApiKeyEnvs: fallbackKeyEnvs,
    // 显式 key 按 provider 分开存。历史共享字段（`apiKey`）只对声明了
    // `legacyKeyField` 的预设兼容读取。
    explicitKey: firstNonEmpty(
      cfg[preset.keyField],
      typeof preset.legacyKeyField === "string" ? cfg[preset.legacyKeyField] : undefined,
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
    protocol: typeof server.protocol === "string" ? server.protocol.trim() : "systemone",
    // 下发值不带能力声明，按协议推：只有 systemone 线协议有 think_mode。
    capabilities: {
      // 下发值只有协议，没有能力声明——按协议推断（同数据层的规则）。
      thinkMode: (typeof server.protocol === "string" ? server.protocol.trim() : "systemone") === "systemone",
    },
    supportsThinkMode:
      (typeof server.protocol === "string" ? server.protocol.trim() : "systemone") === "systemone",
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
  // TYPESAFE_API_KEY 里的旧安装，升级后不必重填就能继续工作。
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
 * 供设置界面展示的 provider 清单。
 *
 * 由服务端下发而不是前端硬编码：新增预设只改 `lib/providers.json` 一处，
 * 界面自动多一个选项。`keyField` / `modelField` 也一并下发——界面写回配置时
 * 必须知道「这一格在 config.yml 里叫什么」，而这个名字只有 provider 数据
 * 知道；让前端自己再抄一份，就是「界面显示存到 A、实际写进 B」这种最难
 * 自查的偏差。
 *
 * @returns 每个预设的 id / 显示名 / 默认地址 / 字段名 / 模型清单 / 说明。
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
      protocol: preset.protocol,
      capabilities: { ...preset.capabilities },
      supportsThinkMode: preset.supportsThinkMode === true,
      defaultModel: preset.defaultModel,
      apiKeyEnv: preset.apiKeyEnv,
      // 该 provider 的显式 key 字段名（`systemoneApiKey` 等）。
      // 界面用它说明「key 存在配置文件的哪一格」——只报变量名会让人
      // 以为 key 在 .credentials.yaml 里，而实际生效的可能是配置文件。
      keyField: preset.keyField,
      // 该 provider 的模型字段名（`model` / `systemoneModel` / …）。
      // 模型输入框按它写回配置，切 provider 不会把 A 的模型名写进 B 那一格。
      modelField: preset.modelField,
      // 「模型」那一行的语义全靠这几项：端点是否强制要 model（决定留空的
      // 写法是「预设默认」还是「服务端默认」），以及能选的模型有哪些。
      // 都由 JSON 下发，前端不必知道任何一家服务商的脾气。
      requiresModel: preset.requiresModel === true,
      /**
       * 该端点是否接受 `think_mode`。
       *
       * 界面据此决定「思考模式」那一行是可用还是禁用：不能让人设置一个
       * 没有效果的选项（decisionmodels.io 实测回 400，另两种协议压根没这个
       * 字段）。能力由协议与数据层共同决定，前端不自己推断——它不可能知道
       * 哪家服务商的脾气。
       */
      capabilities: { ...preset.capabilities },
      supportsThinkMode: preset.supportsThinkMode === true,
      // canonical 字段：JSON 里的 models 数组。
      models: [...preset.models],
      // 兼容旧字段名（外部脚本/旧界面读 knownModels）。
      knownModels: [...preset.models],
      hint: preset.hint,
      hintEn: preset.hintEn,
      customizable: preset.customizable === true,
    };
  });
}

/**
 * 判断历史字段 `apiKeyEnv` 的值算不算「用户自定义」。
 *
 * 老配置写的是旧默认名
 * （`TYPESAFE_API_KEY`）或对应的**旧环境变量**。这两种都不算用户自定义——
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
