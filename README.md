# dsh-startlux-decision

给 DeepSeek Harness 的 System-1 决策守卫，专为 **Bamboo Relay / StartLux** 打造。
在每次工具调用前问模型四个问题（风险、可逆性、任务相关性、注入嫌疑），据此放行、
询问或拦截。默认 `shadow`：只记录判断，绝不打断你干活。

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin add dsh-startlux-decision
```

或手动装进 profile：

```sh
cd ~/.dsh/profiles/desktop
pnpm add dsh-startlux-decision
```

然后在 profile 的 `package.json` → `dsh.profile.bundles` 里加入
`"dsh-startlux-decision"`，重启 DSH。

### 本地开发

```sh
git clone https://github.com/zuosus/dsh-startlux-decision.git
cd dsh-startlux-decision
# 复制到 profile 的 node_modules，或 pnpm link
```

## 配置

### 插件配置页

**插件 → 已安装 → dsh-startlux-decision → 点进该插件**，配置区（「包含的组件」
**上方**）会出现 StartLux 卡片，布局与内置 `dsh-rewind-plugin` 一致：

- 两个开关：`启用守卫`、`真正拦截`
- 一个 **API Key 输入框** + `保存` 按钮
- 一个 `测试端点` 按钮
- **决策模型参与点**列表：每个决策点一行，右侧是 `关闭 / 观察 / 生效` 三态
- `自身 token 预算` 输入框，以及实时的缓存命中率与每个点的 token / 延迟统计

改完点`保存`即写入 `startlux.yml`，**不需要重启**：监听器常驻注册，模式在
每次调用时现读；预算与缓存参数同样是取值函数而非启动期快照。

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

同时有两道护栏兜底：

- **自身预算**（`budgetTokens`，默认每小时 40 万）：超限后所有决策点自动退回
  启发式并放行。省钱的东西不能反过来成为主要消耗方。
- **双层缓存**：见下节。

## 模型选择

配置页的「模型」是**下拉框**，由服务商实时提供，另有「自动（服务端默认）」选项。

**默认就是「自动」**（`startlux.yml` 里 `model:` 留空）：插件**不发送该字段**，
服务端用它当前的默认决策模型。实测省略 `model` 返回 200，响应里回填实际使用的模型名：

```json
{"answers":{...},"model":"startlux-decision-27b-autothink","usage":{...}}
```

这样即便服务商将来更换模型名，留空配置也不会因此 400。

> 注意：`startlux.yml` 里的 `model:` **必须写出来但留空**（`model:` 后面不跟值）。
> 解析器把显式空值保留为 `""`；若整行删掉，键会缺失并回落到内置的硬编码模型名，
> 「自动」就不生效了。

**列表为何要过滤**：`/v1/models` 返回全部 20 个模型，其中多数是 chat 模型，
拿去打 `/v1/decisions` 会 400 `model ... is not served by this plugin`。
本插件按 `supported_endpoint_types` 只保留声明了 `StartLux Decision` /
`StartLux SystemOne` 的模型。实测 `typesafe/jev-1.14` 虽声明 `jev-decisions`，
仍被本端点拒绝，因此也排除。

## 超时与自动回退

每次请求都带**硬超时**（默认 8000ms），超时不是错误，而是降级放行：

```
AbortSignal.timeout(budget) → 超时 → degrade("timeout") → 钩子 next() 放行
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
| 超时 | `timeout`（附 `budgetMs`） |
| 返回非 JSON / 非对象 | `invalid-json` / `invalid-response` |
| 缺 `answers` 字段 | `missing-answers` |
| 答案形状不符（类型错、缺字段、`choice` 非法、概率越界/NaN） | `answer-shape-mismatch` |
| 守卫内部抛异常 | 捕获后放行，仅 `logger.warn` |
| 只读工具 / auto 权限预设 / 被排除工具 | 不判断，直接放行 |

默认 `mode: shadow` 时，即使判断出 `deny` 也只记录不执行。

## 省 token 的设计

- **双层缓存**：
  - `精确`：完整 `state` + 问题集一致即复用，绝对安全。
  - `同类复用`：键是「工具名 + 命令族 + 风险标记」的归一化签名，
    **只有低风险放行的裁决**才进这一层；`ask` / `deny` 永不复用，
    否则会把一次危险判断错误地扩散到同类操作。

    这一层是必要的：旧实现只用精确键，而键里含 `args_preview`，
    于是**实测 309 次调用命中 0 次**——等于缓存完全没工作。
    现在 4 条同类 `node -e '...'` 变体只需 1 次真实请求（命中率 60%），
    而 `rm -rf` 不会复用任何缓存裁决。
- **`thinkMode: never`**：实测主要省**延迟**（约 1.9s vs 7.2s）；输入 token 基本不变
  （该端点 `output_tokens` 恒为 0，思考开销未计入计量）。
- **只读工具直接放行**：`read`/`grep`/`glob`/`todo_write` 等不发请求。
- **state 截断**：`args` 走头尾摘要，`recent` 只带最近 4 条、每条 240 字符。
- **失败冷却**：连续 3 次失败进入 60s 冷却，避免对着故障端点烧钱。
- **自身预算**：`budgetTokens` 限制决策模型每小时的花费，超限自动退回启发式。
- **默认只观察**：新决策点先跑 `observe`，确认与人工判断一致后再切 `enforce`。

## 验证链路

### 自动化验收（三条，全部可重复跑）

```sh
pnpm test              # 78 项单元测试：纯函数 + 适配器接线 + 降级语义
pnpm verify:wiring     # 39 项接线检查：用真实 schemastery 加载插件
pnpm verify:endpoint   # 8 个决策点逐个打真实端点，校验题型与答案形状
pnpm verify            # 前两条一起跑
```

`verify:wiring` 需要 profile 的依赖可解析。仓库里没有 `node_modules` 时先建链接：

```sh
ln -s ~/.dsh/profiles/desktop/node_modules node_modules
```

它检查的是「宿主到底给不给这个服务」——包括缺 `translator` / `sessionTitle`
时 `apply()` 不抛、所有监听器都注册上、每个新点默认 `off`（升级不改变行为）。

`verify:endpoint` 要网络与 `BAMBOO_API_KEY`，它逐点校验：
端点接受该点的问题集（`choice` 必须有 `criteria`、`score` 必须 2–10 档、
题型只认三种）、答案能被 `parse()` 解析、`decide()` 产出合法 `kind`。
**这一步不能省**：题型写错会在运行时 400 并静默降级，光看日志很难发现
「这个点其实一直没生效」。

### 手工验证

1. `「测试端点」按钮` → 看到 `HTTP 200` 和 `x-oneapi-request-id`，说明配置与网络都对。
2. `插件配置页` → 确认 `端点`、`模型`、`密钥 已配置 ✅`；
   决策点列表里每个点都应有 `关闭 / 观察 / 生效` 三态（没有「即将支持」）。
   若某个点显示 `宿主缺服务`，说明宿主没有它依赖的服务（如 `translator`），
   该点无法开启——这不是 bug，是不适用的部署。
3. 把某个点切到 `观察`，触发一次对应动作 → 看
   `~/.dsh/dsh-startlux-decision/telemetry.jsonl`：
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

全部阈值都在 `startlux.yml` 里可覆盖，默认值按实测校准（见上文「阈值是实测
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
