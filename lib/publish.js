/**
 * 把决策引擎的错误送到**聊天界面**上。
 *
 * ## 这条通路解决什么
 *
 * 本插件全程 fail-open：决策模型挂了、地址错了、key 没配，一切照常放行。
 * 这对「不打断用户」是对的，对「用户能修」是错的——降级时界面上什么都不显示，
 * 用户只会觉得「这个插件好像没生效」。
 *
 * 宿主日志能看见，但那是另一个界面（终端 / 日志文件）。用户要修，就得在
 * **他正在看的那个对话里**看见「这一轮因为什么坏了」。
 *
 * ## 为什么走会话事件
 *
 * 候选是让前端轮询 `/api/decision-engine/log`，但那条路有两个硬伤：
 *
 *   1. **归不到轮次**。HTTP 接口知道错误发生在什么时刻，却不知道它属于
 *      哪一轮；除非额外传 sessionId+turn，而前端并不知道界面正在显示
 *      第几轮（那是会话索引的内部结构，前端拿不到）。
 *   2. **历史错误会张冠李戴**。轮询拿到的是「最近 N 条错误」，配上
 *      当前的轮次号，就会把三天前的故障挂到今天的新消息下面。
 *
 * 会话事件自带 `turn`，而且**由会话索引按轮次归位**：客户端的 conversation
 * 层把同轮事件折进同一个 Turn，前端拿到的天然是「这一轮的错误列表」。
 * 附带好处是会话重放时错误跟着重放——翻历史时那轮的故障仍在原处。
 *
 * ## 与其它插件的写法一致
 *
 * DSH 自带的 `llm-retry` 就是这么做的：宿主 `session.append("llm/retry", …)`，
 * 客户端的 conversation Definition 按 `event.type` 匹配并折进状态。
 * 本模块沿用同一套形状，只是事件名换成插件自己的。
 *
 * @module dsh-decision-engine/publish
 */

import { ERROR_LABELS, createErrorLedger, normalizeError } from "./errors.js";

/**
 * 动态取 `appendPluginRecord`。
 *
 * ## 为什么要动态 import
 *
 * `@deepseek-ai/dsh-session` 是**宿主自带**的包（app 的 dependency，
 * 通过 installation scope 提供给每个 profile），不是能单独安装的 npm 包。
 * 若在模块顶层 `import`，一旦某个部署环境解析不到它，**整个插件都加载不了**
 * ——包括配置页与九个决策点这些核心功能。
 *
 * 而错误尾部只是**增强**：它坏掉时，决策本身必须照常工作。
 * 所以这里延迟到真正要发错误时才加载，且加载失败就只记不发布。
 *
 * @returns `appendPluginRecord` 函数，或 undefined（取不到）。
 */
let appendPluginRecordPromise;

/**
 * 取一次 `appendPluginRecord`（结果缓存，含失败）。
 *
 * @returns `Promise<appendPluginRecord | undefined>`。
 */
export function loadAppendPluginRecord() {
  if (appendPluginRecordPromise === undefined) {
    appendPluginRecordPromise = import("@deepseek-ai/dsh-session")
      .then((module) => (typeof module.appendPluginRecord === "function" ? module.appendPluginRecord : undefined))
      .catch(() => undefined);
  }
  return appendPluginRecordPromise;
}

/**
 * 本插件发布到会话里的错误事件类型。
 *
 * ## 为什么是 `plugin:` 前缀
 *
 * DSH 宿主的事件词表（`SessionEventMap`）是**封闭**的：不在表里的事件类型，
 * 持久化读路径不肯跳过它——因为它无法判断「跳过这条会不会重建出一个错的
 * 会话」，宁可报错也不静默丢事件。
 *
 * 宿主为此留了一个**官方出口**：`appendPluginRecord(session, type, data)`。
 * 它写入的事件自带 `ignorable` 标记，于是：
 *
 *   - 不认识这个类型的旧版 DSH 会**保留并跳过**它（不重建错的会话）；
 *   - 它**永远不进模型可见的 surface**（模型看不到这些错误）；
 *   - fork / resume 会把它带着走。
 *
 * 代价（宿主文档里写明的）：会话格式迁移对这类记录是「尽力保留」，
 * 插件自己可能丢状态——但那不影响会话其余部分的解释。
 * 对我们来说正合适：这些错误只是**给人看的注解**，丢了就丢了，
 * 下一轮还会再记。
 *
 * 类型名必须是 `plugin:` 加小写斜杠分段（宿主的语法规定），
 * 这里用 `plugin:decision-engine/error`——带上包名，避免与别的插件撞名。
 *
 * 与 DSH 自带的 `dsh-experimental-translator` 同一套写法
 * （`plugin:translator/request` 那种）。
 */
export const ERROR_EVENT_TYPE = "plugin:decision-engine/error";

/**
 * 建一个「错误发布器」。
 *
 * @param {object} options - 选项。
 * @param {(session: object, error: object) => void} options.publish - 把一条错误
 *   写进**指定会话**。宿主实现负责 `session.append`（并处理 `ignorable` 细节）。
 *   带上 session 是必须的：错误必须落在「出问题的那一个会话」里，
 *   落到别的会话上就成了张冠李戴。
 * @param {(error: object) => void} [options.logger] - 可选的日志出口。
 * @param {number} [options.maxTurns] - 账本保留的轮数上限。
 * @returns 发布器：含 `note` / `errorsOf` / `clear`。
 */
export function createErrorPublisher(options) {
  const ledger = createErrorLedger({ maxTurns: options.maxTurns });
  /**
   * 记一条错误并发布出去。
   *
   * @param {object} session - 出错的那个会话（可缺省：缺省时只记不发布）。
   * @param {object} input - 归一化输入（见 `normalizeError`）。
   * @returns 归一化后的错误对象；没有轮次时只记不发布。
   */
  function note(session, input) {
    const error = normalizeError(input);
    if (!Number.isSafeInteger(error.turn)) return error;
    ledger.note(error);
    if (session === undefined || session === null) return error;
    try {
      options.publish(session, error);
    } catch (publishError) {
      // 发布失败绝不能影响决策：这条通路只用于「报告」。
      options.logger?.warn?.(
        `dsh-decision-engine: 错误发布失败（${publishError instanceof Error ? publishError.message : String(publishError)}）`,
      );
    }
    return error;
  }
  return {
    note,
    /** 某一轮的错误列表（供宿主自己的 HTTP 接口复用）。 */
    errorsOf: (turn) => ledger.errorsOf(turn),
    clear: () => ledger.clear(),
  };
}

/**
 * 把一段降级原因翻译成可展示的分类。
 *
 * `classify()` 的降级原因不是固定词表：`http-404` / `http-500` 这类是
 * 动态拼出来的，而 `ERROR_LABELS` 只列了用户真正需要区分开的几类。
 * 这里做一次归并，让界面上不会出现「HTTP 500」和「HTTP 502」两行几乎
 * 一样的红字。
 *
 * @param {string} reason - 降级原因。
 * @returns 归一化后的分类键（`ERROR_LABELS` 的键之一）。
 */
export function errorCodeOf(reason) {
  if (typeof reason !== "string" || reason.length === 0) return "adapter-error";
  if (ERROR_LABELS[reason] !== undefined) return reason;
  // 429 是限流：它与其它 HTTP 错误的修复动作不同（等一会儿就好，
  // 而不是改地址或改 key），所以单独一行。
  if (reason === "http-429") return "rate-limited";
  // 其它 http-4xx / http-5xx 一律归成「http-error」：它们的修复动作不同
  // （4xx 多半是地址/模型写错，5xx 多半是服务端问题），但都属于
  // 「请求没成」，值得单独一行。
  if (reason.startsWith("http-")) return "http-error";
  if (reason === "build-error") return "adapter-error";
  if (reason === "no-questions") return "adapter-error";
  if (reason === "no-spec") return "adapter-error";
  if (reason === "classify") return "adapter-error";
  return "adapter-error";
}
