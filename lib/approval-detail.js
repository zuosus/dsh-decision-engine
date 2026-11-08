/**
 * 审批卡正文那块命令的可读化：**把一条 shell 命令拆成能读的几条**。
 *
 * ## 为什么需要这个模块
 *
 * 宿主审批卡（`conversation.approval.detail`）只把 `args.command` 原文原样
 * 放进一个等宽字体块里，样式是 `word-break: break-all` 且**没有**
 * `white-space: pre-wrap`——换行全被折叠。于是一条十几行的 `python3 - <<'PY'`
 * 会把整张卡撑成一坨既不分行、也看不出在干什么的墙。
 *
 * 我们接管那个 slot 之后就能自己渲染，但「能读」不等于「格式化好看」：
 * 用户真正想知道的是**这条命令都做了哪些事、其中哪些是危险动作**。
 * 决策端点只有 choice / score / noul 三种题型、没有自由文本，所以这件事
 * 不能交给小模型，只能在这里用**确定性**的切分规则做。
 *
 * ## 设计上的三条原则
 *
 * 1. **绝不改写原文**：摘要只是「在原文之上加一层导读」，原文必须能原样展开
 *    看到。用户按「允许」之后真正执行的是原文，摘要与原文不一致就是欺骗。
 * 2. **宁可少说，不要乱说**：切分只看确定的结构（换行、`;`、`&&`、`||`、
 *    管道、heredoc 包裹），猜不到的一律不猜。识别不出的部分归到最后一段，
 *    而不是假装它是某条命令。
 * 3. **纯函数**：不发请求、不读文件、不碰 DOM。所以它能在 Node 里单测，
 *    也能被 client bundle 直接引用。
 *
 * @module dsh-decision-engine/approval-detail
 */

/** 一条命令最多列几条摘要；超出的合并成「还有 N 条」。 */
export const MAX_SUMMARY_STEPS = 12;

/** 每条摘要最多显示多少个字符，超出截断。 */
export const MAX_STEP_CHARS = 72;

/**
 * 危险动作的识别规则：命中即给该条摘要标一个警示级别。
 *
 * 这些判断刻意**粗**——它们是提示，不是判据。真正的拦截在守卫的
 * `decideGuard()` 里，这里只负责让用户一眼看到「这条命令里有 rm -rf」。
 *
 * 顺序有意义：先匹配更高危的规则，同一条命令只取最严重的那级。
 */
const DANGER_RULES = [
  {
    // 递归删除、强删、磁盘级写：破坏性最强。
    level: "high",
    pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$\w+|\*)/,
  },
  { level: "high", pattern: /\b(?:mkfs|dd\s+if=|>\/dev\/sd)\b/ },
  { level: "high", pattern: /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/ },
  // 把远端内容直接交给 shell 执行：等价于执行任意代码。
  { level: "high", pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi)?sh\b/ },
  // 提权。
  { level: "medium", pattern: /\bsudo\b/ },
  // 覆盖面大的批量移动 / 删除。
  { level: "medium", pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/ },
  { level: "medium", pattern: /\bmv\s+.*\s+(?:\/|~)(?:\s|$)/ },
  // 进程 / 服务级改动。
  { level: "medium", pattern: /\b(?:kill|killall|pkill|shutdown|reboot)\b/ },
  // 会改仓库/系统状态、但不是破坏性的。
  { level: "low", pattern: /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-zA-Z]*f)\b/ },
  { level: "low", pattern: /\b(?:pip|npm|pnpm|yarn|cargo|gem|brew)\s+(?:install|add|uninstall|remove)\b/ },
  { level: "low", pattern: /\b(?:apt|apt-get|yum|dnf|apk)\s+(?:install|remove|update|upgrade)\b/ },
];

/**
 * 危险级别的排序权重（数字越大越严重）。
 * @param level - 级别 id。
 * @returns 权重。
 */
function dangerWeight(level) {
  if (level === "high") return 3;
  if (level === "medium") return 2;
  if (level === "low") return 1;
  return 0;
}

/**
 * 判断一条命令片段的危险级别。
 * @param text - 单条命令片段。
 * @returns 最严重的级别 id，或 null（没命中任何规则）。
 */
export function dangerLevelOf(text) {
  const value = typeof text === "string" ? text : "";
  let worst = null;
  for (const rule of DANGER_RULES) {
    if (rule.pattern.test(value) && dangerWeight(rule.level) > dangerWeight(worst)) {
      worst = rule.level;
    }
  }
  return worst;
}

/**
 * 压成一行：把连续空白折叠成单个空格，去掉首尾空白。
 * @param text - 任意文本。
 * @returns 单行文本。
 */
function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把一段超长文本截断到 `MAX_STEP_CHARS`。
 * @param text - 单行文本。
 * @returns 截断后的文本。
 */
function clip(text) {
  if (text.length <= MAX_STEP_CHARS) return text;
  return `${text.slice(0, MAX_STEP_CHARS - 1)}…`;
}

/**
 * 找出「被包裹起来的整段脚本」：heredoc、`python3 -c "…"`、引号内的长字符串。
 *
 * 这类命令的重点不是它内部的语法，而是**它在执行一段多行脚本**——所以摘要
 * 应该说「执行 python 脚本（N 行）」，而不是把脚本正文当成几条命令切开。
 *
 * @param command - 原始命令。
 * @returns `{kind, lines}`，不是整段脚本时返回 null。
 */
function wrappedScriptOf(command) {
  // heredoc：`<<'PY'` / `<<-"EOF"` 等，正文在下一个分隔符行之间。
  const heredoc = command.match(/<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
  if (heredoc !== null) {
    const marker = heredoc[2];
    const bodyStart = command.indexOf("\n", heredoc.index);
    const bodyEnd = bodyStart < 0 ? -1 : command.indexOf(marker, bodyStart);
    const body = bodyStart < 0 ? "" : command.slice(bodyStart, bodyEnd < 0 ? undefined : bodyEnd);
    const lines = body.split("\n").filter((line) => line.trim().length > 0).length;
    return { kind: "heredoc", lines };
  }
  // 单行的 `python3 -c "…"` / `sh -c "…"`：也算「执行一段脚本文本」。
  if (/\b(?:python[0-9.]*|node|ruby|perl|sh|bash|zsh)\s+-[cce]\b/.test(command) && command.includes("\n")) {
    const lines = command.split("\n").filter((line) => line.trim().length > 0).length;
    return { kind: "inline-script", lines };
  }
  return null;
}

/**
 * 把一条 shell 命令切成若干「步骤」。
 *
 * 切分只看**确定的分隔符**：换行、`;`、`&&`、`||`、`|`。引号与括号内部
 * 的分隔符不切（否则 `echo "a; b"` 会被错误地拆成两条）。heredoc 的正文
 * 整段保留，因为它是同一个命令的输入——但**摘要里只留它的开头一行**：
 * 「python3 - <<'PY'」本身已经说明了一切，把那 4 行脚本正文压缩进一条摘要
 * 只会重新变成一坨不可读的东西（正文在展开态里照原样显示）。
 *
 * 刻意**不**做完整的 shell 解析：真正的解析要处理转义、变量展开、子 shell、
 * 函数定义……那是一整个 parser 的工作量，而这里只需要一个「大致看清有几步」
 * 的导读。切不准时宁可把剩余部分并成一条。
 *
 * @param command - 原始命令文本。
 * @returns 步骤数组：`{text, line}`，line 是它大致来自第几行（1 起）。
 */
export function stepsOf(command) {
  const source = typeof command === "string" ? command : "";
  if (source.trim().length === 0) return [];

  const steps = [];
  let buffer = "";
  let line = 1;
  let bufferLine = 1;
  // 引号状态：单引号、双引号各一个开关；heredoc 另算（见下）。
  let inSingle = false;
  let inDouble = false;
  let heredocMarker = null;
  /** heredoc 命中时，它开头那一行的文本（摘要要留这一行）。 */
  let heredocHeader = "";

  const flush = () => {
    const text = oneLine(buffer);
    if (text.length > 0) steps.push({ text, line: bufferLine });
    buffer = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    // heredoc：从命中 `<<'X'` 到分隔符行，整段不切。
    if (heredocMarker === null) {
      const rest = source.slice(index);
      const heredocMatch = rest.match(/^<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (heredocMatch !== null && !inSingle && !inDouble) {
        heredocMarker = heredocMatch[2];
        // 记下「本步骤到 heredoc 标记为止」的文本作为摘要；正文丢掉。
        buffer += heredocMatch[0];
        heredocHeader = buffer;
        index += heredocMatch[0].length - 1;
        continue;
      }
    } else {
      if (char === "\n") {
        line += 1;
        // 日分隔符单独成行才算结束。
        const lineEnd = source.indexOf("\n", index + 1);
        const currentLine = source.slice(index + 1, lineEnd < 0 ? undefined : lineEnd).trim();
        if (currentLine === heredocMarker) {
          // 整段脚本结束：把「开头一行」作为这一步的摘要，正文不进去。
          buffer = heredocHeader;
          heredocMarker = null;
          heredocHeader = "";
          flush();
          // 跳过正文与分隔符行，避免它们进入下一步骤。
          index = lineEnd < 0 ? source.length - 1 : lineEnd - 1;
          bufferLine = line;
          continue;
        }
      }
      // 正文一律不写进 buffer（它由 summarizedCommand 的 script.lines 计数）。
      continue;
    }

    if (char === "\n") {
      flush();
      line += 1;
      bufferLine = line;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      buffer += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      buffer += char;
      continue;
    }
    // 只在引号外切分。`;` 与 `&&` / `||` / `|` 都是步骤边界。
    if (!inSingle && !inDouble) {
      const isPipeline = char === "|" && next === "|";
      const isAnd = char === "&" && next === "&";
      const isPipe = char === "|" && !isPipeline;
      if ((char === ";" || isAnd || isPipeline || isPipe) && buffer.trim().length > 0) {
        flush();
        if (isAnd || isPipeline) index += 1;
        bufferLine = line;
        continue;
      }
      // 开头就是分隔符（例如 `; ls`）时丢掉它，不要产生空步骤。
      if (char === ";" || isAnd || isPipeline || isPipe) continue;
    }
    buffer += char;
  }
  // 收尾：heredoc 没找到结束标记时（命令被截断），把开头一行留下。
  if (heredocMarker !== null) buffer = heredocHeader;
  flush();
  return steps;
}

/**
 * 归纳一条命令：步骤清单 + 危险标记 + 是否整段脚本。
 *
 * 危险级别算**两次**：一次对整条原文（`danger`），一次对每个步骤（`steps[].danger`）。
 * 为什么不能只算步骤：像 `curl https://x.sh | sh` 这种「把远端脚本喂给 shell」的
 * 形态，切分后会变成 `curl https://x.sh` 与 `sh` 两条，单独看哪条都无害——
 * 危险恰恰在它们的**组合**里。所以整条原文必须单独过一遍规则。
 *
 * @param command - 原始命令文本。
 * @returns `{steps, script, danger, total, truncated, lines, dangerCount}`：
 *   - `steps`：`{text, line, danger}` 数组（已按 MAX_SUMMARY_STEPS 截断）；
 *   - `script`：整段脚本的识别结果（`{kind, lines}` 或 null）——它决定标题怎么措辞；
 *   - `danger`：**整条命令**最严重的危险级别（null = 没命中任何规则）；
 *   - `total`：切出来的总步骤数（未截断前）；
 *   - `truncated`：是否因为条数上限被截断；
 *   - `lines`：原文行数；
 *   - `dangerCount`：带危险标记的步骤数（整条命中而步骤都没命中时至少为 1）。
 */
export function summarizeCommand(command) {
  const source = typeof command === "string" ? command : "";
  const script = wrappedScriptOf(source);
  const raw = stepsOf(source);
  const total = raw.length;
  const kept = raw.slice(0, MAX_SUMMARY_STEPS);
  const steps = kept.map((step) => ({
    text: clip(step.text),
    line: step.line,
    danger: dangerLevelOf(step.text),
  }));
  const danger = dangerLevelOf(source);
  const flagged = steps.filter((step) => step.danger !== null).length;
  return {
    steps,
    script,
    danger,
    total,
    truncated: total > MAX_SUMMARY_STEPS,
    lines: source.split("\n").length,
    dangerCount: flagged === 0 && danger !== null ? 1 : flagged,
  };
}

/**
 * 把归纳结果压成一行给人看的摘要（纯文本，不渲染）。
 *
 * 为什么除了 React 组件还要有这一份：**同一个「这条命令在干什么」的判断
 * 应该只有一处措辞**。组件把结构画出来，这里给出它的文字形式——测试对着
 * 这一行断言，比对着 React 树断言稳得多；以后加日志或遥测也直接用它。
 *
 * @param command - 原始命令文本。
 * @param wordings - 该语言的词句表；缺省用中文。
 * @returns 一行摘要文本。
 */
export function summaryLine(command, wordings = {}) {
  const w = {
    empty: "（空命令）",
    steps: (n) => `${n} 个步骤`,
    script: (kind, lines) => (kind === "heredoc" ? `执行一段脚本（${lines} 行）` : `执行一段内联脚本（${lines} 行）`),
    danger: (n) => `含 ${n} 个危险动作`,
    truncated: (n) => `另有 ${n} 个步骤未展开`,
    ...wordings,
  };
  const result = summarizeCommand(command);
  if (result.total === 0 && result.script === null) return w.empty;
  const parts = [];
  parts.push(result.script === null ? w.steps(result.total) : w.script(result.script.kind, result.script.lines));
  if (result.danger !== null) parts.push(w.danger(result.dangerCount));
  if (result.truncated) parts.push(w.truncated(result.total - MAX_SUMMARY_STEPS));
  return parts.join(" · ");
}
