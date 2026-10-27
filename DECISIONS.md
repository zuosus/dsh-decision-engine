# DECISIONS.md — 设计决策日志

<!-- APPEND-ONLY LOG: 新条目插入到此行之后 -->

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
