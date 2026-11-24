# 能力表：让「界面能设置」与「端点真的接受」永远一致

## 症状

`decisionmodels.io` 上守卫**完全没在工作**，但面板显示一切正常：provider 正确、模型正确、key 已配置、端点连通。

查遥测：每次决策都是 `http-400`，响应体：

```json
{"loc":["think_mode"],"msg":"Extra inputs are not permitted"}
```

原因是本插件在 System One 线协议里总会发一个可选的 `think_mode` 字段（`never` / `auto` / `always`）。TypeSafe、硅基流动、端砚都接受它；`decisionmodels.io` 不接受。

而守卫是 **fail-open** 的：400 → 降级 → 放行。于是「每次都失败」表现为「什么都没做」。

## 第一个补丁只修了一半

给数据层加 `supportsThinkMode: false`，请求构造时跳过该字段——请求终于 200 了。

但设置界面里的「思考模式」下拉**还在**：可以点、可以选 `always`、还能存进配置。用户选了之后什么也不会发生，因为那个 provider 根本不发这个字段。

这比原来的 bug 更隐蔽：端点已经通了，遥测也正常，只有一个不起作用的下拉框。**「配了没反应」正是本插件最忌讳的一类故障。**

## 正确的形状：一张共享的能力表

能力的唯一真相在 `lib/providers.json`：

```json
{
  "id": "decisionmodels",
  "capabilities": { "thinkMode": false }
}
```

两侧都读它：

- **传输层**：`buildRequestBody()` 见 `thinkMode: false` 就不发 `think_mode`。
- **配置界面**：`providerCatalog()` 把整张表下发，界面见到 `false` 就把该行**禁用并说明原因**。

三条设计约束：

1. **协议事实优先于 JSON。** 只有 `systemone` 协议有 `think_mode`；`google-decisions` / `openai-decisions` 的请求体是 `input` / `questions`，即使 JSON 里写 `thinkMode: true` 也必须按 `false` 处理。允许覆盖等于允许能力表说谎。
2. **表是开放的。** 数据层不认识的能力键原样下发，所以以后加参数只改 JSON，前端与传输层都不动。
3. **禁用，不隐藏。** 隐藏会让用户以为设置丢了，也无法回答「为什么我选的 `always` 没反应」。禁用 + 一行「该端点没有 think_mode 字段」把答案直接写在界面上。

## 怎么保证它不再退回去

两条断言把两侧钉在同一事实上：

- `supportsThinkMode` 与 `buildRequestBody()` 的实际输出必须一致——**声称支持的，请求体里必须真的能看到该字段**。这条挡住「能力表是另一份真相」。
- 界面按 `capabilities.<key>` 取值、并且能顺着这张表禁用控件。把 `capabilityTo` 写死成 `true`，4 条 UI 用例立刻转红；把传输层的判断删掉，2 条协议用例转红。

## 一般规律

**任何「用户可设置、但某些 provider 会忽略」的选项，都必须有一个数据层的声明来支撑它。** 只在一层修（只管发请求，或只管界面）永远会剩下另一半——而剩下的那一半不会报错，只会安静地什么都不做。
