# dsh-decision-engine

[website](https://dsh.zuos.us/dsh-decision-engine/)

给 DeepSeek Harness 的**决策层**：在主模型动手之前，把「当前状态 + 一组结构化问题」发给一个
便宜的决策小模型，拿回概率化的答案，据此决定放行、询问、拦截，或改道（换模型）、跳过（省掉一次
昂贵调用）。例如工具授权问四个问题：风险、可逆性、任务相关性、注入嫌疑。
默认只记录、不拦截（`shadow`），任何异常一律 fail-open 放行。

A judgement layer for DeepSeek Harness: before the main model acts, it sends
"current state + a set of structured questions" to a cheap decision model, gets
probability-bearing answers back, and decides to allow, ask, block — or reroute
(switch model) and skip (drop an expensive call). Tool authorization, for example,
asks four questions: risk, reversibility, task relevance, injection suspicion.
Defaults to `shadow` (record only) and fails open on any error.

**接任意决策服务**：请求形状只有一个——`{ model, state, questions, think_mode }` 发过去，
拿回 `answers`。哪些服务商提供这个端点、走哪条路径、用谁的 key，都由 provider 决定，
与各决策点的解析逻辑无关。因此内置多个预设，也可填任意 `custom` base URL
（自建 llama.cpp / vLLM、企业网关、第三方中转）。

Works with **any decision endpoint**: there is exactly one request shape —
`{ model, state, questions, think_mode }` in, `answers` out. Which service provides it,
which path it sits on, and whose key it uses are the provider's business and never touch
the per-point parsing logic, so you can pick a built-in preset or fill in any `custom`
base URL (self-hosted llama.cpp / vLLM, corporate gateways, relays).

## 安装 / Install

```sh
dsh plugin add dsh-decision-engine
```

或手动装进 profile：add it to a profile manually:

```sh
cd ~/.dsh/profiles/desktop
pnpm add dsh-decision-engine
```

然后在 profile 的 `package.json` → `dsh.profile.bundles` 里加入 `"dsh-decision-engine"`，
重启 DSH。Then add `"dsh-decision-engine"` to `package.json` → `dsh.profile.bundles`
and restart DSH.

本地开发 / local development：`git clone` 后复制进 profile 的 `node_modules`，或用
`pnpm link`（详见
[docs/local-dev-link.md](https://github.com/zuosus/dsh-decision-engine/blob/main/docs/local-dev-link.md)）。

配置**改完即生效，不需要重启**：每次调用前都会检查配置文件 mtime。
Config changes take effect **without restarting DSH**.

## 数据文件 / Data files

数据目录是 **`$DSH_HOME/dsh-decision-engine/`**（`DSH_HOME` 未设置时为 `~/.dsh`，
Windows 上形如 `C:\Users\<name>\.dsh\`）。解析顺序与宿主一致：显式路径 → `$DSH_HOME` →
系统家目录。All paths below live under `$DSH_HOME/dsh-decision-engine/`.

| 文件 | 作用 |
|---|---|
| `config.yml` | 配置（可从 [config.example.yml](config.example.yml) 拷贝；实际以配置页写入为准） |
| `telemetry.jsonl` | 决策流水账，给人读 / `tail` 排查 |
| `stats.jsonl` | 按 provider × model 的 token 与耗时，供「统计与对比」页读取 |
| `~/.dsh/.credentials.yaml` 的 `refs:` 段 | API key 的默认存放处（见下） |

配置里可能有明文 key，因此 `config.yml` 权限保持 `600`。

## 配置页 / The config page

**插件 → 已安装 → dsh-decision-engine → 点进该插件**，上方出现 Decision Engine 卡片
（内置 `enabled: false`，不会擅自介入）：

- **服务提供方**：`system one` / `bamboonode` / `硅基流动` / `Silicon Flow` / `custom`，
  下一行显示当前生效端点
- 两个开关：`启用守卫`、`真正拦截`
- **思考模式**：`never`（默认）/ `auto` / `always`
- **模型**下拉（来自当前 provider 的 `/v1/models`，含「自动（服务端默认）」）
- **API Key** 输入框；选 `custom` 时展开 `Base URL`（必填）、`端点风格`、`附加请求头`、`密钥变量名`
- `测试端点` 按钮：回显 provider、实际 POST 的完整地址、HTTP 码、请求 id 与响应体
- **决策模型参与点**：每个决策点一行，`关闭 / 观察 / 生效` 三态
- **统计与对比** tab：命中率、token / 耗时 / 节省量、裁决分账（见下）

**改完即保存，没有「保存」按钮**：开关 / 下拉点一下即落盘；文本框停顿约 0.7 秒或失焦落盘；
API Key 只在**失焦或回车**时落盘（半截 key 不会进凭据文件）。底部状态行实时显示
`待保存… / 保存中… / 已保存 / 未保存：原因`，失败可重试。
选 `custom` 但 `Base URL` 为空或不合法时，配置改动整体延后并给出原因，地址补全后自动落盘。

There is **no Save button**: controls persist on click, text fields after ~0.7s or on
blur, the API key only on blur/Enter. The status line reports pending / saving / saved /
unsaved-with-reason.

**界面语言跟随宿主 / UI language follows the host**：配置页与统计页会自动使用宿主
（DSH 设置 → 语言）当前的语言：中文宿主显示中文，英文宿主显示英文，切换语言时面板
即时跟随，无需重开。宿主未提供语言时按浏览器语言判断。文案由插件自带的词表提供，
因此与插件信息页里的标题/描述独立。工具授权审批卡的**标题**同样跟随宿主语言：插件按
宿主的 `PreToolDecision.displayReason` 契约成对给出中英两种文案，`reason` 保持中文
原文，只用于审批审计与遥测。

The config and stats panels use the host language (DSH settings → Language): a Chinese
host gets Chinese, an English host gets English, and the panel follows a live switch
without reopening. When the host exposes no language, the browser language decides.
Translations live in the plugin's own dictionary, independent of the manifest title.
A tool-authorization approval card's **title** follows the host language too: the plugin
supplies the host's paired `PreToolDecision.displayReason`, while `reason` stays the
Chinese original for the approval audit trail and telemetry.

## Provider：接哪个决策服务 / Which decision service

请求形状对所有 provider 完全一致：

```http
POST <base>/decisions   或 / or   POST <base>/systemone
authorization: Bearer <key>
content-type: application/json

{ "model": "...", "state": {...}, "questions": {...}, "think_mode": "never" }
```

响应只需含 `answers`（`model` / `usage` 可选）。所以 provider 只决定三件事：
**往哪发、用谁的 key、默认哪个模型**。

| provider | 默认地址 | 端点 | 密钥变量名 | 默认模型 |
|---|---|---|---|---|
| `system one` | `https://api.typesafe.ai/v1` | `/v1/systemone` | `TYPESAFE_API_KEY` | 服务端默认（`jev-latest`） |
| `bamboonode` | `https://api.bamboonode.dev/v1` | `/v1/decisions` | `BAMBOO_API_KEY` | 服务端默认（`startlux-decision-27b-autothink`） |
| `siliconflow`（国内站） | `https://api.siliconflow.cn/v1` | `/v1/systemone` | `SILICONFLOW_API_KEY` | `Kev-4B`（可改 `SemIf`） |
| `siliconflow-intl`（国际站） | `https://api.siliconflow.com/v1` | `/v1/systemone` | `SILICONFLOW_INTL_API_KEY` | `Kev-4B`（可改 `SemIf`） |
| `custom` | 用户填写（必填） | 按 `端点风格` 拼 | `customApiKeyEnv`（缺省 `DECISION_ENGINE_CUSTOM_KEY`） | `customModel` |

硅基流动接入文档：[国内站](https://api-docs.siliconflow.cn/docs/api/systemone-post) ·
[国际站](https://docs.siliconflow.com/en/api-reference/systemone/create-systemone)。
两个站点是**两套账号、key 互不通用**，所以各占一格；选它们只需粘一个 key，
地址、路径、默认模型都已预置。

**每个 provider 有自己的密钥变量名并各自保存 key，互不覆盖**：五套凭据可以同时配好，
切换 provider 不会把 A 的 key 发给 B。模型字段同样**按 provider 分开存**
（`model` / `systemoneModel` / `siliconflowModel` / `siliconflowIntlModel` / `customModel`），
切 provider 不会把 A 的模型名发给 B。

`custom` 的 `Base URL` 必须是 `http://` 或 `https://` 地址（不带 scheme、其它协议、含空格或
查询串都会被拒），`端点风格` 取 `auto`（默认）/ `decisions` / `systemone`，
`附加请求头` 格式 `名称: 值`（分号分隔；`authorization` / `content-type` / `host` 由插件固定）。
结尾斜杠会先去掉，因此 `.../v1/` 与 `.../v1` 等价；拼接幂等，不会产生 `/v1/v1/decisions`。

### 端点路径由服务商决定，不由模型决定

`端点风格` 只是**首选**路径：先打首选，收到 **404**（= 路径不存在）时自动改用另一条再试一次，
试通的那条按 base URL **记住**，下次直接命中、不再多一次往返。两条都 404 时，遥测与
`测试端点` 会列出试过的两个地址并提示改端点风格。只有 404 触发换路径——400（模型/内容不合法）、
401（key 不对）、5xx 与路径无关。配置页会显示「已验证可用：…」。

The endpoint style is only a *preference*: on **404** the plugin retries the other path
once and remembers the one that works (keyed by base URL). Only 404 triggers a switch —
400 / 401 / 5xx have nothing to do with the path.

### 密钥保存位置 / Where keys are stored

| `keyStorage` | 写到哪里 | 适合 |
|---|---|---|
| `credentials`（默认） | `~/.dsh/.credentials.yaml` 的 `refs:` 段 | 与其他服务统一托管，插件目录不留明文 |
| `config` | 插件配置目录下的 `config.yml` | 配置自包含、可随目录整体备份；注意是**明文** |

写 `credentials` 时**只改 `refs:` 段**，`records:` 与注释逐字保留；权限固定 `600`；
清空即删除该键；写入失败整体报错，不会出现「配置说存了、实际没存」。
已有 key 不会随存储位置切换被悄悄搬家，需要时重新粘贴一次。

**密钥优先级**：该 provider 的显式 key 字段 > 所选存储位置里的对应键 > 环境变量。
Key precedence: explicit key field > the matching key at the chosen storage location >
environment variables.

### 模型默认「自动」

留空即**不发送 `model` 字段**，由服务端用它当前的默认决策模型——服务商将来改名也不会 400。
注意 `config.yml` 里 `model:` **必须写出来但留空**：整行删掉会让键缺失并回落到内置模型名。
两个 SiliconFlow 端点把 `model` 列为必填，所以它们的「留空」= 预设默认 `Kev-4B`；
模型名大小写不敏感。模型下拉只列该 provider 真正能服务的模型（服务商的 `/v1/models`
会列出大量 chat 模型，打到决策端点必然 400）。

Blank = **auto**: the field is not sent and the server picks its default decision model.
In `config.yml` the `model:` key must be present but empty — deleting the whole line falls
back to a built-in name.

## 决策点 / Decision points

八个决策点全部已实装，由你决定让决策模型进入哪些环节。原则：**只在「替代更贵的调用」
或「阻止更大的开销」处介入，绝不为了「多一道检查」而介入**。

All eight decision points are implemented. The plugin intervenes only where a call
replaces something more expensive or prevents a bigger expense — never just to add a check.

| # | 决策点 | 挂载位置 | 触发闸（为什么不是每次都问） | 生效方式 | 省 token |
|---|---|---|---|---|---|
| 1 | 工具授权 `authorize` | `tools/pre-execute` | 只读工具 / auto 预设 / 排除名单直接放行 | `ask` / `deny` | 替代 auto-review 的满上下文审查 |
| 2 | 模型路由 `route` | `agent/request` | 每轮仅前 N 步 + 路由未变不问 + 新用户输入不问 | 替换 `provider` / `model` | 机械步骤下沉到便宜模型 |
| 3 | 子任务分派 `delegate` | `agent/pre-step` | 仅每轮第一步且带新用户输入 | 注入一条提示 | 少开一个 subagent = 省一整个上下文 |
| 4 | 上下文压缩 `compact` | `agent/pre-step` → `ctx.compaction` | 仅实测 token 达触发线 ×70% | 先跑确定性裁剪，让摘要被跳过 | 省掉一次摘要调用 |
| 5 | 轮次延续 `turnStop` | `agent/turn-stopping` | 同一轮最多续一次 | `agent.steer()` | 避免空转一整轮 |
| 6 | 检索必要性 `retrieval` | `tools/pre-execute` | 仅检索类工具；其余工具零开销 | `deny` | 省搜索与结果 token |
| 7 | 技能选择 `skillPick` | `tools/pre-execute` | 仅 `skill` 工具且候选 ≥2 | `deny` + 指路 | 省误加载的技能正文 |
| 8 | 思维链翻译 `cotTranslate` | 包住 `translator.translate()` | 本地预筛 + 同文本缓存 | 跳过并返回原文 | 按条省翻译调用 |

### 三态 / Three modes

| 模式 | 行为 |
|---|---|
| `关闭` off | **连请求都不发**，既省 token 也省一次往返 |
| `观察` observe | 照常判断并记录「本该怎样」，不改变任何行为 |
| `生效` enforce | 按判断执行该点的处置 |

新接入的决策点默认 `off`，升级不改变行为；建议先跑 `观察`，确认与人工判断一致后再切 `生效`。
New points default to `off`; run `observe` first, switch to `enforce` once verdicts match
human review.

热路径上的点（`route` / `delegate` / `cotTranslate`，配置页标「热路径」角标）每次约
1.9k token，且每步都触发，因此都带明确的触发闸，不能无条件调用。
本插件**不设每小时 token 预算**：命中缓存后几乎为零，而「超限即停止判断」会让守卫在最需要
它的时候失效。

## 省 token 的设计 / Token-saving design

- **精确缓存**（唯一默认开启的层）：完整 `state` + 问题集一致即复用，命中即不发请求。
- **同类复用软缓存默认关闭**：其键刻意丢弃参数内容，命中意味着不同参数共享同一裁决；
  只有调用方显式声明 `softCacheable: true` 才启用，**工具授权永久禁用**该层（安全裁决
  要么绑定完整调用上下文，要么不缓存）。
- **只读工具直接放行**：`read` / `read_image` / `grep` / `glob` / `todo_write` /
  `web_search` / `web_fetch` 等不发请求。
- **state 截断**：`args` 走头尾摘要，`recent` 只带最近 4 条、每条 240 字符
  （`recentMessages` / `recentMessageChars` / `maxStateChars`）。
- **`thinkMode` 默认 `never`**：主要省延迟（约 1.9s vs 7.2s）。`always` 每次约多等 5s，
  适合排查误判时临时用。非法值会被归一成 `never`。
- **失败冷却**：连续 3 次失败进入 60s 冷却，冷却期内直接放行、0ms 返回。

## 超时与降级（fail-open）/ Timeout and fail-open degradation

每次请求带硬超时（默认 `timeoutMs: 8000`，最小 1000）；超时不是错误，而是降级放行。
**没有配置 key 时根本不发请求**，直接 `no-key` 降级，零延迟。上层 `AbortSignal` 被中止时
立即返回 `caller-aborted`。设计原则：任何不确定都退回原生行为，守卫自身故障绝不卡住工具调用。

Every request has a hard timeout (default 8000ms) and a timeout is a fail-open
degradation, not an error. With no key, no request is sent at all.

所有降级放行主流程，并在 `telemetry.jsonl` 记一条 `action=degraded`：

| 情形 | `detail` |
|---|---|
| 插件未启用（`enabled: false`） | 不判断，直接放行 |
| 没有 API key | `no-key` |
| 命中失败冷却 | `cooldown` |
| 端点 4xx / 5xx | `http-404` / `http-500` …（附 `endpoint`、`body`、`provider`） |
| 网络不可达 / 超时 | `network-error` / `timeout`（附 `timeoutMs`） |
| 响应非 JSON / 非对象 / 缺 `answers` | `invalid-json` / `invalid-response` / `missing-answers` |
| 答案形状不符（类型错、缺字段、`choice` 非法、概率越界） | `answer-shape-mismatch` |
| provider 不可用（如 custom 的 base URL 非法） | `invalid-base-url`（附原因） |
| 鉴权被拒（401/403） | `auth-failed`（附该 provider 的密钥变量名） |
| 守卫内部抛异常 | 捕获后放行，仅 `logger.warn` |

降级不止写进日志：它显示在**所属那一轮消息的尾部**（与宿主自带的 token 统计同一位置），
一轮里同一类错误只出一行；错误永不进入模型可见上下文。若宿主没有该扩展位或读不到当前轮次，
则宁可只进日志，也不会把错误挂到别的消息下面。

Degradations also surface **at the tail of the message they belong to** (one line per
error kind per turn), and never enter the model's visible context.

## 统计与对比 / Statistics

设置页第二个 tab 回答两个问题：**钱花在哪**，以及**不开这个插件本该花多少**。

- **时间范围**：当日 / 本周（周一起）/ 本月 / 本年 / 自定义（精确到分钟）。区间一律
  左闭右开 `[start, end)`，界面上会写出预设解析成的真实边界。
- **维度**：按 **provider × model** 独立统计，每组给 input / output token 总量、
  总耗时与平均耗时（**均耗时只按真实请求算**，缓存命中那次耗时为 0）、命中缓存次数。
- **横向对比**表统计全部模式（回答「钱花在哪」）；**节省量对比**表（基线 → 实际）
  **只统计 `observe` 模式的记录**——节省量是反事实数字，只有两条路径跑在同一批工作上
  才成立；生效模式下主模型路径根本没发生，只能事后估算。界面据此标注「（观察）」，
  并在区间内没有观察样本时明确写「没有可比对的数据」而不是显示「省了 0」。
- **基线** = 不启用本插件的缓存与上下文截断时同样的工作本应消耗的 token 与时间；
  只有这两类优化计入，`think_mode`（用户自己的配置）刻意不算。无可归因优化时节省量是 0。
- **裁决统计**：`allow`（照常进行）/ `ask`（升级到人工确认）/ `reject`（拦下不执行），
  外加一格 `未裁决`（降级时插件什么都没改变）。映射按 **(决策点, 裁决词)** 定义在
  `lib/outcomes.js`——同一个词在不同点上含义可能相反
  （`retrieval.skip` 是拦截，`cotTranslate.skip` 只是没翻译一句）。未登记的裁决会显式提示条数。
- **按决策点分账**：同一 provider/model 上哪个点在花钱。
- 写入是异步的，不占决策路径；写盘失败只记警告。

每条统计记录含 `provider` / `model` / `point` / `mode` / `action` / `cached` /
`inputTokens` / `outputTokens` / `durationMs` 与对应的 `base*` 基线值；实现见
`lib/stats.js` 与 `lib/stats-store.js`。
Each stats record carries provider, model, point, mode, action, cached, token and
duration values plus their `base*` baseline counterparts.

### token 估算 / Token estimation

API 不返回 `usage` 时（自建 llama.cpp / vLLM 通常不返回）用内置零依赖估算器兜底：
`tokens ≈ 90 + 中日韩字符数 + 其它字符数 / 3`（真实请求标定，平均相对误差约 6%）。
真实返回值始终优先。本插件的硬约束是**零运行时依赖**，因此不引第三方 tokenizer。

## 阈值 / Thresholds

每个决策点的阈值都可用真实端点的成对样本（「该判 A」与「该判 B」）校准，全部可在
`config.yml` 覆盖；键名、默认值与「调高 / 调开会怎样」逐项写在
[config.example.yml](config.example.yml) 里，那里是唯一的权威清单。

Every threshold is overridable in `config.yml` and calibrated against paired samples on a
real endpoint. [config.example.yml](config.example.yml) is the single authoritative list of
keys, defaults, and what raising or lowering each one does.

## 开发 / Development

```sh
pnpm test             # 单元测试：纯函数、适配器接线、providers、配置往返、设置界面渲染、缓存回归、统计与裁决分账
pnpm verify:wiring    # 接线检查：用真实 schemastery 加载插件，确认每个监听器注册、每个新点默认 off
pnpm verify:endpoint  # 逐个决策点打真实端点，校验题型与答案形状（需网络与该 provider 的 key）
pnpm verify           # test + verify:wiring
```

`verify:endpoint` 不能省：题型写错会在运行时 400 并静默降级，光看日志几乎发现不了
「这个点其实一直没生效」。It cannot be skipped: a wrong question type 400s at runtime and
degrades silently, so logs alone won't reveal that a point never worked.

`verify:wiring` 需要 profile 的依赖可解析；仓库里没有 `node_modules` 时先
`ln -s ~/.dsh/profiles/desktop/node_modules node_modules`。

## 想深挖为什么这样设计 / Why it works this way

本文只讲「现在的行为」。每个取舍背后的推理与实测证据另有去处：
This file documents current behavior only; the reasoning and measurements behind each
trade-off live elsewhere.

- [DECISIONS.md](https://github.com/zuosus/dsh-decision-engine/blob/main/DECISIONS.md) —
  设计决策日志（为什么节省量只统计观察模式、为什么软缓存
  对授权永久禁用、为什么去掉 token 预算…）
- [docs/lessons/](https://github.com/zuosus/dsh-decision-engine/tree/main/docs/lessons) —
  踩过的坑（端点路径与模型名的关系、`model` 字段哪些
  服务商必填、本地开发的链接方式）
- [config.example.yml](config.example.yml) — 全部配置键与阈值的权威清单
- [项目站](https://dsh.zuos.us/dsh-decision-engine/) — 带英文版的介绍页

## License

MIT
