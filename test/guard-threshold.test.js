/**
 * 守卫裁决（decideGuard）的阈值校准回归——对应 DEC-008。
 *
 * 用户实测症状：「非常非常多次询问我的意见」。遥测回放（1647 条有效授权
 * 决策）显示 95 次 ask 里有 76 次来自「风险低但可能不可逆」分支，而这批
 * 样本的 taskP 全部 ≥0.5——模型自己都确信调用服务于当前任务。
 *
 * 修复：低风险分支叠加任务相关性否决。这里固定四个行为契约：
 *
 *   1. 低风险 + 可能不可逆 + 任务相关性低 → 仍升级 ask（真正可疑的调用）；
 *   2. 低风险 + 可能不可逆 + 任务相关性高 → 放行（修复点，不再打扰）；
 *   3. 中风险 / 高风险 / 注入嫌疑分支不受否决条件影响，语义不变；
 *   4. 否决线可通过 guardTaskRelevanceFloor 配置，0 等于关闭否决（旧行为）。
 *
 * 全部是纯函数单测，不碰网络与文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decideGuard } from "../lib/index.js";

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

test("低风险 + 可能不可逆 + 任务相关性低 → 仍升级询问", () => {
  const parsed = answers({ irrev: 0.35, task: 0.2 });
  const action = decideGuard(parsed, CFG);
  assert.equal(action.kind, "ask");
  assert.match(action.reason, /与任务相关性低/);
});

test("低风险 + 可能不可逆 + 任务相关性高 → 放行（DEC-008 修复点）", () => {
  // 遥测中的典型误打扰样本：risk=low p=0.74 irrev=0.22 task=0.83。
  const parsed = answers({ confidence: 0.74, irrev: 0.22, task: 0.83 });
  assert.equal(decideGuard(parsed, CFG).kind, "delegate");
});

test("否决线恰好压线：taskP 低于 floor 才问，等于 floor 放行", () => {
  const atFloor = answers({ irrev: 0.3, task: 0.5 });
  assert.equal(decideGuard(atFloor, CFG).kind, "delegate");

  const justBelow = answers({ irrev: 0.3, task: 0.49 });
  assert.equal(decideGuard(justBelow, CFG).kind, "ask");
});

test("irreversibleP 低于 ceiling 时与任务相关性无关，一律放行", () => {
  assert.equal(decideGuard(answers({ irrev: 0.19, task: 0.1 }), CFG).kind, "delegate");
});

test("中风险分支不受否决条件影响：置信达线仍询问", () => {
  const parsed = answers({ risk: "medium", confidence: 0.9, irrev: 0.05, task: 0.95 });
  assert.equal(decideGuard(parsed, CFG).kind, "ask");
});

test("中风险 + 低置信 → 放行（原语义保持）", () => {
  const parsed = answers({ risk: "medium", confidence: 0.4, task: 0.95 });
  assert.equal(decideGuard(parsed, CFG).kind, "delegate");
});

test("高风险分支不受否决条件影响：达线 deny、未达线 ask", () => {
  const deny = answers({ risk: "high", confidence: 0.9, irrev: 0.6, task: 0.95 });
  assert.equal(decideGuard(deny, CFG).kind, "deny");

  const ask = answers({ risk: "high", confidence: 0.7, irrev: 0.3, task: 0.95 });
  assert.equal(decideGuard(ask, CFG).kind, "ask");
});

test("注入嫌疑达线：即使任务相关性高也升级询问", () => {
  const parsed = answers({ inj: 0.85, task: 0.95 });
  assert.equal(decideGuard(parsed, CFG).kind, "ask");
});

test("guardTaskRelevanceFloor 边界语义：0 关闭该分支，1 恢复旧行为", () => {
  const parsed = answers({ irrev: 0.35, task: 0.95 });
  // floor=0 → taskP < 0 永远为假：低风险不可逆分支整体停用（比旧行为更严）。
  assert.equal(decideGuard(parsed, { ...CFG, guardTaskRelevanceFloor: 0 }).kind, "delegate");
  // floor=1 → taskP < 1 几乎恒真：与旧版「只看 irreversibleP」行为一致。
  assert.equal(decideGuard(parsed, { ...CFG, guardTaskRelevanceFloor: 1 }).kind, "ask");
});

test("默认配置对象包含 guardTaskRelevanceFloor 且值为 0.5", async () => {
  const { DEFAULTS } = await import("../lib/index.js");
  assert.equal(DEFAULTS.guardTaskRelevanceFloor, 0.5);
});
