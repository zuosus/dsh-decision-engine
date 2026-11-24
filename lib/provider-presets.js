/**
 * provider 数据层：`providers.json` → 运行时清单。
 *
 * 为什么要单独一个文件：
 *
 * 1. **数据与线协议分开。** `providers.js` 负责「请求怎么构造、端点怎么拼」，
 *    本文件只负责「有哪些 provider、各自什么参数」。新增一家服务只改
 *    `providers.json`，两个文件都不用动。
 * 2. **校验集中。** JSON 是人手改的，写坏的方式（重复 id、两家共用一个配置
 *    字段、id 大小写不对）必须在这里一次性拒绝，而不是等到某次决策静默失效
 *    才发现。`parseProviderPresets()` 因此被导出，可以脱离文件单独测。
 *
 * 本模块只读同目录的 `providers.json` 一次（模块加载时），不读用户配置、
 * 不读环境变量、不发请求，因此可以在裸 Node 下直接单测。
 *
 * @module dsh-decision-engine/provider-presets
 */

import { readFileSync } from "node:fs";

/**
 * 自定义 base URL 的端点风格。
 *
 *   auto       已指向 /decisions 或 /systemone 就原样用，否则先试 decisions
 *   decisions  POST <base>/decisions
 *   systemone  POST <base>/systemone
 *
 * 注意：这是**首选**路径，不是唯一路径。路径后缀由服务商决定（实测
 * SiliconFlow 的 Kev-4B 只通 /v1/systemone），
 * 因此 404 时会换另一条再试——见 endpointCandidates()。
 */
export const ENDPOINT_STYLES = ["auto", "decisions", "systemone"];

/**
 * provider 数据文件。
 *
 * 这是**唯一**需要改动的文件：新增一家服务 = 往数组里加一个对象，不改代码。
 * 放在 lib/ 下是为了随 npm 包一起发布（package.json 的 `files` 含 `lib`）。
 */
const PROVIDER_PRESETS_PATH = new URL("./providers.json", import.meta.url);

/** id → camelCase，用于推导缺省的配置字段名（my-gateway → myGateway）。 */
function camelId(id) {
  return String(id).replace(/[^A-Za-z0-9]+(.)?/g, (_, next) => (next ? next.toUpperCase() : ""));
}

/** id → 环境变量名（my-gateway → MY_GATEWAY_API_KEY）。 */
function defaultKeyEnv(id) {
  return `${String(id).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

/** 取字符串数组：丢弃非字符串与空串，不做其他类型推断。 */
function stringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 取可选的字符串字段；空白串视为缺省。 */
function optionalText(raw) {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * 把 providers.json 的数组归一成运行时清单。
 *
 * 只有 `id` 是必填。其余字段都有可推导的默认值，因此新增一个 provider 的
 * 最小写法就是：
 *
 *   { "id": "my-gateway", "baseUrl": "https://gw.example.com/v1", "models": ["m1"] }
 *
 * 字段名（keyField / modelField / keyEnvField）缺省时由 id 推导，避免出现
 * 「JSON 里加了一个 provider，但配置页不知道往哪一格写」的半截状态。
 *
 * 校验失败直接抛错而不是跳过：写坏的条目会表现为「切过去没有地址 / 没有
 * key」，而守卫是 fail-open 的，症状只会是「配了没反应」——必须让坏数据
 * 在加载时就发出声音。
 *
 * @param definitions - JSON 解析后的数组。
 * @param options.source - 出错信息里的来源名。
 * @returns 归一后的 provider 对象数组（顺序即下拉顺序）。
 */
export function parseProviderPresets(definitions, options = {}) {
  const source = options.source ?? "providers.json";
  if (!Array.isArray(definitions)) throw new Error(`${source}: 顶层必须是 provider 数组`);
  if (definitions.length === 0) throw new Error(`${source}: 至少需要一个 provider`);

  const seenIds = new Set();
  const fieldOwners = new Map();
  const defaultIds = [];

  const presets = definitions.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source}[${index}] 必须是对象`);
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`${source}[${index}] 的 id 必须是小写字母/数字/连字符：${JSON.stringify(raw.id)}`);
    }
    if (seenIds.has(id)) throw new Error(`${source}: provider id 重复：${id}`);
    seenIds.add(id);

    const models = stringList(raw.models);
    const preset = {
      id,
      label: optionalText(raw.label) ?? id,
      labelEn: optionalText(raw.labelEn) ?? optionalText(raw.label) ?? id,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
      endpointStyle: ENDPOINT_STYLES.includes(raw.endpointStyle) ? raw.endpointStyle : "auto",
      apiKeyEnv: optionalText(raw.apiKeyEnv) ?? defaultKeyEnv(id),
      legacyApiKeyEnvs: stringList(raw.legacyApiKeyEnvs),
      keyField: optionalText(raw.keyField) ?? `${camelId(id)}ApiKey`,
      modelField: optionalText(raw.modelField) ?? `${camelId(id)}Model`,
      keyEnvField: optionalText(raw.keyEnvField) ?? `${camelId(id)}ApiKeyEnv`,
      // 可用模型清单：空数组 = 不限定，由服务端的 /v1/models 决定。
      models,
      // 兼容旧字段名（外部脚本/旧测试读 knownModels），与 models 同一份数据。
      knownModels: models,
      defaultModel: optionalText(raw.defaultModel) ?? models[0] ?? "",
      requiresModel: raw.requiresModel === true,
      hint: optionalText(raw.hint) ?? "",
      hintEn: optionalText(raw.hintEn) ?? optionalText(raw.hint) ?? "",
      /** 默认 provider：字段缺省时用它（见 DEFAULT_PROVIDER）。 */
      default: raw.default === true,
      /** 用户自己填地址的那个 provider（见 resolveProvider 的 custom 分支）。 */
      customizable: raw.customizable === true,
      /** 历史字段兼容（只给老 provider 用，新条目不需要）。 */
      legacyBaseUrlField: optionalText(raw.legacyBaseUrlField),
      legacyKeyField: optionalText(raw.legacyKeyField),
      legacyKeyEnvOverride: raw.legacyKeyEnvOverride === true,
      legacyKeyEnvField: optionalText(raw.legacyKeyEnvField),
      /** 该 provider 的模型配置默认值取 defaultModel（老版本行为）。 */
      legacyModelDefault: raw.legacyModelDefault === true,
      /** /v1/models 只认带决策类型标记的行（StartLux 系端点）。 */
      typedModelsOnly: raw.typedModelsOnly === true,
      /** 请求/响应协议。缺省时沿用 System One / decisions 通用线协议。 */
      protocol: optionalText(raw.protocol) ?? "systemone",
    };

    if (preset.default) defaultIds.push(id);
    for (const field of [preset.keyField, preset.modelField, preset.keyEnvField]) {
      const owner = fieldOwners.get(field);
      if (owner !== undefined && owner !== id) {
        throw new Error(`${source}: 配置字段 ${field} 被 ${owner} 与 ${id} 共用——切换 provider 会互相覆盖`);
      }
      fieldOwners.set(field, id);
    }
    return preset;
  });

  if (defaultIds.length > 1) {
    throw new Error(`${source}: 只能有一个 "default": true，实际有：${defaultIds.join(", ")}`);
  }
  return presets;
}

/**
 * 读取并解析 providers.json。
 *
 * 用 readFileSync 而不是 `require("./providers.json")`：ESM 的 JSON 导入
 * 语法在 Node 20.3 与 22 之间不兼容（assert/with），而 require 的缓存会
 * 让测试无法验证解析失败的分支。这里只在模块加载时读一次，不在请求路径上。
 */
function loadProviderPresets() {
  let text;
  try {
    text = readFileSync(PROVIDER_PRESETS_PATH, "utf8");
  } catch (error) {
    throw new Error(`无法读取 ${PROVIDER_PRESETS_PATH.pathname}：${error.message}`);
  }
  let definitions;
  try {
    definitions = JSON.parse(text);
  } catch (error) {
    throw new Error(`${PROVIDER_PRESETS_PATH.pathname} 不是合法 JSON：${error.message}`);
  }
  return parseProviderPresets(definitions, { source: "lib/providers.json" });
}

/**
 * 归一后的内置 provider 清单（顺序即设置界面下拉的顺序）。
 *
 * 模块加载时读一次：写坏的数据文件应当**立刻**让插件起不来（而不是让某次
 * 决策静默走错地址），所以这里不 try/catch 兜底成一个空清单。
 */
export const PROVIDER_LIST = loadProviderPresets();
