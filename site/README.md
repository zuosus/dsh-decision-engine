# site/ — dsh.zuos.us 站点

DeepSeek Harness 插件项目的介绍站，部署在 Cloudflare Workers，域名
`dsh.zuos.us`。

## 结构

```
site/
  build.mjs            渲染 dist/（中英各两页：首页 + 插件页）
  make-bundle.mjs      把 dist/ 压成自包含 Worker（gzip + base64）
  deploy.mjs           上传 Worker 并挂自定义域名
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
