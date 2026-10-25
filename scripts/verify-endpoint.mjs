/**
 * 对着真实决策端点验证每个决策点的「问题集」都能被接受、答案都能被解析。
 *
 * 这不是单元测试（它需要网络与 API key），而是接入验收：端点的题型校验
 * 很严（choice 必须有 criteria、score 必须有 2–10 档、题型只认三种），
 * 任何一处写错都会在运行时 400 并降级——而降级是静默的，光看日志很难
 * 发现「这个点其实一直没生效」。因此必须真打一次。
 *
 * 用法：
 *   node scripts/verify-endpoint.mjs
 *
 * 退出码 0 表示全部决策点通过；非 0 表示有点不可用（会逐条打印原因）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { POINT_SPECS } from "../lib/points/spec.js";
import { resolveKeyFor, resolveProvider, PROVIDER_IDS } from "../lib/providers.js";

/*
 * 刻意不从 lib/index.js 导入 normalizeEndpoint / resolveKey：
 * 那个模块 import 了 @deepseek-ai/schemastery（宿主的 peer 依赖），
 * 在没有 DSH node_modules 的裸仓库里无法加载。
 *
 * 但也不在这里另写一套地址规则——那正是「脚本打 A、插件打 B」的来源。
 * providers.js 是零依赖纯模块，直接复用它，脚本与运行期只有一份真相。
 */

/**
 * 读取真实运行配置（`config.yml`），让验收打的就是用户实际在用的端点。
 *
 * 支持环境变量覆盖，便于在不改用户配置的前提下对别的服务做验收：
 *   DECISION_ENGINE_PROVIDER    systemone | bamboonode | custom
 *   DECISION_ENGINE_BASE_URL    覆盖 base URL（custom 直接生效）
 *   DECISION_ENGINE_API_KEY     显式 key（优先级最高）
 *
 * @returns 已合并的配置对象。
 */
function loadConfig() {
  // 顺序与插件保持一致：新名字在前，旧名字只做回退（升级后旧文件可能还在）。
  const candidates = [
    join(homedir(), ".dsh", "dsh-decision-engine", "config.yml"),
    join(homedir(), ".dsh", "dsh-decision-engine", "startlux.yml"),
    join(homedir(), ".dsh", "dsh-startlux-decision", "startlux.yml"),
    join(homedir(), ".dsh", "plugins", "dsh-startlux-decision", "startlux.yml"),
    join(homedir(), ".dsh", "plugins", "dsh-startlux-guard", "startlux.yml"),
    join(process.cwd(), "config.yml"),
    join(process.cwd(), "startlux.yml"),
  ];
  const config = {};
  let raw;
  for (const path of candidates) {
    try {
      raw = readFileSync(path, "utf8");
      break;
    } catch {
      /* 继续找下一个 */
    }
  }
  if (raw === undefined) return config;
  // 与插件同规则的极简解析：只看 `key: value` 与 `#` 注释。
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    const hashAt = value.indexOf(" #");
    if (hashAt >= 0) value = value.slice(0, hashAt).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    config[key] = value;
  }
  return config;
}

/** 每个决策点一份「现场数据」，用来生成问题集。 */
const INPUTS = {
  route: { turn: 3, step: 2, current: { provider: "deepseek-official", model: "deepseek-pro" }, recent: "user: 把这个函数改成 async\nassistant: 好的，我先看实现" },
  delegate: { turn: 1, step: 1, incoming: "帮我把整个 lib 目录的 CommonJS 改成 ESM，并补测试", recent: "" },
  compact: { totalTokens: 132000, triggerTokens: 100000, oversized: 5, nodes: 88, recent: "user: 继续\nassistant: 已经改完三个文件" },
  turnStop: { turn: 2, last: "我已经改完 a.js 和 b.js，接下来准备改 c.js。", pendingTools: 0, steered: 0 },
  retrieval: { tool: "web_search", query: "DSH agent/pre-step 的 next() 语义", recent: "user: 这个 hook 的返回值是什么" },
  skillPick: {
    requested: "dsh-hooks",
    candidates: [
      { name: "dsh-hooks", description: "How to hook into the DSH agent loop" },
      { name: "office-xlsx", description: "Create and edit Excel workbooks" },
      { name: "xcode-build-loop", description: "Build and debug Xcode projects" },
    ],
    recent: "user: 我想知道 pre-step 能拿到什么",
  },
  cotTranslate: { text: "The agent loop rejects a proposed step before it enters.", targetLanguage: "zh", sourceLanguage: "en", head: "The agent loop rejects" },
};

/** 各决策点期望的处置 kind（只要解析成功就算通过，这里额外核对种类）。 */
const EXPECTED_KINDS = new Set([
  "switch",
  "keep",
  "advise",
  "inline",
  "prune",
  "summarize",
  "continue",
  "stop",
  "skip",
  "allow",
  "redirect",
  "translate",
]);

/** 与 DEFAULTS 对齐的阈值（这里只需要「能算出处置」）。 */
const CFG = {
  routeCheapProvider: "deepseek-official",
  routeCheapModel: "deepseek-flash",
  routeMaxScore: 0.4,
  routeMechanicalFloor: 0.6,
  routeRiskFloor: 0.3,
  delegateConfidenceFloor: 0.6,
  delegateBlockingFloor: 0.6,
  delegateParallelFloor: 0.5,
  compactStaleFloor: 0.6,
  compactLossyCeiling: 0.4,
  turnStopClosedFloor: 0.6,
  turnStopUnfinishedFloor: 0.6,
  turnStopValueFloor: 0.6,
  retrievalKnownFloor: 0.7,
  retrievalNecessaryCeiling: 0.4,
  skillPickConfidenceFloor: 0.5,
  cotProseFloor: 0.5,
  cotSameLanguageFloor: 0.8,
};

/** 从 ~/.dsh/.credentials.yaml 的 refs 段取 key（不引入 YAML 依赖）。 */
function credential(ref, options = {}) {
  let raw;
  try {
    raw = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  } catch (error) {
    // optional：文件不存在只是「这一路没取到 key」，不是脚本故障——
    // 后面的环境变量兜底仍然可能成功。
    if (options.optional === true) return undefined;
    throw error;
  }
  let inRefs = false;
  let refsIndent = -1;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === "refs:") {
      inRefs = true;
      refsIndent = indent;
      continue;
    }
    if (!inRefs) continue;
    if (indent <= refsIndent) {
      inRefs = false;
      continue;
    }
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    if (trimmed.slice(0, sep).trim() !== ref) continue;
    const value = trimmed.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
    if (value.length > 0) return value;
  }
  return undefined;
}

// ---- 解析 provider / 端点 / key：与插件运行期完全同一套逻辑 --------------
const fileConfig = loadConfig();
const envProvider = process.env.DECISION_ENGINE_PROVIDER;
const envBaseUrl = process.env.DECISION_ENGINE_BASE_URL;

const cfg = { ...fileConfig };
if (envProvider !== undefined && PROVIDER_IDS.includes(envProvider)) cfg.provider = envProvider;
if (envBaseUrl !== undefined && envBaseUrl.length > 0) {
  // 覆盖地址时一律按 custom 处理，避免内置预设的默认值把它盖回去。
  cfg.provider = "custom";
  cfg.customBaseUrl = envBaseUrl;
}
if (process.env.DECISION_ENGINE_API_KEY !== undefined) {
  cfg.provider = cfg.provider === "custom" ? "custom" : cfg.provider;
  cfg.customApiKey = process.env.DECISION_ENGINE_API_KEY;
  cfg.apiKey = process.env.DECISION_ENGINE_API_KEY;
}

const provider = resolveProvider(cfg);
if (!provider.valid) {
  console.error(`provider 配置不可用：${provider.error}`);
  process.exit(2);
}

const endpoint = provider.endpoint;
const key =
  (process.env.DECISION_ENGINE_API_KEY ?? "").trim() ||
  resolveKeyFor(provider, {
    credentialReader: (ref) => credential(ref, { optional: true }),
  });

if (key === undefined || key.length === 0) {
  console.error(
    `未找到 API key（provider ${provider.id}，变量名 ${provider.apiKeyEnv || "未设置"}）：无法做端点验收`,
  );
  process.exit(2);
}

console.log(`provider: ${provider.label}（${provider.id}）`);
console.log(`endpoint: ${endpoint}`);
console.log(`model:    ${provider.model || "自动（服务端默认）"}\n`);

/** 打一次端点，返回 { ok, answers, error }。 */
async function decide(state, questions) {
  const controller = AbortSignal.timeout(60000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ state, questions, think_mode: "never" }),
      signal: controller,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    const body = JSON.parse(text);
    return { ok: true, answers: body.answers, usage: body.usage, model: body.model };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let failures = 0;
const rows = [];

for (const [id, input] of Object.entries(INPUTS)) {
  const spec = POINT_SPECS[id];
  const built = spec.build(input);
  const started = Date.now();
  const result = await decide(built.state, built.questions);
  const elapsed = Date.now() - started;

  if (!result.ok) {
    failures += 1;
    rows.push({ id, verdict: "请求失败", detail: result.error, elapsed });
    continue;
  }

  const parsed = spec.parse(result.answers);
  if (parsed === undefined) {
    failures += 1;
    rows.push({
      id,
      verdict: "答案形状不符",
      detail: JSON.stringify(result.answers).slice(0, 300),
      elapsed,
    });
    continue;
  }

  const action = spec.decide(parsed, CFG, input);
  if (!EXPECTED_KINDS.has(action.kind)) {
    failures += 1;
    rows.push({ id, verdict: "处置 kind 非法", detail: `kind=${action.kind}`, elapsed });
    continue;
  }

  const tokens = result.usage?.input_tokens ?? "?";
  rows.push({ id, verdict: `ok → ${action.kind}`, detail: `${tokens} token`, elapsed });
}

const width = Math.max(...rows.map((row) => row.id.length));
for (const row of rows) {
  const mark = row.verdict.startsWith("ok") ? "✔" : "✖";
  console.log(
    `${mark} ${row.id.padEnd(width)}  ${String(row.elapsed).padStart(5)}ms  ${row.verdict.padEnd(22)}  ${row.detail}`,
  );
}

console.log(`\n${rows.length - failures}/${rows.length} 个决策点通过端点验收`);
process.exit(failures === 0 ? 0 : 1);
