# dsh-decision-engine

给 DeepSeek Harness 的 System-1 决策守卫：在每次工具调用前问模型四个问题
（风险、可逆性、任务相关性、注入嫌疑），据此放行、询问或拦截。默认 `shadow`：
只记录判断，绝不打断你干活。

**它支持所有 system-one 风格 API**：内置 `system one` 与
`bamboonode` 两个预设，也可以填任意 `custom` base URL（自建 llama.cpp / vLLM、
企业网关、第三方中转）。请求路径、鉴权方式与响应结构与 system-one 协议保持一致，
换 provider 不影响各决策点的解析逻辑。

> **本项目原名 `dsh-startlux-decision`**（更早叫 `dsh-startlux-guard`）。
> 0.4.0 起更名为 `dsh-decision-engine` 并加入 provider 抽象。
>
> **0.5.0 起配置文件名从 `startlux.yml` 改为 `config.yml`**——本插件已不是
> 只服务 startlux 一家，名字里再挂某个服务商只会误导。旧文件会被**自动改名
> 迁移**，升级不需要重新填 key；迁移失败时仍会回退读取旧文件名。

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin add dsh-decision-engine
```

或手动装进 profile：

```sh
cd ~/.dsh/profiles/desktop
pnpm add dsh-decision-engine
```

然后在 profile 的 `package.json` → `dsh.profile.bundles` 里加入
`"dsh-decision-engine"`，重启 DSH。

### 本地开发

```sh
git clone https://github.com/zuosus/dsh-decision-engine.git
cd dsh-decision-engine
# 复制到 profile 的 node_modules，或 pnpm link
```

仓库里带了迁移脚本，不用手改（默认只预览，`--write` 才写入并自动备份）：

```sh
node scripts/migrate-profile.mjs           # 预览
node scripts/migrate-profile.mjs --write   # 写入 + 备份 .bak
cd ~/.dsh/profiles/desktop && pnpm install
```

然后重启 DSH。**配置不用重填**：插件在启动时会做一次自动迁移，
把旧目录里的配置与遥测拷到新目录——

| | 路径 |
|---|---|
| 数据目录（迁移目标） | `~/.dsh/dsh-decision-engine/` |

迁移规则：

- **只搬一次**：新目录已有 `config.yml` 就不再动，绝不覆盖你后来改的值。
- **配置改名**：新目录里的旧名 `startlux.yml` 会被 `rename` 成 `config.yml`
  （rename 失败则拷贝）；跨目录迁移是**拷贝**，源文件保留，出问题可对照。
- **只搬两个文件**：配置文件与 `telemetry.jsonl`。目录里其它东西
  （笔记、备份）一概不碰。
- **权限 600**：配置里可能有明文 key，迁移后仍保持只有你可读。

### 数据目录解析规则（跨平台）

数据目录是 **`$DSH_HOME/dsh-decision-engine/`**，`~/.dsh` 只是 `DSH_HOME`
未设置时的默认值。解析顺序与宿主 `@deepseek-ai/dsh-home-paths` 完全一致：

| 优先级 | 来源 |
|---|---|
| 1 | 显式配置的路径（本插件暂无此入口） |
| 2 | 环境变量 `$DSH_HOME` |
| 3 | 操作系统家目录下的 `~/.dsh` |

细节（都由 `lib/home-paths.js` 统一处理）：

- **空白值等于未设置**：`DSH_HOME=""` 或纯空白会回退 `~/.dsh`，绝不会把数据
  目录解析到当前工作目录。
- **支持波浪号**：`DSH_HOME=~/myhome` 会展开；`~\`（Windows 形式）同样支持。
- **相对路径会被规范化成绝对路径**，否则落盘位置会随进程工作目录漂移。

**Windows 说明**：`~/.dsh` 里的 `.dsh` 只是**目录名**，不是路径分隔符——
Windows 允许点开头的目录。真正与平台相关的是分隔符与家目录位置，二者分别由
`node:path` 与 `node:os` 处理，所以 Windows 上实际路径是
`C:\Users\<你的用户名>\.dsh\dsh-decision-engine\config.yml`。

## 配置

### 插件配置页

**插件 → 已安装 → dsh-decision-engine → 点进该插件**，配置区（「包含的组件」
**上方**）会出现 Decision Engine 卡片，布局与内置 `dsh-rewind-plugin` 一致：

- **服务提供方**下拉：`system one` / `bamboonode` / `custom`，下面一行显示当前生效端点
- 两个开关：`启用守卫`、`真正拦截`
- **思考模式**下拉：`never` / `auto` / `always`（见下文「省 token 的手段」里的取舍）
- **模型**下拉（来自当前 provider 的 `/v1/models`，含「自动（服务端默认）」）
- 一个 **API Key 输入框**
- 选 `custom` 时展开四个字段：`Base URL`（必填）、`端点风格`、`附加请求头`、`密钥变量名`
- 一个 `测试端点` 按钮（回显 provider、实际 POST 的完整地址、HTTP 码、请求 id 与响应体）
- **决策模型参与点**列表：每个决策点一行，右侧是 `关闭 / 观察 / 生效` 三态
- 实时的缓存命中率与每个点的 token / 延迟统计

**改完即保存，没有「保存」按钮**：开关 / 下拉 / 分段控件点一下就落盘；文本框
（地址、请求头）停手约 0.7 秒或失焦后落盘；API Key 只在**失焦或回车**
时落盘（避免把打字途中的半截 key 写进凭据文件）。底部状态行实时显示
`待保存… / 保存中… / 已保存 / 未保存：原因`，失败时附「重试」。落盘即写入
`config.yml`，**不需要重启**：监听器常驻注册，provider 与模式在每次调用时现读；
缓存参数同样是取值函数而非启动期快照。

一个例外：选 `custom` 但 `Base URL` 还没填或不合法时，配置改动会**整体延后**
（状态行给出原因），地址补全后自动落盘；此时决策点改动不受影响，照常保存。

## Provider：接任意 system-one 风格服务

请求形状对所有 provider 完全一致（这也是 system-one 协议本身）：

```http
POST <base>/decisions        或   POST <base>/systemone
authorization: Bearer <key>
content-type: application/json

{ "model": "...", "state": {...}, "questions": {...}, "think_mode": "never" }
```

响应只需含 `answers`（`model` / `usage` 可选）。因此 provider 只决定三件事：
**往哪发、用谁的 key、默认哪个模型**。

### 五个选项

| provider | 默认地址 | 端点 | 密钥名 | 默认模型 |
|---|---|---|---|---|
| `system one` | `https://api.typesafe.ai/v1` | `/v1/systemone` | `TYPESAFE_API_KEY` | 服务端默认（`jev-latest`） |
| `bamboonode` | `https://api.bamboonode.dev/v1` | `/v1/decisions` | `BAMBOO_API_KEY` | 服务端默认（`startlux-decision-27b-autothink`） |
| `siliconflow`（硅基流动，国内站） | `https://api.siliconflow.cn/v1` | `/v1/systemone` | `SILICONFLOW_API_KEY` | `Kev-4B`（可改 `SemIf`） |
| `siliconflow-intl`（Silicon Flow，国际站） | `https://api.siliconflow.com/v1` | `/v1/systemone` | `SILICONFLOW_INTL_API_KEY` | `Kev-4B`（可改 `SemIf`） |
| `custom` | 用户填写（必填） | 按 `端点风格` 拼 | `customApiKeyEnv`（缺省 `DECISION_ENGINE_CUSTOM_KEY`） | `customModel` |

> 硅基流动两个站点的接入文档：
> [国内站 api-docs.siliconflow.cn](https://api-docs.siliconflow.cn/docs/api/systemone-post) ·
> [国际站 docs.siliconflow.com](https://docs.siliconflow.com/en/api-reference/systemone/create-systemone)

**开箱即用**：`siliconflow` / `siliconflow-intl` 只需要粘一个 API key——地址、
路径（`/systemone`）、默认模型（`Kev-4B`）都已预置。两个站点是**两套账号**，
key 互不通用，所以各占一格。

**每个 provider 有各自的 key 名，各自保存各自的 key。** 五者互不覆盖，
可以同时配好五套凭据；切换 provider 不会串用别人的 key。

不写 `provider` 时等于 `bamboonode`，**老配置行为完全不变**。

模型字段按 provider **分开存**，切换 provider 不会把 A 的模型名发给 B：

| provider | 配置键 | 默认 |
|---|---|---|
| `bamboonode` | `model` | 与历史一致（留空即服务端默认） |
| `system one` | `systemoneModel` | 留空 = 服务端默认（`jev-latest`） |
| `siliconflow` | `siliconflowModel` | 留空 = 预设默认 `Kev-4B` |
| `siliconflow-intl` | `siliconflowIntlModel` | 留空 = 预设默认 `Kev-4B` |
| `custom` | `customModel` | 留空 = 服务端默认 |

> ⚠️ 两个 SiliconFlow 端点把 `model` 列为**必填**（实测省略或空串都回
> `400 {"code":20013,"message":"Model field is required."}`），所以它们的
> 「留空」不是「让服务端挑」，而是用预设默认 `Kev-4B`；想换模型填 `SemIf`。
> 官方目前只支持这两个决策模型，界面上的模型下拉也只列这两个——
> `/v1/models` 会返回 98 个模型，但 chat 模型打到 `/systemone` 会
> `400 Model does not exist.`，列出来就是「选了就失败」。
>
> 模型名**大小写不敏感**：`kev-4b` / `Kev-4b` / `Kev-4B` 实测都 200，
> 配置里三种写法等价。

### custom：填写方式与限制

在设置界面选 `custom` 后需要填：

| 字段 | 必填 | 说明 |
|---|---|---|
| `Base URL` | **是** | 必须是 `http://` 或 `https://` 地址。不支持其它协议（`ftp:` 等会被拒绝），不带 scheme 也会被拒绝——自定义地址必须显式，避免猜错协议。不能含空格、换行或查询串。 |
| `端点风格` | 否 | `auto`（默认）/ `decisions` / `systemone`。这是**首选**路径，不是唯一路径：首选返回 404 时插件会自动改用另一条再试一次（见下）。 |
| `附加请求头` | 否 | 格式 `名称: 值`，多项用分号分隔，如 `X-Tenant: team-a; X-Trace: dsh`。`authorization` / `content-type` / `host` 由插件固定，写了也会被忽略。 |
| `密钥变量名` | 否 | 填了就从该环境变量或 `~/.dsh/.credentials.yaml` 的 `refs:` 段取 key；也可以直接在 API Key 输入框粘贴。 |
| `模型` | 否 | 留空 = 由服务端选默认；实测留空比发空串安全（发 `"model": ""` 会被 400）。 |

**地址拼接规则**（`末尾斜杠`一律先去掉，因此 `.../v1/` 与 `.../v1` 等价）：

| 你填的 base URL | 端点风格 | 实际 POST |
|---|---|---|
| `https://x.dev` | decisions | `https://x.dev/v1/decisions` |
| `https://x.dev/v1` | decisions | `https://x.dev/v1/decisions` |
| `https://x.dev/v1/decisions` | decisions | `https://x.dev/v1/decisions`（不重复） |
| `https://x.dev/api/v1` | decisions | `https://x.dev/api/v1/decisions` |
| `https://x.dev/v1` | systemone | `https://x.dev/v1/systemone` |
| `https://x.dev/v1/systemone` | decisions | `https://x.dev/v1/systemone`（已带端点即原样） |

拼接是幂等的：对结果再拼一次不会变成 `/v1/v1/decisions` 或 `//decisions`。

### 端点路径由服务商决定，不由模型决定

这是本插件最容易踩空的一处，因此**实测**过（2026-10-25，真实 key 打真实端点）：

| 服务商 | 模型 | `/v1/decisions` | `/v1/systemone` |
|---|---|---|---|
| SiliconFlow | `Kev-4B` | **404 Not Found** | **200 ✅** |
| bamboonode | `startlux-decision-27b-autothink` | 200 ✅ | 200 ✅ |

也就是说，`Kev-4B` 并不是「只能用 `/systemone` 的模型」——**路径由服务商决定**。
同一个 `Kev-4B` 换一个服务商，路径就得跟着换。

**因此 `端点风格` 只是「首选」**：

1. 先打首选路径；
2. 收到 **404**（= 路径不存在）时，自动改用另一条再试一次；
3. 试通的那条会被**记住**（按 base URL 区分），下次直接打它，不再多一次往返；
4. 两条都 404 时，遥测与「测试端点」会**列出试过的两个地址**并提示改端点风格。

只有 404 会触发换路径：400（模型/内容不合法）、401（key 不对）、5xx 都与路径无关，
换路径只是多烧一次请求。配置页的「生效端点」下方会显示「已验证可用：…」。

> 旧版本没有回退：路径踩空就是 404，而守卫是 fail-open 的——**静默失效**。
> 现场证据：`telemetry.jsonl` 里 2026-10-25 13:16–13:41 有 8 次 `http-404` 降级。

### 持久化与切换行为

- 所有 provider 的配置**并列**存在 `config.yml` 里，互不覆盖：
  `provider` 记录当前选择，`baseUrl`/`model` 属于内置预设（bamboonode 的
  `baseUrl` 保留老的覆盖语义），`customBaseUrl`/`customModel`/`customApiKey`/
  `customApiKeyEnv`/`customHeaders`/`customEndpointStyle` 属于 custom。
- 切换 provider 只改 `provider` 一个键：**其它 provider 已保存的地址、模型、密钥
  原样留着**，切回来即恢复。
- 保存后再次打开配置页按服务端返回的状态回显（不缓存、不推断），custom 的字段
  除密钥明文外全部回显。
- 密钥优先级：该 provider 的显式 key（`systemoneApiKey` / `bamboonodeApiKey` /
  `siliconflowApiKey` / `siliconflowIntlApiKey` / `customApiKey`）>
  密钥存储位置上对应的键 > 环境变量。
- 旧的单一 `apiKey` 字段只对 `bamboonode` 生效（历史兼容）。

### 密钥保存位置

密钥可以放在两个地方，默认 `credentials`：

| `keyStorage` | 写到哪里 | 适合 |
|---|---|---|
| `credentials`（默认） | `~/.dsh/.credentials.yaml` 的 `refs:` 段 | 与其他服务（DeepSeek / ModelScope …）统一托管，插件目录不留明文 |
| `config` | 插件配置目录下的 `config.yml` | 希望配置自包含、能随目录整体备份或迁移；注意是**明文** |

在设置界面「密钥保存位置」下拉切换，切换即按新位置写入；已有的 key 不会被
自动搬家（避免"看不到的地方被改动"），需要时重新粘贴一次即可。

写入 `credentials` 的行为约束：

- **只改 `refs:` 段**，`records:`（DSH 的授权记录，含嵌套结构）与注释逐字保留；
- 键名就是该 provider 自己的名字，所以五套 key 能同时存在、互不覆盖；
- 传空值等于**删除**该键（清空即撤销，不留空壳行）；
- 文件权限固定 `600`；
- 写入失败会整体报错，不会出现"配置说存了、实际没存"。

密钥优先级：显式 key 字段 > 所选存储位置里的对应键 > 环境变量。

### 错误与降级

| 情形 | 表现 |
|---|---|
| base URL 非法 / 为空（custom） | 该次落盘直接被拒（HTTP 400 + 具体原因，如「必须以 http:// 或 https:// 开头」），**不会写进 yml**；自动保存会一直挂着「未保存」并允许重试 |
| 密钥缺失 | 不发请求，`no-key` 降级（记录里带该 provider 的变量名） |
| 鉴权失败（401/403） | `auth-failed` 降级，提示检查该 provider 的 key 是否有效、是否与地址匹配 |
| 地址错（404/400） | `http-404` / `http-400` 降级，记录里带 `provider`、`endpoint` 与响应体 |
| provider 配置不可用 | `invalid-base-url` 降级，不打到猜出来的地址上 |
| 网络失败 / 超时 | `network-error` / `timeout` 降级，随后按阈值进入冷却 |

降级一律 fail-open：放行原行为，并写一条 `telemetry.jsonl`。
「测试端点」按钮会把完整诊断（provider、实际端点、HTTP 码、请求 id、响应体）直接显示出来。

## 决策点（参与哪些环节）

这个插件的定位不是「工具调用风险闸门」，而是**一个便宜的判断层**：用一次
约 1.9k token 的小模型调用，去替代或阻止更贵的 LLM 开销。因此判断必须克制——
**只在「替代更贵的调用」或「阻止更大的开销」处介入，绝不为了「多一道检查」而介入**。

八个决策点**全部已实装**，由你决定让决策模型进入哪些环节。

| # | 决策点 | 挂载位置 | 触发闸（为什么不是每次都问） | 生效方式 | 省 token 机制 |
|---|---|---|---|---|---|
| 1 | 工具授权 | `tools/pre-execute` | 只读工具 / auto 预设 / 排除名单直接放行 | `ask` / `deny` | 替代 auto-review 的满上下文审查 |
| 2 | 模型路由 | `agent/request` | 每轮仅前 N 步 + 路由未变不问 + 新用户输入不问 | 替换 `provider`/`model` | 机械步骤下沉到便宜模型 |
| 3 | 子任务分派 | `agent/pre-step` | 仅每轮第一步且带新用户输入 | 注入一条提示 | 少开一个 subagent = 省一整个上下文 |
| 4 | 上下文压缩 | `agent/pre-step` → `ctx.compaction` | 仅实测 token 达触发线 ×70% | 先跑确定性裁剪，让摘要被跳过 | 省掉一次摘要调用 |
| 5 | 轮次延续 | `agent/turn-stopping` | 同一轮最多续一次 | `agent.steer()` | 避免空转一整轮 |
| 6 | 检索必要性 | `tools/pre-execute` | 仅检索类工具；其余工具零开销 | `deny` | 省搜索与结果 token |
| 7 | 技能选择 | `tools/pre-execute` | 仅 `skill` 工具且候选 ≥2 | `deny` + 指路 | 省误加载的技能正文 |
| 8 | 思维链翻译门槛 | 包住 `translator.translate()` | 本地预筛 + 同文本缓存 | 跳过并返回原文 | 按条省翻译调用 |

### 三态的含义

| 模式 | 行为 |
|---|---|
| `关闭` | **连请求都不发**。省 token，也省那约 2 秒延迟 |
| `观察` | 照常判断并记录「本该怎样」，但不改变任何行为 |
| `生效` | 按判断执行该点的处置 |

新接入的决策点都应当先跑 `观察`，确认与人工判断一致后再切 `生效`。

### 阈值是实测校准的，不是拍脑袋的

每个决策点的阈值都用真实端点跑过对照样本（「该判 A」与「该判 B」成对输入），
只有两类输入真的分得开才留着。校准过程发现并修掉了三个问题，值得记下来：

1. **`choice` 的 `confidence` 是被选中项的概率**。三选项平分时天然只有 0.33，
   所以分派点的门槛不能设 0.6，否则永远判不出 `advise`。现在按「显著高于均分」
   取 0.5。
2. **question 的问法决定一切**。原来问「这个信息是否已知道」，两类输入给出
   0.30 / 0.12 —— 完全没有区分力。改问「recent 里是否**逐字覆盖**了这个事实，
   只依据那段文本回答」之后变成 0.92 / 0.01。
3. **判据顺序会改变结果**。轮次延续若先看 `closed`，「明确未完成」那组
   因为 `closed=0.28` 不达线就会掉进默认 `stop`——而它恰恰该续轮。
   现在先看 `unfinished`。

校准后的实测对照（`scripts/verify-endpoint.mjs` + 成对样本）：

| 决策点 | 输入 A | 判定 | 输入 B | 判定 |
|---|---|---|---|---|
| 模型路由 | 机械步骤 | `switch` | 新架构设计 | `keep` |
| 子任务分派 | 三个包并行补测试 | `advise` | 变量改名 | `inline` |
| 上下文压缩 | 结论已落地 | `prune` | 对话承载状态 | `summarize` |
| 轮次延续 | 任务已完成 | `stop` | 明确还有三步 | `continue` |
| 检索必要性 | 上下文已覆盖 | `skip` | 完全没提过 | `allow` |
| 思维链翻译 | 英文→中文 | `translate` | 中文→中文 | `skip` |

### 为什么不是「所有 hook 都开」

决策模型每次约 **1.9k token、p50 约 0.5 秒**。`agent/pre-step` 与 `agent/request`
都是**每步**触发，两个都开且不加闸，等于每步多等 1 秒以上。所以热路径上的
决策点（注册表里标了 `hotPath`，配置页显示「热路径」角标）都带明确的触发闸，
不能无条件调用。

护栏是**双层缓存**（见下节）：命中缓存就不发请求，把热路径上的重复调用挡掉。
本插件不设每小时的 token 预算——一次决策约 1.9k token，命中缓存后几乎为零，
不值得用「超限即停止判断」的方式省，那会让守卫在最需要它的时刻失效。

## 模型选择

配置页的「模型」是**下拉框**，由服务商实时提供，另有「自动（服务端默认）」选项。

**默认就是「自动」**（`config.yml` 里 `model:` 留空）：插件**不发送该字段**，
服务端用它当前的默认决策模型。实测省略 `model` 返回 200，响应里回填实际使用的模型名：

```json
{"answers":{...},"model":"startlux-decision-27b-autothink","usage":{...}}
```

这样即便服务商将来更换模型名，留空配置也不会因此 400。

> 注意：`config.yml` 里的 `model:` **必须写出来但留空**（`model:` 后面不跟值）。
> 解析器把显式空值保留为 `""`；若整行删掉，键会缺失并回落到内置的硬编码模型名，
> 「自动」就不生效了。

**列表为何要过滤**：bamboonode 的 `/v1/models` 返回全部 20 个模型，其中多数是
chat 模型，拿去打 `/v1/decisions` 会 400 `model ... is not served by this plugin`。
因此对 `bamboonode` 按 `supported_endpoint_types` 只保留声明了
`StartLux Decision` / `StartLux SystemOne` 的模型。实测 `typesafe/jev-1.14` 虽声明
`jev-decisions`，仍被该端点拒绝，因此也排除。

对 `system one` / `custom`：自建服务的 `/v1/models` 往往不带
`supported_endpoint_types`，继续按类型过滤会得到空列表（用户会以为服务没有可用
模型）。因此这两种 provider 改为「有类型就按类型过滤，没类型就全收」，下拉里也
仍可手填。

对 `siliconflow` / `siliconflow-intl`：它们的 `/v1/models` 返回 **98 个**模型、
**没有一条**带 `supported_endpoint_types`，而决策端点只认 `Kev-4B` / `SemIf`
（chat 模型打过去是 400 `Model does not exist.`）。类型过滤拿不到任何线索，
全收又等于「96 个选了就失败的选项」，因此按预设里的 `knownModels` 白名单筛，
下拉里只列这两个。

## 超时与自动回退

每次请求都带**硬超时**（默认 8000ms），超时不是错误，而是降级放行：

```
AbortSignal.timeout(timeoutMs) → 超时 → degrade("timeout") → 钩子 next() 放行
```

三层保护，保证守卫永远不会拖住工具执行：

1. **单次超时**：`timeoutMs`（默认 8000ms，可在配置页调整，最小 1000ms）。
   实测该端点 p50≈0.7s、冷启动 p95≈6.4s，8s 覆盖冷启动又不至于让用户干等。
2. **连续失败冷却**：连续 `failureThreshold`（默认 3）次失败后进入
   `cooldownMs`（默认 60s）冷却，冷却期内**直接放行、0ms 返回**，
   不再对着故障端点反复消耗。
3. **调用方取消**：若上层传入 `AbortSignal` 且被中止，立即降级返回
   `caller-aborted`。

实测（指向不可路由地址，`timeoutMs: 1500`）：

```
第1次: 1504ms → 降级      第4次: 0ms → 降级   ← 冷却生效
第2次: 1502ms → 降级      第5次: 0ms → 降级
第3次: 1502ms → 降级（触发冷却）
```

**没有配置 key 时根本不发请求**，直接 `no-key` 降级，零延迟。

## 失败降级（fail-open）

插件的设计原则是**任何不确定都退回原生行为**，绝不因为守卫自身故障而卡住工具调用。
以下情形全部 `next()` 放行，并在 `telemetry.jsonl` 记一条 `action=degraded`：

| 情形 | `detail` |
| --- | --- |
| 插件未启用（`enabled: false`） | 不进入判断，直接放行 |
| 没有 API key | `no-key` |
| 命中失败冷却 | `cooldown` |
| 端点 4xx / 5xx | `http-404` / `http-500` 等（附 `endpoint`、`body`） |
| 网络不可达 | `network-error` |
| 超时 | `timeout`（附 `timeoutMs`） |
| 返回非 JSON / 非对象 | `invalid-json` / `invalid-response` |
| 缺 `answers` 字段 | `missing-answers` |
| provider 配置不可用（如 custom 的 base URL 非法） | `invalid-base-url`（附 `provider` 与原因） |
| 鉴权被拒（401/403） | `auth-failed`（附 `provider`、`status`、该 provider 的密钥变量名） |
| 答案形状不符（类型错、缺字段、`choice` 非法、概率越界/NaN） | `answer-shape-mismatch` |
| 守卫内部抛异常 | 捕获后放行，仅 `logger.warn` |
| 只读工具 / auto 权限预设 / 被排除工具 | 不判断，直接放行 |

默认 `mode: shadow` 时，即使判断出 `deny` 也只记录不执行。

## 省 token 的设计

- **双层缓存**：
  - `精确`：完整 `state` + 问题集一致即复用。**这是唯一默认开启的层。**
  - `同类复用`：键是「工具名 + 命令族 + 风险标记」的归一化签名，刻意丢弃
    参数内容——命中即意味着**不同参数共享同一次裁决**。因此这一层
    **默认关闭（fail-closed）**，只有调用方显式声明 `softCacheable: true`
    才启用；工具授权（authorize）**永久禁用**：一次「低风险放行」若被
    归一化复用，会扩散到参数完全不同的同类调用上（评审意见 2026-10）。

    历史教训：曾以为「只缓存低风险放行 + 风险标记完全一致」就安全，
    但缓存层自己不判断风险——`rm -rf /tmp/x` 的合理放行会被
    `rm -rf /Users/chi/xx` 原样继承，两者风险标记完全一致。安全决策的
    缓存要么绑定完整调用上下文，要么不做。各决策点的裁决现在要么与
    完整 state 一一对应，要么不复用。
- **`thinkMode` 默认 `never`**：实测主要省**延迟**（约 1.9s vs 7.2s）；输入 token 基本不变
  （该端点 `output_tokens` 恒为 0，思考开销未计入计量）。三档可在配置页「思考模式」
  下拉切换，或手改 `config.yml`：

  | 值 | 行为 | 适用 |
  |---|---|---|
  | `never` | 不思考。默认值 | 热路径首选，不想拖慢每次工具调用 |
  | `auto` | 仅在模型自己判断需要时思考 | 折中 |
  | `always` | 总是思考 | 高风险场景、排查误判时临时使用；每次约多等 5s |

  非法值（如 `thinkMode: sometimes`）会被归一成 `never`，不会被原样发给服务端：
  配置来自自研 YAML 子集解析器，绕过了 Schemastery 校验，因此取值必须在这里兜。
- **只读工具直接放行**：`read`/`grep`/`glob`/`todo_write` 等不发请求。
- **state 截断**：`args` 走头尾摘要，`recent` 只带最近 4 条、每条 240 字符。
- **失败冷却**：连续 3 次失败进入 60s 冷却，避免对着故障端点烧钱。
- **双层缓存**：精确命中即不发请求；「同类复用」软层默认关闭、授权点永久禁用。
- **默认只观察**：新决策点先跑 `observe`，确认与人工判断一致后再切 `enforce`。

## 验证链路

### 自动化验收（三条，全部可重复跑）

```sh
pnpm test              # 209 项单元测试：纯函数 + 适配器接线 + providers + 配置往返 + 设置界面渲染 + 缓存回归
pnpm verify:wiring     # 接线检查：用真实 schemastery 加载插件
pnpm verify:endpoint   # 8 个决策点逐个打真实端点，校验题型与答案形状
pnpm verify            # 前两条一起跑
```

四个测试文件各管一层，互不依赖宿主：

| 文件 | 覆盖 |
|---|---|
| `test/spec.test.js` | 每个决策点的问法 / 解析 / 处置与阈值边界 |
| `test/engine.test.js` | 适配器接线、off/observe/enforce 语义、全部降级分支 |
| `test/providers.test.js` | provider 预设、地址拼接、URL 校验、鉴权与请求构造 |
| `test/config-file.test.js` | `config.yml` 读写往返：保存后再打开的回显、切换不互相覆盖 |
| `test/client-ui.test.js` | 设置界面渲染与交互：provider 下拉、custom 字段、错误提示、**改动即保存**（无保存按钮、改动自动 PUT /config、API Key 失焦提交） |

`test/providers.test.js` 是 provider 改造的验收用例（不依赖宿主依赖，
裸仓库可直接跑），覆盖六项硬约束：

1. 内置 `system one` 可用（默认地址 / `/v1/systemone` / 自己的密钥变量名）
2. 内置 `bamboonode` 行为不变（默认端点、老 `baseUrl` 覆盖、老模型名）
3. `custom` base URL 可用（含端点风格、请求头、密钥来源优先级）
4. 非法 URL 被拒绝（缺 scheme、非 http(s)、含空格、带查询串、空值）
5. 末尾斜杠与端点拼接正确、幂等，不出现 `/v1/v1` 或 `//decisions`
6. 请求构造不再硬编码 `bamboonode.dev`（含源码级断言：`lib/index.js` 与
   `lib/client.js` 里不得再出现该域名）

`verify:wiring` 需要 profile 的依赖可解析。仓库里没有 `node_modules` 时先建链接：

```sh
ln -s ~/.dsh/profiles/desktop/node_modules node_modules
```

它检查的是「宿主到底给不给这个服务」——包括缺 `translator` / `sessionTitle`
时 `apply()` 不抛、所有监听器都注册上、每个新点默认 `off`（升级不改变行为）。

`verify:endpoint` 要网络与对应 provider 的密钥（`bamboonode` 默认读 `BAMBOO_API_KEY`，
可用 `DECISION_ENGINE_BASE_URL` + `DECISION_ENGINE_API_KEY` 指向其它
system-one 服务），它逐点校验：
端点接受该点的问题集（`choice` 必须有 `criteria`、`score` 必须 2–10 档、
题型只认三种）、答案能被 `parse()` 解析、`decide()` 产出合法 `kind`。
**这一步不能省**：题型写错会在运行时 400 并静默降级，光看日志很难发现
「这个点其实一直没生效」。

### 手工验证

1. `「测试端点」按钮` → 看到 `HTTP 200` 和 `x-oneapi-request-id`，说明配置与网络都对；
   诊断文本第一行就是当前 provider，接着是实际 POST 的完整端点。
2. `插件配置页` → 确认 `服务提供方`、`生效端点`、`模型`、`密钥 已配置 ✅`；
   决策点列表里每个点都应有 `关闭 / 观察 / 生效` 三态（没有「即将支持」）。
   若某个点显示 `宿主缺服务`，说明宿主没有它依赖的服务（如 `translator`），
   该点无法开启——这不是 bug，是不适用的部署。
3. 把某个点切到 `观察`，触发一次对应动作 → 看
   `~/.dsh/dsh-decision-engine/telemetry.jsonl`（首次升级时旧目录的历史记录
   会被自动拷过来）：
   - `action=degraded, detail=no-key` → key 没读到
   - `detail=http-404` / `http-400` → 地址或模型不对（记录里带 `endpoint` 和 `body`）
   - `detail=answer-shape-mismatch` → 端点返回的答案形状不对（该点的问题集要复核）
   - `point=route, action=switch` → 该点判出了「本该下沉到便宜模型」
   - 每条的 `point` 字段标明是哪个决策点，`scores` 里是原始判断分数
4. 服务商后台 → 出现 `type=2 · Action decision` 记录。

## 阈值

### 工具授权

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `guardDenyConfidence` | 0.85 | 高风险 + 高置信 + 不可逆 → `deny` |
| `guardIrreversibleDenyFloor` | 0.5 | 判定不可逆的门槛 |
| `guardIrreversibleCeiling` | 0.2 | 低风险但不可逆 → 升级询问 |
| `guardConfidenceMin` | 0.6 | 中风险置信下限，低于则放行 |
| `guardInjectionAskThreshold` | 0.8 | 注入嫌疑 → 升级询问 |

### 其余八个决策点

全部阈值都在 `config.yml` 里可覆盖，默认值按实测校准（见上文「阈值是实测
校准的」）。下表列出「改动它会怎样」：

| 键 | 默认 | 调高会怎样 | 调低会怎样 |
| --- | --- | --- | --- |
| `routeCheapProvider` / `routeCheapModel` | 空 | 留空即不路由，点开着也只记录 | — |
| `routeMaxStepsPerTurn` | 3 | 每轮判断更多步，更准但更慢 | 更快但后续步骤沿用旧裁决 |
| `routeMaxScore` | 0.4 | 更少下沉（更保守） | 更多下沉（更省但可能降质） |
| `routeMechanicalFloor` | 0.6 | 更难判为机械（更保守） | 更易下沉 |
| `routeRiskFloor` | 0.3 | 风险稍高就保留强模型（更保守） | 更敢下沉 |
| `delegateConfidenceFloor` | 0.5 | 更少建议分派 | 更多建议分派 |
| `delegateBlockingFloor` | 0.6 | 更容易判「被阻塞」→ 更少分派 | 更敢分派 |
| `delegateParallelFloor` | 0.5 | 组队需要更强并行证据 | 更容易建议组队 |
| `compactContextWindow` | 0 | — | 设成实际窗口才能按比例提前介入 |
| `compactThresholdRatio` | 0.7 | 更晚介入（贴近 compaction 自己的 0.8） | 更早介入 |
| `compactDistilledFloor` | 0.6 | 更少裁剪（更保守） | 更多裁剪 |
| `compactVerbatinFloor` | 0.6 | 更少因「需要原文」而改走摘要 | 更保守（更容易摘要） |
| `turnStopMaxSteers` | 1 | 一轮可续多次（注意空转风险） | 0 = 永不续轮 |
| `turnStopUnfinishedFloor` | 0.6 | 更少续轮 | 更易续轮 |
| `turnStopValueFloor` | 0.35 | 更少续轮 | 更易续轮 |
| `retrievalCoveredFloor` | 0.5 | 更少跳过检索（更安全） | 更敢跳过 |
| `retrievalWouldAddCeiling` | 0.8 | 更敢跳过（更省） | 更少跳过 |
| `skillPickConfidenceFloor` | 0.5 | 更少改指路 | 更敢改指路 |
| `cotProseFloor` | 0.5 | 更少翻译（更省） | 更敢翻译 |
| `cotSameLanguageFloor` | 0.8 | 更少判「已是目标语言」→ 更多翻译 | 更敢跳过 |

## License

MIT
