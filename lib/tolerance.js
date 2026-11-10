/**
 * 「人工审核比例」（tolerance）——**模型无关**的打扰频率设定。
 *
 * ## 为什么需要这一层
 *
 * 现有的授权裁决靠**固定阈值**（`guardConfidenceMin` / `guardIrreversibleCeiling` /
 * `guardTaskRelevanceFloor` …）。这些阈值是在**某一家决策模型**的输出分布上
 * 校准出来的，换一个模型就失去意义：
 *
 *   - 同一个 0.4，在 A 模型上是「中风险」，在 B 模型上可能只是「基线噪声」；
 *   - 同一个 0.9，在 A 模型上几乎不出现，在 B 模型上是家常便饭。
 *
 * 而用户真正想表达的不是「阈值是多少」，而是「**大概每多少次调用来问一次**」。
 * 这两件事之间隔着一层「模型归一化」，本模块就是那层归一化。
 *
 * ## 归一化怎么做：滚动分位数，而不是固定阈值
 *
 * 每次授权裁决都算出一个 **severity**（严重度，0–1，与模型无关的可比量），
 * 把它塞进一个**滚动窗口**（按 provider × model 分开）。窗口里存的是
 * 「这个模型最近怎么说的」，于是：
 *
 *   - 「最严重的 1%」= 窗口里的 **P99 分位**，而不是某个固定的绝对分数；
 *   - 换模型时窗口是空的，阈值重新学——**这正是模型无关的含义**。
 *
 * 窗口按 provider × model 分桶：两个模型的分数分布没有可比性，混在一个
 * 窗口里算分位数会得到一个两边都不对的阈值。
 *
 * ## 四档语义
 *
 *   自治  autonomous  0% 询问用户。只保留「直接拦下」（deny）——那不是打扰，
 *                      是安全边界。**唯一的例外**。
 *   轻松  relaxed    只有严重度排在最前的 1% 才询问用户。
 *   默认  default    按决策模型自己的判断提问（**当前的默认行为**，逐字不变）。
 *   谨慎  cautious   在默认判断之外，再把严重度靠前的 25% 也拿来询问。
 *
 * 三档之间是**单调**的（校准完成后）：1% ≤ 默认 ≤ 默认 ∪ 25%。自治是例外——
 * 它是「不打扰」，不是「按分位数」。
 *
 * ## 校准不足时怎么办
 *
 * 窗口里还没攒够样本时**算不出可靠的分位数**。此时不猜分位数，改用
 * `fallbackSeverity`——这几个绝对值是**在真实数据上量出来的典型分位数**
 * （见 DEC-035 的实测表），因此冷启动的行为与校准后的行为量级一致，不会
 * 出现「一开始问很多、攒够数据后突然变安静」这种跳变。
 *
 * 校准状态会显示在界面上（校准中 n/50），用户不会以为设置没生效。
 *
 * @module dsh-decision-engine/tolerance
 */

/** 四档的固定顺序（界面上的滑块从左到右也是这个顺序）。 */
export const TOLERANCE_LEVELS = ["autonomous", "relaxed", "default", "cautious"];

/** 默认档：`default` = 当前的默认行为（升级不改变行为）。 */
export const DEFAULT_TOLERANCE = "default";

/**
 * 滚动窗口容量（每个 provider × model 一份）。
 *
 * 取 200 的理由：分位数要稳，至少要几十个样本；200 个样本能让 P99 落在
 * 「最���的那一两个」之外（插值后是一个连续阈值），同时窗口不必大到让
 * 「最近」失去意义——用户改用模型后，几十次调用之内就该反映新分布。
 */
export const TOLERANCE_WINDOW_SIZE = 200;

/**
 * 校准「就绪」所需的最小样本数。
 *
 * 50 是折中：样本太少时 P99 只是「最大的那一条」，噪声大到会随机打扰用户；
 * 50 个样本时 P99 插值出来已经落在真实分布的尾部附近。
 */
export const TOLERANCE_MIN_SAMPLES = 50;

/**
 * 严重度的构成常量。
 *
 * ## 风险分：把三档的 choice 连续化
 *
 * 决策模型的 `choice` 只有 low/medium/high 三档，是**粗糙**的量化；同一次
 * 调用里，模型给出的 `probabilities`（high/medium/low 各多少）比 choice 细
 * 得多。用概率合成一个连续分数（`high + medium/2`），让同档内部也能分出
 * 轻重——这正是「按比例挑」所需要的信息：分位数只能区分**连续**分数。
 *
 * 没有 `probabilities` 时（部分自建服务不返回该字段）退回分类兜底值。
 *
 * ## 安全下限：保证最危险的那几条一定排在最前面
 *
 * 分位数是**相对**的：如果模型整体校准很差（所有分数都挤在 0.2 附近），
 * 「P99」可能落在一条平平无奇的调用上，而真正危险的那条反而在中间。
 *
 * 因此对两类**不容置疑**的情况设下限：
 *
 *   - 注入嫌疑达线（`injectionP ≥ 0.8`）→ 至少 0.90；
 *   - 判定为高风险（`choice === "high"`）→ 至少 0.70。
 *
 * 这两个下限让「最该被人看一眼的那几条」在任何分位数口径下都进得了最前面
 * 的那 1%。下限的值是刻意挑的：0.90 高于实测 P99（≈0.50），0.70 也高于它，
 * 于是它们必然落在最前 1% 内（实测 5/5 条危险样本全部命中）。
 */
const CATEGORICAL_RISK = { low: 0.1, medium: 0.5, high: 0.9 };

/** 注入嫌疑达到这个值就算「安全下限」档（与 `guardInjectionAskThreshold` 默认值一致）。 */
export const INJECTION_FLOOR_THRESHOLD = 0.8;

/** 注入嫌疑达线时的严重度下限。 */
export const INJECTION_FLOOR_SCORE = 0.9;

/** 判定为高风险时的严重度下限。 */
export const HIGH_RISK_FLOOR_SCORE = 0.7;

/**
 * 四档预设。
 *
 * `percentile` = 该档在窗口里的分位数（null = 不按分位数走）。
 * `fallbackSeverity` = 校准不足时用的绝对阈值。
 */
export const TOLERANCE_PRESETS = {
  autonomous: {
    id: "autonomous",
    label: "自治",
    labelEn: "Autonomous",
    summary: "从不询问用户；只有高风险调用会被直接拦下",
    summaryEn: "Never asks; only high-risk calls are blocked outright",
    percentile: null,
    // 自治档不走分位数路径，这里的值只是「让通用分支也不会触发」的占位。
    fallbackSeverity: Number.POSITIVE_INFINITY,
  },
  relaxed: {
    id: "relaxed",
    label: "轻松",
    labelEn: "Relaxed",
    summary: "只有严重度排在最前的 1% 才询问用户",
    summaryEn: "Only the top 1% by severity asks the user",
    percentile: 0.99,
    // 实测（1421 条真实授权决策，见 DEC-035）：severity ≥ 0.60 覆盖 0.47%
    // 的调用，与 P99 分位（≈0.50，覆盖 1.1%）在同一量级。冷启动时用它，
    // 行为与校准后一致，不会出现「一开始问一堆、攒够数据后突然变安静」。
    fallbackSeverity: 0.6,
  },
  default: {
    id: "default",
    label: "默认",
    labelEn: "Default",
    summary: "按决策模型自己的判断提问（当前的默认行为）",
    summaryEn: "Ask according to the decision model's own judgement (current behaviour)",
    percentile: null,
    fallbackSeverity: null,
  },
  cautious: {
    id: "cautious",
    label: "谨慎",
    labelEn: "Cautious",
    summary: "在默认判断之外，再把严重度靠前的 25% 也拿来询问",
    summaryEn: "Beyond the default judgement, also ask for the top 25% by severity",
    percentile: 0.75,
    // 实测：severity ≥ 0.30 覆盖 19.3% 的调用；P75 分位（≈0.28）覆盖 25.1%。
    // 兜底值取实测的中位口径，量级一致。
    fallbackSeverity: 0.3,
  },
};

/** 把任意值夹到 [0, 1]。 */
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * 算一次授权决策的**严重度**（0–1，越大越严重）。
 *
 * 三个分量取**最大**而不是加权求和：三个分量各自都是「独立成立的严重性」
 * （风险高 / 可能不可逆且与任务无关 / 疑似注入），其中任何一条成立都足以
 * 让人工审核。加权求和会让「注入 0.9 + 风险 0.05」被平均值稀释掉——
 * 而那恰恰是最该拦下来的一次。
 *
 * @param answers - 已通过 `extractGuardAnswers` 校验的答案。
 * @param options.injectionFloorThreshold - 注入嫌疑达线值；缺省 0.8。
 * @returns 严重度；输入不可用时返回 0。
 */
export function severityOf(answers, options = {}) {
  if (answers === null || typeof answers !== "object") return 0;
  const risk = answers.risk ?? {};
  const probabilities = risk.probabilities;
  let riskScore;
  if (
    probabilities !== null &&
    typeof probabilities === "object" &&
    Number.isFinite(probabilities.high) &&
    Number.isFinite(probabilities.medium)
  ) {
    riskScore = probabilities.high + 0.5 * probabilities.medium;
  } else {
    riskScore = CATEGORICAL_RISK[risk.choice] ?? 0.5;
  }
  // 「可能不可逆」只有在**与当前任务无关**时才值得打断人：模型自己都确信
  // 这个调用服务于任务时，它对不可逆的顾虑多半是模型对某类工具的惯性谨慎
  // （实测：普通 bash 命令的 irreversible 输出基线在 0.2–0.4）。
  const irrelevance = clamp01(answers.irreversibleP) * (1 - clamp01(answers.taskP));
  const injection = clamp01(answers.injectionP);
  let severity = Math.max(riskScore, irrelevance, injection);
  // 安全下限：让最危险的那几条在任何分位数口径下都排在最前面。
  const injectionFloor =
    Number.isFinite(options.injectionFloorThreshold)
      ? options.injectionFloorThreshold
      : INJECTION_FLOOR_THRESHOLD;
  if (injection >= injectionFloor) severity = Math.max(severity, INJECTION_FLOOR_SCORE);
  if (risk.choice === "high") severity = Math.max(severity, HIGH_RISK_FLOOR_SCORE);
  return clamp01(severity);
}

/**
 * 线性插值分位数（与 numpy 默认口径一致）。
 *
 * 为什么要插值而不是直接取第 k 个：P99 在 200 个样本上落在倒数第 2 与
 * 倒数第 1 之间，取整会让阈值在两次调用之间跳一整步，表现为「突然多问一次
 * 或突然不问」。插值把它变成连续阈值。
 *
 * @param sorted - **已排序**的数值数组。
 * @param q - 分位数（0–1）。
 * @returns 分位数值；数组为空时返回 null。
 */
export function quantileOf(sorted, q) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * 滚动校准器：按 provider × model 记住最近若干次严重度。
 *
 * 为什么分桶：两个决策模型的分数分布没有可比性。混在一个窗口里算分位数，
 * 得到的阈值对两个模型都不对（对高分模型偏松，对低分模型偏紧）。
 *
 * 纯内存：不落盘。理由是窗口的语义是「**最近**怎么说的」，落盘会把几天前
 * 的分布混进来，而模型与调用场景都可能已经变了。
 */
export class ToleranceCalibrator {
  /**
   * @param options.windowSize - 每个分桶保留多少个样本。
   * @param options.minSamples - 校准就绪所需的最小样本数。
   */
  constructor(options = {}) {
    this.windowSize = Number.isFinite(options.windowSize)
      ? Math.max(10, Math.floor(options.windowSize))
      : TOLERANCE_WINDOW_SIZE;
    this.minSamples = Number.isFinite(options.minSamples)
      ? Math.max(5, Math.floor(options.minSamples))
      : TOLERANCE_MIN_SAMPLES;
    /** `@type {Map<string, number[]>}` 分桶：键 = `provider::model`。 */
    this.buckets = new Map();
    /** 最近一次观察到的分桶键（状态回显用）。 */
    this.lastKey = "";
    /**
     * 分桶 → 有序副本的缓存，供 `threshold()` 复用（见 `sortedOf`）。
     * 键是分桶键，值是 `{ source, length, sorted }`；`observe()` 会删掉对应项。
     */
    this.sortedCache = new Map();
  }

  /** 分桶键。 */
  static keyOf(provider, model) {
    return `${String(provider ?? "unknown")}::${String(model ?? "unknown")}`;
  }

  /**
   * 记一次严重度。
   *
   * @param provider - 服务商 id。
   * @param model - 模型 id。
   * @param severity - 严重度（0–1）。
   */
  observe(provider, model, severity) {
    const value = clamp01(severity);
    const key = ToleranceCalibrator.keyOf(provider, model);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(value);
    // 窗口是「最近」的：超量就从最旧的开始丢。
    while (bucket.length > this.windowSize) bucket.shift();
    // 窗口变了，有序副本作废（见 `sortedOf`）。
    this.sortedCache.delete(key);
    this.lastKey = key;
  }

  /**
   * 某分桶的校准状态。
   *
   * @param provider - 服务商 id。
   * @param model - 模型 id。
   * @returns `{ samples, ready }`；分桶不存在时 samples = 0。
   */
  stats(provider, model) {
    const key = ToleranceCalibrator.keyOf(provider, model);
    const bucket = this.buckets.get(key);
    const samples = bucket === undefined ? 0 : bucket.length;
    return { samples, ready: samples >= this.minSamples };
  }

  /**
   * 某分桶在某分位数上的阈值。
   *
   * @param provider - 服务商 id。
   * @param model - 模型 id。
   * @param q - 分位数（0–1）。
   * @returns 阈值；样本不足时返回 null（调用方应改用 `fallbackSeverity`）。
   */
  threshold(provider, model, q) {
    const key = ToleranceCalibrator.keyOf(provider, model);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.length < this.minSamples) return null;
    return quantileOf(this.sortedOf(key, bucket), q);
  }

  /**
   * 取某分桶的**有序**副本。
   *
   * 为什么需要缓存：`threshold()` 在**每一次受守卫的决策**上都会被问一次
   * （算「这一档要问多频繁」），而它过去每次都要复制整个窗口再排序——
   * 窗口 200 条就是每次决策一次 200 元素排序。窗口只在 `observe()` 时变化，
   * 所以把有序副本连同「当时的长度」一起记住，`observe()` 一来就作废。
   *
   * 为什么用「长度 + 数组身份」当失效依据而不是脏标记：`buckets` 是公开字段
   * （测试与界面会直接读），外部可能整体替换或 push。用长度比对能覆盖 push
   * 与出窗，用数组身份比对能覆盖替换；两者都不依赖调用方守规矩。
   *
   * @param key - 分桶键。
   * @param bucket - 当前分桶数组。
   * @returns 升序数组（内部缓存，调用方只读）。
   */
  sortedOf(key, bucket) {
    const cached = this.sortedCache.get(key);
    if (cached !== undefined && cached.source === bucket && cached.length === bucket.length) {
      return cached.sorted;
    }
    const sorted = [...bucket].sort((a, b) => a - b);
    this.sortedCache.set(key, { source: bucket, length: bucket.length, sorted });
    return sorted;
  }

  /** 清空（配置变更或测试用）。 */
  reset() {
    this.buckets.clear();
    this.sortedCache.clear();
    this.lastKey = "";
  }
}

/**
 * 归一化一档配置。
 *
 * @param level - 档位 id。
 * @returns 预设对象；未知档位退回 `default`。
 */
export function tolerancePreset(level) {
  const id = TOLERANCE_LEVELS.includes(level) ? level : DEFAULT_TOLERANCE;
  return TOLERANCE_PRESETS[id];
}

/**
 * 按档位决定「这次要不要问用户」。
 *
 * 这个函数是**纯函数**：`cutoff` 由调用方算好传进来（校准器是有状态的，
 * 而裁决必须可测）。
 *
 * @param options.level - 档位 id。
 * @param options.legacyKind - 现有阈值算出的裁决（`delegate` / `ask` / `deny`）。
 * @param options.severity - 本次的严重度（0–1）。
 * @param options.cutoff - 该档的严重度阈值；null = 还没校准好。
 * @returns `{ kind, changed, severity, cutoff, note }`：
 *   - `kind`：最终裁决（`delegate` / `ask` / `deny`）；
 *   - `changed`：是否与 `legacyKind` 不同（用于审计与界面提示）；
 *   - `note`：改动原因（`changed` 为 true 时才有意义）。
 */
export function resolveTolerance(options = {}) {
  const preset = tolerancePreset(options.level);
  const severity = clamp01(options.severity);
  const legacyKind = options.legacyKind === "ask" || options.legacyKind === "deny"
    ? options.legacyKind
    : "delegate";

  // 拦截（deny）不是「打扰用户」，四档一律保留。
  //
  // 这条边界必须守住：自治档的语义是「不问我」，不是「什么都放行」。
  // deny 不会打断用户（它直接告诉模型「这次调用被拒了」），而把它一并
  // 取消等于让自治档变成「关掉安全检查」——那与用户说的「0% 询问」是两件事。
  if (legacyKind === "deny") {
    return { kind: "deny", changed: false, severity, cutoff: null, note: "" };
  }

  // 自治：从不询问。
  if (preset.id === "autonomous") {
    return legacyKind === "ask"
      ? {
          kind: "delegate",
          changed: true,
          severity,
          cutoff: null,
          note: `tolerance=autonomous（自治：不询问用户，severity=${severity.toFixed(3)}）`,
        }
      : { kind: "delegate", changed: false, severity, cutoff: null, note: "" };
  }

  // 默认档：完全走现有阈值，逐字不变。
  if (preset.id === "default") {
    return { kind: legacyKind, changed: false, severity, cutoff: null, note: "" };
  }

  // 轻松 / 谨慎：按分位数带。
  const cutoff = Number.isFinite(options.cutoff)
    ? clamp01(options.cutoff)
    : preset.fallbackSeverity;

  if (preset.id === "relaxed") {
    // 轻松档**替换**默认判断，而不是叠加在它上面——否则「top 1%」会变成
    // 「top 1% ∪ 默认判断」，实测那是 23% 的打扰率，与档位语义不符。
    if (severity >= cutoff) {
      return {
        kind: "ask",
        changed: legacyKind !== "ask",
        severity,
        cutoff,
        note: `tolerance=relaxed（严重度 ${severity.toFixed(3)} ≥ ${cutoff.toFixed(3)}，属最前的 1%）`,
      };
    }
    return legacyKind === "ask"
      ? {
          kind: "delegate",
          changed: true,
          severity,
          cutoff,
          note: `tolerance=relaxed（严重度 ${severity.toFixed(3)} < ${cutoff.toFixed(3)}，不在最前的 1%）`,
        }
      : { kind: "delegate", changed: false, severity, cutoff, note: "" };
  }

  // 谨慎档：默认判断 ∪ 严重度靠前的 25%（**叠加**，因此一定 ≥ 默认）。
  if (legacyKind === "ask" || severity >= cutoff) {
    return {
      kind: "ask",
      changed: legacyKind !== "ask",
      severity,
      cutoff,
      note:
        legacyKind === "ask"
          ? `tolerance=cautious（默认判断已升级询问）`
          : `tolerance=cautious（严重度 ${severity.toFixed(3)} ≥ ${cutoff.toFixed(3)}，属最前的 25%）`,
    };
  }
  return { kind: "delegate", changed: false, severity, cutoff, note: "" };
}

/**
 * 算一档该用的严重度阈值。
 *
 * @param options.level - 档位 id。
 * @param options.calibrator - 校准器（可为 undefined）。
 * @param options.provider - 服务商 id。
 * @param options.model - 模型 id。
 * @returns `{ cutoff, ready, samples }`：`cutoff` 为 null 表示「该档不按分位数走」
 *   或「还没校准好」（调用方据此改用 `fallbackSeverity`）。
 */
export function toleranceCutoff(options = {}) {
  const preset = tolerancePreset(options.level);
  if (preset.percentile === null) {
    return { cutoff: null, ready: true, samples: 0 };
  }
  const stats = options.calibrator?.stats(options.provider, options.model) ?? {
    samples: 0,
    ready: false,
  };
  if (!stats.ready) {
    return { cutoff: null, ready: false, samples: stats.samples };
  }
  const threshold = options.calibrator.threshold(options.provider, options.model, preset.percentile);
  return {
    cutoff: Number.isFinite(threshold) ? threshold : null,
    ready: true,
    samples: stats.samples,
  };
}
