/**
 * 题目分批：一次请求能带几道题，由**服务商的模型**决定，不由本插件决定。
 *
 * ## 它解决什么
 *
 * 2026-11-25 实测 decisionmodels.io：`s1-fast` 的 `GET /v1/models` 写着
 * `max_questions: 1`，而本插件的决策点动辄一次问 2–4 道（授权点四道、
 * turnStop 四道）。于是**每一次**决策都被回 400
 * `{"error":{"code":"too_many_questions"}}`，然后静默降级——面板显示
 * 「已连接、模型正确」，守卫却一次都没生效过。这正是本插件最忌讳的那类
 * 故障：配了没反应，而且日志里只有一个笼统的 degraded。
 *
 * 同一家的 `s1-pro` / `reax-1` 上限是 3，`s1-llm-auto-router` 是 7：
 * 上限是**模型**属性，所以它必须跟着「预设的默认模型」一起声明，并在
 * 运行时按模型再兜一层（见 `QuestionLimitMemory`）。
 *
 * ## 两条策略
 *
 *   1. **声明**：`providers.json` 的 `maxQuestions`（0 / 缺省 = 不限制）。
 *      预设在默认模型上取保守值——拆多了只是多几次请求，拆少了就是静默失效。
 *   2. **学习**：没声明上限的服务如果回 `too_many_questions`，把它学成 1 并
 *      重发一次。声明是「已知服务商」，学习是「其余的」；两者都不做，用户
 *      就得自己去猜该填什么。
 *
 * 本模块**零依赖**（不 import 任何东西、不发请求、不读时钟），可在裸 Node
 * 下直接单测（见 test/question-batching.test.js）。
 *
 * @module dsh-decision-engine/question-batching
 */

/** 学到的上限最多记多少条（endpoint × model 的组合屈指可数）。 */
const LEARNED_LIMIT = 32;

/**
 * 归一化一个「上限」取值。
 *
 * @param raw - 配置 / 预设里的原始值（可能是任意类型）。
 * @returns 正整数上限；0 表示不限制（含所有非法值）。
 */
export function normalizeMaxQuestions(raw) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : 0;
}

/**
 * 按上限把题目集切成若干份。
 *
 * 顺序保持不变：决策点的 `parse()` 不依赖顺序，但「第一份先发」让日志与
 * 遥测里的题目顺序可读，也让「前一道失败就停」这类策略以后有落点。
 *
 * @param questions - `{ id: question }`。
 * @param limit - 每份最多几道（≤0 表示不切，原样返回一份）。
 * @returns 若干份 `{ id: question }`；输入不是对象时返回空数组。
 */
export function chunkQuestions(questions, limit) {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) return [];
  const entries = Object.entries(questions);
  if (entries.length === 0) return [];
  const size = normalizeMaxQuestions(limit);
  if (size === 0 || entries.length <= size) return [Object.fromEntries(entries)];
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(Object.fromEntries(entries.slice(index, index + size)));
  }
  return chunks;
}

/**
 * 把若干份答案合并成一份。
 *
 * 后到的不覆盖先到的：同一个 id 出现两次说明分批逻辑本身出了错，保留第一份
 * 比让后来的值悄悄改写裁决更可查（两边都来自同一个模型，差异只可能是拆分 bug）。
 *
 * @param parts - 各次请求的答案对象。
 * @returns 合并后的答案对象。
 */
export function mergeAnswers(parts) {
  const merged = {};
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    for (const [id, answer] of Object.entries(part)) {
      if (!(id in merged)) merged[id] = answer;
    }
  }
  return merged;
}

/**
 * 响应体是否在说「一次只能问一道题」。
 *
 * 各家措辞不同（decisionmodels 用 `too_many_questions` + `max_questions`，
 * 也有服务直接写一句英文），因此三个信号都认。**只在 400 上判**，由调用方
 * 保证——否则一次 500 的错误体里出现这几个词也会被误判成「该拆分」。
 *
 * @param text - 响应体原文（已截断也可）。
 * @returns 是否需要按「每题一次」重发。
 */
export function isTooManyQuestions(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return /too_many_questions|max_questions|exactly one question|one question per request/i.test(text);
}

/**
 * 记住「这个端点 × 模型实际能带几道题」。
 *
 * 为什么需要记：学习发生在**失败之后**。若不记住，每一次决策都要先被 400
 * 拒一次再拆开重发——多一次注定失败的往返，而且遥测里会持续出现
 * `http-400`，看起来像服务坏了。记住之后只有第一次付这个代价。
 *
 * 键包含 baseUrl：换了地址就重新学，否则「A 服务商的结论」会被套用到
 * B 服务商上（与 `EndpointMemory` 同一条理由）。
 */
export class QuestionLimitMemory {
  constructor() {
    /** @type {Map<string, number>} */
    this.entries = new Map();
  }

  /**
   * 拼缓存键。
   *
   * @param provider - `resolveProvider()` 的结果。
   * @returns 键；provider 不完整时返回空串（调用方据此跳过缓存）。
   */
  static keyOf(provider) {
    if (provider === null || typeof provider !== "object") return "";
    const id = typeof provider.id === "string" ? provider.id : "";
    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const model = typeof provider.model === "string" ? provider.model : "";
    if (id.length === 0) return "";
    return `${id}\u0000${baseUrl}\u0000${model}`;
  }

  /**
   * 取学到的上限。
   *
   * @param provider - `resolveProvider()` 的结果。
   * @returns 学到的上限；没学过返回 0。
   */
  get(provider) {
    const key = QuestionLimitMemory.keyOf(provider);
    if (key.length === 0) return 0;
    return this.entries.get(key) ?? 0;
  }

  /**
   * 记下上限（只往小改：已学到的更小值时保留更小的那个）。
   *
   * 为什么只往小改：学到的值来自一次真实拒绝，比声明更可信；但若某次学成 1，
   * 之后又「学成 3」，那是把更宽松的猜测盖在已知事实上——拆分不足会再次
   * 静默失效，而拆分过多只是多几次请求。
   *
   * @param provider - `resolveProvider()` 的结果。
   * @param limit - 学到的上限（≤0 忽略）。
   */
  set(provider, limit) {
    const key = QuestionLimitMemory.keyOf(provider);
    const value = normalizeMaxQuestions(limit);
    if (key.length === 0 || value === 0) return;
    const previous = this.entries.get(key);
    if (previous !== undefined && previous <= value) return;
    if (this.entries.size >= LEARNED_LIMIT) this.entries.clear();
    this.entries.set(key, value);
  }

  /** 清空记忆（配置变了、或探测结果不再适用时）。 */
  clear() {
    this.entries.clear();
  }
}

/**
 * 依次发出若干份题目，收集各份的答案。
 *
 * 为什么串行而不并发：这些题目属于**同一次**决策，并发发出去会把单次决策的
 * 请求数放大成 N 倍瞬时并发；而限流（429）恰好是本插件最不该自己制造的东西。
 *
 * 为什么任何一份失败都整体失败：只拿到半份答案就裁决，等于让决策点的
 * `parse()` 对着缺字段的对象做判断（返回 undefined）——看起来像降级，实际是
 * 「一部分题目根本没问」。宁可整体降级，也不拿半份答案冒充完整答案。
 *
 * @param chunks - 已切好的若干份 `{ id: question }`。
 * @param sendOne - `(chunk) => Promise<{ ok: true, answers, ... } | { ok: false, ... }>`。
 * @returns `{ ok: true, parts }` 或 `{ ok: false, failure }`（第一份失败的原样结果）。
 */
export async function runChunks(chunks, sendOne) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (list.length === 0) return { ok: false, failure: { ok: false, reason: "empty-questions" } };
  const parts = [];
  for (const chunk of list) {
    const part = await sendOne(chunk);
    // 半份答案不裁决：把这次失败原样上抛，由调用方降级或兜底。
    if (part?.ok !== true) return { ok: false, failure: part };
    parts.push(part);
  }
  return { ok: true, parts };
}
