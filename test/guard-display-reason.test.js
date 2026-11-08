/**
 * ask 裁决的审批卡文案：审计原文（`reason`）与人类标题（`displayReason`）。
 *
 * 宿主审批卡渲染的是 `displayReason`（有则按宿主语言解析），不是 `reason`；
 * `reason` 则进宿主的 `approval/asked` 审计事件与本插件的遥测 `detail`。
 * DEC-019 曾要求「`displayReason.zh` 与 `reason` 逐字相同」——那正是用户抱怨的
 * 源头：标题里塞着 `risk=` / `p=` / `irrev=` / `task=` / `inj=` 这些遥测字段名
 * 和裸小数，读起来不像给人看的一句话。DEC-041 因此**取消**了那条契约，把两者
 * 拆开：审计口径逐字不变，标题改成日常语言。
 *
 * 这里把住六条新契约：
 *
 *   1. 每条 ask 都带 `displayReason`，`zh` 与 `en` 都是非空字符串；
 *   2. `reason` **逐字保持审计原文**——这是「可读性改造没有改动审计口径」的
 *      唯一硬保证，所以四条分支都钉完整字符串，而不是只测结构；
 *   3. `displayReason` 里没有任何审计字段名（`risk=` / `irrev=` / `task=` /
 *      `inj=` / `p=` / `severity=`）与 `\d.\d` 形态的裸小数；`en` 另外不含 CJK、
 *      以 `decision-engine: ` 开头；
 *   4. 带工具上下文时标题点名操作对象（write → 「修改文件 + 路径」，
 *      apply_patch → 从 patch 文本里捞路径）；
 *   5. **`bash` 不加工具那一节**：命令原文已由宿主那条 detail 行显示在标题
 *      正下方，标题再写「命令行操作」是重复；
 *   6. delegate / deny 不带 `displayReason`——deny 是给模型的工具错误，
 *      宿主 PreToolDecision 的 deny 分支也没有这个字段。
 *
 * 纯函数单测，不碰网络与文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decideGuard } from "../lib/index.js";

/** CJK：汉字 + 全角标点（含全角括号）。 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 审计字段名：任何一个出现在标题里，就说明又把遥测口径漏给了用户。 */
const AUDIT_FIELDS = [/risk=/, /irrev=/, /task=/, /inj=/, /p=/, /severity=/];

/** 裸小数：标题里不该出现 0.84 这种给人看没有意义的东西。 */
const DECIMAL = /\d\.\d/;

/** 构造一份已通过 extractGuardAnswers 校验的答案。 */
function answers({ risk = "low", confidence = 0.9, irrev = 0.05, task = 0.9, inj = 0.05 } = {}) {
  return {
    risk: { choice: risk, confidence },
    irreversibleP: irrev,
    taskP: task,
    injectionP: inj,
  };
}

/** 最小配置：全部阈值取默认值。 */
const CFG = {
  guardConfidenceMin: 0.6,
  guardDenyConfidence: 0.85,
  guardIrreversibleCeiling: 0.2,
  guardTaskRelevanceFloor: 0.5,
  guardIrreversibleDenyFloor: 0.5,
  guardInjectionAskThreshold: 0.8,
};

/** 四条 ask 分支各一例（阈值取自 DEC-008 的校准数据）。 */
const ASK_CASES = {
  injection: answers({ inj: 0.85, task: 0.95 }),
  high: answers({ risk: "high", confidence: 0.7, irrev: 0.3, task: 0.95 }),
  medium: answers({ risk: "medium", confidence: 0.9, irrev: 0.05, task: 0.95 }),
  lowIrreversible: answers({ irrev: 0.35, task: 0.2 }),
};

/**
 * 四个分支的 `reason` 全文（DEC-041 起**一个字都不许变**）。
 *
 * 故意写死整句而不是正则：这条断言守的是「审计口径没有漂移」，只测结构的话
 * 文案被改一个字仍然绿——那正是要防的事。evidence 按 `toFixed(2)` 拼。
 */
const REASON_TEXT = {
  injection:
    "decision-engine: 工具输入疑似提示注入，升级人工确认" +
    "（risk=low p=0.90 irrev=0.05 task=0.95 inj=0.85）",
  high:
    "decision-engine: 高风险调用，需人工确认" +
    "（risk=high p=0.70 irrev=0.30 task=0.95 inj=0.05）",
  medium:
    "decision-engine: 中风险调用，需人工确认" +
    "（risk=medium p=0.90 irrev=0.05 task=0.95 inj=0.05）",
  lowIrreversible:
    "decision-engine: 风险低但可能不可逆且与任务相关性低，需人工确认" +
    "（risk=low p=0.90 irrev=0.35 task=0.20 inj=0.05）",
};

test("每条 ask 分支都带 displayReason，zh 与 en 都是非空字符串", () => {
  for (const [name, parsed] of Object.entries(ASK_CASES)) {
    const action = decideGuard(parsed, CFG);
    assert.equal(action.kind, "ask", `${name} 应为 ask`);
    assert.ok(action.displayReason !== undefined, `${name} 缺 displayReason`);
    assert.equal(typeof action.displayReason.zh, "string", `${name} 的 zh 应为字符串`);
    assert.equal(typeof action.displayReason.en, "string", `${name} 的 en 应为字符串`);
    assert.ok(action.displayReason.zh.length > 0, `${name} 的 zh 不能为空`);
    assert.ok(action.displayReason.en.length > 0, `${name} 的 en 不能为空`);
  }
});

test("reason 逐字保持审计原文（可读性改造没有改动审计口径）", () => {
  for (const [name, parsed] of Object.entries(ASK_CASES)) {
    const action = decideGuard(parsed, CFG);
    assert.equal(action.reason, REASON_TEXT[name], `${name} 的 reason 被改动了`);
  }
});

test("displayReason 不含审计字段名、裸小数，且不再是 reason 的复制", () => {
  for (const [name, parsed] of Object.entries(ASK_CASES)) {
    const action = decideGuard(parsed, CFG);
    const { zh, en } = action.displayReason;
    assert.notEqual(zh, action.reason, `${name} 的标题不该再是 reason 的复制（DEC-041）`);
    for (const field of AUDIT_FIELDS) {
      assert.doesNotMatch(zh, field, `${name} 的中文标题残留审计字段 ${field}`);
      assert.doesNotMatch(en, field, `${name} 的英文标题残留审计字段 ${field}`);
    }
    assert.doesNotMatch(zh, DECIMAL, `${name} 的中文标题带裸小数：${zh}`);
    assert.doesNotMatch(en, DECIMAL, `${name} 的英文标题带裸小数：${en}`);
  }
});

test("displayReason.en 不含中文，且以插件前缀开头", () => {
  for (const [name, parsed] of Object.entries(ASK_CASES)) {
    const action = decideGuard(parsed, CFG);
    const en = action.displayReason.en;
    assert.ok(!CJK.test(en), `${name} 的英文标题里残留中文：${en}`);
    assert.match(en, /^decision-engine: /, `${name} 应保留插件前缀`);
  }
});

test("带工具上下文时标题点名操作对象", () => {
  // 写文件类工具：宿主的 detail 行是空的（它只认 args.command），
  // 所以这里必须由标题自己说明「要改哪个文件」。
  const write = decideGuard(ASK_CASES.medium, CFG, {
    tool: "write",
    args: { file_path: "/tmp/x.txt" },
  });
  assert.match(write.displayReason.zh, /修改文件/, "write 的标题应点名修改文件");
  assert.ok(
    write.displayReason.zh.includes("/tmp/x.txt"),
    `write 的标题应带出文件路径：${write.displayReason.zh}`,
  );
  assert.ok(write.displayReason.en.includes("/tmp/x.txt"));
  // 上下文只影响标题，不能顺手改了审计原文。
  assert.equal(write.reason, REASON_TEXT.medium);

  // apply_patch 没有路径字段，路径藏在 patch 文本的 *** Update File: 行里。
  const patch = decideGuard(ASK_CASES.medium, CFG, {
    tool: "apply_patch",
    args: { input: "*** Begin Patch\n*** Update File: src/a.js\n*** End Patch\n" },
  });
  assert.match(patch.displayReason.zh, /修改文件/, "apply_patch 的标题应点名修改文件");
  assert.ok(
    patch.displayReason.zh.includes("src/a.js"),
    `apply_patch 的标题应从 patch 文本里捞到路径：${patch.displayReason.zh}`,
  );

  // 路径过长要截断，不能把整条路径铺满标题。
  const long = decideGuard(ASK_CASES.medium, CFG, {
    tool: "edit",
    args: { file_path: `/tmp/${"a".repeat(80)}.txt` },
  });
  assert.ok(long.displayReason.zh.includes("…"), "超长路径应截断并加省略号");
  assert.ok(!long.displayReason.zh.includes("a".repeat(70)), "超长路径不该整段铺进标题");
});

test("bash 不加工具那一节：命令原文由宿主 detail 行负责", () => {
  // 宿主 `conversation.approval.detail` 那一行会显示 args.command 原文，
  // 标题里再写「命令行操作」就是同一件事说两遍。
  const bash = decideGuard(ASK_CASES.medium, CFG, { tool: "bash", args: { command: "ls" } });
  const withoutContext = decideGuard(ASK_CASES.medium, CFG);
  assert.equal(
    bash.displayReason.zh,
    withoutContext.displayReason.zh,
    "bash 的标题不该因为带了工具上下文而变化",
  );
  assert.ok(!bash.displayReason.zh.includes("命令行"), "bash 的标题不该重复那行命令");
  assert.ok(!bash.displayReason.zh.includes("ls"), "标题不该抄命令原文");

  // 但审计原文一样不受上下文影响。
  assert.equal(bash.reason, REASON_TEXT.medium);
});

test("不带第三参时标题仍然正常（只少了工具那一节）", () => {
  const action = decideGuard(ASK_CASES.medium, CFG);
  assert.match(action.displayReason.zh, /^decision-engine：/, "仍应有插件前缀");
  assert.match(action.displayReason.zh, /需要你确认/, "仍应说明需要用户确认");
  assert.ok(!action.displayReason.zh.includes("undefined"), "缺上下文时不该漏出 undefined");
  // 标题结构是「<可选工具节 ·>正文 · 需要你确认」，没有工具节时就是两节。
  assert.equal(action.displayReason.zh.split(" · ").length, 2, `标题节数不对：${action.displayReason.zh}`);
});

test("异常工具名不会劈开标题：控制字符被压平、超长名被截断", () => {
  // 标题是**一行文本**：带换行的工具名会把「为什么问」那节挤到第二行，
  // 超长名字会把那节挤出可视区。工具名来自宿主注册表，我们只在展示层收敛。
  const newline = decideGuard(ASK_CASES.medium, CFG, { tool: "bad\nname", args: {} });
  const zh = newline.displayReason.zh;
  assert.equal(zh.split("\n").length, 1, `工具名里的换行不该劈开标题：${JSON.stringify(zh)}`);
  assert.match(zh, /bad name/, "控制字符应被压成空格而不是删除");

  const longName = decideGuard(ASK_CASES.medium, CFG, { tool: "x".repeat(200), args: {} });
  assert.ok(longName.displayReason.zh.includes("…"), "超长工具名应截断");
  assert.ok(
    longName.displayReason.zh.length < 200,
    `超长工具名不该整段铺进标题（长度 ${longName.displayReason.zh.length}）`,
  );
});

test("delegate / deny 不带 displayReason", () => {
  const delegate = decideGuard(answers({ irrev: 0.05, task: 0.95 }), CFG);
  assert.equal(delegate.kind, "delegate");
  assert.equal(delegate.displayReason, undefined);

  const deny = decideGuard(answers({ risk: "high", confidence: 0.9, irrev: 0.6, task: 0.95 }), CFG);
  assert.equal(deny.kind, "deny");
  assert.equal(deny.displayReason, undefined);
});
