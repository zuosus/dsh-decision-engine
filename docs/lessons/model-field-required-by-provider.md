/**
 * 「模型留空」的含义由服务商决定，不是本插件能统一的。
 *
 * 2026-10-25 实测（真实 key，打真实端点）：
 *
 *   服务商          请求                           结果
 *   ────────────── ──────────────────────────── ──────────────────────────
 *   SiliconFlow    省略 model                    400 Model field is required.
 *   SiliconFlow    model: ""                     400 Model field is required.
 *   SiliconFlow    model: Kev-4B                 200 ✅
 *   bamboonode     省略 model                    200 ✅（服务端回填默认模型）
 *
 * 结论：
 *
 *   1. **model 是否必填由服务商决定**。SiliconFlow 的 /systemone 把 model 列为
 *      required（官方文档也这么写），而 bamboonode 省略字段会由服务端回填。
 *   2. 因此「留空 = 不发 model 字段」这条规则只在**服务端接受省略**时成立。
 *      套到必填端点上就是一次注定的 400，而守卫是 fail-open 的——表现为
 *      **静默失效**：用户只看到「守卫没反应」，日志里是 http-400 降级。
 *   3. 反过来把模型名钉死在配置里也不好：服务商给模型改名时配置就失效了。
 *      正确做法是**预设带默认模型、配置留空即用默认、填了以填的为准**
 *     （见 providers.js 的 `requiresModel` / `defaultModel`）。
 *
 * 附带一条同源的坑：/v1/models 不能直接当决策模型清单用。SiliconFlow 会返回
 * 98 个模型、且**没有一条**带 `supported_endpoint_types`，而 /systemone 只认
 * Kev-4B / SemIf——chat 模型打过去是 400 `Model does not exist.`。把它们都塞进
 * 下拉，就是「96 个选了就失败的选项」。这类端点只能按预设的 `knownModels`
 * 白名单筛。
 */

export {};
