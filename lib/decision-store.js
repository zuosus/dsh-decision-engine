/**
 * 决策明细存储（`decisions.jsonl`）——「决策历史」标签页的数据源。
 *
 * ## 为什么不写进 telemetry.jsonl
 *
 * `telemetry.jsonl` 是**人读的审计流水账**（DEC-013 定义的「服务端到底说了
 * 什么」），而且它是 `StatsStore.backfillFromTelemetry()` 的唯一回填来源。
 * 它的平均行长实测只有 377 字节；一旦把发给决策模型的 `state`、`questions`
 * 与回来的 `answers` 塞进去，行长会膨胀十到十五倍，于是：
 *
 *   1. `tail -f` 不再好读——而这正是它存在的理由；
 *   2. 回填链路读的每一行都变大，历史迁移的内存与耗时跟着涨；
 *   3. 老版本插件读到带大字段的行时，字段口径会漂移。
 *
 * 所以另立一个文件。两个文件各管一件事：
 *
 *   - `telemetry.jsonl`  对外口径的决策**结论**（谁、哪家、什么裁决、多少 token）
 *   - `decisions.jsonl`  本地的决策**明细**（问了什么、答了什么、给谁做的）
 *
 * ## 记录体为什么带 sessionId
 *
 * 这个字段是新加的：老遥测里**根本没有**会话维度，所以「某个会话里的全部
 * 决策」在旧数据上答不出来。这里不回溯、不臆造——没有 sessionId 的记录
 * （例如思维链翻译的匿名通道）就是「不可归属」，界面上不进任何会话页。
 * 臆造一个 id 比留空更坏：它会让用户看到一条属于别人的记录。
 *
 * ## 隐私边界：唯一的开关是「决策历史」
 *
 * 这里只有一个开关——构造项 `getEnabled()`（来自 `decisionsTabEnabled`）：
 *
 *   - **关 = 完全不写**。不建文件、不占磁盘、不采集内容；不是「写了再藏」。
 *   - **开 = 记录明细，且一定带上内容**。内容只在超过单条长度上限时才由
 *     `truncateContent()` 退回 `capture: 'meta'`；没有任何配置键能把它静默
 *     剥掉——`capture: 'meta'` 因此只可能来自截断超限（`too-large` /
 *     `serialize-error` / `no-content`），不存在「配置成只记元数据」的档位。
 *
 * 内容落盘的前提是三条硬约束，写在这里是为了以后不被悄悄改掉：
 *
 *   1. **只落本地**。这条链路不经过任何网络请求，也不进匿名统计（
 *      `lib/telemetry.js` 的七个字段与这里无关）。
 *   2. **写盘前脱敏**。`maskSecrets()` 对整行做模式替换：一次 `bash` 里
 *      贴过的 API key 不该躺在磁盘上。
 *   3. **有上限**。单条内容截断、文件按体积轮转——明细不是无界日志。
 *
 * ## 写入为什么不阻塞决策
 *
 * 与 `StatsStore` 同一套做法：`record()` **不 await**，把写盘排进串行队列
 * 就返回；队列有上限，磁盘挂掉时丢最旧的。决策路径上的额外开销恒为
 * 「一次 push + 一次 JSON.stringify」，绝不等磁盘。
 *
 * @module dsh-decision-engine/decision-store
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 明细文件名（与 `telemetry.jsonl` / `stats.jsonl` 同目录）。 */
export const DECISIONS_FILE_NAME = "decisions.jsonl";

/** 轮转后的旧文件（覆盖式，只留一代）。 */
export const DECISIONS_ROTATED_NAME = "decisions.jsonl.1";

/** 记录体版本。加字段不升版本（读端按缺省值兜），改语义才升。 */
export const DECISION_RECORD_VERSION = 1;

/** 默认体积上限：8 MB。到顶就轮转，明细文件永无界增长。 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 默认单条内容上限：4000 字符。够回答「这次问了什么、答了什么」。 */
export const DEFAULT_MAX_CONTENT_CHARS = 4000;

/** 尾部读默认扫描行数：再多也不会整文件载入。 */
export const DEFAULT_SCAN_LINES = 4000;

/** 单次查询的返回条数上限。 */
export const MAX_ENTRIES_PER_QUERY = 500;

/**
 * 密钥形态的**兜底**替换表。
 *
 * 为什么是「兜底」而不是「保证」：这里只认**有固定形态**的密钥（OpenAI 风格
 * 的 `sk-`、GitHub token、JSON 里的 apiKey / token 字段）。没有固定形态的
 * 密钥（例如某家自建的任意字符串）在原理上没法靠模式识别——那种情况只能
 * 靠用户不把 key 贴进命令。因此这里的定位是「拦住最常见的泄漏形态」，
 * 不是「保证磁盘上没有密钥」。这句话必须留在代码里，否则后来的人会以为
 * 脱敏是全覆盖的。
 *
 * 替换值不含引号与反斜杠，因此对一行 JSON 做替换后仍然是合法 JSON。
 */
const SECRET_PATTERNS = [
  // OpenAI / 兼容网关的 key
  [/(sk-[A-Za-z0-9_-]{12,})/g, "sk-***"],
  // GitHub token
  [/(ghp_[A-Za-z0-9]{20,})/g, "ghp_***"],
  [/(github_pat_[A-Za-z0-9_]{20,})/g, "github_pat_***"],
  // `Authorization: Bearer xxx`（JSON 串或 header 行都认）
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***"],
  // JSON 里的敏感字段（序列化后形如 `"apiKey": "..."`）
  [/("(?:x-)?api[-_]?key"\s*:\s*")[^"]{4,}/gi, "$1***"],
  [/("(?:authorization|proxy-authorization)"\s*:\s*")[^"]{4,}/gi, "$1***"],
  [/("(?:password|passwd|secret|token|apiKeyValue)"\s*:\s*")[^"]{4,}/gi, "$1***"],
];

/**
 * 对一段文本做密钥兜底替换。
 *
 * 输入通常是**整行 JSON**（见 `DecisionStore.record`）。对整行而不是只对
 * `content` 做，是因为 `detail` 里也可能带路径或命令片段。
 *
 * @param text - 待脱敏的文本。
 * @returns 替换后的文本；输入非字符串时原样返回。
 */
export function maskSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 截断到指定长度，保留头尾（中段省略）。
 *
 * 与 `lib/index.js` 的 `headTail` 同语义，但刻意不复用：那是服务端
 * 「发给决策模型的 state」的裁剪口径，改它会改变决策行为；这里是写盘的
 * 展示口径，两者必须能各自演进。
 *
 * @param text - 原文。
 * @param headChars - 头部保留字符数。
 * @param tailChars - 尾部保留字符数。
 * @returns 截断后的文本。
 */
function headTail(text, headChars, tailChars) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const head = Math.max(0, Number(headChars) || 0);
  const tail = Math.max(0, Number(tailChars) || 0);
  if (value.length <= head + tail) return value;
  const tailText = tail > 0 ? value.slice(-tail) : "";
  return `${value.slice(0, head)}…[省略 ${value.length - head - tailText.length} 字符]…${tailText}`;
}

/**
 * 深拷贝一份可 JSON 化的值。
 *
 * 不用 `structuredClone`：明细内容来自服务端的 JSON，走一次
 * `JSON.parse(JSON.stringify())` 顺带把 `undefined`、函数、类实例全部归一成
 * 纯数据，写盘时不会出现「序列化到一半抛错」这种情况。
 *
 * @param value - 待拷贝的值。
 * @returns 拷贝结果；不可序列化时返回 undefined。
 */
function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/**
 * 把一次决策的内容裁到上限之内。
 *
 * 裁剪顺序**按信息价值从低到高**排，不是按字段顺序：
 *
 *   1. `state.args_preview` —— 工具参数预览，最长、也最可能是噪声（一段
 *      命令的完整正文）；
 *   2. `state.recent` —— 最近几条对话的摘要；
 *   3. `state` 整体 —— 换成一个「已截断」的占位对象；
 *   4. 连 `questions` / `answers` 都超限时，退回 `null` + `capture: 'meta'`。
 *
 * 为什么 `questions` / `answers` 排在最后：它们才是「这次到底问了什么、
 * 答了什么」，也就是这个页面存在的理由；`state` 是背景材料。为了保住
 * 结论可以丢掉背景，反过来不行。
 *
 * @param content - `{ state, questions, answers }`，可缺项。
 * @param maxChars - 序列化后的长度上限。
 * @returns `{ content, capture, note }`：`capture` 为 `"full"` / `"meta"`。
 */
export function truncateContent(content, maxChars) {
  const limit = Number.isFinite(Number(maxChars))
    ? Math.max(200, Number(maxChars))
    : DEFAULT_MAX_CONTENT_CHARS;
  if (content === null || typeof content !== "object") {
    return { content: null, capture: "meta", note: "no-content" };
  }
  const cloned = jsonClone(content);
  if (cloned === null || typeof cloned !== "object") {
    return { content: null, capture: "meta", note: "serialize-error" };
  }
  const sizeOf = (value) => {
    try {
      return JSON.stringify(value).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  if (sizeOf(cloned) <= limit) return { content: cloned, capture: "full", note: "" };

  // 第一刀：工具参数预览（最长、价值最低）。
  if (typeof cloned.state?.args_preview === "string") {
    cloned.state.args_preview = headTail(cloned.state.args_preview, Math.floor(limit / 8), 0);
    if (sizeOf(cloned) <= limit) return { content: cloned, capture: "full", note: "trim-args" };
  }
  // 第二刀：最近对话摘要。
  if (typeof cloned.state?.recent === "string") {
    cloned.state.recent = headTail(cloned.state.recent, Math.floor(limit / 8), 0);
    if (sizeOf(cloned) <= limit) return { content: cloned, capture: "full", note: "trim-recent" };
  }
  // 第三刀：整个 state 换成占位（保住 questions / answers）。
  if (cloned.state !== undefined && cloned.state !== null) {
    cloned.state = { truncated: true, note: "state dropped to fit the content limit" };
    if (sizeOf(cloned) <= limit) return { content: cloned, capture: "full", note: "drop-state" };
  }
  // 最后的兜底：内容整体不存，只留元数据。
  return { content: null, capture: "meta", note: "too-large" };
}

/**
 * 造一条决策明细记录。
 *
 * 与 `stats.js` 的 `buildRecord` 同一个角色：**唯一的构造入口**。差异在于
 * 这里多两样东西——会话归属与决策内容——而它们正是这个页面的核心。
 *
 * 字段取舍说明：
 *
 *   - `mode` 是**决策点自己的三态**（observe / enforce / off）；`topMode`
 *     是旧的顶层 `shadow` / `enforce`。两者并存，因为界面要同时回答
 *     「这个点在当时是观察还是生效」与「插件整体是什么模式」。
 *   - `tool` / `turn` / `step` **有则带、无则省**。不同决策点的现场不同
 *     （授权点有工具名与轮次，翻译点什么都没有），硬造一个 `null` 只会
 *     让界面多出一列「—」。
 *   - `action` 是裁决词（`delegate` / `deny` / `keep` / `skip` / `switch` …），
 *     `detail` 是人读的原因。两者都留，因为界面表里只放裁决词、展开才看原因。
 *
 * @param options - 字段见函数体；缺省值一律给安全值。
 * @returns 记录对象（字段齐整，可直接 JSON 化）。
 */
export function buildDecisionRecord(options = {}) {
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const str = (value, fallback = "") =>
    typeof value === "string" && value.length > 0 ? value : fallback;
  const optional = (value) =>
    typeof value === "string" && value.length > 0 ? { value } : undefined;

  const tool = optional(options.tool);
  const turn = typeof options.turn === "number" && Number.isFinite(options.turn) ? options.turn : undefined;
  const step = typeof options.step === "number" && Number.isFinite(options.step) ? options.step : undefined;
  const scores = options.scores === undefined ? undefined : jsonClone(options.scores);
  const trimmed =
    options.content === undefined || options.content === null
      ? { content: null, capture: "meta", note: "no-content" }
      : truncateContent(options.content, options.maxContentChars);

  const record = {
    v: DECISION_RECORD_VERSION,
    seq: num(options.seq),
    ts: str(options.ts, new Date().toISOString()),
    // 空串 = 不可归属。读端据此把它排除在「某个会话的决策历史」之外。
    sessionId: str(options.sessionId),
    point: str(options.point, "unknown"),
    tag: str(options.tag),
    mode: str(options.mode, "unknown"),
    topMode: str(options.topMode),
    provider: str(options.provider, "unknown"),
    model: str(options.model),
    action: str(options.action),
    detail: str(options.detail),
    // 降级失败时的 HTTP 状态码（401/403/404/500 ...）：来自降级原因的 extra.status。
    // 单独成字段，便于「标记」列直接展示（如 HTTP 401），而不必去猜 detail 是否带码。
    status: typeof options.status === "number" && Number.isFinite(options.status) ? options.status : undefined,
    cached: options.cached === true,
    degraded: options.degraded === true,
    latencyMs: num(options.latencyMs),
    inputTokens: num(options.inputTokens),
    outputTokens: num(options.outputTokens),
    capture: trimmed.capture,
  };
  if (tool !== undefined) record.tool = tool.value;
  if (turn !== undefined) record.turn = turn;
  if (step !== undefined) record.step = step;
  if (scores !== undefined && scores !== null) record.scores = scores;
  if (trimmed.content !== null) record.content = trimmed.content;
  // note 只在真的裁剪过时才写：未裁剪的记录不该带一个空字段。
  if (trimmed.note.length > 0 && trimmed.note !== "no-content") record.contentNote = trimmed.note;
  return record;
}

/**
 * 从文件尾部倒着读，最多取 `maxLines` 行。
 *
 * 为什么必须从尾部读：明细带内容后文件会长到上百 MB，整文件载入会
 * 把宿主进程的堆打满——而这个页面绝大多数时候只想看**最近几十条**。
 *
 * 坏行（写到一半被杀的半行）在这里原样返回、由调用方跳过，与
 * `StatsStore.read()` 的容错口径一致。
 *
 * @param path - 文件路径。
 * @param maxLines - 最多返回多少行。
 * @param chunkBytes - 每次反向读取的字节数。
 * @returns 行数组，**最早的在前**；文件不存在或读失败时返回空数组。
 */
export async function readTailLines(path, maxLines, chunkBytes = 65536) {
  const want = Math.max(0, Number(maxLines) || 0);
  if (want === 0) return [];
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return [];
  }
  const reversed = [];
  try {
    const info = await handle.stat();
    let position = info.size;
    let buffer = "";
    while (position > 0 && reversed.length < want) {
      const start = Math.max(0, position - Math.max(1024, chunkBytes));
      const length = position - start;
      const data = await handle.read(Buffer.alloc(length), 0, length, start);
      buffer = data.buffer.subarray(0, data.bytesRead).toString("utf8") + buffer;
      const parts = buffer.split("\n");
      // 第一段一定是被截断的半行，留给下一轮（或循环结束后处理）。
      buffer = parts.shift() ?? "";
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const trimmed = parts[index].trim();
        if (trimmed.length > 0) reversed.push(trimmed);
        if (reversed.length >= want) break;
      }
      position = start;
    }
    // 走到文件头时，buffer 里剩下的是最早那一行（文件没有尾换行时会走到这里）。
    if (position === 0 && reversed.length < want && buffer.trim().length > 0) {
      reversed.push(buffer.trim());
    }
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
  return reversed.reverse();
}

/**
 * 把一批行按字节上限切成若干片。
 *
 * 切分点必须落在**行边界**上：JSONL 一行被劈成两半，解析时会变成两条坏行
 * （与 `StatsStore.schedule` 那个「并发 appendFile 会把行拆成两半」的坑
 * 同一类）。因此这里按「累积字节数」找切点，然后把切点回退到下一个换行。
 *
 * @param lines - 待写的行（每行自带结尾的 `\n`）。
 * @param limit - 每片的最大字节数。
 * @returns 片的数组；入参为空时返回空数组。
 */
function splitByBytes(lines, limit) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const max = Math.max(1024, Number(limit) || DEFAULT_MAX_BYTES);
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, "utf8");
    // 单行就超过上限：它自己成一片（没法再切——切了就是坏行）。
    if (size > 0 && size + bytes > max) {
      chunks.push(current.join(""));
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current.join(""));
  return chunks;
}

/**
 * 取一条记录的稳定唯一标识。
 *
 * 新记录自带 `id`（`<进程前缀>-<seq>`，见 `DecisionStore.record`）。但**已经
 * 落盘的老记录没有这个字段**——它们只有 `seq`，而 `seq` 跨重启会重复。
 * 因此这里用 `ts#seq` 兜底：`ts` 精确到毫秒，两个不同进程要写出完全相同的
 * 时间戳**且**相同的 seq 才会撞，实测用户的 308 条历史数据里 308/308 唯一。
 *
 * 这个函数是「哪些字段能当身份用」的**唯一**定义处：存储层读取时会用它补齐
 * `id`，界面拿 `id` 当 key 与展开标识——两边不能各算一套，否则又会错位。
 *
 * @param entry - 一条记录。
 * @returns 稳定标识；拿不到任何字段时返回空串。
 */
export function recordIdOf(entry) {
  if (entry === null || typeof entry !== "object") return "";
  if (typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  const ts = typeof entry.ts === "string" ? entry.ts : "";
  const seq = Number(entry.seq);
  if (ts.length === 0 && !Number.isFinite(seq)) return "";
  return `${ts}#${Number.isFinite(seq) ? seq : 0}`;
}

/**
 * 决策明细存储。
 *
 * 用法：
 *
 *   const store = new DecisionStore({ dir, getEnabled, getMaxBytes });
 *   store.record(buildDecisionRecord({ … }));       // 不 await，异步落盘
 *   const page = await store.readForSession(sessionId, { limit: 200 });
 */
export class DecisionStore {
  /**
   * @param options.dir - 插件数据目录（`~/.dsh/dsh-decision-engine/`）。
   * @param options.fileName - 文件名，默认 `decisions.jsonl`。
   * @param options.logger - 宿主 logger；写盘失败时用它警告。
   * @param options.getEnabled - 返回「决策历史」开关。**关闭时不写任何东西**：
   *   不建文件、不占磁盘、也不采集内容。用取值函数而不是定值，配置改了
   *   立刻生效（与插件其余配置的处理方式一致）。**这是唯一的开关**：开启时
   *   记录一定带内容，内容只在超过长度上限时才由 `truncateContent()` 退回
   *   `capture: 'meta'`。
   * @param options.getMaxBytes - 返回文件体积上限。
   * @param options.getMaxContentChars - 返回单条内容长度上限。
   * @param options.maxQueue - 待写队列上限；超过丢最旧的，防止磁盘挂起时吃内存。
   */
  constructor(options = {}) {
    this.dir = options.dir;
    this.fileName = options.fileName ?? DECISIONS_FILE_NAME;
    this.logger = options.logger;
    this.getEnabled = typeof options.getEnabled === "function" ? options.getEnabled : () => true;
    this.getMaxBytes =
      typeof options.getMaxBytes === "function" ? options.getMaxBytes : () => DEFAULT_MAX_BYTES;
    this.getMaxContentChars =
      typeof options.getMaxContentChars === "function"
        ? options.getMaxContentChars
        : () => DEFAULT_MAX_CONTENT_CHARS;
    this.maxQueue = Number.isFinite(options.maxQueue) ? Math.max(16, options.maxQueue) : 4096;
    /** 待写队列（已脱敏的整行文本）。 */
    this.queue = [];
    /** 正在进行的写盘任务。 */
    this.pending = null;
    /** 进程内单调序号：同一毫秒内多条记录之间也能稳定排序。 */
    this.seq = 0;
    /**
     * 记录 id 的进程前缀，每次构造（= 每次插件加载）随机生成。
     *
     * 它与 `seq` 拼成 `id`，解决「`seq` 跨重启重复」：只靠进程内计数器，
     * DSH 重启后新记录的 seq 会与旧记录撞车（实测 307 条里 89 个重复），
     * 界面上的 React key 也就跟着重复——点第二行会展开第三行。
     */
    this.idPrefix = randomUUID().slice(0, 8);
    /** 累计写入条数（诊断用）。 */
    this.written = 0;
    /** 累计失败条数（诊断用）。 */
    this.failed = 0;
    /** 队列溢出丢弃的条数（诊断用）。 */
    this.dropped = 0;
    /** 轮转次数（诊断用）。 */
    this.rotated = 0;
    /** 自上次轮转以来已追加的字节数。 */
    this.appendedBytes = 0;
    /** 是否已经确认过文件权限（避免每条记录一次 chmod）。 */
    this.permissionSettled = false;
  }

  /** 明细文件的绝对路径。 */
  get path() {
    return join(this.dir, this.fileName);
  }

  /** 轮转后旧文件的绝对路径。 */
  get rotatePath() {
    return join(this.dir, DECISIONS_ROTATED_NAME);
  }

  /** 开关是否开启。 */
  enabled() {
    try {
      return this.getEnabled() !== false;
    } catch {
      return false;
    }
  }

  /**
   * 记一条决策明细。
   *
   * **不返回 Promise**：调用方不该 await 它。写盘在后台串行进行，决策路径
   * 上的额外开销只有一次 `JSON.stringify` 与一次 `push`。
   *
   * @param record - `buildDecisionRecord()` 造出的记录。
   * @returns 是否入队（开关关闭、内容为空、序列化失败都返回 false）。
   */
  record(record) {
    if (!this.enabled()) return false;
    if (record === null || typeof record !== "object") return false;
    const seq = this.seq + 1;
    /**
     * `id` 是记录的**全局唯一标识**；`seq` 不是。
     *
     * 这是真机上被用户抓到的缺陷（2026-11-03：「点第二个，展开的是第三个」）：
     * `seq` 只是**进程内**计数器，DSH 每重启一次就从 1 重新数。实测用户的
     * `decisions.jsonl` 里 307 条记录只有 119 个不同的 `seq`（89 个重复）。
     *
     * 界面拿 `seq` 当 React `key` 与「哪一行展开了」的标识，于是：
     *   1. 重复 key 让 React 把行/事件处理器对到错的 DOM 节点上——
     *      点第二行展开的是第三行；
     *   2. `expanded === seq` 会同时命中多条记录，展开一行冒出好几段详情。
     *
     * 因此在进程内计数之外，再拼一段**每次启动随机生成**的前缀：两者合起来
     * 跨重启唯一。`seq` 原样保留——它是**排序**用的，语义不变。
     */
    //
    // 内容与 `capture` 一律**原样落盘**：开关开着就是「记录明细且一定带内容」，
    // 这里没有第二个档位可以把它降级成只记元数据（`capture: 'meta'` 只可能由
    // `buildDecisionRecord()` → `truncateContent()` 的超限裁剪产生）。
    const finalRecord = { ...record, seq, id: `${this.idPrefix}-${seq}` };
    let line;
    try {
      // 脱敏放在**序列化之后**：模式表针对的是 JSON 文本形态（`"apiKey": "…"`），
      // 对结构化对象做替换既难写又容易漏。
      line = maskSecrets(JSON.stringify(finalRecord));
    } catch {
      // 循环引用之类的问题不该把调用方带崩——明细是旁路。
      this.failed += 1;
      return false;
    }
    this.seq += 1;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(`${line}\n`);
    this.schedule();
    return true;
  }

  /**
   * 安排一次落盘。
   *
   * 串行保证顺序：写入中的那一次没结束就不再发起新的写，否则两个
   * `appendFile` 并发会让同一行被拆成两半——JSONL 一行拆开后，解析时
   * 会被当成两条坏行丢掉（与 `StatsStore.schedule` 同一个理由）。
   */
  schedule() {
    if (this.pending !== null) return;
    this.pending = this.drain().finally(() => {
      this.pending = null;
      if (this.queue.length > 0) this.schedule();
    });
    // drain 里可能先轮转再写；错误已在内部吞掉，这里只防未处理的 rejection。
    this.pending.catch(() => {});
  }

  /** 把队列里的条目写进文件；到体积上限时先轮转。 */
  async drain() {
    await Promise.resolve();
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      const payload = batch.join("");
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await this.ensureSizeBaseline();
        const limit = this.maxBytes();
        /**
         * 一批可能很大（调用方连续记了 200 条 → 一批 60 KB），**整批写会
         * 直接冲过上限**：轮转判断发生在写之前，而写之前文件还是空的，
         * 于是「追加字节数 + 这一批 > 上限」永远不成立，上限形同虚设。
         *
         * 因此把这一批按上限切成若干片，逐片写。片与片之间才可能触发
         * 轮转，于是「文件有多大」真正受上限约束。
         */
        for (const chunk of splitByBytes(batch, limit)) {
          // 写之前：文件已接近上限就先轮转，让新内容从一个空文件开始。
          // `appendedBytes > 0` 是「文件还空着就不轮转」——对着一个不存在的
          // 文件 rename 会失败，那只是噪音。
          if (this.appendedBytes > 0 && this.appendedBytes + chunk.length > limit) {
            await this.rotate();
          }
          const handle = await open(this.path, "a");
          try {
            await handle.write(chunk);
          } finally {
            await handle.close().catch(() => {});
          }
          this.appendedBytes += chunk.length;
        }
        this.written += batch.length;
        if (!this.permissionSettled) {
          this.permissionSettled = true;
          // 明细里可能有会话正文与命令片段，权限与 config.yml 一致保持 600。
          await chmod(this.path, 0o600).catch(() => {});
        }
      } catch (error) {
        // 写盘失败：丢这批，记一次警告。**不重试**——重试会堆积，
        // 而明细失败绝不该拖住决策。
        this.failed += batch.length;
        this.logger?.warn?.(
          `dsh-decision-engine: 写入决策明细失败（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }
  }

  /** 体积上限（现读配置）。 */
  maxBytes() {
    try {
      const value = Number(this.getMaxBytes());
      return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
    } catch {
      return DEFAULT_MAX_BYTES;
    }
  }

  /**
   * 首次写盘前用真实文件大小初始化「已追加字节」。
   *
   * 为什么需要：进程刚启动时 `appendedBytes` 是 0，而磁盘上的文件可能已经
   * 有几十 MB（升级前累积的）。不校准的话要再写满一整个上限才轮转。
   */
  async ensureSizeBaseline() {
    if (this.permissionSettled) return;
    try {
      const info = await stat(this.path);
      this.appendedBytes = info.size;
    } catch {
      this.appendedBytes = 0;
    }
  }

  /**
   * 把当前文件挪成 `.1`，覆盖上一代。
   *
   * 只留一代而不是多代：这个页面的用途是「看会话里刚才发生了什么」，
   * 不是归档。多代备份会让磁盘占用变成上限的整数倍，而收益近似为零。
   */
  async rotate() {
    try {
      await unlink(this.rotatePath).catch(() => {});
      await rename(this.path, this.rotatePath);
      this.rotated += 1;
    } catch (error) {
      this.logger?.warn?.(
        `dsh-decision-engine: 轮转决策明细失败（${error instanceof Error ? error.message : String(error)}）`,
      );
    } finally {
      // 无论成功与否都把计数清零：失败时继续往老文件写也不会无限跑偏。
      this.appendedBytes = 0;
    }
  }

  /**
   * 读某个会话的决策明细（时间升序）。
   *
   * 先读当前文件尾部；不够再读轮转过的 `.1`（更早的那些）。**永远整读**：
   * 扫描行数有上限 `DEFAULT_SCAN_LINES`，返回条数有上限 `MAX_ENTRIES_PER_QUERY`。
   *
   * @param sessionId - 会话 id；空串直接返回空页（不可归属的记录不属于任何人）。
   * @param options.limit - 返回多少条（默认 200，上限 500）。
   * @param options.scanLines - 最多倒着扫多少行（默认 4000）。
   * @returns `{ entries, total, scanned, truncated, file }`。
   *   `total` 是扫描窗口内**该会话**的记录数，可能大于 `entries.length`。
   */
  async readForSession(sessionId, options = {}) {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    const limitRequested = Number(options.limit);
    const limit = Number.isFinite(limitRequested) && limitRequested > 0
      ? Math.min(MAX_ENTRIES_PER_QUERY, Math.floor(limitRequested))
      : 200;
    const scanLines = Number.isFinite(Number(options.scanLines))
      ? Math.max(limit, Math.floor(Number(options.scanLines)))
      : DEFAULT_SCAN_LINES;
    const empty = {
      entries: [],
      total: 0,
      scanned: 0,
      truncated: false,
      file: this.path,
      enabled: this.enabled(),
    };
    if (id.length === 0) return empty;

    const current = await readTailLines(this.path, scanLines);
    let lines = current;
    let scannedHitCap = current.length >= scanLines;
    if (current.length < scanLines) {
      const older = await readTailLines(this.rotatePath, scanLines - current.length);
      lines = [...older, ...current];
    }

    const matched = [];
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // 坏行跳过（与 StatsStore.read 同口径），不影响其余记录。
        continue;
      }
      if (entry === null || typeof entry !== "object") continue;
      if (typeof entry.sessionId !== "string" || entry.sessionId !== id) continue;
      matched.push(entry);
    }
    // 按**时间**排序，不按 `seq`。
    //
    // 这里曾经按 seq 排，理由是「崩溃重启后文件顺序可能错位」——那个理由
    // 站不住：文件是**追加**写的，append 顺序本身就是发生顺序（轮转也只是把
    // 旧文件拼在前面）。而 `seq` 每重启一次就从 1 重数（实测 307 条里只有
    // 119 个不同的 seq），按它排序会把不同批次的记录交叉排出来，**时间顺序
    // 整个乱掉**——那正是「决策历史」这个页面唯一的排序依据。
    //
    // 现在按 ts 升序；ts 相同时由 `Array.prototype.sort` 的稳定性保持文件里
    // 的先后，那也正是真实发生顺序。
    matched.sort((left, right) => String(left.ts ?? "").localeCompare(String(right.ts ?? "")));

    const entries = matched.slice(-limit);
    /**
     * 补齐 `id` 并保证**本次响应内唯一**。
     *
     * 老记录没有 `id` 字段（本次修复之前写的），用 `ts#seq` 兜底；万一连这个
     * 也撞（同一毫秒 + 同一 seq），再加一个位置后缀。界面拿 `id` 当 React
     * `key` 与展开标识，**重复 key 会让点击落到错的行上**，所以这一层不能
     * 留给界面去赌。
     */
    const seen = new Set();
    for (const entry of entries) {
      const base = recordIdOf(entry);
      let unique = base;
      let attempt = 1;
      while (seen.has(unique)) {
        unique = `${base}~${attempt}`;
        attempt += 1;
      }
      seen.add(unique);
      entry.id = unique;
    }
    return {
      entries,
      total: matched.length,
      scanned: lines.length,
      truncated: matched.length > limit || scannedHitCap,
      file: this.path,
      enabled: this.enabled(),
    };
  }

  /**
   * 等待队列里的内容全部落盘。
   *
   * 只在**关停**与测试里用；决策路径上绝不能 await 它。
   *
   * @returns 落盘后的条数。
   */
  async flush() {
    while (this.pending !== null) {
      await this.pending.catch(() => {});
    }
    return this.written;
  }
}
