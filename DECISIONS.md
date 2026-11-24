# DECISIONS.md — 设计决策日志

<!-- APPEND-ONLY LOG: 新条目插入到此行之后 -->

## DEC-083 把 8355 行的 client.js 拆成 lib/client-src 分片，构建期拼回单文件 bundle（2026-11-25）

**背景**：`lib/client.js` 涨到 8355 行 / 318 KB，远超 AI_CODING 的 500 行文件预算。后果是具体的：`grep` 一次命中一屏、读一段就要花掉大量上下文，而且「配置页」「统计页」「图表」「i18n」四种职责挤在同一个路径里，改任何一处都要先读完整个文件才能确认该动哪里。

**关键约束（决定了拆分形态）**：宿主把 `client.js` 当**单文件浏览器 bundle** 直接加载（`window.__ModuleLoader__.load({ factory })`）。factory 收到的 `require` 只解析 shell 的共享模块表，**加载不了本包的其它源文件**；`require.async("./client.<name>.js")` 虽然存在，但它把内容变成**异步分块**——配置页是首屏同步渲染的，拆成异步块会让面板先空白一段时间，且分块失败就等于设置页没了。所以「拆成多个 ES 模块、运行时 import」这条路在宿主约束下不可用。

**决定**：

- **源码分片 + 构建期拼接**：新增 `lib/client-src/NN-<职责>.js`（39 个分片），`scripts/client-bundle.mjs` 按文件名前缀顺序**纯连接**成 `lib/client.js`；`scripts/build-client.mjs` 只做读写与 `--check`。沿用 DEC-051 已经立过的套路（可编辑源单独放、构建期嵌进 bundle），只是把范围从「CSS 与控件」扩到整个 bundle。
- **拼接是纯连接，不做任何空白规整**：分片是原文件的字符区间切片，只有纯连接才能保证产物逐字节等于拆分前。这条是「拆分没改行为」的机械证明，不是靠人眼比对。
- **切分点按「可读边界」吸附，而不是硬编码行号**：`scripts/split-client-once.mjs` 里存的是锚点 + 吸附规则（优先语句级边界，退而求其次接受编号注释行）。主分支上代码上下挪几行不会让切分点落进表达式中间——本条目落地时就撞上过一次（main 期间前进了两个提交，`client.js` 多了 135 行）。
- **单次切分脚本保留在仓库里**：它记录「原文件 → 分片表」的映射，并在写盘前断言拼回结果与原文逐字节相同；同时**拒绝再次运行**（分片已存在即报错），因为重跑会把构建期覆盖区里的展开副本写回分片。
- **两份可编辑源继续覆盖分片内容**：`lib/client.config.css` 覆盖 `CFG_SECTION_CSS` 模板字符串正文，`lib/client.config-controls.js` 覆盖 `BEGIN/END CONFIG CONTROLS` 之间。改样式仍然改 CSS 文件、不改分片。
- **分片里那两块只留占位注释，不留展开副本**：既然构建期一定会覆盖，分片里再存一份就是「改了不生效」的静默失效陷阱。占位注释明确写出「构建期由哪个文件覆盖」。
- **旧 `scripts/sync-config-css.mjs` 删除**，职责并入 `build-client.mjs`；`package.json` 新增 `build:client`。
- **拆分后每个分片 ≤ 500 行**（最大 418 行），并新增 `test/client-build.test.js` 把预算钉成断言，防止分片重新长大。

**为什么**：

- **单一写入路径**：分片是唯一可编辑源，bundle 是产物。之前任何人都可以直接改产物，改完还没有任何机制告诉你「源码在哪」——拆分后这种歧义消失。
- **构建一致性必须被测试守住**：拆开之后多了一类只在提交时才暴露的事故——改了分片忘记构建，浏览器拿旧 bundle，而所有渲染测试都对着产物跑、全绿。所以把「产物 == 构建(源)」写成断言。
- **纯函数与 CLI 分离**：第一版把构建逻辑和写文件放在同一模块，测试 `import` 它会**顺手把 bundle 重新生成**——漂移断言在比对之前就被自己的 import 悄悄修好了，测试永远绿（实测：故意制造漂移后仍然 5/5 通过）。改成 `client-bundle.mjs`（纯函数、无副作用）+ `build-client.mjs`（读写 + CLI）后，漂移才真的会红。这是本次最重要的实现细节。

**被否决的方案**：

- **拆成运行时 ES 模块 / 动态 import**：宿主 factory 的 `require` 解析不到本包其它文件；`require.async` 是异步分块，会让首屏配置页变成空白等待，且分块失败即设置页不可用。
- **拆成多个 `client.<name>.js` 分块按需加载**：配置页是首屏必需的，拆块只增加失败面，不减少首屏体积（首屏本来就要它）。
- **保留 `sync-config-css.mjs` 另加一个拼接脚本**：两个脚本都要读同一批分片、都要处理同样的漂移判定，属于「两个文件都能改同一件事」的歧义，合并成一个。

**验证**：

- 切分当次（基线 main = DEC-082）：39 个分片拼回与原文**逐字节一致**（317895 字节）。
- 构建往返：`node scripts/build-client.mjs` 后与拆分前 `client.js` 相比只差 1 行注释（指向新脚本），语义为零；一遍 `diff` 零差异。
- `test/client-build.test.js`（新增 5 项）：产物与分片同步、分片按前缀升序且以换行结尾、每片 ≤ 500 行、bundle 内嵌 CSS/控件与两份可编辑源逐字一致、分片里的可编辑源只留占位不留展开副本。
- **红→绿证据**：在 `01-header.js` 末尾追加一行 → 「产物与分片同步」失败；在 `client.config.css` 末尾追加一行 → 同步用例与内嵌用例**两条**同时失败；把 `associateConfigControl` 正文塞回占位区 → 「只留占位」失败；撤销后均恢复 5/5。
- `node --test --test-concurrency=1 test/`：**919 项 / 919 通过 / 0 失败**（基线 914 + 新增 5）。`node scripts/verify-wiring.mjs`：全部接线检查通过。
- **发布包不受影响**：`package.json` 的 `files` 增加 `!lib/client-src`，分片只是开发期源码，不进 npm 包。

**改动文件**：`lib/client-src/`（新增 39 个分片 + README）、`lib/client.js`（改为构建产物，内容仅 1 行注释变化）、`scripts/client-bundle.mjs`（新增，纯构建逻辑）、`scripts/build-client.mjs`（新增，CLI）、`scripts/split-client-once.mjs`（新增，一次性切分与逐字节校验）、`scripts/sync-config-css.mjs`（删除，职责并入）、`test/client-build.test.js`（新增）、`package.json`（`build:client`、`files` 排除 `lib/client-src`）、`docs/local-dev-link.md`（补构建流程）、`DECISIONS.md`。

## DEC-082 服务提供方 picker 改成 grid 线框按钮：选中反色、已配 Key 标小字（2026-11-25）

**背景**：配置页「服务提供方」原来是一个 `<select>` 下拉：要确认「现在用的是哪家」得点开、在长列表里找高亮项，更没法一眼看出哪些 provider 已经配过 key。用户要求把 picker 改成 grid 线框按钮，放在标题与说明之间，选中项用高亮底色 + 文字反色表示，已配置的 provider 在按钮右侧用小字标 `已配置Key`，方便查看和切换。

**决定**：

- **picker 从 `<select>` 改成一组 `button[aria-pressed]`**：每个 provider 一格（`options = catalog`，含 custom），grid 用 `repeat(auto-fit, minmax(88px, 1fr))` 自然换行。按钮放在 `de-cfg__text` 里、title 与 hint 之间；hint 随当前选择变化，正好在按钮下方解释刚选的那家。
- **选中态用 `aria-pressed` 表达、CSS 画高亮反色**：`.de-cfg__provider-grid button[aria-pressed="true"]` 用 `--de-accent` 做底色、`--dsw-alias-state-business-contrast`（回落 `--de-surface`）做文字色，边框同强调色。语义由 `aria-pressed` 承担，视觉由 CSS 承担，测试断言 `aria-pressed=true` 恰好一个且随点击切换。
- **「已配置Key」角标只读服务端下发的 `keyStatus`**：与「删除配置」行用同一份判断（明文不回传，凭据 / config.yml / 环境变量三个来源只有服务端算得准）。每个 provider 独立判断，角标是 button 内的 `<span class="de-cfg__provider-grid-key">`，选中时用更高 opacity 保证反色底上也读得清。
- **`configRow` 加可选第 6 参数 `beforeHint`**：渲染在 label 与 hint 之间；传入的控件同样走 `associateConfigControl`，让按钮自动挂上 `aria-labelledby` / `aria-describedby`（复用既有可访问性链路，不另写一份）。第 5 参数 `note` 语义与位置不变，老调用点逐字兼容。
- **交互与旧下拉一致**：点按钮 → `setProviderDraft` + `setProviderError("")` + `scheduleSave({providerDraft}, true)`；`busy !== ""` 时整体禁用；catalog 为空时降级为单个禁用按钮，不空白。`EN_CONFIG` 增加 `已配置Key → Key set`，英文界面不夹中文。

**为什么**：

- **grid 按钮把「有哪些、选了谁、谁配了 key」三件事压进一屏**：下拉只回答「当前选了谁」，另外两件要逐个点开才能看到，与「方便查看和切换」的目标直接冲突。
- **位置放在 title 与 desc 之间**：说明是当前的解释，必须紧跟在被解释的控件下面；放在右侧 control 区会让 10 个预设挤成一条窄栏，说明与控件分家。
- **角标以 `keyStatus` 为准**：输入框内容只是用户此刻的草稿，不代表已经落盘；用凭据文件里的状态判断才不会被「粘贴了但没失焦」骗到。
- **`aria-pressed` 而非自定义 class 表达选中**：既拿到无障碍语义，又能复用 `associateConfigControl` 对 `aria-pressed` 按钮的既有处理，不引入第二套键盘/读屏路径。

**被否决的方案**：

- **保留 `<select>`、只在旁边加「已配置」列表**：否决。查看与切换仍要两步，没解决用户要的「一眼看清」。
- **用前端 key 输入框内容或顶层 `view.keyConfigured` 判断角标**：否决。前者可能是未提交的草稿，后者只是「生效 provider」的状态，都不能回答「这家 provider 到底配没配 key」。


## DEC-081 模型级 capabilities 覆盖 provider 级：同一家不同模型可以有不同脾气（2026-11-25）

**背景**：用户给出 decisionmodels.io 的模型说明：s1-fast 是快速文本模型，s1-pro 处理较难判断且每次最多收三道题，s1-vision 接受图片。此前 DEC-079 的 `maxQuestions` 写在 provider 层（decisionmodels 填 1，取默认模型 s1-fast 的保守值），DEC-078 的 `capabilities` 也只写在 provider 层。这与事实冲突：上限与能力都是**模型**属性——把 1 套到 s1-pro 上会让它被无谓拆成四发，把 `thinkMode:false` 写死在 provider 层则挡住「某款模型重开该字段」的可能。用户要求：把 capabilities 加进 `models` 数组每个对象的配置里，模型的配置 override provider 的配置。

**决定**：

- **`providers.json` 的 `models` 数组每项从「字符串」扩展为「字符串或 `{ id, capabilities }` 对象」**：字符串写法原样兼容（归一成空能力对象），对象写法给该模型声明自己的 `capabilities`。`preset.models` / `knownModels` / `catalog.models` 仍是 id 清单，既有消费者逐字不变；新增 `preset.modelCapabilities`（模型名 → 自己的能力表）承载对象里的声明。
- **新增 `effectiveCapabilities(preset, modelId)`（数据层纯函数）**：provider 表打底、模型表逐键覆盖（未知键同样覆盖、原样透传）、协议事实兜底（`thinkMode` 只有 systemone 协议才可能 true）。合并产生新对象，绝不写回 preset 自己的表，因此按不同模型反复合并不互相污染。
- **`resolveProvider` 按生效模型解析**：custom / preset 两个分支的 `capabilities`、`supportsThinkMode`、`maxQuestions` 都改读 `effectiveCapabilities(preset, model)`。`maxQuestions` 优先取模型能力里的值，没声明时回落 provider 级 `maxQuestions`（老 JSON 不写模型能力也照常工作）。server 下发分支不变（下发值不声明能力）。
- **传输层读生效值**：`buildRequestBody` 的 `think_mode` 判断从 `preset.supportsThinkMode === false` 改为 `provider.supportsThinkMode === false`——后者是 resolveProvider 合并后的结果，模型重开字段时请求体里才真的会出现它。
- **`providerCatalog()` 下发 `modelCapabilities`（每个模型合并后的表）**：provider 级 `capabilities` 保持「默认模型视角」给老界面，行为逐字不变；新界面按当前选中的模型改读 `modelCapabilities[modelValue]`。
- **界面按选中模型取能力**：`capabilityOf(key)` 优先读 `activeProvider.modelCapabilities[modelValue]`，没有该表或该模型时回落 provider 级表，再没有才按 true。于是同一 provider 换模型时「思考模式」下拉的可用状态跟着变。
- **`decisionmodels` 预设改造**：四个模型改成对象写法，`s1-fast` 声明 `maxQuestions: 1`，`s1-pro` / `s1-vision` / `reax-1` 声明 `maxQuestions: 3`，`s1-vision` 另声明 `vision: true`（未知能力键，验证透传）。provider 级 `capabilities: { thinkMode: false }` 保留，作为所有模型的共同默认值。

**为什么**：

- **能力必须跟着模型走**。DEC-079 已经确认上限是模型属性，但当时把它压在 provider 层是权宜之计（默认模型 s1-fast 的保守值）。现在用户明确要求模型级覆盖，保守值继续套在所有模型上就成了谎报：s1-pro 白拆四发，既多花请求又多等延迟。
- **模型只覆盖自己声明的键**。逐键合并而不是整表替换，是因为 `thinkMode:false` 这类「全模型共同事实」写在 provider 层一次就够；模型只说「我和别人不一样的那几项」。这也让未知能力键天然可扩展——数据层不认识就不吞。
- **协议事实仍优先**。非 systemone 协议的请求体里根本没有 `think_mode`，即使模型声明 `thinkMode:true` 也不能让能力表说谎（DEC-078 的同一条约束）。
- **三层都读同一张合并表**。界面与传输层若各实现一遍合并规则，就会回到「界面说支持、请求体里没有」的静默失效（docs/lessons/provider-capabilities.md 的教训）。把合并收在数据层一个函数里，两侧只消费结果。
- **字符串写法必须兼容**。老 JSON、外部脚本、`test/provider-json-catalog.test.js` 都按字符串数组读写 `models`；改成只收对象会让升级变成一次破坏性变更。

**被否决的方案**：

- **只把 `maxQuestions` 挪到模型上，其它能力仍在 provider 层**：否决。用户要求的是整个 capabilities 都能被模型覆盖；只挪一个字段等于把「模型级能力」做成特例，下次加能力还要再改一遍。
- **模型整表替换 provider 表**：否决。那样每款模型都要重复声明所有共同能力，漏一个就丢一个（DEC-078 已经吃过「界面一份、传输层一份」的亏）。
- **在界面里按模型 id 判断能力**：否决。那是把服务商的脾气抄进前端，新增一家就要改前端，漏改就是静默失效。
- **让模型声明盖过协议事实**：否决。请求体形状由协议决定，声明盖不过事实，否则能力表可以说谎。

**验证**：

- `test/model-capabilities.test.js`（新增，7 项）：对象/字符串两种写法归一、模型覆盖 provider（含未知键、provider 表不被改脏）、协议优先、decisionmodels 各模型能力、传输层读生效表、catalog 按模型下发合并表。
- `test/question-batching-route.test.js`（+1 项）：真实 `StartluxClient` + 桩 fetch，四问授权集在 s1-pro（上限 3）下拆成**两发**（s1-fast 是四发），答案合并后仍能解析出裁决。
- `test/client-ui.test.js`（+3 项）：选中模型声明 `thinkMode:true` 时下拉可用、换到不支持的模型即禁用、老服务端不下发 `modelCapabilities` 时回落 provider 级表。
- `test/providers.test.js`（修订 1 项）：JSON 里的 models 可能是对象，比对时先取 id 再与归一的 `preset.models` 比对。
- 红→绿证据：实现前新增的 `test/model-capabilities.test.js` 因缺少 `effectiveCapabilities` 导出而整文件加载失败；数据层实现后 4/7 通过、3 项仍红在 resolve/catalog/请求体；三层接线完成后 7/7 通过。
- `node --test test/`：**910 项 / 910 通过 / 0 失败**（基线 899 + 新增 11）。`node scripts/verify-wiring.mjs`：全部接线检查通过。

**改动文件**：`lib/providers.json`（decisionmodels 模型改成对象写法 + 各模型能力）、`lib/provider-presets.js`（`modelDefsOf` + `effectiveCapabilities` + `modelCapabilities`）、`lib/providers.js`（三个 resolve 分支按模型合并、catalog 下发 `modelCapabilities`）、`lib/wire-protocol.js`（读生效 `supportsThinkMode`）、`lib/client.js`（`capabilityOf` 按选中模型取值）、`test/model-capabilities.test.js`（新增）、`test/question-batching-route.test.js`、`test/client-ui.test.js`、`test/providers.test.js`、`README.md`、`README.zh.md`、`config.example.yml`、`DECISIONS.md`。


## DEC-080 配置页「删除配置」按钮：只删该 provider 的 API Key，两处存储按当前位置清（2026-11-25）

**背景**：用户多处配置过 key 后，没有界面入口把某一家已经配好的 key 撤销——只能去 `~/.dsh/.credentials.yaml` 手删 refs 项，或手改 `config.yml`，而 key 存在哪一处还取决于 `keyStorage`，用户根本不知道该改哪个文件。用户明确要求：在配置页「连接方式」分组、连接方式下方显示一个删除配置按钮，删除该配置；并在确认范围时选择「只删除 API Key」（模型 / 地址 / 变量名等其它设置保留）。

**决定**：

- **服务端新增 `DELETE /api/decision-engine/config/key`**：请求体 `{ provider }`，校验 provider 必须是预设之一，否则 400 且不碰任何凭据。按当前 `cfg.keyStorage` 决定删哪里：`credentials` → `writeCredentialToDsh(refName, "")` 清凭据文件 refs 项；`config` → `persistConfig({ [keyField]: "" })` 把 config.yml 里该 provider 的显式 key 字段清空。返回与 `/status` 相同的完整状态（`keyStatus` 随之刷新），前端一次对齐草稿与服务端状态。
- **只删当前生效位置的那一把**：`keyStorage=config` 时不顺手删凭据文件里同名的 ref（沿用 persistKeys 的既有约定——换回 credentials 模式时旧值还能用）；`credentials` 模式下也不去清 config.yml 里的明文。删除范围只针对 key，不动 provider / 模型 / base URL / 密钥变量名。
- **config.yml 里按键保留空行**（`systemoneApiKey:` 无值），不把整行删掉：`applyConfigUpdates` 的既有语义是「保留注释与顺序」，空值解析出来就是未配置；明文 key 字节不残留。
- **界面：已配置 key 时才显示**（用服务端下发的 `keyStatus[id].configured`，明文不回传、来源服务端最清楚），放在 API Key 行正下方，属于「连接方式」分组。文案说明「删除当前 provider 的 API Key（保留模型、地址等其它设置）」，避免误以为整份配置被清空。
- **先 `confirm()` 再发请求**：密钥正在被使用时误删会让守卫全部降级放行（fail-open），而界面上只少一把 key——是最难自查的故障形态。取消不发请求；确认后发 DELETE 并带当前 provider id，成功后清空该 provider 的 key 输入草稿（防止残留的明文在下次保存时被写回），删除结果走同一条 `msg` 诊断行展示。
- **中英文案进 client.js 的 EN_CONFIG / T_CONFIG 词表**：沿用本插件的 i18n 覆盖测试，不新增硬编码中文。

**为什么**：

- **删除与保存走不同的路由**：保存走 PUT `/config`（防抖、合并、按 provider 分派字段、可能两处写入、失败整体回滚）；删除是一次明确、离散、只针对一把 key 的动作。塞进 `/config` 的空串 patch 会复用那套复杂语义，且按钮「删的是哪一把」无法表达清楚。
- **凭据先写、配置后写**：与 PUT `/config` 同一条失败原则——凭据写失败整体报错，不让界面假装成功；配置写失败也如实返回错误，但删除本身已经落盘，不能伪造「没删成」。
- **按钮条件用服务端状态而不是输入框**：key 可能来自凭据文件 / 环境变量 / 服务端下发，输入框里什么都没有；用输入框判断会让「已配置」的 provider 永远看不到删除入口。

**被否决的方案**：

- **删除该 provider 的全部配置**（provider / 模型 / 地址 / 变量名一起清）：用户明确选了「只删除 API Key」；整份清空代价大且不可逆。
- **两处存储一起清**：否决。与 persistKeys 的既有约定（切换 keyStorage 不清另一处）冲突，还会把用户刻意保留的旧值删掉。
- **把删除按钮放在页脚或独立分组**：否决。它操作的是 API Key，必须与 API Key 行同组、紧邻，否则与它删的对象脱节。
- **把空值写成删除整行**：否决。破坏 `applyConfigUpdates` 的注释/顺序保持语义；空值本就等价未配置。

**验证**：

- `test/delete-key-route.test.js`（新增，7 项）：凭据模式删除（其它 provider 的 key 与 records 段保留）、config 模式删除（明文消失、空行保留、模型/开关不动）、删除不存在的 key 是空操作、未知 provider 被拒且不碰凭据、删除后再次 GET /status 仍是未配置、config 模式不动凭据里的旧 ref、凭据文件不存在时安全返回。
- `test/client-ui.test.js`（+3 项）：已配置时连接方式分组出现 `data-field=deleteKey` 行与按钮、未配置时不出现、点按钮先确认（取消不发请求）且确认后发一次 `DELETE /config/key` 并带当前 provider id。
- 红→绿证据：实现前 `delete-key-route.test.js` 7/7 失败在「应注册 DELETE 路由」、两条 UI 用例失败在「应有删除配置行」；实现后分别 7/7、3/3 通过。
- `node --test --test-concurrency=1 test/`：**899 项 / 899 通过 / 0 失败**（基线 889 + 新增 10）。`node scripts/verify-wiring.mjs`：全部接线检查通过。

**改动文件**：`lib/index.js`（新增 DELETE `/config/key` 路由）、`lib/client.js`（`deleteKey()` + 连接方式分组的删除行 + 中英文案）、`test/delete-key-route.test.js`（新增）、`test/client-ui.test.js`、`DECISIONS.md`。




## DEC-079 按「单次请求的题目上限」拆题：decisionmodels 的 s1-fast 只收 1 道（2026-11-25）

**背景**：用户报「openai、decisionmodels.io 两者请求都失败了，fallback to free model」。实测两家的失败**完全不同**：

- **OpenAI**：`HTTP 429 insufficient_quota / credit_balance_exhausted`——账号余额为 0，与插件无关。
- **decisionmodels**：`HTTP 400 too_many_questions`，`GET /v1/models` 写着 `s1-fast` 的 `max_questions: 1`，而本插件的决策点动辄一次问 2–4 道（授权点 4 道、turnStop 4 道、route/delegate 各 3 道）。于是**每一次**决策都被整笔拒掉后静默降级：面板显示「已连接、模型正确」，守卫一次都没生效过。八个决策点里只有 `skillPick`（1 道题）能过。

上限是**模型**属性而不是服务属性：同一家的 `s1-pro` / `reax-1` 是 3、`s1-llm-auto-router` 是 7。

**决定**：

- **新增 `lib/question-batching.js`（纯函数 + 一个记忆表）**：`chunkQuestions` 按上限切份（顺序不变、不超上限时原样一份）、`mergeAnswers` 合并、`isTooManyQuestions` 认拒绝信号、`QuestionLimitMemory` 按「provider × baseUrl × model」记学到的上限（只往小改）。
- **`providers.json` 新增 `maxQuestions` 字段**（0 / 缺省 = 不限制），decisionmodels 预设填 `1`（默认模型 s1-fast 的保守值）。服务端下发分支固定 0——下发值不声明上限，行为与改动前逐字一致。
- **`index.js` 的 `#attempt` 拆成两层**：原实现改名 `#attemptOnce`（单次请求，题目已切好），新的 `#attempt` 负责「算上限 → 切份 → 串行发 → 合并答案」。**不超上限时逐字走原路径**（一次请求），绝大多数 provider 不多出任何请求或延迟。
- **没声明上限的服务自愈**：单发被 `too_many_questions` 拒时，学成 1 并拆开重发一次。这不是重试策略——它换的是**请求形状**，不是把同一份请求再发一遍。
- **任何一份失败即整体失败**：只拿半份答案就裁决，等于让决策点的 `parse()` 对着缺字段的对象判断（返回 undefined），看起来像降级、实际是「一部分题目根本没问」。

**为什么**：

- **声明 + 学习，两条都要**。只有声明：用户填了没预设的服务（自建 vLLM、中转）仍会静默失效。只有学习：每次决策都要先被 400 拒一次再拆开重发，多一次注定失败的往返，遥测里持续出现 `http-400`，看起来像服务坏了。
- **上限必须跟着模型走**。按 baseUrl 记会把 s1-fast 的 1 套到 s1-pro 上（拆多了，只是多几次请求），反过来把 3 套到 s1-fast 上就是再次静默失效。
- **串行而不并发**：这些题目属于同一次决策，并发会把单次决策放大成 N 倍瞬时并发，而限流（429）恰好是本插件最不该自己制造的东西。
- **token 与延迟按整次决策累加**：拆成三发时用户等的是三发之和，遥测记的也该是这一次决策的真实消耗。有一发没报 usage 就不假装知道总数（保持 undefined，与单发语义一致）。

**被否决的方案**：

- **遇到 400 就自动换模型**（s1-fast → s1-pro）：否决。那等于替用户改配置（DEC-037/062 同一条约束），而且 s1-pro 贵 3 倍（$0.097 vs $0.032 / 百万 token）。
- **把 decisionmodels 预设的默认模型改成 s1-pro**（上限 3）：否决。仍不够（授权点与 turnStop 各 4 道），且贵 3 倍；拆题才是通用解。
- **按 baseUrl 记上限**：否决。上限是模型属性，见上。
- **并发发各份题目**：否决。理由见上（自造限流）。
- **学到的上限可以被更宽松的值覆盖**：否决。学到的值来自一次真实拒绝，比猜测可信；拆分不足会静默失效，拆分过多只是多几次请求。

**顺带修掉的第二个缺陷**：`scripts/verify-endpoint.mjs` 自己拼 `{ state, questions, think_mode }` 并自己读 `body.answers`，**绕过了线协议层**。后果是它对 OpenAI 报「HTTP 400 Missing required parameter: 'model'」——而插件运行时其实是 429 余额不足，两个完全不同的结论；对 decisionmodels 则把「只收一道题」误报成端点不可用。现在改为走 `buildHeaders` / `buildRequestBody` / `readAnswers` + 同一套 `chunkQuestions`。验收脚本必须和插件同一条路径，否则它说的不是插件的事。

**验证**：

- `test/question-batching.test.js`（新增，9 项）：上限归一、切份（顺序 / 每份只含自己的题 / 不超上限时原样一份）、畸形输入不抛、合并、拒绝信号识别（不误判普通 400）、记忆表（只往小改 / 按模型分开 / 畸形 provider 不抛）、`runChunks`（串行保序 / 一份失败即停 / 空输入不抛）。
- `test/question-batching-route.test.js`（新增，4 项）：真实 `StartluxClient` + 桩 fetch 走 `classify()`。四问授权集在 `maxQuestions: 1` 下拆成 4 次请求、每次只带自己那道题、答案合并后 `extractGuardAnswers` 真的解析出裁决；未声明上限时仍是一次请求发完；某一份失败即整体 `http-400` 且不返回半份答案；未声明上限的服务回 `too_many_questions` 时学成 1 并重发（第一次 5 发、第二次直接 4 发）。
- `node --test test/`：**877 项 / 877 通过 / 0 失败**（原 864 + 新增 13）。
- `node scripts/verify-wiring.mjs`：全部接线检查通过。
- **真实端点验收**（`node scripts/verify-endpoint.mjs`）：decisionmodels **8/8 个决策点通过**（改动前 0/8）；OpenAI 仍为 0/8，但原因已明确是 `429 credit_balance_exhausted`（账号余额为 0，不是形状问题——同一份请求在 429 之前已通过参数校验）。

**改动文件**：`lib/question-batching.js`（新增）、`lib/index.js`（`#attempt` 拆两层 + `#sendChunks`）、`lib/providers.js`（provider 上暴露 `maxQuestions`）、`lib/provider-presets.js`（解析 `maxQuestions`）、`lib/providers.json`（decisionmodels 填 1）、`scripts/verify-endpoint.mjs`（走线协议 + 分批）、`test/question-batching.test.js`（新增）、`test/question-batching-route.test.js`（新增）、`docs/lessons/max-questions-per-request.md`（新增）、`DECISIONS.md`。

## DEC-078 配置项按 provider 能力表个性化显示：能力写进 JSON，UI 与传输层共用一张表（2026-11-25）

**背景**：用户提出「不同 provider/model 对请求参数有不同要求，能不能在 `lib/providers.json` 里给他们定好参数，然后 UI 配置层根据参数决定个性化显示配置项」。这不是假设——`decisionmodels.io` 实测对 `think_mode` 回 400 `{"loc":["think_mode"],"msg":"Extra inputs are not permitted"}`，而 `google-decisions` / `openai-decisions` 的请求体里根本没有这个字段（它们用 `input` / `questions`）。此前的第一个补丁（`19e1556`）只在**传输层**跳过了该字段，UI 上「思考模式」下拉仍然无条件显示、可选、可存——用户选了 `always` 什么也不会发生，正是本插件反复强调的「配了没反应」。

**决定**：

- **能力写进 `lib/providers.json` 的 `capabilities` 表**：`{ "thinkMode": false }` 表示该端点不接受 `think_mode`。表是**开放**的——数据层不认识的新键原样下发，因此以后加一种能力只需要改 JSON，前端与传输层都不用动。
- **协议事实优先于 JSON**：只有 `systemone` 线协议有 `think_mode` 字段，另两种协议恒为 `false`——即使在 JSON 里写 `thinkMode: true` 也不能改变。否则能力表就成了谎报（请求体里根本没有该字段）。
- **`supportsThinkMode` 保留为 `capabilities.thinkMode` 的别名**（顶层老写法仍被接受）：`19e1556` 已经提交的顶层字段、传输层的读取点、既有测试都还在用它，直接删会造出一次无声的行为变化。
- **UI 读 `capabilities`，不认专用字段**：`capabilityOf(key)` 统一取值，`providerCatalog()` 把整张表下发。界面按 `capabilities.thinkMode` 决定「思考模式」下拉**禁用 + 说明原因**（不是隐藏——隐藏会让人以为设置丢了，也无法解释「为什么我选的 always 没反应」）。
- **拿不到能力表时按「支持」处理**：老服务端不下发这一项，行为与改前逐字一致。

**为什么**：

- **能力必须与请求构造同源**。分成「UI 一份、传输层一份」就会出现「界面说支持、实际发不出去」——那正是这次要消灭的故障。`test/protocols.test.js` 里专门有一条把两者钉在一起：声明 `supportsThinkMode: true` 的 provider，请求体里必须真的能看到 `think_mode`。
- **为什么用一张开放表而不是每项一个布尔**：每加一个参数就加一个专用字段，意味着每加一个参数都要改前端；而界面读的是同一套键，新能力天然被支持。
- **为什么禁用而不是隐藏**：这个插件里已经出现过太多次「静默失效」。隐藏控件让用户无从判断「是我不支持，还是它丢了」；禁用 + 一行说明把答案直接写在界面上。

**被否决的方案**：

- **在 `client.js` 里按 provider id 或协议名写 if/else**：否决。那是把服务商的脾气抄进前端，新增一家就要改前端，漏改就是又一次静默失效（DEC-074 已经为字段名否决过同一类做法）。
- **不支持时直接隐藏「思考模式」整行**：否决。用户看不到这一项，会以为设置丢了或插件坏了；而且「这个端点没有该字段」这条信息本身就值得显示。
- **删掉 `supportsThinkMode`、只留 `capabilities`**：否决。`19e1556` 已提交，传输层与测试都在读它；保留为别名是零风险的向后兼容，删它只为「好看」。
- **让 JSON 里的 `thinkMode: true` 覆盖协议推断**：否决。请求体是协议决定的，声明盖不过事实；允许覆盖只会让能力表可以说谎。

**验证**：

- `test/protocols.test.js`（+4 项）：`capabilities` 与 `supportsThinkMode` 一致；`providerCatalog()` 下发 `capabilities`；未知能力键原样下发；非 systemone 协议即使写 `true` 也按不支持；以及既有的一条「声明支持就必须真的发得出 `think_mode`」。
- `test/client-ui.test.js`（+5 项）：不支持的 provider 上「思考模式」行仍在但下拉 `disabled`；说明文案点明端点没有该字段；支持的 provider 行为不变；切换 provider 时能力跟着变；**界面读的是能力表而不是专用字段**（把 `capabilities.thinkMode` 改成 `false` 即禁用）。
- **变异验证**：把 UI 的 `capabilityOf("thinkMode")` 写死成 `true` → 4 条 UI 用例转红；把传输层的 `supportsThinkMode` 判断删掉 → 2 条协议用例转红。两侧都承重。
- `node --test --test-concurrency=1 test/`：**876 项 / 876 通过 / 0 失败**。`node scripts/verify-wiring.mjs`：全部接线检查通过。

**附记（并行测试的既有 flake，未在本次修复）**：并行跑 `node --test test/` 时 `test/backup-model-route.test.js` 的「primary-is-free」偶发失败（3 次里 1 次）；串行与单文件跑均稳定通过，`main` 基线连跑 4 次也全绿。判断是多文件并行时 `DSH_HOME` 环境变量互相覆盖导致，属于既有测试隔离问题，与本次改动无关；串行即绿。

**改动文件**：`lib/provider-presets.js`（新增 `capabilitiesOf()`，`capabilities` 归一 + `supportsThinkMode` 别名）、`lib/providers.js`（`resolveProvider` 三个分支与 `providerCatalog()` 下发 `capabilities`）、`lib/client.js`（`capabilityOf()` + 「思考模式」行按能力禁用与说明 + 英文文案）、`lib/providers.json`（`decisionmodels` 改用 `capabilities: { thinkMode: false }`）、`test/protocols.test.js`、`test/client-ui.test.js`、`README.md`、`README.zh.md`、`config.example.yml`、`DECISIONS.md`。


## DEC-077 新增 OpenAI Decisions API 预设，并把线协议拆成独立模块（2026-11-25）

**背景**：用户要求把 OpenAI 的 Decisions API（https://developers.openai.com/api/docs/guides/decisions）接成内置预设。它和现有的 System One 系端点**三样都不同**：请求体（`input` 而不是 `state`，`questions` 是带 `name` 的数组而不是对象）、题型名（`noul` 对应 `predicate`）、答案形状（`answers` 是数组，靠 `name` 认领，而不是按 id 索引的对象）。上一个提交（041a2c9，Google AI Studio）已经在 `providers.js` 里加了 `protocol` 字段与 `buildHeaders` / `buildRequestBody` 的分支，但当时没有答案归一这一半。

**决定**：

- **`lib/providers.json` 新增一条 `openai-decisions`**：`baseUrl: https://api.openai.com/v1`、`endpointStyle: decisions`、`protocol: openai-decisions`、`apiKeyEnv: OPENAI_API_KEY`、`requiresModel: true`、`defaultModel: gpt-6-luna`、`models: ["gpt-6-luna"]`。插在 `custom` 之前（`custom` 必须收尾）。三个配置格（`openaiDecisionsApiKey` / `openaiDecisionsModel` / `openaiDecisionsApiKeyEnv`）由预设表自动生成，`index.js` 的 schema / 保存白名单 / `persistKeys` / `rawModels` 一处都不用改——这是 DEC-074 那条抽象的直接收益。
- **线协议拆成 `lib/wire-protocol.js`（251 行）+ `lib/protocols/openai-decisions.js`（192 行）**。`providers.js` 从 927 行降到 767 行，仍超 500 行预算，但本次只搬不重构（拆它是另一件事）。`providers.js` 把 `buildHeaders` / `buildRequestBody` / `readAnswers` / `normalizeThinkMode` / `THINK_MODES` / `DEFAULT_THINK_MODE` 原样再导出，对外 API 不变。
- **答案归一放在传输层**：新增 `readAnswers(provider, body)`，`classify()` 用它取代原来的 `body.answers`。OpenAI 的数组在这里转成内部按 id 索引的对象；`predicate → noul`、`choice`/`score` 的 `probabilities` 数组转成按值索引的对象（`tolerance.js` 的连续严重度靠 `probabilities.high` / `.medium`）。**`refusal` 原样保留**，让各决策点的 `parse()` 判为形状不符 → 降级放行。
- **未知协议回落 `systemone`**，不抛错：`protocol` 是后加字段，老配置、老下发值里都没有；抛错会把「字段写错」放大成整个插件不可用。

**为什么**：

- **答案归一必须和请求构造放在同一层**：协议差异是**成对**出现的（请求换了形状，答案一定也换了）。只做请求那一半，结果是 HTTP 200 + 每次 `answer-shape-mismatch` 降级——面板显示「已连接、模型正确」，守卫却静默不工作。这是本插件历史上反复出现的故障模式（见 `docs/lessons/endpoint-path-vs-model.md`、`model-field-required-by-provider.md`）。
- **为什么不让九个决策点各自处理协议**：漏一个就是那个点静默失效，而决策点是逐个加出来的，后来加的人不会记得再写一遍。放传输层则天然覆盖将来新增的点。
- **为什么 `refusal` 不翻译**：把「模型拒绝判断」映射成 `noul: 0`（= 条件不成立 = 不危险）等于让拒绝变成放行。形状不符即降级，是本插件既有的 fail-open 原则。
- **为什么 `requiresModel: true`**：官方只支持 `gpt-6-luna`，且省略 `model` 会被拒。留空必须回落预设默认，否则「只填一个 API key 就能用」这条承诺落空，守卫还会静默失效。
- **为什么单开 `lib/protocols/` 目录**：OpenAI 这一支是「整套形状都不同」（约 180 行：题型映射 + 答案归一 + 概率归一），不是几行分支。留在 `wire-protocol.js` 会让三种协议挤在一起，且该文件会超预算。

**被否决的方案**：

- **把 OpenAI 当成 `custom` 让用户自己填**：否决。`custom` 只能发 System One 线协议，填了官方地址只会 400/404；用户要的是「选中就能用」的预设。
- **在 `providers.js` 里直接加分支、不拆文件**：否决。`providers.js` 改动前已 927 行，超「单文件 500 行」预算；再塞 200 行只会更难定位。
- **让 `readAnswers` 也处理 `google-decisions` 的答案**：否决。Google 的答案本来就是按 id 索引的对象，与 System One 同形；给它加分支等于凭空造一个不存在的差异。
- **把 `refusal` 当作 `noul: 0.5`（不确定）**：否决。0.5 会让阈值判断落在中间，既不是明确的放行也不是明确的拦截，比直接降级更难解释；而「形状不认识 → 降级」已有明确语义。

**验证**：

- `test/protocols.test.js`（新增，12 项）：预设本身（端点 / key 变量名 / 字段名 / 默认模型 / 协议名）、Bearer 鉴权且不带 `x-goog-api-key`、请求体（`input_json` + `questions` 数组 + `name` + `choices` / `levels`）、答案归一（三种题型各自能被 `readNoul` / `readChoice` / `readScore` 解析）、`refusal` 保留、畸形输入不抛、其它协议答案原样透传、未知协议回落 systemone。
- `test/openai-protocol-route.test.js`（新增，4 项）：真实 `StartluxClient` + 桩 fetch 走 `classify()`。**关键一条**用真实的 `extractGuardAnswers` 解析真实回包——只断言请求体不够，请求对、答案没接上正是上面那个故障。变异验证：把 `readAnswers(provider, body)` 换回 `body.answers`，该用例立刻转红。
- 既有回归：`test/providers.test.js`（provider 清单 / key 字段 / 模型字段三处枚举补 `openai-decisions`）、`scripts/verify-wiring.mjs`（「预设齐备」改 10 家 + 新增「custom 收尾」检查）。
- `node --test test/`：**862 项 / 862 通过 / 0 失败**。`node scripts/verify-wiring.mjs`：全部接线检查通过（含自动生成的三格 `openaiDecisions*`）。

**改动文件**：`lib/wire-protocol.js`（新增）、`lib/protocols/openai-decisions.js`（新增）、`lib/providers.js`（协议实现搬走，改为再导出）、`lib/providers.json`（新增预设）、`lib/index.js`（`classify()` 改用 `readAnswers`）、`test/protocols.test.js`（新增）、`test/openai-protocol-route.test.js`（新增）、`test/providers.test.js`、`scripts/verify-wiring.mjs`、`config.example.yml`、`README.md`、`README.zh.md`、`docs/lessons/openai-decisions-wire-format.md`（新增）、`DECISIONS.md`。


## DEC-076 状态信息与诊断结果跟着「测试端点」进「连接方式」分组，页脚只剩保存状态（2026-11-25）

**背景**：DEC-051 把配置页拆成四组可折叠分组时，「测试端点」按钮被移进了「连接方式」组的最后一项，但它的**结果**——紧凑状态信息（提供方 / 端点 / 模型 / 超时 / 请求次数 / 密钥来源）与 `msg` 诊断结果（`端点连通 ✅ ...` 或失败原因）——仍留在页脚。于是出现「按钮在组里、结果显示在页面最底部」的割裂：用户配完地址点测试，得跨半个页面去对照；更糟的是**「连接方式」一旦收起，刚测出的结果就完全看不见了**，而这一组恰恰是用户配完就会折起来的那一组。用户明确要求：整个测试结果那一段都要跟着挪过去。

**决定**：

- 把 `footerItems` 里的 `meta`（4h）与 `msg` 两个节点整体搬进 `connectionItems` 末尾，成为 2f / 2g，紧跟在 2e「测试端点」按钮之后。
- 页脚 `footerItems` **只保留**自动保存状态行（4g：进行中 / 已存 / 失败原因 + 重试）。页脚从此只回答一件事：「刚才那一下存没存」。
- 搬动是**逐字移动**，不重写内容：文案、`S.meta` 样式、`activeKeyStatus` 的取值理由（必须取当前 provider 自己那一条、显示真实命中的 `sourceLabel`）原样保留，注释跟着一起搬。

**为什么**：

- **「测试端点」和它的结果是一个问题的两面**：状态信息是「现在连的是什么」，诊断结果是「刚才那一下通不通」。拆到两个容器里，用户就要自己把两段对上。
- **折叠是主要风险**：`sectionBlock` 折叠时正文只是 `hidden`、仍在树里，但**视觉上不可见**。结果留在页脚时，收起「连接方式」后按钮和结果分处两个可见性状态，用户会以为「点了没反应」。
- **页脚不该承担两件事**：它常驻、不进任何分组，是因为「存没存」与页面展开状态无关；而「连的这家通不通」恰恰与「连接方式」这一组强相关，留在页脚反而破坏了分组的语义边界。

**被否决的方案**：

- **只把 `msg` 搬过去、状态信息留页脚**：否决。用户要挪的是「整个这个部分」；且状态信息（生效端点、密钥来源）正是判断诊断结果的前提，拆开会让「provider: 书生·端砚 POST ... HTTP 200」这段结果缺少上下文。
- **两处都保留（页脚继续显示、组里再显示一份）**：否决。同一段文字出现两次，改一处忘另一处就是漂移；且页脚那份在折叠后仍然可见，会让人以为结果没跟着走。
- **把整个页脚塞进「连接方式」组**：否决。保存状态行必须常驻——用户在任何一组改动都要能立刻看到「已保存 / 未保存 + 重试」，跟着一组折叠掉就丢了这个反馈。

**验证**：

- `test/client-ui.test.js`「测试端点、状态信息与诊断结果都在连接方式分组，页脚只保留保存状态（DEC-051）」：先把 `msg` 槽（useState 序号 3）注入一份成功诊断结果，断言 ① 连接方式组的最后一项 `data-field` 仍是 `testEndpoint`；② 该组正文含「超时」「密钥来源」「端点连通 ✅」；③ 页脚仍含「改动即保存」，且**不含**「测试端点」「超时」「端点连通 ✅」。改动前该用例失败在「连接方式分组应有状态信息」（红），实现后转绿。
- `node --test test/`：**846 项 / 846 通过 / 0 失败**。`node scripts/verify-wiring.mjs`：全部接线检查通过。

**改动文件**：`lib/client.js`（`connectionItems` 新增 2f/2g，`footerItems` 删除 4h 与 `msg`，页脚注释改写）、`test/client-ui.test.js`（`SLOTS.msg` + 用例改写）、`DECISIONS.md`。



## DEC-074 内置 provider 抽象成 `lib/providers.json`（一个 provider 一个对象，`models` 数组即多个可用模型）（2026-11-24）

**背景**：provider 的地址、端点风格、密钥字段名、默认模型原先写在 `lib/providers.js` 的 `PROVIDER_PRESETS` 字面量里，而「哪些字段要落进配置」又散在 `lib/index.js` 的 `DEFAULTS`、`Config` schema、保存白名单、`persistKeys` 槽位、`buildKeyStatus` 五处逐个列举。于是「加一家服务」等于改 8+ 处代码，漏一处就是静默失效（面板能填、保存时被丢掉；或字段名撞车导致切换 provider 互相覆盖）。用户要求：把内置 provider 抽象成 JSON，每个 provider 是数组里的一个对象，一家服务支持多个模型就写进对象里的数组，以后加自定义 provider 只改 JSON。

**决定**：

- **数据文件 `lib/providers.json`**：顶层数组，每个元素一个 provider，顺序即设置界面下拉顺序。字段：`id`（必填）/`label`、`labelEn`/`baseUrl`/`endpointStyle`/`apiKeyEnv`、`legacyApiKeyEnvs`/`keyField`、`modelField`、`keyEnvField`/`models`（该服务可用的模型，空数组 = 不限定）/`defaultModel`/`requiresModel`/`hint`、`hintEn`/`default`/`customizable`，以及只给老记录用的兼容标记（`legacyBaseUrlField`、`legacyKeyField`、`legacyKeyEnvOverride`、`legacyKeyEnvField`、`legacyModelDefault`、`typedModelsOnly`）。
- **数据层单独一个文件 `lib/provider-presets.js`**（零依赖，只读同目录 JSON 一次）：`parseProviderPresets()` 把数组归一成运行时清单，`PROVIDER_LIST` 是加载即用的结果。`providers.js` 只保留「请求怎么构造、端点怎么拼」，并把 `ENDPOINT_STYLES` / `parseProviderPresets` 原样再导出，对外 API 不变。
- **只有 `id` 必填，其余可推导**：`keyField`/`modelField`/`keyEnvField` 缺省按 id 推导（`my-gateway` → `myGatewayApiKey` / `myGatewayModel` / `myGatewayApiKeyEnv`），`apiKeyEnv` 缺省为 `MY_GATEWAY_API_KEY`，`label`/`labelEn` 缺省为 id，`defaultModel` 缺省取 `models[0]`，`endpointStyle` 缺省 `auto`。所以新增一家服务的最小写法是三行：`{ "id", "baseUrl", "models" }`。
- **坏数据在加载时抛错**：重复 id、两个 provider 共用同一个配置字段、id 不合 `[a-z0-9-]`、空数组、`default: true` 多于一条，一律直接抛。写坏的 JSON 会让插件起不来——这比「切过去没地址 / 没 key」的静默失效好。
- **代码里不再按 id 特判**：`if (id === "custom")` 改为预设的 `customizable` 标记；历史字段兼容改为数据里的 `legacyBaseUrlField` / `legacyKeyField` / `legacyKeyEnvOverride`；`typedModelsOnly`、`legacyModelDefault` 同理。`DEFAULT_PROVIDER` 取 `"default": true` 的那一条。
- **`lib/index.js` 的字段清单改为从数据推导**：`DEFAULTS`、`Config` schema、保存白名单、`persistKeys` 槽位、`rawModels`、`buildKeyStatus` 全部由 `PROVIDER_PRESETS` 生成，新增 provider 三格自动出现。
- **`models` 成为 canonical 字段**，`knownModels` 保留为同一份数据的兼容别名（外部脚本/旧测试在用）。
- **英文文案也走数据**：`providerCatalog()` 一直下发 `labelEn`/`hintEn`，客户端新增 `providerText()` 按语言取；`/status` 补 `providerLabelEn`。于是新增 provider 只写 JSON 的中英两栏，不必再到 `lib/client.js` 的 `EN_LABELS` 里补两行——那份镜像表已经漂移过一次（perplexity / openrouter 的 hint 从没登记）。

**为什么**：

- **为什么是 JSON 而不是 YAML**：YAML 需要新依赖（本插件目标之一是零运行时依赖），而 `JSON.parse` 是内置的；且 JSON 不允许注释、不允许隐式类型，正好避免「`true` 是字符串还是布尔」这类在自研 YAML 子集里踩过的坑。
- **为什么用 `readFileSync` 而不是 `require("./providers.json")`**：`require` 的 JSON 缓存会让「同进程里改数据再断言」永远读到旧值，测试无法覆盖解析与校验；ESM 的 JSON 导入语法（`assert` / `with`）在 Node 20.3 与 22 之间不兼容，与 `engines.node: >=20.3.0` 冲突。`readFileSync` 在模块加载时只跑一次，不在请求路径上。
- **为什么校验放数据层而不是 `resolveProvider`**：数据错误是**启动期**问题，应当在加载时就炸；`resolveProvider` 在每次决策的热路径上，那里抛错会把一次「配置坏了」放大成每步都失败，而守卫是 fail-open 的，结果仍是静默。
- **为什么拆出 `provider-presets.js`**：`providers.js` 在改动前已 1038 行，超过「单文件 500 行」的预算；再往里塞 190 行归一与校验只会更难定位。按职责拆（数据 vs 线协议）后 `providers.js` 875 行、数据层 186 行，且数据层可脱离线协议单独测。
- **为什么保留 `knownModels` 别名**：`scripts/`、`bench/` 与既有测试按这个名字读；同时保留 `models` 与 `knownModels` 两个名字是唯一的重复，注释里写清「同一份数据」，不引入第二个真相源。

**被否决的方案**：

- **把 `default: true` 也留给代码（硬编码默认 provider）**：否决。这样「换默认 provider」仍要改代码，与「只改 JSON」的承诺不一致；且新增 `default` 标记后测试可以断言「恰好一条」。
- **允许 `label`/`hint` 缺省为空串，让界面回落到 id**：否决。缺省文案会让下拉出现空白项，用户以为是加载失败；统一回落到 id 至少可读。
- **两个字段名撞车时只警告不抛错**：否决。撞车的后果是「切到 A 再切回 B，B 的值被 A 覆盖」——最典型也最难自查的一类静默失效，必须在加载时就拒绝。
- **支持用户自己的 `providers.json` 覆盖（`~/.dsh/plugins/<dir>/providers.json` 合并内置）**：本次不做。用户当前要的是「改内置数据」，而运行时合并要定义「覆盖 / 追加 / 删除」三种语义与冲突优先级，还会让「你的配置为什么和文档不符」变成常态。`custom` provider 已经覆盖了「接任意服务」的场景；真要多家自定义，值得单独设计一次。
- **把 provider 定义挪进 `config.yml`**：否决。`config.yml` 是**用户**配置（会被面板读改写），provider 定义是**插件**数据（随包发布、随版本更新）；混在一起会让升级覆盖用户改动，或让用户改动被升级冲掉。

**验证**：

- `test/provider-json-catalog.test.js`（新增 3 项）：**复制一份 `lib/` 到临时目录**，往副本的 `providers.json` 里追加一个 `my-gateway`（一家服务三个模型），再真的加载副本的 `lib/index.js`，断言 ① `Config` 能解析 `myGatewayModel` / `myGatewayApiKey` / `myGatewayApiKeyEnv`；② `resolveProvider` 拼出地址 `/systemone`、留空时回落 `m-large`（JSON 里填的显式值），`apiKeyEnv` 推导为 `MY_GATEWAY_API_KEY`；③ `providerCatalog` 的 label/labelEn/models/字段名/requiresModel 全部正确；④ 默认 provider 不受追加影响。另两项分别验证「改 `default` 标记就换默认 provider」与「重复 id 让加载失败并说明原因」。
- `test/providers.test.js`（新增 5 项）：JSON 与运行时清单同源、`models` ↔ `knownModels` 同源、`default`/`customizable` 各恰好一条、`parseProviderPresets` 的最小条目推导出全部字段、坏数据（重复 id / 字段撞车 / 非法 id / 空数组）抛错。既有 59 项全部保持绿色（行为逐字不变）。
- `test/client-i18n.test.js`（新增 1 项）：只存在于 catalog 里的 `acme`（中文 label + `labelEn`，`EN_LABELS` 里没有登记），英文界面显示 `Acme Gateway` 与 `A self-hosted gateway`，且不出现中文 label/hint。
- `node --test test/`：**800 项 / 800 通过 / 0 失败**（改前 792 项全绿；本次新增 8 项）。`node scripts/verify-wiring.mjs`：全部接线检查通过。

**改动文件**：`lib/providers.json`（新增，143 行）、`lib/provider-presets.js`（新增，186 行）、`lib/providers.js`（预设字面量删除、`customizable`/`legacy*`/`typedModelsOnly` 改为读数据、`providerCatalog` 下发 `models`）、`lib/index.js`（`DEFAULTS`、`Config` schema、保存白名单、`persistKeys`、`rawModels`、模型清单过滤改读 `preset.models`、`/status` 补 `providerLabelEn`）、`lib/client.js`（新增 `providerText()`；下拉/说明/统计页展示名按语言取；`isCustom` 改为读 `customizable`）、`test/providers.test.js`、`test/provider-json-catalog.test.js`（新增）、`test/client-i18n.test.js`、`test/client-ui.test.js`、`test/save-path.test.js`、`config.example.yml`、`README.md`、`README.zh.md`、`docs/lessons/model-field-required-by-provider.md`、`scripts/verify-wiring.mjs`、`scripts/verify-endpoint.mjs`、`DECISIONS.md`。
## DEC-075 新增「免费模型兜底」（backup model）：主模型 4xx/5xx 时自动改用免费模型（2026-11-24）

**背景**：用户要求「当指定的 model 出现错误，不管是 429 insufficient balance 还是其他 4xx/5xx 时，如果本插件指定的免费模型可达，则本次调用自动使用免费模型。这个功能是可选项，默认关闭。当然这就要求本插件需要提前自动下载免费模型配置。」

现状的痛点很具体：用户填了自己的决策服务后，一旦额度用光（429/402）或 key 失效（401/403），守卫就整段 fail-open 降级——「没拦人」与「没工作」在界面上长得一模一样。而插件本来就有免费通道（DEC-030/037/062 的服务端下发），只是过去只能二选一：要么当主模型（`serverProvider` 开着），要么完全不用。

**决定**：

- **默认关闭的 `backupModel`**。打开后：主模型返回任何非 2xx（4xx 全族 + 5xx 全族，含 429/402/401/403）或 200 但响应体不可用（`invalid-json` / `invalid-response` / `missing-answers`）时，**本次调用**换免费通道再问一遍；免费配置不可达则行为与今日逐字一致。
- **复用现有下发通道，不新增第二个服务商**。兜底目标就是 `ServerConfigSource`（`SERVER_CONFIG_ENDPOINT`）那份配置，因此地址/模型/key 的校验、TTL、并发去重、失败重试下限、`keyHint` 末位脱敏全部继承，DEC-030 的三条红线（不落盘 / 绝不抛错 / 绝不外泄 key）自动适用。
- **判断层单独成模块** `lib/backup-model.js`（零依赖、零 I/O 纯函数）：`shouldFallback()` 定「哪些失败值得换人」，`backupPlanOf()` 定「此刻可不可用、为什么不可用」（`off` / `primary-is-free` / `no-config` / `expired`）。与 `endpoint-fallback.js` / `resilience.js` 同一分层，可裸 Node 单测。
- **超时与网络错误刻意不触发**。这两类已有专门的冷启动重试（resilience.js 的实测依据：首发被超时掐断时服务端已被焐热，第二发 1–2 秒必中）。再叠一次兜底会把单次决策的最坏等待从 2×timeout 抬到 3×timeout，而换一家服务商并不解决本机链路问题。`caller-aborted`（调用方已取消）与 `cooldown`（本地保护机制）同理排除。
- **与 `serverProvider` 互斥**。后者开着时免费模型**就是**主模型，再兜底等于拿同一份配置重问一遍。运行期报 `primary-is-free`，界面明说，但**不自动替用户关掉任何开关**（与 DEC-062 同一条约束）。
- **冷却语义改为「跳过主模型，直接走兜底」**。原来冷却期内一律 `degrade("cooldown")`；现在若兜底可用，冷却期间不发主模型请求、直接用它，每 `cooldownProbeMs` 仍放行一次主模型试探（半开冷却不变，试探成功即彻底解除）。否则「服务抖了一下」会让最有用的能力在最需要的时刻失效。
- **兜底成功不解除主模型的冷却**。`noteSuccess()` 会同时把 `cooldownUntil`/`cooldownStreak` 归零；免费模型答上来只证明**另一套账号**可用，对主模型是否恢复一无所知。若在这里清冷却，下一轮就会立刻再打一次已知故障的主模型——正是冷却要避免的白烧。主模型的冷却只由它自己的一次成功试探来解除（实测：第一版漏了这条，冷却期内的第二次调用又打了一次主模型，被新用例逮到）。
- **归因分得清**：`provider` 记既有常量 `server`，另加 `backup: true`；遥测、统计（`buildRecord`/`normalizeRecord`）、决策明细（`buildDecisionRecord`）三处各自透传，界面「标记」列显示「免费兜底」（排序值 2，夹在已降级与缓存命中之间）。降级路径额外回传 `backupAttempted`，审计能回答「为什么这次没兜底」。
- **兜底结果不进缓存**。缓存键由**主模型**的 endpoint/model 算；把兜底答案塞进去，后续同题会直接命中——既不再打主模型（也就无从得知它是否恢复），归因还会错记成主模型。
- **提前获取三个触发点**：启动（`reloadOwnConfig` 落定后）、热路径（`classify()` 开头）、进配置页（`/status`）。全部 `void`、不 await。另加 `BACKUP_REFRESH_MARGIN_MS = 120000`：临近过期也补一发，否则会出现「正好在过期窗口里失败 → 兜底不可用」。三处都只在开关打开时发生（关闭时零请求）。
- **先做了一次纯抽取**：把 `classify()` 里「对一个 provider 发一次请求（含重试循环、端点 404 回退、状态码分支、响应体解析）」抽成 `#attempt()` / `#successResult()`。兜底只是「换一套 provider+key 再调一次」，若复制一份发送逻辑，四段最容易漂移的代码会各自演化，而漂移的后果是「主模型与兜底模型对同一份题给出不可比的结论」。该提交单独可验证：792/792 全绿、测试文件一行未改。

**为什么**：

- **为什么不新增一个「backup provider」预设**：那会引入第二套地址/密钥/TTL 管理，而免费通道已经把这些做完了（含「不落盘、只给末四位」的既有承诺）。多一套就等于多一处会漂移的配置面。
- **为什么判断不写进 `classify()`**：四个闸（开关/互斥/有无配置/过期）各有独立失败语义与文案，散在 4300 行的 `index.js` 里就没法单测，也没法解释「为什么这次没兜底」。
- **为什么兜底只试一次**：它换的是「另一套账号与地址」，不是重试策略。再叠几轮只会成倍拉长最坏等待，却不会提高成功率。
- **为什么失败时保留主模型的失败原因**：主模型才是用户配的那个。用兜底的错误（可能是 401/404）盖掉 429，会把人引向完全错误的排查方向；「试过兜底」这件事另用 `backupAttempted` 记录。
- **为什么默认关且不跟随 DEC-062 的「全新安装默认开」**：DEC-062 那条是「开箱即用的免费主模型」，不产生额外网络行为；兜底要求提前取配置、并可能在失败时多打一次请求，属于必须由用户显式选择的行为变更。

**被否决的方案**：

- **把兜底塞进 `resilience.js` 的重试链**（当作「第三种可重试原因」）：**否决**。重试链换的是同一个端点的第二发，而兜底换的是另一套 provider + key + endpoint；混进去会让 `shouldRetry` 同时表达两件事，而它的 `maxAttempts`/`maxBudgetMs` 口径是按时长算的，容不下「换一家」。
- **把兜底结果写进缓存**：**否决**，理由见上（会遮蔽主模型是否恢复，并污染归因）。
- **在「使用免费模型」开着时自动关掉它，好让兜底生效**：**否决**。那等于替用户改了一个隐私相关开关（DEC-037/062 明令禁止），且用户本来可能就是想要免费模型当主模型。
- **让 `POST /test`（测试端点）也走兜底**：**否决**。它是「测你配的这个地址通不通」的诊断工具；静默改道后，它的结果就不再回答那个问题了。
- **把「用户主模型（reasoning model）自身报错」也接管**：不在本插件职责内——插件只判断决策模型，不拦截宿主主模型的请求。

**验证**：

- TDD 红→绿，新增 21 项：`test/backup-model.test.js`（18 项纯函数，覆盖触发集合的正反两侧、四种 `blocked`、畸形输入不抛、plan 不含明文 key）+ `test/backup-model-route.test.js`（13 项端到端：默认关零请求、就绪时接管且用下发 key、请求体除 model 外逐字相同、兜底也失败时保留主因并记 `backupAttempted`、超时不触发、互斥、key 不落盘 canary、白名单与布尔校验、统计/明细带 `backup`）。另有配置页 6 项与决策历史 2 项。先跑红确认失败原因是行为缺失（非环境/语法），再实现转绿。
- `node --test test/`：**840/840 全绿**（rebase 到含 DEC-074 provider-JSON 重构的 main 之后；main 基线 801 + 39 新增）。`node scripts/verify-wiring.mjs` 全部通过（含新增的 `Config 含 provider 键 backupModel`）。
- 抽取那一步单独验收：改动前后都是 792/792、测试文件零改动，证明「零行为变化」再叠功能。
- 三道既有护栏继续成立：下发明文 key 不落盘（沿用 `server-provider-route` 的递归读盘 canary，兜底路径也覆盖）；`serverProvider` 关闭时零请求下发端点；i18n 覆盖测试（新增 8 条中文文案全部登记英文）。

**改动文件**：`lib/backup-model.js`（新增）、`lib/index.js`（DEFAULTS/schema/白名单/校验/`#attempt` 抽取/兜底分支/冷却跳过主模型/`backupPlan`/`backupOverride`/`prefetchBackupConfig`/`statusPayload`/遥测与明细透传）、`lib/stats.js`、`lib/decision-store.js`、`lib/engine.js`、`lib/client.js`（配置页行、决策历史标记、provider 标签、英文词表）、`config.example.yml`、`README.md`、`README.zh.md`、`scripts/verify-wiring.mjs`、`test/backup-model.test.js`（新增）、`test/backup-model-route.test.js`（新增）、`test/client-ui.test.js`、`test/client-decisions-view.test.js`、`DECISIONS.md`。



## DEC-073 免费模型配置下发地址改为 cdn.zuos.us 静态文件（2026-11-24）

**背景**：用户要求把免费模型接口（「使用免费模型」开关的配置下发端点）下载地址改为 `https://cdn.zuos.us/dsh-market/decision-config-free.json`。原地址是授权服务的动态 API `https://dsh.zuos.us/api/provider-config`（DEC-030 引入），新地址是 cdn.zuos.us 上的静态 JSON 文件。

**决定**：`lib/server-config.js` 的 `SERVER_CONFIG_ENDPOINT` 改为新 URL。该常量是唯一的真实来源：`lib/index.js` 的实例创建与 `/status` 展示都直接引用它，因此只改一处，运行时请求与面板显示同步生效。同步更新 `config.example.yml` 的注释与测试里的硬编码 fixture（`test/server-config.test.js`、`test/client-ui.test.js`）。`test/server-provider-route.test.js` 的 fetch 桩原先用 URL 子串 `provider-config` 识别下发请求，改为与 `SERVER_CONFIG_ENDPOINT` 常量做全等比较——这样下次再换地址时桩不会静默失配。

**协议兼容性**：新 URL 的响应体沿用既有格式（curl 实测旧端点为 `{ ok, v:1, baseUrl, model, endpointStyle, key, ttlSeconds }`）；`parseServerConfig` 的校验逻辑一个字节都不改。注意：本次验证时（2026-11-24）新 URL 尚返回 Cloudflare 404，属待部署状态；免费通道本就 fail-open，404 时静默回落到本地配置，与既有「服务端未部署 key」路径一致。

**验证**：TDD 红→绿——先把 `test/server-config.test.js` 的端点断言改成新 URL，确认因实际值仍为旧地址而失败（失败原因是行为缺失，非环境/语法问题），再改实现转绿。`npm test` 792 项全绿；`node scripts/verify-wiring.mjs` 全部通过。全库 grep 确认旧地址零残留。

## DEC-072 会话标签「决策历史」改名为「决策」（2026-11-24）

**背景**：用户要求把会话标签页的 label `决策历史` 改成 `决策`。页面正文、配置页开关、文档里的「决策历史」叫法不变——只改会话标签栏那一个 label。

**决定**：`lib/client.js` 里 `conversation.view` 注册的 `label: () => t("决策历史")` 改为 `t("决策")`。英文词典里 `决策` 已有映射 `Decision`（原 tab 用的 `决策历史` → `Decisions` 不再被 tab 使用），因此中文显示「决策」、英文显示 `Decision`，无需新增词条。`t()` 的 thunk 机制不变：语言切换仍由宿主每次投影重新读取。

**为什么**：改动范围严格限制在用户点名的那个 tab label；页面的表头、空态文案、配置项说明里的「决策历史」是同一个功能的不同语境叫法，不在本次请求范围内，避免连带修改十几处文案与对应测试。

**验证**：TDD 红→绿——先把 `test/client-decisions-view.test.js` 的标签断言从 `决策历史` 改成 `决策`，并新增英文界面断言 `Decision`，两者先失败（实际分别为 `决策历史` / `Decisions`），改完后通过。`node --test test/` 共 792 项全绿（原 791 项 + 新增 1 项）；`node scripts/verify-wiring.mjs` 全部通过。


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

实测（当时的默认预设，模型
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
