/**
 * 「这一轮判断了几次」的发布通道。
 *
 * ## 它与错误尾部（lib/publish.js）是什么关系
 *
 * 那一条通路回答的是「这一轮**坏了**什么」，这一条回答的是「这一轮
 * **做了**多少次判断」——两个问题，两个事件类型，两条互不干扰的通路。
 *
 * 为什么要分开，而不是复用错误事件：错误是**例外**（一次降级就该让人去修），
 * 判断计数是**常态**（一轮里判断十次完全正常）。混进同一条事件流，客户端
 * 要么把十次正常判断渲染成十条红字，要么为了不吵而把降级一起藏掉。分开后：
 *
 *   - 拿到答案的那一次发一条**裁决**记录（带 `action`），它计入判断次数；
 *   - 试过但没拿到答案的那一次发一条**降级**记录（带 `degraded`），
 *     它只进计数器的降级桶，不计入判断次数——降级不是判断；
 *   - 原有的一条**错误**记录照发（那一条用于「去修」，见 lib/publish.js）。
 *
 * ## 为什么不直接读遥测
 *
 * telemetry.jsonl 里其实什么都有（point / action / cached / latency），
 * 但它**没有轮次**：绝大多数决策点触发时并不知道自己属于第几轮（守卫的
 * 轮次是从会话日志里回读的，翻译点压根没有会话）。而计数器的单位是「轮」——
 * 用户要看的是「这一条消息下面判断了几次」。
 *
 * 会话事件自带 `turn`，并且由会话索引**按轮次归位**：客户端的 conversation
 * 层把同轮的事件折进同一个 Turn。理由与错误处理那条通路完全相同
 * （详见 lib/publish.js 顶部的说明），这里不重复。
 *
 * ## 哪些算、哪些不算
 *
 *   - 请求真的到了端点、答案也解析出来了 → 裁决记录，计入判断次数；
 *   - 缓存命中（`cached === true`）→ **不算**：那一轮并没有真的问过决策
 *     模型，只是复用了上次的结论。算进去会让数字随命中率忽大忽小；
 *   - 任何降级（没 key / 超时 / 404 / 答案形状不符 / 适配器异常）→ 降级
 *     记录，进降级桶，**不**计入判断次数；
 *   - 没有轮次的（翻译点、拿不到 session 的适配器异常）→ 一条都不发。
 *     宁可界面上少一个数字，也不能把记录挂到**别的**消息下面——那比不
 *     显示更糟：用户会照着一条假线索去排查。
 *
 * ## 开关
 *
 * `judgementCount: false` 时**一条都不发**（零会话足迹）。客户端不需要
 * 知道这个开关：没有记录，界面上自然什么都不渲染。
 *
 * @module dsh-decision-engine/judgements
 */

import { DECISION_POINTS } from "./decision-points.js";
import { loadAppendPluginRecord } from "./publish.js";

/**
 * 本插件发布到会话的判断事件类型。
 *
 * ## 为什么是 `plugin:` 前缀
 *
 * 与错误事件（`plugin:decision-engine/error`）同一个理由：DSH 宿主的事件
 * 词表是**封闭**的，不在表里的类型只有自带 `ignorable` 标记才能被安全跳过。
 * 宿主为此留了官方出口 `appendPluginRecord(session, type, data)`，它写入的
 * 事件：
 *
 *   - 不认识这个类型的旧版 DSH 会**保留并跳过**，而不是拒绝打开会话；
 *   - 永远不进模型可见的 surface（模型看不到这些记录，它们不是给模型看的）；
 *   - fork / resume 会带着走——于是翻历史时那一轮的计数仍在原处。
 *
 * 代价是会话格式迁移对它「尽力保留」（可能丢）：这些记录只是**给人看的
 * 注解**，丢了就丢了，下一轮还会再记。
 *
 * 类型名带包名，避免与别的插件撞名。
 */
export const JUDGEMENT_EVENT_TYPE = "plugin:decision-engine/judgement";

/** 决策点 id 集合：从注册表取，不在本模块抄一份（抄了就会随新增点而腐烂）。 */
const KNOWN_POINTS = new Set(DECISION_POINTS.map((point) => point.id));

/**
 * 少数调用方报上来的是 hook 名或遥测 tag，这里映射到它承载的那个决策点。
 *
 * `pre-step` 上挂着分派与压缩两个点，取分派：适配器异常只发生在**已经
 * 进去判断过**的路径上，而映射只影响这条降级落在界面哪一行——猜错也只是
 * 行名不同，不会把「没有判断」算成「判断过」。
 */
const POINT_ALIASES = {
  guard: "authorize",
  "pre-step": "delegate",
  "turn-stopping": "turnStop",
};

/**
 * 把一个调用方报上来的点名归一成决策点 id。
 *
 * 认不出来时返回 `"unknown"`——**不猜也不丢**：留着它，界面上还能显示
 * 「决策引擎」这一行；返回 null 会让这次尝试悄悄消失，而降级桶的目的
 * 恰恰是「让用户看见它曾经试过」。
 *
 * @param {string} name - 点名（决策点 id / hook 名 / 遥测 tag）。
 * @returns 决策点 id，或 `"unknown"`。
 */
export function pointIdOf(name) {
  if (typeof name !== "string" || name.length === 0) return "unknown";
  if (KNOWN_POINTS.has(name)) return name;
  const alias = POINT_ALIASES[name];
  if (alias !== undefined && KNOWN_POINTS.has(alias)) return alias;
  return "unknown";
}

/**
 * 把一条判断记录归一化成可发布的形状。
 *
 * 纯函数：不发网络、不碰会话，因此可被单元测试直接调用。
 *
 * 归一化**可能返回 null**（缺轮次、模式不合法、既无裁决也无降级原因），
 * 那表示「这条不该发」。刻意不做「补一个默认值凑成一条」：一条挂错轮次
 * 或挂着假裁决的记录，比没有记录更糟——界面上的数字会骗人。
 *
 * @param {object} input - 归一化输入。
 * @param {number} input.turn - 第几轮（必须是有符号安全整数且 >= 0）。
 * @param {string} input.point - 决策点 id。
 * @param {string} input.mode - 该点此刻的模式（observe / enforce）。
 * @param {string} [input.action] - 裁决词（`spec.decide()` 的 `kind`，如 `skip`）。
 * @param {string} [input.degraded] - 降级原因；有它时这条是**降级**记录。
 * @returns 可发布的记录 `{turn, point, mode, action}` 或
 *   `{turn, point, mode, degraded}`；不该发时返回 null。
 */
export function normalizeJudgement(input) {
  const turn = input?.turn;
  // 轮次是这一整套的立足点：没有它，记录就归不到任何一条消息下面。
  if (!Number.isSafeInteger(turn) || turn < 0) return null;
  const mode = input?.mode;
  if (mode !== "observe" && mode !== "enforce") return null;
  const point = pointIdOf(input?.point);
  // 降级优先：一次尝试不可能同时「拿到裁决」又「没拿到答案」。
  // 有降级原因就按降级记，裁决词就算跟着传来也不看。
  const degraded = shortText(input?.degraded, 80);
  if (degraded !== undefined) return { turn, point, mode, degraded };
  const action = shortText(input?.action, 40);
  if (action === undefined) return null;
  return { turn, point, mode, action };
}

/**
 * 裁剪一段短文本。
 *
 * 记录会**逐条写进会话日志**：原因串里有的是模型/服务端给的原文，不设上限
 * 就会把用户的会话文件撑大，而它只是给人扫一眼的说明。
 *
 * @param {unknown} value - 原值。
 * @param {number} limit - 字符上限。
 * @returns 裁剪后的字符串；不是非空字符串时返回 undefined。
 */
function shortText(value, limit) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * 建一个判断发布器。
 *
 * 三条纪律，与错误发布器一致：
 *
 *   1. **从不抛**。发布失败只记日志——它是报告通路，坏了也不能影响决策；
 *   2. **fire-and-forget**。发布不 await：决策路径上多等一次 I/O 不值得，
 *      而记录晚到几十毫秒对「这一轮判断了几次」没有区别；
 *   3. **宿主接口动态取、只取一次，且缓存含失败**（见 `loadAppendPluginRecord`
 *      与本函数内的 `loadOnce`）。
 *
 * @param {object} options - 选项。
 * @param {() => boolean} [options.enabled] - 总开关；返回 false 时一条都不发。
 *   缺省视为开启。
 * @param {object} [options.logger] - 可选的日志出口。
 * @param {() => Promise<Function>} [options.load] - 取 `appendPluginRecord`
 *   的函数；缺省用 `loadAppendPluginRecord`（与错误发布器共用同一份缓存，
 *   两个事件类型合起来只动态 import 一次）。
 * @returns 发布器：含 `note`。
 */
export function createJudgementPublisher(options = {}) {
  const load = options.load ?? loadAppendPluginRecord;
  const logger = options.logger;
  /**
   * 宿主接口的装载结果（Promise），**只做一次**。
   *
   * 缓存的必要性与 `loadAppendPluginRecord` 内部那份不同：那份缓存是
   * 「动态 import 只做一次」，而 `load` 在测试里可能被换成每次计数的假实现，
   * 真实部署里也可能指向一个每次都要重新解析的装载器。判定发生在热路径上
   * （一个会话一轮里可能有十几次判断），每发一条就重新解析一次是纯浪费。
   *
   * 缓存**含失败**：接口取不到时，不必每发一条再试一次；反正都是不发。
   */
  let loadedPromise;
  /** 取宿主接口（带缓存）。 */
  const loadOnce = () => {
    if (loadedPromise === undefined) loadedPromise = Promise.resolve().then(() => load());
    return loadedPromise;
  };
  /**
   * @param {object} session - 这次判断所属的那个会话（可缺省：缺省时不发）。
   * @param {object} input - 归一化输入（见 `normalizeJudgement`）。
   * @returns 已发布的记录；没发时返回 null（含被开关关掉的情形）。
   */
  function note(session, input) {
    try {
      // 开关是**总闸**：关掉时连归一化都不必做，会话里一个字节都不多。
      if (options.enabled?.() === false) return null;
      const record = normalizeJudgement(input);
      if (record === null) return null;
      // 没有会话：记录无处可落。落到「某个」会话上就是张冠李戴，
      // 与错误通路的处理一致——只进遥测（那本来就在记），不进界面。
      if (session === undefined || session === null) return null;
      void loadOnce()
        .then((appendPluginRecord) => {
          if (typeof appendPluginRecord !== "function") {
            logger?.warn?.("dsh-decision-engine: 无法取得宿主的插件记录接口，判断计数只在日志里可见");
            return;
          }
          appendPluginRecord(session, JUDGEMENT_EVENT_TYPE, record);
        })
        .catch(() => {
          /* 发布失败绝不影响决策：这条通路只用于报告 */
        });
      return record;
    } catch {
      // 兜底：上面任何一步（含开关判断、归一化）抛异常都不能冒到决策路径上。
      return null;
    }
  }
  return { note };
}
