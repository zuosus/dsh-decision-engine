/**
 * 线协议层：同一个决策端点约定，按服务商翻译成各自的请求体与答案形状。
 *
 * 为什么单独一个文件：
 *
 *   1. **职责不同。** `providers.js` 回答「往哪发、用谁的 key、默认哪个模型」，
 *      本文件回答「发出去长什么样、回来怎么读」。两者一起改动的理由不重叠，
 *      而 `providers.js` 已经超过单文件预算（见 DEC-074 的拆分理由）。
 *   2. **协议差异是成对出现的。** 请求体换了形状，答案也一定换了形状；
 *      把两边放在同一处，才不容易出现「请求按 OpenAI 发、答案按 System One 读」
 *      这种只坏一半的接法——它的症状是**静默降级**，最难自查。
 *
 * 三种协议：
 *
 *   systemone       通用线协议：`{ model?, state, questions, think_mode }`
 *                   → `{ answers: { <id>: {type, ...} } }`（TypeSafe / Jev /
 *                   SiliconFlow / 端砚 / 自建 llama.cpp、vLLM 都是这一条）
 *   google-decisions Google AI Studio：`{ model?, input, questions }`，用
 *                   `x-goog-api-key` 鉴权
 *   openai-decisions OpenAI Decisions API：`POST /v1/decisions`，
 *                   `{ model, input, questions: [ {type, name, ...} ] }`，
 *                   Bearer 鉴权；答案是一个**数组**，靠 `name` 认领。
 *
 * 本模块零 I/O、零依赖，可在裸 Node 下直接单测（见 test/protocols.test.js）。
 *
 * @module dsh-decision-engine/wire-protocol
 */

// OpenAI 那一支单独成文件（题型映射 + 答案归一，约 180 行）：它和另外两种协议
// 的差异是「整套形状都不同」，而不是几行分支，留在本文件会让三个协议挤在一起。
import { openaiAnswers, openaiInput, openaiQuestions } from "./protocols/openai-decisions.js";

/** 合法的思考模式（System One 线协议的 `think_mode` 取值）。 */
export const THINK_MODES = ["never", "auto", "always"];

/** 思考模式的默认值：热路径上优先保证不拖慢每次工具调用。 */
export const DEFAULT_THINK_MODE = "never";

/** 已知协议。缺省（含旧数据里没有该字段）一律按 systemone 处理。 */
export const PROTOCOLS = ["systemone", "google-decisions", "openai-decisions"];

/**
 * 把配置里的 thinkMode 归一成合法取值。
 *
 * 为什么需要它：本插件的配置来自**自研的极简 YAML 解析器**，完全绕过
 * Schemastery 的 `z.union([...])` 校验。于是 `thinkMode: sometimes` 这种
 * 手写错误会被原样发到服务端，得到 400 后静默降级放行——正是本插件最忌讳的
 * 「配了没反应」。
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
 * 协议名归一：不认识的取值回落 systemone。
 *
 * 为什么不在数据层就报错：`protocol` 是后加的字段，老配置、老下发值里都没有；
 * 未知协议若直接抛错，一次「字段写错」就会把整个插件变成不可用。
 * 回落 systemone 与升级前的行为逐字一致，不会让老安装悄悄换协议。
 *
 * @param raw - provider.protocol 的取值。
 * @returns 合法协议名。
 */
export function normalizeProtocol(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  return PROTOCOLS.includes(value) ? value : "systemone";
}

/** 该协议是否使用 OpenAI 的请求/答案形状。 */
function isOpenAI(provider) {
  return normalizeProtocol(provider?.protocol) === "openai-decisions";
}

/** 该协议是否使用 Google AI Studio 的请求形状。 */
function isGoogle(provider) {
  return normalizeProtocol(provider?.protocol) === "google-decisions";
}

/**
 * 当前 provider 是否接受 `think_mode`。
 *
 * 首选 resolveProvider 合并后的 `provider.supportsThinkMode`（模型级覆盖已生效）；
 * 老调用方若直接传了未合并的 preset 形状，回落到 `preset.supportsThinkMode`。
 * 两者都缺时按 true（缺省 = 发送，与原行为一致）。
 */
function thinkModeCapableOf(provider) {
  if (typeof provider?.supportsThinkMode === "boolean") return provider.supportsThinkMode;
  return provider?.preset?.supportsThinkMode !== false;
}

/**
 * 构造请求头。
 *
 * `authorization` / `content-type` 最后写入，因此自定义头无法覆盖它们——
 * 鉴权方式必须与协议匹配，否则换 provider 就可能悄悄换掉认证方式。
 *
 * @param provider - `resolveProvider()` 的结果。
 * @param key - 已解析的 API key。
 * @returns fetch headers。
 */
export function buildHeaders(provider, key) {
  if (isGoogle(provider)) {
    return {
      ...provider.headers,
      "x-goog-api-key": key,
      "content-type": "application/json",
    };
  }
  return {
    ...provider.headers,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

/**
 * 构造请求体。
 *
 * `model` 为空时**省略字段**而不是发空串：实测端点对 `"model": ""` 回
 * 400 `model must be a nonempty string`，而省略字段会回填服务端默认模型。
 *
 * @param provider - `resolveProvider()` 的结果。
 * @param payload.state - 决策上下文。
 * @param payload.questions - 问题集（`{ id: { type, instructions, criteria? } }`）。
 * @param payload.thinkMode - 覆盖 provider 上的 thinkMode（探测用）。
 * @returns 可直接 JSON.stringify 的对象。
 */
export function buildRequestBody(provider, payload) {
  const model = (provider.model ?? "").trim();
  const withModel = model.length > 0 ? { model } : {};
  if (isOpenAI(provider)) {
    return {
      ...withModel,
      input: openaiInput(payload.state),
      questions: openaiQuestions(payload.questions),
    };
  }
  if (isGoogle(provider)) {
    const input =
      typeof payload.state === "string" ? payload.state : JSON.stringify(payload.state ?? {});
    return {
      ...withModel,
      input,
      questions: googleQuestions(payload.questions),
    };
  }
  return {
    ...withModel,
    state: payload.state,
    questions: normalizeNoulCriteria(payload.questions),
    // 部分 System One 端点拒绝该字段（实测 decisionmodels.io 回 400
    // `{"loc":["think_mode"],"msg":"Extra inputs are not permitted"}`）。
    // 是否发送读的是 **resolveProvider 按生效模型合并后的** supportsThinkMode，
    // 不是 preset 上的 provider 级值——某款模型可以重开这个字段（见
    // effectiveCapabilities）。缺省（字段缺失）= 发送，与老行为一致。
    ...(thinkModeCapableOf(provider)
      ? { think_mode: normalizeThinkMode(payload.thinkMode ?? provider.thinkMode) }
      : {}),
  };
}

/**
 * 把响应体读成内部统一的答案对象（`{ <id>: {type, ...} }`）。
 *
 * 归一放在这里而不是各决策点的 `parse()` 里：协议是**传输层**的事，
 * 决策点只该面对一种答案形状。否则每加一种协议，九个决策点的 parse 都要
 * 各写一遍分支——漏一个就是那个点静默失效。
 *
 * @param provider - `resolveProvider()` 的结果。
 * @param body - 已解析的响应 JSON。
 * @returns 答案对象；响应里没有可用答案时返回 undefined（调用方降级）。
 */
export function readAnswers(provider, body) {
  const answers = body?.answers;
  if (isOpenAI(provider)) return openaiAnswers(answers);
  if (answers === null || typeof answers !== "object") return undefined;
  return answers;
}

// --------------------------------------------------------------- Google

/**
 * 把通用决策题型转换成 Google Decisions REST 的字段形状。
 *
 * Google 的 noul 等价物要求 `criteria: { true_description, false_description }`，
 * 而内部协议里 noul 常常没有 criteria——缺了它会被回 400。
 *
 * @param questions - 决策点构造的问题集。
 * @returns 转换后的问题集。
 */
function googleQuestions(questions) {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) {
    return questions;
  }
  const out = {};
  for (const [id, question] of Object.entries(questions)) {
    const isPlain = question !== null && typeof question === "object" && !Array.isArray(question);
    if (!isPlain || question.type !== "noul") {
      out[id] = question;
      continue;
    }
    const criteria = question.criteria;
    const hasTrueFalse =
      criteria !== null && typeof criteria === "object" && !Array.isArray(criteria);
    out[id] = {
      ...question,
      ...(hasTrueFalse
        ? {
            criteria: {
              true_description:
                typeof criteria.true === "string" ? criteria.true : "The stated condition is true.",
              false_description:
                typeof criteria.false === "string" ? criteria.false : "The stated condition is false.",
            },
          }
        : {}),
    };
  }
  return out;
}

// ------------------------------------------------------------- System One

/**
 * 给「没写 criteria 的 noul 问题」补上显式的 true/false 描述。
 *
 * 为什么需要（2026-11-23 实测）：书生·端砚 Intern InkStone 的 System One 端点
 * 要求每个 noul 问题都带 `criteria: { true, false }`，缺了就回 HTTP 400：
 *
 *   question "irreversible" field `criteria` must be an object with `true`/`false` keys
 *
 * 本插件的决策点构造 noul 时都不写 criteria，于是「模型名填对了却每次 400」
 * ——不是模型不支持，是线协议差一层。
 *
 * 为什么放在**传输层**而不是 `lib/points/spec.js`（那里是各决策点的题型定义）：
 * criteria 的补齐是**线协议对所有 noul 题一视同仁的要求**，与「这道题问什么」
 * 无关。放在传输层，将来新增决策点时不必记得再补一次。
 *
 * @param questions - 决策点构造的问题集。
 * @returns 补齐 criteria 后的新对象；输入不是普通对象时原样返回。
 */
function normalizeNoulCriteria(questions) {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) {
    return questions;
  }
  const out = {};
  for (const [id, question] of Object.entries(questions)) {
    const isPlain = question !== null && typeof question === "object" && !Array.isArray(question);
    if (isPlain && question.type === "noul" && (question.criteria === undefined || question.criteria === null)) {
      out[id] = {
        ...question,
        criteria: {
          true: "The stated condition is true.",
          false: "The stated condition is false.",
        },
      };
      continue;
    }
    out[id] = question;
  }
  return out;
}
