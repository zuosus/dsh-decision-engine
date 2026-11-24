/**
 * OpenAI Decisions API 线协议：`POST /v1/decisions`。
 *
 * 官方文档：https://developers.openai.com/api/docs/guides/decisions
 *
 * 与本插件内部形状的三处差异，全在这个文件里吸收掉：
 *
 *   1. **问题集是数组，不是对象。** 内部用 `{ id: question }`（便于各决策点按
 *      名字取答案），OpenAI 用 `[{ type, name, ... }]`。这里把键搬进 `name`。
 *   2. **题型名不同。** 内部的 `noul`（"是不是"）对应 `predicate`；`choice`
 *      与 `score` 同名但字段不同（`criteria` → `choices` / `levels`）。
 *   3. **答案是数组。** 回包 `answers` 是 `[{ type, name, ... }]`，靠 `name`
 *      认领；内部要的是按 id 索引的对象。归一在 `readAnswers` 里做。
 *
 * 结构化证据走 `input_json` 内容块而不是 JSON.stringify：官方明确支持
 * `{ "type": "input_json", "data": {...} }`，压成字符串等于把结构交给模型去猜，
 * 而且键名里的 `role` / `image_url` 还会被当成消息解析。
 *
 * @module dsh-decision-engine/protocols/openai-decisions
 */

/**
 * state → OpenAI 的 `input`。
 *
 * @param state - 决策上下文（对象或字符串）。
 * @returns 字符串或消息数组。
 */
export function openaiInput(state) {
  if (typeof state === "string") return state;
  return [
    {
      role: "user",
      content: [{ type: "input_json", data: state ?? {} }],
    },
  ];
}

/**
 * 问题集 → OpenAI 的 `questions` 数组。
 *
 * 题型映射：
 *
 *   noul   → predicate（"条件是否成立"，回 probability）
 *   choice → choice（criteria 变成 choices，回 choice + probabilities）
 *   score  → score（criteria 变成 levels，回浮点档位）
 *
 * @param questions - `{ id: question }`。
 * @returns OpenAI 的 questions 数组。
 */
export function openaiQuestions(questions) {
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) {
    return [];
  }
  const out = [];
  for (const [name, question] of Object.entries(questions)) {
    const isPlain = question !== null && typeof question === "object" && !Array.isArray(question);
    if (!isPlain) continue;
    const instructions = question.instructions;
    const base = { name, ...(typeof instructions === "string" ? { instructions } : {}) };
    if (question.type === "noul") {
      out.push({ type: "predicate", ...base });
      continue;
    }
    if (question.type === "choice") {
      out.push({ type: "choice", ...base, choices: openaiChoices(question.criteria) });
      continue;
    }
    if (question.type === "score") {
      out.push({ type: "score", ...base, levels: openaiLevels(question.criteria) });
      continue;
    }
    // 未知题型原样带过去：端点会回 400，而 400 比「静默丢掉一个问题」可查。
    out.push({ ...question, ...base });
  }
  return out;
}

/**
 * 内部 choice 的 criteria → OpenAI 的 choices。
 *
 * 对象形态（`{ value: description }`）能带上「每个选项何时适用」的说明；
 * 数组形态只有标签，此时 description 直接复用标签——官方要求两个字段都在。
 *
 * @param criteria - 对象或字符串数组。
 * @returns `[{ value, description }]`。
 */
function openaiChoices(criteria) {
  if (Array.isArray(criteria)) {
    return criteria
      .filter((item) => typeof item === "string" && item.length > 0)
      .map((item) => ({ value: item, description: item }));
  }
  if (criteria === null || typeof criteria !== "object") return [];
  return Object.entries(criteria)
    .filter(([, description]) => typeof description === "string")
    .map(([value, description]) => ({ value, description }));
}

/**
 * 内部 score 的 criteria → OpenAI 的 levels（必须 2–10 档，且按低到高排列）。
 *
 * @param criteria - 字符串数组或 `{ label: description }`。
 * @returns `[{ label, description? }]`。
 */
function openaiLevels(criteria) {
  if (Array.isArray(criteria)) {
    return criteria
      .filter((item) => typeof item === "string" && item.length > 0)
      .map((label) => ({ label }));
  }
  if (criteria === null || typeof criteria !== "object") return [];
  return Object.entries(criteria)
    .filter(([, description]) => typeof description === "string")
    .map(([label, description]) => ({ label, description }));
}

/**
 * OpenAI 的 `answers` 数组 → 内部按 id 索引的对象。
 *
 *   predicate → `{type:'noul', noul: probability}`
 *   choice    → `{type:'choice', choice, confidence, probabilities:{value: p}}`
 *   score     → `{type:'score', score, confidence, probabilities:{label: p}}`
 *   refusal   → 原样保留
 *
 * 为什么 choice / score 要把 `probabilities` 数组转成按值索引的对象：内部
 * 协议（以及 tolerance 的严重度计算）读的是 `probabilities.high` 这种取值，
 * 数组形态会让它拿不到连续量、只能退回分类兜底值。
 *
 * refusal 刻意**不**翻译成某种低风险答案：类型不认识就必须让各决策点的
 * `parse()` 返回 undefined（→ 降级放行），而不是把「模型拒绝判断」当成
 * 「条件不成立」——后者会悄悄放宽策略。
 *
 * @param answers - 响应里的 answers 数组。
 * @returns 内部答案对象；不是数组时返回 undefined。
 */
export function openaiAnswers(answers) {
  if (!Array.isArray(answers)) return undefined;
  const out = {};
  for (const answer of answers) {
    if (answer === null || typeof answer !== "object") continue;
    const name = typeof answer.name === "string" ? answer.name : "";
    if (name.length === 0) continue;
    if (answer.type === "predicate") {
      out[name] = { type: "noul", noul: answer.probability };
      continue;
    }
    if (answer.type === "choice") {
      out[name] = {
        type: "choice",
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: probabilityMap(answer.probabilities),
      };
      continue;
    }
    if (answer.type === "score") {
      out[name] = {
        type: "score",
        score: answer.score,
        confidence: answer.confidence,
        probabilities: probabilityMap(answer.probabilities),
      };
      continue;
    }
    out[name] = answer;
  }
  return out;
}

/**
 * `[{ value, label?, probability }]` → `{ <value|label>: probability }`。
 *
 * 只收合法概率（有限数且落在 [0,1]）：畸形值留着会让下游把它当成真实的
 * 连续量参与阈值计算，而「形状不符即降级」才是本插件的既有原则。
 *
 * @param rows - 概率数组。
 * @returns 按值索引的概率对象（无有效项时为空对象）。
 */
function probabilityMap(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const key = row.value ?? row.label;
    if (typeof key !== "string" && typeof key !== "number") continue;
    const probability = row.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability)) continue;
    if (probability < 0 || probability > 1) continue;
    out[String(key)] = probability;
  }
  return out;
}
