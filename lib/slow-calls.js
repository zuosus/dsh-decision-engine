/**
 * 「决策调用持续变慢」的判定。
 *
 * 用户的要求：**连续多次出现「一次调用耗时超过 10 秒」时，在标签页上提示**。
 * 这里把它落成一条可单测的规则，而不是散落在路由与界面里的几个比较：
 *
 *   阈值  单次真实往返 **严格超过** 10 秒（恰好 10 秒不算——原文是「超过」）。
 *   连续  连着 5 次都超阈值才报警；中间夹一次快调用立刻清零。
 *
 * ## 哪些记录参与判定
 *
 * 判定的对象是「**一次真实的模型往返**」，而统计文件里有三类记录，口径不同：
 *
 *   - **缓存命中**（`cached`）0 毫秒、根本没发请求。它既不是慢调用，也不是
 *     快调用——把它当成快调用去清零，会让「偶发命中一次就再也报不出来」的
 *     静默失效发生。因此**不参与判定**。
 *   - **降级**（`degraded`）的耗时里混着两种完全不同的情况：请求发出去并
 *     超时（真等了这么久），与「缺 key / 地址非法」根本没发请求（耗时几乎为
 *     0）。两者在记录上分不开，所以：**超过阈值 → 一定真等了这么久，算慢；
 *     没超过 → 无法断定，不参与判定**（既不计数也不清零）。
 *   - **其余记录**（真实请求拿到了回复）按耗时正常判定。
 *
 * ## 为什么是内存态
 *
 * 这条警告回答的是「**现在**服务商是不是在拖慢我」。它没有历史意义：进程
 * 重启后重新攒就够了（第 5 次慢调用自然会再触发）。落盘反而是坏事——昨天
 * 的一段慢调用会让用户今天一打开面板就看到一个已经过时的警告，而警告一旦
 * 变成「反正一直亮着」，就再也没人看它。
 *
 * @module dsh-decision-engine/slow-calls
 */

/** 单次调用超过多久算「慢」。原文口径：超过 10 秒。 */
export const SLOW_CALL_THRESHOLD_MS = 10_000;

/** 连续多少次慢调用才报警。 */
export const SLOW_CALL_STREAK = 5;

/**
 * 判定一条记录该怎么参与「连续慢调用」的计数。
 *
 * @param sample - `{ durationMs, cached?, degraded? }`。
 * @param thresholdMs - 阈值（毫秒）。
 * @returns
 *   `"slow"` 计入连续段；
 *   `"fast"` 清零连续段；
 *   `"skip"` 不参与判定（缓存命中 / 无法归因的降级 / 畸形数据）。
 */
export function classifySlowCall(sample, thresholdMs = SLOW_CALL_THRESHOLD_MS) {
  const duration = sample?.durationMs;
  // 畸形数据一律不判定：把它当成 0 会静默清零一段真实的连续慢调用，
  // 当成慢又会凭空报警。两种猜测都不如「这次不知道」诚实。
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return "skip";
  if (sample?.cached === true) return "skip";
  if (duration > thresholdMs) return "slow";
  if (sample?.degraded === true) return "skip";
  return "fast";
}

/** 把任意输入归一成一个非负整数毫秒数（判不出来就是 0）。 */
function toMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * 建一个内存态的连续慢调用监视器。
 *
 * @param options.thresholdMs - 阈值，默认 `SLOW_CALL_THRESHOLD_MS`。
 * @param options.needed - 连续次数，默认 `SLOW_CALL_STREAK`。
 * @param options.now - 取当前时刻的函数（测试用）。
 * @returns `{ observe(sample), status() }`。
 */
export function createSlowCallMonitor(options = {}) {
  const thresholdMs =
    typeof options.thresholdMs === "number" && Number.isFinite(options.thresholdMs) && options.thresholdMs > 0
      ? options.thresholdMs
      : SLOW_CALL_THRESHOLD_MS;
  const needed =
    typeof options.needed === "number" && Number.isFinite(options.needed) && options.needed >= 1
      ? Math.floor(options.needed)
      : SLOW_CALL_STREAK;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  /** 当前连续慢调用的次数。 */
  let streak = 0;
  /** 当前这一段连续慢调用里，最近一次的耗时。 */
  let lastDurationMs = 0;
  /** 当前这一段连续慢调用的起点（毫秒）；0 = 还没有连续段。 */
  let sinceMs = 0;

  /**
   * 快照。每次返回**新对象**：调用方（路由）拿到的是数据，不是内部状态，
   * 改它不该影响判定。
   */
  const status = () => ({
    active: streak >= needed,
    streak,
    needed,
    thresholdMs,
    lastDurationMs,
    sinceAt: sinceMs > 0 ? new Date(sinceMs).toISOString() : "",
  });

  /**
   * 喂一条记录。
   *
   * @param sample - `{ durationMs, cached?, degraded? }`。
   * @returns 喂完之后的快照。
   */
  const observe = (sample) => {
    const verdict = classifySlowCall(sample, thresholdMs);
    if (verdict === "skip") return status();
    const durationMs = toMs(sample?.durationMs);
    lastDurationMs = durationMs;
    if (verdict === "slow") {
      if (streak === 0) sinceMs = now();
      streak += 1;
    } else {
      streak = 0;
      sinceMs = 0;
    }
    return status();
  };

  return { observe, status };
}
