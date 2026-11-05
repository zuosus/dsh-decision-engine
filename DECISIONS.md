# DECISIONS.md — 设计决策日志

<!-- APPEND-ONLY LOG: 新条目插入到此行之后 -->
## DEC-036 决策历史页删掉整排「会话 / 总数 / 刷新」（2026-11-05）

**背景**：用户要求「决策历史页面，不需要显示会话名称，总数，刷新按钮；删除一整排」。

那排是 DEC-022 建页时一并加的，三条理由当时成立、后来都不再成立：

- **会话名称（短 id）**：这一页的数据本来就**只查本会话**（`/session-decisions?sessionId=…`，
  服务端按会话过滤）。在一个「只看得到自己」的页面里标注「你是谁」，信息量为零——
  用户知道自己开的是哪个会话。
- **总数「共 N 条决策」**：列表每 **5 秒**轮询刷新，这个数字会在用户读的过程中自己变。
  它既不可操作（点不动、筛不了），也不稳定（看一眼和再看一眼不一样）；而 DEC-025 已经
  删掉了筛选，这个「N」连做分母的用途都没有了。
- **刷新按钮**：同一件事有两套刷新机制时，手动那套只会造成困惑——点下去与等 5 秒的结果
  一样，反而让人怀疑「是不是不点就不更新」。轮询本来就在跑（且刻意**失败不重置**已有
  数据，见 `load` 的注释），按钮纯属冗余。

**决定**：整排删除，不留「精简版」。删掉的东西：

- `DecisionsView` 里的 `bar` 整块（两个 `span` + 刷新 `button`）；
- 随之失效的样式 `S.decisionsBar`；
- 随之失效的助手函数 `shortSessionId()`（它唯一的调用点就在这排里）；
- 三条词条（`T_MISC` 的「会话 {id}」「共 {count} 条决策」、`EN_MISC` 的「刷新」）。

**留下的部分与边界**：

1. **人工审核比例面板不动。** 它与那排共用一层 `header` 包裹，但说的是另一件事
   （「聊天被问多频繁」，DEC-035）。删整排时容易顺手把 `header` 一起拆掉——那样滑块
   会在某些 `return` 分支里消失。改法是让 `header` **只装滑块**，并在
   `toleranceBlock === null` 时返回 `null`，不留一个空的包裹 `div`（否则表格上方会多出
   一条 `marginBottom` 撑出的空白）。
2. **轮询与「点行展开」照旧。** 这次删的只有展示，不动数据链路。
3. **`entries.length` 仍在用**——计数那行删了，但它还喂给空态判断与排序，不是死代码。

**测试**：把 DEC-025 那条「只应剩『刷新』按钮」的反向断言**升级**成「这一排整排不在」
（`test/client-decisions-view.test.js`）：

- 原来那条只数 `button`，而会话名与计数是 **span**——它们悄悄回来时测试照样全绿；
- 新断言同时盯三件事：`buttonTexts()` 为空、正文里没有「会话」、没有「条决策」，再
  **正向**断言表头还在（证明是「少一排」而不是整页删空）。
- **做过变异验证**：把那一排原样塞回渲染树，新断言立刻变红（另外三条「英文零中文」用例
  也红，因为词条已删）。只删代码不加断言的话，这类「展示层回潮」没有任何东西能拦住。

**改动文件**：`lib/client.js`、`test/client-decisions-view.test.js`、`DECISIONS.md`。
全量 550 项通过（改写 1 项、新增 1 项）。

## DEC-035 人工审核比例（tolerance）：模型无关的打扰频率设定（2026-11-05）

**背景**：现有六个守卫阈值（`guardConfidenceMin` / `guardIrreversibleCeiling` /
`guardTaskRelevanceFloor` / `guardInjectionAskThreshold` / `guardDenyConfidence` /
`guardIrreversibleDenyFloor`）全是**绝对分数**，而且是在**某一家决策模型**的输出分布上
校准出来的：同一个 0.4 在 A 模型上是「中风险」，在 B 模型上可能只是基线噪声，同一个 0.9
在 A 模型上几乎不出现、在 B 模型上是家常便饭。用户要的却不是「阈值取多少」，而是
「**让我挑选大概每多少次调用需要人工审核**」——一个与模型无关、纯粹关于体验的设定，
四个具名档位：自治（0% 询问）/ 轻松（最前 1% 询问）/ 默认（当前行为）/ 谨慎（比现在更保守）。

作用范围在这里就定死了：询问用户**只发生在 `authorize` 这一个决策点**。
`lib/outcomes.js` 说得很清楚——适配器里真正返回 `{ kind: "ask" }` 的只有工具授权的 ask，
其余七个点根本没有「打断用户」这种处置。所以这个旋钮只作用于授权点，界面上那两个滑块
也只在这一处生效。

**决定**：新增配置键 `tolerance`，默认值 `"default"`，四个 id（`autonomous` / `relaxed` /
`default` / `cautious`），全部集中在 `lib/tolerance.js` 一处。

1. **`default` 档与升级前逐字一致**。新代码是 `decideGuard()` 之上的**后处理层**，从不替换它：
   `lib/index.js` 的顺序刻意是「先 `decideGuard()` 算出 baseAction，再按档位增删询问」，
   默认档原样返回 legacyKind、连文案都复用原有那四条（审计口径不漂移）。于是老安装升级后
   什么都不会变，回归风险为零，四档的差别全部落在一个可单测的纯函数里。
2. **其余三档用「比例」表达，用「排名」实现**。每次授权算出一个 `severity` ∈ [0,1]，
   询问集合取该模型**自己最近分布**的前 p 分位：`relaxed` 取 p=0.01（即 P99），`cautious`
   取「默认判断本来要问的 ∪ severity 前 p=0.25（即 P75）」，`autonomous` 从不询问。
3. **为什么是排名，不是绝对分界线**（这是整个设定的核心）：一条固定的分界线恰恰是
   **换个模型就失效**的那个东西；分位数是从模型自己的最近输出里算出来的，所以「最前 1%」
   对任何在用的模型都真的意味着最前 1%。换模型时该模型的分桶是空的、阈值重新学——
   这就是「模型无关」的字面实现。

**severity 的定义**：`max(风险分量, 不可逆 × (1 − 任务相关性), 注入嫌疑)`。风险分量在有
`probabilities` 时取 `P(high) + 0.5·P(medium)`（`choice` 只有 low/medium/high 三档，太粗，
而分位数只能区分**连续**分数），服务不返回该字段时退回分类兜底 `{low 0.1, medium 0.5, high 0.9}`。
取 **max** 而不是加权求和：三个分量各自都是**独立成立**的人工审核理由，任何一条都足够让人看一眼；
加权求和会让「注入 0.9 + 风险 0.05」被平均值稀释掉——而那恰恰是最该拦下来的一次。
不可逆那一项要乘 `(1 − taskP)`，是沿用 DEC-008 的实测结论：普通 bash 命令的 irreversible
基线本来就在 0.2–0.4，只有「可能不可逆**且**模型自己都不认为它服务于当前任务」才值得打断人。

**校准与冷启动**：滚动窗口按 `provider × model` 分桶，每桶留最近 **200** 个 severity，
**纯内存**（分桶的理由：两个模型的分数没有可比性，混在一个窗口里算出来的阈值对两边都不对——
对高分模型偏松、对低分模型偏紧）。分位数用线性插值（与 numpy 默认口径一致；取整会让阈值在
两次调用之间跳一整步，表现为「突然多问一次或突然不问」）。就绪下限 **50** 个样本：再少时
P99 只是「最大的那一条」，噪声大到会随机打扰用户。样本不足时分位数**算不出来**，此时不猜，
改用在真实数据上量出来的绝对分界（`relaxed` 0.60、`cautious` 0.30），因此冷启动与校准后的
行为在同一量级，不会出现「一开始问一堆、攒够数据后突然变安静」的跳变。

**实测依据**（回放 `~/.dsh/dsh-decision-engine/decisions.jsonl` 里 **1,421** 条真实
`authorize` 决策）：

| 量 | 实测 |
| --- | --- |
| 现有阈值口径的询问率（= `default` 档） | **22.5%** |
| severity 分位数 | P50 0.195 / P75 0.277 / P90 0.354 / P95 0.405 / P99 0.495 |
| 各档询问率 | `autonomous` 0% / `relaxed` ≈1.1% / `default` 22.5% / `cautious` ≈41% |

同一批回放里真正危险的调用只有 **5** 条（注入 ≥0.8，或判为 high 风险），它们**全部落进最前 1%**
这一带。下面第 2、4 条边界的取值就是照着这批测量定的。

**约束与取舍**（每条都要说为什么）：

1. **任何档位都不压制 `deny`，自治档也不例外**。拦下一次破坏性调用不是「打扰用户」，它是
   安全边界——deny 从不弹窗问人，它直接告诉模型「这次调用被拒了」。让自治档把 deny 一起
   关掉，等于把一个体验旋钮悄悄变成「关掉安全检查」，而用户说的只是「0% 询问」，两件事。
2. **severity 的两条安全下限**：注入嫌疑达线（≥ `guardInjectionAskThreshold`，默认 0.8）
   → 至少 **0.90**；判为高风险 → 至少 **0.70**。因为分位数是**相对**的：模型整体校准很差时
   （所有分数挤在 0.2 附近），P99 可能落在一条平平无奇的调用上，真正危险的那条反而在中间。
   两个下限都刻意高于实测 P99（≈0.495），于是最该被人看一眼的那几条在任何口径下都进得了
   最前 1%。
3. **`relaxed` 取「替换」语义（把默认判断整个换掉），`cautious` 取「求并」语义（叠加在默认判断
   之上）**。这个不对称是
   刻意的：轻松档的语义是「只按最前 1% 问」，与默认判断取交集（叠加）就等于把语义作废——
   实测那是 23% 的打扰率而不是 1%；谨慎档的语义是「在现在的判断之上再多问些」，改成替换
   反而可能让它比默认档问得更少。求并保证「谨慎 ≥ 默认」这条单调性恒成立。
4. **为什么 relaxed 敢砍这么狠**：默认口径的 320 次 legacy ask 里有 **315** 次出自
   「低风险 + 可能不可逆 + 与任务无关」这一条分支（DEC-008 早就量出它是噪声主源），
   按 severity 排名它们全部落在尾部之外。砍掉的是模型对 bash 的惯性谨慎，不是真可疑的调用。
5. **窗口只在内存里、按 provider×model 分桶，刻意不落盘**。语义是「这个模型**最近**怎么说的」，
   落盘会把几天前的分布混进来，而模型与调用场景都可能已经变了。代价要说实话：**重启会重置
   校准**，此时界面显示实际生效的冷启动阈值，并写明「校准中 n/50 次授权决策」，而不是让用户
   以为设置没生效。严重度**四档一律记录**（包括自治与默认），否则用户切档后窗口是空的，
   还得重新攒一遍。
6. **控件是一条分段滑块，放在两处**（配置页 + 会话的「决策历史」页），不是下拉。四档是一条
   **单调的轴**（从不问 → 更常问），下拉会把「越往右越爱打扰」这层语义压成四个互不相干的
   选项；滑块还能在同一行画出当前档位附近的校准现状（最前 1% 现在落在哪个分数），那是下拉
   每一行放不下的。两处读的是服务端**同一份** `tolerancePayload()`——`/status`、`/decisions`、
   `/session-decisions` 三条路由都带着它——所以一个 tab 里改完，另一个 tab 在它原有的 5 秒
   轮询内就会跟上；加一档也只改 `lib/tolerance.js` 一处（元数据 label / summary / percentile
   全部下发，前端不抄）。`tolerance` 一并进了 PUT 白名单：不在白名单里的后果与当初的
   `telemetryLevel` 一样——面板能拨、显示「已保存」、值却从来没落盘。

**验证**：`test/tolerance.test.js` 新增 **25** 项，全是纯函数、不碰网络与文件系统——
severity 的三个分量各自把分数拉高、两条安全下限生效、缺 `probabilities` 时退回分类兜底、
畸形输入不上抛且**未知 risk 不当成低风险**（避免 fail-open）、`quantileOf` 的线性插值口径、
四档各自的行为、`deny` 不变量（四档全部保留拦截）、未校准时回落冷启动阈值、校准器的分桶
隔离与「窗口只留最近」、未知档位退回 `default`。`decideGuard()` 原有阈值分支由
`test/guard-threshold.test.js` 继续把住——那正是「默认档逐字不变」的兜底。

`test/tolerance-guard.test.js` 新增 **12** 项，覆盖纯函数之外的**接线**——这是本项目最
常见的故障形态（函数对了、参数传反、裁决算出来却没 return 出去，单测全绿而用户感受是
「设置没生效」）。做法是把 `DSH_HOME` 指到临时目录、真跑 `apply()`、从
`ctx.on("tools/pre-execute")` 拿到真监听器、写真实 `config.yml`（`reloadOwnConfig` 按
mtime 热读，所以拨档位不用重启）、打桩 `globalThis.fetch`（**必须在 `apply()` 之前**：客户端
构造时就固化了 `fetchFn`），然后断言监听器**return 给宿主的东西**。逐个钉住：默认档/省缺
档位仍是 ask（升级不改变行为）、自治档压掉 ask、自治档**不**压制 deny（四档逐档拨一遍）、
轻松档压掉噪声 ask、达线的注入嫌疑仍问且**理由仍是模型自己的结论**（审计口径不漂移）、
未达线但 severity 够高的调用由 tolerance 升级且理由自称是档位要求（这条是「severity 真接进
了热路径」的唯一证据——纯看默认判断它本来什么都不做）、谨慎档攒够 50 样本后把普通调用
升级、`decisions.jsonl` 与 `telemetry.jsonl` 都带 `scores.tolerance` 留痕、非法档位值
不崩（fail-open）、只读工具零开销。

**一次真机排版事故（用户截图反馈）**：滑块最初被放进 `row()` 的右半边，而
`row()` 是「左标题 / 右控件」的两列布局（`justify-content: space-between`）。四段在
`maxWidth: 420px` 里各自 `flex:1 1 0` + `minWidth: 0`，被压到每段只剩一个字宽，
中文标签逐字换行、四个段叠成一团竖排，整页看着像坏了。三处修正：

1. 滑块**自成一块**（`S.toleranceSection`：竖排、占满整行、与 `rowLine` 同节奏的下边框），
   不再作为任何 `rowLine` 的右控件——滑块本来就是一整行宽的控件，塞进两列布局必然被压扁；
2. 落点 `minWidth: max-content` + `whiteSpace: nowrap`，保证中文标签**永不换行**；
   容器太窄时宁可整体溢出，也不要把「轻松」拆成两行；
3. 落点标签**只留档位名**，原来的语义尾注（「轻松（只问最前 1%）」）移到轨道下方一行
   「当前档位只问最前 N% 的调用」。620px 面板里四段等宽后每段仅 ~141px，带尾注的中文
   放不下；而尾注只对**当前**档位有意义，用户点过去再看另一档的比例就够了。

配套加了一条回归守卫 `test/client-ui.test.js`「滑块独占一整行，没被塞进 rowLine 的右半边」：
断言滑块不在两列布局里、且四个落点都带 `minWidth: max-content` 与 `nowrap`。这条守卫
**经过了回注验证**——把源码故意改回旧形状（塞回两列 + 去掉 max-content）会立刻变红，
改回来变绿。

界面两处各有用例：`test/client-ui.test.js` 新增 **6** 项（四段都在且顺序对、**不是**
`select` 选项、当前段 `aria-pressed` 唯一为真、服务端不下发 `tolerance` 时安静消失而不报错、
校准脚注从「校准中 n/50」切到「已按这个模型校准 + 实际阈值」）；`test/client-decisions-view.test.js`
新增 **5** 项（会话页有滑块、**空态也有**、错误态如实报错且不画无数据支撑的滑块、无下发数据时
安静消失、英文界面零中文）。最后一条**抓出一个真 bug**：段标签里写死了全角括号 `（）`，
英文宿主上拼成 `Relaxed（top 1% only）`——全角括号本身是中文标点，被「英文零中文」判为漏翻。
已改成可译模板 `"{name}（{detail}）"` → `"{name} ({detail})"`，这也印证了那条断言的价值。

本次全量 `node --test "test/*.test.js"` **549 项全绿**。
`test/decisions-route.test.js` 曾偶发 `ENOTEMPTY`：`apply()` 启动的后台旁路（统计回填、明细
写盘）可能在用例 `rmSync` 之后才落盘，是**清理阶段的竞态**而非被测行为的失败。不做处理的
代价是「全量跑里随机变红」——那种红会训练人忽略真回归。已把该文件 14 处清理统一走
`cleanupDir()`：对 `ENOTEMPTY`/`EBUSY` 重试 6 次、`ENOENT` 视为已达成、其余错误照常抛出
（真的权限/路径问题不该被吞）。

**改动文件**：新增 `lib/tolerance.js`、`test/tolerance.test.js`、`test/tolerance-guard.test.js`；
修改 `lib/index.js`（DEFAULTS / Config schema / `extractGuardAnswers` 透传 `probabilities` /
`askOutcomeForSeverity` / PUT 白名单与落盘前校验 / 守卫热路径上的 `baseAction` +
`severity`→`calibrator`→`resolveTolerance` / `tolerancePayload()` 与三条路由 / 导出）、
`lib/client.js`（`ToleranceSlider` 共用组件 + 配置页与会话页两处挂载 + 滑块样式 + 中英词表 +
全角括号修复）、`test/client-ui.test.js`、`test/client-decisions-view.test.js`、
`test/decisions-route.test.js`（14 处清理改走 `cleanupDir()`，消除偶发 `ENOTEMPTY`）、
`config.example.yml`、`README.md`、`DECISIONS.md`。


## DEC-034 裁决列写中文：16 个裁决词各给一个中文名（2026-11-05）

**背景**：用户要求「裁决里的英文需要对应的中文翻译：inline, delegate 等」。决策历史八列
里七列是中文，唯独「裁决」列整片是英文机器词，而它恰是这张表最需要一眼读懂的一格。

**决定：只在渲染边界换中文，数据一个字节不动。** `lib/client.js` 新增 `VERDICT_LABELS`
（与 `VERDICT_COLORS` 同序分族）：allow 照常放行 · keep 保留原模型 · delegate 交给主模型 ·
switch 换模型 · redirect 改用别的技能 · advise 建议分派 · prune 裁剪结果 · summarize 摘要
压缩 · continue 续一轮 · translate 翻译 · stop 收束本轮 · inline 自己接着做 · skip 跳过 ·
ask 转人工确认 · deny 拒绝执行 · degraded 降级未裁决。配套四条约束：

1. **英文界面逐字不变**：每个中文名同时登记进 `EN_LABELS`，值就是那个机器词，`tr()`
   翻回去仍是 `delegate`，「英文零中文」的断言不受影响，也没新开一套机制。
2. **原始机器词留在 `title` 上**：`action` 是明细文件、遥测、原因串里的标识，要对照日志时
   停一下鼠标就能看到。
3. **未登记的词退回机器词本身**：将来新增裁决词忘了补中文名，表现是「那格还是英文」而不是
   「那格是空的」。
4. **没有复用「放行 / 询问 / 拦截」**：它们已是三格裁决结果（allow / ask / reject）在词表里
   的键，而运行时 `EN` 是四张表合并成一张，同名键后写盖先写——把裁决词也叫「放行」会让
   统计页那列表头被翻成 `allow`。同理 `degraded` 不叫「已降级」：标记列那三个字说的是
   **这次请求**降级了，这一格说的是**这次根本没有裁决**（统计里它进 `none`）。

**排序改按中文显示名**，与「决策点」列同口径（按机器词字母序会把放行族按 adv/allow/deny
打散，读不出哪几类在一起）。**数据层不动**：`decisions.jsonl`、遥测、响应与 `outcomes.js`
的 (决策点, 裁决词) 矩阵继续写英文机器词；`detail` 仍是服务端写的中文审计原文（DEC-022）。

**测试**：`test/client-decisions-view.test.js` 新增 5 项、修正 1 项（旧断言写的是改前行为）：
16 个裁决词逐格比对中文名并反向断言该列不再出现机器词；`title` 是原始机器词；英文界面逐格
等于机器词且整页无中文；`brand-new-word` 原样显示；排序夹具用 `keep`/`advise`/`allow` 让
机器词序、中文名序、时间序三者互不相同。变异验证（各改完立刻还原）：渲染退回 `action` →
3 项红；删掉词表里「跳过」→ 英文项红；排序退回机器词 → 排序项红。全量 501 项通过。

**改动文件**：`lib/client.js`、`test/client-decisions-view.test.js`、`README.md`、`DECISIONS.md`。


## DEC-032 ⛔️ 取消 DEC-031：bamboonode 恢复为内置预设与默认 provider（2026-11-04）

**背景**：DEC-031（2026-11-03）以「bamboonode.dev 作为预设 provider 已下线」为
唯一前提，从预设表里移除 bamboonode、把 `DEFAULT_PROVIDER` 改成 systemone，并给
老配置加了 bamboonode → custom 的加载期自动迁移。撤销它有两个理由。

**理由一：前提经复核不成立——端点今天仍然在线。**

2026-11-04 直接复核该服务：

| 请求 | 结果 |
| --- | --- |
| `GET https://api.bamboonode.dev/v1/models` | **HTTP 401** |
| `POST https://api.bamboonode.dev/v1/decisions` | **HTTP 401**，`{"error":{"code":"invalid_api_key","type":"new_api_error"}}` |
| 对照：`GET https://api.openai.com/v1/models` | HTTP 401（同样是在线的鉴权失败） |
| 对照：`GET https://nonexistent-xyz-12345.invalid/v1/models` | HTTP 000，`SSL_ERROR_SYSCALL` |

响应头里有 `server: nginx/1.30.5`、`via: 1.1 Caddy`、`x-new-api-version` 与
`x-oneapi-request-id`：网关在跑，请求进到了应用层并生成了 request id。
**401 的含义是「服务活着、密钥不对」**，与「服务已下线」是两回事——真下线的
表现是连不上（HTTP 000 / DNS 失败 / TLS 断），就像上面那个对照组。DEC-031 把
一次未带凭据的探测读成了服务退役，前提从一开始就是错的。

**理由二：迁移把「本来能用的配置」变成了明确不可用。**

DEC-031 的迁移规则刻意不给「没有自己 baseUrl 的用户」补地址（怕静默指向已下线
服务），于是产出 `provider: custom` + 空 `customBaseUrl`，`resolveProvider` 回
`valid=false`。对这批用户，升级把「能跑」变成「不能跑、且必须手工填 base URL
才能救回来」。既然目标服务其实在线，这份代价没有换来任何东西。

**决定**：

1. **bamboonode 回到预设表并重新成为默认**：`PROVIDER_IDS` 恢复五家
   （systemone / bamboonode / siliconflow / siliconflow-intl / custom），
   `DEFAULT_PROVIDER = "bamboonode"`。不写 provider 键的老配置，行为与 DEC-031
   之前逐字一致：端点 `https://api.bamboonode.dev/v1/decisions`、key 变量
   `BAMBOO_API_KEY`、默认模型 `startlux-decision-27b-autothink`。
2. **恢复 bamboonode 的解析特例**：`baseUrl` 覆盖（`/v1` 与 `/v1/decisions`
   两种写法都接受，`source` 记为 `legacy`）、历史字段 `apiKeyEnv` 的变量名覆盖、
   `bamboonodeApiKeyEnv` 的显式覆盖优先于 `apiKeyEnv`、以及历史共享字段
   `apiKey` 的兼容读取。
3. **删除迁移机制**：`migrateLegacyProviderConfig` 与四个 `LEGACY_*` 常量、
   `/status` 的 `providerMigratedFrom` 字段、设置页的「已自动迁移」提示，
   README / config.example.yml / 站点双语里的对应表述一并撤回。
4. **不做反向迁移**（见下）。

**明确保留的部分——这次撤销不牵连它们**：

- **DEC-030（服务端下发配置）全量保留**：`SERVER_PROVIDER_*`、
  `buildServerProvider`、`resolveKey` 与 `memoryKey` 优先级、`serverProvider`
  开关、`/server-provider` 路由、设置页的「地址与密钥来自服务端下发」角标、
  `lib/server-config.js`、`test/server-*.test.js`，以及站点侧
  `/api/provider-config` 文档与打包接线。
- **DEC-031 同日「跟进修复」的三项独立改进保留**：打开配置页自动拉取模型列表、
  custom 下模型行移入「自定义 provider」区（「自动」= 不发送 model 字段）、
  `/models` 对 custom 不做 StartLux 类型过滤。第三项在 `lib/index.js` 里与恢复
  的 `typedOnly`（bamboonode 严格过滤）合并成 if / else if 两条分支：bamboonode
  照旧严格、custom 照旧全收、其余 provider 维持「有人声明类型才过滤」。只把
  DEC-031 之前的写法抄回来会重新清空用户网关的模型列表——那是
  `test/save-path.test.js` 明确覆盖过的真实故障，不是假想风险。
- **DEC-031 第 4 条（历史统计归属）依然成立**，但实现回退为「bamboonode 回到
  预设表，由预设表统一负责归属」。`lib/stats-store.js` 现在与 DEC-031 之前
  逐字节相同（`git diff e4e3128^ -- lib/stats-store.js` 为空）；其中
  `LEGACY_MODEL_PROVIDERS` 属于 DEC-011 的模型名反推，与本次无关，未改动。

**为什么这次不能整文件回滚**：`e4e3128` 把 DEC-031 与 DEC-030 写进了同一个提交。
`git revert` 或 `git checkout e4e3128^ -- <file>` 在纠缠文件上会连带抹掉 DEC-030
与后续提交的改动，所以只有「纯 DEC-031」的文件才允许整文件回滚（`README.md`、
`config.example.yml`、`lib/stats-store.js`、`test/cache-regression.test.js`、
`site/build.mjs`、`site/lib/content-en.mjs`），其余一律逐块手改。

**为什么不做反向迁移（custom → bamboonode）**：

DEC-031 的迁移是**纯内存**的，从不回写 `config.yml`。所以绝大多数用户在本次撤销
之后自动恢复 bamboonode，不需要任何迁移动作。唯一例外是在 v1.0 之后**打开并保存
过设置页**的用户：保存会把内存里迁移后的 `provider: custom` + 空
`customBaseUrl` 落盘，升级后他们停在 `valid=false`。刻意不为他们加自动反向迁移，
理由是：`provider: custom` 是完全合法的用户选择，插件没有任何依据把一个正在用
custom 的用户改成别的服务——猜错就是静默换掉生效服务，正是 DEC-031 自己反对的
那类行为。出路现成且一步到位：设置页的 provider 下拉恢复包含 bamboonode，选中
即回到预设默认（地址、模型、key 变量名都由预设给），保存生效。若后续真收到
「升级后不可用」的反馈，再考虑只在「custom 且 base URL 为空且 customApiKey 未
配置」这个三重条件下加**提示**（提示而非改写）——条件足够窄，碰不到真正在用
custom 的用户。

**取舍与风险**：

- 若 bamboonode 之后真的下线，正确做法是把它做成**可下线的预设**（由服务端或
  预设表标注 retired，设置页显式提示并引导迁移），而不是在默认值层面硬切——
  硬切会同时打断「老配置行为不变」这条不变量，这次就是被它反噬。
- 迁移机制本身不是错的设计，错的是把它用在端点仍然可用的服务上。本次删掉的代码
  随时可从 `e4e3128` 取回。
- 默认 provider 已在 bamboonode / systemone 之间翻转过两次。凡是「依赖当前默认
  值」的检查与测试都应显式钉住 provider：本次据此修正了
  `scripts/verify-wiring.mjs` 的空 `memoryKey` 检查与
  `test/client-ui.test.js` 的服务端生效下拉检查，并新增一条默认 provider 的
  key 链路检查，补回被默认值翻转消掉的覆盖。

**验证**：`npm test` 495 通过 / 0 失败（比 DEC-031 版本的 497 少 2 条，少的正是
被删掉的两个迁移测试）；`node scripts/verify-wiring.mjs` 全部通过；`/status`
实测返回 `provider=bamboonode`、端点 `/v1/decisions`、`keyEnvName=BAMBOO_API_KEY`、
`providerCatalog` 五家、且响应里不再有 `providerMigratedFrom` 键。


## DEC-031 移除 bamboonode 预设：provider 默认改 systemone，老配置自动迁移到 custom（2026-11-03）

**背景**：bamboonode.dev（StartLux 官方端点）作为预设 provider 下线。它此前是
`DEFAULT_PROVIDER`，预设表里还有一个完整条目（地址 `https://api.bamboonode.dev/v1`、
key 名 `BAMBOO_API_KEY`、默认模型 `startlux-decision-27b-autothink`）。

**决定**：

1. **预设表与可选清单里彻底移除**：`PROVIDER_IDS = ["systemone", "siliconflow",
   "siliconflow-intl", "custom"]`，`DEFAULT_PROVIDER = "systemone"`。
   默认值不能指向一个不可用的服务；不写 provider 键的新配置与老 yml 里没写过的
   安装都落到 systemone。
2. **解析点不为已下线的服务保留特例**：`resolveProvider` 不再读历史字段
   `baseUrl` / `model` / `apiKey` / `apiKeyEnv`（它们只对 bamboonode 有过
   覆盖语义），读取它们的兼容分支一并删除——迁移负责搬运，解析点保持单一形状。
3. **新增 `migrateLegacyProviderConfig(cfg)`（纯函数，providers.js）**，宿主层在
   `reloadOwnConfig` 合并配置之后、`resolveProvider` 之前调用：
   - `provider: bamboonode` → `custom`；
   - 用户自己的 `baseUrl` / `model` / key（`bamboonodeApiKey`，历史共享字段
     `apiKey` 兜底）原样搬进 `customBaseUrl` / `customModel` / `customApiKey`；
   - **等于老预设默认值的 baseUrl / model 按「残留」处理，不搬**：老版本把预设
     默认值注入 DEFAULTS，配置里出现默认地址不代表用户选过它；搬过去等于让用户
     继续指向已下线的服务还以为插件给它挑的；
   - **没有自己的 baseUrl 时拒绝静默迁移**：迁成 base URL 为空的 custom，
     `resolveProvider` 给出 `valid=false` 与中文原因，设置页把「不可用」亮给
     用户。替用户决定「迁移到哪家服务」超出配置迁移的职权，宁可显式不可用；
   - 变量名：用户自定义过的（`bamboonodeApiKeyEnv` / `apiKeyEnv` 里的非默认值）
     搬到 `customApiKeyEnv`；全是默认残留时**落回 `BAMBOO_API_KEY`**——key 存在
     环境变量或凭据文件旧默认名下的用户，升级后不断供；
   - 迁移发生与否通过 `statusPayload` 新增的 `providerMigratedFrom` 下发给设置页，
     界面提示「provider 为什么变成了 custom」——沉默地换掉生效服务，看起来就像
     配置被损坏。
4. **历史统计归属保留**（lib/stats-store.js）：老统计/遥测里大量行属于 bamboonode，
   `providerByEndpoint` 继续认识 `api.bamboonode.dev` 主机名，
   `defaultModelOf("bamboonode")` 仍返回 `startlux-decision-27b-autothink`，
   模型名反推表（`startlux-*` → bamboonode）原样保留——历史行不因此变成 unknown。
5. **已知的取舍**：曾短暂用过 `DECISION_ENGINE_KEY` 变量名的极老安装，迁移后
   key 不再被自动读到（custom 只认一个变量名），需在设置页重填；模型默认值残留
   不搬运，指向自建兼容服务且依赖旧模型名的用户需在设置页重选一次。
6. **文档 / 站点 / 校验脚本同步**：README、config.example.yml、site 双语文档改为
   四预设 + 迁移说明；`verify-wiring.mjs` 增加迁移行为检查（迁移搬运、残留不搬）。
7. **跟进（同日反馈）**：迁移后设置页模型下拉只剩「自动」。两个根因一起修：
   `loadModels` 此前只有「获取」按钮一个调用点，打开页面从不自动拉取——现在
   状态加载完成、provider / 生效地址变化时自动拉；模型行在 custom 下移入
   「自定义 provider」区（清单来自用户自己的服务，「自动」= 不发送 model 字段，
   语义在文案里说清）；`/models` 对 custom 不再做 StartLux 类型过滤——用户
   网关声明的类型五花八门，过滤会把列表清空，请求本身仍有 404/400 回退兜底。

**为什么不在解析点兼容读取 `provider: bamboonode`**：那会让「已下线的服务」永远
留在可选值里，设置界面也能再次选中它；迁移一次性把状态搬干净，之后代码里只剩
四个 provider。


## DEC-029 ⛔️ 取消 decisionsCapture 档位：「决策历史」开关全权决定是否记录内容（2026-11-03）

**背景**：用户反馈「决策历史的表格里，决策内容都没记录，只有元数据，这是不对的」。

**排查**：真机 `~/.dsh/dsh-decision-engine/decisions.jsonl` 488 条——244 条
`capture:"full"` 带 `content`（截至 02:37Z），其后 244 条全部 `capture:"meta"`
且没有 `content` 字段；分界点与 `config.yml` 的 mtime（10:40 本地时间）一致。
配置里留着 `decisionsCapture: false`，而 `decisionsTabEnabled: true`。
`DecisionStore.record()` 在该键为 false 时删掉 `content`、强制 `capture:"meta"`，
于是**开关显示「开」、记录却只有元数据**。这个 false 已无法从配置页回溯出自谁手
（DEC-026 合并两行开关之后它就没有界面入口了），无论它当初是刻意设的还是中途
版本兜底值留下的，结论都一样：**一项用户看不见的配置正在静默否决用户看得见的开关**。

**为什么这是设计缺陷而不是配置问题**：DEC-026 已把配置页的两个 toggle 合并成一行
「决策历史」，并写明「开 = 记录明细（含内容）」。但 `decisionsCapture` 作为「高级
档位」既不出现在配置页，也不在任何提示里回显——它成了一项**界面无法表达、用户无法
发现**的隐藏否决权。用户看到的开关状态与真实行为不一致，而 DEC-022 的隐私承诺本来
就可以用「关掉开关 = 完全不写文件」表达。一个能静默否决用户可见状态的隐藏档位，
比它带来的那点灵活性更贵。

**决定**：

1. **`decisionsCapture` 退役**：从 `DEFAULTS` / Config schema / `PUT /config` 白名单 /
   `statusPayload` / 客户端 patch·diff·draft / `DecisionStore` 构造函数（`getCapture`）
   上一并删除。
2. **唯一开关是 `decisionsTabEnabled`**：开 = 记录明细**且一定记录内容**；关 = 不建
   文件、不占磁盘、不采集内容（DEC-022 #5 的隐私承诺不变）。
3. **每条记录上的 `capture` 字段保留，语义不变但来源收窄**：它现在只反映
   `truncateContent()` 的结果——`full` = 内容装得下，`meta` = 内容超限被丢弃
   （`too-large` / `serialize-error` / `no-content`）。没有任何配置能再把它强制成 `meta`。
4. **旧配置里的 `decisionsCapture: false` 自然失效**（未知键被忽略），不动用户的
   `config.yml`——这正是「退役而不是迁移」的理由：迁移得猜这个 false 是刻意的还是
   残留的，而它已经不可见，猜错就是继续静默。
5. **`/session-decisions` 响应去掉 `page.capture`**：它回答的是「这个功能有没有开」，
   而那是 `enabled` 的语义。

**顺带修正**：表格「内容」列此前渲染的是「缓存命中 / 已降级」标记，而它的表头叫
「内容」、排序键却按有没有内容排（DEC-028 自己也把这两件事混写了）。现在：
「内容」列 = 有内容 / 仅元数据；新增「标记」列（在其后）= 缓存命中 / 已降级。

**测试**：全量 445 项通过（本次新增 8 项：服务端「开关开启时内容一定落盘」
「capture:meta 只可能来自超限裁剪」「已退役的 decisionsCapture 只提交它应被拒」
「config.yml 里遗留的退役键不再影响任何行为（旧配置平滑升级）」
+ 客户端「内容列显示捕获状态」「缓存/降级标记只在标记列」「内容表头按有无内容排序」
「标记表头按状态分组排序」；另把旧的三条 decisionsCapture 断言改成**反向断言**
「该字段不该再出现」——断言「它不在」比断言「它是 true」更能防它悄悄回来）。
变异验证（各变异后立刻还原）：`DecisionStore.record()` 忽略 `content` → 服务端新断言变红；
「内容」列渲染退回缓存/降级 → 客户端 2 项变红；时间列退回「切一刀 ISO 串」的 UTC
渲染 → 8 项变红。另外把时间列的期望值改成 TZ 无关的写法（测试进程钉在
`Asia/Shanghai`，本地≠UTC），把上一个任务遗留的本地时间改动也纳入了回归。

**改动文件**：`lib/index.js`（DEFAULTS / schema / PUT 白名单 / statusPayload /
DecisionStore 接线 / session-decisions 响应）、`lib/decision-store.js`（去 `getCapture`
与降级分支、注释改写）、`lib/client.js`（去接线、「内容/标记」两列、`EN_MISC` 三条新词条）、
`test/decision-store.test.js`、`test/decisions-route.test.js`、
`test/client-decisions-view.test.js`（新增 4 项 + 时区无关化）、`README.md`、
`config.example.yml`、`DECISIONS.md`。

## DEC-028 决策历史：表头逐列可排序；裁决配色一词一色（2026-11-03）

**背景**：同一轮里用户提了两件事——

1. 「表格头的每一个都允许点击进行排序，升序降序切换。默认按时间升序排列。」
2. 「裁决部分使用的颜色要区分大一些，比如通过用绿色，拒绝用红色，降级用黑色，
   delegate 用蓝色等。」

---

**一、逐列排序**

七列全部可点（时间 / 决策点 / 提供方 / 模型 / 裁决 / 耗时 / 内容）。规则：

- **默认 `{ key: "ts", dir: "asc" }`**（用户明确要时间升序）；
- 点**当前列** → 翻转升降序；
- 点**别的列** → 切到该列，方向按列性给定：`ts` 从升序起（与整页默认排序一致），
  其余从**降序**起——第一次点「耗时」的人想看的是最慢的在前，点「模型」想先看到
  某个模型自己那一批，降序都是更常被要到的那一头。

另外三个决定：

1. **排序放客户端。** 这个页面读的是单会话最近几百条，数据已在内存；再发一次
   请求去排同一批数据只会多一次往返，而且服务端是按时间取尾部的，要支持任意列
   排序就得把「取哪几百条」的语义一起改掉。服务端只管取数，怎么排是视图的事。
2. **同值必须有次级键。** 列表每 5 秒轮询刷新，若同值行每次渲染彼此换位，用户
   读到一半就会串行。因此比较器在同值时退回**时间升序**，再退回**原始顺序**
   （`Array.prototype.sort` 稳定），不靠运气。
3. **箭头只画在当前列**，并用 `user-select: none` + `cursor: pointer` 表明可点。
   所有列都挂箭头等于没有信息。

---

**二、裁决配色：一词一色**

改前的映射是**多词共用一色**：`delegate` / `allow` / `keep` 同为绿，
`stop` / `inline` / `skip` / `translate` 同为灰，`continue` / `switch` /
`redirect` 同为蓝，`advise` / `prune` / `summarize` 同为紫，`deny` 与
`degraded` 同为红。而这一页的全部用途就是**扫一眼看出哪几次被拦了**——共用色相
等于把语义压平。

现在 16 个裁决词各有色相，按语义分族摆放：

| 族 | 词 → 色 |
|---|---|
| 放行 | `allow` 绿 · `keep` 青绿 · `delegate` 蓝 |
| 改写行为 | `switch` 天蓝 · `redirect` 紫 · `advise` 品红 · `prune` 黄绿 · `summarize` 浅橙 · `continue` 淡紫 · `translate` 粉 |
| 中性 | `stop` 灰蓝 · `inline` 灰 · `skip` 黄 |
| 要人看一眼 | `ask` 橙 · `deny` 红 · `degraded` 主文本色 |

**颜色仍只是辅助**：裁决词本身写在标签里，色盲用户与截图场景都不依赖颜色。

**`degraded` 没有用字面黑**（用户说的是「黑色」）。纯黑在深色主题下**完全不可读**，
而面板常年跑在深色主题上。这里改用主题的**主文本色令牌**
`var(--dsw-alias-label-primary, #111111)`：浅色主题下它就是黑，深色主题下自动
翻成浅色——「最中性、不带色相的一种状态」这个语义保住了，可读性也保住了。
同理，新配色全部取 400–500 明度，深色底上不消失。

---

**测试**：新增 4 项表头排序用例（`test/client-decisions-view.test.js`）。
夹具把 `ts` 与 `latencyMs` 的顺序**故意错开**（时间 08:00/08:01/08:02 对应耗时
3000/1000/2000），排错列立刻显形；并断言箭头只出现在当前列。与 DEC-027 同理：
只断言初始画面测不出交互，所以测试**真的去点表头**再看行序。

变异验证：把 `sortDecisionEntries` 改成原样返回 → 2 项变红。

全量 438 项通过。

**改动文件**：`lib/client.js`（`DECISION_COLUMNS` / `decisionSortValue` /
`sortDecisionEntries`、`sort` 状态声明在 useState 末尾、可点表头、
`VERDICT_COLORS` 重排）、`test/client-decisions-view.test.js`。
## DEC-027 ⛔️ 修订 DEC-022：记录身份用全局唯一 id，排序用时间而不是 seq（2026-11-03）

**背景**：用户反馈「决策历史里，表格里的 row 点击展开有问题，我点击第二个，
展开的是第三个」。

**根因不在渲染逻辑，在身份标识**。渲染代码是对的（点击处理器与「哪一行展开」
的判定用的是同一个值），但那个值选错了：

- `seq` 只是 `DecisionStore` 的**进程内**计数器（`this.seq + 1`），DSH 每重启
  一次就从 1 重新数。而明细文件是**跨重启追加**的，于是同一个文件里大量记录
  共用同一批 `seq`。
- 实测用户数据：**307 条记录只有 119 个不同的 `seq`**（89 个重复，可见
  1..119 反复出现四轮）。
- 界面拿 `seq` 当 React `key`，**重复 key 让 React 把行与事件处理器对到错的
  DOM 节点上**——现象就是「点第二行、展开第三行」。同时 `expanded === seq`
  会命中多条记录，展开一行可能冒出几段详情。

**顺带发现的第二个缺陷**：`readForSession` 当时**按 `seq` 排序**。这和身份问题
同源——`seq` 跨重启重数，按它排会把不同批次的记录交叉排开，**时间顺序整个
乱掉**，而时间顺序是这个页面唯一的排序依据。实测确认：把真实数据按 seq 排序
后时间戳不再单调。

**决定**：

1. **写入时给全局唯一 `id`**：`<进程前缀>-<seq>`，前缀是 `DecisionStore`
   构造时随机生成的 8 位（`randomUUID().slice(0, 8)`），因此跨重启唯一。
   `seq` **原样保留**——它仍是排序与诊断用的进程内计数器，语义不变。
2. **读取时为老记录补 `id`**：`recordIdOf()` 是「哪些字段能当身份」的**唯一**
   定义处。老记录没有 `id`，退回 `ts#seq`——`ts` 精确到毫秒，要撞得两个进程
   写出完全相同的时间戳**且**相同 seq 才行；实测用户 308 条历史数据
   `ts#seq` **308/308 唯一**。
3. **读取时再保证响应内唯一**：万一还撞，加位置后缀。这是**保险而不是主修**：
   靠它产生的是位置相关的合成 id，窗口一变就可能漂移。写入时就唯一才是正解。
4. **排序改为按 `ts`**，`ts` 相同时由 `Array.prototype.sort` 的稳定性保持文件
   先后（文件是追加写的，append 顺序就是发生顺序；轮转也只是把旧文件拼在前面）。
   原先那条「崩溃重启后文件顺序可能错位」的理由站不住——真正会错位的是 seq。
5. **界面统一用 `entryIdOf()`** 取身份，React `key` 与「哪一行展开」都用它，
   **两处不能各算一套**（曾经一处用 seq、一处用 index，这类不一致正是错位的
   温床）。

**为什么之前的测试没抓到**：展开相关的用例**只有单行**。单行时行身份怎么写都
「对」，错位根本无从发生。这类缺陷需要**多行 + 顺序断言**才看得见。

**新增测试（全部做过变异验证）**：

- `test/client-decisions-view.test.js`：新增 `tbodySequence()`（返回 tbody 里
  各行的**实际先后**，形如 `row / row / detail / row`），据此断言「点第二行时
  详情紧跟第二行」「点第一行/第三行也各自正确」「seq 重复时只展开被点的那一行」
  「同一行点两次收起且不影响别的行」。把界面身份退回 `seq` → **4 项变红**。
- `test/decision-store.test.js`：「跨重启写入的 id 唯一」——不仅断言**返回**的
  id 唯一，还直接解析**落盘文件**里每条记录的 `id`。这条补充是变异测试逼出来
  的：只断言返回值时，把写入的 id 退回 `String(seq)` 测试照样全绿（读端的去重
  后缀兜住了），补上磁盘断言后才变红。「老记录补 id」「按时间排序」「recordIdOf
  的兜底规则」各一条；把排序退回按 seq → 排序用例变红。
- 既有三处用例的夹具随之更新：它们此前把 `seq` 当展开键注入（`SLOTS.expanded: 7`
  之类），现在注入 `id`。**这些用例变红恰恰说明身份变更生效了**，不是回归。

**改动文件**：`lib/decision-store.js`（`idPrefix`、`recordIdOf`、写入补 `id`、
读取补 id + 去重保险、排序改按 ts）、`lib/client.js`（`entryIdOf`，行 key 与
展开判定统一用它）、`test/decision-store.test.js`、`test/client-decisions-view.test.js`。
全量 434 项通过。
## DEC-026 配置页的决策历史合成一个开关（2026-11-03）

**背景**：用户要求「这个任务在插件的配置页面增加了两个 toggle，没必要，合为
一个即可。」

**当时的两行**：

| 行 | 键 | 说明 |
|---|---|---|
| 决策历史 | `decisionsTabEnabled` | 记录明细并挂会话标签页 |
| 决策内容 | `decisionsCapture` | 只在上一行开启时出现，控制是否存内容 |

**为什么该合并**：两行表达的是**同一件事**——「这个功能要不要用」——却要求用户
先做一次「记不记」的决策、再做一次「记多细」的决策。第二问根本不是日常选择：
会关心「只存元数据」的人，本来就是会去翻 `config.yml` 的人。

**决定**：

1. 配置页只留**一行**「决策历史」：开 = 记录明细（含内容）并挂标签页；
   关 = 完全不写文件。提示文案随状态换：
   - 开：「把本会话里经本插件做出的每次决策按时间记下来，并在会话里新增一个
     「决策历史」标签页」
   - 关：「关闭后不写任何明细文件（不采集内容、不占磁盘）」
2. `decisionsCapture` **不删除**，退成 `config.yml` 的高级档位，与
   `decisionsMaxContentChars` / `decisionsMaxBytes` 同级（后两项本来就是
   配置文件only）。「只存元数据、不保存会话正文」那个隐私档位因此没有消失，
   只是不再占配置页的位置。
3. 服务端能力一律不动：`decisionsCapture` 仍在 Config schema、仍在 `PUT
   /config` 白名单、仍在 `statusPayload` 回传、客户端仍在 patch 里**原样提交**
   （草稿由 status 派生，因此手改过 `config.yml` 的值不会被界面覆盖）。
   `test/decisions-route.test.js` 里那三条针对它的断言继续有效——它们测的是
   服务端能力，不是界面行。
4. 删掉随行一起失效的 3 个词条（`EN_MISC` 的「决策内容」、`T_MISC` 的两条
   子开关说明）。同时把原本**未被使用**的「关闭后不写任何明细文件…」用起来，
   作为关闭态的提示。

**测试与教训**：新增 1 项断言「配置页恰有一行决策历史、且没有 `decisionsCapture`
那一行」。**这一项的第一版是错的**：我用文案当判据（断言页面文本里不出现
「决策内容」），而 `stateWith({})` 下开关是开着的，我改的却是关闭态的文案——
**变异测试证明它抓不到**（故意让「决策内容」出现，测试照样全绿）。第二版改用
行上的 `key`（就是配置键名）当判据：它不随开关状态变化，变异后立刻变红。
这条经验与 DEC-024 同源：**断言要盯住不随状态漂移的事实**，否则测试只是
在复述自己。

**改动文件**：`lib/client.js`（合并两行、换提示、删 3 个失效词条）、
`test/client-ui.test.js`（+1 项）、`config.example.yml`、`README.md`。
全量 426 项通过（写这条时是 425；随后补了一条「关闭态仍只有一行、且说明后果」的用例，故为 426）。
## DEC-025 移除决策点筛选控件（2026-11-03）

**背景**：DEC-024 刚把「点名表要自己拉」修好，用户随后要求：**「去掉决策点
filter 功能吧，始终做不好。」**

**决定**：接受，整块移除。删掉的东西：

- `DecisionsView` 里的 `filter` 状态、`visible` 派生、以及那排「全部 + 各决策点
  芯片」按钮；
- 配套的筛选提示文案「已筛选「{point}」：{shown} / {total} 条」；
- 随之失效的两个词条（`T_MISC` 的筛选模板、`EN_MISC` 的「全部」）；
- 三项筛选交互测试，换成一項**反向断言**：按钮只应剩「刷新」、页面上不该再
  出现「已筛选」。断言「控件不在」比断言「控件好用」更能防止它悄悄回来。

**保留的东西（重要）**：**点名表仍然由视图自己拉**（DEC-024 的修复），
因为「决策点」这一**列**还在——去掉列名映射的话，那一列又会显示
`turnStop` 这种原始 id。移除的是**筛选交互**，不是点名表。

**为什么移除而不是继续修**：这个交互的失败形态无法由我在本地验证（GUI 需要
`dsh web` 的认证 URL，我看不到真机 DOM），而它已经连续两轮占据排查时间：
第一次是表头 sticky（DEC-023），第二次是点名表与「点击无效」（DEC-024）。
一个**只能靠用户回传现象**才能确认的小控件，收益远小于它的维护与沟通成本。
去掉它之后，剩下的交互只有一个「点行展开」——它同样有真实状态下的测试覆盖。

**测试**：全量 424 项通过（比上一版少 2 项：移除 3 项筛选交互测试、新增 1 项
反向断言）。测试桩保持**有状态**（DEC-024 的成果）——「点行展开/收起」那个
用例依赖它，不能因为筛选没了就把桩退回空操作。

**改动文件**：`lib/client.js`（移除 filter 状态、芯片、提示与两个词条）、
`test/client-decisions-view.test.js`（删筛选用例、加反向断言、`SLOTS` 中
`labels` 序号由 5 前移到 4、清理不再使用的助手）、`README.md`。
## DEC-024 决策历史：点名表要自己拉；渲染测试桩必须有状态（2026-11-03）

**背景**：用户反馈「表格头的决策点 filter 点击后无效，比如点击 turnStop 并没有
更新表格」。

**排查结论——筛选逻辑本身是对的，但暴露了两个更严重的问题**：

1. **真机上显示的是原始 id，不是中文点名。** `DecisionsView` 从
   `props.pointLabels` 取点名表，而**宿主根本不会传这个字段**，注册时也没法带
   （注册发生在 `apply()`，那时还没有任何服务端数据）。兜底成 `{}` 之后，
   芯片与「决策点」列显示的就是 `turnStop`、`authorize` 这类原始 id——用户
   说的「点击 turnStop」正是这么来的（正常应显示「轮次延续」）。
2. **我的渲染测试桩把 `useState` 的 setter 写成空函数、`useEffect` 写成空操作。**
   于是「点一下筛选芯片」这条路径**从来没有被真正执行过**：测试全绿，真机上
   点击却没有任何反应。只断言「初始画面」的渲染测试，对交互等于没测——这一次
   假信心比缺陷本身更危险。

**决定**：

1. **点名表由视图自己拉**（`GET /decisions` 本来就在下发 `points[].label`）。
   拉不到就退回显示原始 id——**功能仍然可用**，只是名字难看；不因为一个
   「显示名」把整页判成错误。
2. **渲染测试桩改成有状态的**：
   - `useState` 跨渲染保留，setter 真的改值；
   - `useEffect` 真的执行，并**按依赖比较**决定是否重跑（`Object.is` 逐项比，
     与 React 一致）——不做依赖比较会陷入「取数 → setState → 再取数」；
   - `useCallback` / `useMemo` 真的记忆化。少了它，`load` 每次渲染都是新函数，
     依赖 `[load]` 的 effect 每轮都重跑，桩会把**不存在**的抖动当成真实行为；
   - 暴露 `click(按钮文本)` / `clickRow(n)` / `rowTexts()`，真正调用 `onClick`
     并重渲染后再断言。
   - 定时器在桩里不真建（视图有 5 秒轮询，真建了进程会挂着）。
3. **筛选生效时给显式提示**「已筛选「轮次延续」：3 / 200 条」。光靠芯片高亮
   不够：高亮在深色主题下不明显，而「点一下到底有没有生效」必须肉眼可判——
   否则用户会以为点击无效（这次就是这么反馈的）。
4. **新增 5 项交互测试**：点芯片筛选、再点取消、点「全部」清空、点行展开/收起、
   点名表由视图自拉。并**做变异测试确认这些测试有牙齿**：把筛选改坏 → 3 项变红；
   把点名表改坏 → 7 项变红。这一步是必须的——上一次就是「测试全绿但功能没生效」。

**同时修掉一处顺序陷阱**：新加的 `labels` useState **必须声明在最后**。本文件
按「第 n 个 useState」注入状态（`SLOTS`），往中间插一个槽位会把后面全部挪位，
测试会静默断言错对象。注释里写明这条约束。

**改动文件**：`lib/client.js`（点名表自拉、筛选提示、`labels` 槽位放末尾）、
`test/client-decisions-view.test.js`（有状态桩重写 + 5 项交互测试 + SLOTS 说明）、
`README.md`。全量 426 项通过。
## DEC-023 ⛔️ 修订 DEC-022 第 9 条：表头冻结不能靠「让宿主滚 + sticky」，必须自建一定会滚的容器（2026-11-03）

**背景**：DEC-022 第 9 条写的是「容器改成 flex 列：工具条固定、表格区自己滚，
`th` 用 `position:sticky; top:0` 钉在滚动区顶部」。真机反馈：**表头仍然跟着
一起滚走**（「表单头（时间、决策点 等）并没有 freeze，会随着 scroll view 一起
滚动」）。

**为什么失效——三条原因叠加，每一条都足以单独致命**：

1. **`height:100%` 在这里拿不到参照高度**。宿主那条布局链的中间层是
   `flex:1 0 auto; min-height:auto`——**会长到内容高度**（dsh-retrace 为
   同一件事写了 `bindListHeight()`，注释里明确记着这个坑）。父级高度不确定时
   `height:100%` 退化成 `auto`，于是我那个 `flex:1 1 auto; minHeight:0`
   的内层滚动区永远等于内容高度、**永远不产生自己的滚动条**。
2. **于是真正滚的是宿主的容器**，而 `position:sticky` 只认「最近的滚动祖先」。
   我的 `th` 在粘一个从不滚动的盒子。
3. **`overflow:hidden` 会吃掉 sticky**。`decisionsWrap` 上那个 `overflow:hidden`
   （本意是「避免双滚动条」）把自身变成了 sticky 的滚动/裁剪祖先，粘性只在
   它内部生效——而它从不滚，粘性等于没写。

此外还有一个独立的问题：表格当时是 `border-collapse: collapse`。这在
Chrome / Safari 上会让 **sticky 表头单元格直接失效**（边框被合并到表格元素上，
单元格不再是独立的粘性盒子）。也就是说即使前三条都修好，这一条还会再挡一次。

**决定**：

1. **不赌宿主的内部结构，自己造一个「一定会滚」的容器**。宿主链里只要有任何
   一层是 `overflow:hidden`（宿主布局的常见写法），纯靠宿主滚动的方案就会
   再次失效，而我看不见真机的 DOM。
2. **限高用 `maxHeight: calc(100vh - 200px)`，不用 `height:100%`**。块级盒
   自己就能算出这个高度，与父级高度无关，内容一超就自己滚——sticky 于是
   总能找到一个**真的会滚**的祖先。配 `minHeight:160px` 保证窗口很矮时也
   还剩几行可看。200px 是给宿主 chrome（标题栏 / tab 栏 / 本页内边距）留的
   余量。
3. **表头之上不再有多余的 overflow/定高层**：`decisionsWrap` 刻意**不写**
   `overflow` 与 `height`（工具条留在滚动区外，仍不滚）。
4. **表格改 `border-collapse: separate; border-spacing: 0`**，靠每格自己的
   `borderBottom` 画线，视觉不变。
5. **表头背景继续走不透明的主题基色令牌**。这里保留 DEC-022 的判断：不能用
   `opacity` 压低表头文字——`opacity` 会连背景一起变半透明，正文会从表头
   底下透出来。

**为什么不学 dsh-retrace 用 `ResizeObserver` 量高度**：那条路要读
`window.innerHeight`、监听 resize、还必须在 flex 环境里手工把 `flex` 改成
`none`（否则 height 被 flex-basis 吃掉）。为一个「表头别滚走」引入整套尺寸
编排，反倒成了以后最容易坏的地方——宿主布局一改就失效。`maxHeight` 方案
没有状态、没有监听、没有测量。

**这次的教训写成可断言的约束**（sticky 失效**不报错、不会让测试变红**，
只有人眼在浏览器里滚动才看得出来，所以必须钉成样式事实）。
`test/client-decisions-view.test.js` 新增 3 项：

- 每个 `th` 都有 `position:sticky` + `top:0` + **不含 `rgba(`** 的背景；
- `table` 是 `border-collapse:separate`（不是 collapse）；
- 存在一个 `overflowY:auto` 且 `maxHeight` 含 `vh` 的滚动祖先，同时该层
  没有 `height:100%`；根容器没有 `overflow` / `height`。

**并修正一处认知**：这类「宿主提供的槽位里的 CSS 布局问题」在本项目里无法
用单测或类型检查发现，也**无法由我验证**——GUI 需要 `dsh web` 的认证 URL，
我看不到真机 DOM。所以样式约束必须转成对渲染树里 style 对象的断言，而不是
「装好了就算完」。

**改动文件**：`lib/client.js`（`decisionsWrap` / `decisionsScroll` /
`decisionsTable` / `decisionsTh` 四处样式与渲染层结构）、
`test/client-decisions-view.test.js`（+3 项）。全量 421 项通过。


## DEC-022 会话级「决策历史」标签页：另立明细文件，内容默认落本地（2026-11-03）

**背景**：用户要求「在当前 session tab 处新增一个 Decisions tab，放在内置的
对话 / 轨迹旁边，点击后按时间顺序列出**当前会话**里经过本插件进行的所有决策
历史，包括 provider、model、内容、决策方案」。

**先检视现有数据，结论是答不出这个问题**——不能靠「加一个 tab」实现：

1. `telemetry.jsonl` 的字段是 `ts/point/tag/mode/tool/model/provider/action/
   detail/latencyMs/cached/inputTokens/scores`，**没有会话维度**，也**没有
   决策内容**（`state` / `questions` / `answers` 从来没落盘）。实测平均每行
   377 字节（981 行 416 KB）。
2. `stats.jsonl` 同样没有会话维度（它按 provider × model 聚合）。

所以这个功能的真实成本 = 新增一份**本地**明细 + 一条按会话查询的路由 +
一个 view。前两项是主体。

**决定**：

1. **另立 `decisions.jsonl`，不改 `telemetry.jsonl`**。理由不是「懒」：
   `telemetry.jsonl` 是 DEC-013 定义的「服务端到底说了什么」的人读审计流水账，
   而且它是 `StatsStore.backfillFromTelemetry()` 的唯一回填来源。带内容后它
   会膨胀十到十五倍，同时破坏两件事——`tail -f` 的可读性，以及回填读每一行
   的成本。两个文件各管一件事：遥测管**结论**，明细管**现场**。
2. **会话归属是新能力**。`Session.id` 是官方 getter，各决策点的现场本来就有
   `agent.session` / `exec.agent.session`；此前没取，只是没人需要。现在由
   `engine.ask()` 统一取（`extra.session` 既接受 Session 对象也接受 id 字符串），
   **异常一律退化成空串**——空串 = 不可归属。
3. **不可归属的记录不进任何会话页**。思维链翻译点使用免费通道（google / bing）
   时，`TranslationSpec` 里根本没有 `sessionId`（只有付费档有）。这是刻意的
   取舍：为它编一个会话 id 会让用户看到不属于自己会话的记录，比缺失更糟。
   这一点写进 README 与代码注释，因为它是用户会问的那类问题。
4. **内容默认落盘，但边界写死三条**：
   - **只落本地**：这条链路不发任何网络请求，也**不进**匿名统计（DEC-020 的
     七个字段与它无关）；
   - **写盘前脱敏**：`maskSecrets()` 对**整行 JSON** 做模式替换（`sk-…`、
     `ghp_…`、`Bearer …`、JSON 里的 `apiKey`/`authorization`/`password`/
     `secret`/`token` 字段）。定位必须写明是**兜底**而不是保证：没有固定形态
     的密钥没法靠模式识别，这里只拦最常见的泄漏形态；
   - **有上限**：单条内容超 `decisionsMaxContentChars`（默认 4000）时按
     「`state.args_preview` → `state.recent` → 整个 `state`」依次裁剪，
     `questions`/`answers` 排最后——它们才是页面存在的理由，`state` 是背景
     材料。连问题与回答都装不下时才退回 `capture: 'meta'`。文件超
     `decisionsMaxBytes`（默认 8 MB）轮转成 `.1`，**只留一代**（这个页面是
     「看刚才发生了什么」，不是归档；多代备份让占用变成上限的整数倍）。
5. **开关关闭 = 真的不写**。`DecisionStore.record()` 在开关关闭时直接返回
   false：不建文件、不占磁盘、不采集内容。不是「写了藏起来」。这是一个
   **隐私承诺**，不是性能优化。
6. **tab 用官方 `conversation.view` 槽位**，`id: 'decisions'`、`order: 15`
   ——排在 `chat`(0)、`trajectory`(10) 之后，第三方插件（retrace 20 /
   git-panel 30）之前。`label` 用 thunk（官方契约明确 thunk 每次投影重读，
   语言切换无需重注册）。**条件挂载**：配置页改了开关要能生效，而该槽位
   注册/注销是运行时操作，因此客户端按 `/status` 的**生效值** reconcile，
   在窗口聚焦时与 60 s 兜底轮询各重读一次。
7. **写盘前把一批切成片**。这是被测试抓出来的真缺陷：最初「写之前判断
   `已追加 + 这一批 > 上限` 就轮转」，但一批可以很大（连续记 300 条约 60 KB），
   而写之前文件还是空的，判断永远不成立——**上限形同虚设**。改成先按上限
   切片（切点必须落在行边界上，否则 JSONL 一行被劈成两半就是坏行），
   片与片之间才触发轮转。
8. **`detail` 是数据，不是 UI 文案**。展开详情里的裁决原因是服务端写的原始
   审计文本（`decision-engine: 风险低，放行`），**原样输出、不过 `t()`**：
   翻译审计记录等于篡改记录。i18n 覆盖测试因此只约束界面文案，另有一条
   测试专门断言「英文界面下审计原文不被翻译」。
9. **表头 sticky，整页不滚**。容器改成 flex 列：工具条固定、表格区自己滚，
   `th` 用 `position: sticky; top: 0` 钉在滚动区顶部（记录一多时列名会滚走，
   用户只能靠记忆对列）。sticky 要生效必须满足三条：`top` 有值、滚动容器是
   直接祖先、背景**不透明**。这里刻意**不用 `opacity` 压低表头文字**——
   `opacity` 作用在整个元素上会连背景一起变半透明，正文从表头底下透出来，
   正好破坏第三条；改用 `--dsw-alias-label-secondary` 文字色把存在感压暗，
   背景走 `--dsw-alias-bg-base`，浅色/深色主题都对。

**顺带修掉的既有缺陷（与本条同批）**：配置页的「匿名统计」下拉**从来没
生效过**——`telemetryLevel` 既不在 `PUT /config` 的 `allowed` 白名单里，
也不在 `configPatchOf` / `patchDiffersFromServer` 里，`statusPayload` 也
不回传它。于是那个下拉能点、能显示「已保存」，后端却回 400
`no updatable fields`，值从未落盘；界面还永远停在兜底值 `daily`。
**用户以为把统计关掉了，实际每天照发**。隐私开关静默失效是这类问题里
最严重的一种。四处一起补上，并加了两条回归测试（保存后回显 + 落盘检查）。

**测试**：新增 51 项——`test/decision-store.test.js`（26 项：记录体、会话
归属、脱敏、截断、队列、轮转、尾部读、坏行、权限、开关）、
`test/decisions-route.test.js`（12 项：400 校验、会话过滤、空/坏文件、
limit 上限、开关链路、匿名统计回归）、
`test/client-decisions-view.test.js`（15 项：注册与 order、开关卸载、
thunk label、字段、时间序、展开内容、空态、错误态、坏记录、截断提示、
缓存/降级标记、英文零残留、审计原文不翻译）。全量 416 项通过。

**改动文件**：新增 `lib/decision-store.js`；修改 `lib/engine.js`（sessionId +
可选 `recordDetail` sink）、`lib/adapters/{route,tools,agent,translate}.js`
（传 session）、`lib/index.js`（Config 四键、DecisionStore 接线、authorize
采集、statusPayload、PUT 白名单、`/session-decisions` 路由）、
`lib/client.js`（词条、样式、开关链路、`DecisionsView`、reconcile 挂载、
表头 sticky）、`config.example.yml`、`README.md`，以及三个新测试文件。


## DEC-021 统计加「插件维度」：上报自报家门，D1 按插件分账（2026-11-02）

**背景**：DEC-020 的统计只服务 `dsh-decision-engine` 一个插件——上报体里没有插件
标识，Worker 把包名写死在 npm 下载查询与推送标题上，D1 各表的主键也不含插件。
将来 dsh 生态里出现第二个、第三个插件时，这些数字会**跨插件混在一起**，而且
「加一个插件」意味着改 Worker 代码、改推送标题、改下载查询。

**根因不是「少一个字段」，是维度缺失**：`installs` 的主键是 `install_id`、
`daily_active` 是 `(day, install_id)`。两个插件在同一台机器上各自生成自己的
install_id，撞车概率低但**并不保证不同**；更关键的是查询无法回答
「这个插件今天有多少人用」——它只能回答「所有插件一共多少人」。

**决定**：

1. **上报体自报家门**：新增 `p` 字段（plugin id，npm 包名形态，小写、
   `[a-z0-9._-]`、最长 48）。客户端从 `package.json` 的 `name` 读，不写死常量——
   写死的话，仓库拆子包或有人 fork 改名会把两个不同插件混成同一条统计线。
2. **没有合法 `p` 就拒发**（`prepare` 阶段直接返回 null）。宁可少一条数据，也不能
   往公共统计里塞一条无法归属的记录——那是多插件共存时最难收拾的脏数据。
3. **`p` 提为第一等维度**：五张明细表全部加 `plugin` 列并**并入主键**
   （`installs` → `(plugin, install_id)`、`daily_active` → `(plugin, day, install_id)`、
   `downloads` → `(plugin, day, source)`、`version_daily` → `(plugin, day, version)`、
   `digest_log` → `(plugin, day)`）。SQLite 不支持修改主键，因此迁移用
   「建新表 → 搬数据 → 改名」（`0002_plugin_dimension.sql`），旧数据按历史事实
   回填 `dsh-decision-engine`——这一版之前只有它一个上报方，回填值是确定的，不是猜测。
4. **所有聚合查询按 plugin 过滤**，所有写入带 plugin、`ON CONFLICT` 从 plugin 起匹配。
5. **npm 下载与推送标题都按插件区分**。npm 查询改 `encodeURIComponent(plugin)`；
   标题从写死的 `dsh-decision-engine <day>` 改成 `<plugin> <day>`。
6. **日报按插件逐条发**：`scheduled()` 先用 `SELECT DISTINCT plugin FROM installs`
   读插件清单（而不是写死常量），对每个插件各跑一次 `runDigest` 并发一条 Bark。
   新增插件只要开始上报，第二天自动进日报，**不必改 Worker 代码再发版**。
   清单为空时兜底跑默认插件，保证首日也有日报。
   `digest_log` 去重按 `(plugin, day)`：两个插件的日报是两条独立消息，不能因为
   「今天已经推过一个」就把另一个跳过。
7. **老客户端兼容**：升级前那批上报体没有 `p` 字段，服务端按历史事实回填
   `DEFAULT_PLUGIN`，而不是丢弃——丢掉的代价是那段时间的 DAU 永远缺一块且无法补回。
   带了 `p` 但非法的（被人直接 POST 或客户端被改坏）直接 400，**绝不猜测归属**。

**测试**：新增 6 项多插件断言——五张表主键都必须含 plugin、所有聚合查询必须带
`plugin=?`（唯一豁免是「列出有哪些插件」那条）、所有 INSERT 必须带 plugin 列且
`ON CONFLICT` 以 plugin 开头、npm 查询与标题不得写死包名、插件清单必须动态读取
且有空表兜底、老客户端回填与非法 `p` 拒绝。`parseSchema` 改为跟随
`CREATE … RENAME TO`，否则检查器会拿迁移前的旧定义误报。全量 365 项通过。

**改动文件**：`lib/telemetry.js`（`normalizePluginId`、`buildPayload` 增 `p`、
构造器与 `prepare`）、`lib/index.js`（`readOwnPackage` / `readOwnPluginId`）、
`site/make-bundle.mjs`（采集校验、所有 SQL、npm、标题、scheduled 多插件循环）、
`site/migrations/0002_plugin_dimension.sql`、`test/telemetry.test.js`、
`test/site-worker.test.js`。


## DEC-020 ⛔️ 修订：默认档位改为 daily，上报移到配置加载之后（2026-11-02）

**取代**：同号 DEC-020 原条目中「默认档位是 `install`」与「`void startTelemetry()` 紧跟 apply 开头」两处结论。
原条目保留不改（append-only），仅在此声明失效。

**推翻的理由一：`install` 档会让统计彻底失效。**

`install` 只在首次运行上报一次。这意味着装机之后再也不会有心跳，于是
`daily_active` 只会在安装当天有一行 —— **DAU / WAU / MAU 恒为 0**。
而需求恰恰是「每天看一次数据（新增下载、安装、每日 DAU）」。选更保守的默认值
看起来更「尊重用户」，但它让整个功能变成一个永远返回 0 的数字：既没实现需求，
也让「离线安装数」这种本该有用的口径失去可信度（谁也不会看一个恒为 0 的报表）。

**与「默认不擅自介入」的关系**：那条姿态约束的是**守卫**——`enabled: false`
意味着不干预会话的裁决。上报是旁路：不发请求给 provider、不改任何裁决、
不增加任何决策路径延迟（`apply()` 里 `void` 掉）。隐私边界写死在上报体本身
（7 个字段、无内容字段）。因此默认 `daily` 不违背该姿态；`off` 依然是一个
请求都不发的硬承诺，且有测试专门断言「off 时 fetch 一次都没被调用」。

**推翻的理由二：上报时机早于配置加载，会把 `off` 当成默认档。**

`apply()` 开头的 `cfg` 只是 `DEFAULTS` 的副本；用户在 `config.yml` 里写的
`telemetryLevel: off` 要等 `reloadOwnConfig()` 合并后才生效。原实现紧跟
`apply` 开头就 `void startTelemetry()`，在「读配置」之前就发了请求——
一个明确关掉统计的用户，每次启动仍会被上报一次。这既是隐私承诺的破口，
也是典型的「读了 DEFAULTS 就当成用户配置」错误（仓库里同类的坑见 DEC-001）。

改成等 `reloadOwnConfig()` 落定后再上报；读配置失败时用 DEFAULTS 兜底，
上报本身的失败只记一条日志，不影响插件。

**代价**：启动时上报会晚一个微任务（读一个 yml 文件的时间），但它是 `void`
掉的旁路，不参与任何 await 链，对启动无感知。

**测试**：新增「默认档位是 daily」用例——构造器不传 level 时必须是 `daily`，
且次日的 `start()` 必须继续上报（`kind === "heartbeat"`）。这条用例同时钉住
了「DAU 能否存在」这个前提；`resolveLevel` 的未知值兜底也改为 `daily`。
全量 359 项通过。

**改动文件**：`lib/telemetry.js`（`resolveLevel` 默认值与构造器默认档）、
`lib/index.js`（`DEFAULTS.telemetryLevel`、上报时机移到 `reloadOwnConfig` 之后）、
`lib/client.js`（界面文案、draft 初值、status 兜底）、`README.md`、
`config.example.yml`、`test/telemetry.test.js`。


## DEC-020 匿名使用统计：每日心跳 + D1 + Bark 日报（2026-11-02）

**背景**：插件已在 npm 上（`dsh-decision-engine`），但只有下载数（npm API 口径），
不知道「装了多少台、每天有多少人在用」。需求是统计下载 / 装机 / DAU 与使用频率，
并且**不要展示页**——只要每天收到一条推送。

**决定**：

1. **两套口径分开**。下载数取 npm 官方 API（`api.npmjs.org/downloads/point/<day>/<pkg>`），
   装机与 DAU 取插件主动上报的匿名心跳。二者不可互相替代：npm 下载包含 CI、镜像、
   重复安装；心跳只反映真正跑起来的实例。
2. **匿名心跳的存在最小化**。字段只有 7 个：`v`（协议版本）、`id`（安装 UUIDv4）、
   `k`（install/heartbeat）、`ver`、`os`、`arch`、`d`（当日决策数）。
   **永不上报** API key、prompt / 工具参数、cwd、provider URL、会话内容、用户名；
   **服务端不读、不存 `CF-Connecting-IP`**。`id` 是首次运行生成的随机 UUIDv4，
   删除 `~/.dsh/dsh-decision-engine/analytics.json` 即换新身份。
3. **档位默认 `install` 而不是 `daily`**。仓库既定姿态是 `enabled: false`「不擅自介入」；
   每天联网属于更主动的行为，默认开它与此姿态冲突。「每天一次」留给用户显式开启。
   `off` 是**真的不联网**：`prepare()` 在任何文件读取之前就返回，没有版本检查、没有 DNS。
4. **状态文件叫 `analytics.json`，不叫 `telemetry.json`**。同目录已有 `telemetry.jsonl`
   （用户的本地决策流水账，会被 `tail -f`）。两个只差一个字母、口径完全不同的文件
   放在一起，迟早有人清缓存时删错——删错流水账等于丢掉用户的决策审计记录。
5. **「一天」固定按 UTC+8 算**。中国自 1991 年起无夏令时，`(ms + 8h)` 取日历日即当地日期，
   不需要 Intl / 时区数据库（Electron 里还取决于 ICU 打包方式）。客户端与服务端同一算法。
6. **落库用 `ctx.waitUntil` + `DB.batch`**。心跳先回 `202`，写入放 `waitUntil`；
   不用 `waitUntil` 的异步写入会在调用结束时被取消。`installs` 与 `daily_active`
   两条 upsert 合成一个 `batch`：一次往返、一个事务、也只算一次查询（Free 档每次
   调用 50 查询上限）。`decisions` 取 `MAX` 而非累加——同一台机器异日重复上报也不会翻倍。
7. **推送在 Worker 的 `scheduled()` 里做，cron `42 10 * * *` UTC**（= 18:42 Asia/Shanghai）。
   Bark 用 `GET https://api.day.app/<key>/<title>/<body>`，key 存 **Worker Secret
   `BARK_TOKEN`**（不入库、不进 wrangler.jsonc）。`digest_log` 表按天去重，
   保证手工触发与 cron 撞车时不会推两条。
8. **不建展示页**。用户明确说只需要每天看一次数据。省下两个页面、图表代码与
   `/api/stats` 读接口，也就省掉了「静态页 ETag 是 content-blind、旧图会一直 304」的坑。

**迁移是一次性的手工步骤**：`wrangler deploy` **不会**执行 D1 迁移，上线前必须
`npx wrangler d1 migrations apply dsh-telemetry --remote`，否则首条 INSERT 就会因为
表不存在而失败。

**改动文件**：`lib/telemetry.js`（新增，纯函数 + 注入式上报器）、`lib/index.js`
（`telemetryLevel`/`telemetryEndpoint` 配置、`readOwnVersion`、`apply()` 里 `void`
调用的上报钩子、status 回传与 PUT 白名单）、`site/make-bundle.mjs`（`/api/e` 采集、
`scheduled()` 汇总、npm 拉取、Bark 推送）、`site/migrations/0001_init.sql`、
`site/wrangler.jsonc`（D1 绑定 + cron）、`test/telemetry.test.js`。

**测试**：`test/telemetry.test.js` 16 项——日界换算、id 稳定性与可重置、
`off` 档「fetch 一次都没被调用」、同一天不重发、install 档终身只报一次、
发送失败不抛错且当天不重试、第 30 次失败触发降级、payload 字段白名单与
禁用字段断言（`prompt|key|token|path|cwd|url|user|ip|session|email`）、
状态文件损坏后能自愈。全量 352 项通过，`verify-wiring` 通过。


## DEC-019 审批卡标题双语：ask 裁决附带 displayReason（2026-11-02）

**背景**：宿主界面是英文时，授权审批卡的**标题**仍是中文，例如
`decision-engine: 中风险调用，需人工确认（risk=medium p=0.84 irrev=0.74 task=0.78 inj=0.03）`，
而同一张卡上的 `Waiting for approval` / `Reject` / `Allow once` 都是英文——看起来像
「这卡翻译了一半」。

**根因**（对着宿主 0.2.1-rc.5 的 `app.asar` 逐跳核对）：

1. 标题来自 `decideGuard()` 造的 `reason`，中文硬编码（四条 ask 分支）；
2. 宿主审批卡本身是**双语的**：`@deepseek-ai/dsh-client-ui-approval` 的
   `ApprovalPanel` 用自己的 `approval` 命名空间词典渲染 `waiting` / `reject` /
   `allowOnce`，跟着「设置 → 语言」走；
3. 但标题走的是另一条路。`ApprovalPanel` 渲染
   `approval.displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason)`，
   而宿主契约 `PreToolDecision` 的 `ask` 分支本来就有
   `displayReason?: { en: string; [locale: string]: string }`，由
   `ctx.locale.resolveText()` 按当前语言解析（映射必须带 `en` 回退值）；
4. 本插件只回传了 `reason`——`displayReason` 在整个仓库里零出现，宿主只能回退到
   中文原文。

所以这不是「宿主没翻译」，是**我们没用宿主已经提供的本地化通道**。DEC-018 的双语化
只覆盖 `lib/client.js`（配置页/统计页，在渲染边界替换），守卫的 `reason` 走
Node → 宿主审批卡那条路，不在它的链上——`test/i18n-coverage.test.js` 也只扫
`lib/client.js`，所以这几句从来没被兜住。

**决定**：

- `reason` **保持中文原文不动**：它进宿主的 `approval/asked` 审计事件，也进本插件
  遥测的 `detail`，改它会让历史口径漂移（`test/guard-threshold.test.js` 还断言了
  其中的中文）。
- 四条 ask 分支统一由 `askOutcome()` 产出，额外带 `displayReason: { zh, en }`；
  `zh` 与 `reason` 逐字相同，`en` 是对应译文，`evidence` 摘要语言中立、两边共用。
- 守卫把 `displayReason` 原样透传给宿主（`tools/pre-execute` 的返回处，此前只传
  `reason`）。
- `deny` 不带：宿主 `PreToolDecision` 的 deny 分支没有 `displayReason` 字段，且
  deny 的 `reason` 是给模型看的工具错误，不是审批卡文案。

**没做的事**：没把 `reason` 改成英文、没让客户端词表去翻它（跨进程，翻不到）、
没动 DEC-018 的渲染边界方案。

**测试**：`test/guard-display-reason.test.js` 把住四条分支——每条 ask 的
`displayReason.zh` 与 `reason` 逐字相同、`en` 不含任何 CJK 字符且保留 `evidence`、
`delegate` / `deny` 不带 `displayReason`。

## DEC-018 配置与统计界面双语：中文是源语言，在渲染边界按宿主语言翻译（2026-11-01）

**背景**：面板此前只有中文。宿主（DSH）自己带 `locale` 服务（`dsh-client-locale`，
提供 LocaleFace：`getSnapshot()` → `{ active, locales, revision }`、`subscribe(fn)`、
`register(ns, {zh, en})`、`bind(ns)`），设置页里也有语言选择。用户希望界面跟着宿主
语言走，而不是固定中文。

**决定**：中文保持为源码里的源语言，英文是一张「中文原文 → English」的词表；
在**渲染边界**（`createElement` 的包装 `h()`）按当前语言替换。带变量的句子不能整段
命中，所以那 30 多处改成显式 `t("模板 {name}", {...})`。

**为什么不在每个调用点写 key（`t("stats.title")`）**：

1. **一半文案不在本文件里**。决策点名、区间标签、历史数据说明、错误分类都由服务端
   下发（`/decisions` 的 `point.label`、`/stats` 的 `labels`、`lib/client-errors.js` 与
   `lib/errors.js` 的 label）。按 key 翻译就得让服务端也双语化，并给每个接口加语言
   参数——改动面从 1 个文件变成 5 个，每加一个字段还要两边同步。在渲染边界翻译，
   服务端下发的中文与代码里的中文走同一条路。
2. **漏翻的失败模式更好**。按 key 写漏了显示 `stats.title` 或空白；这里漏了只是
   那一格保持中文——是中文，不是乱码，也不是另一种语言的错译。
3. 代价是**必须整段命中**。跨行 `"a" + "b"` 在运行时会合成一整句，逐片段登记永远
   命中不了——这正是实现时真的踩到的坑（两处：端点风格说明、节省量不可用提示），
   所以新增了静态守卫（`test/i18n-coverage.test.js`）专门盯这件事。

**跟随语言的方式**：`apply()` 里先读 `ctx.locale.getSnapshot().active`（读不到再试
`active` / `language` 等直接属性），再 `yield` 一个订阅：优先 `ctx.locale.subscribe`
（每次快照变化都回调，含词典注册），备用 `ctx.on("locale/change")`（只在切换时发）。
订阅回调只更新模块级 `lang` 并通知 `useLang()` 注册的组件重绘。宿主没有 locale 服务
时回落 `navigator.languages`（与宿主默认口径一致：带 `zh` 前缀算中文，其余算英文）。

**没有用宿主注入的 `t` 席位**：`t` 只在槽位声明了 `locale: NS` 时才由框架注入，且只能
翻译**本命名空间**的 key，翻不了服务端下发的文案。本插件要翻的正好是「服务端下发的
那批中文」，所以自己持有一张表更直接。槽位仍保留 `locale: NS`（宿主据此注入 `t` 并
在切换时重绘 outlet），与自持词表并存不冲突。

**测试**：`test/client-i18n.test.js` 把着真实宿主 locale 桩渲染整页，断言英文界面里
**没有中文字符**（品牌名「硅基流动」按服务端数据单独登记）；覆盖首屏未加载、保存失败、
custom 表单、统计错误/空区间、错误尾部等分支。`test/i18n-coverage.test.js` 做静态兜底：
渲染位置的中文都有英文、跨行拼接的整段不被漏翻、英文译文里不残留中文。

## DEC-017 入口文件由 wrangler 的 build.command 现场生成，不依赖 CI 的 Build command 字段（2026-10-28）

**背景**：DEC-016 把 Workers Builds 接上之后，第一次真实构建走过了 clone，
死在 deploy：

```
✘ [ERROR] The entry-point file at "worker/bundle.js" was not found.
Failed: error occurred while running deploy command
```

原因很朴素：**后台的 Build command 是空的**。Workers Builds 见它留空就跳过
构建步骤，而 `worker/bundle.js` 是 `make-bundle.mjs` 的生成物（gitignore，
仓库里根本没有），deploy 自然找不到入口。

**这不是配置失误，是配置的形状错了。** DEC-016 的方案把「deploy 能不能成功」
押在 dashboard 上另一个字段有没有填对——两个字段（Root directory、Build
command）必须同时正确，构建才活。这种隐式耦合迟早再翻车：字段被谁改回空、
新连接漏填、复制项目时丢设置，失败都长一个样，报错还指向入口文件，排查
路径极长。

**决策**：在 `site/wrangler.jsonc` 里声明

```jsonc
"build": { "command": "node build.mjs && node make-bundle.mjs" }
```

即 wrangler 的 custom build：`wrangler deploy` 在打包**之前**自己执行它。
生成物被谁消费，谁就负责当场造出来——入口文件的存在不再取决于任何外部字段。

**验证**（干净 clone，`site/worker/` 不存在，模拟 Build command 留空）：

```
npm ci                              → exit 0
npx wrangler deploy --dry-run       → [custom build] Running: node build.mjs && node make-bundle.mjs
                                       Total Upload: 28.23 KiB / gzip: 21.18 KiB → exit 0
```

custom build 产出的 bundle 与线上那份 sha256 完全一致（`538e83f7…`），
重复构建字节不变。

**Build command 字段现在填不填都行**：留空 → wrangler 兜底；填 `npm run build`
→ 构建阶段与部署阶段在日志里分得更清楚。建议保留填上，但**它不再是成功的前置条件**。

**与 Cloudflare 文档的一条注记的关系**：文档提到 Workers Builds 不采用
Custom Builds 里的某些配置——那说的是 CI **构建阶段**不会替你识别/执行它；
而 deploy 阶段执行的就是 wrangler 本体，`build.command` 照跑不误。上面在
干净 clone 里的实测（模拟的正是 CI 的执行序列）确认了这一点。

## DEC-016 站点自动部署：Root directory 指向 site/，站点自成一个包（2026-10-28）

**背景**：站点（`site/` → `dsh.zuos.us`）一直只有手动部署一条路——本地跑
`node site/deploy.mjs` 直接调 Cloudflare API 上传 Worker 脚本并挂域名。
2026-10-27 把 `dsh-worker` 连到本仓库的 `main` 分支，想让它推送即部署，
结果**连续 4 次构建全部失败**，错误是：

```
Cloning repository...
Failed: root directory not found
```

这不是构建失败，是**构建根本没开始**——Workers Builds 连仓库都拿到了，
但找不到配置里指定的 Root directory。

**根因**：`site/` 在 2026-10-27 才进仓库（提交 `4ef171f`），而 Workers Builds
的 Root directory 是在连接时（建站初、仓库还没有 `site/` 的时候）设的，
指向一个当时不存在的路径。四次失败的构建正好对应 `site/` 进仓库之后的
四个提交（`755fd28a` / `d1ea5c3e` / `8dd4e7c4` / `f7c2ac94`），
更早的提交根本没有 check run——因为那时 Root directory 还不存在，
Cloudflare 直接跳过，不触发构建。

**决策**：不动 Cloudflare 后台的 Root directory（改成 `/` 也有坑，见下），
而是**把 `site/` 补成一个自足的 Wrangler 项目**：新增 `site/wrangler.jsonc`
与 `site/package.json`（+ 锁文件），让 Root directory 指向 `site` 后
一切自洽。

**为什么 Root directory 不能指向仓库根**——这是本条最容易被忽略的点：

仓库根的 `package.json` 声明了三个宿主自带包的 peerDependency：

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/schemastery": "*",
  "@deepseek-ai/dsh-session": "*"
}
```

这些包在 npm 上确实存在（`@deepseek-ai/dsh-session@0.0.1-rc.1`），
但它自己又依赖 `@deepseek-ai/dsh-type-meta@^0.0.1-rc.1`——
**这个包不在公共 registry 上**（实测 `npm install` 在仓库根 404 失败：
`npm error 404 Not Found - GET .../@deepseek-ai%2fdsh-type-meta`）。
这些包是**宿主 DSH 自带**的，由 DSH 注入运行时，插件仓库从来不需要、
也不应该去装它们。Workers Builds 的自动依赖安装会在 Root directory
（及其仓库根）跑 `npm ci`，Root directory 指向仓库根就必然 404。

`site/` 有自己干净的 `package.json`（只依赖 wrangler），装它不碰那些包，
问题消失。

**为什么 `site/package-lock.json` 要入库**：Workers Builds 用 `npm ci`
装依赖。没有锁文件时它会退回 `npm install`，每次构建解析出的 wrangler
版本可能不同（`^4.154.0` 会随上游发版漂移），构建就不再可复现。
锁文件让「同一份源码 → 同一个 bundle」成立。

**验证**（在干净 clone 上跑，等价于 CI）：

```
npm ci                 → exit 0
npm run build          → worker/bundle.js (27.9 KB)
npx wrangler deploy --dry-run → Total Upload: 28.23 KiB
```

且 CI 生成的 `worker/bundle.js` 与当前线上那份 **sha256 完全一致**
（`538e83f7…`）——说明构建是确定性的，接上自动部署后线上内容不会变。

**保留手动路径**：`site/deploy.mjs` 仍然能用。它走的是裸 API 上传
（不需要 wrangler），适合「不想装依赖只想推一把」的场景。
两条路产出的是同一份 `worker/bundle.js`，行为一致。

**顺带记一笔**：本次诊断暴露了本机 MCP 的 Cloudflare token 缺
`workers-ci.read` 权限，读不到构建配置，只能靠 GitHub check run 的时间戳
与提交对应关系反推（详见 `docs/lessons/cloudflare-builds-root-directory.md`）。

## DEC-014 决策点（point）的老记录归因：tag 与决策点本是一对一（2026-10-27）

**背景**：DEC-013 之后，统计页「按决策点」表里又出现一个 `unknown`。实测现网
stats.jsonl：377 条 `point=unknown`，全部 `estimated: true`（回填行），时间
集中在 2026-10-23 上午。

**根因**：遥测的 `point` 字段是 2026-10-23 13:33 才开始写的——更早的 428 条
老遥测只有 `tag`，没有 `point`。回填时 `entry.point` 缺失只能记 "unknown"。
但老遥测的 `tag` 与决策点是**确定的一对一**，不是猜：

- `guard` → authorize（授权守卫专用 tag，实测 2113 条全部如此）
- `adapter/X` → X（适配器异常出口统一用 `adapter/点id` 做 tag）
- 其余 tag 就是决策点 id 本身（engine.js 写 `tag: id`：delegate / turnStop /
  retrieval / skillPick / cotTranslate）

**决策**：

1. **回填按 tag 反推**（新增 `inferLegacyPoint(tag, point)`）：新遥测自带
   point 直接用；老遥测按上表反推；未登记的 tag 必须与决策点注册表
   （`DECISION_POINTS`）核对，对不上留 unknown——与 provider 反推同一个
   纪律：宁可 unknown，不猜一个不存在的决策点。

2. **迁移补回已落盘的 point**：`telemetryProviderIndex` 扩展为
   `telemetryIndex`（时间戳 → provider / point 双索引），迁移对
   `point=unknown` 的行按时间戳与遥测对上后补回。377/377 全部精确命中。

**效果**：现网 377 条 `point=unknown` 全部归位（authorize 2381 / delegate 85 /
turnStop 40 / retrieval 31 / skillPick 9），残留 0。

**注意**：与 DEC-013 的 provider 归因不同，point 没有对应「遥测写入点补字段」
的根治项——新遥测从 2026-10-23 13:33 起就**已经**带 point，此条只涉及更老的
历史数据。本条新增的反推仅服务回填，不碰新数据路径。

**改动文件**：`lib/stats-store.js`（`inferLegacyPoint`、`telemetryIndex`、回填
与迁移接入，引入 `DECISION_POINTS`）、`test/stats.test.js`（新增 3 项测试）。

## DEC-013 根治「未知（历史）」：遥测必须自带 provider（2026-10-27）

**背景**：DEC-011 / DEC-012 修的是**存量数据**（把已经落盘的 unknown 补回
provider / model）。用户随后追问机制问题：*为什么会出现「未知（历史）」和
unknown？* 也就是说：**这套机制本身**会不会再次产出这种标签。

**根因（实测证据）**：`telemetry.jsonl` 共 2713 条，其中

- **0 条**带 `provider` 字段；
- **347 条**连 `model` 都没有（全是 `action: degraded` 的失败记录）。

遥测是**回填历史统计的唯一来源**（`backfillFromTelemetry` 只读
telemetry.jsonl）。遥测不带 provider → 回填无据可依 → 只能记
`provider: "unknown"` → 界面显示「未知（历史）」。

**为什么以前没发现**：回填按模型名反推能救回大部分（startlux→bamboonode、
Kev/SemIf→硅基流动），于是「未知（历史）」看起来只是**老数据**的标签。但
**降级记录一个也救不回来**——它们没有 model。按今天的代码做一次全新回填的
模拟结果是：

```
bamboonode / startlux-decision-27b-autothink   记录 2281  降级   0
unknown / unknown                              记录  349  降级 349   ← 整块「未知（历史）」
siliconflow / Kev-4B                           记录   85  降级   0
```

**决策**：

1. **遥测自带 provider（根治点）**：所有遥测写入点都记上这次决策实际用的
   服务商——`classify()` 成功路径、引擎的 `engine.js` 两个写入点、授权守卫的
   两个写入点、以及 `classify()` 的 `degrade()` 降级路径。降级路径额外记
   `model`（本来会用的那个：配置留空时回落 provider 默认模型）。
   降级**也要归因**：失败发生在哪个服务商上是事实，藏起来会让「按 provider
   对比」看不见谁在超时。

2. **回填按可靠度取 provider**（新增 `providerOfTelemetryEntry`）：
   `entry.provider` → `entry.extra.provider` → `entry.extra.endpoint` 的主机名
   （新增 `providerByEndpoint`，只认内置预设的 baseUrl，自建地址不猜）→
   按模型名反推。四条路都走不通才退 `unknown`。
   老遥测的降级记录大多带 `extra.endpoint`（实测 349 条里 291 条有），
   因此**历史降级记录也能归因**了，不必只靠模型名猜。

3. **降级记录的 model 回落默认模型**（新增 `defaultModelOf`）：provider 定了，
   「本来会用的那个」就是它的默认模型。降级记录因此并进正确的那一行，
   而不自成「某 provider / unknown」零数据行。

4. **迁移也用遥测索引**（新增 `telemetryProviderIndex`）：统计行里没有
   `extra`，靠**时间戳**与遥测对上（与 `fillMissingModesOnce` 补 mode 同一
   套做法），因此连**真实记录**里 provider 确实 unknown 的降级行也能补回。

**效果（同一份现网遥测，修复前后对比）**：

| | 修复前 | 修复后 |
|---|---|---|
| provider=unknown 的行 | 349 | 62 |
| 降级记录归因 | 全部 unknown | 按 extra.endpoint / extra.provider 归位 |

剩下 62 条是老遥测里 `cooldown` / `no-key` 且 `extra` 为空或只有 `hint` 的
记录——**确实无从归因**，保留 unknown 是诚实的（`no-key` 的 `hint` 里其实
带着环境变量名，可反查，但那属于另一套推断，暂不做）。

**改动文件**：`lib/index.js`（`classify` 结果带 provider、degrade 路径遥测带
provider+model、授权守卫两处遥测带 provider）、`lib/engine.js`（两处遥测带
provider）、`lib/stats-store.js`（新增 `providerOfTelemetryEntry` /
`providerByEndpoint` / `defaultModelOf` / `telemetryProviderIndex`，回填与迁移
接入）、`test/stats.test.js` 与 `test/engine.test.js`（新增机制测试）。

**注意**：代码改动要**重启 DSH** 后才生效——运行中的旧实例仍会写不带
provider 的遥测行。

## DEC-012 降级记录的 model 回落到 provider 默认模型（消除「某 provider / unknown」零数据行）（2026-10-27）

**背景**：DEC-011 之后统计页不再有「未知（历史）」整块，但又冒出一批
`model = unknown`、token 全 0 的记录。排查现网数据：共 40 条，全部是
`action: degraded` 的**降级（失败）请求**（超时 / 冷却 / HTTP 500 / 网络错误），
且 `provider` 已是 bamboonode（已归因）。

**根因（lib/index.js 的 `degrade()` 闭包）**：降级时记统计用
`model: provider?.model ?? ""`。bamboonode 在 `resolveProvider` 里**不强制带
默认模型**（只有 `requiresModel` 的硅基流动会回落到默认模型，见 providers.js
496-497 行），而用户配置里 `model:` 留空，于是 `provider.model` 是 `""`，
`buildRecord` 把 `""` 归一化成 `"unknown"`。成功路径记的是 `result.model`
（API 响应里的实际模型），所以正常记录 model 正常——只有降级路径缺这步。

**核心问题**：这种记录 token 全 0 是对的（失败没产出 token），但 `model=unknown`
会在对比表里凭空多出一整行「bamboonode / unknown」零数据，与「为什么会有全 0
记录」的困惑同源。

**决策**：

1. **代码修根因**：`degrade()` 里 `model` 改为
   `provider?.model || provider?.defaultModel || ""`——配置留空时回落到该
   provider 的默认模型（即本来会用的那个）。绝不猜 provider，只补 model；
   provider 在降级时已解析出来。custom provider 默认模型为空，保持 `""`。

2. **迁移已落盘数据**：`repairLegacyProviderOnce()` 扩展一条规则——把
   `degraded === true` 且 `model` 为 unknown/空、且 `provider` 是已知预设的记录，
   回落到 `PROVIDER_PRESETS[provider].defaultModel`。**不碰非降级**的 unknown
   model 记录（交给反推或留作未知）。

3. **代码改动文件**：`lib/index.js`（`degrade` 闭包）、`lib/stats-store.js`
   （迁移扩展 + 引入 `PROVIDER_PRESETS`）、`test/stats.test.js`（新增降级 model
   回落测试）。

**已对用户现网数据执行**：删除旧 `stats.provider-repaired` 标记后重跑迁移，
共改写 47 条（40 条降级 bamboonode→startlux-decision-27b-autothink 等），
`model=unknown` 归零；备份 `stats.jsonl.bak-20261027-165636`。**注意**：代码改动
要在**重启 DSH** 后才生效，否则运行中的旧实例仍会写出 `model=unknown` 的降级
记录，需再跑一次迁移即可补齐。

## DEC-011 历史回填按模型名反推 provider（消除「未知（历史）」）（2026-10-27）

**背景**：用户升级到带统计功能的版本后，统计页「按 provider × model」对比表
里出现一大块「未知（历史）」。原因是旧遥测 `telemetry.jsonl` 没有 provider 字段
（DEC-007 已说明），回填时一律标成 `provider: "unknown"`，界面显示为
「未知（历史）」。而老版本唯一的端点就是 bamboonode，老遥测里的 `model`
字段往往能反推出服务商——这批记录并非真的「不知道」，只是没被归因。

**核心问题**：`未知（历史）` 在「当日 / 本周」视图里尤其刺眼：回填发生在升级当天
下午，旧遥测覆盖当天上午，于是当天既有真实记录（bamboonode / siliconflow）也有
一大块 unknown，混在一起像故障。用户要求：凡是 startlux 模型都改成 bamboonode，
凡是 kev 模型都改成硅基流动。

**决策**：

1. **回填补 provider 反推**：`backfillFromTelemetry` 不再硬编码
   `provider: "unknown"`，改为 `inferLegacyProvider(model)`——按模型名反推
   （`startlux*` → bamboonode；`Kev*` / `SemIf*` → siliconflow）。两个
   SiliconFlow 站点（国内 / 国际）同用 Kev-4B / SemIf，平局按用户选择归国内站
   （siliconflow）。匹配不上才退回 `"unknown"`，**绝不凭空猜一个服务商**（否则
   「按 provider 对比」会出现一家不存在的）。

2. **一次性迁移已落盘的历史**：新增 `repairLegacyProviderOnce()`，扫描
   `stats.jsonl`，只给 `estimated === true` 且 provider 为 unknown 的记录补回
   provider（靠 `stats.provider-repaired` 标记保证只做一次）。**刻意不碰真实
   记录里因降级失败而确实是 unknown 的新记录**——那些是真的没解析到 provider，
   改了反而会引入假数据。

3. **界面文案同步**：统计页脚注与 `/stats` 的 `legacy.note` 由「缺 provider 与
   output token」改为「provider 按模型名推断，output token 与耗时基线为推算值」——
   归因是推断的，仍要诚实标注 output token 与耗时基线是推算值。

**改动文件**：`lib/stats-store.js`（新增 `inferLegacyProvider` 与
`repairLegacyProviderOnce`、回填接入反推）、`lib/index.js`（启动链接入迁移）、
`lib/client.js` 与 `lib/index.js`（脚注文案）、`test/stats.test.js`（新增反推与
迁移测试，回填测试断言由 unknown 改为 bamboonode）。

**已对用户现网数据执行**：`stats.jsonl` 备份为 `stats.jsonl.bak-20261027-164250`，
迁移改写 2173 条（2132 → bamboonode、41 → siliconflow）。统计页重新读取即生效，
无需重启。

## DEC-010 节省量只统计「观察」模式：反事实只在两条路径跑在同一批工作时成立（2026-10-27）

**背景**：用户指出「数据统计里的节省部分，只有在『观察』模式下才有意义，
因为可以对比使用普通 LLM 和使用决策模型的共同数据对比」，并要求「修改为只
体现观察模式下如果采用决策模型的节省部分，UI 也要说明这一点」。

**核心问题**：节省量是一个**反事实**（counterfactual）数字——「如果采用决策
模型，这次能少花多少」。反事实要成立，前提是**两种路径跑在同一批数据上**：

| 模式 | 普通 LLM 路径 | 节省量的性质 |
|---|---|---|
| 观察 observe | **真的跑了**，同一批工作 | 实测对比 |
| 生效 enforce | **没发生**，决策已落地 | 事后估算 |

观察模式下决策模型只记录、不改变行为，于是同一批工作既有「普通 LLM 实际
怎么跑的」（真实数据），也有「决策模型说本该怎么跑」（记录下来的裁决）——
两边比的是同一批活。

生效模式下普通 LLM 路径根本没有发生，「省了多少」只能是事后估算。把两种
模式的数字混在同一张表里，读者看到的是一个漂亮的节省量，却**不知道它是实测
对比还是估算模型算出来的**——这是统计里最难自查、也最难解释的一类偏差。

**决策**：

1. **记录带 `mode` 字段**：每条统计记录记下该决策点此刻的三态模式
   （observe / enforce / off）。写入链路：`engine.js` 与授权守卫把
   `pointMode` 传给 `classify()`，`classify()` 把它挂进 `statsFacts`，
   `recordDecision()` 落到 `stats.jsonl`。
2. **聚合层分两套累加**：`accumulate()` 里，实际消耗统计**全部模式**的
   记录（它回答「钱花在哪」），节省量只累加**观察模式**的记录。两者各用
   一套字段（`observe*` 前缀），不能共用——共用就必须二选一，而两种都要。
3. **老记录归为「未知模式」，不计入节省量**：无法证明一条历史记录是在观察
   模式下产生的，就不能把它的「省下的量」当成实测展示。宁可少算，不可把
   不确定的数字当实测。
4. **老遥测的 `shadow` 正确映射成 `observe`**：老遥测只有 `shadow` /
   `enforce` 两值，`shadow` 就是现在的 observe。老遥测里那 205 条 `shadow`
   记录正是**唯一有实测意义的观察样本**——把它们一律当「未知」丢掉，等于把
   历史里唯一可信的节省量一并抹掉。映射放在 `stats-store.js` 的
   `legacyModeOf()`，并有专门用例覆盖。
5. **UI 三处说明**（用户明确要求）：
   - 页面顶部**常驻提示条**：节省量只统计观察模式，并解释为什么（生效模式
     下普通 LLM 路径没发生）。放在顶部而不是脚注，是因为看表的人先看表。
   - 汇总卡片标题与节省量对比表标题都带**「（观察）」**标记；对比表的
     「实际」三列也改用观察模式那部分的值——它们必须与旁边的「省」列同源，
     否则读者会拿生效模式的消耗去减观察模式的节省。
   - 页脚给出**按模式分账**（观察 / 生效 / 关闭 / 未知）。
6. **「省了 0」与「没有可比对的数据」分开说**：区间内一条观察模式的记录都
   没有时，聚合层给出 `savings.unavailable = true`，界面明确写出「现在是节省
   量 0 是『没有可比对的数据』，不是『一点也没省』」，并提示把相关决策点切
   到「观察」。这两件事的行动建议完全不同，混成一个 0 就是在误导。

**约束与取舍**：

1. **生效模式下的节省量一律不显示**，即使能估算出来。理由：估算值与观察
   模式的实测值摆在同一张表里，读者无从分辨，而这正是要避免的事。若将来
   要展示估算值，必须**另起一节**并标明「估算」，不能与实测混排。
2. **节省量对比表的「实际」列改为观察模式的部分**。这一列原来显示全部模式
   的消耗，与「省」列（观察模式）不同源——读者会拿生效模式的消耗去减观察
   模式的节省，得出一个毫无意义的数。
3. **实际消耗（横向对比表、汇总卡片的前六项）仍统计全部模式**：那部分回答
   「钱花在哪」，与模式无关，把它也按观察过滤会丢掉真实用量。

7. **给已有记录补 `mode` 的一次性迁移**（`fillMissingModesOnce()`）：
   引入 `mode` 之前写下的 `stats.jsonl` 记录没有这个字段，不补的话它们
   会被归为「未知模式」而**全部不计入节省量**——用户升级后打开统计页会
   看到历史节省量凭空变成 0，看起来像「这功能从来没省过东西」。
   补法：从老遥测按**时间戳**精确匹配找回每条记录当时的模式（回填时
   统计记录与遥测记录复制了同一个 `ts`；实测 2416 条全部对上、无一歧义，
   恢复出 185 条观察模式记录）。匹配不上的**不改**——宁可保持「未知模式」
   不计入，也不能猜一个模式（猜错会把生效模式当成观察模式的实测）。
   写回前先备份原文件，靠标记文件保证只做一次。
   **两步历史整理（回填 → 补模式）必须串行**：补模式是「读整个文件 → 改
   → 整体写回」，与回填并发时可能在回填追加前读完、追加后写回，把刚追加
   的历史记录覆盖丢失。这类竞态极少复现却极难自查，因此老老实实串行。

**验证**：`test/stats.test.js` 新增 7 个用例（观察/生效分账、不可用标记、
未知模式排除、mode 归一化、`shadow` 映射、迁移补模式、已有 mode 不被覆盖），
`test/client-ui.test.js` 新增 3 个用例（界面标注观察模式、「省了 0」与
「没省」的区分、按模式分账）。
端到端用假 fetch 验证：观察模式的一次缓存命中省 500 token 并计入，同等的
生效模式记录不计入。在真实数据副本上跑迁移：2416 条补上模式，恢复出 185 条
观察模式记录。全套 296/296，`verify-wiring` 通过。


## DEC-009 裁决统计（allow / ask / reject）：映射按 (point, kind) 而非只按 kind（2026-10-27）

**背景**：需求要求统计「决策模型导致的 allow、ask、reject 次数」。DEC-006/007
把统计做出来了，但只统计**用量**（token、耗时、缓存命中）——回答的是
「钱花在哪」。用户还问了一个不同的问题：**决策模型到底放行了多少、
惊动了用户多少次、拦下了多少次**。这是两套口径，不能合成一张表。

**决策**：

1. **新增 `lib/outcomes.js` 作为唯一映射源**。九个决策点各有自己的裁决词
   （delegate / ask / deny / skip / redirect / inline / switch …），映射按
   **(决策点, 裁决词)** 定义，不只按裁决词。

   理由：**同一个词在不同点上含义可能相反**。`retrieval.skip` 拦下了一次
   检索（→ 拦截），`cotTranslate.skip` 只是没翻译一句话（→ 放行）。只按词
   统一映射，会把「不翻译」算成「拦截」——得到的「拦截次数」毫无意义。
   映射集中一处后，新增决策点或新增裁决词只有一处要改。

2. **映射的语义按「对待办的用户动作做了什么」**：
   allow = 动作照常进行；ask = 升级人工确认；reject = 动作被拦下。
   这个口径与实际生效行为一一对应：真正返回 `{kind:"ask"}` 的只有授权的
   ask，真正拦下工具调用的只有授权的 deny、检索的 skip、技能选择的
   redirect。三张表对得上，是因为它们描述同一件事。

3. **「未裁决」单列一格，但不是第四种裁决**。降级（超时、鉴权失败、
   端点 404）时插件根本没改变任何行为：算成放行会虚增放行次数，算成
   拦截会虚增拦截次数。查不到映射时也归入这一格，**绝不猜成放行**。

4. **未登记的裁决被显式提示**。新增裁决词忘了登记时，数字只会**偏小**——
   看着仍然合理，是最难自查的一类错。因此 `aggregate()` 收集
   `otherVerdicts`，界面上直接写出「有 N 条裁决未归类」并指出是哪一个。

**顺带修掉的三个真实问题**（都是「数字看起来不对但不会报错」那一类）：

1. **统计写得太早，裁决维度永远是空的**。

   原来统计写在 `classify()` 里，而裁决是 `spec.decide()` 的产物——
   `decide()` 要等决策模型的答案回来才跑得出来。因此写进统计的记录
   必然**没有裁决**。

   实测证据：用户的 stats.jsonl 里 132 条实时记录的 `action` 是空串，
   而按裁决分账的统计永远只能显示「未裁决」。

   改法：`classify()` 只把「消耗事实」挂在返回值上（`statsFacts`），
   由**拿到裁决的一方**（engine.js 的 `ask()`、以及授权守卫）调用
   `recordDecision()` 补齐裁决并写盘。

2. **降级记录从统计里凭空消失**。

   回填时有一条 `if (entry.action === "degraded") continue;` 把所有降级
   跳过了，于是历史上所有降级都不在统计里——用户看到「这段时间零降级」，
   而实际上当时端点连着超时了 124 次（280 次降级共 35 分钟）。

   改法：降级记录也回填，并打上 `degraded: true`。

3. **降级会稀释「均耗时」**。

   降级没有拿到任何答案：它不是「一次模型请求」，混进 `requests` 会让
   均耗时的分母多出一批根本没得到回答的请求。现在降级累加到独立的
   `degraded` 与 `degradedDurationMs` 两个字段，不进 `requests` /
   `durationMs`——降级的等待耗时是真实成本，但要单列，不能混进
   「一次请求多快」。

**约束与取舍**：

1. **裁决统计与用量统计互不换算**。一次降级没有裁决却花了等待时间；
   一次缓存命中的裁决照常计入却没花任何 token。硬合成一张表两边都得打折。
2. **老遥测回填的记录保留裁决词**，因此历史裁决仍能按三格分账；老遥测里
   有一批没有 `point` 字段（授权守卫早于 point 字段），回填后 point 是
   `unknown`，只认授权那三个裁决词（delegate / ask / deny）——其它词一律
   不猜。
3. **裁决映射查不到时返回 none，不猜**。猜一个默认分类会让未知裁决看起来
   像「放行」，而放行是三格里看起来最无害、实则最能掩盖问题的一格。

**验证**：`test/outcomes.test.js`（15 项）覆盖映射矩阵完整性、同词不同义、
降级归入未裁决、未登记裁决显式列出、降级不进用量口径、写入路径把裁决落进
统计记录；`test/engine.test.js` 新增 2 项（引擎把裁决交给统计层、形状不符
时记未裁决）；`test/client-ui.test.js` 新增 4 项（裁决一节渲染、按决策点
分账、未归类提示、无数据时不渲染）。全套 285/285，`verify-wiring` 通过。



## DEC-008 授权守卫低风险分支叠加任务相关性否决（2026-10-27）

**背景**：用户反馈插件「非常非常多次询问我的意见」，认为决策模型判完就该
自行放行/拒绝，而不是反复升级人工确认。遥测回放（`telemetry.jsonl` 1647 条
有效授权决策）定位到根因：

- 95 次 `ask` 里 **76 次来自「风险低但可能不可逆」分支**（irrev ≥ 0.2）；
- 这批样本的 `taskP`（任务相关性）**全部 ≥ 0.5**，`risk` 判定本身就是 low
  （均值 0.585），典型样本如 `risk=low p=0.74 irrev=0.22 task=0.83`；
- 决策模型对「执行后是否不可逆」一问的输出基线并不接近 0：普通 bash 命令
  （`ls`、`git status` 等）普遍落在 0.2–0.4。阈值 `guardIrreversibleCeiling`
  取 0.2，恰好压在基线噪声带上——模型对 bash 的惯性谨慎被当成了风险本身；
- 该分支只看 irrev 单一分数，四问里的 `taskP` 算了但**从未参与裁决**。

**决策**：

1. 低风险分支改为**双条件**：`irrev >= guardIrreversibleCeiling` 且
   `taskP < guardTaskRelevanceFloor`（新增配置，默认 0.5）才升级询问。
   模型说「低风险 + 服务于任务」而唯一顾虑是「有点不可逆」时，三个信号
   互相矛盾，按 System-1 定位放行；只有「可能不可逆**且模型自己都不认为
   它服务于当前任务**」才值得人工确认。
2. 阈值不动（ceiling 保持 0.2）：回放数据表明区分度来自任务相关性这一维，
   而不是把 0.2 盲调到更高——后者会把 6 条中低 irrev 的可疑样本也放过。
3. 其余分支（高风险 deny/ask、中风险、注入嫌疑）语义不变。
4. 边界语义：`guardTaskRelevanceFloor: 0` 使 taskP < 0 恒假 = 停用该分支；
   设 1 = 恢复「只看不可逆」的旧行为。两者都在单测里固定。

**验证**：`test/guard-threshold.test.js` 新增 10 项纯函数单测；全量
263/263 通过。1647 条真实遥测回放：ask 95 → 38（-60%）。被砍掉的 57 次
全部是低风险分支的误打扰；剩余 38 次中，低风险分支留下的 19 次全部满足
`taskP < 0.5 且 irrev ≥ 0.2`（真正可疑），另 16 次中风险与 3 次高风险来自
其他分支（语义未动），deny/delegate 数不变。

**取舍**：新默认值下「低风险但可能不可逆」的调用不再逐条打扰用户；换取的
风险敞口是「模型判低风险且判错任务相关性」的调用会静默放行——但该情形下
模型的三问已自洽指向放行，人工确认本就缺乏增量信息。嫌放得太宽的用户可把
`guardTaskRelevanceFloor` 设为 1 回到旧行为。

## DEC-007 统计独立成页（两 tab）；回填改为启动时落盘（2026-10-27）

**背景**：DEC-006 把统计做出来了，但它是**配置页末尾的一小块**。用户明确指出：
统计功能非常重要，不应该只是一小块 UI，设置页应改为两个 tab（配置 / 统计）。

**决策**：

1. **设置页拆成两个 tab**：`配置` 与 `统计与对比`。统计页用更宽的容器
   （1000px，配置页是 620px）——对比表有十来列，620px 放不下。
   统计页从「配置表单的尾部」变成「一整页」：时间范围 → 汇总指标 →
   **横向对比**（实际消耗）→ **节省量对比**（基线 → 实际）→
   **按决策点分账** → 口径脚注。
2. **统计页是纯渲染函数**（`renderStatsTab`），放在 factory 作用域，
   不碰任何状态、不发请求。聚合口径只在服务端一处定义（lib/stats.js），
   前端再算一遍必然出现「界面与导出数据对不上」。
3. **预设清单来自服务端**（`stats.presets` / `stats.labels`），前端不抄一份。
   统计请求只在**统计 tab 打开时**才发：配置 tab 下没人看它，而它每次都要
   读完整个统计文件。

**顺带修掉的三个真实 bug**（都是「数字看起来不对但不会报错」那一类，
且都是靠真机端到端跑才暴露出来的）：

1. **回填的缓存命中映射反了，导致节省量为负**。
   老遥测在缓存命中时记的 `inputTokens` 是**被复用的那次真实请求**的计数
   （`classify` 直接返回缓存对象），而那次命中实际一个 token 都没花。
   按字面把它当成「实际消耗」、基线留 0，`base - actual` 就算出 **-473**
   这种负节省（实测某个 30 分钟窗口就命中了这条路径）。
   现在映射为：实际 = 0，基线 = 老遥测记的那份。
2. **「平均耗时」被缓存命中稀释**。原来分母是全部请求数，而命中那次耗时
   是 0，算进去会让平均耗时随命中率升高而变好看——它说的其实是「我们有多久
   没发请求」，不是「一次请求多快」。现在平均值一律按**真实请求**算。
3. **历史回填改成启动时落盘**（原来只在「统计文件为空」时现算）。
   现算的话历史只在统计文件为空时存在，而插件跑起来后**第一笔新请求就会
   创建统计文件**——于是用户刚升级就发现「以前一个月的记录不见了」。
   现在启动时回填一次并落盘（靠 `stats.backfilled` 标记保证只做一次），
   历史与新记录同处一个文件。

**顺带修正的一处聚合逻辑**：基线补齐原来按「任一基线字段存在就整体跳过」
判断，导致「有 input 基线但没有耗时基线」的历史命中记录永远补不上耗时，
而缓存命中省下的时间恰恰是用户最想看的数字。现在改成**缺哪个补哪个**。

**约束与取舍**：

1. **历史回填的记录带 `estimated: true`**，界面上明确标注「由旧遥测推算」。
   老遥测没有 provider 与 output token，这部分数字是推算值，耗时基线取
   同组真实请求的均值——不会把推算值混充成实测值。
2. **回填只在启动时做一次**，不阻塞插件启动（不 await），失败只记警告。

**验证**：`test/stats.test.js`（36 项）与 `test/client-ui.test.js` 新增用例
覆盖：负节省回归、平均耗时口径、回填只做一次且与新记录同文件、回填后
节省量非负、tab 拆分与默认停在配置页、预设只来自服务端、实际区间显示、
自定义范围未填全的提示。全套 253/253，`verify-wiring` 通过，并在真实 DSH
runtime 里跑通：启动回填 2085 条 → 各时间范围节省量均非负 → 二次启动
不重复回填。


## DEC-006 统计与对比：独立 stats.jsonl + 缓存命中即基线（2026-10-27）

**背景**：需求要求给插件加统计与对比：按 provider × model 分别统计 input
token 与耗时，并算出「不开本插件时本该消耗多少」作为节省量的基线。

**先检视现有 telemetry.jsonl**，结论是**字段覆盖不了**，不能直接复用：

| 统计所需 | telemetry.jsonl | 结论 |
|---|---|---|
| provider | ❌ 只有 model | 同一模型跑在两个 provider 上就分不开 |
| model | ✅ | |
| input_tokens | ✅ | 但缓存命中的那次记的是**上次**的数 |
| output_tokens | ❌ 完全没记 | API 返回了 `usage.output_tokens`，遥测丢掉了 |
| timestamp | ✅ | |
| duration_ms | ⚠️ 与缓存命中的 0 混在一起 | 累加出来的「总耗时」没有意义 |
| 基线 | ❌ 无 | 「省了多少」无从算起 |

**决策**：

1. **统计走独立的 `stats.jsonl`**，与 `telemetry.jsonl` 同目录、不同文件。
   遥测是给人读的流水账（「上次那条为什么放行了」），统计是给机器读的
   结构化度量（「这个 provider 这个模型这个月花了多少」）。两者字段需求
   不同，硬塞进一份文件只会让两边都别扭。
2. **基线口径定死在写入端**（`buildRecord()`）：基线 = 不启用本插件的
   缓存与上下文压缩时，同样的工作本应消耗的 token 与时间。
   - **缓存命中**：基线 = 缓存里那份结果的开销（它就是上一次真实请求），
     实际 = 0。省下的正是「本来要再付一次」的那份。
   - **上下文截断**：基线 = 未截断时的 input token。
   - **`think_mode` 刻意不算进去**：它是用户自己的配置，不是插件的优化；
     算进去会让节省量随配置摆动，数字失去意义。
   - 没有可归因的优化时节省量是 **0**，不是负数也不是某个假想的数。
3. **比例的分母是基线，不是实际值**。「省了多少」永远是相对基线说的。
4. **区间一律左闭右开** `[start, end)`：相邻区间（本月 → 本年）不会在边界
   上重复计入同一条记录。「本周」从周一开始（ISO 习惯）。自定义范围的
   结束时刻按「含该整分钟」处理。
5. **token 数优先取 API 返回值，缺失时用内置估算器**（`lib/tokenizer.js`）：
   `tokens ≈ 90 + CJK 字符数 + 其它字符数 / 3`，系数由实测标定（真实 key
   打真实端点，14 组不同长度与语种的请求体，平均相对误差约 6%）。
   **不引第三方 tokenizer**——`tiktoken` / `js-tiktoken` 都是几百 KB 的
   依赖，而本插件的硬约束是零运行时依赖（见 home-paths.js 的说明）。
   估算值带 `inputSource: "estimated"` 标记，界面能分清实测与估算。
6. **写入是异步的**（`lib/stats-store.js`）：决策路径上的额外开销只有一次
   入队 + 一次 JSON 序列化，不等磁盘。队列串行，保证行不被并发写拆开；
   写盘失败只记一条警告，绝不影响主功能。
7. **升级后立刻有历史可看**：统计文件为空时从旧遥测回填。但老遥测没有
   provider 与 output token，回填记录带 `estimated: true`，界面明确标注
   「由旧遥测推算」，其耗时基线也是同组真实请求的均值（估算值）。

**为什么用 JSONL 而不是 SQLite**：需求给的两条路都可行。选 JSONL 的理由：
零依赖（`node:sqlite` 在 Electron 里要 `--experimental-sqlite` 或承担版本
差异）；写入天然原子、不需要事务、进程被杀最多丢最后一条；用户能直接
`tail -f` 看；决策请求是分钟级频率，一天几千条，JSONL 完全撑得住。

**过程中修掉的两个真实 bug**（都是「数字看起来不对但不会报错」那一类）：

1. `buildRecord()` 的三个基线字段默认值不一致——只有 output 与 duration
   跟随实际值，input 默认为 0。于是「没有优化」的那次请求算出
   `savedInputTokens = 0 - 实际值` = **负数**，界面显示「省了 -1200 token」，
   而实际是「没省也没多」。三个字段现在统一跟随实际值。
2. provider × model 的组合键最初直接拼接：`"ab" + "c"` 与 `"a" + "bc"`
   撞成同一个键，两组数据被合并统计——而 provider/model 都可能含任意
   字符（自定义服务的模型名尤其）。改用 `\u0000` 作分隔符。

**约束与取舍**：

1. **output token 的服务方差异**：`think_mode` 不为 `never` 时，服务端会
   自行决定思考多少，`output_tokens` 实测在 0–434 之间波动（同一请求两次
   调用结果不同）。因此 output token 只作为「消耗量」统计，**不作为基线
   的可归因项**——省不了的就别写成省了。
2. **历史回填不落盘**：每次请求都重新算一遍旧遥测会拖慢响应，且回填
   记录无法与真实记录区分。统计文件非空后就不再回填。

**验证**：`test/stats.test.js`（31 项）覆盖时间边界、基线口径、聚合维度、
排序稳定性、tokenizer 精度、异步写入与坏行容错、旧遥测回填，以及
「遥测只记 API 报的数字、估算值只进统计」这条职责边界；
`test/client-ui.test.js` 新增 5 项覆盖界面渲染。全套 `node --test
"test/*.test.js"` 245/245（Node 26 与 DSH 自带的 Node 24.21 各跑一遍），
`verify-wiring` 通过，并在真实 DSH runtime 里跑通端到端：真实请求 →
写盘 → 统计接口 → 各时间范围预设。

**顺带修正的一处职责混淆**：客户端原本把「含估算」的 token 数放进
`result.inputTokens`，而 `result` 正是遥测记录的来源——于是服务端没报
usage 时，审计记录里会出现「由本插件推算」的 token 数。遥测的用途是
「服务端到底说了什么」，混入推算值就失去审计意义。现在
`result.inputTokens` 只放 API 原始值，估算值单独放在
`statInputTokens` / `statOutputTokens` 里，供统计与缓存基线使用。


## DEC-005 授权决策禁用同类复用软缓存；软缓存改为显式启用（2026-10-26）

**背景**：插件市场评审意见（2026-10）：

> The authorization soft cache can reuse a low-risk result for different tool
> arguments. Please bind authorization caching to the full call/context, or
> disable soft reuse for this check.

软缓存（soft 层）的键是「工具名 + 命令族 + 风险标记」的归一化签名，刻意丢弃
参数内容，目的是让 `node -e '...'` 这类重复调试命中缓存。旧实现以为安全，
理由是「只缓存低风险放行 + 风险标记完全一致才复用」，但该论证不成立：
**缓存层自己不判断风险，它只存第一次调用的裁决**。`rm -rf /tmp/x` 被合理放行
后，`rm -rf /Users/chi/xx` 与它风险标记完全一致（碰撞条件而非保护）、族名相同，
于是后者**原样继承放行**，决策模型根本不会看到这条命令。软键也不含 cwd 与
会话摘要，不同目录、不同会话同样互串。

**决策**：

1. **授权（authorize）永久禁用软缓存**：守卫不再传 `signatureText` /
   `softCacheable`，裁决只写精确键（完整 state + 问题集一致才复用）。
2. **软缓存整体翻成 fail-closed**：`classify` 只在调用方显式传
   `softCacheable: true` 时才建软键；旧版「传回调函数判定是否可缓存」的
   形式废除——没声明就启用等于把复用决策藏进了默认行为。
3. **全部决策点不再传 `signatureText`**：spec.build 的签名字段移除，engine
   透传通道移除。软层默认休眠，唯一保留的出口是显式声明 `softCacheable: true`
   的调用方（当前内置决策点无使用）。
4. 精确层语义不变，仍是默认且唯一默认开启的层。

**顺带修正**：

- retrieval / skillPick 此前误传 `softCacheable`（效果与代码注释
  「skip 永不复用」相反：skip 裁决同样进软层），已随 fail-closed 一并移除；
- DEC-003 里「已由双层缓存（精确命中 + 同类复用）挡掉」按 append-only 规则
  原样保留——「同类复用」现已默认关闭，该句以本条目为准。

**约束与取舍**：

1. **命中率回退可接受**：authorize 的重复调试命令从「同类命中」退回每次真发
   （约 1.9k token/次）。安全决策的缓存要么绑定完整调用上下文，要么不做；
   省 token 的职责由只读白名单、route 的步数闸/路由闸等不依赖归一化复用的
   机制继续承担。
2. **保留 `softKey` 实现与显式出口**：非安全决策点未来可在声明后使用，
   出口必须显式、可评审、有测试钉住，而不是藏在默认行为里。

**验证**：`test/cache-regression.test.js`（9 项）：评审场景（同族不同参数
不复用）、authorize 不写软键、精确复用仍有效、cwd/recent 失配、fail-closed
两条、显式出口、decideGuard 语义不变、spec 不再传签名。全套
`node --test test/` 209/209，`verify-wiring` 通过。

## DEC-004 硅基流动两个站点做成「只粘一个 key」的预设（2026-10-25）

**背景**：用户要求新增两个 pre-configured provider——硅基流动
（`https://api.siliconflow.cn/v1`）与 Silicon Flow（`https://api.siliconflow.com/v1`），
模型 kev-4b、url path `/systemone`，**只提供一个 API key 就能用**。

接入前对两个站点做了实测（真实 key 打真实端点，2026-10-25）：

| 探测 | 结果 |
|---|---|
| `cn/v1/systemone` + `kev-4b` | **200**，回 `{"model":"kev-4b",...}` |
| 同上 + `Kev-4B` / `Kev-4b` | 200（模型名大小写不敏感） |
| 同上 + **省略 model** | **400** `{"code":20013,"message":"Model field is required."}` |
| 同上 + `model: ""` | 400 同上 |
| 同上 + `deepseek-ai/DeepSeek-V4.1-Flash` | 400 `{"code":20012,"message":"Model does not exist."}` |
| `cn/v1/decisions` | 404 `Not Found` |
| `com/v1/systemone`（假 key） | 401 `Token is invalid.`（= 路径存在） |
| `com/v1/decisions`（假 key） | 404 |
| `GET cn/v1/models` | 98 条（含 `Kev-4B`、`SemIf`），**无一条**带 `supported_endpoint_types` |

**决策**：

1. 新增 `siliconflow`（国内站）/ `siliconflow-intl`（国际站）两个预设，地址、
   路径（`/systemone`）、默认模型全部预置，**用户只粘一个 API key**。
   两站是两套账号：地址、key、模型字段各占一格，互不共用。
2. 预设新增 `requiresModel: true` 标记：这类端点把 model 列为必填，**留空时
   回落到预设默认 `Kev-4B`**，而不是沿用「留空 = 省略字段」。省略字段在它们
   那里是一次注定的 400，而守卫 fail-open——症状正是静默失效。
   其余 provider 保留省略语义（服务端回填默认模型，服务商改名不失效）。
3. 预设新增 `knownModels` 白名单：`/v1/models` 会返回 98 个模型且不带
   `supported_endpoint_types`，全收等于给用户 96 个「选了就 400」的选项；
   按白名单筛，下拉只列 `Kev-4B` / `SemIf`。
4. provider 的三个字段名（`modelField` / `keyField` / `keyEnvField`）**由预设表
   下发**（`providerCatalog` + status 的 `rawModels`），前端不再按 provider 写
   if/else——新增预设只改 providers.js 一处。服务端没下发映射时**整笔延后并
   说明原因**：宁可不写也不猜格子，猜错就是把 A 的 key 存进 B 的格子。
5. `persistKeys` / 变量名校验 / PUT 允许写入的键全部改为**按预设表生成**：
   漏掉一个 provider 的后果不是报错，而是它的 key 会绕过凭据文件、以明文
   落进 config.yml。
6. 「测试端点」的请求 id 兼容 `x-siliconcloud-trace-id`（SiliconFlow 用它，
   不是 bamboonode 的 `x-oneapi-request-id`）。

**模型名**：用户写的是 `kev-4b`，服务端 `/v1/models` 的规范写法是 `Kev-4B`
（两份官方文档自己也一写 `Kev-4b`、一写 `Kev-4B`）。三种大小写实测都 200
（模型名大小写不敏感），预设取 `Kev-4B`——与 `/v1/models` 的 id 一致，
模型下拉里才是同一条；否则会出现「kev-4b（当前值）」与「Kev-4B」两条重复项。

**约束与取舍**：

1. **requiresModel 只对声明了的预设生效**：bamboonode / system one 留空仍省略
   字段，否则服务商给模型改名时本配置会失效。
2. **knownModels 是白名单**：服务商将来新增决策模型要改预设表。取「漏掉新
   模型（仍可在 config.yml 手填）」，好过「96 个选了就失败的下拉」。
3. **两站各占一格**：省的只是几行配置，换来的却是「切过去拿错 key」这种用户
   无法自查的故障。

**验证**：
- `test/providers.test.js`：两个预设的地址 / 端点 / 默认模型 / key 隔离、
  `requiresModel` 只对声明者生效、五个 provider 各读各的 key。
- `test/client-ui.test.js`：硅基流动的 key 与模型各写自己那一格、别家一格不写；
  「留空」文案说成预设默认；服务端没给字段映射时不发 `/config`。
- `test/save-path.test.js`：五个 provider 的 key 分别落进五个 refs 键。
- `scripts/verify-wiring.mjs`：每个预设的三个字段名都在 Config 里、
  siliconflow 解析出 `/v1/systemone` 且留空时带默认模型。
- 真实端点：上表全部为实测（`.com` 一项用假 key 探路径，未占用其额度）。
- `node --test test/`：199 项全通过；`node scripts/verify-wiring.mjs` 全通过。

**顺带**：README / config.example.yml 补齐五个 provider 的表、model 字段表
与两条官方 API 文档链接；`package.json` 描述同步。


## DEC-003 去掉「自身 token 预算」功能（2026-10-25）

**背景**：插件原本有一道自身用量护栏——`budgetTokens`（默认每小时 40 万）
加 `budgetWindowMs`，超限后所有决策点一律退回本地启发式并 fail-open，
等滑动窗口滚过去才恢复。用户要求：**本插件不需要设置预算**。

重新审视这道护栏，它得不偿失：

1. **超限即停止判断**，意味着用量最大的时刻（也就是会话最繁忙、判断最有
   价值的时刻）恰恰是守卫主动失效的时刻——一个「省钱的东西」在最需要它的
   时候罢工，比省下的那点 token 贵得多。
2. **它挡不住真正的浪费**：一次决策实测约 1.9k token，真正的浪费来自
   白名单外的重复调用，那部分已由双层缓存（精确命中 + 同类复用）挡掉；
   缓存命中后请求根本不发，预算窗口里根本不会记账。
3. **多一份状态就多一处漂移**：预算要维护滑动窗口、超限计数、UI 输入框与
   clamp 规则，而它给出的收益与缓存高度重叠。

**决策**：整体移除预算功能，`lib/budget.js` 删除，不留配置项、不留开关。

- Config schema 去掉 `budgetTokens` / `budgetWindowMs`，`DEFAULTS` 同步去掉；
- `/status` 与 `/decisions` 的 payload 不再下发 `budget` 字段；
- `/decisions` 的 PUT 不再接受 `budgetTokens`（现在只改决策点模式）；
- 配置页删除「自身 token 预算」输入框，`client.js` 去掉 `budgetDraft` 状态
  与它那条防抖保存链路；
- 降级原因 `budget-exhausted` 随之消失（遥测里不会再出现这一项）。

**约束与取舍**：

1. **删除而非默认值改 0**：留一个「0 = 不限制」的字段等于把死配置写进
   schema，用户仍会去填它、仍会问它为什么不生效。功能去掉就去掉干净。
2. **省 token 的职责交回缓存**：README 里「省 token 的手段」那一条由
   「自身预算」换成「双层缓存」——真正省钱的是不发请求，而不是发够了就停。
3. **超时不是预算**：`timeoutMs` 与它派生的 `AbortSignal.timeout(...)` 是
   单次请求的硬超时，语义完全不同，一并顺手改成 `timeoutMs` 命名，避免
   遥测里的 `budgetMs` 让人误以为预算还在。

**顺带修正**：`DEC-001` 里列举的自动保存文本框包含「预算」——该条目按
append-only 规则原样保留，此处声明：那个输入框已随本条目移除。

**验证**：`node --test test/`（190 项中 188 通过；2 项失败是 `providers.js`
新增 siliconflow 预设后测试未同步，与本改动无关）；`node scripts/verify-wiring.mjs`
全部通过；全仓 `grep -rn "budget" ` 除超时命名外已无残留。


## DEC-002 端点风格改为「首选」：404 自动换另一条路径（2026-10-25）

**背景**：用户报「选了 kev 模型（如 kev-4b）时 url path 应该是 `/systemone`，
不能用 `/decisions`」。实测（真实 key 打真实端点）确认了问题，但**归因需要修正**：

| 服务商 | 模型 | `/v1/decisions` | `/v1/systemone` |
|---|---|---|---|
| SiliconFlow | `Kev-4B` | 404 Not Found | **200 ✅** |
| bamboonode | `startlux-decision-27b-autothink` | 200 ✅ | 200 ✅ |

**路径后缀由服务商决定，不由模型决定**——`Kev-4B` 换个服务商路径就得跟着换。
旧实现只拼一条路径（`auto` 的真实含义是「按 decisions 拼」），配到只认
`/systemone` 的服务上就 404；而守卫是 fail-open 的，于是**静默失效**。
现场证据：`telemetry.jsonl` 里 2026-10-25 13:16–13:41 有 8 次 `http-404` 降级，
全部是 `custom` provider 打 `https://api.siliconflow.cn/v1/decisions`。

**决策**：`端点风格` 从「唯一的路径」改为「**首选**路径」。

1. `resolveProvider()` 额外给出 `candidates`（按优先级排好的候选端点）：
   - 地址已自带端点段 → 只给它自己（用户的明确决定不被自动改写）；
   - `auto` → 先 `decisions` 再 `systemone`；
   - 显式指定 → 先它自己再另一条。
2. 请求时**只有 404** 才换下一条候选：400（模型/内容不合法）、401（key 不对）、
   5xx 都与路径无关，换路径只是多烧一次请求。网络异常直接上抛，不重试。
3. 试通的那条被**记住**（按 base URL 隔离），下次直接打它——热路径上不多一次往返。
4. 两条都 404 时，遥测与「测试端点」**列出试过的地址**并提示改端点风格。
5. 界面「生效端点」下方显示「已验证可用：…」，让「实际打哪」始终可见。

**约束与取舍**：

1. **显式指定也留退路**：用户选 `systemone` 但填错了 base URL，404 时仍会
   试另一条。理由：显式是「首选」而非「唯一」，否则「选错了只能手动改」
   这种死胡同会被当成插件的 bug。
2. **回退不覆盖用户决定**：地址自带端点段时只有一个候选，不回退——那是
   明确的「我就要打这个完整地址」。
3. **只认 404**：实测两类网关一致（SiliconFlow 甚至回纯文本 `Not Found`
   而非 JSON 错误体），404 = 路径不存在，400 = 请求内容不合法。
4. **记忆按 base URL 隔离**：换了地址就重新探测，否则「A 服务商的结论」
   会被套到 B 服务商上——那正是本插件最忌讳的配置漂移。

**为什么不给「二选一」的下拉就完事**：下拉已经有了（本就是 `端点风格`）。
真正缺的是**兜底**——服务商换路径、用户填错、地址自带端点，三种情况都会
踩空，而静默降级是本插件最忌讳的失败形态。给下拉加自动回退，两种需求
同时满足，且不把选择责任推给用户。

**验证**：
- `test/endpoint-fallback.test.js`（15 项）：404 才换路径、400/401/5xx 不换、
  网络异常上抛、换路径前取消响应体、候选顺序、记忆按 base URL 隔离。
- `scripts/verify-wiring.mjs`：候选端点存在、覆盖两条路径、地址自带端点时只有一个。
- **真实端点验证**：`https://api.siliconflow.cn/v1/decisions` → 404 →
  自动换 `/v1/systemone` → **200**，响应 `{"model":"Kev-4B",...}`。

**顺带修正**：现场配置的 `customEndpointStyle` 由 `auto` 改为 `systemone`
（配置改动热加载生效，不用重启 DSH）。


## DEC-001 配置页改为「修改即保存」，取消保存按钮（2026-07-25）

**背景**：配置页原先是「改草稿 → 点保存」两段式。用户提出：能否改完即保存，
不额外提供保存按钮？

**决策**：取消「保存」按钮，全部控件改为自动落盘——

- 开关 / 下拉 / 分段控件：点击即存（离散改动，无需防抖）；
- 文本框（Base URL、请求头、密钥变量名、预算）：停手 700ms 或失焦后存；
- API Key：**仅**失焦或回车时存（防抖自动存会把打字途中的半截 key 写进
  凭据文件，比多一步确认更危险）；
- 按钮位置改为状态行：`待保存… / 保存中… / 已保存 / 未保存：原因`，失败附「重试」。

**约束与取舍**：

1. **串行 + 合并 + 序号守卫**（`flush`）：同一时刻一个请求在飞，期间的改动
   并入 `valuesRef` 等下一轮；响应回来时若用户已改过则不覆盖草稿——
   否则就是老毛病「保存后开关回弹」。
2. **值以 `valuesRef` 为准**而不是渲染闭包：`setState` 异步，连点两次开关时
   第二次读到的还是上一帧的值，会丢改动。
3. **打字途中的非法地址整笔延后**（不发注定 400 的请求），决策点改动照常
   落盘，不受地址牵连。
4. **失败不自动重试**（可能是校验错误），保留输入 + 显示原因 + 手动重试；
   保存期间的新改动则立刻补发，不等防抖。
5. `customBaseUrl` 只在本地校验通过时才随 patch 提交，半截地址不进 yml。

**风险告知**：配置保存即生效（热加载），去掉「草稿缓冲」后误触开关会立刻
改变守卫行为，不再有「没点保存就不生效」这层保险。

**验证**：`test/client-ui.test.js` 新增三条——无保存按钮、拨开关即 PUT /config、
API Key 失焦即提交且只写当前 provider 那一格。
