/**
 * ask 裁决的双语审批卡文案（DEC-019）。
 *
 * 宿主审批卡渲染的是 `displayReason`（有则按宿主语言解析），不是 `reason`；
 * 没有它，宿主界面切到英文时标题仍是中文。这里把住三条契约：
 *
 *   1. 每条 ask 都带 displayReason，且 `zh` 与 `reason` 逐字相同
 *      （中文宿主看到的必须与审计原文完全一致）；
 *   2. `en` 里没有任何 CJK 字符，并保留语言中立的 evidence 摘要；
 *   3. delegate / deny 不带 displayReason——deny 是给模型的工具错误，
 *      宿主 PreToolDecision 的 deny 分支也没有这个字段。
 *
 * 纯函数单测，不碰网络与文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decideGuard } from "../lib/index.js";

/** CJK：汉字 + 全角标点（含全角括号）。 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

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

test("每条 ask 分支都带 displayReason，且 zh 与 reason 逐字相同", () => {
  for (const [name, parsed] of Object.entries(ASK_CASES)) {
    const action = decideGuard(parsed, CFG);
    assert.equal(action.kind, "ask", `${name} 应为 ask`);
    assert.ok(action.displayReason !== undefined, `${name} 缺 displayReason`);
    assert.equal(action.displayReason.zh, action.reason, `${name} 的 zh 必须等于 reason`);
  }
});

test("displayReason.en 不含中文，且保留语言中立的 evidence 摘要", () => {
  for (const [name, parsed] of Object.entries(ASK_CASES)) {
    const action = decideGuard(parsed, CFG);
    const en = action.displayReason.en;
    assert.ok(!CJK.test(en), `${name} 的英文译文里残留中文：${en}`);
    assert.match(en, /^decision-engine: /, `${name} 应保留插件前缀`);
    assert.match(
      en,
      /risk=\w+ p=[\d.]+ irrev=[\d.]+ task=[\d.]+ inj=[\d.]+/,
      `${name} 的英文里缺 evidence 摘要`,
    );
    // 中文原文用全角括号，译文用半角——顺带确认两种语言没有串用。
    assert.ok(en.includes("(") && !en.includes("（"), `${name} 的括号应为半角`);
  }
});

test("delegate / deny 不带 displayReason", () => {
  const delegate = decideGuard(answers({ irrev: 0.05, task: 0.95 }), CFG);
  assert.equal(delegate.kind, "delegate");
  assert.equal(delegate.displayReason, undefined);

  const deny = decideGuard(answers({ risk: "high", confidence: 0.9, irrev: 0.6, task: 0.95 }), CFG);
  assert.equal(deny.kind, "deny");
  assert.equal(deny.displayReason, undefined);
});