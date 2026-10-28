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
  wrangler.jsonc       Workers Builds 的配置（name / main / account_id）
  lib/partials.mjs     共用 HTML 片段（导航含主题按钮 + 语言按钮）
  lib/content-en.mjs   英文版页面内容（章节 id 与中文版一致）
  assets/style.css     样式（light/dark 双调色板）
  assets/theme.js      <head> 同步落 data-theme，防主题闪白
  assets/app.js        交互（命令块复制、主题切换）
  dist/               构建产物（gitignore）
  worker/             Worker 脚本与 payload（gitignore）
```

## 路由

| 路径 | 语言 |
|---|---|
| `/`、`/dsh-decision-engine/` | 中文（默认） |
| `/en/`、`/en/dsh-decision-engine/` | English |

无尾斜杠的目录访问返回 308。每页都有 `canonical` + 双向 `hreflang`，
导航右侧是「中文 / English」按钮与太阳/月亮主题按钮。

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

### 本地验证（模拟 CI）

```sh
cd site
npm ci                 # 与 CI 同一条命令
npm run build          # 生成 worker/bundle.js
npx wrangler deploy --dry-run   # 只打包不上传
```

`npm run build` 产出的 `worker/bundle.js` 是确定性的：同一份源码在本地
和 CI 里生成的字节完全一致（已核对 sha256）。

## 为什么是「把文件嵌进 Worker」

部署走 Cloudflare API，而站点是 5 个静态文件。用 Workers 的 assets
上传会话要额外的往返，因此构建时把整个站点 gzip + base64 嵌进一段很短的
Worker——部署只是一次脚本上传，运行时用 `DecompressionStream` 解压。

代价是每次冷启动解一次压（约 12 KB，可忽略），换来的是部署路径极短、
没有额外的资产上传状态要管理。

## 部署凭据

`deploy.mjs` 读 `CLOUDFLARE_API_TOKEN`（环境变量，或写进 `site/.env`，
后者已在 .gitignore 里）。令牌需要 **Workers 编辑** 与 **DNS 编辑** 权限。

挂载 Worker 自定义域名时 Cloudflare 会自动创建对应的 DNS 记录，
所以不需要单独去 DNS 页加记录。

## 加一个新项目

1. 在 `build.mjs` 里加一段 `xxxBody`，并写进 `dist/xxx/index.html`；
2. 在首页 `indexBody` 的项目列表里加一张卡片；
3. `make-bundle.mjs` 会把 `/xxx` 自动加进目录重定向列表吗 —— 不会，
   需要手动把新目录加进 `bundle` 里的 `DIRS` 数组。

## 注意

- 首页与插件页共用 `assets/`，链接都写成绝对路径（`/assets/style.css`），
  这样子目录下的页面也能正确解析。
- Worker 对 `/xxx`（无尾斜杠）返回 308 跳到 `/xxx/`，保证相对链接不跑偏。
- CSP 只允许同源资源，没有外部字体与脚本，避免第三方依赖拖慢首屏。
