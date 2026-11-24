# DECISIONS.md — 设计决策日志

<!-- APPEND-ONLY LOG: 新条目插入到此行之后 -->

## DEC-071 新增「书生·端砚」预设 + custom 模型框可手填（2026-11-24）

**背景**：上游 issue #2（`[Feature] 可自定义手动填写 authorization / content-type / model 字段`）提出：选 custom 时模型只能从下拉里选，而有些决策服务的 `/v1/models` 里**根本没有**它的决策模型——书生·端砚（Intern InkStone，上海人工智能实验室）的 `intern-decision-4b` 就是这样，用户只能手填，但界面没有地方可填。

实测（2026-11-23，真实 key）还暴露第二层问题：该端的 System One 端点（`POST https://discovery-api.intern-ai.org.cn/v1/systemone`）要求**每个 noul 问题都带 `criteria: { true, false }`**，缺了就回 HTTP 400：

```
question "irreversible" field `criteria` must be an object with `true`/`false` keys
```

本插件的决策点构造 noul 时都不写 criteria，于是「模型名填对了却每次 400」——不是模型不支持，是线协议差一层。守卫是 fail-open 的，这个 400 表现为**静默失效**（守卫不再拦人，也不再报错）。

**决定**：

- **新增「书生·端砚」预设**（`PROVIDER_IDS` 里 id = `duanyan`，插在 siliconflow-intl 之后、custom 之前）：地址 `https://discovery-api.intern-ai.org.cn/v1`、端点风格 `systemone`（实测 `/v1/decisions` 回 404）、默认模型 `intern-decision-4b`、`requiresModel`（该端点 model 必填，留空回落到预设默认）、`knownModels` 只列 `intern-decision-4b`（该站 `/v1/models` 会一并返回普通对话模型，与 SiliconFlow 同款问题）。它有自己的 key 格 `duanyanApiKey`、模型格 `duanyanModel`、变量名格 `duanyanApiKeyEnv`，与其它 provider 互不共用。
- **密钥变量名用平台自己的叫法** `TOKENPLAN_API_KEY`（端砚控制台的 key 属于「token plan」套餐，官方示例里就是这个变量名）。不另设回退名：这是**新预设**，没有需要兼容的历史变量名，凭空留一个「回退」只会让配置模板承诺一个代码里不存在的键。
- **noul 题统一补 `criteria: { true, false }`**：`buildRequestBody()` 在发请求前把缺 criteria 的 noul 补成 `{ true: "The stated condition is true.", false: "The stated condition is false." }`（语义与 `dsh-jev-decision-model` 的 `jev.mjs` 一致）。这是**协议层**的形状而不是某家服务商的偏好：`criteria` 是 System One 线协议里 noul 题的标准字段，端砚缺了就回 400，而允许省略它的端点（TypeSafe / Jev / SiliconFlow）收到显式的这两个键同样合法（实测 SiliconFlow 补与不补都回 200）。因此请求体形状与 provider 无关——内置预设、custom、服务端下发三条路径走同一条补齐逻辑，不会出现「换个接法就又撞上那条 400」。
- **custom 的模型框改成组合框**（原生 `<input list>` + `<datalist>`）：既能下拉选检测到的模型，也能直接手填模型名。空串的语义不变 = 「不发送 model 字段」，由 placeholder 与说明文字表达。**内置预设的模型框仍是下拉**——它们有预设默认模型与已知清单，不需要手填，也不必为它们改测试。

**为什么**：

- **为什么做成预设而不是扩展 custom**：custom 是「用户自己填地址」的那一格，把某家的地址、模型、变量名塞进去，等于让通用分支长出一家一家的特例；而预设表本来就是这个插件收拢 provider 差异的地方（`lib/providers.js` 顶部的说明：provider 只决定「往哪发、用谁的 key、默认哪个模型」）。做成预设还顺带得到「只填一个 API key 就能用」——地址、路径、默认模型都已预置，用户不用知道 `/v1/systemone` 这条路径该填什么。
- **为什么补 criteria 放在传输层**：它是**线协议对所有 noul 题的一视同仁的要求**，与「这道题问什么」无关。放在传输层，将来新增决策点不必记得再补一次；写进各决策点的题型定义，就得逐个写一遍，漏一个就是一次静默的 400。
- **为什么组合框只给 custom**：内置预设都有预设默认模型与已知清单，下拉就够用；把它们也换成文本框会改掉所有用户已经习惯的交互，还要连带改它们的测试。而 custom 面向的是「用户自己的服务」——那里的模型常常不在 `/v1/models` 里（书生·端砚实测就是如此），下拉会把人卡死。
- **为什么不顺手改掉「新增 provider 要改 8+ 处」这件事**：provider 的展示名与说明目前同时存在于 `lib/providers.js`（服务端下发）与 `lib/client.js` 的英文词表里，两处必须逐字相同——这是既有 i18n 路径的结构性债务（`lib/client.js` 的注释自己就写着「漏了就是那一句保持中文」，而且这份镜像表**已经漂移**：perplexity 与 openrouter 的 hint 从来没登记过）。把它改成「英文界面直接用 catalog 下发的 `labelEn` / `hintEn`」能一次消掉这份重复，但那会动到**所有** provider 的渲染路径与对应测试，属于独立的重构，不该混进这个 PR。

**被否决的方案**：

- **把「补 criteria」做成某个预设专属的标记**（`requiresNoulCriteria`，只对声明它的预先生效，其它 provider 的请求体一个字节都不变）：**否决**。初审时它是首选（影响半径最小），但实测发现这条路径只盖住三条接法里的一条——`custom` 与「服务端下发」的 provider 都没有预设表条目（`preset === undefined`），拿不到这个标记，于是「custom + 端砚地址」与「免费通道哪天换成端砚地址」会静默退回那条 400。要补齐就得在三处各打一个补丁（预设 + custom + 服务端下发分支），反而更复杂、更容易漏；而协议层的形状本来就该与 provider 无关（见本模块顶部的不变式），统一补齐只需一处。
- **把端砚做成 custom 的特例**（在 custom 分支里按域名判断）：那等于把「这家服务商的需求」写进通用分支，预设表也就失去意义。
- **保留下拉再加一个输入框**：两个输入点必然漂移（「下拉选了 A、输入框还显示 B」），保存时还要定义优先级。
- **顺手把 issue #2 的 `authorization` / `content-type` 也做成可自定义**：本 PR 不做。鉴权方式与响应结构绑定是既有设计（`buildHeaders` 固定 Bearer，`parseCustomHeaders` 保护性忽略这两个头），改动它是一次协议层决策，应单开一个 issue/PR 讨论。issue #2 的 **model 手动输入**部分由本 PR 的组合框实现；关联写法因此是 `Refs #2` 而不是 `Closes #2`——issue 标题里的另两项仍未覆盖。
- **给端砚的 custom 路径也补 criteria**（让「custom + 手填端砚地址」的老用法继续能用）：不做专门分支——统一补齐已经覆盖了这条路径（custom 与服务端下发都走同一处逻辑）。

**验证**：

- `test/providers.test.js` 新增 8 项（先红后绿）：预设齐备（地址 / 端点风格 / 默认模型 / 变量名 / 已知模型清单）、解析出的端点与模型、显式填模型以填的为准、noul 自动补 criteria、已写 criteria 原样保留、**所有 provider（含 custom 与服务端下发）的 noul 都带 criteria**、非 noul 题型不受影响。另有 1 项是既有用例（「各 provider 各读各的 key」）改名并补上端砚，不是新增。
- `test/client-ui.test.js` 更新 custom 模型行用例（断言组合框 + placeholder + datalist 候选 + 不出现「服务端默认」），新增 1 项「手填模型名会写进 `customModel`，且不写别的 provider 的模型格」。
- `test/save-path.test.js` 的凭据落盘用例补上端砚（六个 provider 各自的 refs 键互不覆盖）。
- `node --test test/*.test.js`：791 项 / 773~774 通过 / 17~18 失败。其中 **17 项与上游基线逐项相同**（上游 `ea2cd1b` 的干净副本在同一跑法下是 782 项 / 765 通过 / 同样这 17 项失败），全是 Windows 环境性失败：POSIX 权限位断言、用 `dirname` 切路径的 POSIX 分隔符、`DSH_HOME` 环境变量跨测试文件串味、测试机 `navigator.language=zh-CN` 而用例假设 `en-US`。第 18 项是**偶发**的 `telemetry.test.js` 临时目录清理竞态（`ENOTEMPTY`：删临时目录时还有异步写没落完；单独跑必过，重负载下更易撞上），与本次改动无关。结论：本次改动**新增 9 项全绿、零新增失败**。（上游 DEC-070 记录的「782/782 全绿」是上游 Linux/macOS 上的结果，两边差异只来自平台。）
- `node scripts/verify-wiring.mjs`：全部接线检查通过（新增两条：端砚解析出的端点与默认模型、noul 题带 criteria）。
- **真实端到端复验**（本机已有 key，密钥只在进程内使用、不落盘、不打印）：用仓库里新写的预设代码打 `https://discovery-api.intern-ai.org.cn/v1/systemone` → **HTTP 200**，`model=intern-decision-4b`。
  - 守卫四问（risk / irreversible / matches_task / injection_suspect）：全部返回，且答案**有判别力**（`irreversible=0.075`、`matches_task=0.638`、`injection_suspect=0.089`，不是同一个常数）。
  - **真实决策点题目**（直接调 `lib/points/spec.js` 的 `build()`，不手编）：`route`（score + 2×noul）→ HTTP 200，`capability=0.967`、`mechanical=0.693`、`risky=0.182`；`delegate`（choice + 2×noul）→ HTTP 200，`scope=inline conf=0.603`、`parallel=0.362`、`blocking=0.608`。**三种题型全部实测通过**，所以「只填一个 API key 即可使用」这句提示有据。
  - 同一份题**不补 criteria** → **HTTP 400**（正是上面那条 `criteria` 报错），证明这条兼容是必需的而不是多余的。
  - 另外两条实测事实（决定了预设的两个标记）：`GET /v1/models` 返回 11 个模型但**不含** `intern-decision-4b`（全是普通对话模型，与 issue #2 描述一致，因此 `knownModels` 白名单是必需的，否则下拉里会出现「选了就 400」的对话模型）；**省略 model 会回 400**（`field `model` must be a string`），因此 `requiresModel: true` 有据。
  - **三条接法终版复验**（统一补齐后）：端砚预设、`custom` + 手填端砚地址 + 手填模型、服务端下发 provider —— **三条都是 HTTP 200**，`model=intern-decision-4b`。后两条在改成「预设专属标记」的版本里会退回 400（`preset === undefined` 拿不到标记），这正是最终方案改成协议层统一补齐的原因。

**改动文件**：`lib/providers.js`（`PROVIDER_IDS` 新增 `duanyan`、`PROVIDER_PRESETS` 新增端砚条目、`buildRequestBody()` 统一补 noul 的 criteria、新增 `normalizeNoulCriteria()`、模块顶部不变式说明）、`lib/index.js`（`DEFAULTS` 与配置 schema 新增 `duanyanModel` / `duanyanApiKey` / `duanyanApiKeyEnv`）、`lib/client.js`（`EN_LABELS` 登记端砚的展示名 / 说明 / 密钥来源文案；custom 的模型框改为 `<input list>` + `<datalist>`，custom 的模型说明文案同步改写；「留空 = 用预设默认」的提示去掉只属于硅基流动的模型名）、`config.example.yml`（provider 清单、模型格、密钥变量名与 refs 示例、custom 模型格的说明）、`test/providers.test.js`、`test/client-ui.test.js`、`test/save-path.test.js`、`scripts/verify-wiring.mjs`、`scripts/verify-endpoint.mjs`、`DECISIONS.md`。

## DEC-070 配置页视觉重构：独立 CSS 源文件 + 语义变量 + 字体主导层级，不引入新框架（2026-11-24）

**背景**：配置页沿用早期仿 rewind 插件的行布局：分组标题带彩色色块图标与同色竖线、每行一条底边线、开关用绿/灰填充、多选按钮用靛蓝高亮。信息层级靠颜色和盒子表达，字符间距与留白不成系统，窄屏下左文右控件会互相挤压。用户要求「更高级优雅克制」，技术栈仍是原生 JS + CSS。

**决定**：
- **视觉减法**：分组的彩色图标与竖线直接移除（标题文字已经说明分组是什么，装饰不携带信息）；每行底边线只在分组之间保留一条；配色收敛为宿主语义变量（`--dsw-alias-*`），不再硬编码靛蓝/绿/红的 rgba；层级改由字号、字重与留白承担。
- **独立可编辑样式源**：`lib/client.config.css` 是唯一可编辑的样式源，用 `--de-space-*` 语义间距、8px 基线和 12 列网格（左 7 列文字 / 右 5 列控件）；`scripts/sync-config-css.mjs` 把它逐字嵌入 `client.js` 的 `CFG_SECTION_CSS`——宿主直接加载单文件 bundle，不解析本地 CSS import，因此样式源与产物必须同步，`--check` 在 CI 中防漂移。同理，行渲染与控件标签关联的实现源放在 `lib/client.config-controls.js` 并嵌入同一 bundle，避免继续加厚 8000 行的 `client.js`。
- **可访问性随重构补齐**：每行标题生成稳定 id，控件（input/select/textarea 及 `aria-pressed` 开关）递归关联 `aria-labelledby` 与 `aria-describedby`；tab 改用 `aria-current="page"` 而非 `aria-pressed`（它是页面导航，不是开关）；自动保存状态行加 `role="status"` / `aria-live="polite"`，失败原因与重试按钮保持可读可点；窄屏容器查询把行改为纵向占满，键盘焦点有 `:focus-visible`，系统减弱动效时不播放过渡。
- **行为不变**：自动保存（离散控件即时、文本框防抖、密钥失焦/回车才写）、分组折叠与 localStorage 偏好、provider 分槽存储、端点探测与所有配置字段逐字保留；只改结构与样式，不改任何配置语义。

**验证**：新增 `test/config-design.test.js`（9 项，先红后绿：实现前 8 项中 4 项失败，均为行为断言——缺 `de-settings` 根、缺 `de-cfg__row` / `data-field`、开关缺 `aria-labelledby`、保存失败缺 live 状态；随后补齐静态 CSS 与 bundle 内嵌一致的第 9 项）。全套 `node --test test/` 782/782 通过，`node scripts/verify-wiring.mjs` 全部通过，`scripts/sync-config-css.mjs --check` 无漂移。

**改动文件**：`lib/client.config.css`（新增）、`lib/client.config-controls.js`（新增）、`scripts/sync-config-css.mjs`（新增）、`test/config-design.test.js`（新增）、`lib/client.js`（嵌入样式与行渲染源、根与 tab 语义、状态行 live 属性）、`DECISIONS.md`。

## DEC-069 插件数据目录收进 $DSH_HOME/plugins/：一次性整目录迁移 + 失败回退读旧地址（2026-11-20）

**背景**：本插件把自有数据放在 `$DSH_HOME/dsh-decision-engine/`（家目录根部），与 DSH 自己的东西（`.credentials.yaml`、`profiles/`、`sessions/`）平级。而 `plugins/` 早已是既有的插件数据父目录惯例——本机已有 `~/.dsh/plugins/dsh-generative-ui/`、`~/.dsh/plugins/dsh-model-fusion/`。同一个家目录下两套摆法，用户看不出哪块目录属于哪个插件，卸载/备份时也没法一把抓。

**决定**：所有解析「插件自有目录」的入口统一改成 `$DSH_HOME/plugins/dsh-decision-engine/`，并加一次性整目录迁移把老地址搬过去。

- **惯例只写一份**：`lib/home-paths.js` 新增 `DSH_PLUGINS_DIR_NAME = "plugins"` 与 `dshPluginDataPath(name)`，`index.js` 的 `defaultTelemetryDir()` 改为调它。家目录解析的既有语义（`$DSH_HOME` 优先、空白视为未设置、`~` 展开、相对路径规范化）一字不动，只多一层目录。各插件自己拼 `join(resolveDshHome(), ...)` 的话，早晚有某个入口漏掉 `plugins/`，然后用户在两个位置各有一半配置。
- **整目录 move，不是单文件拷贝**：新增 `migratePluginDataDir()`，把 `<DSH_HOME>/dsh-decision-engine` 整体搬到 `<DSH_HOME>/plugins/dsh-decision-engine`。rename 优先（同卷原子、没有「拷了一半」的中间态），跨卷 EXDEV 退化为 `cpSync(recursive)` 到同父目录的 `<new>.migrating` staging、再 rename 落位、最后 `rmSync` 源目录。**先拷到 staging 再整体改名**是为了让半拷贝永远不占住新地址：否则一次磁盘写满就会留下一个「看着像迁移成功」的残缺目录，下次启动按「新地址已存在」直接跳过，用户从此读残缺配置。拷完必须删源，留着就是两份数据并存，之后读哪份说不清。
- **三条边界**：旧地址不存在 → 静默什么都不做（全新安装不该被凭空造出 `plugins/`）；新地址已存在 → 绝不覆盖、绝不合并（合并等于把两套配置混成一套）；旧地址是普通文件而不是目录 → 不动它（那是用户的东西）。
- **失败必须回退，不能让插件失效**：所有异常吞掉并返回 `"failed"`，`resolveConfigPath()` / `resolveTelemetryDir()` 继续从旧地址读。半拷贝的残骸顺手清掉，免得下次启动被误判成「新地址已存在」而永远不重试。
- **迁移先于一切读写**：放在 `apply()` 最前面、`migrateLegacyData()` 之前。顺序反了的话，第一次启动就会「读旧位置、写新位置」，一份配置劈成两半。两件事别混：`migratePluginDataDir()` 搬**目录**（本次目录结构变更），`migrateLegacyData()` 搬**单文件**（更早的改名与跨代目录）。
- **老用户不能被当成全新安装**：`hasAnyPriorConfig()` 的候选表补上旧地址里的 `config.yml` / `startlux.yml`。漏了它，迁移失败的老用户会被判成新装、默认打开免费模型，把本地 key 顶掉——这正是 DEC-062 明令禁止的。

**为什么迁移失败不重试到底**：家目录不可写是环境问题，插件无权修改权限。回退读旧地址能让插件照常工作，用户只看到一条 warn 日志；而反复重试只会在每次启动时多花一次失败的系统调用。

**验证**：`test/plugin-dir-migration.test.js`（新增 8 项，TDD 先红后绿）覆盖——正常搬迁（内容逐字保留、旧目录消失、`/status` 报新 `configPath`、key 仍可读、老用户默认仍关）、新地址已存在不覆盖不合并、旧地址不存在不造目录、迁移失败回退读旧目录且不崩溃、连续两次 apply 幂等、旧地址是普通文件时不动它、注入 `rename` 抛 EXDEV 时走拷贝分支并删源、落位失败时新地址不被残骸占住且 staging 被清掉。`test/home-paths.test.js` 新增 `dshPluginDataPath` 的三条断言（默认家目录 / `$DSH_HOME` / 空白值）。既有 8 个测试文件的夹具路径同步改到 `plugins/` 下。`node --test "test/*.test.js"` 全绿（773/773），`node scripts/verify-wiring.mjs` 全部通过。

**改动文件**：`lib/index.js`（`DATA_DIR_NAME` 注释、新增 `legacyDataDir()` / `migratePluginDataDir()`、`defaultTelemetryDir()`、`hasAnyPriorConfig()`、`resolveConfigPath()`、`resolveTelemetryDir()`、`apply()` 迁移顺序与启动日志）、`lib/home-paths.js`（`DSH_PLUGINS_DIR_NAME` / `dshPluginDataPath`）、`lib/decision-store.js`、`lib/stats-store.js`、`config.example.yml`、`docs/lessons/cold-start-timeout.md`、`scripts/verify-endpoint.mjs`、`test/plugin-dir-migration.test.js`（新增）、`test/home-paths.test.js`、`test/providers.test.js`、`test/config-rename.test.js`、`test/decisions-route.test.js`、`test/save-path.test.js`、`test/scope-guard.test.js`、`test/server-provider-route.test.js`、`test/tolerance-guard.test.js`、`test/fresh-install-default.test.js`、`test/engine.test.js`、`DECISIONS.md`。

## DEC-068 面板顶部链接改宣传 DSH 插件市场（2026-11-20）

**背景**：面板顶栏的页面级链接原来指向本插件的文档页 `https://dsh.zuos.us/dsh-decision-engine/`，文案「项目主页 ↗」。用户要求 link 部分改为宣传 `dsh.zuos.us` 的插件市场。`dsh.zuos.us` 首页本身就是插件市场（DEC-066：format 1 索引 + R2 自动更新，收录本插件等），其根 URL 即市场入口。

**决定**：

- 把顶部链接的 href/title 从文档页改为市场首页 `https://dsh.zuos.us/`，文案由「项目主页 ↗」改为「插件市场 ↗」（英文 "Plugin market ↗"，走既有 i18n 表）。
- 常量 `SITE_URL` 改名 `MARKET_URL`，注释同步；链接仍是页面级入口，保留在 tab 栏上方、统计页也可见，站外打开行为（target=_blank + noreferrer noopener）不变。
- 不改其它 `dsh.zuos.us` 引用：provider 配置端点、遥测上报端点是服务接口（`lib/server-config.js` / `lib/telemetry.js`），与宣传链接无关。

**验证**：`test/client-ui.test.js` 三条链接断言先改期望（URL + 文案），实现前 3 条红（「面板没有指向插件市场的链接」——行为缺失，非环境），实现后全绿；完整 `npm test` 764/764，`npm run verify:wiring` 通过。

## DEC-067 站点独立成 zuosus/dsh-site 仓库：只换代码托管位置，不换 Worker 身份（2026-11-20）

**背景**：`dsh.zuos.us` 站点（`site/` → Cloudflare Worker `dsh-worker`）一直放在本仓库里。但两者是两个发布单元：本仓库发 npm 包（`files` 白名单、`dsh` 字段、peerDependencies 全是宿主包），`site/` 发一个 Worker（wrangler + D1 + cron + R2）。混在一个仓库的代价：改一行站点文案也要在插件仓库 `main` 上产生提交，插件历史里混着大量站点改动；站点的 `wrangler` 依赖与插件的宿主 peerDependencies 互相干扰（DEC-016 记过 `@deepseek-ai/dsh-type-meta` 的 404，就是这种干扰的直接后果）。

**决定**：把站点独立成单独的项目仓库 `zuosus/dsh-site`，本仓库**删除 `site/` 与随它搬走的测试**。

- **历史保留**：`git subtree split --prefix=site` 抽出完整站点历史（含 DEC-066 的插件市场），新仓库根 = 原 `site/`，不是无历史快照。
- **线上标识一个都不动**：Worker 名仍是 `dsh-worker`，自定义域名仍是 `dsh.zuos.us`，D1 仍是 `dsh-telemetry`（`e828893a-…`），cron 仍是 `42 10 * * *`，R2 仍是 `public`，service binding 仍指向 `www-worker` 的 `Services`。**拆仓库只换代码托管位置，不换 Worker 身份**——换名意味着域名、D1 数据、cron、R2 绑定全部重建。
- **搬走的测试**：`test/site-theme.test.js`、`test/site-worker.test.js`、`test/market-index.test.js`、`test/site-home-market.test.js`、`test/fixtures/market-index-parser.mjs` 全部移到新仓库的 `test/`（改名 theme / worker / market-index / home-market），`SITE` 常量由 `join(HERE,"..","site")` 改成 `join(HERE,"..")`。
- **新仓库自己跑测试**：加 `npm test`（`node --test test/`），43 项全绿。

**为什么用 subtree split**：站点的历史里有大量「为什么这么写」的记录（DEC-016/017 的部署踩坑、DEC-020/021 的统计口径、DEC-065 的主题改造、DEC-066 的市场索引）。复制文件会把这些上下文丢掉，而 subtree split 是纯本地、零风险操作。

**验证**：

- 新仓库 `npm run build` 与拆分前**字节完全一致**：`worker/bundle.js` sha256 `2bdf28bbc7a578d2b69b7d5d377a0a4cb0c932f9e4b8d886ab5554c0ee366586`，拆分前后各算一次对比。这是「拆出来没改坏东西」的硬证据。
- 本仓库 `npm test`：807 项全绿（站点测试移走后其余不受影响）。

**顺手修掉的两个真问题**（都在新仓库）：

1. `test/fixtures/market-index-parser.mjs` 的「版本必须降序」判断写反了（`semver.lt(v.version, prev)` 应为 `lt(prev, v.version)`）。在旧仓库它永远走不到——官方包 `@deepseek-ai/dsh-plugin-market-index` 总能解析成功，离线回退分支从未执行。新仓库一开始没装官方包，立刻撞上，于是暴露。已修。
2. `theme.test.js` / `worker.test.js` 与 `home-market.test.js` 共享 `dist/`，而 `build.mjs` 开头会 `rm(DIST)`，`node --test` 并发加载时互相删文件（ENOENT 竞态）。现在 `build.mjs` 与 `make-bundle.mjs` 都支持 `DSH_SITE_DIST` / `DSH_SITE_OUT`，三个测试各建自己的临时目录。

**代价**：站点文案里的插件功能描述要与本仓库的 `README.md` / `README.zh.md` 手动对齐。这是拆分的固有成本，换来两条发布线互不牵连。

**线上切换还需一次手工操作**（本会话无 Cloudflare 凭据，未执行）：Cloudflare 后台把 `dsh-worker` 的 Workers Builds 从 `zuosus/dsh-decision-engine` 改连到 `zuosus/dsh-site`，Root directory 从 `site` 改成空（仓库根）。新仓库根目录就有 `wrangler.jsonc` 与 `package.json`，Root directory 指向仓库根不会再撞上 `@deepseek-ai/dsh-type-meta` 那个 404——那条约束只对插件仓库成立。步骤见新仓库 `README.md`「自动部署」一节。

## DEC-066 首页加入 DSH 插件市场入口：format 1 索引 + R2 public bucket 自动更新（2026-11-20）

**背景**：用户要在首页 hero 加一个「dsh plugin market」功能：一个按钮告诉用户怎么装索引、
一个符合 DSH 要求的 index.json URL、自动收录本项目列出的插件，并把 `cf R2` named `public`
绑进项目，让插件更新时主动更新 `public/index.json`。

**决定**：

- **入口**：首页（中英）hero 加原生 `<details class="market-install">` 按钮，展开后三步说明
  （插件 → 实验性插件启用「自定义插件索引」→ 发现 → 管理索引源），并给出可复制 URL
  `https://cdn.zuos.us/dsh-market/index.json`。无 JS 也能展开/复制，沿用既有 codeBlock。
- **索引格式**：严格按 DSH format 1（`format:1`、本地化 title 含 en、合法 npm 包名、
  精确 SemVer、真实 Unix 发布秒、npm source、版本降序、去重）。构建期用官方包
  `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 自检；不合法直接构建失败。
  已用真实 npm registry 数据验证通过（decision-engine 31 版 / flatmap 12 版 / pocket-kit 2 版）。
- **自动收录**：`site/market-plugins.json` 是唯一收录源，生成器 `site/scripts/build-market-index.mjs`
  从中构建索引；新增插件只改 manifest 并跑构建，索引自动带上，不在生成器里复制首页卡片文案。
  `--refresh` 可从 npm 重抓版本/发布时间回写。
- **R2 绑定**：`binding:PUBLIC` / `bucket_name:public` 同时写进 `wrangler.jsonc`、
  `cloudflare.config.ts`、`deploy.mjs` metadata（沿用 DEC-063 的三路径对齐原则）。
  Worker 新增 `GET /dsh-market/index.json`：从 `env.PUBLIC.get()` 读，直接 200 + `max-age=300`
  + CORS `*`，不重定向（DSH 抓取用 `redirect:"error"`）；未绑定返回 503 JSON，缺对象 404。
  `cdn.zuos.us` 自定义域指向同一 bucket，用户给的 URL 与 Worker 路由字节一致。
- **自动更新**：`npm run deploy = npm run upload:market && cf deploy`，`deploy-market.mjs`
  用 `cf r2 objects put --bucket-name public --file ...` 上传。Workers Builds 的 Deploy command
  本就是 `npm run deploy`，因此每次 main 变更（含插件/manifest）先更新 R2 再部署 Worker；
  手动 `node deploy.mjs` 复用同一上传脚本，避免两条路径漂移。

**为什么不让 Worker 直接打包静态 index.json**：那样 cdn.zuos.us 的 R2 对象不会更新，
用户添加的索引源 URL 会长期停留在旧内容。必须让 R2 对象本身每次部署刷新。

**验证**：新增 `test/market-index.test.js`（5 项）+ `test/site-home-market.test.js`（7 项）
+ `test/site-worker.test.js` 追加 4 项运行时 R2 路由测试（真实执行 bundle，200/404/503/405）。
红→绿：实现前 11 项新测试全红（缺失文件/行为），实现后全绿；完整 `npm test` 807/807 通过。
另外用官方解析器对 `site/dist/dsh-market/index.json` 验证：format 1、3 插件、版本数 31/12/2。

## DEC-065 站点主题改为完全跟随浏览器偏好：删掉手动切换、data-theme 与 theme.js（2026-11-20）

**背景**：站点主题原来是三层——head 里 `theme.js` 同步落 `data-theme`（localStorage 显式选择 > 系统偏好 > light），导航有太阳/月亮按钮手动切换并写入 `dsh-theme`，CSS 用 `[data-theme=dark]` 与 `@media (prefers-color-scheme: dark) :root:not([data-theme])` 两套选择器。用户要求「都做成根据浏览器设置自动 light/dark 模式」：手动切换与持久化记住正是「自动」的对立面——用户改了浏览器的深色设置后，站点仍固执地显示上次手选的颜色，且同一台机器上不同标签页、不同设备间行为不一致。

**决定**：主题完全由浏览器 `prefers-color-scheme` 驱动，纯 CSS 实现：

- 样式表里深色整套 token（含 `color-scheme: dark`，表单控件与滚动条一并跟随）合并进单个 `@media (prefers-color-scheme: dark) { :root { … } }`；`:root` 默认浅色。
- 删除 `assets/theme.js` 与 head 里对它的引用；删除导航主题按钮（`THEME_BTN`）与 `themeAria` 参数；删除 `app.js` 的主题切换段（复制按钮逻辑保留）。
- `theme-color` 的两条 meta（本就带 light/dark media）保留，浏览器地址栏/状态栏配色继续跟随。
- 浏览器设置变化时媒体查询实时重新应用：无需 JS、无闪白，禁用 JS 也成立。

**为什么不留按钮做「默认自动 + 手动覆盖」**：需求是「根据浏览器设置自动」，留手动开关意味着同一人站点与浏览器设置会长期背离（切一次就被 localStorage 永远记住），正是这次要移除的行为。若将来需要手动覆盖，作为新决策重新引入，不在本轮留开关。旧 `dsh-theme` localStorage 值不再被任何代码读取（残留在浏览器里，无副作用）。

**验证**：`test/site-theme.test.js`（新增 11 项）真实执行 `node site/build.mjs` 后对 dist/ 产物断言——8 个页面均无主题按钮/data-theme/theme.js 引用；深色值（#0b0e14、`color-scheme: dark`、btn-primary 深色字色 #06210f）只存在于媒体查询块内；`app.js` 无 `dsh-theme`；`theme.js` 源与产物均不存在。红→绿：实现前该文件 11 项全红（断言失败原因是行为缺失，非环境），实现后全绿。

## DEC-064 www-worker 的 BARK_DEVICE_KEY 落成普通 Worker Secret：Store 里没有这个条目，绑定会阻断部署（2026-11-20）

**背景**：DEC-063 部署时 www-worker 报 CF 10182——它把 `BARK_DEVICE_KEY` 声明成了 Secrets Store 绑定，但 store `7d4345789d06443999d6b2d6cbd59caa` 里并没有这个 secret，引用不存在的 store 条目会让整个部署失败。

**决定**：device key 只 www-worker 一个 worker 用，不需要跨 worker 共享存储——改成普通 Worker Secret（`cloudflare.config.ts` 里 `bindings.secret()`，`wrangler.jsonc` 不声明，值用 `npx wrangler secret put BARK_DEVICE_KEY` 设置一次，部署保留）。www-worker 代码本就兼容字符串形态，无需改动。

**影响**：DEC-063 中「device key 走共享 secrets store」一句作废（其余结论不变）。对 dsh-worker 没有任何影响：它只经 `WWW_SERVICES` 调用，密钥细节全在 www-worker 侧。

## DEC-063 日报推送改走 www-worker 共享推送服务：device key 不再散落在各 worker（2026-11-19）

**背景**：日报原来由本 worker 直连 Bark（`GET https://api.day.app/<key>/<title>/<body>`，device key 存 Worker Secret `BARK_TOKEN`），Dynamics 的 `dynamics-worker` 也各自维护了一份同样的发送逻辑与 key。同一件事有三份实现、两份 key，截断与编码规则还不一致。

**决定**：推送收敛到 `www-worker` 作为基本服务对外暴露（RPC 入口 `Services.sendPush` / `sendPushNotification`，device key 走共享 secrets store 的 `BARK_DEVICE_KEY`）。本 worker 改为通过 service binding `WWW_SERVICES`（`service=www-worker`、`export_name=Services`）调用，删掉本地 Bark base URL、`seg()` 截断与 `barkPush()`。绑定必须同时写进三条部署路径：`site/wrangler.jsonc`、`site/cloudflare.config.ts`、`site/deploy.mjs` 的 metadata——少写一处就会出现「配置里看着有、线上跑起来没有」的漂移。

**影响**：

- 部署顺序变为 **先 www-worker，后本 worker**（service binding 在部署时校验目标存在）。
- `BARK_TOKEN` 在本 worker 上不再被读取；未绑定 `WWW_SERVICES`（如本地 dev）时推送降级为 `push-failed`，`digest_log` 记 `ok=0`，汇总本身不受影响。
- 标题/正文仍由本 worker 组装（口径见 DEC-046），截断（480 字符）与 URL 编码只在 www-worker 侧维护一份。
- 回归护栏写在 `test/site-worker.test.js`：bundle 不得再出现 `api.day.app` / `BARK_BASE`，且三处部署配置都要有 `WWW_SERVICES` 绑定。

## DEC-062 全新安装默认打开「使用免费模型」：开箱即用，但不替老用户改开关（2026-11-19）

**背景**：用户要求「新安装的用户默认打开使用预置的免费模型」。插件本来就有这条免费通道（DEC-030 服务端下发，DEC-037 改名「使用免费模型」），但开关默认关：新装的人打开配置页看到一行关着的开关，不知道免费模型已经准备好，得自己找到并拨开、还得填自己的 key 才能跑——这与「开箱即用」的初衷相悖。

**决定**：只把**全新安装**的缺省值翻成 `true`；升级用户与本机曾有过任何配置的用户，默认仍逐字保持原来的 `false`。

**怎么判定「全新安装」**：看本机有没有本插件写过的任何配置——新文件名 `config.yml`、旧文件名 `startlux.yml`、三处历史数据目录里的 `startlux.yml` 全部算数。任何一个存在就是老用户；只有全都不存在才算新装。这个判定必须在 `migrateLegacyData()` **之前**做：迁移本身会造出 `config.yml`，之后再问就永远是「有」。探测只读、不创建文件；探测异常一律当成老用户（宁可少给一个新用户默认开，也不翻掉老用户的选择）。

**为什么不直接改 DEFAULTS / schema 默认**：`apply()` 的合成顺序是 `DEFAULTS < DSH 传入的 config < config.yml`，而 DSH 传进来的 `config` 是 Schemastery 解析后的**完整默认值**（`serverProvider:false` 也在其中），并不是用户显式配置。直接把 DEFAULTS / schema 默认值改成 `true`，老用户没写这一项时也会被 DSH 传来的 `false` 盖回去，等于什么都没改；反过来若在合成后无条件抬成 `true`，又会替老用户把关着的开关翻开、升级即开始向授权服务端发请求。所以做法是：保留 DEFAULTS 与 schema 默认 `false`（老用户的语义一字不动），在 `apply()` 里算出 `freshDefaults`（新装时 `serverProvider:true`），用它作为合成基座；并且在全新安装时把 config 层里**等于内置默认的 `false`** 丢掉——那是「没配置」的另一种写法，不是用户选择。config.yml 在最后展开，用户显式落盘的 `true`/`false` 永远优先。

**缺省值不落盘**：新装的 true 只活在内存里，`config.yml` 不会因为默认开而被凭空创建（保持既有「无配置不建空文件」的约定）。用户第一次从配置页保存时，草稿从 `/status` 派生（那里已归一成 true），存下来的就是他自己看到的值；想关随时拨一下，显式 `false` 经 PUT /config 落盘后盖过缺省。免费通道失效时照旧静默回落到本地手动配置，面板显示原因——这条 DEC-030 的承诺不变。

**为什么不为老用户也默认开**：那会把「升级」变成一次未经同意的行为变更——悄悄开始联系授权服务端、把已经在用的本地 key 顶掉，而用户只会看到「key 好像失效了」。DEC-037 之所以坚持默认关，守的就是这件事；这次只在「本来就没有既往选择」的全新安装上翻默认值，正是把那条约束保留在它真正适用的地方。

**验证**：`test/fresh-install-default.test.js`（新增 5 项）钉住——全新安装默认开且不写 config.yml；新文件名、旧文件名、历史目录三种「已有配置」都默认仍关；显式 `false` 经保存后能关掉。`test/server-provider-route.test.js` 的默认回归改为两条：全新安装默认开、已有配置默认关；其 `setup()` 增加 `seedConfig` 以模拟升级用户。`test/scope-guard.test.js` 的夹具显式写 `serverProvider:false`，免得后台下发刷新多打一次 fetch 污染「问模型次数」断言。`node --test test/` 全绿（基线 773 + 新增 5 = 778），`node scripts/verify-wiring.mjs` 全部通过。

**改动文件**：`lib/index.js`（`hasAnyPriorConfig()`、`apply()` 里的 `freshDefaults` 与合成层处理、DEFAULTS 注释、schema 描述）、`config.example.yml`、`test/fresh-install-default.test.js`（新增）、`test/server-provider-route.test.js`、`test/scope-guard.test.js`、`DECISIONS.md`。

## DEC-061 子代理模型阶梯：决策模型只给分数，路由与 effort 由本地映射（2026-11-18）

**背景**：宿主派生 subagent 时的默认行为是**原样继承 lead 的 provider /
model / 推理强度**（`resolveChildAgentOptions` → `parentAgentOptionsForDelegation`）。
这个默认值只对「lead 自己也在做同类工作」成立，而它错的两个方向代价不同：

- 把调研、查证、格式整理这类子任务交给 lead 的强模型 —— 纯浪费；
- 把改关键代码、逐字迁移这类子任务下沉到便宜档 —— 返工，而返工成本总是
  高于那一次省下的钱。

因此新增第九个决策点 `pointSpawnModel`（子代理模型阶梯）。用户要求是
「让本插件决定 subagent 用的模型和推理强度，取代 DSH 自带的继承逻辑」，
并要求同时提供 `set_model` / `list_models` / `switch_preset` / `list_presets`
这类工具。

**决定**：

1. **决策模型只回答两个 0–1 分数，不直接挑路由。** 决策端点只有三种题型
   （choice / score / noul），没有自由文本。用 choice 让模型从几十条路由里
   挑，等于把 `provider/model` 当选项 key 塞进 criteria——小模型会拼错、会选到
   不存在的组合，而**拼错的代价是派生直接失败**（宿主 `resolveCallConfig` 会抛
   未注册 provider / UNSUPPORTED）。所以拆成：
   `capability`（能力需求）+ `depth`（思考深度）两个 score，加一个 `fidelity`
   安全否决（noul）。路由由本地的有序阶梯 `tierForScore` 映射，effort 由**该
   模型实际公布的清单** `effortForScore` 映射。

2. **能力与思考深度分开问，不合成一个分数。** 二者会分离：一次「照抄一段
   结论」是高能力但零思考；一次「把两个互相矛盾的口径算清楚」是低能力但深
   思考。合成一个分数会让其中一类必然被估错。

3. **两个钩子，一条队列。** 宿主的时序是死的：`tools/pre-execute` 拿得到
   完整任务但子代理还不存在；`agent/created` 子代理已存在（可以
   `agent.model.select()`）但载荷里没有任务内容。所以 `tools/pre-execute`
   判断并入队（按父会话 + `description` 配对），`agent/created` 取走并落地。
   **必须落在 `agent/created` 而不是 `agent/pre-step`**：循环在派发 pre-step
   **之前**就捕获了本步 selection（`preStep()` 第一行 `model.current()`），在
   pre-step 里 select 只能影响下一步——对只跑一两步的子代理等于永远不生效。

4. **并行派生按 label 配对，不靠 FIFO。** 宿主的 `create` 是并发执行的，
   `agent/created` 的到达顺序与工具调用发起顺序不保证一致；纯 FIFO 会把 A 的
   档位发给 B。子代理会话里宿主自己写的第一条事件
   `subagent/descriptor.label` 与派生调用的 `description` 逐字相同，用它配对。

5. **三类不介入的边界**（任一成立就完全不改，子代理照旧继承）：
   阶梯留空（默认）/ lead 在派生调用里显式给了 provider+model / 决策模型判
   keep 或降级。三条都落在「宁可不动」一侧：插件的判断是优化，不是正确性的
   必要条件。

6. **effort 取不到就省略，绝不猜。** 模型不公布 `reasoning.efforts` 时返回
   undefined 并**省略该字段**；硬塞一个不支持的 id 会让宿主抛
   `UNSUPPORTED_REASONING_EFFORT`，子代理直接派生失败。同理，查不到目标模型
   元数据时**完全不改**——不赌一条未经确认的路由。

7. **优先级：派生调用里的显式参数 > `set_model` > 决策模型 > 继承 lead。**
   `set_model` 的效果**不**取决于决策点的 off/observe/enforce：它是模型主动
   调用的工具，与「自动判断」是两条独立的路。覆盖按**父会话**存内存、不落盘
   ——「这个会话接下来派生的子代理用什么模型」是会话内的临时决定，写进
   config.yml 会让它变成下次启动的默认值。

8. **本版本不做 `switch_preset`。** 宿主的 `agentPresets.select()` 在会话开过
   turn 之后返回 `agent-preset/locked`，而插件无法改写 subagent 工具的
   `agent_preset` 参数（参数由模型给出）。所以切换 preset 只能靠「拦下这次
   调用 + 让模型带新参数重发」，那是与「技能选择」点同类的拒绝-重试模式，
   需要单独设计。本版本只提供只读的 `list_presets`。

**被否决的方案**：

- **让决策模型用 choice 直接挑 `provider/model`**：见第 1 条。拼错路由的代价
  是派生失败，而分数 + 本地阶梯把「判断」与「合法性」分开，合法性由本地保证。
- **在 `agent/pre-step` 里改路由**：见第 3 条。对本步无效，对短命子代理等于
  永远无效。
- **把阶梯写成结构化对象（嵌套 YAML）**：本插件的配置读取器只认标量与
  字符串数组（`lib/config-file.js`），嵌套对象读不出来。阶梯必须是能手写的
  部署知识，所以编码成 `provider/model[/effort]` 字符串数组。
- **阶梯末尾一律当 effort**：`provider/vendor/model`（第三方聚合路由）与
  `provider/model/effort` 语法同形。按位置切会把前者读成「model 叫 vendor、
  强度叫 model」——一条根本不存在的路由。改为**只有末尾是已知 effort id
  时才当强度**（`EFFORT_RANK` 的键）。
- **纯 FIFO 配对**：见第 4 条。

**验证**（随 lib 改动一同落地）：

- `node --test test/`：772 项全绿，其中新增 `spawn-model.test.js`（22 项纯函数）
  与 `spawn-adapter.test.js`（24 项接线行为，逐个断言「是否调用了 select」——
  三类不介入都不会抛错，只表现为「用了和 lead 一样的模型」，因此必须对着
  副作用断言而不是最终路由）。
- `node scripts/verify-wiring.mjs`：新增六个 Config 键、三个工具注册、以及
  「缺 llm / tools 服务的宿主仍不抛」共 16 项检查。
- 用**宿主自己的 `defineTool`**（从安装目录解析真实 `@deepseek-ai/dsh-tools`）
  校验三个工具的 schema 并实际执行，确认宿主的参数方言与 output schema 子集
  都接受。
- 端到端跑通：`tools/pre-execute` 判定 → `agent/created` 落地，日志输出
  `子代理 C1 路由 lead/lead-model → cheap/cheap-model @ high（来源：决策模型）`。

**教训（写进 `docs/lessons/subagent-model-timing.md`）**：宿主里「子代理已经
存在」与「子代理的任务已经可见」发生在**两个不同的时刻**，而改模型只在前一个
时刻有效。任何想「按任务内容给子代理选模型」的实现，都必须自己把这两半接
起来——并且要用会话里持久化的 label 配对，因为并发创建不保证顺序。


## DEC-060 冷启动尾延迟：预算抬到 20s、只对超时/网络错误重试一次、冷却改半开（2026-11-13）

**背景**：用户报「官方文档页点『发送请求』永远返回 200，但在插件里配好同一个
provider 点『测试』大约 2/3 会报错」。同一个端点、同一把 key，一边 100% 成功，
一边三分之二失败——这个反差必须解释清楚，否则任何「再点几次试试」的回应都只是
把用户推回随机。

实测（bamboonode `https://api.bamboonode.dev/v1/decisions`，模型
`startlux-decision-v1.1-27b-autothink`，生产遥测 2573 次请求 / 358 次降级）：

| 场景 | 实测延迟 |
|---|---|
| 闲置 110 秒后首发 | **7.4–15.9 s**（服务端冷启动尾延迟） |
| 焐热之后 | 1.0–1.3 s |
| 首发被掐断后的第二发 | 1.1–1.7 s，**4 组独立实验一致** |
| `thinkMode: never` / `auto` | 约 1.9 s / 约 7.2 s |

成功请求延迟分布（n=2215）：<1s 36.1%、1-2s 31.8%、2-4s 18.3%、4-6s 8.8%、
6-8s 5.0%、**≥8s 0%**。最后那个 0% 是最有欺骗性的一格：不是没有慢请求，而是
慢的那些全被 8 秒预算掐掉了，根本没资格进入「成功」样本。

**根因是四层叠起来的，不是一层**：

1. **冷启动尾延迟被 8 秒预算截断**。闲置约 110 秒后的首发要 7.4–15.9 秒，
   而预算 8 秒——首发**稳定**落在预算线之外。这是「偶发失败」的错觉来源：
   它其实是确定性的。
2. **服务端 5xx 是服务商侧的问题，本地改不了**。响应体是服务商内部错误：
   `{"error":"Task request failed"}`、
   `{"error":{"message":"Database error, please contact the administrator
   (request id: …)","type":"new_api_error"}}`。带 request id 的错误说明请求
   已经进了对方的业务层，本机配置、key、地址全都无关。
3. **network-error 是链路层**。全部是 `fetch failed`，延迟 5004–5557 ms；本机
   DNS 解析到 198.18.0.145（Clash fake-IP），说明链路被本机代理接管过。
4. **cooldown 是放大器**。连续 3 次失败进入 60 秒全黑，而一次抖动往往 3 秒就
   恢复——「3 秒的服务端抖动」被放大成「60 秒完全不工作」，冷却期间的请求以
   0–1 ms 计入降级（遥测里 cooldown 记录的耗时全部是 0 或 1 ms：请求根本没
   发出去），把一次小故障记成一串大故障。

**「2/3」这个数字是采样偏差，不是端点属性**。真实降级率是 **13.9%**
（2573 次请求 / 358 次降级）。358 次降级的构成：timeout 83、network-error 84、
http-5xx 95、cooldown 93、caller-aborted 2、429 1、502 1、530 2。而「点测试」
是手动触发的，人点它的时机永远是「刚想起来 / 刚改完配置」——也就是端点**闲置
了一段时间**之后。每一次点击都是一次冷启动首发，等于永远在延迟分布最右端采样。
2/3 是「只在最差点采样」的产物。

**决定**：

1. **`timeoutMs` 默认 20000**。代码里的 `DEFAULT_TIMEOUT_MS` 本来就是 20000，
   只有 `config.example.yml` 还写着 8000——模板与代码不一致本身就是 bug。
   20 秒覆盖实测 7.4–15.9 秒的冷启动区间，且仍在「用户可感知的等待」之内。
2. **仅对 `timeout` / `network-error` 重试一次（`retryAttempts: 1`）**，
   总预算封顶 `min(2 × timeoutMs, 30s)`。4xx 是配置错（地址 / 模型 / key）、
   5xx 是服务端故障，重试只是多烧一次额度、拿回同一个错误。这与 DEC-002
   「**只有 404 才换路径**，400/401/5xx 不换」是同一条哲学：**只重试那些
   「再来一次可能不一样」的失败**。实测支撑：首发被掐断时服务端其实已经被焐热，
   第二发 1.1–1.7 秒必中。
3. **冷却改半开 + 指数退避**（`cooldownProbeMs: 10000`）。冷却期内每隔
   `cooldownProbeMs` 放行一次试探请求，成功即彻底恢复；冷却时长随连续失败次数
   指数增长，封顶 `10 × cooldownMs`（即 `cooldownMs` 是**首轮**时长，不是上限）。
   目的是让「一次抖动」只换来「一次抖动」，而不是 60 秒全黑。
4. **测试按钮有独立的 20 秒预算（总预算封顶 35s），且走同一条 `fetchFn` 路径**。不与正常决策
   共享预算（否则试探会被主预算连坐），也不另开一条旁路（否则它测到的不是
   用户实际走的那条链路）。失败沿用同一套分类（timeout / network-error /
   http-5xx），遥测里能直接按 detail 判读——错误分类必须**可执行**：看到
   `cooldown` 就知道「等」，看到 `http-500` 就知道「等或换 provider」，
   看到 `timeout` 才知道「抬预算」。
5. **不引入 undici 依赖做代理支持**。给 Node fetch 设 `HTTPS_PROXY` 环境变量
   是**无效的**（实测反而变成 `UND_ERR_CONNECT_TIMEOUT` 10.5 秒 + 连续
   ECONNRESET，比不设更差）；Node 26 的 `NODE_USE_ENV_PROXY=1`（或
   `--use-env-proxy`）才真正生效，实测某次 4001ms → 1949ms。但**在冷启动场景
   代理并不稳定优于直连**：同一次实验 8030ms（代理）vs 6035ms（直连）。
   收益不稳定 + 打破本插件的零运行时依赖约束，两件事一起否掉这个方向。
   改为**文档化** `NODE_USE_ENV_PROXY=1` 作为诊断手段——它是环境相关的排查
   工具，不是修复方案。

**被否决的方案**：

- **加 undici 的 `ProxyAgent`**：打破零依赖（本仓库刻意让 `lib/providers.js`
  能在裸 Node 下跑单测，连宿主的 peer 包都自己复刻而不引入），而实测收益
  不稳定甚至为负。为一个不稳定的收益付一个确定的架构代价，不划算。
- **对 5xx 也重试**：5xx 是服务商侧故障，重试烧的是项目方自掏的免费额度，
  拿回同一个 `Task request failed`。免费额度不是无限资源，省着用是义务。
- **把 `timeoutMs` 提到 60s 以上**：能覆盖一切冷启动，但 60 秒的等待已经超出
  用户可感知的上限——那时候用户早就以为卡死了。**一个「最终会成功但用户已经
  放弃」的预算等于失败**；正确的做法是 20 秒预算 + 一次重试，用两次机会覆盖
  冷启动，而不是用一次长等待赌运气。

**预期效果**：降级率从 **13.9%** 降到预计 **3–5%**（剩余部分主要是服务端
5xx 与真实链路故障，两者都不是本地能消除的）。「点测试」的体验变化最大——
它原本 100% 采在冷启动首发的点上，现在首发有 20 秒预算、被掐断还有一次重试。

**验证**（随 lib 改动一同落地，本条只记录决策与依据）：

- `timeoutMs` 默认值与模板一致（20000），`retryAttempts` / `cooldownProbeMs`
  三个键在 `config.example.yml` 与 `lib/index.js` 的配置 schema 里同名同义。
- 重试只发生在 timeout / network-error 两条分支上；4xx / 5xx 分支逐字未变。
- 冷却的半开试探不会绕过 fail-open：试探失败仍然降级放行，绝不阻塞用户。
- 遥测里 `cooldown` 降级的耗时应当从「0–1 ms 的成串记录」变成零散单条。

**教训（写进 `docs/lessons/cold-start-timeout.md`）**：「同一个端点浏览器 200、
Node 报错」不是「Node 不行」，而是四类失败（超时 / 网络错误 / 5xx / 冷却）被
混成了同一句「报错」，而这四类的修复动作完全不同。判别的第一步永远是看耗时：
0 ms = 请求没发出去，预算线整数值 = 被自己的预算掐了，5 秒上下 + `fetch failed`
= 链路层，带 request id 的 JSON = 服务端自己的问题。

## DEC-059 圆环不再自绘读数行：图型自己的读数气泡已经够用（2026-11-11）

**背景**：用户指出——「按决策点分账 在鼠标 hover 的时候，不必再在 chart 下面增加
显示一行说明，因为 chart 已经支持互动了」。

**为什么之前会多出那一行**：DEC-055 把统计页的图表换成了 microcharts 的
**交互入口**（`/interactive`）。交互入口自带两样东西：高亮当前数据点，以及一个
读数气泡（`.mc-spark-readout`，在图的上方浮出，内容是「工具授权 75%, 120」）。

但当时对走势图（Sparkline）来说，库的读数气泡只给数值（「120」），没有给**这一格
是哪个桶**（「14时」）。于是走势图那边补了一个自绘读数行——那是对的，库里确实
没有这句话可说。

而圆环不需要这一步：库的圆环读数气泡里**名字、占比、次数全都有**
（`shareAt(label, share, value)`），颜色 ↔ 名字 ↔ 数字在同一个气泡里就对齐了。
所以那一行自绘读数是**纯粹的重复**：同一件事说两遍，还多占一行版面；两处措辞
稍有差异（自绘行写「120 次请求」，气泡写「120」），读者会以为是两个不同的数。

**做法**：删掉圆环那一行自绘读数，以及它带来的全部附属物：

- `renderPointDonut` 里 `MicroDonut` 的 `onActive` / `onSelect` 回调不再往下传
  （图型内部的读数不需要外传）；
- `renderPointDonut` 里 `options.readout()` 这个插槽整个删掉（它只有圆环在用）；
- 组件里 `donutReadout` / `setDonutReadout` 这份 useState 删掉，连同它经 props
  进 `renderStatsTab` 的那条链路；
- 词表里的 `"次请求"` 条目删掉（唯一消费者就是那一行的单位标签）。

**刻意没动的**：

- **走势图的读数行保留**。库的气泡只给数值，不给桶标签；走势图要显示的是
  「14时 · 128 次」，那句话库里说不出来，自绘那一行是必需的。这条与本决策
  互为对照，测试里也钉住了两边。
- `S.chartReadout` 样式常量保留（走势图还在用）。
- `chartBox` 的「第三个参数只能是样式对象」防御保留（DEC-056 的真机事故，
  走势图的读数仍然经过它）。
- `options.readout` 机制本身保留（`renderTrend` 仍在用）。

**验证**：

- 新增两条回归守卫：一条钉住「圆环不再有自绘读数行」（且不接 onActive/
  onSelect/readout），一条钉住「走势图的读数行仍然在」。
  反向验证过：把自绘读数重新塞回去，第一条**确实会红**——不是空跑。
- 全套 **669 项通过**。

**取代 DEC-055 的一部分**：DEC-055 说「图表接入 hover 读数」，其中走势图部分
仍然成立；**圆环自绘读数行**的部分被本条取代。

## DEC-058 走势图把「还没到的时间」画成淡色虚线（2026-11-11）

**背景**：用户原话「走势的折线图显示的统计周期包含了未来。未来部分的颜色粗细风格
和过去的完全一致，是否可以采用淡一些的颜色，以及使用虚线而不是实线，以便用户更
清晰地了解时间分布？」

**根因（口径问题，不是画法问题）**：`resolveRange` 给的区间上界常常落在未来——
`today` → 次日 0 点、`week` → 本周末、`month` → 月末、`year` → 年末。`bucketKeys`
又刻意生成**连续**的桶（见 DEC-052 那条「空桶补 0」），于是序列尾部有一批值恒为 0
的桶。**同样画成实线的 0，此时有两种互相矛盾的含义**：「这段时间真的没有请求」
与「这段时间还没到」。图上无法区分，读者会把后者的平线读成前者——这是本插件在
统计口径上反复强调的那条原则（0 与「无数据」不是一回事）在时间维度上的同一个坑。

**决定**：

1. **未来段由服务端算好一个下标下发**，前端不做任何时间运算：
   `series.nowIndex` = 第一个「还没开始」的桶的下标。判定看**桶起点**：
   `bucketStartMs(key) > now` 才算未来（严格大于）。**正在进行的那个桶算过去**
   ——它已经有真实数据了，按桶终点判定会把它划进未来段，图上最后一段真实折线被
   画成虚线，读者以为「还没发生」，其实那就是刚刚发生的事。
   全过去 → `buckets.length`；全未来 → `0`；空序列 / 任一非法键 → `buckets.length`
   （非法键时**整段放弃**而非停在出错位置：返回出错位置等于把「说不清」画成
   「还没发生」，会凭空造出一段假虚线。宁可没有虚线，不可造假）。
2. **过去段照旧交给库，未来段自己画**：交给 `Sparkline` 的 `data` 在未来索引处置
   `null`——库把非有限值当断点，实线自然停在边界；同时 hover 与键盘漫游的候选点
   集合只剩过去的桶，**自动跳过未来的桶**（没发生的时间不该给出「0 次」的读数，
   这正是本次要修的那个误读）。虚线段由我们在 `children` 里塞一条
   `<path data-mc-ink="muted">`。
3. **线型复用库已有的 token，不硬编码颜色**：vendored 样式里
   `:where(.mc-root [data-mc-ink=muted]){fill:none;stroke:var(--mc-neutral)}` 且
   `:where(.mc-spark-interactive [data-mc-ink=muted]){stroke-dasharray:1.5 2}`；
   本插件的主题覆盖把 `--mc-neutral` 接到 `--dsw-alias-label-tertiary`（淡色），
   muted 又**没有**设 `stroke-width`（库只给 `[data-mc-ink=data]` 设 `--mc-sw`），
   线宽因此从 1.5 降到默认 1。**淡色 + 虚线 + 略细**一次满足，深色 / 浅色主题与
   forced-colors（muted → GrayText）都自动成立。硬编码颜色会在深色主题或高对比
   模式下变成看不见的线。
4. **`domain` 与 `maxPoints` 必须由我们显式传**：值域按**原始序列**算（未来那个 0
   照样参与缩放），否则库拿 null 化之后的序列自己算，过去段的坡度会随「后面挂了
   几格未来」被偷偷改掉——那比虚线缺席严重得多。`maxPoints` 只有存在未来段时
   才钉成桶数：库默认 200 会做 min/max 抽稀，长区间（year + 日桶 = 365 格）上
   虚线与实线的顶点就不再逐桶对应，会错开好几天。没有未来段时不传，保持旧行为。
5. **坐标系必须逐位复刻库的内部布局**：pad=2、按**全长**排 x、按值域排 y、坐标
   保留 2 位小数、null 处切子路径且每段各起一个 `M`（分隔符是 `" L"`）。复刻错了
   不会报错，只会错位。所以 `lib/client.js` 为此导出 `sparkTrendGeometry` /
   `sparkTrendPath` / `sparkDomain` / `sparkFutureIndex`，由
   `test/client-charts-chunk.test.js` 拿**同一份 vendored 产物**渲染 Sparkline，
   把库自己算出的 `d` 与我们算的**逐字符**比对。将来重跑
   `scripts/build-microcharts.mjs` 升级 microcharts、库改了 pad 或抽稀规则，
   这条立刻红，而不是让用户先看到错位的线。
6. **旧响应完全不受影响**：`nowIndex` 缺失 / 非整数 / 越界 / 为 0 一律当作「没有
   未来段」，`data`、`domain`、`maxPoints` 全部原样——这是向后兼容的底线。

**文案**：走势区块在有未来段时才多一行「虚线段是区间内还没到的时间，不计入读数。」；
无障碍摘要补「（虚线为未来 N 个桶，尚未发生）」——读屏用户看不见线型，虚线的含义
只能写进摘要里。两处都登记进了词表（`test/i18n-coverage.test.js` 盯着）。

**测试**：
- `test/stats-series.test.js` 新增 11 项：`bucketStartMs` 与 `bucketKey` 互逆
  （含 23 点 / 月末 / 跨年）、严格大于的边界两侧（13:59:59.999 → 14、
  14:00:00.000 → 15）、全过去 / 全未来、天与月粒度、空数组 / 乱码键 / 坏 now
  不抛异常、`aggregate` 下发形状。
- `test/client-ui.test.js` 新增 2 项：有未来段时 `data` 置 null 且虚线首尾顶点
  精确落在 `{x:130,y:32}` → `{x:258,y:2}`；以及 9 种退化输入（缺失 / 越界 /
  负数 / 0 / NaN / Infinity / 小数 / 字符串 / null）全部退回旧行为且摘要不提虚线。
- `test/client-charts-chunk.test.js` 新增几何锁定：我们算的 `d` 与真实 vendored
  库算出的 `d` 逐字符相同（含 NaN / Infinity / undefined 断成四段那条）。

**验证**：`node --test "test/*.test.js"` → 684 项全过；另用独立脚本让真库与我们
的几何函数在小时桶 / 日桶 / 负值 / 无未来段 / 全未来五种输入上比对，实线顶点
逐位一致、虚线起笔点与实线末点重合、虚线确实渲染进 SVG。

**补充（同日复检，修一处说明行与图不一致）**：说明行的判据原先只看**区间**的
事实（`seriesFutureCount > 0`），但虚线是否存在是**图**的事实。区间全零时
（例如本月一条记录都没有、`nowIndex` 仍指向月末），`renderTrend` 会直接返回
「本区间没有数据」占位——屏幕上根本没有图，说明行却照样渲染出一句「虚线段是
区间内还没到的时间」，去解释一个不存在的东西。修法：加 `trendHasData` 前提
（判据与 `renderTrend` 里那个 `hasData` 逐字相同），说明行必须跟着图走。
`test/client-ui.test.js` 新增一例钉住（全零区间既要有「没有数据」占位、又
不该出现虚线说明）。

另：曾担心 `year` + 日桶（366 点）时 `stroke-dasharray:1.5 2` 密到读不出虚线。
实测该担心不成立——`pickBucket` 给 `year` 的粒度是**月桶（12 个）**，不是日桶；
真实最密场景是 59 天自定义区间（60 个日桶，每桶约 4.3px，仍有 1.24 个虚线
周期），虚线清晰可辨。故不为此另写 CSS，保持「纯 ink 方案」。

## DEC-057 DEC-044 入场动画：时长翻倍 + 新增行背景色淡出（2026-11-11）

取代：DEC-044 第 4 条里 `S.decisionsRowEnter` 的 `300ms` 与
`from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)}`
这两处口径。keyframes 名、`both` 填充、只给新增行、首屏不动画、减弱动效不播、
幂等注入、新增判定放取数、换会话清基线等**其余约定一字未动**；DEC-044 条目按
append-only 规则原样保留（它正文里那几处 `300ms` 是当时的历史值），失效由本条声明。

**背景**：用户原话「DEC-044 的动画太快了……1. 动画效果 duration 延长一倍；
2. 增加 row background color 动画：新增 row 自带不同的 background color，在整个
动画过程中逐渐改变为默认 color」。

**决定**：

1. **时长 300ms → 600ms**（翻倍）。`S.decisionsRowEnter` 仍是一条
   `animation: dsh-decision-row-enter 600ms ease-out both`，不拆两段、不加延时、
   不加配置键、不升版本（沿用 DEC-044「不新增配置键、不升版本」）。
2. **在 `@keyframes` 里加 `background-color`**：`from` 帧给新增行一层靛蓝高亮
   `rgba(99,102,241,.28)`（与配置页 active 的 `rgba(99,102,241,.28)` 同一个语义
   色），`to` 帧褪到同色相 `rgba(99,102,241,0)`——即行默认的「无背景色」。颜色
   与 opacity / 位移走同一条 `from→to`、同一段 600ms，于是「逐渐改变为默认 color」
   正好铺满整个动画过程。

**为什么高亮只写在 keyframes、不写成行内联 `background`**：`DECISION_ROW_ENTER_CSS`
注不上（无 `document` / CSP 拦 `<style>`）时，浏览器找不到同名 keyframes，整条
`animation` 失效；此时若高亮是内联样式，行会**永久卡在一层底色**（要到下一次轮询
才被覆盖）。放进 keyframes 则随动画一起失效，行照常按默认背景出现。这与 DEC-044
「注不上就是不动画、行照常出现」是同一个失败方向，不能破。

**为什么 `to` 用 `rgba(99,102,241,0)` 而不是 `transparent` 关键字**：部分引擎把
`transparent` 当 `rgba(0,0,0,0)` 做非预乘插值，靛蓝 → 黑透明中途会透出灰调；
同色相 alpha=0 是纯 alpha 淡出，浅色/深色主题、各浏览器都不偏色，且 alpha=0 与
「无背景色」视觉等价——正是用户说的「默认 color」。

**只碰展示层**：背景色不牵动盒尺寸，不碰 `decisionsScroll` 的重排（沿用 DEC-044
「简单动画、不碰盒尺寸」）；5 秒轮询、新增判定、`newIds` / `seenIdsRef` 链路不动。

**验证**：`test/client-decisions-view.test.js` 仍 52 项。复用 DEC-044 那 7 项入场
动画用例：「要有明确时长」断言 `300ms` → `600ms`；在 keyframes 注入用例补三条——
`from` / `to` 两帧都带 `background-color`、起始色 ≠ 默认色、`to` 帧收敛到 alpha=0
（透明）。注释里残留的 `300ms` 同步改为 `600ms`。

## DEC-056 修「点统计页整页白屏」：读数元素被当成样式对象展开（2026-11-10）

**背景**：用户报告——「你肯定改错东西了，设置里点击 `统计与对比` 后，整个配置部分
（包括配置 tab）都消失了」。

**根因（真机事故，已复现并证实）**：

上一轮给走势图加 hover 读数的写法是：

```js
return chartBox(
  `trend/${options.label}`,
  h(charts.Sparkline, { ... }),
  typeof options.readout === "function" ? options.readout() : null,  // ← 第三个参数
);
```

而 `chartBox(key, children, extra)` 的第三个参数是**样式对象**：

```js
style: { ...S.chartBox, ...(extra ?? {}) }
```

于是那个 React 元素被**展开进了 `style`**，产生 `{ display:'inline-flex',
type:'div', props:{}, children:[...] }` 这样的畸形样式。React 设置样式时遇到
对象值直接抛 `TypeError`：

```
The style prop expects a mapping from style properties to values,
got an object for key "props"
```

React 在渲染期抛异常就会**卸载整棵组件树**——所以用户看到的不是「统计页坏了」，
而是「连配置 tab 一起消失」。这个现象正是根因的直接证据：**异常发生在统计页
渲染内部，但 React 的崩溃范围是整棵树**。

**为什么测试没抓到**：测试用的是图表替身（`chartsFixture`），且 `readout` 只在
真实数据 + charts 非 null 时才被调用；更关键的是，测试桩的 `h()` 不做任何样式
校验，展开出来的畸形对象被原样存进 `props.style`，没有任何断言去看它。

**修法（三层）**：

1. **改正写法**：读数作为图表的**兄弟节点**，放进一个外层 `div`，不再走
   `chartBox` 的第三个参数。
2. **`chartBox` 加防御**：第三个参数若带 `type` / `props` / `$$typeof`（即它是
   React 元素而不是样式对象），打一条英文警告并**忽略**它。实测：传元素进去后
   `style` 保持 `{display:'inline-flex'}` 干净、不再污染页面。这条防的是「同一类
   错误再次发生」——任何把非样式对象塞进第三个参数的调用都不会再拖垮整页。
3. **统计页加保护壳** `safeRenderStatsTab`：用 try/catch 包住整页渲染，异常时
   **把错误消息与完整堆栈显示在页面上**，而不是白屏。理由：统计页数据全部来自
   服务端（`/stats` 形状随版本变），一条缺字段的记录就可能让某张图崩掉——这种
   情况会一直存在，必须让它降级而不是炸掉整棵树；而白屏对用户毫无信息、对我们
   更是零线索（Console 里往往只有一句 `The above error occurred in…`）。

**验证**：
- 用真实数据 + 真实 charts 分块渲染统计页，四个区块（走势 / 横向对比 /
  按决策点分账 / 裁决构成）全部出现，未触发错误保护。
- `chartBox` 防御单测：传 React 元素 → 打警告、style 干净；传普通样式 → 正常合并。
- 新增回归守卫测试：遍历统计页渲染树，断言任何节点的 `style` 里都**不能**出现
  `type` / `props` / `children` / `$$typeof` 这些来自 React 元素的键。
- 全套 **667 项通过**，`verify-wiring` 通过。

**教训（已写进 DECISIONS 以便下次避免）**：给渲染辅助函数加「可选参数」时，
必须确认那个参数位的**语义**（是样式？是子节点？是回调？）。`chartBox` 的第三个
参数叫 `extra`，名字中性而实际是样式对象——这种命名本身就是坑。以后这类辅助函数
的参数名要写清类型（`styleExtra`），或者干脆只接受一个 options 对象。



## DEC-055 图表改用 microcharts 的交互入口（/interactive），并接入 hover 读数（2026-11-10）

**背景**：用户指出一件事——「这些图表都不能交互，但是 microcharts 是允许交互的，
请你查看问题」。

**根因**：microcharts 的每个图型都有**两个入口**，我之前一直只用静态的那个：

| 入口 | 例子 | 能力 |
|---|---|---|
| 静态 | `@microcharts/react/sparkline` | hook-free、零客户端 JS、**完全不可交互** |
| 交互 | `@microcharts/react/sparkline/interactive` | hover 读数 / 十字线 / 点选钉住 / 键盘漫游 |

也就是说，**不是「交互坏了」，而是「用的是没有交互的那个版本」**。106 个图型
全部有交互入口（`exports` 里每个图型都成对出现），只有静态版是「一张不会动的图」。

**为什么这个差别很要紧**：趋势图有几十个点，静态版既不能指着某个点问「这是多少」，
也不能键盘访问——那基本是一张装饰画。裁决构成条静态版也无法指出「哪一段是 ask」。

**决定与验证**：

1. **全部改用 `/interactive` 入口**（构建脚本 `scripts/build-microcharts.mjs`）。
2. **交互版仍只依赖 react**：实测全部 106 个交互入口的产物里只有
   `require("react")`（多几个同目录的相对引用，不是外部依赖），所以
   「宿主只保证 react」这条硬约束没有被破坏。交互版多用的 hook 是
   `useSyncExternalStore` / `useLayoutEffect` / `useMemo`。
3. **宿主满足这些 hook**：宿主是 React 18.3.1（从 app.asar 的 renderer bundle 里
   读到的版本号），`useSyncExternalStore` 自 React 18 起就提供，宿主 bundle 里
   还带 shim 回退。
4. **接入 hover 读数**：`onActive`（移过）/ `onSelect`（点选钉住）把当前点回传，
   界面在图下方显示「时间 · 数值」。没有它，交互就只剩一根会动的线——读者看到
   高亮圆点，却不知道那个点是多少。
5. **给走势图喂时间标签**（`labels` 数组）：交互版默认念「第 7 个点」，
   喂了桶标签之后念「13时」。桶键 `2026-11-10T14` 在 260px 的 viewBox 里放不下，
   因此按粒度缩成「14时」「10日」「11月」（见 `shortBucketLabel`）。
6. **圆环与构成条同样接入**：hover/点选某段时那一段会高亮，并报出它的占比与数值。

**代价**：产物从 24.8 KB / gzip 11.2 KB 涨到 68.0 KB / gzip 23.5 KB。仍是按需下载的
分块，不进首屏。

**过程中修掉的三个真实问题**：

1. **块注释里的 `*/` 提前闭合了注释**：注释里写 `**/interactive**` 时，`*/`
   正好闭合了 JSDoc 块，后面所有内容变成代码——chunk 直接语法错误、加载失败。
   改成不带 `*/` 的写法。
2. **CSS 里的反引号破坏了外层模板字符串**：产物用模板字面量拼接时，
   `JSON.stringify` 出来的 CSS 里含反引号（CSS 注释里有 `[data-mc-ink]`）会提前
   闭合模板。改为**用数组 join 拼装**（头 + 产物 + 尾），不再把第三方内容
   嵌进模板字面量。
3. **交互读数状态又踩了跨作用域的坑**：`trendReadout` 定义在组件里，却被
   组件**外部**的 `renderStatsTab` 直接引用 → `ReferenceError` → 整页崩掉。
   这与上一轮 `hiddenPoints` 是同一类错误，这次一次把两张图的读数都改走 props。

**验证**：
- 新增 `test/client-charts-chunk.test.js`（5 项）专门盯**构建产物**：语法正确、
  只依赖 react、注册协议正确、导出全部图型 + 样式、**交互层真的挂上了**
  （`data-mc-host` / `tabindex="0"` / `aria-live`）、CSS 具备图形可见性所需规则。
  这条测试能挡住「悄悄退回静态入口」——实测把产物里的 `data-mc-host` 改掉，
  该用例立刻变红。
- 测试桩补上 `useLayoutEffect` / `useMemo` / `useSyncExternalStore`：原来的桩
  只有 `useState`，静态版一切正常，**交互坏了这件事在测试里根本不会暴露**。
- 真实浏览器端到端：在 Chrome 里用 `PointerEvent` 扫过走势图，`onActive` 触发
  **6 次**，最后一次回报 `{index:5, value:7}`，与最后一个数据点一致；截图可见
  十字线、高亮端点与读数气泡（「12」）以及图下方的「13时 → 12」。
- 全套 666 项通过，`verify-wiring` 通过。



## DEC-054 圆环图例可点击隐藏；横向对比改为自绘排序条（2026-11-10）

用户报的两个问题，都是「图看起来没问题，但其实没传达信息」那一类。

### 一、圆环图例可点击，隐藏后重新归一化

**背景**：用户原话——「决策点 的每个项目可以点击来改变是否在饼状图里参与显示，
这样`工具调用`这种常年 95% 占用以上的决策点可以不参与柱状图绘制方便查看其他决策点的相互比例」。

**决定**：

1. **图例项做成 `<button>`**（不是带 onClick 的 div）：它是可操作控件，键盘用户必须
   能 Tab 到、Enter/Space 触发，读屏软件也要念成「按钮」。
2. **占比的分母跟着可见项走**。这是功能的意义所在：排除「工具授权」之后，剩下的点
   重新归一到 100%，彼此比例才看得清。若分母始终用全量总和，隐藏后留下的是几个
   2%、3% 的小数——比例关系依然读不出来，功能等于没做。同时把「被隐藏的部分占全量
   多少」单独写在图下方，免得读者以为看到的就是全集。
3. **颜色按决策点 id 固定，不按可见顺序**。这是本功能能不能用的关键：若颜色跟着
   「第几个可见项」走，隐藏掉第一名之后，原本第二名的颜色会顶到第一位——每点一次
   整张图换一套配色，读者无法在两次操作之间比较。实现上预先按**完整列表**的索引
   给每个 id 分配 `--mc-cat-N`，再通过 `colors` 显式传给图型。
4. **存「被排除的」而不是「被选中的」**。默认全显示，用户点掉不想看的那一个。
   若存「被选中」，区间换了、决策点集合变了时默认值会变成「什么都不显示」——
   一屏空白，而不是一份正常的图。
5. **全部隐藏时不画空环**，改为提示「所有决策点都被隐藏了，点击下面的图例可以重新显示」。
   空环会被读成「这段时间没有数据」，而真相是用户的排除操作——两者行动建议完全不同。

**修掉的一个真实 bug**：第一版把 `hiddenPoints` 定义在组件里，却在**组件外部**的
`renderStatsTab` 里直接引用，渲染时抛 `ReferenceError: hiddenPoints is not defined`，
表现为整页崩掉（而不是圆环不显示）。改为走 props 传递。

### 二、横向对比的柱状图「只有白色，没有文字，没有比例，没有不同颜色」

**背景**：用户原话——「横向对比（provider × model）的横向柱状图只有白色，没有文字，
没有比例，没有不同颜色」。

**根因**：第一版用的是 `charts.MiniBar` 横向模式。实测这个用法根本表达不了这层信息：

- **不画任何标签**：`label` 只有纵向的 `"max"` 一种，横向没有；
- **不能按条上色**：所有条共用同一个 `color`；
- **不能拼成对齐的图**：给单条数据配 `domain` 后，三条不同数值画出来都是**满宽**
