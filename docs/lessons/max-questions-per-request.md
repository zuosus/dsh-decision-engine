/**
 * 「一次请求能带几道题」由服务商的**模型**决定，不由本插件决定。
 *
 * 2026-11-25 实测（真实 key，打真实端点，`GET /v1/models` + `POST /v1/systemone`）：
 *
 *   服务 / 模型                   max_questions   一次问 2–4 道的结果
 *   ──────────────────────────── ──────────────  ─────────────────────────────────
 *   decisionmodels s1-fast        1               400 too_many_questions（每次必失败）
 *   decisionmodels s1-pro         3               2 道可以、4 道 400
 *   decisionmodels reax-1         3               同上
 *   decisionmodels s1-llm-auto-router  7           4 道可以
 *   OpenAI gpt-6-luna             未声明          一次可问完（429 是余额问题，不是形状）
 *   SiliconFlow Kev-4B            未声明          一次可问完
 *
 * 结论：
 *
 *   1. **上限是模型属性，不是服务属性。** 同一家的 s1-fast 是 1、s1-pro 是 3、
 *      路由模型是 7。因此它必须跟着「预设的默认模型」一起声明
 *      （`providers.json` 的 `maxQuestions`），不能按 baseUrl 记。
 *   2. **超上限不是「模型不聪明」，是整笔 400。** 而本插件 fail-open：表现为
 *      **静默失效**——面板显示「已连接、模型正确」，守卫却一次都没生效过。
 *      这是最贵的一种故障：用户以为它在工作。
 *   3. 因此必须**拆题**：超过上限的题目集切成多份、分多次请求、答案合并
 *      （见 `lib/question-batching.js` 与 `index.js` 的 `#sendChunks`）。
 *      任何一份失败就整体失败——半份答案喂给决策点的 `parse()` 只会返回
 *      undefined，看起来像降级，实际是「一部分题目根本没问」。
 *   4. **没声明上限的服务也要能自愈。** 回包里出现 `too_many_questions` /
 *      `max_questions` / `exactly one question` 时，把它学成 1 并重发一次
 *      （`QuestionLimitMemory`）。学习只往小改：已学到的更小值时保留更小的，
 *      因为拆分不足会再次静默失效，而拆分过多只是多几次请求。
 *
 * 附带一条同源的坑：`GET /v1/models` 里的 `max_questions` 是**唯一**可靠的
 * 上限来源，别靠猜、也别靠「试一次看会不会 400」——后者每次决策都多付一次
 * 注定失败的往返，遥测里还会持续出现 `http-400`，看起来像服务坏了。
 */

export {};
