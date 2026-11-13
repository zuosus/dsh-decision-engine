# site/ — dsh.zuos.us 站点

DeepSeek Harness 插件项目的介绍站，部署在 Cloudflare Workers，域名
`dsh.zuos.us`。

## 结构

```
site/
  build.mjs            渲染 dist/（中英各两页：首页 + 插件页）
  make-bundle.mjs      把 dist/ 压成自包含 Worker（gzip + base64）
  deploy.mjs           上传 Worker 并挂自定义域名（手动路径，见下）
  package.json         site/ 自己的包：build / deploy 脚本 + wrangler 依赖
  package-lock.json    锁 wrangler 版本，保证 CI 与本地一致
  wrangler.jsonc       Workers Builds 的配置（name / main / build.command）
  lib/partials.mjs     共用 HTML 片段（导航含主题按钮 + 语言按钮；站点图标、figure/fact 片段）
  lib/content-en.mjs   英文版页面内容（章节 id 与中文版一致）
  assets/style.css     样式（light/dark 双调色板；少卡片，用留白与细分隔线分层）
  assets/theme.js      <head> 同步落 data-theme，防主题闪白
  assets/app.js        交互（命令块复制、主题切换）
  assets/*.png/*.jpeg  两个插件的宣传图与截图（优化过的副本，随站点嵌入 Worker）
  dist/               构建产物（gitignore）
  worker/             Worker 脚本与 payload（gitignore）
```

## 路由

| 路径 | 语言 |
|---|---|
| `/`、`/dsh-decision-engine/`、`/dsh-model-flatmap/` | 中文（默认） |
| `/en/`、`/en/dsh-decision-engine/`、`/en/dsh-model-flatmap/` | English |

无尾斜杠的目录访问返回 308。每页都有 `canonical` + 双向 `hreflang`，
导航右侧是「中文 / English」按钮与太阳/月亮主题按钮。

### API 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/e` | 匿名使用统计心跳（DEC-020/021）：校验后 202，写入放进 `ctx.waitUntil` |
| POST | `/api/digest` | 手工触发日报（需 `x-digest-key` 与 `DIGEST_KEY` 一致；未配 secret 即 404） |
| GET | `/api/provider-config` | 下发插件的 provider 配置（DEC-030，见下节） |

其余 `/api/*` 一律 404。

## 服务端下发 provider 配置（DEC-030）

`GET /api/provider-config` 把 baseUrl / model / endpointStyle / **key** 交给插件。
插件的「使用免费模型」开关（默认关，原名「跟随服务端下发」）打开后直接用它们，
**key 只驻留插件进程内存、不落盘**（不写 config.yml / .credentials.yaml / 遥测 /
统计 / 决策明细）。配置页在这行说明下还挂了一行小字「可能会失效」——这条免费通道的额度
由项目方自己掏，随时可能停用或换 key，界面上必须直说这个风险。
地址写死在插件里（`lib/server-config.js` 的 `SERVER_CONFIG_ENDPOINT`），服务端不提供自定义路径。

环境变量（全部部署时填，**不要写进仓库**）：

```sh
npx wrangler secret put PROVIDER_BASE_URL           # 下发给插件的基础地址
npx wrangler secret put PROVIDER_MODEL              # 下发的模型名；留空 = 不发送 model 字段
npx wrangler secret put PROVIDER_ENDPOINT_STYLE     # auto（默认）/ decisions / systemone
npx wrangler secret put PROVIDER_KEY                # 下游服务商的 api-key（必须 secret）
npx wrangler secret put PROVIDER_CONFIG_TTL_SECONDS # 可选，夹取 60..3600，默认 600
npx wrangler secret put PROVIDER_CONFIG_TOKEN       # 可选门禁
```

行为：

- **未配置 `PROVIDER_KEY` → 整条路由 404**（功能等同不存在，不会意外成为公开接口）；
- 设了 `PROVIDER_CONFIG_TOKEN` → 请求必须带 `x-provider-token` 且完全相等，否则 403。
  插件从环境变量 `DECISION_SERVER_CONFIG_TOKEN`，或 `.credentials.yaml` 的 `refs:` 同名键读取；
- `endpointStyle` 只认 `decisions` / `systemone`，其余（含拼错、空值）一律回落 `auto`；
  严格校验留给客户端——服务端将来加新风格，老客户端不会因此直接报错；
- 响应沿用 `json()` 的 `cache-control: no-store`；key 只在响应体里出现一次，
  **不写 D1、不打日志**；
- 无迁移、无新增绑定。

> ⚠️ **这不是鉴权**：任何知道地址的人 GET 一次就能拿到 api-key。请只放**专用、低额度**
> 的 key；轮换靠改 Worker secret（插件在 TTL 内自动跟上，不需要发版）。

## 主题

默认跟随系统 `prefers-color-scheme`；手动切换后记住在 `localStorage`
（键 `dsh-theme`）。`theme.js` 在 head 里同步执行，先设 `data-theme`
再首屏绘制，避免闪白。样式表是纯 token 双调色板（`:root` 浅色、
`[data-theme=dark]` 深色覆盖），改颜色只动变量。

## 流程

```sh
node site/build.mjs        # dist/ <- 源文件
node site/make-bundle.mjs  # worker/bundle.js <- dist/（gzip + base64 嵌入）
node site/deploy.mjs       # 上传并挂 dsh.zuos.us
```

本地预览：

```sh
cd site/dist && python3 -m http.server 8000
```

## 自动部署（Cloudflare Workers Builds）

Worker `dsh-worker` 已连到本仓库的 `main` 分支，推送即构建部署。
Cloudflare 后台 **Settings → Builds → Build Configuration** 的设置：

| 项 | 值 |
|---|---|
| Root directory | `site` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Git branch | `main` |

**Root directory 必须是 `site`，不能是仓库根。** 两个原因：

1. `wrangler.jsonc` 在 `site/` 下，Root directory 指向它所在目录；
2. 仓库根的 `package.json` 有三个宿主自带包的 peerDependency
   （`@deepseek-ai/cordis` 等），其中 `@deepseek-ai/dsh-session` 依赖的
   `@deepseek-ai/dsh-type-meta` **不在 npm 公共 registry 上**。Root directory
   指向仓库根时，Workers Builds 的自动依赖安装会 404 失败；`site/` 有自己
   干净的 `package.json`（只依赖 wrangler），安装不碰那些包。

同理，`site/package-lock.json` **要入库**：Workers Builds 用 `npm ci`
装依赖，有锁文件才能装出和本地同一份 wrangler；没锁文件它会退回
`npm install`，每次构建拉到的 wrangler 版本可能不同。

`site/package.json` 与 `site/wrangler.jsonc` 是 2026-10-28 补上的
（此前只有手动 `deploy.mjs` 一条路，Workers Builds 因找不到 Root directory
直接失败，见 DEC-016）。

### 入口文件不能指望 Build command 字段

`worker/bundle.js` 是生成物（gitignore），历史上栽过两次：

| 失败 | 原因 |
|---|---|
| `Failed: root directory not found` | Root directory 指向 clone 里不存在的目录 |
| `The entry-point file at "worker/bundle.js" was not found` | Build command 留空，构建步骤被跳过，deploy 找不到入口 |

所以 `wrangler.jsonc` 里写了 `build.command = "node build.mjs && node make-bundle.mjs"`：
**谁用入口文件，谁就现场把它造出来**（wrangler 的 custom build，deploy 前自动执行）。
有了它，Build command 留空也能部署成功；填上 `npm run build` 则构建/部署阶段
在日志里分得更清楚。两种都验证过（干净 clone、无 `worker/`，exit 0，
产物与线上 sha256 一致）。

### 本地验证（模拟 CI）

```sh
cd site
npm ci                 # 与 CI 同一条命令
npm run build          # 生成 worker/bundle.js（省略也可，wrangler 会自己跑）
npx wrangler deploy --dry-run   # 只打包不上传
```

`npm run build` 产出的 `worker/bundle.js` 是确定性的：同一份源码在本地
和 CI 里生成的字节完全一致（已核对 sha256）。

## 为什么是「把文件嵌进 Worker」

部署走 Cloudflare API，站点是几个静态文件。用 Workers 的 assets
上传会话要额外的往返，因此构建时把整个站点 gzip + base64 嵌进一段很短的
Worker——部署只是一次脚本上传，运行时用 `DecompressionStream` 解压。

代价是每次冷启动解一次压，换来的是部署路径极短、没有额外的资产上传状态要管理。

### 图片是二进制，不能按文本读

页面里的宣传图与截图放在 `assets/*.png|*.jpeg`，源文件来自两个插件仓库的
`docs/assets/`（以及 flatmap 的 `docs/model-picker.jpeg`），**优化过的副本提交在本仓库**，
不引用 GitHub，因此 CSP 不需要放行外域、也不依赖外链可用性。

`make-bundle.mjs` 对 `.png/.jpg/.jpeg/.webp` 等二进制扩展名单独处理：构建期存
base64 文本并打 `bin:1` 标记，运行时先 `atob` 还原成字节再交给 `Response`，
否则 PNG/JPEG 会被当成 UTF-8 文本发出去（浏览器解码失败）。`build.mjs` 负责把这些
图片从 `assets/` 拷进 `dist/assets/`。新增图片时把文件放进 `assets/` 并加进
`build.mjs` 顶部的拷贝列表即可。

## 部署凭据

`deploy.mjs` 读 `CLOUDFLARE_API_TOKEN`（环境变量，或写进 `site/.env`，
后者已在 .gitignore 里）。令牌需要 **Workers 编辑** 与 **DNS 编辑** 权限。

挂载 Worker 自定义域名时 Cloudflare 会自动创建对应的 DNS 记录，
所以不需要单独去 DNS 页加记录。

## 加一个新项目

1. 在 `build.mjs` 里加一段 `xxxBody`（中文）并写进 `dist/xxx/index.html`；英文版放 `lib/content-en.mjs` 的 `xxxBodyEn`，由 `build.mjs` 顶部 import；
2. 在首页 `indexBody`（中文）与 `indexBodyEn`（英文）的 `<div class="projects">` 里各加一个 `<a class="project">` 条目（结构见现有两条），并在 `partials.mjs` 里给它画一个图标；
3. 在 `build.mjs` 顶部 `navLinksFor` 里给新插件加一条导航（`${prefix}/xxx/#...`），双语共用；
4. `make-bundle.mjs` 会从 `dist/` 自动推导目录重定向列表（含 `/xxx`、`/en/xxx`），无需手动加 `DIRS`。

## 注意

- 首页与插件页共用 `assets/`，链接都写成绝对路径（`/assets/style.css`），
  这样子目录下的页面也能正确解析。
- Worker 对 `/xxx`（无尾斜杠）返回 308 跳到 `/xxx/`，保证相对链接不跑偏。
- CSP 只允许同源资源，没有外部字体与脚本，避免第三方依赖拖慢首屏。
