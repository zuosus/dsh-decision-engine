/**
 * 作用域边界（DEC-045）的单元测试。
 *
 * 这一层测的是本插件**不做什么**，而不是做什么——所以断言大多写成
 * 「应该让位」而不是「应该拦下」。
 *
 * 覆盖三类敏感场景：
 *
 *   1. 越出工作区的写入  —— 能确定性判（词法路径计算），因此插件让位。
 *   2. 模型在等用户决定  —— **不能**确定性判（宿主没有这个状态位），
 *                           交给模型判，但模型的结果**只用于让位**。
 *
 * 以及最关键的一条负向断言：这条边界**永远**不会变成「替用户选一个」。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOPE_KINDS,
  SCOPE_NONE,
  classifyWorkspaceTarget,
  isUnderRoots,
  pathTargetOf,
  pathTargetsOf,
} from "../lib/scope.js";
import { POINT_SPECS } from "../lib/points/spec.js";

/** 一份覆盖全部阈值的配置（与 index.js 的 DEFAULTS 对齐）。 */
const CFG = {
  turnStopMaxSteers: 1,
  turnStopClosedFloor: 0.6,
  turnStopUnfinishedFloor: 0.6,
  turnStopValueFloor: 0.35,
  turnStopAwaitingUserFloor: 0.5,
};

/** 构造一条 noul 答案。 */
const noul = (value) => ({ type: "noul", noul: value });

// ------------------------------------------------------------ 写根判定

test("写根判定：绝对路径落在根之内", () => {
  assert.equal(isUnderRoots("/work/repo/a.txt", ["/work/repo"], "/work"), true);
  assert.equal(isUnderRoots("/work/repo", ["/work/repo"], "/work"), true, "根本身算在内");
});

test("写根判定：绝对路径落在根之外", () => {
  assert.equal(isUnderRoots("/etc/passwd", ["/work/repo"], "/work"), false);
  assert.equal(isUnderRoots("/work/repository/x", ["/work/repo"], "/work"), false, "前缀相同但不是子目录");
});

test("写根判定：相对路径按 cwd 解析", () => {
  assert.equal(isUnderRoots("a.txt", ["/work/repo"], "/work/repo"), true);
  assert.equal(isUnderRoots("../outside.txt", ["/work/repo"], "/work/repo"), false);
});

test("写根判定：.. 不能越过绝对路径的根", () => {
  // /work/repo/../../etc/passwd 归一后是 /etc/passwd，仍在根外。
  assert.equal(isUnderRoots("/work/repo/../../etc/passwd", ["/work/repo"], "/work"), false);
});

test("写根判定：根是 / 时一切都算在内", () => {
  assert.equal(isUnderRoots("/anything/at/all", ["/"], "/"), true);
});

test("写根判定：拿不到根时一律放行（宁可漏判也不误判）", () => {
  assert.equal(isUnderRoots("/etc/passwd", [], "/work"), true, "根为空 = 无从判断");
  assert.equal(isUnderRoots("/etc/passwd", undefined, "/work"), true);
  assert.equal(isUnderRoots("", ["/work"], "/work"), true, "路径非法 = 放行");
});

// ------------------------------------------------------------ 路径提取

test("路径提取：认写文件工具的参数名", () => {
  assert.equal(pathTargetOf("write", { file_path: "/a/b.txt" }), "/a/b.txt");
  assert.equal(pathTargetOf("edit", { path: "/a/b.txt" }), "/a/b.txt");
  assert.equal(pathTargetOf("read", { file: "/a/b.txt" }), "/a/b.txt");
});

test("路径提取：认 apply_patch 的补丁头", () => {
  const input = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch";
  assert.equal(pathTargetOf("apply_patch", { input }), "src/a.ts");
});

test("路径提取：多目标补丁必须收集全部目标（DEC-045 的边界只认这个）", () => {
  const input = [
    "*** Begin Patch",
    "*** Add File: /w/repo/inside.txt",
    "+x",
    "*** Add File: /w/outside.txt",
    "+y",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(pathTargetsOf("apply_patch", { input }), ["/w/repo/inside.txt", "/w/outside.txt"]);
  // `pathTargetOf` 保留「首个目标」的旧语义：它是公开 API，调用方按单目标用。
  assert.equal(pathTargetOf("apply_patch", { input }), "/w/repo/inside.txt");
});

test("路径提取：Move File 的源与目标都算目标", () => {
  assert.deepEqual(pathTargetsOf("apply_patch", { input: "*** Move File: a.ts → b.ts" }), ["a.ts", "b.ts"]);
  assert.deepEqual(pathTargetsOf("apply_patch", { input: "*** Move File: a.ts -> b.ts" }), ["a.ts", "b.ts"]);
});

test("路径提取：普通工具就一个目标，没有路径时是空数组", () => {
  assert.deepEqual(pathTargetsOf("write", { file_path: "/a/b.txt" }), ["/a/b.txt"]);
  assert.deepEqual(pathTargetsOf("write", {}), []);
  assert.deepEqual(pathTargetsOf("bash", { command: "rm -rf /etc" }), []);
});

test("越界判定：多目标补丁里只要有任一个越界，整次调用就算越界", () => {
  // 回归：修之前 `pathTargetOf` 只取第一个 `*** ... File:`，于是
  // 「界内 + 越界」的补丁返回 none，越界让位（DEC-045）整段不触发——
  // 本该交还宿主沙箱的写入被静默送进了决策模型。
  const roots = ["/w/repo"];
  const classify = (input) => classifyWorkspaceTarget({ tool: "apply_patch", args: { input }, roots, cwd: "/w/repo" });

  const mixed = "*** Begin Patch\n*** Add File: /w/repo/a.txt\n+x\n*** Add File: /w/out.txt\n+y\n*** End Patch";
  assert.equal(classify(mixed).kind, SCOPE_KINDS.outsideWorkspace, "第二个目标越界也必须判越界");

  // 越界排在第三位同样不能被前两条界内目标掩盖。
  const third = "*** Add File: /w/repo/a\n*** Add File: /w/repo/b\n*** Add File: /w/out\n";
  assert.equal(classify(third).kind, SCOPE_KINDS.outsideWorkspace, "越界目标排在后面同样要判");

  // 全部界内仍然是 none（不能因为改成「任一」就把正常补丁也拦下来）。
  const inside = "*** Add File: /w/repo/a\n*** Add File: /w/repo/b\n";
  assert.equal(classify(inside).kind, SCOPE_NONE, "全部界内不应判越界");

  // Move 的目标越界也算：只改路径的移动同样会写到越界位置。
  assert.equal(classify("*** Move File: /w/repo/a → /w/out").kind, SCOPE_KINDS.outsideWorkspace);
});

test("路径提取：没有明确路径时返回 undefined（不猜）", () => {
  assert.equal(pathTargetOf("bash", { command: "rm -rf /etc" }), undefined, "shell 命令不解析");
  assert.equal(pathTargetOf("web_search", { query: "x" }), undefined);
  assert.equal(pathTargetOf("write", {}), undefined);
  assert.equal(pathTargetOf("write", null), undefined);
});

// ------------------------------------------------------------ 越界判定

test("越界判定：目标在工作区外即让位", () => {
  const result = classifyWorkspaceTarget({
    tool: "write",
    args: { file_path: "/etc/passwd" },
    roots: ["/work/repo"],
    cwd: "/work/repo",
  });
  assert.equal(result.kind, SCOPE_KINDS.outsideWorkspace);
});

test("越界判定：工作区内的写入不算越界", () => {
  const result = classifyWorkspaceTarget({
    tool: "write",
    args: { file_path: "src/a.ts" },
    roots: ["/work/repo"],
    cwd: "/work/repo",
  });
  assert.equal(result.kind, SCOPE_NONE);
});

test("越界判定：认不出路径时不算越界", () => {
  const result = classifyWorkspaceTarget({
    tool: "bash",
    args: { command: "echo hi > /etc/x" },
    roots: ["/work/repo"],
    cwd: "/work/repo",
  });
  assert.equal(result.kind, SCOPE_NONE);
});

// ------------------------------------------------------------ 轮次延续的边界

test("轮次：模型说在等用户时让位，不续轮", () => {
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.85),
    value: noul(0.8),
    closed: noul(0.1),
    awaiting_user: noul(0.9),
  });
  const action = POINT_SPECS.turnStop.decide(parsed, CFG);
  assert.equal(action.kind, "defer", "在等用户时绝不续轮");
  assert.equal(action.scope, SCOPE_KINDS.awaitingUser);
});

test("轮次：等用户的判断排在「未完成」之前（未完成会把等待误判成活没干完）", () => {
  // 「你选 A 还是 B？」这一轮：unfinished 高、closed 低，但正是在等用户。
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.9),
    value: noul(0.8),
    closed: noul(0.05),
    awaiting_user: noul(0.95),
  });
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "defer");
});

test("轮次：不在等用户时行为逐字不变", () => {
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.85),
    value: noul(0.8),
    closed: noul(0.1),
    awaiting_user: noul(0.05),
  });
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "continue");
});

test("轮次：老端点不认识 awaiting_user 时整点降级，不再「判不出来还硬判」", () => {
  // 曾经的 fail-open 在「你要选 A 还是 B？」这类轮次上是致命的：
  // 模型对 unfinished 必然给高分（确实没干完），于是 continue，插件注入
  // steer 把轮次撑下去——用小模型的猜测顶掉用户的选择权（DEC-045）。
  //
  // 现在：缺这一问 = 这个端点跑不了本点 → 返回降级信号，本轮不续轮、
  // **不留裁决**（统计落在「未裁决」那格），端点补上后自动恢复。
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.85),
    value: noul(0.8),
    closed: noul(0.1),
  });
  assert.deepEqual(parsed, { degraded: "turnstop-boundary-question-unavailable" });
  // 降级信号没有可供 decide 消费的分数——引擎在 decide 之前就返回了，
  // 这里断言「它不是一个裁决输入」，防止有人误把它当普通 parsed 用。
  assert.equal(parsed.unfinished, undefined);
});

test("轮次：awaiting_user 形状不合格同样按「端点不支持」整点降级", () => {
  // noul(5) 越界 → readNoul 归一失败 → 与「完全没这一问」等价：
  // 端点给出的边界答案不可用，就不能拿它当「不在等用户」。
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.85),
    value: noul(0.8),
    closed: noul(0.1),
    awaiting_user: { type: "noul", noul: 5 },
  });
  assert.deepEqual(parsed, { degraded: "turnstop-boundary-question-unavailable" });
});

test("轮次：边界问句答得出来时照常裁决（降级不能变成常态）", () => {
  // 与上面两条配对的负向断言：只要端点答了边界问句，一切照旧。
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.85),
    value: noul(0.8),
    closed: noul(0.1),
    awaiting_user: noul(0.05),
  });
  assert.equal(parsed.awaitingUser, 0.05);
  assert.equal(POINT_SPECS.turnStop.decide(parsed, CFG).kind, "continue");
});

// ------------------------------------------------------- 最关键的负向断言

test("边界永远不会变成「替用户选一个」", () => {
  // 让位只有一种结果：defer。没有「所以我替你选了 A」这种裁决词。
  const parsed = POINT_SPECS.turnStop.parse({
    unfinished: noul(0.9),
    value: noul(0.9),
    closed: noul(0.0),
    awaiting_user: noul(1),
  });
  const action = POINT_SPECS.turnStop.decide(parsed, CFG);
  assert.equal(action.kind, "defer");
  // 裁决里**没有**任何「选定方案」的字段：插件没有这条能力。
  assert.equal(action.suggest, undefined, "让位不得附带任何「我替你选了什么」");
  assert.equal(action.selected, undefined);
  assert.equal(action.answer, undefined);
});

test("轮次的四个裁决词里没有「代替用户决定」这一类", () => {
  // 穷举 spec.decide 可能返回的 kind —— 断言集合里没有「代替」类。
  const kinds = new Set();
  for (const unfinished of [0, 0.5, 0.9]) {
    for (const value of [0, 0.5, 0.9]) {
      for (const closed of [0, 0.5, 0.9]) {
        for (const awaiting of [undefined, 0, 0.5, 0.9]) {
          const parsed = POINT_SPECS.turnStop.parse({
            unfinished: noul(unfinished),
            value: noul(value),
            closed: noul(closed),
            ...(awaiting === undefined ? {} : { awaiting_user: noul(awaiting) }),
          });
          kinds.add(POINT_SPECS.turnStop.decide(parsed, CFG).kind);
        }
      }
    }
  }
  assert.deepEqual([...kinds].sort(), ["continue", "defer", "stop"]);
});
