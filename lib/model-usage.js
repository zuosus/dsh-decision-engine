/**
 * 匿名统计的 provider × model 明细（DEC-096）。
 *
 * 为什么单独一个模块：这段逻辑要同时给「上报体构造」和「测试」用，而它
 * 有一条容易被悄悄改坏的隐私边界——只上报**非免费**模型的服务商与模型名，
 * 且只有次数，没有 token / 耗时 / prompt。纯函数放在这里，测试可以直接
 * 断言；任何被拒的行都静默跳过，绝不因此拖住匿名统计。
 *
 * @module dsh-decision-engine/model-usage
 */

/** 服务端下发的免费模型 provider id（与 providers.js 的 SERVER_PROVIDER_ID 一致）。 */
export const FREE_PROVIDER_ID = "server";

/** 无法归因的 provider id（stats.js 的默认值）。 */
const UNKNOWN_PROVIDER_ID = "unknown";

/** 上报体里最多带几组 provider×model：防止自定义模型名把心跳撑大。 */
export const MAX_MODEL_PAIRS = 12;

/** 单个字段的最大长度：与站点侧的 MAX_FIELD=32 对齐。 */
const MAX_FIELD = 32;

/** provider / model 都走同一套清洗：只留可安全展示的短标识。 */
function cleanName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^0-9A-Za-z._:/+-]/g, "")
    .slice(0, MAX_FIELD);
}

/** 次数：非法值丢弃，合法值截断（与 buildPayload 的 d 字段同口径）。 */
function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 100000) : 0;
}

/**
 * 把 stats.js 的 byCombo 行转成上报用的 `[provider, model, requests][]`。
 *
 * 排除三类行：
 *   1. `server` —— 服务端下发的免费模型，用户明确要求「非免费模型」；
 *   2. `unknown` —— 归因失败，上报只会污染排行；
 *   3. 次数为 0 / 模型名为空 —— 没有可统计的事。
 *
 * 排序按次数降序、provider/model 升序，保证同一天多次上报得到同一份数据。
 *
 * @param rows - `aggregate().rows`，形如 `{ provider, model, requests }`。
 * @returns 清洗后的三元组数组，最多 MAX_MODEL_PAIRS 条。
 */
export function normalizeModelPairs(rows) {
  if (!Array.isArray(rows)) return [];
  const pairs = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const provider = cleanName(row.provider);
    const model = cleanName(row.model);
    const count = countOf(row.requests);
    if (provider.length === 0 || model.length === 0 || count === 0) continue;
    if (provider === FREE_PROVIDER_ID || provider === UNKNOWN_PROVIDER_ID) continue;
    pairs.push([provider, model, count]);
  }
  pairs.sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return pairs.slice(0, MAX_MODEL_PAIRS);
}

/**
 * 构造上报体里的 pm 字段。没有可上报的明细时返回 undefined，
 * 由调用方 `buildPayload` 整字段省略——空数组不发送。
 *
 * @param rows - `aggregate().rows`。
 * @returns `[provider, model, count][]` 或 undefined。
 */
export function buildModelUsagePayload(rows) {
  const pairs = normalizeModelPairs(rows);
  return pairs.length > 0 ? pairs : undefined;
}
