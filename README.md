# dsh-startlux-decision

给 DeepSeek Harness 的 System-1 决策守卫，专为 **Bamboo Relay / StartLux** 打造。
在每次工具调用前问模型四个问题（风险、可逆性、任务相关性、注入嫌疑），据此放行、
询问或拦截。默认 `shadow`：只记录判断，绝不打断你干活。

## 为什么另起一个插件

`dsh-jev-interceptor` 0.5.0 在这套环境里有一串叠加缺陷，导致「配了 base URL 和 key，
但服务商后台一条调用都没有」。本插件针对性绕开：

| 旧插件的问题 | 本插件的做法 |
| --- | --- |
| `settings.installSection(...)` 在当前 DSH 中**不存在**，抛错被 catch 吞掉，设置表单永不出现 | 完全不用 settings 服务；配置只放 `startlux.yml` |
| `Config` 没有 `.volatile()`，settings 的 `volatileForm()` 返回 `undefined`，整个 entry 被丢弃，所有持久化命令必然失败 | 不依赖该机制（也避免 `.volatile()` 把值包成 `{get()}` 导致 `=== true` 判断失效） |
| `apply()` 里把 `endpoint` 固化进 client，之后改 Base URL **永不影响**已构造的实例 | `classify()` 每次请求现读配置 |
| 填 `https://api.bamboonode.dev/v1` 会被原样 POST → `404 Invalid URL (POST /v1)` | `normalizeEndpoint()` 自动补 `/decisions`，两种写法都接受 |
| 默认 `timeoutMs: 1500`，而实测 p50≈0.7s、冷启动 p95≈6.4s → 必然超时 | 默认 8000ms |
| 默认 `enabled: false` 且无提示，请求静默不发 | 启动日志直接打印端点/模型/密钥状态，「测试端点」按钮可立即真实验证 |

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

### 方式一：插件配置页（推荐）

**插件 → 已安装 → dsh-startlux-decision → 点进该插件**，配置区（「包含的组件」
**上方**）会出现 StartLux 卡片，布局与内置 `dsh-rewind-plugin` 一致：

- 两个开关：`启用守卫`、`真正拦截`
- 一个 **API Key 输入框** + `保存` 按钮
- 一个 `测试端点` 按钮

> 实现要点（踩过的坑）：必须写成
> ```js
> ctx.effect(function* () {
>   yield ctx.locale.register(NS, { zh, en });
>   yield ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({...}, Card));
> });
> ```
> `ctx.effect` 要收 **generator 函数**、用 `yield` 挂载。写成普通函数 + 直接
> `inject` 时回调不会触发，表现为 Console 只有 `apply() called`、界面空白。
> 这是照 `dsh-rewind-plugin` 与 `dsh-experimental-client-ui-cot-translation`
> 两个可用插件的真实写法得出的。

### 方式二：直接编辑文件

**只需要一个 API key**，写在插件自己的配置文件里：

```
~/.dsh/plugins/dsh-startlux-decision/startlux.yml
```

```yaml
enabled: true
mode: shadow
baseUrl: https://api.bamboonode.dev/v1/decisions
model: startlux-decision-27b-autothink
apiKey: sk-...
timeoutMs: 20000
thinkMode: never
```

改完**不用重启**：每次工具调用前会比对 mtime 并重载。

可用环境变量 `STARTLUX_GUARD_CONFIG` 指向别的配置文件路径。

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

- **缓存**：相同 `state` + 问题集命中即返回，0 网络 0 token（实测第二次 `0ms`）。
- **`thinkMode: never`**：实测主要省**延迟**（约 1.9s vs 7.2s）；输入 token 基本不变
  （该端点 `output_tokens` 恒为 0，思考开销未计入计量）。
- **只读工具直接放行**：`read`/`grep`/`glob`/`todo_write` 等不发请求。
- **state 截断**：`args` 走头尾摘要，`recent` 只带最近 4 条、每条 240 字符。
- **失败冷却**：连续 3 次失败进入 60s 冷却，避免对着故障端点烧钱。
- **`shadow` 默认**：先观察命中率再决定是否 `enforce`。

## 验证链路

1. `「测试端点」按钮` → 看到 `HTTP 200` 和 `x-oneapi-request-id`，说明配置与网络都对。
2. `插件配置页` → 确认 `端点`、`模型`、`密钥 已配置 ✅`。
3. 触发一次 `bash` 等非只读调用 → 看 `~/.dsh/plugins/dsh-startlux-decision/telemetry.jsonl`：
   - `action=degraded, detail=no-key` → key 没读到
   - `detail=http-404` / `http-400` → 地址或模型不对（记录里带 `endpoint` 和 `body`）
   - `action=ask/deny/delegate` → 决策正常
4. 服务商后台 → 出现 `type=2 · Action decision` 记录。

## 阈值

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `guardDenyConfidence` | 0.85 | 高风险 + 高置信 + 不可逆 → `deny` |
| `guardIrreversibleDenyFloor` | 0.5 | 判定不可逆的门槛 |
| `guardIrreversibleCeiling` | 0.2 | 低风险但不可逆 → 升级询问 |
| `guardConfidenceMin` | 0.6 | 中风险置信下限，低于则放行 |
| `guardInjectionAskThreshold` | 0.8 | 注入嫌疑 → 升级询问 |

## License

MIT
