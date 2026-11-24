/**
 * 一次性切分脚本：把 lib/client.js 按行区间切成 lib/client-src/*.js。
 *
 * 只跑一次（拆分当时用），不作为常规构建步骤。产物由
 * `scripts/build-client.mjs` 重新拼回 `lib/client.js`，且拼接结果必须与
 * 切分前的文件**逐字节相同**——这是「拆分没有改变任何行为」的最强证据。
 *
 * ⚠️ **不要再跑它**。现在 `lib/client.js` 是构建产物，而分片里有几处刻意
 * 留下的「构建期覆盖」占位（CONFIG CONTROLS 与 CFG_SECTION_CSS 的正文）：
 * 从这里重新切分会把产物里的**展开副本**写回分片，两份实现随即漂移，而且
 * 因为构建期又会覆盖它们，改了分片里的副本不会有任何效果——正是最难查的
 * 那种静默失效。脚本保留在仓库里只是作为「原文件 → 分片表」的存档。
 *
 * 用法（仅存档参考）：node scripts/split-client-once.mjs --force
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 分片表：`[大致起始行, 文件名]`，按原文件顺序排列。
 *
 * 起始行只是**锚点**：脚本会把它吸附到最近的「干净边界」（缩进 4 或 6 的
 * 声明/键，或注释块开头，且上一行是空行或块结束大括号），所以主分支上代码
 * 上下挪几行不会让切分点落进表达式中间。真正的硬保证是末尾的逐字节断言。
 */
const ANCHORS = [
  [1, "01-header.js"],
  [49, "02-i18n-config-dictionary.js"],
  [214, "03-i18n-stats-dictionary.js"],
  [292, "04-i18n-misc-dictionary.js"],
  [374, "05-i18n-label-dictionary.js"],
  [475, "06-i18n-template-dictionary.js"],
  [587, "07-i18n-runtime.js"],
  [807, "08-style-injection.js"],
  [1141, "09-charts-loader.js"],
  [1258, "10-styles-shell-and-controls.js"],
  [1522, "11-styles-points-and-charts.js"],
  [1749, "12-styles-decisions-and-stats.js"],
  [2019, "13-styles-approval.js"],
  [2128, "14-approval-detail-rules.js"],
  [2438, "15-config-values-and-url.js"],
  [2720, "16-config-patch-and-format.js"],
  [2937, "17-decision-table.js"],
  [3177, "18-approval-detail-view.js"],
  [3329, "19-decisions-view-state.js"],
  [3525, "20-decisions-view-rows.js"],
  [3734, "21-decisions-view-render.js"],
  [3865, "22-chart-geometry.js"],
  [4080, "23-chart-render-basic.js"],
  [4336, "24-chart-render-ranking.js"],
  [4667, "25-chart-render-savings.js"],
  [4829, "26-stats-tab-props.js"],
  [5175, "27-stats-tab-trend.js"],
  [5309, "28-stats-tab-verdicts.js"],
  [5626, "29-stats-tab-breakdown.js"],
  [5774, "30-config-sections-meta.js"],
  [5903, "31-config-page-state.js"],
  [6245, "32-config-page-save.js"],
  [6630, "33-config-page-actions.js"],
  [7020, "34-config-page-connection-items.js"],
  [7442, "35-config-page-guard-items.js"],
  [7616, "36-config-page-record-items.js"],
  [7700, "37-config-page-model-items.js"],
  [7869, "38-config-page-render.js"],
  [8032, "39-plugin-registration.js"],
];

const CLIENT_URL = new URL("../lib/client.js", import.meta.url);
const SRC_DIR = new URL("../lib/client-src/", import.meta.url);

// 硬性拦截：分片已存在就说明拆分完成了，再切一次会毁掉占位约定。
if (!process.argv.includes("--force")) {
  try {
    readdirSync(fileURLToPath(SRC_DIR));
    throw new Error(
      "lib/client-src/ 已存在：拆分已完成，不要重跑本脚本（会覆盖占位注释）。确需重做请加 --force。",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const source = readFileSync(CLIENT_URL, "utf8");
const lines = source.split("\n");
// `split` 会把结尾换行切成一个空串；它属于最后一行的换行，不是第 N+1 行。
const lastLine = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

/** 上一行是否「元素结束」——切分点落在它下面才安全。 */
const endsBlock = (line) => {
  const text = line.trim();
  return text === "" || text === "}" || text.endsWith("*/") || text === "});" || text === "];";
};

/** 是否是干净的起点：注释块开头，或 4/6 空格缩进的声明 / 对象键。 */
const startsClean = (line) => {
  const text = line.trim();
  if (text === "") return false;
  if (text.startsWith("/**") || text.startsWith("/*") || text.startsWith("//")) return true;
  return /^(?:const|let|var|async function|function|class)\s|^[A-Za-z_$][\w$]*\s*:/.test(text);
};

/**
 * 把锚点吸附到最近的边界。
 *
 * 两档，因为「能切」和「好读」是两件事：
 *
 *   - **纯连接永远无损**：分片是行区间的分割，拼回来逐字节相同，所以任何行
 *     边界都不丢字节（末尾有断言兜底）。切分点的唯一风险是「落到表达式中间
 *     导致人看不懂这一段是什么」。
 *   - 因此先找 **语句级干净的边界**（声明/键/注释块开头，且上一行是块结束）；
 *     找不到再退到 **注释行开头**——大段 JSX 返回体的自然分隔就是编号注释
 *     （`// 4.4) 走势…`），在那里切既安全又可读。
 */
function snap(anchor) {
  if (anchor <= 1) return 1;
  const tidy = (line) => startsClean(lines[line - 1]) && endsBlock(lines[line - 2] ?? "");
  const comment = (line) => {
    const text = lines[line - 1]?.trim() ?? "";
    return text.startsWith("//") || text.startsWith("/**") || text.startsWith("/*");
  };
  for (const accept of [tidy, comment]) {
    for (let delta = 0; delta <= 10; delta += 1) {
      for (const line of [anchor + delta, anchor - delta]) {
        if (line < 2 || line > lines.length) continue;
        if (accept(line)) return line;
      }
    }
  }
  throw new Error(`锚点 ${anchor} 附近找不到可读的边界，请手工确认`);
}

const starts = ANCHORS.map(([anchor]) => snap(anchor));
for (let index = 1; index < starts.length; index += 1) {
  if (starts[index] <= starts[index - 1]) {
    throw new Error(`切分点必须严格递增：${starts[index - 1]} → ${starts[index]}`);
  }
}

mkdirSync(fileURLToPath(SRC_DIR), { recursive: true });
const pieces = [];
for (let index = 0; index < ANCHORS.length; index += 1) {
  const from = starts[index];
  const to = index + 1 < starts.length ? starts[index + 1] - 1 : lastLine;
  const body = `${lines.slice(from - 1, to).join("\n")}\n`;
  pieces.push(body);
  const name = ANCHORS[index][1];
  writeFileSync(new URL(name, SRC_DIR), body);
  console.log(`${String(from).padStart(5)}..${String(to).padStart(5)}  ${name}`);
}

const rebuilt = pieces.join("");
if (rebuilt !== source) {
  let at = 0;
  while (at < rebuilt.length && rebuilt[at] === source[at]) at += 1;
  throw new Error(`切分后拼回与原文不一致，首个差异位置：${at}`);
}
console.log(`\n已写出 ${ANCHORS.length} 个分片；拼回与原文逐字节一致（${source.length} 字节）`);
