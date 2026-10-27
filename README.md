# dsh-decision-engine

给 DeepSeek Harness 的 System-1 决策守卫：在每次工具调用前问模型四个问题
（风险、可逆性、任务相关性、注入嫌疑），据此放行、询问或拦截。默认 `shadow`：
只记录判断，绝不打断你干活。

A System-1 decision guard for DeepSeek Harness: before every tool call it asks the
model four questions (risk, reversibility, task relevance, injection suspicion)
and allows, asks, or blocks accordingly. Defaults to `shadow`: judgments are only
recorded and never interrupt your work.

**它支持所有 system-one 风格 API**：内置 `system one` 与
`bamboonode` 两个预设，也可以填任意 `custom` base URL（自建 llama.cpp / vLLM、
企业网关、第三方中转）。请求路径、鉴权方式与响应结构与 system-one 协议保持一致，
换 provider 不影响各决策点的解析逻辑。

**It works with any system-one style API**: built-in presets for `system one` and
`bamboonode`, or any `custom` base URL (self-hosted llama.cpp / vLLM, corporate
gateways, third-party relays). Request path, auth and response shape follow the
system-one protocol, so switching providers never changes how answers are parsed
at any decision point.

> **本项目原名 `dsh-startlux-decision`**（更早叫 `dsh-startlux-guard`）。
> 0.4.0 起更名为 `dsh-decision-engine` 并加入 provider 抽象。
>
> **0.5.0 起配置文件名从 `startlux.yml` 改为 `config.yml`**——本插件已不是
> 只服务 startlux 一家，名字里再挂某个服务商只会误导。旧文件会被**自动改名
> 迁移**，升级不需要重新填 key；迁移失败时仍会回退读取旧文件名。

> **This project was formerly named `dsh-startlux-decision`** (before that,
> `dsh-startlux-guard`). Since 0.4.0 it is `dsh-decision-engine`, with a provider
> abstraction added.
>
> **Since 0.5.0 the config file is `config.yml`, renamed from `startlux.yml`** —
> the plugin no longer serves a single vendor, and keeping one provider's name in
> the file would only mislead. Old files are **automatically renamed in place**;
> upgrading does not require re-entering keys, and if the rename fails the old
> filename is still read as a fallback.

## 安装 / Install

### 从 npm 安装（推荐）/ Install from npm (recommended)

```sh
dsh plugin add dsh-decision-engine
```

或手动装进 profile：

Or add it to a profile manually:

```sh
cd ~/.dsh/profiles/desktop
pnpm add dsh-decision-engine
```

然后在 profile 的 `package.json` → `dsh.profile.bundles` 里加入
`"dsh-decision-engine"`，重启 DSH。

Then add `"dsh-decision-engine"` to `package.json` → `dsh.profile.bundles` of the
profile and restart DSH.

### 本地开发 / Local development

```sh
git clone https://github.com/zuosus/dsh-decision-engine.git
cd dsh-decision-engine
# 复制到 profile 的 node_modules，或 pnpm link
# copy into the profile's node_modules, or use pnpm link
```

仓库里带了迁移脚本，不用手改（默认只预览，`--write` 才写入并自动备份）：

The repo ships a migration script, so nothing has to be edited by hand
(preview-only by default; `--write` applies the change and keeps a backup):

```sh
node scripts/migrate-profile.mjs           # 预览 / preview
node scripts/migrate-profile.mjs --write   # 写入 + 备份 .bak / apply + .bak backup
cd ~/.dsh/profiles/desktop && pnpm install
```

然后重启 DSH。**配置不用重填**：插件在启动时会做一次自动迁移，
把旧目录里的配置与遥测拷到新目录——

Then restart DSH. **No re-configuration is needed**: on startup the plugin runs a
one-time automatic migration, copying config and telemetry from old directories
to the new one —

| | 路径 |
|---|---|
| 数据目录（迁移目标） | `~/.dsh/dsh-decision-engine/` |

| | Path |
|---|---|
| Data directory (migration target) | `~/.dsh/dsh-decision-engine/` |

迁移规则：

Migration rules:

- **只搬一次**：新目录已有 `config.yml` 就不再动，绝不覆盖你后来改的值。
- **配置改名**：新目录里的旧名 `startlux.yml` 会被 `rename` 成 `config.yml`
  （rename 失败则拷贝）；跨目录迁移是**拷贝**，源文件保留，出问题可对照。
- **只搬两个文件**：配置文件与 `telemetry.jsonl`。目录里其它东西
  （笔记、备份）一概不碰。
- **权限 600**：配置里可能有明文 key，迁移后仍保持只有你可读。

- **Migrated only once**: if a `config.yml` already exists in the new directory,
  nothing is touched — values you edited later are never overwritten.
- **Config rename**: an old `startlux.yml` inside the new directory is `rename`d
  to `config.yml` (copied if rename fails); cross-directory migration **copies**,
  so the source file is kept for comparison if anything goes wrong.
- **Only two files move**: the config file and `telemetry.jsonl`. Everything else
  in the directory (notes, backups) is left alone.
- **Permission 600**: the config may contain a plaintext key, so after migration
  it stays readable only by you.

### 数据目录解析规则（跨平台）/ Data directory resolution (cross-platform)

数据目录是 **`$DSH_HOME/dsh-decision-engine/`**，`~/.dsh` 只是 `DSH_HOME`
未设置时的默认值。解析顺序与宿主 `@deepseek-ai/dsh-home-paths` 完全一致：

The data directory is **`$DSH_HOME/dsh-decision-engine/`**; `~/.dsh` is only the
default when `DSH_HOME` is unset. The resolution order matches the host's
`@deepseek-ai/dsh-home-paths` exactly:

| 优先级 | 来源 |
|---|---|
| 1 | 显式配置的路径（本插件暂无此入口） |
| 2 | 环境变量 `$DSH_HOME` |
| 3 | 操作系统家目录下的 `~/.dsh` |

| Priority | Source |
|---|---|
| 1 | Explicitly configured path (this plugin has no such entry point yet) |
| 2 | Environment variable `$DSH_HOME` |
| 3 | `~/.dsh` under the OS home directory |

细节（都由 `lib/home-paths.js` 统一处理）：

Details (all handled in one place by `lib/home-paths.js`):

- **空白值等于未设置**：`DSH_HOME=""` 或纯空白会回退 `~/.dsh`，绝不会把数据
  目录解析到当前工作目录。
- **支持波浪号**：`DSH_HOME=~/myhome` 会展开；`~\`（Windows 形式）同样支持。
- **相对路径会被规范化成绝对路径**，否则落盘位置会随进程工作目录漂移。

- **Blank counts as unset**: `DSH_HOME=""` or whitespace-only falls back to
  `~/.dsh`; the data directory can never resolve into the current working
  directory.
- **Tilde is supported**: `DSH_HOME=~/myhome` expands, and the `~\` (Windows)
  form too.
- **Relative paths are normalized to absolute**, otherwise the on-disk location
  would drift with the process's working directory.

**Windows 说明**：`~/.dsh` 里的 `.dsh` 只是**目录名**，不是路径分隔符——
Windows 允许点开头的目录。真正与平台相关的是分隔符与家目录位置，二者分别由
`node:path` 与 `node:os` 处理，所以 Windows 上实际路径是
`C:\Users\<你的用户名>\.dsh\dsh-decision-engine\config.yml`。

**Note for Windows**: the `.dsh` in `~/.dsh` is just a **directory name**, not a
path separator — Windows allows directories that begin with a dot. What actually
differs by platform are the separator and the home-directory location, handled by
`node:path` and `node:os` respectively, so the real path on Windows is
`C:\Users\<your-name>\.dsh\dsh-decision-engine\config.yml`.

## 配置 / Configuration

### 插件配置页 / The plugin config page

**插件 → 已安装 → dsh-decision-engine → 点进该插件**，配置区（「包含的组件」
**上方**）会出现 Decision Engine 卡片，布局与内置 `dsh-rewind-plugin` 一致：

Go to **Plugins → Installed → dsh-decision-engine → open the plugin**; above the
"included components" area a Decision Engine card appears, laid out like the
built-in `dsh-rewind-plugin`:

- **服务提供方**下拉：`system one` / `bamboonode` / `custom`，下面一行显示当前生效端点
- 两个开关：`启用守卫`、`真正拦截`
- **思考模式**下拉：`never` / `auto` / `always`（见下文「省 token 的手段」里的取舍）
- **模型**下拉（来自当前 provider 的 `/v1/models`，含「自动（服务端默认）」）
- 一个 **API Key 输入框**
- 选 `custom` 时展开四个字段：`Base URL`（必填）、`端点风格`、`附加请求头`、`密钥变量名`
- 一个 `测试端点` 按钮（回显 provider、实际 POST 的完整地址、HTTP 码、请求 id 与响应体）
- **决策模型参与点**列表：每个决策点一行，右侧是 `关闭 / 观察 / 生效` 三态
- 实时的缓存命中率与每个点的 token / 延迟统计

- **Provider** dropdown: `system one` / `bamboonode` / `custom`, with the
  currently effective endpoint shown on the line below
- Two switches: `Enable guard`, `Actually block`
- **Thinking mode** dropdown: `never` / `auto` / `always` (see the trade-off in
  "Token-saving design" below)
- **Model** dropdown (served live from the current provider's `/v1/models`,
  plus "auto (server default)")
- An **API key input**
- Choosing `custom` expands four fields: `Base URL` (required), `Endpoint style`,
  `Extra headers`, `Key variable name`
- A `Test endpoint` button (echoes the provider, the exact full POST URL, HTTP
  code, request id and response body)
- **Decision point** list: one row per point, each with an
  `off / observe / enforce` tri-state on the right
- Live cache-hit rate and per-point token / latency stats

**改完即保存，没有「保存」按钮**：开关 / 下拉 / 分段控件点一下就落盘；文本框
（地址、请求头）停手约 0.7 秒或失焦后落盘；API Key 只在**失焦或回车**
时落盘（避免把打字途中的半截 key 写进凭据文件）。底部状态行实时显示
`待保存… / 保存中… / 已保存 / 未保存：原因`，失败时附「重试」。落盘即写入
`config.yml`，**不需要重启**：监听器常驻注册，provider 与模式在每次调用时现读；
缓存参数同样是取值函数而非启动期快照。

**Edits save immediately — there is no Save button**: switches / dropdowns /
segmented controls persist on click; text fields (URL, headers) persist ~0.7s
after you stop typing or on blur; the API key persists only **on blur or Enter**
(so a half-typed key never lands in the credentials file). The status line at the
bottom shows `pending… / saving… / saved / unsaved: reason` live, with a `retry`
action on failure. Persisting writes `config.yml` and **needs no restart**:
listeners are registered permanently, provider and mode are read fresh on every
call, and cache parameters are getters too rather than startup snapshots.

一个例外：选 `custom` 但 `Base URL` 还没填或不合法时，配置改动会**整体延后**
（状态行给出原因），地址补全后自动落盘；此时决策点改动不受影响，照常保存。

One exception: while `custom` is selected but `Base URL` is empty or invalid,
config changes are **deferred as a whole** (the status line says why) and persist
automatically once the address is complete; decision-point changes are unaffected
and keep saving normally.

## Provider：接任意 system-one 风格服务 / Any system-one style service

请求形状对所有 provider 完全一致（这也是 system-one 协议本身）：

The request shape is identical across all providers (this is the system-one
protocol itself):

```http
POST <base>/decisions        或 / or   POST <base>/systemone
authorization: Bearer <key>
content-type: application/json

{ "model": "...", "state": {...}, "questions": {...}, "think_mode": "never" }
```

响应只需含 `answers`（`model` / `usage` 可选）。因此 provider 只决定三件事：
**往哪发、用谁的 key、默认哪个模型**。

A response only needs `answers` (`model` / `usage` optional). So a provider
decides exactly three things: **where to send, whose key to use, which model by
default**.

### 五个选项 / Five options

| provider | 默认地址 | 端点 | 密钥名 | 默认模型 |
|---|---|---|---|---|
| `system one` | `https://api.typesafe.ai/v1` | `/v1/systemone` | `TYPESAFE_API_KEY` | 服务端默认（`jev-latest`） |
| `bamboonode` | `https://api.bamboonode.dev/v1` | `/v1/decisions` | `BAMBOO_API_KEY` | 服务端默认（`startlux-decision-27b-autothink`） |
| `siliconflow`（硅基流动，国内站） | `https://api.siliconflow.cn/v1` | `/v1/systemone` | `SILICONFLOW_API_KEY` | `Kev-4B`（可改 `SemIf`） |
| `siliconflow-intl`（Silicon Flow，国际站） | `https://api.siliconflow.com/v1` | `/v1/systemone` | `SILICONFLOW_INTL_API_KEY` | `Kev-4B`（可改 `SemIf`） |
| `custom` | 用户填写（必填） | 按 `端点风格` 拼 | `customApiKeyEnv`（缺省 `DECISION_ENGINE_CUSTOM_KEY`） | `customModel` |

| provider | Default base URL | Endpoint | Key variable | Default model |
|---|---|---|---|---|
| `system one` | `https://api.typesafe.ai/v1` | `/v1/systemone` | `TYPESAFE_API_KEY` | server default (`jev-latest`) |
| `bamboonode` | `https://api.bamboonode.dev/v1` | `/v1/decisions` | `BAMBOO_API_KEY` | server default (`startlux-decision-27b-autothink`) |
| `siliconflow` (CN site) | `https://api.siliconflow.cn/v1` | `/v1/systemone` | `SILICONFLOW_API_KEY` | `Kev-4B` (switch to `SemIf` if desired) |
| `siliconflow-intl` (intl site) | `https://api.siliconflow.com/v1` | `/v1/systemone` | `SILICONFLOW_INTL_API_KEY` | `Kev-4B` (switch to `SemIf` if desired) |
| `custom` | user-provided (required) | assembled per `endpoint style` | `customApiKeyEnv` (defaults to `DECISION_ENGINE_CUSTOM_KEY`) | `customModel` |

> 硅基流动两个站点的接入文档：
> [国内站 api-docs.siliconflow.cn](https://api-docs.siliconflow.cn/docs/api/systemone-post) ·
> [国际站 docs.siliconflow.com](https://docs.siliconflow.com/en/api-reference/systemone/create-systemone)

> SiliconFlow integration docs for both sites:
> [CN site api-docs.siliconflow.cn](https://api-docs.siliconflow.cn/docs/api/systemone-post) ·
> [intl site docs.siliconflow.com](https://docs.siliconflow.com/en/api-reference/systemone/create-systemone)

**开箱即用**：`siliconflow` / `siliconflow-intl` 只需要粘一个 API key——地址、
路径（`/systemone`）、默认模型（`Kev-4B`）都已预置。两个站点是**两套账号**，
key 互不通用，所以各占一格。

**Ready to use**: `siliconflow` / `siliconflow-intl` need nothing but one pasted
API key — the base URL, path (`/systemone`) and default model (`Kev-4B`) are all
preconfigured. The two sites are **separate accounts** with non-interchangeable
keys, which is why they get their own slots.

**每个 provider 有各自的 key 名，各自保存各自的 key。** 五者互不覆盖，
可以同时配好五套凭据；切换 provider 不会串用别人的 key。

**Each provider has its own key variable and keeps its own key.** None of the
five overwrite one another; you can configure all five credential sets at once,
and switching providers never leaks one provider's key to another.

不写 `provider` 时等于 `bamboonode`，**老配置行为完全不变**。

Omitting `provider` means `bamboonode` — **old configs behave exactly as before**.

模型字段按 provider **分开存**，切换 provider 不会把 A 的模型名发给 B：

Model fields are stored **separately per provider**, so switching providers never
sends provider A's model name to provider B:

| provider | 配置键 | 默认 |
|---|---|---|
| `bamboonode` | `model` | 与历史一致（留空即服务端默认） |
| `system one` | `systemoneModel` | 留空 = 服务端默认（`jev-latest`） |
| `siliconflow` | `siliconflowModel` | 留空 = 预设默认 `Kev-4B` |
| `siliconflow-intl` | `siliconflowIntlModel` | 留空 = 预设默认 `Kev-4B` |
| `custom` | `customModel` | 留空 = 服务端默认 |

| provider | Config key | Default |
|---|---|---|
| `bamboonode` | `model` | unchanged from history (blank = server default) |
| `system one` | `systemoneModel` | blank = server default (`jev-latest`) |
| `siliconflow` | `siliconflowModel` | blank = preset default `Kev-4B` |
| `siliconflow-intl` | `siliconflowIntlModel` | blank = preset default `Kev-4B` |
| `custom` | `customModel` | blank = server default |

> ⚠️ 两个 SiliconFlow 端点把 `model` 列为**必填**（实测省略或空串都回
> `400 {"code":20013,"message":"Model field is required."}`），所以它们的
> 「留空」不是「让服务端挑」，而是用预设默认 `Kev-4B`；想换模型填 `SemIf`。
> 官方目前只支持这两个决策模型，界面上的模型下拉也只列这两个——
> `/v1/models` 会返回 98 个模型，但 chat 模型打到 `/systemone` 会
> `400 Model does not exist.`，列出来就是「选了就失败」。
>
> 模型名**大小写不敏感**：`kev-4b` / `Kev-4b` / `Kev-4B` 实测都 200，
> 配置里三种写法等价。

> ⚠️ Both SiliconFlow endpoints list `model` as **required** (measured: omitting
> it or sending an empty string both return
> `400 {"code":20013,"message":"Model field is required."}`), so "blank" there
> does not mean "let the server pick" — it falls back to the preset default
> `Kev-4B`; put `SemIf` in to switch. The platform currently serves only these
> two decision models, and the model dropdown lists only these two as well —
> `/v1/models` returns 98 models, but a chat model sent to `/systemone` gets
> `400 Model does not exist.`, so listing them would only offer "options that
> fail when picked".
>
> Model names are **case-insensitive**: `kev-4b` / `Kev-4b` / `Kev-4B` all
> measured 200 — the three spellings are equivalent in config.

### custom：填写方式与限制 / custom: fields and limits

在设置界面选 `custom` 后需要填：

After selecting `custom` in the settings UI, you fill in:

| 字段 | 必填 | 说明 |
|---|---|---|
| `Base URL` | **是** | 必须是 `http://` 或 `https://` 地址。不支持其它协议（`ftp:` 等会被拒绝），不带 scheme 也会被拒绝——自定义地址必须显式，避免猜错协议。不能含空格、换行或查询串。 |
| `端点风格` | 否 | `auto`（默认）/ `decisions` / `systemone`。这是**首选**路径，不是唯一路径：首选返回 404 时插件会自动改用另一条再试一次（见下）。 |
| `附加请求头` | 否 | 格式 `名称: 值`，多项用分号分隔，如 `X-Tenant: team-a; X-Trace: dsh`。`authorization` / `content-type` / `host` 由插件固定，写了也会被忽略。 |
| `密钥变量名` | 否 | 填了就从该环境变量或 `~/.dsh/.credentials.yaml` 的 `refs:` 段取 key；也可以直接在 API Key 输入框粘贴。 |
| `模型` | 否 | 留空 = 由服务端选默认；实测留空比发空串安全（发 `"model": ""` 会被 400）。 |

| Field | Required | Description |
|---|---|---|
| `Base URL` | **yes** | Must be an `http://` or `https://` URL. Other schemes are rejected (`ftp:` etc.), and a URL without a scheme is rejected too — a custom address must be explicit so the protocol is never guessed. No spaces, newlines, or query strings. |
| `Endpoint style` | no | `auto` (default) / `decisions` / `systemone`. This is the **preferred** path, not the only one: if the preferred path returns 404, the plugin automatically retries once on the other path (see below). |
| `Extra headers` | no | Format `name: value`, semicolon-separated, e.g. `X-Tenant: team-a; X-Trace: dsh`. `authorization` / `content-type` / `host` are fixed by the plugin; supplying them is silently ignored. |
| `Key variable name` | no | When set, the key is read from that environment variable or the `refs:` section of `~/.dsh/.credentials.yaml`; you can also paste it straight into the API key input. |
| `Model` | no | Blank = server default. Measured: blank is safer than an empty string (sending `"model": ""` gets a 400). |

**地址拼接规则**（`末尾斜杠`一律先去掉，因此 `.../v1/` 与 `.../v1` 等价）：

**URL assembly rules** (a trailing `/` is always stripped first, so `.../v1/`
and `.../v1` are equivalent):

| 你填的 base URL | 端点风格 | 实际 POST |
|---|---|---|
| `https://x.dev` | decisions | `https://x.dev/v1/decisions` |
| `https://x.dev/v1` | decisions | `https://x.dev/v1/decisions` |
| `https://x.dev/v1/decisions` | decisions | `https://x.dev/v1/decisions`（不重复） |
| `https://x.dev/api/v1` | decisions | `https://x.dev/api/v1/decisions` |
| `https://x.dev/v1` | systemone | `https://x.dev/v1/systemone` |
| `https://x.dev/v1/systemone` | decisions | `https://x.dev/v1/systemone`（已带端点即原样） |

| Base URL you enter | Endpoint style | Actual POST |
|---|---|---|
| `https://x.dev` | decisions | `https://x.dev/v1/decisions` |
| `https://x.dev/v1` | decisions | `https://x.dev/v1/decisions` |
| `https://x.dev/v1/decisions` | decisions | `https://x.dev/v1/decisions` (no duplication) |
| `https://x.dev/api/v1` | decisions | `https://x.dev/api/v1/decisions` |
| `https://x.dev/v1` | systemone | `https://x.dev/v1/systemone` |
| `https://x.dev/v1/systemone` | decisions | `https://x.dev/v1/systemone` (kept as-is once it already names an endpoint) |

拼接是幂等的：对结果再拼一次不会变成 `/v1/v1/decisions` 或 `//decisions`。

Assembly is idempotent: assembling once more onto the result never produces
`/v1/v1/decisions` or `//decisions`.

### 端点路径由服务商决定，不由模型决定 / The endpoint path belongs to the provider, not the model

这是本插件最容易踩空的一处，因此**实测**过（2026-10-25，真实 key 打真实端点）：

This is the plugin's most trip-prone detail, so it was **verified against real
endpoints with real keys** (2026-10-25):

| 服务商 | 模型 | `/v1/decisions` | `/v1/systemone` |
|---|---|---|---|
| SiliconFlow | `Kev-4B` | **404 Not Found** | **200 ✅** |
| bamboonode | `startlux-decision-27b-autothink` | 200 ✅ | 200 ✅ |

| Provider | Model | `/v1/decisions` | `/v1/systemone` |
|---|---|---|---|
| SiliconFlow | `Kev-4B` | **404 Not Found** | **200 ✅** |
| bamboonode | `startlux-decision-27b-autothink` | 200 ✅ | 200 ✅ |

也就是说，`Kev-4B` 并不是「只能用 `/systemone` 的模型」——**路径由服务商决定**。
同一个 `Kev-4B` 换一个服务商，路径就得跟着换。

In other words, `Kev-4B` is not "a model that only speaks `/systemone`" —
**the path belongs to the provider**. The same `Kev-4B` on a different provider
needs a different path.

**因此 `端点风格` 只是「首选」**：

**Which is why `endpoint style` is only the *preference*:**

1. 先打首选路径；
2. 收到 **404**（= 路径不存在）时，自动改用另一条再试一次；
3. 试通的那条会被**记住**（按 base URL 区分），下次直接打它，不再多一次往返；
4. 两条都 404 时，遥测与「测试端点」会**列出试过的两个地址**并提示改端点风格。

1. Send to the preferred path first;
2. On **404** (= the path does not exist), automatically retry once on the other path;
3. The path that works is **remembered** (keyed by base URL), so the next call
   goes straight to it without an extra round-trip;
4. If both paths 404, telemetry and the "Test endpoint" button **list both
   addresses that were tried** and suggest changing the endpoint style.

只有 404 会触发换路径：400（模型/内容不合法）、401（key 不对）、5xx 都与路径无关，
换路径只是多烧一次请求。配置页的「生效端点」下方会显示「已验证可用：…」。

Only 404 triggers the path switch: 400 (invalid model/content), 401 (wrong key)
and 5xx all have nothing to do with the path — switching would just burn another
request. Below "effective endpoint" the config page shows "verified working: …".

> 旧版本没有回退：路径踩空就是 404，而守卫是 fail-open 的——**静默失效**。
> 现场证据：`telemetry.jsonl` 里 2026-10-25 13:16–13:41 有 8 次 `http-404` 降级。

> Older versions had no fallback: a wrong path just 404s, and the guard is
> fail-open — it **fails silently**. Smoking gun: `telemetry.jsonl` recorded 8
> `http-404` degradations between 13:16 and 13:41 on 2026-10-25.

### 持久化与切换行为 / Persistence and switching behavior

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

- All providers' settings live **side by side** in `config.yml` and never
  overwrite one another: `provider` records the current choice, `baseUrl`/`model`
  belong to the built-in presets (bamboonode's `baseUrl` keeps its legacy
  override semantics), and `customBaseUrl`/`customModel`/`customApiKey`/
  `customApiKeyEnv`/`customHeaders`/`customEndpointStyle` belong to custom.
- Switching providers changes exactly one key, `provider`: **the other
  providers' saved URLs, models and keys stay untouched** and come right back
  when you switch over again.
- Reopening the config page after saving reflects the server's returned state
  verbatim (no caching, no guessing); all custom fields are echoed back except
  the key's plaintext.
- Key precedence: the provider's explicit key (`systemoneApiKey` /
  `bamboonodeApiKey` / `siliconflowApiKey` / `siliconflowIntlApiKey` /
  `customApiKey`) > the matching key at the chosen storage location >
  environment variables.
- The legacy single `apiKey` field applies only to `bamboonode` (backwards
  compatibility).

### 密钥保存位置 / Where keys are stored

密钥可以放在两个地方，默认 `credentials`：

Keys can live in two places; the default is `credentials`:

| `keyStorage` | 写到哪里 | 适合 |
|---|---|---|
| `credentials`（默认） | `~/.dsh/.credentials.yaml` 的 `refs:` 段 | 与其他服务（DeepSeek / ModelScope …）统一托管，插件目录不留明文 |
| `config` | 插件配置目录下的 `config.yml` | 希望配置自包含、能随目录整体备份或迁移；注意是**明文** |

| `keyStorage` | Written to | Good for |
|---|---|---|
| `credentials` (default) | the `refs:` section of `~/.dsh/.credentials.yaml` | managed alongside other services (DeepSeek / ModelScope …); no plaintext in the plugin directory |
| `config` | `config.yml` in the plugin's config directory | a self-contained config you can back up or move as one directory — note it is **plaintext** |

在设置界面「密钥保存位置」下拉切换，切换即按新位置写入；已有的 key 不会被
自动搬家（避免"看不到的地方被改动"），需要时重新粘贴一次即可。

The "key storage location" dropdown in the UI switches where keys are written,
effective immediately; existing keys are never silently relocated (nothing
changes behind your back) — just paste once more if you need to move one.

写入 `credentials` 的行为约束：

Constraints when writing to `credentials`:

- **只改 `refs:` 段**，`records:`（DSH 的授权记录，含嵌套结构）与注释逐字保留；
- 键名就是该 provider 自己的名字，所以五套 key 能同时存在、互不覆盖；
- 传空值等于**删除**该键（清空即撤销，不留空壳行）；
- 文件权限固定 `600`；
- 写入失败会整体报错，不会出现"配置说存了、实际没存"。

- **Only the `refs:` section is touched**; `records:` (DSH's own authorization
  records, nested included) and comments are preserved verbatim;
- the key name is that provider's own name, so all five key sets coexist without
  overwriting each other;
- passing an empty value **deletes** the key (clearing means revoking — no empty
  shell line is left behind);
- the file permission is pinned to `600`;
- a failed write raises as a whole — the config can never claim a key was saved
  when it wasn't.

密钥优先级：显式 key 字段 > 所选存储位置里的对应键 > 环境变量。

Key precedence: explicit key field > the matching key at the chosen storage
location > environment variables.

### 错误与降级 / Errors and degradation

| 情形 | 表现 |
|---|---|
| base URL 非法 / 为空（custom） | 该次落盘直接被拒（HTTP 400 + 具体原因，如「必须以 http:// 或 https:// 开头」），**不会写进 yml**；自动保存会一直挂着「未保存」并允许重试 |
| 密钥缺失 | 不发请求，`no-key` 降级（记录里带该 provider 的变量名） |
| 鉴权失败（401/403） | `auth-failed` 降级，提示检查该 provider 的 key 是否有效、是否与地址匹配 |
| 地址错（404/400） | `http-404` / `http-400` 降级，记录里带 `provider`、`endpoint` 与响应体 |
| provider 配置不可用 | `invalid-base-url` 降级，不打到猜出来的地址上 |
| 网络失败 / 超时 | `network-error` / `timeout` 降级，随后按阈值进入冷却 |

| Situation | Behavior |
|---|---|
| Invalid or empty base URL (custom) | That save attempt is rejected outright (HTTP 400 plus the concrete reason, e.g. "must start with http:// or https://") and **never written into the yml**; auto-save keeps showing "unsaved" and allows a retry |
| Key missing | No request is sent; `no-key` degradation (the record carries that provider's variable name) |
| Auth failure (401/403) | `auth-failed` degradation, telling you to check whether that provider's key is valid and matches the URL |
| Wrong address (404/400) | `http-404` / `http-400` degradation; the record carries `provider`, `endpoint` and the response body |
| Provider config unusable | `invalid-base-url` degradation; nothing is sent to a guessed address |
| Network failure / timeout | `network-error` / `timeout` degradation, then cooldown per the thresholds |

降级一律 fail-open：放行原行为，并写一条 `telemetry.jsonl`。
「测试端点」按钮会把完整诊断（provider、实际端点、HTTP 码、请求 id、响应体）直接显示出来。

Degradation is always fail-open: the original behavior passes through and one
line is written to `telemetry.jsonl`. The `Test endpoint` button shows the full
diagnosis (provider, actual endpoint, HTTP code, request id, response body)
directly.

## 决策点（参与哪些环节）/ Decision points (which stages it joins)

这个插件的定位不是「工具调用风险闸门」，而是**一个便宜的判断层**：用一次
约 1.9k token 的小模型调用，去替代或阻止更贵的 LLM 开销。因此判断必须克制——
**只在「替代更贵的调用」或「阻止更大的开销」处介入，绝不为了「多一道检查」而介入**。

This plugin is positioned not as a "tool-call risk gate" but as **a cheap
judgement layer**: one ~1.9k-token small-model call replacing or preventing more
expensive LLM work. So judgment must be restrained — **intervene only where a
call replaces something more expensive, or prevents a bigger expense — never
just to add one more check**.

八个决策点**全部已实装**，由你决定让决策模型进入哪些环节。

All eight decision points are **fully implemented** — you decide which stages
the decision model joins.

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

| # | Decision point | Hook | Trigger gate (why not every call) | What it enforces | Token-saving mechanism |
|---|---|---|---|---|---|
| 1 | Tool authorization | `tools/pre-execute` | Read-only tools / auto presets / excluded tools pass straight through | `ask` / `deny` | Replaces auto-review's full-context examination |
| 2 | Model routing | `agent/request` | First N steps of a turn only + skip when the route is unchanged + skip on new user input | Replaces `provider`/`model` | Mechanical steps sink to a cheaper model |
| 3 | Subtask delegation | `agent/pre-step` | Only the first step of a turn, and only with new user input | Injects one hint | One avoided spawn = one whole context saved |
| 4 | Context compaction | `agent/pre-step` → `ctx.compaction` | Only when measured tokens reach 70% of the trigger line | Runs deterministic pruning first so the summarization is skipped | Saves one summarization call |
| 5 | Turn continuation | `agent/turn-stopping` | At most one steer per turn | `agent.steer()` | Avoids a wasted full turn |
| 6 | Retrieval necessity | `tools/pre-execute` | Retrieval tools only; zero overhead for everything else | `deny` | Saves search and result tokens |
| 7 | Skill selection | `tools/pre-execute` | Only the `skill` tool, and only with ≥2 candidates | `deny` + redirection | Saves the body of a wrongly loaded skill |
| 8 | COT translation gate | Wraps `translator.translate()` | Local pre-filter + same-text cache | Skips and returns the original | Saves translation calls per message |

### 三态的含义 / The three modes

| 模式 | 行为 |
|---|---|
| `关闭` | **连请求都不发**。省 token，也省那约 2 秒延迟 |
| `观察` | 照常判断并记录「本该怎样」，但不改变任何行为 |
| `生效` | 按判断执行该点的处置 |

| Mode | Behavior |
|---|---|
| `off` | **No request is sent at all**. Saves tokens and the ~2s latency |
| `observe` | Judges and records what would have happened, but changes no behavior |
| `enforce` | Executes that point's outcome per the judgment |

新接入的决策点都应当先跑 `观察`，确认与人工判断一致后再切 `生效`。

Newly wired decision points should all run in `observe` first, and only switch
to `enforce` once their judgments match human review.

### 阈值是实测校准的，不是拍脑袋的 / Thresholds are calibrated on measurements, not guesses

每个决策点的阈值都用真实端点跑过对照样本（「该判 A」与「该判 B」成对输入），
只有两类输入真的分得开才留着。校准过程发现并修掉了三个问题，值得记下来：

Every point's thresholds were run against paired samples on a real endpoint
("should judge A" vs "should judge B"), and a gate stays only if the two kinds
of input really separate. Calibration surfaced and fixed three problems worth
recording:

1. **`choice` 的 `confidence` 是被选中项的概率**。三选项平分时天然只有 0.33，
   所以分派点的门槛不能设 0.6，否则永远判不出 `advise`。现在按「显著高于均分」
   取 0.5。
2. **question 的问法决定一切**。原来问「这个信息是否已知道」，两类输入给出
   0.30 / 0.12 —— 完全没有区分力。改问「recent 里是否**逐字覆盖**了这个事实，
   只依据那段文本回答」之后变成 0.92 / 0.01。
3. **判据顺序会改变结果**。轮次延续若先看 `closed`，「明确未完成」那组
   因为 `closed=0.28` 不达线就会掉进默认 `stop`——而它恰恰该续轮。
   现在先看 `unfinished`。

1. **`choice`'s `confidence` is the probability of the picked option**. With
   three choices splitting evenly it is naturally 0.33, so the delegation floor
   can never be 0.6 — `advise` would be unreachable. It now requires "clearly
   above a uniform split": 0.5.
2. **The question's wording decides everything**. Asking "is this information
   already known?" gave 0.30 / 0.12 on the two input kinds — zero
   discriminative power. Asking "does `recent` cover this fact **verbatim** —
   answer only from that text" flipped it to 0.92 / 0.01.
3. **Check order changes outcomes**. If turn continuation tests `closed` first,
   the "clearly unfinished" group misses the line at `closed=0.28` and falls
   through to the default `stop` — exactly the case that should continue.
   `unfinished` is checked first now.

校准后的实测对照（`scripts/verify-endpoint.mjs` + 成对样本）：

Post-calibration measured pairs (`scripts/verify-endpoint.mjs` + paired samples):

| 决策点 | 输入 A | 判定 | 输入 B | 判定 |
|---|---|---|---|---|
| 模型路由 | 机械步骤 | `switch` | 新架构设计 | `keep` |
| 子任务分派 | 三个包并行补测试 | `advise` | 变量改名 | `inline` |
| 上下文压缩 | 结论已落地 | `prune` | 对话承载状态 | `summarize` |
| 轮次延续 | 任务已完成 | `stop` | 明确还有三步 | `continue` |
| 检索必要性 | 上下文已覆盖 | `skip` | 完全没提过 | `allow` |
| 思维链翻译 | 英文→中文 | `translate` | 中文→中文 | `skip` |

| Decision point | Input A | Verdict | Input B | Verdict |
|---|---|---|---|---|
| Model routing | mechanical step | `switch` | new architecture design | `keep` |
| Subtask delegation | tests for three packages in parallel | `advise` | renaming a variable | `inline` |
| Context compaction | conclusions already landed | `prune` | the conversation carries state | `summarize` |
| Turn continuation | task complete | `stop` | clearly three steps left | `continue` |
| Retrieval necessity | already covered in context | `skip` | never mentioned | `allow` |
| COT translation | English → Chinese | `translate` | Chinese → Chinese | `skip` |

### 为什么不是「所有 hook 都开」/ Why not "all hooks on"

决策模型每次约 **1.9k token、p50 约 0.5 秒**。`agent/pre-step` 与 `agent/request`
都是**每步**触发，两个都开且不加闸，等于每步多等 1 秒以上。所以热路径上的
决策点（注册表里标了 `hotPath`，配置页显示「热路径」角标）都带明确的触发闸，
不能无条件调用。

The decision model costs about **1.9k tokens and p50 ≈ 0.5s** per call.
`agent/pre-step` and `agent/request` both fire **every step**; running both
without gates would add over a second of waiting per step. So hot-path points
(marked `hotPath` in the registry, shown with a "hot path" badge in the config
page) all carry explicit trigger gates and can never be called unconditionally.

护栏是**双层缓存**（见下节）：命中缓存就不发请求，把热路径上的重复调用挡掉。
本插件不设每小时的 token 预算——一次决策约 1.9k token，命中缓存后几乎为零，
不值得用「超限即停止判断」的方式省，那会让守卫在最需要它的时刻失效。

The guardrail is the **two-layer cache** (next section): a cache hit sends no
request, blocking repeated calls on the hot path. This plugin deliberately has
no hourly token budget — one decision is ~1.9k tokens and near zero once cached;
saving via "stop judging when over budget" would disable the guard exactly when
it is needed most, so it isn't worth it.

## 模型选择 / Model selection

配置页的「模型」是**下拉框**，由服务商实时提供，另有「自动（服务端默认）」选项。

The "Model" field on the config page is a **dropdown**, served live by the
provider, plus an "auto (server default)" option.

**默认就是「自动」**（`config.yml` 里 `model:` 留空）：插件**不发送该字段**，
服务端用它当前的默认决策模型。实测省略 `model` 返回 200，响应里回填实际使用的模型名：

**"Auto" is the default** (`model:` left blank in `config.yml`): the plugin
**does not send the field** and the server uses its current default decision
model. Measured: omitting `model` returns 200 and the response names the model
actually used:

```json
{"answers":{...},"model":"startlux-decision-27b-autothink","usage":{...}}
```

这样即便服务商将来更换模型名，留空配置也不会因此 400。

This way, even if the provider renames its model in the future, a blank config
cannot break with a 400.

> 注意：`config.yml` 里的 `model:` **必须写出来但留空**（`model:` 后面不跟值）。
> 解析器把显式空值保留为 `""`；若整行删掉，键会缺失并回落到内置的硬编码模型名，
> 「自动」就不生效了。

> Note: `model:` in `config.yml` **must be present but empty** (write the key,
> put no value after it). The parser keeps an explicit empty value as `""`;
> delete the whole line and the key goes missing, falling back to the built-in
> hardcoded model name — "auto" would no longer apply.

**列表为何要过滤**：bamboonode 的 `/v1/models` 返回全部 20 个模型，其中多数是
chat 模型，拿去打 `/v1/decisions` 会 400 `model ... is not served by this plugin`。
因此对 `bamboonode` 按 `supported_endpoint_types` 只保留声明了
`StartLux Decision` / `StartLux SystemOne` 的模型。实测 `typesafe/jev-1.14` 虽声明
`jev-decisions`，仍被该端点拒绝，因此也排除。

**Why the list is filtered**: bamboonode's `/v1/models` returns all 20 models,
most of them chat models, which would 400 with `model ... is not served by this
plugin` against `/v1/decisions`. So for `bamboonode` the list keeps only models
declaring `StartLux Decision` / `StartLux SystemOne` in
`supported_endpoint_types`. Measured: `typesafe/jev-1.14` declares
`jev-decisions` yet is still rejected by that endpoint, so it is excluded too.

对 `system one` / `custom`：自建服务的 `/v1/models` 往往不带
`supported_endpoint_types`，继续按类型过滤会得到空列表（用户会以为服务没有可用
模型）。因此这两种 provider 改为「有类型就按类型过滤，没类型就全收」，下拉里也
仍可手填。

For `system one` / `custom`: self-hosted `/v1/models` often carries no
`supported_endpoint_types`, and filtering by type would yield an empty list
(users would assume the service has no usable model). So these two providers
switch to "filter by type when types exist, accept everything when they don't",
and the dropdown still allows a manually typed value.

对 `siliconflow` / `siliconflow-intl`：它们的 `/v1/models` 返回 **98 个**模型、
**没有一条**带 `supported_endpoint_types`，而决策端点只认 `Kev-4B` / `SemIf`
（chat 模型打过去是 400 `Model does not exist.`）。类型过滤拿不到任何线索，
全收又等于「96 个选了就失败的选项」，因此按预设里的 `knownModels` 白名单筛，
下拉里只列这两个。

For `siliconflow` / `siliconflow-intl`: their `/v1/models` returns **98** models
with **not one** carrying `supported_endpoint_types`, while the decision
endpoint only accepts `Kev-4B` / `SemIf` (a chat model sent there gets
`400 Model does not exist.`). Type filtering yields no signal at all, and
accepting everything would list "96 options that fail when picked" — so the
preset's `knownModels` whitelist applies, and the dropdown lists only these two.

## 超时与自动回退 / Timeout and automatic fallback

每次请求都带**硬超时**（默认 8000ms），超时不是错误，而是降级放行：

Every request carries a **hard timeout** (default 8000ms); a timeout is not an
error but a fail-open degradation:

```
AbortSignal.timeout(timeoutMs) → 超时 → degrade("timeout") → 钩子 next() 放行
AbortSignal.timeout(timeoutMs) → timeout → degrade("timeout") → hook next() passes through
```

三层保护，保证守卫永远不会拖住工具执行：

Three layers of protection ensure the guard never holds up a tool execution:

1. **单次超时**：`timeoutMs`（默认 8000ms，可在配置页调整，最小 1000ms）。
   实测该端点 p50≈0.7s、冷启动 p95≈6.4s，8s 覆盖冷启动又不至于让用户干等。
2. **连续失败冷却**：连续 `failureThreshold`（默认 3）次失败后进入
   `cooldownMs`（默认 60s）冷却，冷却期内**直接放行、0ms 返回**，
   不再对着故障端点反复消耗。
3. **调用方取消**：若上层传入 `AbortSignal` 且被中止，立即降级返回
   `caller-aborted`。

1. **Single-call timeout**: `timeoutMs` (default 8000ms, adjustable on the
   config page, minimum 1000ms). Measured on that endpoint: p50 ≈ 0.7s,
   cold-start p95 ≈ 6.4s — 8s covers cold starts without making users wait.
2. **Consecutive-failure cooldown**: after `failureThreshold` (default 3)
   consecutive failures the client enters `cooldownMs` (default 60s); inside
   cooldown calls **pass through directly, returning in 0ms** instead of
   repeatedly burning requests against a broken endpoint.
3. **Caller abort**: if an upstream `AbortSignal` fires, the call degrades
   immediately with `caller-aborted`.

实测（指向不可路由地址，`timeoutMs: 1500`）：

Measured (pointing at an unroutable address, `timeoutMs: 1500`):

```
第1次: 1504ms → 降级      第4次: 0ms → 降级   ← 冷却生效
第2次: 1502ms → 降级      第5次: 0ms → 降级
第3次: 1502ms → 降级（触发冷却）

Call 1: 1504ms → degraded     Call 4: 0ms → degraded   ← cooldown active
Call 2: 1502ms → degraded     Call 5: 0ms → degraded
Call 3: 1502ms → degraded (triggers the cooldown)
```

**没有配置 key 时根本不发请求**，直接 `no-key` 降级，零延迟。

**With no key configured, no request is sent at all** — straight `no-key`
degradation, zero latency.

## 失败降级（fail-open）/ Fail-open degradation

插件的设计原则是**任何不确定都退回原生行为**，绝不因为守卫自身故障而卡住工具调用。
以下情形全部 `next()` 放行，并在 `telemetry.jsonl` 记一条 `action=degraded`：

The plugin's design rule is **any uncertainty falls back to native behavior** —
a guard failure must never wedge a tool call. All cases below pass through via
`next()`, and one `action=degraded` line is recorded in `telemetry.jsonl`:

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

| Situation | `detail` |
| --- | --- |
| Plugin disabled (`enabled: false`) | no judgment, passes through directly |
| No API key | `no-key` |
| Failure cooldown hit | `cooldown` |
| Endpoint 4xx / 5xx | `http-404` / `http-500` … (with `endpoint`, `body`) |
| Network unreachable | `network-error` |
| Timeout | `timeout` (with `timeoutMs`) |
| Non-JSON / non-object response | `invalid-json` / `invalid-response` |
| Missing `answers` field | `missing-answers` |
| Provider unusable (e.g. invalid custom base URL) | `invalid-base-url` (with `provider` and reason) |
| Auth rejected (401/403) | `auth-failed` (with `provider`, `status`, that provider's key variable name) |
| Answer shape mismatch (wrong type, missing field, illegal `choice`, probability out of range / NaN) | `answer-shape-mismatch` |
| Exception thrown inside the guard | caught, then passed through, only `logger.warn` |
| Read-only tool / auto permission preset / excluded tool | no judgment, passes through |

默认 `mode: shadow` 时，即使判断出 `deny` 也只记录不执行。

In the default `mode: shadow`, even a judged `deny` is only recorded, never
executed.

## 省 token 的设计 / Token-saving design

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

- **Two-layer cache**:
  - `exact`: reused when the full `state` + question set match — **the only
    layer enabled by default**.
  - `soft reuse`: the key is a normalized signature of "tool name + command
    family + risk flags" that deliberately drops argument content — a hit means
    **different arguments share one verdict**. So this layer ships **disabled
    (fail-closed)** and activates only when a caller explicitly declares
    `softCacheable: true`; tool authorization (authorize) is **permanently
    excluded**: a "low-risk allow" reused across a normalized signature would
    spread to calls with entirely different arguments (review note, 2026-10).

    Historical lesson: it once seemed safe to "cache only low-risk allows with
    identical risk flags" — but the cache layer itself does not judge risk. A
    justified allow for `rm -rf /tmp/x` would be inherited verbatim by
    `rm -rf /Users/chi/xx`, whose risk flags match exactly. A security verdict
    is either bound to the full call context or not cached at all. Every
    decision point's verdict now either maps to the complete `state` one-to-one,
    or is not reused.
- **`thinkMode` defaults to `never`**: the measured effect is mainly on
  **latency** (~1.9s vs 7.2s); input tokens stay basically unchanged (this
  endpoint always reports `output_tokens` = 0, thinking overhead is unmetered).
  The three values switch via the thinking-mode dropdown on the config page or
  by editing `config.yml`:

  | Value | Behavior | Good for |
  |---|---|---|
  | `never` | No thinking. The default. | Hot paths — don't slow down every tool call |
  | `auto` | Think only when the model itself decides it's needed | Middle ground |
  | `always` | Always think | High-risk scenarios or debugging misjudgments, temporarily; adds ~5s per call |

  Illegal values (e.g. `thinkMode: sometimes`) are normalized to `never` and
  never forwarded verbatim: config comes from an in-house YAML-subset parser
  that bypasses Schemastery validation, so values must be caught here.
- **Read-only tools pass through**: `read`/`grep`/`glob`/`todo_write` and
  friends send no request.
- **State truncation**: `args` becomes a head/tail digest; `recent` carries only
  the last 4 entries at 240 characters each.
- **Failure cooldown**: 3 consecutive failures enter a 60s cooldown, avoiding
  burned money on a broken endpoint.
- **Two-layer cache**: an exact hit sends no request; the "soft reuse" layer is
  off by default and permanently disabled for authorization.
- **Observe by default**: new decision points run in `observe` first, switching
  to `enforce` only once their judgments match human review.

## 验证链路 / Verification

### 自动化验收（三条，全部可重复跑）/ Automated acceptance (three scripts, all repeatable)

```sh
pnpm test              # 209 项单元测试：纯函数 + 适配器接线 + providers + 配置往返 + 设置界面渲染 + 缓存回归
                       # 209 unit tests: pure functions + adapter wiring + providers + config round-trip + settings UI rendering + cache regressions
pnpm verify:wiring     # 接线检查：用真实 schemastery 加载插件 / wiring check: loads the plugin with the real schemastery
pnpm verify:endpoint   # 8 个决策点逐个打真实端点，校验题型与答案形状 / hits the real endpoint once per decision point, validating question shape and answer parsing
pnpm verify            # 前两条一起跑 / runs the first two together
```

五个测试文件各管一层，互不依赖宿主：

The five test files each own one layer, none depending on the host:

| 文件 | 覆盖 |
|---|---|
| `test/spec.test.js` | 每个决策点的问法 / 解析 / 处置与阈值边界 |
| `test/engine.test.js` | 适配器接线、off/observe/enforce 语义、全部降级分支 |
| `test/providers.test.js` | provider 预设、地址拼接、URL 校验、鉴权与请求构造 |
| `test/config-file.test.js` | `config.yml` 读写往返：保存后再打开的回显、切换不互相覆盖 |
| `test/client-ui.test.js` | 设置界面渲染与交互：provider 下拉、custom 字段、错误提示、**改动即保存**（无保存按钮、改动自动 PUT /config、API Key 失焦提交） |

| File | Coverage |
|---|---|
| `test/spec.test.js` | Each point's question phrasing / parsing / enforcement and threshold boundaries |
| `test/engine.test.js` | Adapter wiring, off/observe/enforce semantics, every degradation branch |
| `test/providers.test.js` | Provider presets, URL assembly, URL validation, auth and request construction |
| `test/config-file.test.js` | `config.yml` read/write round-trip: echo after save-and-reopen, switching without cross-overwrite |
| `test/client-ui.test.js` | Settings UI rendering and interaction: provider dropdown, custom fields, error hints, **edit-saves-immediately** (no save button, edits auto-PUT /config, API key submits on blur) |

`test/providers.test.js` 是 provider 改造的验收用例（不依赖宿主依赖，
裸仓库可直接跑），覆盖六项硬约束：

`test/providers.test.js` is the acceptance suite for the provider rework (it
depends on nothing from the host and runs in a bare checkout), covering six
hard constraints:

1. 内置 `system one` 可用（默认地址 / `/v1/systemone` / 自己的密钥变量名）
2. 内置 `bamboonode` 行为不变（默认端点、老 `baseUrl` 覆盖、老模型名）
3. `custom` base URL 可用（含端点风格、请求头、密钥来源优先级）
4. 非法 URL 被拒绝（缺 scheme、非 http(s)、含空格、带查询串、空值）
5. 末尾斜杠与端点拼接正确、幂等，不出现 `/v1/v1` 或 `//decisions`
6. 请求构造不再硬编码 `bamboonode.dev`（含源码级断言：`lib/index.js` 与
   `lib/client.js` 里不得再出现该域名）

1. Built-in `system one` works (default URL / `/v1/systemone` / its own key variable)
2. Built-in `bamboonode` behavior is unchanged (default endpoint, legacy `baseUrl` override, legacy model name)
3. `custom` base URL works (including endpoint style, extra headers, key source precedence)
4. Illegal URLs are rejected (missing scheme, non-http(s), spaces, query strings, empty)
5. Trailing-slash and endpoint assembly is correct and idempotent — never `/v1/v1` or `//decisions`
6. Request construction no longer hardcodes `bamboonode.dev` (with a source-level assertion: the domain must not reappear in `lib/index.js` or `lib/client.js`)

`verify:wiring` 需要 profile 的依赖可解析。仓库里没有 `node_modules` 时先建链接：

`verify:wiring` needs the profile's dependencies resolvable. If the repo has no
`node_modules`, create the link first:

```sh
ln -s ~/.dsh/profiles/desktop/node_modules node_modules
```

它检查的是「宿主到底给不给这个服务」——包括缺 `translator` / `sessionTitle`
时 `apply()` 不抛、所有监听器都注册上、每个新点默认 `off`（升级不改变行为）。

What it checks is "does the host actually provide this service" — including that
`apply()` does not throw when `translator` / `sessionTitle` are absent, that
every listener gets registered, and that each new point defaults to `off`
(upgrading changes no behavior).

`verify:endpoint` 要网络与对应 provider 的密钥（`bamboonode` 默认读 `BAMBOO_API_KEY`，
可用 `DECISION_ENGINE_BASE_URL` + `DECISION_ENGINE_API_KEY` 指向其它
system-one 服务），它逐点校验：
端点接受该点的问题集（`choice` 必须有 `criteria`、`score` 必须 2–10 档、
题型只认三种）、答案能被 `parse()` 解析、`decide()` 产出合法 `kind`。
**这一步不能省**：题型写错会在运行时 400 并静默降级，光看日志很难发现
「这个点其实一直没生效」。

`verify:endpoint` needs network access and the provider's key (`bamboonode`
reads `BAMBOO_API_KEY` by default; `DECISION_ENGINE_BASE_URL` +
`DECISION_ENGINE_API_KEY` can point it at other system-one services). Per point
it validates: the endpoint accepts that point's question set (`choice` requires
`criteria`, `score` requires a 2–10 scale, only three question types exist),
answers parse via `parse()`, and `decide()` yields a legal `kind`.
**This step cannot be skipped**: a wrong question type 400s at runtime and
degrades silently — from the logs alone it is nearly impossible to notice "this
point has never actually worked".

### 手工验证 / Manual verification

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

1. The `Test endpoint` button → seeing `HTTP 200` and an `x-oneapi-request-id`
   means both config and network are right; the first line of the diagnosis
   names the current provider, then comes the exact full POST endpoint.
2. The plugin config page → confirm `Provider`, `effective endpoint`, `Model`,
   `key configured ✅`; every point in the decision-point list should offer the
   `off / observe / enforce` tri-state (there is no "coming soon"). If a point
   shows `host service missing`, the host lacks a service it depends on (e.g.
   `translator`) and the point cannot be enabled — that is not a bug, just an
   inapplicable deployment.
3. Switch one point to `observe`, trigger its action → read
   `~/.dsh/dsh-decision-engine/telemetry.jsonl` (on first upgrade, history from
   the old directory is copied over automatically):
   - `action=degraded, detail=no-key` → the key was not found
   - `detail=http-404` / `http-400` → wrong URL or model (the record carries `endpoint` and `body`)
   - `detail=answer-shape-mismatch` → the endpoint's answer shape is off (recheck that point's question set)
   - `point=route, action=switch` → the point judged "this step should have sunk to a cheaper model"
   - each line's `point` field names the decision point; `scores` holds the raw judgment scores
4. The provider's dashboard → a `type=2 · Action decision` record appears.

## 阈值 / Thresholds

### 工具授权 / Tool authorization

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `guardDenyConfidence` | 0.85 | 高风险 + 高置信 + 不可逆 → `deny` |
| `guardIrreversibleDenyFloor` | 0.5 | 判定不可逆的门槛 |
| `guardIrreversibleCeiling` | 0.2 | 低风险但不可逆 → 升级询问 |
| `guardConfidenceMin` | 0.6 | 中风险置信下限，低于则放行 |
| `guardInjectionAskThreshold` | 0.8 | 注入嫌疑 → 升级询问 |

| Key | Default | Meaning |
| --- | --- | --- |
| `guardDenyConfidence` | 0.85 | high risk + high confidence + irreversible → `deny` |
| `guardIrreversibleDenyFloor` | 0.5 | the bar for calling something irreversible |
| `guardIrreversibleCeiling` | 0.2 | low risk but irreversible → escalate to ask |
| `guardConfidenceMin` | 0.6 | confidence floor for medium risk; below it passes |
| `guardInjectionAskThreshold` | 0.8 | injection suspicion → escalate to ask |

### 其余八个决策点 / The other decision points

全部阈值都在 `config.yml` 里可覆盖，默认值按实测校准（见上文「阈值是实测
校准的」）。下表列出「改动它会怎样」：

Every threshold can be overridden in `config.yml`, and the defaults were
calibrated on measurements (see "Thresholds are calibrated on measurements"
above). The table lists what changing each one does:

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

| Key | Default | Raising it… | Lowering it… |
| --- | --- | --- | --- |
| `routeCheapProvider` / `routeCheapModel` | empty | blank means no routing: even with the point on, it only records | — |
| `routeMaxStepsPerTurn` | 3 | more steps judged per turn — better but slower | faster, but later steps keep the old verdict |
| `routeMaxScore` | 0.4 | fewer sink decisions (more conservative) | more sinks (cheaper, may lose quality) |
| `routeMechanicalFloor` | 0.6 | harder to judge a step mechanical (conservative) | easier to sink |
| `routeRiskFloor` | 0.3 | keeps the strong model even at slightly higher risk (conservative) | more willing to sink |
| `delegateConfidenceFloor` | 0.5 | fewer delegation advices | more delegation advices |
| `delegateBlockingFloor` | 0.6 | more often judged "blocked" → fewer delegations | more willing to delegate |
| `delegateParallelFloor` | 0.5 | teaming up requires stronger parallel evidence | easier to suggest teaming up |
| `compactContextWindow` | 0 | — | must be set to the real window for proportional early intervention |
| `compactThresholdRatio` | 0.7 | intervene later (close to compaction's own 0.8) | intervene earlier |
| `compactDistilledFloor` | 0.6 | less pruning (more conservative) | more pruning |
| `compactVerbatinFloor` | 0.6 | less often switching to summarization because "verbatim is needed" | more conservative (more likely to summarize) |
| `turnStopMaxSteers` | 1 | a turn may continue multiple times (mind the spin risk) | 0 = never continue |
| `turnStopUnfinishedFloor` | 0.6 | fewer continuations | more continuations |
| `turnStopValueFloor` | 0.35 | fewer continuations | more continuations |
| `retrievalCoveredFloor` | 0.5 | fewer retrieval skips (safer) | more willing to skip |
| `retrievalWouldAddCeiling` | 0.8 | more willing to skip (cheaper) | fewer skips |
| `skillPickConfidenceFloor` | 0.5 | fewer redirections | more willing to redirect |
| `cotProseFloor` | 0.5 | less translation (cheaper) | more willing to translate |
| `cotSameLanguageFloor` | 0.8 | less often judged "already in target language" → more translation | more willing to skip |

## License

MIT
