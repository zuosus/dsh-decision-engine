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
| `decisions.jsonl` | 决策明细（含会话归属与决策内容），供「决策历史」标签页读取；到 8 MB 轮转 |
| `analytics.json` | 匿名统计的本地状态（安装 id + 上次上报日期），可随时删除以重置身份 |
| `~/.dsh/.credentials.yaml` 的 `refs:` 段 | API key 的默认存放处（见下） |

配置里可能有明文 key，因此 `config.yml` 权限保持 `600`。

## 决策历史 / The Decisions tab

开启后，会话的标签栏会在「对话」「轨迹」之后多出一个 **决策历史** 标签页，
按时间倒序列出**当前会话**里经本插件做出的每一次决策，共八列：
时间 / 决策点 / provider / model / 裁决 / 耗时 / **内容**（有内容 / 仅元数据）/
**标记**（缓存命中、已降级）。点任意一行展开，能看到这次决策的完整现场——
发给决策模型的 `state` 与 `questions`，以及它回来的 `answers` 和本地算出的
`scores`。

**列表滚动时表头（时间 / 决策点 / …）保持冻结**，记录多了也看得到列名。
**每一列表头都可点排序**（首次点某一列一律从降序起，再点切换升降序；默认按时间降序，最新一条在最上面）。

**新出现的记录带一个轻量入场动画**：页面每 5 秒轮询一次，这一轮比上一轮多出来的行会淡入
（300ms、位移 4px），已有行不动画，打开页面时那一批也不动画（几十条一起淡等于整页闪，反而看不出哪条是新的）。
翻排序方向、展开某行不会重放动画；系统开了「减弱动态效果」时一律不播。

Every column header is clickable (the first click on any column sorts descending;
the page itself defaults to time-descending — newest row on top). **Rows that show
up on a poll fade in** (300ms, 4px): existing rows never animate, neither does the
batch you get when you open the tab, and flipping the sort or expanding a row never
replays it. With the system's "reduce motion" setting on, nothing animates at all.

**「裁决」列写中文**：`delegate` 交给主模型 · `ask` 转人工确认 · `deny` 拒绝执行 ·
`keep` 保留原模型 · `switch` 换模型 · `inline` 自己接着做 · `advise` 建议分派 ·
`summarize` 摘要压缩 · `prune` 裁剪结果 · `continue` 续一轮 · `stop` 收束本轮 ·
`allow` 照常放行 · `skip` 跳过 · `redirect` 改用别的技能 · `translate` 翻译 ·
`degraded` 降级未裁决。裁决词本身是**机器词**（明细文件、遥测、原因串里都写它），
所以数据一个字节没动，只在渲染处换中文；鼠标停在标签上能看到原始词，英文界面
显示的也仍是这些原词。这一列的排序按中文显示名排，与其它列同一口径。

The **verdict** column is localized: the machine words (`delegate`, `inline`,
`advise`, …) stay exactly as they are in `decisions.jsonl` and telemetry — only
the display carries a Chinese gloss, with the raw word available on hover, and
the English UI keeps showing the words themselves.

With the feature on, each session gains a **Decisions** tab right after
Chat and Trajectory. It lists every decision this plugin made in *that* session
newest first, in eight columns: time / decision point / provider / model /
verdict / latency / **content** (has content, metadata only) / **flags** (cache
hit, degraded). Expanding a row reveals the full context sent to the decision
model, the questions, its answers, and the locally computed scores.

**默认开启**，可在配置页关掉（`decisionsTabEnabled`）：

Default **on**; turn it off on the config page (`decisionsTabEnabled`):

```yaml
# 唯一的开关：开 = 记录明细（含决策内容）；关 = 不写任何明细文件，标签页也消失
decisionsTabEnabled: true

# 以下是高级档位，配置页上没有开关，需要时手改 config.yml：
decisionsMaxContentChars: 4000   # 单条内容上限
decisionsMaxBytes: 8388608       # 明细文件体积上限（到顶轮转，只留一代）
```

**隐私边界 / Privacy**：明细只写本机 `decisions.jsonl`，**不发网络请求**，
也**不进匿名统计**。开关开着时**一定记录决策内容**（现场与回答），只有当
内容大到超出上限、连裁剪后的问题与回答都装不下时，该条才退化成「仅元数据」。
所以想不保留内容，唯一的办法是**关掉整个开关**——关掉后**完全不写这个文件**，
不采集、不落盘、不占磁盘，**没有**「只存元数据」的中间档。写盘前会做一层
密钥兜底替换（`sk-…`、`Bearer …`、JSON 里的 `apiKey`/`token` 字段），单条
内容超 4000 字符时按「工具参数 → 对话摘要 → 整个 state」依次裁剪。

The detail file never leaves the machine and is never part of anonymous
telemetry. With the switch on the decision content is **always** recorded — a row
only degrades to "metadata only" when its content is too large to fit even after
trimming. So the only way to keep content off disk is to turn the whole feature
off, which writes nothing at all: nothing collected, nothing stored, no disk
footprint. Secrets matching common key shapes are masked before the line hits
disk, and oversized content is trimmed in a fixed order.

**为什么单独一个文件**：`telemetry.jsonl` 是给人 `tail` 的结论流水账，
平均每行几百字节，而且被历史回填消费；把会话正文与完整现场塞进去会让它
膨胀十几倍，同时破坏「好读」和「回填口径」两件事。所以明细另立
`decisions.jsonl`，各管一件事。

> 有一个已知取舍：**思维链翻译**这个决策点在使用免费通道（google / bing）
> 时拿不到会话 id，因此那些记录「不可归属」，不会出现在任何会话的决策
> 历史里。为它编造一个会话 id 会让用户看到不属于自己会话的记录，比缺失
> 更糟。

## 匿名使用统计 / Anonymous usage stats

默认 **`daily` 档**：每天上报一次（首次运行那次算「安装」，之后算「今天在用」），
附带当日决策数。`install` 只在首次运行报一次；`off` 是**真的一个请求都不发**。

```yaml
telemetryLevel: daily     # off | install | daily
telemetryEndpoint: ""     # 留空用内置端点
```

为什么默认是 `daily` 而不是更保守的 `install`：只报首次的话，装机之后再也没有
心跳，日活/周活会恒为 0，统计本身就没有意义了。这条上报不改任何决策、不给会话
加延迟（`apply()` 里 `void` 掉），隐私边界见下。不想参与就设 `off`。

上报内容只有八个字段：**插件标识**（本插件的 npm 包名，服务端按它分插件统计）、
匿名安装 id（首次运行随机生成的 UUIDv4，与任何账号无关）、插件版本、平台、架构、
宿主版本、当日决策数、事件类型。

**绝不上报**：API key、prompt / 工具参数、文件路径、provider 地址、会话内容、用户名；
服务端也不记录 IP。想看/重置身份就删掉 `analytics.json`——下次运行会生成新 id。


## 配置页 / The config page

**插件 → 已安装 → dsh-decision-engine → 点进该插件**，上方出现 Decision Engine 卡片
（内置 `enabled: false`，不会擅自介入）：

表单按**从上到下四组**排列，组与组之间画一条分隔线（分隔线只是分组，界面上不加「第几组」
这样的标题）：

1. **使用免费模型**（默认关，原名「跟随服务端下发」）：打开后地址 / 模型 / key 改由
   `dsh.zuos.us` 下发，key **只驻内存、不落盘**；服务端不可用时自动回落到下面的本地配置，
   并显示一行原因。说明下面多一行小字「**可能会失效**」——这条免费通道由项目方自掏额度
   维护，随时可能停用或换 key，风险必须写在界面上
2. **连接与鉴权**：**服务提供方**（`system one` / `bamboonode` / `硅基流动` /
   `Silicon Flow` / `custom`）、**模型**下拉（来自当前 provider 的 `/v1/models`，
   含「自动（服务端默认）」）、**API Key** 输入框、**生效端点**（当前实际打到的地址，
   服务端下发生效时带来源角标）
3. **守卫行为**：两个开关 `启用守卫`、`真正拦截`；**决策历史**开关；
   **人工审核比例**四段滑块 `自治 / 轻松 / 默认 / 谨慎`（见下节）
4. 其余选项：**思考模式**（`never`（默认）/ `auto` / `always`）、**匿名统计**、
   **密钥保存位置**、**自定义 provider** 区（选 `custom` 时才展开：`Base URL`（必填）、
   `端点风格`、`附加请求头`、`密钥变量名`，**模型下拉也在这里**——清单来自你自己的服务，
   与 Base URL 同属一组）、provider 校验错误提示、**决策模型参与点**（每个决策点一行，
   `关闭 / 观察 / 生效` 三态）、自动保存状态行（含 `测试端点` 按钮：回显 provider、
   实际 POST 的完整地址、HTTP 码、请求 id 与响应体）与底部状态信息。
   这一组界面上**没有**「其他选项」这样的字面标题：它只是「其余都在这里」，多一层标题
   只会多一层不必要的视觉层级

**统计与对比** 是第二个 tab（不是配置页末尾的一块）：命中率、token / 耗时 / 节省量、
裁决分账（见下）。

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
因此与插件信息页里的标题/描述独立。工具授权审批卡的**标题**同样跟随宿主语言，而且
标题讲人话——它说明这次要做什么、为什么问，例如
`decision-engine：修改文件 /path/a.ts · 中风险，会改动可恢复的状态 · 需要你确认`，
不再把 `risk=… p=…` 这类遥测字段塞进标题（`write` / `edit` 这类工具在宿主卡上本来
就没有命令那行 detail，标题是唯一的人类文字，所以标题里点名操作对象）。`reason`
保持中文审计原文不动，只进审批审计与遥测。

**审批卡正文**（标题下面那块命令）另有一个开关 **`approvalDetailReadable`**（配置页叫
「审批卡正文可读化」，**默认开启**）。插件接管宿主的 `conversation.approval.detail`，
把命令改成「摘要 + 可展开的原文」：先给出「几步、其中哪几步是危险动作」（`rm -rf` /
`curl … | sh` / `sudo` 这类会被标出来），摘要下方列出每个步骤；原文默认收起，点开仍可
逐字核对——**真正执行的永远是原文**。摘要由确定性规则切分（`&&` / `||` / `;` / `|` /
换行，heredoc 整段识别成「执行一段脚本（N 行）」），不经过决策模型——端点只有
`choice` / `score` / `noul` 三种题型、没有自由文本。可读化就是默认体验；若你更想保留
宿主自己的样子，把这个开关**关掉**即可：关闭后完全不接管，宿主自己的渲染原样回来，
与 1.5.x 逐字一致（换行照旧由宿主折叠）。

The config and stats panels use the host language (DSH settings → Language): a Chinese
host gets Chinese, an English host gets English, and the panel follows a live switch
without reopening. When the host exposes no language, the browser language decides.
Translations live in the plugin's own dictionary, independent of the manifest title.
A tool-authorization approval card's **title** follows the host language too, and it
speaks plain language: it says what this call does and why it is asking, e.g.
`decision-engine: modifying /path/a.ts · medium risk — modifies recoverable state · needs your confirmation`,
instead of stuffing telemetry fields such as `risk=… p=…` into the title (`write` / `edit`
calls have no command detail line on the host card, so the title is the only human text
there). `reason` stays the Chinese audit original for the approval audit trail and
telemetry.

The **command block inside an approval card** (below the title) has its own switch,
**`approvalDetailReadable`** (labelled "Readable approval-card command block" on the config
page, **on by default**). The plugin takes over the host's
`conversation.approval.detail` and turns the raw command into a summary plus an expandable
original: how many steps there are and which look risky (`rm -rf`, `curl … | sh`, `sudo`)
come first, then each step on its own line; the original is collapsed by default and can be
expanded to compare byte for byte — **the original is always what actually runs**. The
summary is produced by deterministic rules (`&&`, `||`, `;`, `|`, newlines, with heredocs
recognised as "runs a script (N lines)"), never by the decision model, whose endpoint only
answers `choice` / `score` / `noul` and has no free text. A readable card is the default
experience; if you would rather keep the host's own rendering, switch it **off** — nothing is
taken over then, the host renders the block exactly as it did in 1.5.x, and line breaks
collapse there as before.

## 人工审核比例：模型无关的打扰频率 / Review tolerance: a model-agnostic interruption rate

`guard*` 那批阈值都是**绝对分数**，而且是在某一家决策模型上校准出来的——换个模型，
同一个 `0.4` 的含义就变了。**人工审核比例**（`tolerance`）不谈分数，只谈比例：
「大概每多少次工具调用，值得问我一次」。插件按当前模型**最近 200 次**授权决策的分数
分布，把你选的比例换算成阈值，因此**换决策模型不需要重调**。

| 档位 | `tolerance` | 含义 | 实测询问率 |
|---|---|---|---|
| 自治 | `autonomous` | 从不询问用户 | 0% |
| 轻松 | `relaxed` | 只有分数排在最前的 **1%** 才询问 | ≈1.1% |
| 默认 | `default` | 按决策模型自己的判断（**当前行为**） | 22.5% |
| 谨慎 | `cautious` | 默认判断之上，再问分数靠前的 **25%** | ≈41% |

（询问率来自回放 1,421 条真实授权决策；`default` 那一格就是现有阈值口径。）

- **`default` 与升级前逐字一致**。新逻辑是 `decideGuard()` 之上的后处理层，从不替换它，
  所以不写这一项（或写 `default`）的老配置行为一点没变。
- **`autonomous` 不取消拦截**。它只压制「问你」；真正高风险的调用仍会被直接拦下
  （`deny`）——拦下不打断你，它是安全边界，不是询问。四档都保留这一条。
- **`relaxed` 是替换语义**（把默认那套判断整个换掉，否则「最前 1%」会变成 23%），
  **`cautious` 是并集语义**（叠加在默认判断之上，因此永远不会比 `default` 问得更少）。
- **换模型或重启会重新攒样本**。不足 50 次时算不出分位数，此时按实测标定的冷启动阈值走，
  界面写明「校准中 n/50」——不是设置失效。分位数窗口按 `provider × model` 分桶，两个模型
  的分布互不干扰。

**两处都能改**：插件配置页，以及会话里的**「决策历史」标签页**。两处渲染同一个分段滑块
（不是下拉菜单——四档是一条单调的轴，下拉会把「往右更保守」这层压掉），读的是服务端同一份
下发载荷，因此在一处改动，另一处在它既有的 5 秒轮询里就会跟上。

`tolerance` controls **how often** a tool call escalates to a human, expressed as a rate
rather than an absolute score — the four levels are realised as *percentiles of that
decision model's own recent scores*, which is exactly why they survive a model swap.
`default` reproduces the pre-feature behaviour byte-for-byte; `autonomous` never asks but
still honours hard blocks. Both the plugin config page and the session **Decisions** tab
carry the same segmented slider.

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
| `perplexity` | `https://api.perplexity.ai` | auto（未实测） | `PERPLEXITY_API_KEY` | `sonar`（占位，待实测） |
| `openrouter` | `https://openrouter.ai/api/v1` | auto（未实测） | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini`（占位，待实测） |
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

**密钥优先级**：配置页的「使用免费模型」开关**生效时，下发的 key（仅内存）优先级最高**；
否则该 provider 的显式 key 字段 > 所选存储位置里的对应键 > 环境变量。
When the free-model switch is on, the delivered key (memory only) wins; otherwise:
explicit key field > the matching key at the chosen storage location > environment variables.

> 提醒：`keyStorage`（密钥保存位置）在配置页上属于最后那一组「其余选项」，不跟 API Key
> 挨着。它是「key 存到哪」的账务设定，不是连接本身；放在连接组里会打断「provider → 模型
> → key → 生效端点」这条阅读线。

### 服务端下发模式 / Server-provided config

**默认关闭。** 打开配置页的「使用免费模型」（原名「跟随服务端下发」）后，地址、模型与 key
都由 `https://dsh.zuos.us/api/provider-config`（**内置地址，不可配置**）下发并直接使用：

- **key 只保存在插件进程的内存里，永不落盘**：不写 `config.yml`、不写
  `.credentials.yaml`、不进遥测 / 统计 / 决策明细，任何接口只回传末四位（`…abcd`）；
- 生效时「生效端点」行会出现「服务端下发」角标与实际地址；
- **服务端不可用（含 404 / 403 / 超时 / 载荷非法）时静默回落到下面的本地配置**
  （包括你自己的 key），配置页显示一行原因；
- 关掉开关会**立即从内存里清掉**下发的 key；
- 手动填写 provider / base URL / 模型 / key 的整套流程**完全不变**；服务端生效期间这些
  本地值只是暂不生效，关掉开关或服务端不可用时立刻回到它们。
- **这条通道「可能会失效」**（开关说明下那行小字就是这件事）：免费额度由项目方自掏
  维护，可能随时停用或换 key。停用后插件自动回落到本地配置，不会中断守卫，但「免费」
  这件事本身没有承诺——要把自己的 key 备好。

服务端换 key 后客户端多久跟上：下发带 TTL（默认 600 秒），插件在**启动**、**打开配置页**与
点「重新获取」时刷新；决策热路径**不会**为刷新等待网络。

维护者侧（Worker）需要在部署时配置的 secret：

```sh
npx wrangler secret put PROVIDER_BASE_URL        # 下发的基础地址，例如 https://api.example.com/v1
npx wrangler secret put PROVIDER_MODEL           # 下发的模型名；留空 = 不发送 model 字段（服务端默认）
npx wrangler secret put PROVIDER_ENDPOINT_STYLE  # auto（默认）/ decisions / systemone
npx wrangler secret put PROVIDER_KEY             # 真正下游服务商的 api-key
```

未配置 `PROVIDER_KEY` 时这条路由返回 404（功能等同不存在）。可选门禁：再设
`PROVIDER_CONFIG_TOKEN` 后，插件必须带 `x-provider-token` 才拿得到配置（插件从环境变量
`DECISION_SERVER_CONFIG_TOKEN`，或 `.credentials.yaml` 的 `refs:` 同名键读取）。

> ⚠️ **这不是鉴权**：任何知道地址的人 GET 一次就能拿到 api-key。请只放**专用、低额度**的
> key；轮换靠改 Worker secret（客户端会在 TTL 内自动跟上，不需要发版）。

Off by default. When enabled (the config page's **Use the free model** switch, formerly
"follow the server-issued configuration"), the address, model and key are delivered by the
built-in endpoint and used directly. The key lives **only in the plugin process's memory** —
never written to `config.yml`, `.credentials.yaml`, telemetry, stats or decision logs, and no
route ever returns more than its last four characters. If the server is unreachable the plugin
silently falls back to your local configuration; switching the mode off clears the delivered
key immediately. Manual configuration is completely unchanged. Note this endpoint is **not
authentication**: anyone who knows the URL can fetch the key — use a dedicated low-quota key
and rotate it by updating the Worker secret. The switch carries a small **"may stop working"**
note underneath: the free quota is funded by the project itself and can be withdrawn or
re-keyed at any time, so keep your own key ready.

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

### 作用域边界：哪些决定不归本插件管 / Scope boundary

插件的定位是「便宜的判断层」，不是「替你拿主意」。有几类决定**天然不属于**它：

| 场景 | 能不能分清 | 插件怎么做 |
|---|---|---|
| **写入工作区之外** | **能**（确定性） | 放行并把决定权留给宿主沙箱与你（`guardDeferOutsideWorkspace`，默认开） |
| **模型给了几套方案让你挑** | **不能**（意图不可观测） | 交给模型判，但只用于**让位**：不替你选 |
| **模型有关键问题没问清** | **不能**（意图不可观测） | 同上 |

「能不能分清」的诚实答案是**分两种**：越界写入是纯路径计算（宿主的
`ctx.sandboxPolicy` 给出写根清单，目标路径是参数里的字面量），不需要模型；
而「这一轮是不是在等你」**只存在于模型的意图里**——宿主没有这个状态位
（`turn/end` 的 reason 是封闭集合，没有 `ask` 成员；`agent/turn-stopping`
的载荷里也没有 reason 字段）。

所以后者交给决策模型判断，但模型的判断**只有一个方向**：`这一轮在等用户 → 插件退出`。
它**不会**变成「所以我替你选了方案 A」或「所以我替你回答了这个问题」——
插件没有任何「代替用户决定」的路。这条线由测试守住
（`test/scope.test.js` 穷举输入组合，断言可返回的裁决词只有
`continue` / `stop` / `defer`）。

Two kinds here, not one: an out-of-workspace write is a pure path computation and is
decided deterministically; whether the assistant is waiting on you lives only in the
model's intent and cannot be observed from the host. Either way the plugin's answer is
the same — it steps aside. It never picks for you.

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
