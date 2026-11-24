/**
 * Provider 配置模型的验收测试。
 *
 * 这一层刻意**不导入 lib/index.js**：那个模块依赖 `@deepseek-ai/schemastery`
 * （宿主 peer 依赖），在裸仓库里加载不了。providers.js（及其数据层
 * provider-presets.js）是零依赖的纯模块，因此地址拼接、校验、鉴权头、以及
 * 「JSON 里的一条 provider 怎么归一」这些最容易被改坏的东西可以脱离 DSH 单独测。
 *
 * 覆盖的验收项（对应需求里的 6 条）：
 *
 *   1. 内置 `system one` 选项可用
 *   2. 内置 `systemone` 选项保持原有行为
 *   3. custom base URL 可用
 *   4. 非法 URL 被拒绝
 *   5. 末尾斜杠与端点拼接不重复、不缺失
 *   6. 请求构造不再硬编码 systemone.dev
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_PROVIDER,
  DEFAULT_THINK_MODE,
  ENDPOINT_STYLES,
  PROVIDER_IDS,
  PROVIDER_PRESETS,
  THINK_MODES,
  buildEndpoint,
  buildHeaders,
  buildRequestBody,
  normalizeBaseUrl,
  normalizeThinkMode,
  parseCustomHeaders,
  parseProviderPresets,
  providerCatalog,
  resolveKeyFor,
  resolveProvider,
  validateBaseUrl,
} from "../lib/providers.js";

// ---------------------------------------------------------------- 1. 内置预设

test("内置预设齐备", () => {
  assert.deepEqual(
    [...PROVIDER_IDS],
    [
      "systemone",
      "siliconflow",
      "siliconflow-intl",
      "duanyan",
      "perplexity",
      "openrouter",
      "decisionmodels",
      "google-decisions",
      "openai-decisions",
      "custom",
    ],
  );
  for (const id of PROVIDER_IDS) {
    assert.ok(PROVIDER_PRESETS[id] !== undefined, `缺少预设 ${id}`);
  }
  // 自定义 provider 的「默认值」由用户给，因此地址为空是刻意设计。
  assert.equal(PROVIDER_PRESETS.custom.baseUrl, "");
});

test("provider 预设由 JSON 数组提供，models 映射为可选模型清单", () => {
  const definitions = JSON.parse(
    readFileSync(new URL("../lib/providers.json", import.meta.url), "utf8"),
  );
  assert.ok(Array.isArray(definitions));
  assert.deepEqual(definitions.map(({ id }) => id), [...PROVIDER_IDS]);
  for (const definition of definitions) {
    assert.ok(Array.isArray(definition.models), `${definition.id} 缺少 models 数组`);
    // models 既可以是字符串，也可以是 { id, capabilities } 对象；归一后
    // preset.models 始终是 id 清单。这里从两种写法里取出 id 再比对。
    const ids = definition.models.map((item) => (typeof item === "string" ? item : item.id));
    assert.deepEqual(PROVIDER_PRESETS[definition.id].models, ids);
    assert.deepEqual(PROVIDER_PRESETS[definition.id].knownModels, ids);
  }
});

test("默认 provider 与 custom 标记也来自 JSON，代码里不再写死", () => {
  const definitions = JSON.parse(
    readFileSync(new URL("../lib/providers.json", import.meta.url), "utf8"),
  );
  const defaults = definitions.filter((item) => item.default === true);
  assert.equal(defaults.length, 1, "必须恰好有一个 default: true");
  assert.equal(defaults[0].id, DEFAULT_PROVIDER);
  assert.equal(PROVIDER_PRESETS[DEFAULT_PROVIDER].default, true);

  const customizable = definitions.filter((item) => item.customizable === true);
  assert.equal(customizable.length, 1, "必须恰好有一个 customizable: true");
  // 界面拿这个标记决定「哪些字段归自定义区」，不是按 id 猜。
  assert.deepEqual(
    providerCatalog().filter((item) => item.customizable).map((item) => item.id),
    [customizable[0].id],
  );
});

test("providerCatalog 下发 models 数组（前端与统计只认这一份）", () => {
  const catalog = providerCatalog();
  const siliconflow = catalog.find((item) => item.id === "siliconflow");
  assert.deepEqual(siliconflow.models, ["Kev-4B", "SemIf"]);
  // 兼容字段与 canonical 字段同源，避免两处漂移。
  assert.deepEqual(siliconflow.knownModels, siliconflow.models);
  for (const item of catalog) {
    assert.ok(Array.isArray(item.models), `${item.id} 的 models 不是数组`);
  }
});

test("parseProviderPresets：最小条目就能新增 provider（字段名由 id 推导）", () => {
  const [preset] = parseProviderPresets([
    { id: "my-gateway", baseUrl: "https://gw.example.com/v1", models: ["m1", "m2"] },
  ]);
  assert.equal(preset.id, "my-gateway");
  // 只有 id 必填：显示名、端点风格、字段名、变量名都由数据/ id 推导。
  assert.equal(preset.label, "my-gateway");
  assert.equal(preset.endpointStyle, "auto");
  assert.equal(preset.modelField, "myGatewayModel");
  assert.equal(preset.keyField, "myGatewayApiKey");
  assert.equal(preset.keyEnvField, "myGatewayApiKeyEnv");
  assert.equal(preset.apiKeyEnv, "MY_GATEWAY_API_KEY");
  // 一家服务多个模型：数组即清单，默认取第一项。
  assert.deepEqual(preset.models, ["m1", "m2"]);
  assert.deepEqual(preset.knownModels, ["m1", "m2"]);
  assert.equal(preset.defaultModel, "m1");
});

test("parseProviderPresets：坏数据在加载时就报错（不能静默半生效）", () => {
  assert.throws(() => parseProviderPresets([{ id: "a" }, { id: "a" }]), /重复/, "重复 id 必须报错");
  assert.throws(
    () => parseProviderPresets([{ id: "a", keyField: "sameKey" }, { id: "b", keyField: "sameKey" }]),
    /共用/,
    "两个 provider 共用一个配置字段会互相覆盖",
  );
  assert.throws(() => parseProviderPresets([{ id: "Bad Id" }]), /id/, "非法 id 必须报错");
  assert.throws(() => parseProviderPresets([]), /至少/, "空数组没有可用的 provider");
});

test("system one 预设有显示名、默认地址、默认模型与端点风格", () => {
  const preset = PROVIDER_PRESETS.systemone;
  assert.equal(preset.label, "System One");
  assert.equal(preset.baseUrl, "https://api.typesafe.ai/v1");
  assert.equal(preset.endpointStyle, "systemone");
  assert.equal(preset.defaultModel, "jev-latest");
  assert.equal(preset.apiKeyEnv, "TYPESAFE_API_KEY");
});

test("选择 system one 时端点落在 /v1/systemone，鉴权变量名跟着换", () => {
  const provider = resolveProvider({ provider: "systemone" });
  assert.equal(provider.id, "systemone");
  assert.equal(provider.valid, true);
  assert.equal(provider.endpoint, "https://api.typesafe.ai/v1/systemone");
  // 变量名必须换成 system one 自己的：否则会拿 systemone 的 key 去打别的服务。
  assert.equal(provider.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.deepEqual(provider.headers, {});
});

test("不同 provider 各有各的 key 名，互不共用", () => {
  // 这是本插件的核心约定：一个 key 名对应一个服务。
  // 共用一格会导致「切 provider 就得重填」，也无法同时保存多套凭据。
  const base = resolveProvider({ provider: "systemone" });
  const siliconflow = resolveProvider({ provider: "siliconflow" });
  const custom = resolveProvider({ provider: "custom", customBaseUrl: "https://x.dev/v1" });

  assert.equal(base.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(siliconflow.apiKeyEnv, "SILICONFLOW_API_KEY");
  assert.equal(custom.apiKeyEnv, "DECISION_ENGINE_CUSTOM_KEY");

  // 三者必须互不相同——相同就等于又合并回一个了。
  const names = [base.apiKeyEnv, siliconflow.apiKeyEnv, custom.apiKeyEnv];
  assert.equal(new Set(names).size, 3, `key 名出现重复：${names.join(", ")}`);
});

test("用户自定义的密钥变量名会被尊重", () => {
  const custom = resolveProvider({ provider: "systemone", apiKeyEnv: "MY_OWN_KEY" });
  assert.equal(custom.apiKeyEnv, "MY_OWN_KEY");

  // 专用覆盖字段优先级最高
  const explicit = resolveProvider({
    provider: "systemone",
    systemoneApiKeyEnv: "EXPLICIT_KEY",
    apiKeyEnv: "MY_OWN_KEY",
  });
  assert.equal(explicit.apiKeyEnv, "EXPLICIT_KEY");
});

test("默认预设继续尊重旧配置中的 apiKeyEnv 覆盖", () => {
  const provider = resolveProvider({ provider: "systemone", apiKeyEnv: "MY_OLD_KEY" });
  assert.equal(provider.apiKeyEnv, "MY_OLD_KEY");
});

test("system one 允许用自己的密钥变量名覆盖预设", () => {
  const provider = resolveProvider({ provider: "systemone", systemoneApiKeyEnv: "MY_ONE_KEY" });
  assert.equal(provider.apiKeyEnv, "MY_ONE_KEY");
});

test("providerCatalog 覆盖全部 provider 且带展示信息", () => {
  const catalog = providerCatalog();
  assert.equal(catalog.length, PROVIDER_IDS.length);
  for (const item of catalog) {
    assert.ok(typeof item.label === "string" && item.label.length > 0, `${item.id} 缺显示名`);
    assert.ok(typeof item.hint === "string" && item.hint.length > 0, `${item.id} 缺说明`);
    assert.equal(item.customizable, item.id === "custom");
  }
  // 内置预设必须自带默认地址，否则「选内置就用默认」这条承诺落空。
  for (const item of catalog) {
    if (item.id === "custom") continue;
    assert.ok(/^https?:\/\//.test(item.baseUrl), `${item.id} 的默认地址不是 http(s)`);
  }
  // 每个 provider 必须带自己的显式 key 字段名：界面靠它说明「key 存在
  // 配置文件的哪一格」。缺了它，就只能退回显示凭据变量名——那正是
  // 「keyStorage=config 却显示 TYPESAFE_API_KEY」误解的来源。
  const fields = catalog.map((item) => item.keyField);
  assert.deepEqual(fields, [
    "systemoneApiKey",
    "siliconflowApiKey",
    "siliconflowIntlApiKey",
    "duanyanApiKey",
    "perplexityApiKey",
    "openrouterApiKey",
    "decisionModelsApiKey",
    "googleDecisionsApiKey",
    "openaiDecisionsApiKey",
    "customApiKey",
  ]);
  // 字段必须互不相同：共用一格会导致切换 provider 时互相覆盖。
  assert.equal(new Set(fields).size, fields.length);
  // 模型字段同理：写回配置靠它定位「哪一格」，撞名就是串台。
  const modelFields = catalog.map((item) => item.modelField);
  assert.deepEqual(modelFields, [
    "systemoneModel",
    "siliconflowModel",
    "siliconflowIntlModel",
    "duanyanModel",
    "perplexityModel",
    "openrouterModel",
    "decisionModelsModel",
    "googleDecisionsModel",
    "openaiDecisionsModel",
    "customModel",
  ]);
  assert.equal(new Set(modelFields).size, modelFields.length);
});

// ------------------------------------------------- 2. systemone 行为不变

test("默认 provider 为 systemone", () => {
  assert.equal(DEFAULT_PROVIDER, "systemone");
  const provider = resolveProvider({});
  assert.equal(provider.id, "systemone");
  assert.equal(provider.endpoint, "https://api.typesafe.ai/v1/systemone");
  assert.equal(provider.apiKeyEnv, "TYPESAFE_API_KEY");
  // 上一版短暂用过 DECISION_ENGINE_KEY，仍作回退读取，老安装不必重填
  assert.deepEqual(provider.legacyApiKeyEnvs, ["DECISION_ENGINE_KEY"]);
  assert.equal(provider.source, "preset");
});

test("默认 provider 继续尊重老 baseUrl 覆盖（含完整端点写法）", () => {
  const full = resolveProvider({ provider: "systemone", baseUrl: "https://api.typesafe.ai/v1/systemone" });
  assert.equal(full.endpoint, "https://api.typesafe.ai/v1/systemone");
  assert.equal(full.source, "legacy");

  const selfHosted = resolveProvider({ provider: "systemone", baseUrl: "https://relay.example.com/v1" });
  assert.equal(selfHosted.endpoint, "https://relay.example.com/v1/systemone");
});

test("模型按 provider 分开存：切换预设不会带过去其他服务的模型名", () => {
  const cfg = { provider: "systemone", model: "startlux-decision-v1.1-27b-autothink" };
  const systemOne = resolveProvider(cfg);
  assert.equal(systemOne.model, "", "预设不应读到共享旧 model 字段");

  const withOwn = resolveProvider({ ...cfg, systemoneModel: "jev-1.14" });
  assert.equal(withOwn.model, "jev-1.14");

  const otherProvider = resolveProvider({ provider: "decisionmodels", systemoneModel: "jev-1.14" });
  assert.equal(otherProvider.model, "s1-fast");
});

test("systemone 的默认模型来自预设数据", () => {
  assert.equal(PROVIDER_PRESETS.systemone.defaultModel, "jev-latest");
  const provider = resolveProvider({ provider: "systemone", model: "" });
  // 模型留空 = 自动，必须原样保留空串（发送时省略字段）。
  assert.equal(provider.model, "");
});

// ------------------------------------------------------ 3. custom 可用

test("custom 用自己的 base URL 与模型", () => {
  const provider = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    customModel: "my-decision-model",
  });
  assert.equal(provider.id, "custom");
  assert.equal(provider.valid, true);
  assert.equal(provider.baseUrl, "https://gw.example.com/v1");
  assert.equal(provider.endpoint, "https://gw.example.com/v1/decisions");
  assert.equal(provider.model, "my-decision-model");
  // custom 没有预设的默认模型：留空就该是空。
  assert.equal(provider.defaultModel, "");
});

test("custom 支持指定端点风格 systemone", () => {
  const provider = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    customEndpointStyle: "systemone",
  });
  assert.equal(provider.endpoint, "https://gw.example.com/v1/systemone");
});

test("custom 地址已含端点时原样使用，不再叠加", () => {
  for (const url of [
    "https://gw.example.com/v1/decisions",
    "https://gw.example.com/v1/systemone",
    "https://gw.example.com/v1/decisions/",
  ]) {
    const provider = resolveProvider({ provider: "custom", customBaseUrl: url });
    assert.equal(
      provider.endpoint.replace(/\/+$/, ""),
      url.replace(/\/+$/, ""),
      `${url} 被重复拼接成了 ${provider.endpoint}`,
    );
  }
});

test("custom 的鉴权与请求头按配置构造", () => {
  const provider = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    customApiKey: "sk-custom-123456",
    customHeaders: "X-Tenant: team-a; X-Trace: dsh",
  });
  assert.equal(provider.explicitKey, "sk-custom-123456");
  assert.deepEqual(provider.headers, { "X-Tenant": "team-a", "X-Trace": "dsh" });

  const headers = buildHeaders(provider, "sk-custom-123456");
  assert.equal(headers.authorization, "Bearer sk-custom-123456");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["X-Tenant"], "team-a");
});

test("custom 的密钥可以只来自变量名（走凭据/环境变量）", () => {
  const provider = resolveProvider({ provider: "custom", customBaseUrl: "https://gw.example.com/v1", customApiKeyEnv: "MY_KEY" });
  assert.equal(provider.apiKeyEnv, "MY_KEY");
  // 注入 reader，证明 provider 层的优先级：credentials 先于 env。
  const key = resolveKeyFor(provider, {
    credentialReader: (ref) => (ref === "MY_KEY" ? "from-credentials" : undefined),
    env: { MY_KEY: "from-env" },
  });
  assert.equal(key, "from-credentials");
  const fallback = resolveKeyFor(provider, { credentialReader: () => undefined, env: { MY_KEY: "from-env" } });
  assert.equal(fallback, "from-env");
});

test("显式 key 优先于凭据文件与环境变量", () => {
  const provider = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    customApiKey: "explicit",
    customApiKeyEnv: "MY_KEY",
  });
  assert.equal(resolveKeyFor(provider, { credentialReader: () => "cred", env: { MY_KEY: "env" } }), "explicit");
});

test("各 provider 只读自己的 key，不会串到别人的", () => {
  // 这条是「各自保存各自的 key」最重要的保证：
  // 同时配好三个 key 时，各 provider 必须拿到与自己地址匹配的那一个。
  const credentials = {
    TYPESAFE_API_KEY: "key-typesafe",
    DECISIONMODELS_API_KEY: "key-dm",
    DECISION_ENGINE_CUSTOM_KEY: "key-custom",
  };
  const reader = (ref) => credentials[ref];

  const cfg = { provider: "systemone" };
  assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), "key-typesafe");

  cfg.provider = "decisionmodels";
  assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), "key-dm");

  cfg.provider = "custom";
  cfg.customBaseUrl = "https://gw.example.com/v1";
  assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), "key-custom");
});

test("systemone 仍能从上一版的 DECISION_ENGINE_KEY 读回 key", () => {
  // 上一版把 systemone 的 key 名改成了 DECISION_ENGINE_KEY；
  // 现在改回按 provider 分开，但那个位置的 key 不能就此读不到。
  const provider = resolveProvider({ provider: "systemone" });
  const key = resolveKeyFor(provider, {
    credentialReader: (ref) => (ref === "DECISION_ENGINE_KEY" ? "legacy-key" : undefined),
    env: {},
  });
  assert.equal(key, "legacy-key");

  // 新名（TYPESAFE_API_KEY）有值时优先，避免用户改了新 key 却仍读旧值
  const both = resolveKeyFor(provider, {
    credentialReader: (ref) =>
      ref === "TYPESAFE_API_KEY" ? "new-key" : ref === "DECISION_ENGINE_KEY" ? "legacy-key" : undefined,
    env: {},
  });
  assert.equal(both, "new-key");
});

test("显式 key 也按 provider 分开，不会串用别人的明文", () => {
  // 明文 key 同理：切到 system one 时不能拿 systemone 的那一份去请求。
  const decisionModels = resolveProvider({ provider: "decisionmodels", decisionModelsApiKey: "key-dm" });
  assert.equal(decisionModels.explicitKey, "key-dm");
  const systemOne = resolveProvider({ provider: "systemone", systemoneApiKey: "key-ts" });
  assert.equal(systemOne.explicitKey, "key-ts");

  // 只有对方那一格有值时，当前 provider 必须视为「没有显式 key」
  const onlySystemOne = resolveProvider({ provider: "systemone", decisionModelsApiKey: "key-dm" });
  assert.equal(onlySystemOne.explicitKey, "");
});

test("历史共享字段 apiKey 只对默认 provider 生效", () => {
  const defaultProvider = resolveProvider({ provider: "systemone", apiKey: "legacy-shared" });
  assert.equal(defaultProvider.explicitKey, "legacy-shared");
  const otherProvider = resolveProvider({ provider: "decisionmodels", apiKey: "legacy-shared" });
  assert.equal(otherProvider.explicitKey, "");
});

test("切换 provider 不影响其它 provider 已保存的值", () => {
  // 同一份配置里同时存在 custom 值；解析 systemone 时必须完全忽略它们。
  const cfg = {
    provider: "systemone",
    customBaseUrl: "https://gw.example.com/v1",
    customModel: "custom-model",
    customApiKey: "sk-custom",
    customHeaders: "X-Tenant: team-a",
    model: "jev-latest",
  };
  const systemOne = resolveProvider(cfg);
  assert.equal(systemOne.endpoint, "https://api.typesafe.ai/v1/systemone");
  assert.equal(systemOne.explicitKey, "");
  assert.deepEqual(systemOne.headers, {});

  // 再把 provider 切回 custom：用户填过的值必须原样还在。
  const custom = resolveProvider({ ...cfg, provider: "custom" });
  assert.equal(custom.endpoint, "https://gw.example.com/v1/decisions");
  assert.equal(custom.model, "custom-model");
  assert.equal(custom.explicitKey, "sk-custom");
  assert.deepEqual(custom.headers, { "X-Tenant": "team-a" });
});

// --------------------------------------------------------- 4. 非法 URL

test("非法 base URL 全部被拒绝", () => {
  const bad = [
    ["", "空"],
    ["   ", "只有空白"],
    ["not-a-url", "没有 scheme"],
    ["api.example.com/v1", "缺 scheme（自定义必须显式写）"],
    ["ftp://example.com/v1", "非 http(s) 协议"],
    ["javascript:alert(1)", "伪协议"],
    ["https://", "缺主机名"],
    ["https://exa mple.com", "含空格"],
    ["https://example.com/v1?x=1", "带查询串"],
  ];
  for (const [input, why] of bad) {
    const result = validateBaseUrl(input);
    assert.equal(result.ok, false, `${why} 应当被拒绝：${input}`);
    assert.ok(typeof result.error === "string" && result.error.length > 0, `${why} 缺错误说明`);
  }
});

test("合法 base URL 通过校验并被规范化", () => {
  for (const input of [
    "https://api.example.com/v1",
    "http://127.0.0.1:8080/v1",
    "https://api.example.com/v1/",
    "https://api.example.com/v1///",
  ]) {
    const result = validateBaseUrl(input);
    assert.equal(result.ok, true, `${input} 应当通过`);
    assert.ok(!result.value.endsWith("/"), `${input} 未去掉结尾斜杠：${result.value}`);
  }
});

test("custom 缺 base URL 时 resolveProvider 明确标记不可用", () => {
  const provider = resolveProvider({ provider: "custom" });
  assert.equal(provider.valid, false);
  assert.ok(provider.error.includes("base URL"), `错误信息不明确：${provider.error}`);
  assert.equal(provider.endpoint, "", "不可用时不得给出可请求的地址");
});

test("未知 provider 回落到默认值而不是抛错", () => {
  const provider = resolveProvider({ provider: "no-such-provider" });
  assert.equal(provider.id, DEFAULT_PROVIDER);
  assert.equal(provider.valid, true);
});

// ------------------------------------------------- 5. 末尾斜杠与拼段

test("末尾斜杠被规范化，不产生空路径段", () => {
  assert.equal(normalizeBaseUrl("https://x.dev/v1/"), "https://x.dev/v1");
  assert.equal(normalizeBaseUrl("https://x.dev/v1///"), "https://x.dev/v1");
  assert.equal(normalizeBaseUrl("  https://x.dev/v1/  "), "https://x.dev/v1");
  assert.equal(normalizeBaseUrl(""), "");
});

test("端点拼接不重复、不缺失", () => {
  const cases = [
    ["https://x.dev", "decisions", "https://x.dev/v1/decisions"],
    ["https://x.dev/", "decisions", "https://x.dev/v1/decisions"],
    ["https://x.dev/v1", "decisions", "https://x.dev/v1/decisions"],
    ["https://x.dev/v1/", "decisions", "https://x.dev/v1/decisions"],
    ["https://x.dev/v1/decisions", "decisions", "https://x.dev/v1/decisions"],
    ["https://x.dev/v1/decisions/", "decisions", "https://x.dev/v1/decisions"],
    ["https://x.dev/api/v1", "decisions", "https://x.dev/api/v1/decisions"],
    ["https://x.dev", "systemone", "https://x.dev/v1/systemone"],
    ["https://x.dev/v1", "systemone", "https://x.dev/v1/systemone"],
    ["https://x.dev/v1/systemone", "decisions", "https://x.dev/v1/systemone"],
  ];
  for (const [base, style, expected] of cases) {
    assert.equal(buildEndpoint(base, style), expected, `${base} + ${style}`);
  }
});

test("端点拼接幂等：连做两次结果不变", () => {
  for (const base of ["https://x.dev", "https://x.dev/v1", "https://x.dev/v1/"]) {
    for (const style of ENDPOINT_STYLES) {
      const once = buildEndpoint(base, style);
      assert.equal(buildEndpoint(once, style), once, `${base} / ${style} 不幂等`);
    }
  }
});

test("不会拼出 /v1/v1 或 //decisions", () => {
  for (const base of ["https://x.dev/v1", "https://x.dev/v1/", "https://x.dev//v1"]) {
    const endpoint = buildEndpoint(base, "decisions");
    assert.ok(!endpoint.includes("/v1/v1"), `出现重复版本段：${endpoint}`);
    assert.ok(!/\/\/decisions/.test(endpoint), `出现空路径段：${endpoint}`);
  }
});

// --------------------------------------- 6. 请求构造不再硬编码服务商

test("请求体对所有 provider 形状一致；模型为空时省略字段", () => {
  const provider = resolveProvider({ provider: "custom", customBaseUrl: "https://gw.example.com/v1" });
  const body = buildRequestBody(provider, { state: { a: 1 }, questions: { q: { type: "noul" } }, thinkMode: "never" });
  assert.deepEqual(Object.keys(body).sort(), ["questions", "state", "think_mode"]);
  assert.equal(body.think_mode, "never");

  const withModel = resolveProvider({ provider: "custom", customBaseUrl: "https://gw.example.com/v1", customModel: "m1" });
  const body2 = buildRequestBody(withModel, { state: {}, questions: {} });
  assert.equal(body2.model, "m1");
  // 实测端点对 "model": "" 回 400，因此留空必须整段省略。
  const empty = resolveProvider({ provider: "systemone", model: "" });
  assert.equal("model" in buildRequestBody(empty, { state: {}, questions: {} }), false);
});

test("请求头不随 provider 泄露服务商域名", () => {
  for (const cfg of [
    { provider: "systemone" },
    { provider: "custom", customBaseUrl: "https://gw.example.com/v1" },
  ]) {
    const provider = resolveProvider(cfg);
    const headers = buildHeaders(provider, "k");
    const serialized = JSON.stringify(headers);
    assert.ok(!serialized.includes("typesafe.ai"), `${provider.id} 的请求头残留服务商域名：${serialized}`);
  }
});

test("请求构造代码里不再出现硬编码的服务商域名", () => {
  // 源码级检查：服务商地址只允许出现在 providers.json，代码里不得写死。
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.equal(
    index.includes("api.typesafe.ai"),
    false,
    "lib/index.js 仍在请求路径上硬编码 systemone.dev；地址必须来自 providers.json",
  );
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.equal(
    client.includes("api.typesafe.ai"),
    false,
    "lib/client.js 仍在界面里硬编码 systemone.dev；默认地址应由服务端下发",
  );
  const presets = readFileSync(new URL("../lib/providers.json", import.meta.url), "utf8");
  assert.ok(presets.includes("api.typesafe.ai"), "默认地址必须来自 providers.json");
});

test("数据目录用新名，同时保留旧名做迁移/回退", () => {
  // 三个都必须成立：
  //   - 新名是主目录（配置最终要落在 dsh-decision-engine）
  //   - 它挂在 plugins/ 父目录下（DSH 既有的插件数据目录惯例）
  //   - 旧名仍要出现在回退表里（否则老用户的 key 找不到，守卫静默失效）
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(
    index.includes('DATA_DIR_NAME = "dsh-decision-engine"'),
    "主数据目录应为 dsh-decision-engine",
  );
  // 惯例本身写在 home-paths.js（唯一的路径解析入口），这里盯它确实存在：
  // 数据目录必须挂在 plugins/ 父目录下，与其它 DSH 插件一致。
  const homePaths = readFileSync(new URL("../lib/home-paths.js", import.meta.url), "utf8");
  assert.ok(
    homePaths.includes('DSH_PLUGINS_DIR_NAME = "plugins"'),
    "插件数据目录应挂在 plugins/ 父目录下，与其它 DSH 插件一致",
  );
  assert.ok(
    index.includes("dsh-startlux-decision"),
    "旧目录名必须保留在回退表里，用于迁移与读取老配置",
  );
});

test("自定义请求头不会覆盖鉴权与内容类型", () => {
  const headers = parseCustomHeaders("Authorization: Bearer evil; Content-Type: text/plain; Host: evil; X-Ok: 1");
  assert.deepEqual(headers, { "X-Ok": "1" });
});

test("customHeaders 支持换行分隔并忽略无效行", () => {
  const headers = parseCustomHeaders("X-A: 1\nX-B: 2\n坏了\n: 空名\nX-C:");
  assert.deepEqual(headers, { "X-A": "1", "X-B": "2" });
});
// --------------------------------------------------- 7. 思考模式（thinkMode）

test("思考模式只有三档，默认 never", () => {
  assert.deepEqual(THINK_MODES, ["never", "auto", "always"]);
  assert.equal(DEFAULT_THINK_MODE, "never");
});

test("三个合法思考模式原样透传到 think_mode", () => {
  const questions = { q: { type: "noul", instructions: "x" } };
  for (const mode of THINK_MODES) {
    const provider = resolveProvider({ provider: "systemone", thinkMode: mode });
    assert.equal(provider.thinkMode, mode);
    const body = buildRequestBody(provider, { state: {}, questions, thinkMode: mode });
    assert.equal(body.think_mode, mode);
  }
});

test("非法思考模式归一为 never，不会原样发给服务端", () => {
  // 配置来自自研 YAML 子集解析器，绕过 Schemastery 校验，必须在取值处兜住。
  for (const bad of ["sometimes", "NEVER", "Always", "true", "", "  ", 123, null, undefined]) {
    assert.equal(normalizeThinkMode(bad), "never", `非法值 ${JSON.stringify(bad)} 应回退 never`);
  }
});

test("空串不会被透传为 think_mode（?? 兜不住空串的老 bug）", () => {
  const questions = { q: { type: "noul", instructions: "x" } };
  // parseConfigText 对 `thinkMode:` 会解析成 ""，这是「显式空值」的既定语义。
  const provider = resolveProvider({ provider: "systemone", thinkMode: "" });
  const body = buildRequestBody(provider, { state: {}, questions, thinkMode: "" });
  assert.equal(body.think_mode, "never");
  assert.notEqual(body.think_mode, "");
});

test("thinkMode 缺失时回退 never", () => {
  const provider = resolveProvider({ provider: "systemone" });
  assert.equal(provider.thinkMode, "never");
});

test("custom 分支同样归一思考模式", () => {
  const provider = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://gw.example.com/v1",
    thinkMode: "bogus",
  });
  assert.equal(provider.thinkMode, "never");
});

// --------------------------------------------- 8. 硅基流动（国内站 / 国际站）

test("siliconflow 预设：只认 /systemone，默认模型 Kev-4B，只填 key 即可用", () => {
  const preset = PROVIDER_PRESETS.siliconflow;
  assert.equal(preset.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(preset.endpointStyle, "systemone");
  assert.equal(preset.defaultModel, "Kev-4B");
  assert.equal(preset.apiKeyEnv, "SILICONFLOW_API_KEY");
  // 该端点把 model 列为**必填**（实测省略或空串都回 400
  // `Model field is required.`），所以预设必须带默认模型——否则
  //「只填一个 API key 就能用」这条承诺落空。
  assert.equal(preset.requiresModel, true);
  // 官方只支持这两个决策模型；/v1/models 却会一并返回 98 个模型且不带
  // supported_endpoint_types，按这份清单筛才不会在下拉里放「选了就 400」的项。
  assert.deepEqual(preset.knownModels, ["Kev-4B", "SemIf"]);
});

test("siliconflow 解析出 /v1/systemone，模型留空时回落预设默认", () => {
  const provider = resolveProvider({ provider: "siliconflow" });
  assert.equal(provider.id, "siliconflow");
  assert.equal(provider.valid, true);
  assert.equal(provider.endpoint, "https://api.siliconflow.cn/v1/systemone");
  assert.equal(provider.apiKeyEnv, "SILICONFLOW_API_KEY");
  // 留空 = 用预设默认：绝不能发「省略 model」的请求（那是一次必 400）。
  assert.equal(provider.model, "Kev-4B");
  // 显式指定只是「首选」：404 时仍留一条退路（见 DEC-002）。
  assert.deepEqual(provider.candidates, [
    "https://api.siliconflow.cn/v1/systemone",
    "https://api.siliconflow.cn/v1/decisions",
  ]);
});

test("siliconflow 显式填模型时以填的为准（换 SemIf 不被预设顶掉）", () => {
  const provider = resolveProvider({ provider: "siliconflow", siliconflowModel: "SemIf" });
  assert.equal(provider.model, "SemIf");
  // 填过的值原样发出去，回显也应是它（而不是预设默认）。
  assert.equal(buildRequestBody(provider, { state: {}, questions: {} }).model, "SemIf");
});

test("siliconflow-intl 是另一套账号：地址、key、字段名都不与国内站共用", () => {
  const cn = resolveProvider({ provider: "siliconflow" });
  const intl = resolveProvider({ provider: "siliconflow-intl" });
  assert.equal(intl.endpoint, "https://api.siliconflow.com/v1/systemone");
  assert.equal(intl.apiKeyEnv, "SILICONFLOW_INTL_API_KEY");
  assert.equal(intl.model, "Kev-4B");
  // 两站是两套账号：key 互不通用，字段名共用一格就是「切过去拿错 key → 401」，
  // 而用户根本看不出是拿错了还是 key 失效了。
  assert.notEqual(intl.apiKeyEnv, cn.apiKeyEnv);
  assert.notEqual(intl.preset.keyField, cn.preset.keyField);
  assert.notEqual(intl.preset.modelField, cn.preset.modelField);
});

test("requiresModel 只对声明了的预设生效：其它 provider 留空仍省略字段", () => {
  // systemone / system one 省略 model 时服务端会回填默认模型，保留省略语义
  // 才能在服务商给模型改名时配置不失效（见 config.example.yml）。
  assert.equal(resolveProvider({ provider: "systemone", model: "" }).model, "");
  assert.equal(resolveProvider({ provider: "systemone" }).model, "");
  assert.equal("model" in buildRequestBody(resolveProvider({ provider: "systemone" }), { state: {}, questions: {} }), false);
});

test("perplexity / openrouter 预设：地址、key 名与默认模型各自独立", () => {
  const p = resolveProvider({ provider: "perplexity" });
  assert.equal(p.baseUrl, "https://api.perplexity.ai");
  assert.equal(p.apiKeyEnv, "PERPLEXITY_API_KEY");
  // requiresModel：模型留空回落预设默认，而不是发出省略 model 的请求。
  assert.equal(p.model, "sonar");
  assert.equal(p.preset.keyField, "perplexityApiKey");
  const o = resolveProvider({ provider: "openrouter" });
  assert.equal(o.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(o.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(o.model, "~typesafe/jev-latest");
  assert.equal(o.preset.keyField, "openrouterApiKey");
});

test("所有 provider 各读各的 key，同时配好也互不串用", () => {
  const credentials = {
    TYPESAFE_API_KEY: "key-typesafe",
    DECISIONMODELS_API_KEY: "key-dm",
    SILICONFLOW_API_KEY: "key-sf-cn",
    SILICONFLOW_INTL_API_KEY: "key-sf-intl",
    TOKENPLAN_API_KEY: "key-duanyan",
    PERPLEXITY_API_KEY: "key-perplexity",
    OPENROUTER_API_KEY: "key-openrouter",
    DECISION_ENGINE_CUSTOM_KEY: "key-custom",
  };
  const reader = (ref) => credentials[ref];
  for (const [id, expected] of [
    ["systemone", "key-typesafe"],
    ["decisionmodels", "key-dm"],
    ["siliconflow", "key-sf-cn"],
    ["siliconflow-intl", "key-sf-intl"],
    ["duanyan", "key-duanyan"],
    ["perplexity", "key-perplexity"],
    ["openrouter", "key-openrouter"],
    ["custom", "key-custom"],
  ]) {
    const cfg = { provider: id, customBaseUrl: "https://gw.example.com/v1" };
    assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), expected, id);
  }
});

// --------------------------------------------- 9. 书生·端砚（Intern InkStone）

test("书生·端砚预设：端点 /v1/systemone、默认模型 intern-decision-4b、key 名独立", () => {
  const preset = PROVIDER_PRESETS.duanyan;
  assert.equal(preset.baseUrl, "https://discovery-api.intern-ai.org.cn/v1");
  // 实测（2026-11-23，真实 key）：该站只认 /v1/systemone，/v1/decisions 回 404。
  assert.equal(preset.endpointStyle, "systemone");
  assert.equal(preset.defaultModel, "intern-decision-4b");
  // 变量名用平台自己的叫法（端砚控制台的 key 属于 token plan 套餐）。
  assert.equal(preset.apiKeyEnv, "TOKENPLAN_API_KEY");
  // 该端点把 model 列为必填（实测），因此预设必须带默认模型——否则
  //「只填一个 API key 就能用」这条承诺落空。
  assert.equal(preset.requiresModel, true);
  // /v1/models 会一并返回普通对话模型（与 SiliconFlow 同款问题），
  // 只认这份清单里的决策模型，别让下拉里出现「选了就 400」的项。
  assert.deepEqual(preset.knownModels, ["intern-decision-4b"]);
});

test("书生·端砚解析出的端点与模型", () => {
  const provider = resolveProvider({ provider: "duanyan" });
  assert.equal(provider.id, "duanyan");
  assert.equal(provider.valid, true);
  assert.equal(provider.endpoint, "https://discovery-api.intern-ai.org.cn/v1/systemone");
  // 留空 = 用预设默认：绝不能发「省略 model」的请求（那是一次必 400）。
  assert.equal(provider.model, "intern-decision-4b");
  assert.equal(provider.apiKeyEnv, "TOKENPLAN_API_KEY");
  // 字段名与其它 provider 都不共用：共用一格就是「切过去拿错 key → 401」。
  assert.equal(provider.preset.keyField, "duanyanApiKey");
  assert.equal(provider.preset.modelField, "duanyanModel");
});

test("书生·端砚显式填模型时以填的为准", () => {
  const provider = resolveProvider({ provider: "duanyan", duanyanModel: "intern-decision-8b" });
  assert.equal(provider.model, "intern-decision-8b");
  assert.equal(buildRequestBody(provider, { state: {}, questions: {} }).model, "intern-decision-8b");
});

test("noul 题在书生·端砚预设下自动补 criteria（该端点缺了就回 400）", () => {
  // 实测原文：question "irreversible" field `criteria` must be an object
  // with `true`/`false` keys
  const provider = resolveProvider({ provider: "duanyan" });
  const body = buildRequestBody(provider, {
    state: {},
    questions: { irreversible: { type: "noul", instructions: "Is it irreversible?" } },
  });
  assert.deepEqual(body.questions.irreversible.criteria, {
    true: "The stated condition is true.",
    false: "The stated condition is false.",
  });
  // 只补 criteria，题目本身不能被改写。
  assert.equal(body.questions.irreversible.instructions, "Is it irreversible?");
  assert.equal(body.questions.irreversible.type, "noul");
});

test("已经写了 criteria 的 noul 题原样保留", () => {
  const provider = resolveProvider({ provider: "duanyan" });
  const criteria = { true: "yes", false: "no" };
  const body = buildRequestBody(provider, {
    state: {},
    questions: { irreversible: { type: "noul", instructions: "x", criteria } },
  });
  assert.deepEqual(body.questions.irreversible.criteria, criteria);
});

test("noul 题在所有 provider 下都带 criteria（线协议的标准形状）", () => {
  // 这不是某一家服务商的偏好：System One 线协议里 noul 题就该带
  // `criteria: { true, false }`（兄弟插件 dsh-jev-decision-model 一直这么发）。
  // 端砚缺了就回 400，所以请求体形状必须与 provider 无关——custom 与
  // 服务端下发的 provider 走同一条补齐路径。
  const questions = { irreversible: { type: "noul", instructions: "x" } };
  for (const id of ["duanyan", "siliconflow", "systemone", "systemone"]) {
    const body = buildRequestBody(resolveProvider({ provider: id }), { state: {}, questions });
    assert.deepEqual(
      body.questions.irreversible.criteria,
      { true: "The stated condition is true.", false: "The stated condition is false." },
      `${id} 的 noul 题应带 criteria`,
    );
  }
  // 输入不被就地改写。
  assert.equal(questions.irreversible.criteria, undefined);
});

test("custom 与服务端下发的 provider 也带 criteria（换接法不会又撞上 400）", () => {
  // 这两条路径的 provider 没有预设表条目（preset 为 undefined），但请求体形状
  // 必须一样：指向端砚时，custom 与「使用免费模型」同样要求 noul 带 criteria。
  const custom = resolveProvider({
    provider: "custom",
    customBaseUrl: "https://discovery-api.intern-ai.org.cn/v1",
  });
  const body = buildRequestBody(custom, {
    state: {},
    questions: { irreversible: { type: "noul", instructions: "x" } },
  });
  assert.deepEqual(Object.keys(body.questions.irreversible.criteria ?? {}).sort(), ["false", "true"]);

  const server = resolveProvider(
    {},
    { server: { baseUrl: "https://discovery-api.intern-ai.org.cn/v1", endpointStyle: "systemone" } },
  );
  const serverBody = buildRequestBody(server, {
    state: {},
    questions: { irreversible: { type: "noul", instructions: "x" } },
  });
  assert.deepEqual(Object.keys(serverBody.questions.irreversible.criteria ?? {}).sort(), ["false", "true"]);
});

test("非 noul 题型不受 criteria 兼容影响", () => {
  const provider = resolveProvider({ provider: "duanyan" });
  const body = buildRequestBody(provider, {
    state: {},
    questions: {
      pick: { type: "choice", options: ["a", "b"] },
      rate: { type: "score", legend: { low: "x", high: "y" } },
    },
  });
  assert.equal(body.questions.pick.criteria, undefined);
  assert.equal(body.questions.rate.criteria, undefined);
});

// ------------------------------------------------- Decision Models (decisionmodels.io)

test("decisionmodels：预设归一正确（地址 / 端点风格 / 字段名 / 模型清单）", () => {
  const preset = PROVIDER_PRESETS.decisionmodels;
  assert.ok(preset !== undefined, "providers.json 缺少 decisionmodels 条目");
  assert.equal(preset.baseUrl, "https://api.decisionmodels.io/v1");
  assert.equal(preset.endpointStyle, "systemone");
  assert.equal(preset.apiKeyEnv, "DECISIONMODELS_API_KEY");
  assert.equal(preset.keyField, "decisionModelsApiKey");
  assert.equal(preset.modelField, "decisionModelsModel");
  assert.equal(preset.keyEnvField, "decisionModelsApiKeyEnv");
  assert.deepEqual(preset.models, ["s1-fast", "s1-pro", "s1-vision", "reax-1"]);
  assert.equal(preset.defaultModel, "s1-fast");
  assert.equal(preset.requiresModel, true);
});

test("decisionmodels：端点拼成 /v1/systemone，model 留空回落 s1-fast（端点要求 model）", () => {
  const provider = resolveProvider({ provider: "decisionmodels" });
  assert.equal(provider.valid, true);
  assert.equal(provider.endpoint, "https://api.decisionmodels.io/v1/systemone");
  assert.equal(provider.apiKeyEnv, "DECISIONMODELS_API_KEY");
  // requiresModel：留空不能省略 model 字段（端点靠 model 选模型），必须回落默认模型。
  assert.equal(provider.model, "s1-fast");
  assert.equal(buildRequestBody(provider, { state: {}, questions: {} }).model, "s1-fast");
  // 配置里显式写的模型覆盖默认值。
  assert.equal(resolveProvider({ provider: "decisionmodels", decisionModelsModel: "s1-pro" }).model, "s1-pro");
});

test("decisionmodels：显式 key 从自己的字段读，鉴权头是 Bearer", () => {
  const provider = resolveProvider({ provider: "decisionmodels", decisionModelsApiKey: "dm-test-key" });
  assert.equal(provider.explicitKey, "dm-test-key");
  const headers = buildHeaders(provider, "dm-test-key");
  assert.equal(headers.authorization, "Bearer dm-test-key");
  // 服务商域名不得残留在请求头里。
  assert.ok(!JSON.stringify(headers).includes("decisionmodels.io"));
});

test("Google AI Studio Decisions API 预设使用 REST 端点、key 与模型", () => {
  const provider = resolveProvider({
    provider: "google-decisions",
    googleDecisionsApiKey: "gemini-test-key",
  });
  assert.equal(provider.valid, true);
  assert.equal(provider.endpoint, "https://generativelanguage.googleapis.com/v1beta/decisions");
  assert.equal(provider.apiKeyEnv, "GEMINI_API_KEY");
  assert.equal(provider.model, "gemini-decision-1");
  assert.equal(provider.explicitKey, "gemini-test-key");
  assert.equal(provider.protocol, "google-decisions");

  const headers = buildHeaders(provider, "gemini-test-key");
  assert.equal(headers["x-goog-api-key"], "gemini-test-key");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.authorization, undefined);
});

test("Google Decisions 请求体转换为官方 REST input/questions 格式", () => {
  const provider = resolveProvider({ provider: "google-decisions" });
  const body = buildRequestBody(provider, {
    state: { cwd: "/tmp/demo", command: "rm -rf /tmp/demo/cache" },
    questions: {
      irreversible: {
        type: "noul",
        instructions: "Is this action irreversible?",
        criteria: { true: "It cannot be undone.", false: "It can be reversed." },
      },
      route: {
        type: "choice",
        instructions: "Which route should handle this?",
        criteria: { fast: "Cheap and sufficient.", strong: "Needs deep reasoning." },
      },
      depth: {
        type: "score",
        instructions: "How much deliberation is required?",
        criteria: ["none", "some", "deep"],
      },
    },
  });

  assert.equal(body.model, "gemini-decision-1");
  assert.equal(body.think_mode, undefined);
  assert.equal(body.state, undefined);
  assert.equal(body.input, JSON.stringify({ cwd: "/tmp/demo", command: "rm -rf /tmp/demo/cache" }));
  assert.deepEqual(body.questions.irreversible, {
    type: "noul",
    instructions: "Is this action irreversible?",
    criteria: {
      true_description: "It cannot be undone.",
      false_description: "It can be reversed.",
    },
  });
  assert.deepEqual(body.questions.route.criteria, {
    fast: "Cheap and sufficient.",
    strong: "Needs deep reasoning.",
  });
  assert.deepEqual(body.questions.depth.criteria, ["none", "some", "deep"]);
});

test("Decision Models 与 Google Decisions 在下拉清单里，custom 收尾", () => {
  const ids = [...PROVIDER_IDS];
  const index = ids.indexOf("decisionmodels");
  assert.ok(index >= 0, "provider 清单缺少 decisionmodels");
  assert.equal(ids[index + 1], "google-decisions");
  assert.equal(ids.at(-1), "custom", "custom 必须收尾");
  const item = providerCatalog().find((entry) => entry.id === "decisionmodels");
  assert.equal(item.label, "Decision Models");
  assert.equal(item.labelEn, "Decision Models");
  assert.deepEqual(item.models, ["s1-fast", "s1-pro", "s1-vision", "reax-1"]);
  assert.equal(item.requiresModel, true);
  const google = providerCatalog().find((entry) => entry.id === "google-decisions");
  assert.equal(google.label, "Google AI Studio Decisions");
  assert.deepEqual(google.models, ["gemini-decision-1"]);
  assert.equal(google.protocol, "google-decisions");
});
