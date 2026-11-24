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

## 能力是模型的属性，不是只属于 provider：模型配置覆盖 provider 配置

`decisionmodels.io` 的四个模型脾气不同：`s1-fast` 一次只收 1 道题，`s1-pro` / `s1-vision` / `reax-1` 收 3 道，`s1-vision` 还能看图（用户 2026-11-25 的说明）。把它们的能力写在 provider 层，等于拿默认模型的保守值冒充全部模型：s1-pro 被白拆四发，`vision` 这种模型独有的能力也没有地方声明。

正确的形状是**两层声明 + 一处合并**：

```json
{
  "id": "decisionmodels",
  "capabilities": { "thinkMode": false },
  "models": [
    { "id": "s1-fast", "capabilities": { "maxQuestions": 1 } },
    { "id": "s1-pro", "capabilities": { "maxQuestions": 3 } },
    { "id": "s1-vision", "capabilities": { "vision": true, "maxQuestions": 3 } }
  ]
}
```

三条规则：

1. **逐键覆盖，模型赢。** 模型只写自己与别人不同的键；共同事实（`thinkMode:false`）写在 provider 层一次即可。未知键同样覆盖、原样透传——数据层不认识的能力不该被吞掉。
2. **合并只有一份实现。** `effectiveCapabilities(preset, modelId)` 是唯一真相：provider 打底、模型覆盖、协议兜底。界面与传输层只消费结果，不各自合并——否则又回到「界面说支持、请求体里没有」的静默失效（这正是上面那半篇文章的教训）。
3. **协议事实仍优先于两层声明。** 请求体里没有 `think_mode` 的协议，即使模型写 `thinkMode:true` 也按不支持处理；声明不能盖过事实。

字符串写法（`models: ["m1", "m2"]`）必须继续可用——老 JSON、外部脚本和既有测试都按它读写。归一时把它当成「声明了空能力对象的模型」，不改任何既有消费者的形状。

一般规律：**凡是对不同模型可能不同的行为，声明点就要落到模型上；覆盖规则收在一处，读取点按当前生效模型取值。** 把差异压在 provider 层，短期看是「保守值更安全」，长期看是在用谎报换省心——用户看不到多拆的几发请求，只看到守卫「好像有点慢」。
