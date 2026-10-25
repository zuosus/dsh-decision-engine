/**
 * Provider 配置模型的验收测试。
 *
 * 这一层刻意**不导入 lib/index.js**：那个模块依赖 `@deepseek-ai/schemastery`
 * （宿主 peer 依赖），在裸仓库里加载不了。providers.js 是零依赖的纯模块，
 * 因此地址拼接、校验、鉴权头这些最容易被改坏的东西可以脱离 DSH 单独测。
 *
 * 覆盖的验收项（对应需求里的 6 条）：
 *
 *   1. 内置 `system one` 选项可用
 *   2. 内置 `bamboonode` 选项保持原有行为
 *   3. custom base URL 可用
 *   4. 非法 URL 被拒绝
 *   5. 末尾斜杠与端点拼接不重复、不缺失
 *   6. 请求构造不再硬编码 bamboonode.dev
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
  providerCatalog,
  resolveKeyFor,
  resolveProvider,
  validateBaseUrl,
} from "../lib/providers.js";

// ---------------------------------------------------------------- 1. 内置预设

test("内置预设齐备：systemone / bamboonode / custom", () => {
  assert.deepEqual([...PROVIDER_IDS], ["systemone", "bamboonode", "custom"]);
  for (const id of PROVIDER_IDS) {
    assert.ok(PROVIDER_PRESETS[id] !== undefined, `缺少预设 ${id}`);
  }
  // 自定义 provider 的「默认值」由用户给，因此地址为空是刻意设计。
  assert.equal(PROVIDER_PRESETS.custom.baseUrl, "");
});

test("system one 预设有显示名、默认地址、默认模型与端点风格", () => {
  const preset = PROVIDER_PRESETS.systemone;
  assert.equal(preset.label, "system one");
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
  // 变量名必须换成 system one 自己的：否则会拿 bamboonode 的 key 去打别的服务。
  assert.equal(provider.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.deepEqual(provider.headers, {});
});

test("三个 provider 各有各的 key 名，互不共用", () => {
  // 这是本插件的核心约定：一个 key 名对应一个服务。
  // 共用一格会导致「切 provider 就得重填」，也无法同时保存多套凭据。
  const base = resolveProvider({ provider: "systemone" });
  const bamboo = resolveProvider({ provider: "bamboonode" });
  const custom = resolveProvider({ provider: "custom", customBaseUrl: "https://x.dev/v1" });

  assert.equal(base.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(bamboo.apiKeyEnv, "BAMBOO_API_KEY");
  assert.equal(custom.apiKeyEnv, "DECISION_ENGINE_CUSTOM_KEY");

  // 三者必须互不相同——相同就等于又合并回一个了。
  const names = [base.apiKeyEnv, bamboo.apiKeyEnv, custom.apiKeyEnv];
  assert.equal(new Set(names).size, 3, `key 名出现重复：${names.join(", ")}`);
});

test("用户自定义的密钥变量名会被尊重", () => {
  const custom = resolveProvider({ provider: "bamboonode", apiKeyEnv: "MY_OWN_KEY" });
  assert.equal(custom.apiKeyEnv, "MY_OWN_KEY");

  // 专用覆盖字段优先级最高
  const explicit = resolveProvider({
    provider: "bamboonode",
    bamboonodeApiKeyEnv: "EXPLICIT_KEY",
    apiKeyEnv: "MY_OWN_KEY",
  });
  assert.equal(explicit.apiKeyEnv, "EXPLICIT_KEY");
});

test("system one 不会被历史字段 apiKeyEnv 带走 bamboonode 的 key", () => {
  // 真实运行配置里 apiKeyEnv 默认就是 DECISION_ENGINE_KEY。若它参与 system one 的
  // 解析，切到 system one 会拿 bamboonode 的 key 去请求，得到 401。
  const systemOne = resolveProvider({ provider: "systemone", apiKeyEnv: "DECISION_ENGINE_KEY" });
  assert.equal(systemOne.apiKeyEnv, "TYPESAFE_API_KEY");

  // 但 bamboonode 必须继续尊重 apiKeyEnv（老用户的变量名可能就在这儿）
  const bamboo = resolveProvider({ provider: "bamboonode", apiKeyEnv: "MY_BAMBOO_KEY" });
  assert.equal(bamboo.apiKeyEnv, "MY_BAMBOO_KEY");
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
  // 「keyStorage=config 却显示 BAMBOO_API_KEY」误解的来源。
  const fields = catalog.map((item) => item.keyField);
  assert.deepEqual(fields, ["systemoneApiKey", "bamboonodeApiKey", "customApiKey"]);
  // 三个字段必须互不相同：共用一格会导致切换 provider 时互相覆盖。
  assert.equal(new Set(fields).size, fields.length);
});

// ------------------------------------------------- 2. bamboonode 行为不变

test("默认 provider 仍是 bamboonode（老配置没有 provider 键也不变行为）", () => {
  assert.equal(DEFAULT_PROVIDER, "bamboonode");
  const provider = resolveProvider({});
  assert.equal(provider.id, "bamboonode");
  assert.equal(provider.endpoint, "https://api.bamboonode.dev/v1/decisions");
  assert.equal(provider.apiKeyEnv, "BAMBOO_API_KEY");
  // 上一版短暂用过 DECISION_ENGINE_KEY，仍作回退读取，老安装不必重填
  assert.deepEqual(provider.legacyApiKeyEnvs, ["DECISION_ENGINE_KEY"]);
  assert.equal(provider.source, "preset");
});

test("bamboonode 继续尊重老 baseUrl 覆盖（含完整端点写法）", () => {
  const full = resolveProvider({ provider: "bamboonode", baseUrl: "https://api.bamboonode.dev/v1/decisions" });
  assert.equal(full.endpoint, "https://api.bamboonode.dev/v1/decisions");
  assert.equal(full.source, "legacy");

  const selfHosted = resolveProvider({ provider: "bamboonode", baseUrl: "https://relay.example.com/v1" });
  assert.equal(selfHosted.endpoint, "https://relay.example.com/v1/decisions");
});

test("模型按 provider 分开存：切到 system one 不会带过去 bamboonode 的模型名", () => {
  // 老配置里 model 是 bamboonode 的模型名；切到 system one 后必须不发送它，
  // 否则 TypeSafe 会回 400 `model not served`——「一切换就坏」的典型来源。
  const cfg = { provider: "systemone", model: "startlux-decision-27b-autothink" };
  const systemOne = resolveProvider(cfg);
  assert.equal(systemOne.model, "", "system one 不应读到 bamboonode 的 model 字段");

  const withOwn = resolveProvider({ ...cfg, systemoneModel: "jev-1.14" });
  assert.equal(withOwn.model, "jev-1.14");

  // 反向：systemoneModel 也不能污染 bamboonode
  const bamboo = resolveProvider({ provider: "bamboonode", systemoneModel: "jev-1.14", model: "m-bamboo" });
  assert.equal(bamboo.model, "m-bamboo");
});

test("bamboonode 的模型默认值与历史常量一致", () => {
  // 老版本 DEFAULTS.model 就是这个名字，升级后不能悄悄换掉。
  assert.equal(PROVIDER_PRESETS.bamboonode.defaultModel, "startlux-decision-27b-autothink");
  const provider = resolveProvider({ provider: "bamboonode", model: "" });
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

test("每个 provider 只读自己的 key，不会串到别人的", () => {
  // 这条是「各自保存各自的 key」最重要的保证：
  // 同时配好三个 key 时，各 provider 必须拿到与自己地址匹配的那一个。
  const credentials = {
    TYPESAFE_API_KEY: "key-typesafe",
    BAMBOO_API_KEY: "key-bamboo",
    DECISION_ENGINE_CUSTOM_KEY: "key-custom",
  };
  const reader = (ref) => credentials[ref];

  const cfg = { provider: "systemone" };
  assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), "key-typesafe");

  cfg.provider = "bamboonode";
  assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), "key-bamboo");

  cfg.provider = "custom";
  cfg.customBaseUrl = "https://gw.example.com/v1";
  assert.equal(resolveKeyFor(resolveProvider(cfg), { credentialReader: reader, env: {} }), "key-custom");
});

test("bamboonode 仍能从上一版的 DECISION_ENGINE_KEY 读回 key", () => {
  // 上一版把 bamboonode 的 key 名改成了 DECISION_ENGINE_KEY；
  // 现在改回按 provider 分开，但那个位置的 key 不能就此读不到。
  const provider = resolveProvider({ provider: "bamboonode" });
  const key = resolveKeyFor(provider, {
    credentialReader: (ref) => (ref === "DECISION_ENGINE_KEY" ? "legacy-key" : undefined),
    env: {},
  });
  assert.equal(key, "legacy-key");

  // 新名（BAMBOO_API_KEY）有值时优先，避免用户改了新 key 却仍读旧值
  const both = resolveKeyFor(provider, {
    credentialReader: (ref) =>
      ref === "BAMBOO_API_KEY" ? "new-key" : ref === "DECISION_ENGINE_KEY" ? "legacy-key" : undefined,
    env: {},
  });
  assert.equal(both, "new-key");
});

test("显式 key 也按 provider 分开，不会串用别人的明文", () => {
  // 明文 key 同理：切到 system one 时不能拿 bamboonode 的那一份去请求。
  const bamboo = resolveProvider({ provider: "bamboonode", bamboonodeApiKey: "key-bamboo", systemoneApiKey: "key-ts" });
  assert.equal(bamboo.explicitKey, "key-bamboo");

  const systemOne = resolveProvider({ provider: "systemone", bamboonodeApiKey: "key-bamboo", systemoneApiKey: "key-ts" });
  assert.equal(systemOne.explicitKey, "key-ts");

  // 只有对方那一格有值时，当前 provider 必须视为「没有显式 key」
  const onlyBamboo = resolveProvider({ provider: "systemone", bamboonodeApiKey: "key-bamboo" });
  assert.equal(onlyBamboo.explicitKey, "");
});

test("历史共享字段 apiKey 只对 bamboonode 生效", () => {
  // 老 yml 里只有 apiKey 这一个 key 字段；升级后它应当只被 bamboonode 读到，
  // 否则切换到 system one 会误用 bamboonode 的 key。
  const bamboo = resolveProvider({ provider: "bamboonode", apiKey: "legacy-shared" });
  assert.equal(bamboo.explicitKey, "legacy-shared");

  const systemOne = resolveProvider({ provider: "systemone", apiKey: "legacy-shared" });
  assert.equal(systemOne.explicitKey, "");
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
  const empty = resolveProvider({ provider: "bamboonode", model: "" });
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
    assert.ok(!serialized.includes("bamboonode"), `${provider.id} 的请求头残留服务商域名：${serialized}`);
    assert.ok(!provider.endpoint.includes("bamboonode"), `${provider.id} 的端点残留服务商域名`);
  }
});

test("请求构造代码里不再出现硬编码的 bamboonode.dev", () => {
  // 源码级检查：预设表之外（providers.js 的 bamboonode 条目）不允许再出现该域名。
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.equal(
    index.includes("bamboonode.dev"),
    false,
    "lib/index.js 仍在请求路径上硬编码 bamboonode.dev；地址必须来自 providers.js",
  );
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.equal(
    client.includes("bamboonode.dev"),
    false,
    "lib/client.js 仍在界面里硬编码 bamboonode.dev；默认地址应由服务端下发",
  );
});

test("数据目录用新名，同时保留旧名做迁移/回退", () => {
  // 两个都必须成立：
  //   - 新名是主目录（配置最终要落在 dsh-decision-engine）
  //   - 旧名仍要出现在回退表里（否则老用户的 key 找不到，守卫静默失效）
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(
    index.includes('DATA_DIR_NAME = "dsh-decision-engine"'),
    "主数据目录应为 dsh-decision-engine",
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
    const provider = resolveProvider({ provider: "bamboonode", thinkMode: mode });
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
  const provider = resolveProvider({ provider: "bamboonode", thinkMode: "" });
  const body = buildRequestBody(provider, { state: {}, questions, thinkMode: "" });
  assert.equal(body.think_mode, "never");
  assert.notEqual(body.think_mode, "");
});

test("thinkMode 缺失时回退 never", () => {
  const provider = resolveProvider({ provider: "bamboonode" });
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
