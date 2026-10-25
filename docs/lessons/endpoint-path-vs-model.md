/**
 * 端点路径（/decisions 还是 /systemone）与模型名无关，只与**服务商**有关。
 *
 * 2026-10-25 实测（真实 key，打真实端点）：
 *
 *   服务商            模型                          /v1/decisions      /v1/systemone
 *   ──────────────── ──────────────────────────── ────────────────── ──────────────────
 *   SiliconFlow      Kev-4B                        404 Not Found      200 ✅
 *   bamboonode       startlux-decision-27b-autothink 200 ✅          200 ✅
 *   bamboonode       typesafe/jev-1.14             400 not served     400 not served
 *
 * 结论：
 *
 *   1. **路径由服务商决定，不由模型决定**。bamboonode 的决策模型在两条路径上
 *      都能用；SiliconFlow 的 Kev-4B 只认 /systemone。
 *   2. **404 = 路径不存在**，400 = 请求内容/模型不合法。这是能安全用来
 *      「换一条路径重试」的信号（实测两类网关都如此）。
 *   3. 同一个 key 在 SiliconFlow 上打 /v1/decisions 得到的是纯文本
 *      `Not Found`——不是 JSON 错误体——因此降级时必须报出真实端点，
 *      否则用户看到「HTTP 404」完全猜不到是自己路径选错了。
 *
 * 现场影响（telemetry.jsonl，2026-10-25 13:16–13:41）：8 次 `http-404` 降级。
 * 守卫是 fail-open 的，所以它**静默地什么也没做**——用户只看到「守卫没反应」。
 */

export {};
