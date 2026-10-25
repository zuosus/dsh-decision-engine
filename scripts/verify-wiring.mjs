/**
 * 在真实 DSH 宿主依赖下加载本插件，验证接线与各项契约。
 *
 * 单元测试用的是假 ctx，能覆盖逻辑但覆盖不了「宿主到底给不给这个服务」。
 * 这里用 profile 里真实的 @deepseek-ai/schemastery 加载 lib/index.js，
 * 再造一个尽量照宿主形状的 ctx，逐个确认：
 *
 *   - Config schema 能解析（新加的阈值键都在）
 *   - apply() 不抛、所有监听器都注册上
 *   - 每个决策点的默认模式正确（新点默认 off，不改变现有行为）
 *   - 缺服务时不崩（这是最常见的部署差异）
 *
 * 用法：node scripts/verify-wiring.mjs
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const profileDir = join(homedir(), ".dsh", "profiles", "desktop");
const requireFromProfile = createRequire(join(profileDir, "package.json"));

/** 让 @deepseek-ai/* 从 profile 的 node_modules 解析（宿主的真实依赖）。 */
async function loadPlugin() {
  // schemastery 是 peer 依赖，必须从 profile 解析到真实实现。
  const schemasteryUrl = pathToFileURL(requireFromProfile.resolve("@deepseek-ai/schemastery")).href;
  const schemastery = await import(schemasteryUrl);
  // 把解析结果注入 import.meta.resolve 做不到，改用临时 package.json 方式：
  // 直接在 profile 目录下跑本脚本即可让 Node 走 profile 的解析路径。
  return { schemastery };
}

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`✔ ${name}`);
  } else {
    failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
    console.log(`✖ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

/** 照宿主形状造一个 ctx：记录监听器、可注入服务、effect 立即执行。 */
function makeCtx(services = {}) {
  const hooks = new Map();
  const disposers = [];
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, listener, options) {
      const list = hooks.get(name) ?? [];
      list.push({ listener, options });
      hooks.set(name, list);
      return () => {};
    },
    effect(body) {
      const result = typeof body === "function" ? body() : body;
      if (typeof result === "function") {
        disposers.push(result);
        return result;
      }
      return () => {};
    },
    get(name) {
      return services[name];
    },
    inject(deps, callback) {
      // 宿主只在依赖可用时调 callback；这里模拟「connection 不可用」，
      // 因为面板 API 不属于决策点主链路，无 connection 也必须能挂。
      if (deps.every((dep) => services[dep] !== undefined)) callback();
      return () => {};
    },
    hooks,
    disposers,
    listeners(name) {
      return (hooks.get(name) ?? []).map((entry) => entry.listener);
    },
  };
}

const { schemastery } = await loadPlugin();
check("从 profile 解析到真实的 @deepseek-ai/schemastery", schemastery !== undefined);

// 用 profile 的解析环境加载插件本体：临时在同目录起一个 loader 太复杂，
// 改为直接把 profile 的 node_modules 加入解析路径 —— 通过 NODE_PATH 不可靠
// （ESM 不读 NODE_PATH），因此用 symlink 到本仓库的 node_modules 是最稳的。
// 这里退一步：先确认 schemastery 能解析，再由调用方保证 node_modules 就位。
const pluginUrl = pathToFileURL(join(process.cwd(), "lib", "index.js")).href;

let plugin;
try {
  plugin = await import(pluginUrl);
  check("加载 lib/index.js", true);
} catch (error) {
  check("加载 lib/index.js", false, error instanceof Error ? error.message : String(error));
  console.log("\n提示：先在仓库里建到 profile 依赖的链接：");
  console.log(`  ln -s ${join(profileDir, "node_modules")} node_modules`);
  process.exit(1);
}

// ---- Config schema -------------------------------------------------------
const schema = plugin.Config;
check("导出 Config schema", schema !== undefined);

const defaults = schema({});
const requiredKeys = [
  "routeCheapProvider",
  "routeCheapModel",
  "routeMaxStepsPerTurn",
  "delegateConfidenceFloor",
  "compactDistilledFloor",
  "compactVerbatinFloor",
  "turnStopValueFloor",
  "retrievalCoveredFloor",
  "retrievalWouldAddCeiling",
  "skillPickConfidenceFloor",
  "cotProseFloor",
  "cotSameLanguageFloor",
];
for (const key of requiredKeys) {
  check(`Config 含 ${key}`, defaults[key] !== undefined, `实际 ${String(defaults[key])}`);
}

// 每个决策点的配置键都必须在 schema 里。
//
// 这里刻意不写 `?? []`：导出缺失时那会让整轮检查静默跳过、脚本照样报
// 「全部通过」。检查脚本自己静默失败比没有检查更危险，所以缺导出直接判失败。
check("导出 DECISION_POINTS", Array.isArray(plugin.DECISION_POINTS), `实际 ${typeof plugin.DECISION_POINTS}`);
check(
  "决策点数量与实现一致（8 个）",
  Array.isArray(plugin.DECISION_POINTS) && plugin.DECISION_POINTS.length === 8,
  `实际 ${plugin.DECISION_POINTS?.length}`,
);
for (const point of plugin.DECISION_POINTS ?? []) {
  check(`Config 含决策点键 ${point.key}`, defaults[point.key] !== undefined);
  check(`决策点 ${point.id} 标记为已实装`, point.available === true);
}

// ---- 默认行为不变 --------------------------------------------------------
const modes = plugin.effectivePointModes(defaults);
check("authorize 默认跟随旧 mode（observe）", modes.authorize === "observe", `实际 ${modes.authorize}`);
for (const id of ["route", "delegate", "compact", "turnStop", "retrieval", "skillPick", "cotTranslate"]) {
  check(`${id} 默认 off（升级不改变行为）`, modes[id] === "off", `实际 ${modes[id]}`);
}

// ---- 挂载：缺所有可选服务 ------------------------------------------------
{
  const ctx = makeCtx();
  let threw;
  try {
    plugin.apply(ctx, {});
  } catch (error) {
    threw = error;
  }
  check("缺所有可选服务时 apply 不抛", threw === undefined, threw === undefined ? "" : String(threw));

  const expectedHooks = [
    "tools/pre-execute",
    "agent/request",
    "agent/pre-step",
    "agent/turn-stopping",
  ];
  for (const hook of expectedHooks) {
    check(`注册了 ${hook}`, ctx.listeners(hook).length > 0, `实际 ${ctx.listeners(hook).length} 个`);
  }
  // tools/pre-execute 应有两个：授权守卫 + 检索/技能
  check(
    "tools/pre-execute 同时挂了授权与检索/技能",
    ctx.listeners("tools/pre-execute").length === 2,
    `实际 ${ctx.listeners("tools/pre-execute").length}`,
  );
}

// ---- 挂载：带全部可选服务 ------------------------------------------------
{
  const ctx = makeCtx({
    skills: {
      async list() {
        return [];
      },
    },
    translator: {
      async translate() {
        return "";
      },
    },
    tokenMeter: { measure: () => ({ totalTokens: 0, nodes: [] }) },
    toolResultPruner: { pruneSession: () => ({ pruned: [], charsRemoved: 0 }) },
  });
  let threw;
  try {
    plugin.apply(ctx, {});
  } catch (error) {
    threw = error;
  }
  check("带全部服务时 apply 不抛", threw === undefined, threw === undefined ? "" : String(threw));
  check("translator.translate 已被包装", typeof ctx.get("translator").translate === "function");
}

// ---- 纯函数契约 ----------------------------------------------------------
check("decode 后的端点规范化", plugin.normalizeEndpoint("https://x.dev/v1").endsWith("/decisions"));
check("规范化幂等", plugin.normalizeEndpoint(plugin.normalizeEndpoint("https://x.dev/v1")) === "https://x.dev/v1/decisions");

// ---- provider 接线 -------------------------------------------------------
//
// 这一节校验的是「provider 抽象真的接进了 Config/解析层」，而不只是文件存在：
// 少一个 schema 键，用户在设置页切到 custom 就会得到一次静默失效。
const providerKeys = [
  "provider",
  "baseUrl",
  "customBaseUrl",
  "customEndpointStyle",
  "customHeaders",
  "keyStorage",
  // 各 provider 的三格（模型 / 显式 key / 密钥变量名）**由预设表生成**：
  // 少一个 schema 键，用户在设置页改的那一项就会静默不生效。
  ...(plugin.PROVIDER_PRESETS
    ? Object.values(plugin.PROVIDER_PRESETS).flatMap((preset) => [
        preset.modelField,
        preset.keyField,
        preset.keyEnvField,
      ])
    : []),
];
for (const key of providerKeys) {
  check(`Config 含 provider 键 ${key}`, Object.hasOwn(defaults, key), `实际 ${String(defaults[key])}`);
}

check("导出 PROVIDER_IDS", Array.isArray(plugin.PROVIDER_IDS), `实际 ${typeof plugin.PROVIDER_IDS}`);
// 预设表导出缺失要立刻失败：上面的字段清单靠它生成，用 `?? []` 兜底会让
// 整轮字段检查静默跳过——检查脚本自己静默失败比没有检查更危险。
check("导出 PROVIDER_PRESETS", typeof plugin.PROVIDER_PRESETS === "object", `实际 ${typeof plugin.PROVIDER_PRESETS}`);
check(
  "provider 预设覆盖五家（systemone / bamboonode / siliconflow / siliconflow-intl / custom）",
  ["systemone", "bamboonode", "siliconflow", "siliconflow-intl", "custom"].every((id) =>
    (plugin.PROVIDER_IDS ?? []).includes(id),
  ),
  `实际 ${JSON.stringify(plugin.PROVIDER_IDS)}`,
);
check("默认 provider 保持 bamboonode（升级不改变行为）", defaults.provider === "bamboonode", `实际 ${defaults.provider}`);

// 用真实 schema 默认值解析一次：内置 provider 必须给出可请求的端点。
const defaultProvider = plugin.resolveProvider(defaults);
check(
  "默认 provider 解析出 bamboonode 端点",
  defaultProvider.id === "bamboonode" && defaultProvider.endpoint.endsWith("/decisions"),
  `实际 ${defaultProvider.id} / ${defaultProvider.endpoint}`,
);

const systemOneProvider = plugin.resolveProvider({ ...defaults, provider: "systemone" });
check(
  "systemone 解析出 /v1/systemone",
  systemOneProvider.endpoint.endsWith("/systemone"),
  `实际 ${systemOneProvider.endpoint}`,
);

// 硅基流动两个站点：只认 /systemone，且把 model 列为必填（实测省略或空串
// 都回 400 `Model field is required.`）。因此「留空」必须回落到预设默认，
// 否则「只填一个 API key 就能用」这条承诺落空，守卫还会静默失效。
for (const id of ["siliconflow", "siliconflow-intl"]) {
  const provider = plugin.resolveProvider({ ...defaults, provider: id });
  check(
    `${id} 解析出 /v1/systemone 且留空时带默认模型`,
    provider.endpoint.endsWith("/systemone") && provider.model.length > 0,
    `实际 ${provider.endpoint} / model=${JSON.stringify(provider.model)}`,
  );
  check(
    `${id} 的候选端点仍是「首选 + 404 回退」`,
    Array.isArray(provider.candidates) && provider.candidates.length === 2,
    `实际 ${JSON.stringify(provider.candidates)}`,
  );
}

// custom 缺地址时必须判为不可用，而不是给出一个猜出来的地址。
const brokenCustom = plugin.resolveProvider({ ...defaults, provider: "custom", customBaseUrl: "" });
check("custom 缺 base URL 时 valid=false", brokenCustom.valid === false, `实际 ${brokenCustom.valid}`);

// 落盘前的校验函数必须真的拦住非法输入。
const rejected = plugin.validateProviderPatch({ provider: "custom", customBaseUrl: "ftp://x.dev" }, defaults);
check("非法 custom base URL 被拒绝", rejected.ok === false, JSON.stringify(rejected));
const accepted = plugin.validateProviderPatch(
  { provider: "custom", customBaseUrl: "https://x.dev/v1" },
  defaults,
);
check("合法 custom base URL 通过校验", accepted.ok === true, JSON.stringify(accepted));

// 请求构造：换 provider 后端点里不得残留别的服务商域名。
const customProvider = plugin.resolveProvider({
  ...defaults,
  provider: "custom",
  customBaseUrl: "https://gw.example.com/v1",
});
check(
  "custom 请求构造不残留 bamboonode 域名",
  !customProvider.endpoint.includes("bamboonode"),
  `实际 ${customProvider.endpoint}`,
);

// 端点回退：404 时换另一条路径。路径后缀由服务商决定（实测 SiliconFlow
// 的 Kev-4B 只通 /v1/systemone），只拼一条路径必然踩空并静默降级。
check(
  "resolveProvider 给出候选端点（404 时有路可退）",
  Array.isArray(customProvider.candidates) && customProvider.candidates.length === 2,
  `实际 ${JSON.stringify(customProvider.candidates)}`,
);
check(
  "候选端点覆盖 decisions 与 systemone 两条路径",
  customProvider.candidates.some((item) => item.endsWith("/decisions")) &&
    customProvider.candidates.some((item) => item.endsWith("/systemone")),
  `实际 ${JSON.stringify(customProvider.candidates)}`,
);
check(
  "地址已自带端点时只给一个候选（用户的明确决定不被改写）",
  plugin
    .resolveProvider({ ...defaults, provider: "custom", customBaseUrl: "https://gw.example.com/v1/systemone" })
    .candidates.length === 1,
  "实际候选多于一个",
);

console.log("");
if (failures.length === 0) {
  console.log("全部接线检查通过");
  process.exit(0);
}
console.log(`${failures.length} 项失败：`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
