/**
 * 决策模型自身的 token 预算。
 *
 * 引入理由：StartLux 每次决策实测约 1,900 token，p50 延迟约 2 秒。
 * 把这个判断层挂到多个决策点上，调用量会成倍上升——如果不设上限，
 * 「省 token 的插件」反而会变成主要的 token 消耗方。
 *
 * 预算按滑动窗口统计（默认 1 小时）。一旦超限，所有决策点立刻退回
 * 本地启发式并 fail-open，等窗口滚过去自动恢复；不需要重启，也不会
 * 让工具调用被卡住。
 */
export class TokenBudget {
  /**
   * @param getLimitTokens - 返回当前上限的取值函数；0 表示不限制。
   *   刻意接收函数而不是数值：本插件的原则是「配置每次现读」，
   *   若在构造时固化，用户在配置页改了预算就得重启才生效。
   * @param getWindowMs - 返回当前窗口长度的取值函数。
   */
  constructor(getLimitTokens, getWindowMs) {
    this.getLimitTokens = getLimitTokens;
    this.getWindowMs = getWindowMs;
    /** @type {Array<{at: number, tokens: number}>} */
    this.entries = [];
    this.blocked = 0;
  }

  /** 当前生效的上限（读不到时按不限制处理，绝不因预算自身出错而卡住决策）。 */
  get limitTokens() {
    const raw = typeof this.getLimitTokens === "function" ? this.getLimitTokens() : this.getLimitTokens;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** 当前生效的窗口长度。 */
  get windowMs() {
    const raw = typeof this.getWindowMs === "function" ? this.getWindowMs() : this.getWindowMs;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 3600000;
  }

  /** 丢弃窗口外的记录。 */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].at < cutoff) drop += 1;
    if (drop > 0) this.entries.splice(0, drop);
  }

  /** 窗口内已消耗的 token。 */
  used(now = Date.now()) {
    this.prune(now);
    let total = 0;
    for (const entry of this.entries) total += entry.tokens;
    return total;
  }

  /** 预算是否已耗尽（未设置上限时永远 false）。 */
  exhausted(now = Date.now()) {
    if (this.limitTokens <= 0) return false;
    return this.used(now) >= this.limitTokens;
  }

  /**
   * 记一次消耗。
   * @param tokens - 本次估算或实测的 input token 数。
   */
  spend(tokens) {
    const amount = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    if (amount === 0) return;
    this.entries.push({ at: Date.now(), tokens: amount });
  }

  /** 记一次「因为预算耗尽而放弃判断」，用于配置页展示。 */
  noteBlocked() {
    this.blocked += 1;
  }

  /** 供 UI 展示的快照。 */
  get report() {
    const now = Date.now();
    const used = this.used(now);
    const limit = this.limitTokens;
    return {
      used,
      limit,
      windowMs: this.windowMs,
      remaining: limit <= 0 ? null : Math.max(0, limit - used),
      exhausted: this.exhausted(now),
      blocked: this.blocked,
    };
  }
}
