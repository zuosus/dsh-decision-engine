# lib/client-src —— 前端 bundle 的可编辑分片

`lib/client.js` 是**构建产物**，不要直接编辑它。真正的源码在这个目录里，按职责
切成若干分片；`scripts/build-client.mjs` 把它们按文件名前缀顺序拼回
`lib/client.js`。

## 为什么要这么拆

宿主把 `client.js` 当作**单文件浏览器 bundle** 直接加载
（`window.__ModuleLoader__.load({ factory })`）。factory 里的 `require` 只解析
shell 的共享模块表，**加载不了本包的其它源文件**——所以源码可以拆开写，下发给
浏览器的产物必须仍然是一个文件。

这与 `lib/client.config.css` / `lib/client.config-controls.js` 是同一套路
（见 DEC-051）：可编辑源单独放，构建期拼进 bundle。这里把范围从「CSS 与控件」
扩展到整个 bundle。

## 改代码的流程

1. 编辑 `lib/client-src/NN-name.js`；
2. 跑 `node scripts/build-client.mjs` 刷新 `lib/client.js`；
3. 提交两者（CI 的 `node scripts/build-client.mjs --check` 会拦住忘记第 2 步的提交）。

样式与行渲染仍然有各自的可编辑源，构建脚本会用它们**覆盖**分片里的对应内容：

| 可编辑源 | 覆盖位置 |
|---|---|
| `lib/client.config.css` | `CFG_SECTION_CSS = \`...\`` 模板字符串正文 |
| `lib/client.config-controls.js` | `// BEGIN … END CONFIG CONTROLS` 之间的正文 |

因此改样式**不要**改分片里的那一大段 CSS，改 `client.config.css`。

## 分片约定

- 文件名 `NN-<职责>.js`，两位数字前缀决定拼接顺序，必须唯一且连续可比
  （重复前缀会让顺序取决于文件系统，构建脚本直接报错）。
- 分片是**原 bundle 的字符区间切片**，拼接是纯连接、不做任何空白规整；每片必须
  以换行结尾。
- 每片不超过 500 行（AI_CODING 的文件尺寸预算）。新增逻辑放对应职责的分片，
  不要把一个分片重新养大。
- 分片之间共享同一个 factory 作用域：`const` / `function` 的可见性照旧，但
  **不能**在声明前使用（TDZ）。顺序即语义，重排会让代码在声明前被引用。

## 顺序一览

| 前缀 | 职责 |
|---|---|
| 01 | bundle 头、factory 入口、共享常量 |
| 02–06 | i18n 词典（配置页 / 统计页 / misc / 服务端标签 / 模板） |
| 07 | i18n 运行时（语言探测、`t` / `tr`、`h`、`useLang`） |
| 08–09 | 样式注入工具、图表分块加载 |
| 10–13 | 内联样式表 `S` |
| 14 | 审批卡命令归纳规则（与 `lib/approval-detail.js` 逐字同源） |
| 15–17 | 配置值同步、地址校验、决策表排序 |
| 18–21 | 审批详情视图、决策历史视图 |
| 22–25 | 图表几何与图型封装 |
| 26–29 | 统计页 |
| 30–38 | 配置页（状态、保存、动作、四个分组、渲染） |
| 39 | 插件注册（`apply` / `inject` / 导出） |
