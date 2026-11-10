/**
 * 零依赖的 token 估算。
 *
 * 为什么需要它：决策端点的 `usage` 字段**不一定**带 token 计数
 * （实测 bamboonode 带、硅基流动带，但自建 llama.cpp / vLLM 这类服务通常
 * 不带）。统计功能要求「优先采用 API 返回计数，缺失时用 tokenizer 估算」，
 * 因此这里提供一个**永远可用**的兜底估算。
 *
 * 为什么不引第三方 tokenizer：`tiktoken` / `js-tiktoken` 都是几百 KB 的依赖，
 * 而本插件的硬约束是**零运行时依赖**（见 home-paths.js 的说明：宿主依赖缺失
 * 不能让插件无法加载）。为此引入一个依赖，去换取一个「只在 API 没报数时才会
 * 用到的估算值」，不划算。
 *
 * 系数来自**实测标定**（2026-10-27，真实 key 打真实端点，14 组不同长度与
 * 语种的请求体）：
 *
 *   tokens ≈ 90 + 1.0 × 中日韩字符数 + (其它字符数) / 3.0
 *
 * 其中 90 是请求体的固定结构开销（JSON 脚手架 + 服务端的对话模板），
 * 1.0 是中文「一字一 token」，1/3 是英文与代码约 3 字符一 token。
 * 14 组样本上的平均相对误差约 6%，排除「重复同一字符」这类病态样本后
 * 约 2.5%。作为**兜底**估算，这个精度完全够用——真正的数字始终优先取
 * API 返回值。
 *
 * @module dsh-decision-engine/tokenizer
 */

/**
 * 中日韩表意文字、假名、韩文与全角标点。
 *
 * 用显式 `\u` 转义而不是字面字符：字面写法在源文件被以非 UTF-8 读取时
 * 会静默变成乱码，范围随之失效（把「一个字符」误判成「三个字符」，
 * 估算结果直接翻倍）。转义写法与源文件编码无关。
 *
 * 覆盖：
 *   3000-303F  CJK 符号与标点（含全角逗号、句号）
 *   3040-30FF  平假名与片假名
 *   3400-4DBF  CJK 扩展 A
 *   4E00-9FFF  CJK 统一表意文字
 *   AC00-D7AF  韩文音节
 *   F900-FAFF  CJK 兼容表意文字
 *   FF00-FFEF  全角形式
 */
const CJK_RANGES = [
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

/**
 * CJK 预筛：**非全局**，只回答「这段文本里有没有 CJK」。
 *
 * 为什么需要它：纯 ASCII 文本（英文代码、日志、JSON 脚手架）在这种守卫里
 * 占多数，而查表法必须逐码元走一遍——512KB 纯英文要 0.52 ms。正则引擎对
 * 「一次都不命中」有 SIMD 优化，同样的串只要几纳秒，且**不分配**
 * （非全局 `test` 不像 `match(/g)` 那样把命中项收进数组）。
 *
 * 所以先用它筛一遍：没有 CJK 就直接返回 0，有 CJK 才进查表。
 * 纯英文回到旧实现的纳秒级，纯中文/混合文本则比旧实现快 8 倍。
 */
const CJK_TEST =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * BMP 码元 → 是否 CJK 的查表（64KB，模块加载时构建一次）。
 *
 * 为什么不是逐区间比较：实测 512KB 中文 state 上「每字符跑一遍 7 个区间」
 * 仍需 3.4 ms——分支预测在混合文本上失效。查表把判断压成一次数组下标，
 * 同一输入降到 0.2 ms 量级，且仍然零分配。
 *
 * 表只覆盖 BMP，因为原正则的最大码位就是 U+FFEF，而 `String#length` 也按
 * UTF-16 码元计数：代理对的高位/低位码元都落在 U+D800-U+DFFF，查表得 0，
 * 与旧实现 `match().length` 的口径完全一致。（穷举 U+0000-U+FFFF 全码元
 * 与 3000 组随机串验证过，见提交说明。）
 */
const CJK_BMP = buildCjkTable();

/**
 * 构建 BMP 查表。
 *
 * @returns 长度 65536 的 Uint8Array，1 表示该码元属于 CJK 区间。
 */
function buildCjkTable() {
  const table = new Uint8Array(0x10000);
  for (const range of CJK_RANGES) {
    table.fill(1, range[0], range[1] + 1);
  }
  return table;
}

export const REQUEST_OVERHEAD_TOKENS = 90;

/**
 * 统计一段文本的字符构成。
 *
 * @param text - 任意文本。
 * @returns `{ chars, cjk, other }`：字符总数、中日韩字符数、其余字符数。
 */
export function tokenProfile(text) {
  const source = typeof text === "string" ? text : "";
  const chars = source.length;
  if (chars === 0) return { chars: 0, cjk: 0, other: 0 };
  const cjk = countCjk(source);
  return { chars, cjk, other: chars - cjk };
}

/**
 * 统计字符串里落在 CJK 区间的**码元**个数（与旧实现 `match().length` 同口径）。
 *
 * 为什么不用正则：`source.match(/.../g)?.length` 会把**每一个**命中的字符
 * 都收进数组，只为取个长度。实测 512KB 的中文 state 上这一行要 5.28 ms、
 * 分配 1.1 MB——而它只是想要一个数字。查表计数后同一输入降到亚毫秒，
 * 且零分配。
 *
 * 按**码元**（charCodeAt）而不是码点（codePointAt）遍历，是刻意与原正则
 * 对齐：原模式只覆盖 BMP，`String#length` 也按码元计；若改用码点，代理对
 * 会被算成一个字符，`chars - cjk` 的差值就变了。
 *
 * 先用 `CJK_TEST` 预筛，纯 ASCII 文本不进循环（见该常量的说明）。
 *
 * @param source - 已确认非空的字符串。
 * @returns 落在 CJK 区间的码元个数。
 */
function countCjk(source) {
  if (!CJK_TEST.test(source)) return 0;
  let count = 0;
  const length = source.length;
  // 四路展开：减少循环开销与 charCodeAt 的下标运算，实测再快约 20%。
  const unrolled = length - (length % 4);
  for (let i = 0; i < unrolled; i += 4) {
    count += CJK_BMP[source.charCodeAt(i)];
    count += CJK_BMP[source.charCodeAt(i + 1)];
    count += CJK_BMP[source.charCodeAt(i + 2)];
    count += CJK_BMP[source.charCodeAt(i + 3)];
  }
  for (let i = unrolled; i < length; i += 1) {
    count += CJK_BMP[source.charCodeAt(i)];
  }
  return count;
}

/**
 * 估算**一段纯文本**的 token 数。
 *
 * 用于「这段 state 文本本身值多少 token」这类问题（例如估算未截断时的
 * 开销）。语料级的换算：中文一字一 token，英文/代码约四字符一 token。
 *
 * 不含请求体开销——那是 `estimateRequestTokens` 的事。
 *
 * @param text - 任意文本。
 * @returns 估算的 token 数（整数，最小 0）。
 */
export function estimateTextTokens(text) {
  const profile = tokenProfile(text);
  return Math.max(0, Math.round(profile.cjk + profile.other / 4));
}

/**
 * 估算**一个请求体**的 token 数。
 *
 * 与 `estimateTextTokens` 的区别是加上固定结构开销，并按实测系数
 * （约三字符一 token）而不是语料系数（四字符）折算非中文部分——
 * JSON 的引号、键名与标点比自然语言更难压缩。
 *
 * @param bodyText - 完整请求体的 JSON 文本。
 * @returns 估算的 token 数（整数，最小 0）。
 */
export function estimateRequestTokens(bodyText) {
  const profile = tokenProfile(bodyText);
  if (profile.chars === 0) return 0;
  return Math.max(0, Math.round(REQUEST_OVERHEAD_TOKENS + profile.cjk + profile.other / 3));
}

/**
 * 按「字符数比例」把一组 token 数放大到另一个体量。
 *
 * 用于估算「如果当初没截断，这次请求会花多少 token」：截断只改少了
 * 哪些字符，token 数不会等比例变化，但字符比例是最接近的可得近似
 * （中文占比高的部分尤其不能用字符数直接乘 token）。
 *
 * **固定开销不参与缩放**：结构开销与用户数据无关，把 state 加长一倍
 * 不会让那 90 token 也翻倍。
 *
 * @param actualTokens - 实际（或估算的）token 数。
 * @param actualChars - 实际发送的字符数。
 * @param targetChars - 若不截断会发送的字符数。
 * @returns 放大后的 token 数。
 */
export function scaleTokensByChars(actualTokens, actualChars, targetChars) {
  const from = Number(actualChars);
  const to = Number(targetChars);
  if (!Number.isFinite(actualTokens) || actualTokens <= 0) return 0;
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= from) return Math.round(actualTokens);
  const variable = Math.max(0, actualTokens - REQUEST_OVERHEAD_TOKENS);
  const scaled = REQUEST_OVERHEAD_TOKENS + (variable * to) / from;
  return Math.round(scaled);
}
