# OpenAI Decisions API：请求与答案的**形状**一起换，且答案数组要靠 name 认领

2026-11-25 接入 OpenAI Decisions（`POST /v1/decisions`，模型 `gpt-6-luna`）时确认的三件事。
前两条是「接不接得上」，第三条是「接上了但每次都静默降级」——那是本插件最难自查的一类故障。

## 1. 结构化证据用 `input_json`，不要 JSON.stringify

官方支持在 `user` 消息里放 `{ "type": "input_json", "data": {...} }`：

```json
{ "input": [{ "role": "user", "content": [
  { "type": "input_json", "data": { "tool": "bash", "command": "rm -rf /tmp/x" } }
] }] }
```

压成字符串会丢掉结构，而且文档明确说 `data` 里的 `role` / `image_url` 这类键是**普通数据**
——它们不会创建消息，也不会去抓图。用 `input_json` 恰好避开这个坑；用字符串则要自己
保证不会和消息语法混淆。

## 2. 题型名与字段都不同，不是换个名字就行

| 内部（System One） | OpenAI Decisions | 主要结果 |
|---|---|---|
| `noul` | `predicate` | `probability`（0–1） |
| `choice` + `criteria: {value: 描述}` | `choice` + `choices: [{value, description}]` | `choice` + `probabilities` |
| `score` + `criteria: [档位…]` | `score` + `levels: [{label}]` | 浮点档位 `score` |

另外两处硬性要求：

- `questions` 是**数组**且每题必须带 `name`（内部是对象键）。回包靠 `name` 认领。
- `choice` 的每个选项**两个字段都要有**；只有标签时 `description` 复用标签。
- `score` 的 `levels` 必须 2–10 档。

## 3. 答案是数组 → 不归一就是「每次决策都降级」

回包形状：

```json
{ "answers": [
  { "type": "predicate", "name": "irreversible", "probability": 0.05 },
  { "type": "choice", "name": "risk", "choice": "low", "confidence": 0.91,
    "probabilities": [{ "value": "low", "probability": 0.91 }] }
] }
```

而 `classify()` 原本读的是 `body.answers` 并按 **id 索引**取值，各决策点的 `parse()`
也只认 `answers.risk` 这种访问方式。于是：

- 请求完全成功（HTTP 200），
- 答案形状「看起来像对象」（数组也是 object），**不会**触发 `missing-answers`，
- 但 `answers.risk` 是 `undefined` → `parse()` 返回 `undefined` → 每次决策都降级放行。

**症状**：面板显示「已连接、模型正确」，遥测里全是 `answer-shape-mismatch`，守卫静默不工作。

对策：把归一放在**传输层**（`readAnswers(provider, body)`），而不是让九个决策点各写分支——
后者漏一个就是那个点静默失效。归一后各决策点只面对一种答案形状。

`probabilities` 数组还必须转成**按值索引的对象**（`{low: 0.91, medium: 0.07}`）：
`tolerance.js` 的连续严重度读的是 `probabilities.high` / `.medium`，数组形态拿不到，
只能退回分类兜底值——「分数能算但永远是最粗的那一档」。

## 4. `refusal` 绝不能翻译成「条件不成立」

OpenAI 会回 `{ "type": "refusal", "name": "risk" }`。把未知类型当成 `noul: 0`
（"条件不成立" = 不危险）等于让**模型拒绝判断**变成**放行**。正确做法是保留原类型，
让 `parse()` 判为形状不符 → 降级放行。形状不符即降级，是既有的 fail-open 原则。

## 验证方式

- `test/protocols.test.js`：纯函数层（形状转换 + 各协议互不干扰）。
- `test/openai-protocol-route.test.js`：端到端。**关键一条**是「用真实的
  `extractGuardAnswers` 解析真实回包」，只断言请求体对不对是不够的——请求对、答案没接上，
  正是第 3 条那个故障。
- 变异验证：把 `readAnswers(provider, body)` 换回 `body.answers`，该用例立刻转红。
