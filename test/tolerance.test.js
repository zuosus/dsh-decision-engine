/**
 * 人工审核比例（tolerance）的纯函数单测 —— 对应 DEC-033。
 *
 * 这个功能的全部价值在一条契约上：**设定是模型无关的**。也就是说，
 * 「轻松 = 只问最前 1%」这个语义在任何决策模型上都成立，而实现它的手段
 * 是「按该模型最近的分位数换算阈值」，不是任何固定分数。
 *
 * 因此这里把住六条：
 *
 *   1. 默认档**逐字**等于现有行为（升级不改变任何东西）；
 *   2. 自治档从不 ask，但**绝不**取消 deny（那不是打扰，是安全边界）；
 *   3. 轻松档 = 只问最前 1%（分位带），**替换**默认判断而不是叠加；
 *   4. 谨慎档 = 默认判断 ∪ 最前 25%，因此一定 ≥ 默认；
 *   5. 严重度把三类危险情况排到最前，且安全下限生效；
 *   6. 校准器按 provider × model 分桶，样本不足时如实报告「未就绪」。
 *
 * 全部是纯函数，不碰网络与文件系统。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TOLERANCE,
  INJECTION_FLOOR_SCORE,
  HIGH_RISK_FLOOR_SCORE,
  TOLERANCE_LEVELS,
  TOLERANCE_PRESETS,
  ToleranceCalibrator,
  quantileOf,
  resolveTolerance,
  severityOf,
  toleranceCutoff,
  tolerancePreset,
} from "../lib/tolerance.js";
import { DEFAULTS, severityOf as severityOfFromIndex } from "../lib/index.js";

/** 构造一份已通过 extractGuardAnswers 校验的答案。 */
function answers({ risk = "low", confidence = 0.9, irrev = 0.05, task = 0.9, inj = 0.05, probs } = {}) {
  const out = {
    risk: { choice: risk, confidence },
    irreversibleP: irrev,
    taskP: task,
    injectionP: inj,
  };
  if (probs !== undefined) out.risk.probabilities = probs;
  return out;
}

/** 一次「默认会 ask」的低风险不可逆调用（DEC-008 那条噪声分支）。 */
const NOISE_ASK = answers({ irrev: 0.35, task: 0.2, probs: { high: 0.001, medium: 0.004 } });

/** 一次完全普通的调用（默认会放行）。 */
const BENIGN = answers({ irrev: 0.02, task: 0.9, probs: { high: 0.001, medium: 0.004 } });

test("默认档逐字等于现有行为：ask 仍是 ask、delegate 仍是 delegate", () => {
  for (const parsed of [NOISE_ASK, BENIGN]) {
    const legacy = "ask";
    const result = resolveTolerance({ level: "default", legacyKind: legacy, severity: 0.99 });
    assert.equal(result.kind, legacy, "默认档不能改变任何裁决");
    assert.equal(result.changed, false, "默认档不应报告「改动过」");
  }
  // 反向：delegate 仍是 delegate，即使严重度极高——默认档不看严重度。
  assert.equal(
    resolveTolerance({ level: "default", legacyKind: "delegate", severity: 1 }).kind,
    "delegate",
  );
});

test("默认档是默认值，且升级不改变行为", () => {
  assert.equal(DEFAULT_TOLERANCE, "default");
  assert.equal(DEFAULTS.tolerance, "default");
  assert.deepEqual([...TOLERANCE_LEVELS], ["autonomous", "relaxed", "default", "cautious"]);
});

test("自治档：ask → delegate，且从不询问", () => {
  const result = resolveTolerance({ level: "autonomous", legacyKind: "ask", severity: 0.99 });
  assert.equal(result.kind, "delegate");
  assert.equal(result.changed, true);
  assert.match(result.note, /autonomous/);
  // 极高严重度也不问。
  assert.equal(
    resolveTolerance({ level: "autonomous", legacyKind: "ask", severity: 1 }).kind,
    "delegate",
  );
});

test("自治档绝不取消 deny：那不是打扰，是安全边界", () => {
  const result = resolveTolerance({ level: "autonomous", legacyKind: "deny", severity: 0.5 });
  assert.equal(result.kind, "deny", "自治档必须保留拦截");
  assert.equal(result.changed, false, "deny 原样返回，不算「改动」");
});

test("四档都保留 deny", () => {
  for (const level of TOLERANCE_LEVELS) {
    const result = resolveTolerance({ level, legacyKind: "deny", severity: 0.5 });
    assert.equal(result.kind, "deny", `${level} 不应取消拦截`);
  }
});

test("轻松档：严重度达线才问，未达线一律放行（替换默认判断）", () => {
  // 达线：即使默认会放行，也升级成 ask。
  const hot = resolveTolerance({ level: "relaxed", legacyKind: "delegate", severity: 0.9, cutoff: 0.5 });
  assert.equal(hot.kind, "ask");
  assert.equal(hot.changed, true);

  // 未达线：即使默认会 ask，也放行——这是「只问最前 1%」的字面语义。
  const cold = resolveTolerance({ level: "relaxed", legacyKind: "ask", severity: 0.1, cutoff: 0.5 });
  assert.equal(cold.kind, "delegate");
  assert.equal(cold.changed, true);
});

test("轻松档未校准时用冷启动阈值，行为量级与校准后一致", () => {
  const preset = TOLERANCE_PRESETS.relaxed;
  assert.equal(preset.percentile, 0.99);
  // 冷启动阈值必须是有限数（不是 Infinity，也不是 null）。
  assert.ok(Number.isFinite(preset.fallbackSeverity), "轻松档必须有冷启动阈值");
  const above = resolveTolerance({
    level: "relaxed",
    legacyKind: "delegate",
    severity: preset.fallbackSeverity + 0.01,
    cutoff: null,
  });
  assert.equal(above.kind, "ask");
  assert.equal(above.cutoff, preset.fallbackSeverity, "未校准时 cutoff 应回落到冷启动值");
});

test("谨慎档：默认判断 ∪ 最前 25% —— 因此一定 ≥ 默认", () => {
  const preset = TOLERANCE_PRESETS.cautious;
  assert.equal(preset.percentile, 0.75);

  // 默认会 ask → 谨慎也 ask（叠加而不是替换）。
  const keptFromLegacy = resolveTolerance({
    level: "cautious",
    legacyKind: "ask",
    severity: 0.01,
    cutoff: 0.3,
  });
  assert.equal(keptFromLegacy.kind, "ask");

  // 默认放行但严重度达线 → 谨慎升级成 ask。
  const lifted = resolveTolerance({
    level: "cautious",
    legacyKind: "delegate",
    severity: 0.5,
    cutoff: 0.3,
  });
  assert.equal(lifted.kind, "ask");
  assert.equal(lifted.changed, true);

  // 都不满足 → 放行。
  const quiet = resolveTolerance({
    level: "cautious",
    legacyKind: "delegate",
    severity: 0.1,
    cutoff: 0.3,
  });
  assert.equal(quiet.kind, "delegate");
});

test("谨慎档的询问率必须高于默认档，轻松档必须低于默认档（单调）", () => {
  // 用一批合成的答案模拟真实分布：大部分良性、少数危险。
  const samples = [];
  for (let i = 0; i < 100; i += 1) {
    samples.push(answers({
      irrev: i % 20 === 0 ? 0.5 : 0.02,
      task: i % 20 === 0 ? 0.2 : 0.9,
      inj: i % 50 === 0 ? 0.9 : 0.01,
      probs: { high: 0.001, medium: 0.004 },
    }));
  }
  // 校准器先学这批分布，再用它算阈值。
  const calibrator = new ToleranceCalibrator();
  const severities = samples.map((item) => severityOf(item));
  for (const value of severities) calibrator.observe("p", "m", value);

  let relaxedAsks = 0;
  let defaultAsks = 0;
  let cautiousAsks = 0;
  samples.forEach((item, index) => {
    // 默认判断：模拟 DEC-008 的核心分支（低风险 + 可能不可逆 + 任务相关性低）。
    const legacy = item.irreversibleP >= 0.2 && item.taskP < 0.5 ? "ask" : "delegate";
    if (legacy === "ask") defaultAsks += 1;
    const severity = severities[index];
    const relaxedCut = toleranceCutoff({
      level: "relaxed", calibrator, provider: "p", model: "m",
    }).cutoff;
    const cautiousCut = toleranceCutoff({
      level: "cautious", calibrator, provider: "p", model: "m",
    }).cutoff;
    if (resolveTolerance({ level: "relaxed", legacyKind: legacy, severity, cutoff: relaxedCut }).kind === "ask") {
      relaxedAsks += 1;
    }
    if (resolveTolerance({ level: "cautious", legacyKind: legacy, severity, cutoff: cautiousCut }).kind === "ask") {
      cautiousAsks += 1;
    }
  });
  assert.ok(relaxedAsks < defaultAsks, `轻松档(${relaxedAsks}) 应少于默认档(${defaultAsks})`);
  assert.ok(cautiousAsks > defaultAsks, `谨慎档(${cautiousAsks}) 应多于默认档(${defaultAsks})`);
});

test("严重度：三类危险情况各自把分数拉高", () => {
  // 基线：良性调用分很低。
  const benign = severityOf(BENIGN);
  assert.ok(benign < 0.1, `良性调用的严重度应很低，实际 ${benign}`);

  // 1) 风险高（概率连续化）。
  const risky = severityOf(answers({ probs: { high: 0.8, medium: 0.1 } }));
  assert.ok(risky > 0.7, `高风险概率应拉高严重度，实际 ${risky}`);

  // 2) 可能不可逆且与任务无关。
  const irrelevant = severityOf(answers({ irrev: 0.9, task: 0.05 }));
  assert.ok(irrelevant > 0.7, `不可逆 + 无关应拉高严重度，实际 ${irrelevant}`);

  // 3) 注入嫌疑。
  const injected = severityOf(answers({ inj: 0.95 }));
  assert.ok(injected >= INJECTION_FLOOR_SCORE, `注入嫌疑应触及安全下限，实际 ${injected}`);
});

test("严重度：不可逆的顾虑在与任务相关时被抵扣（DEC-008 的核心）", () => {
  const relevant = severityOf(answers({ irrev: 0.5, task: 0.95 }));
  const irrelevant = severityOf(answers({ irrev: 0.5, task: 0.05 }));
  assert.ok(
    relevant < irrelevant,
    `与任务相关时的严重度应低于无关时（${relevant} vs ${irrelevant}）`,
  );
  // 实测基线：普通 bash 的 irreversible 在 0.2–0.4，task 高时不该被推上去。
  assert.ok(relevant < 0.2, `任务相关时不该靠不可逆单项抬高，实际 ${relevant}`);
});

test("严重度：安全下限让最关键的那几条必然落进最前 1%", () => {
  // 判定为 high 时，即使概率分布很平淡也必须达到下限。
  const highChoice = severityOf(answers({ risk: "high", probs: { high: 0.1, medium: 0.1 } }));
  assert.ok(highChoice >= HIGH_RISK_FLOOR_SCORE, `high 应有下限，实际 ${highChoice}`);

  // 注入达线时同理。
  const injection = severityOf(answers({ inj: 0.85 }));
  assert.ok(injection >= INJECTION_FLOOR_SCORE, `注入达线应有下限，实际 ${injection}`);

  // 两个下限都高于实测 P99（≈0.50），因此保证排在最前 1%。
  assert.ok(HIGH_RISK_FLOOR_SCORE > 0.5);
  assert.ok(INJECTION_FLOOR_SCORE > 0.5);
});

test("严重度：没有 probabilities 时退回分类兜底，不崩", () => {
  for (const choice of ["low", "medium", "high"]) {
    const value = severityOf(answers({ risk: choice }));
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${choice} 应给出合法分数`);
  }
  // 三档必须单调。
  assert.ok(severityOf(answers({ risk: "low" })) < severityOf(answers({ risk: "medium" })));
  assert.ok(severityOf(answers({ risk: "medium" })) < severityOf(answers({ risk: "high" })));
});

test("严重度：畸形输入一律不上抛，且不给 fail-open 的低分", () => {
  // 非对象：没有可判的东西，返回 0。
  for (const bad of [null, undefined, 0, "x"]) {
    assert.equal(severityOf(bad), 0, `${String(bad)} 应返回 0`);
  }
  // 对象但缺字段：**不能**当成低风险（那会是 fail-open），因此退回「中等」
  // 兜底分 0.5——它不抬高打扰率，但也不会把未知当成安全。
  for (const weird of [{}, []]) {
    const value = severityOf(weird);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${String(weird)} 应给出合法分数`);
    assert.ok(value >= 0.5, `未知 risk.choice 不该被当成低风险，实际 ${value}`);
  }
  // 越界概率被夹到 [0,1]：注入给 99 会被夹成 1（达线 → 触及安全下限）。
  assert.equal(severityOf(answers({ inj: 99 })), 1);
  // 负数被夹成 0：不再贡献严重度，分数只剩「低风险」的分类兜底 0.1。
  assert.ok(severityOf(answers({ inj: -5 })) < 0.2, "负概率不该抬高严重度");
});

test("severityOf 从 index.js 也导出，且与模块内是同一个实现", () => {
  assert.equal(typeof severityOfFromIndex, "function");
  const parsed = answers({ inj: 0.85, irrev: 0.4, task: 0.1 });
  assert.equal(severityOfFromIndex(parsed), severityOf(parsed));
});

test("quantileOf：线性插值，与 numpy 默认口径一致", () => {
  // 1..10 的 P50 是 5.5，P99 落在 9.91 附近。
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantileOf(sorted, 0.5), 5.5);
  assert.ok(Math.abs(quantileOf(sorted, 0.99) - 9.91) < 1e-9);
  assert.equal(quantileOf(sorted, 0), 1);
  assert.equal(quantileOf(sorted, 1), 10);
  // 空数组返回 null（调用方据此回落到冷启动值）。
  assert.equal(quantileOf([], 0.5), null);
  assert.equal(quantileOf(undefined, 0.5), null);
});

test("校准器：窗口是「最近」的，超量丢最旧的", () => {
  const calibrator = new ToleranceCalibrator({ windowSize: 10, minSamples: 5 });
  for (let i = 0; i < 25; i += 1) calibrator.observe("p", "m", i / 25);
  assert.equal(calibrator.stats("p", "m").samples, 10, "窗口应只保留最近 10 个");
  // 最早的 0..0.6 已被丢掉，因此最小值应大于 0。
  const threshold = calibrator.threshold("p", "m", 0);
  assert.ok(threshold > 0, `最旧的样本应已被丢弃，实际最小值 ${threshold}`);
});

test("校准器：按 provider × model 分桶，换模型重新校准", () => {
  const calibrator = new ToleranceCalibrator({ windowSize: 200, minSamples: 3 });
  for (let i = 0; i < 10; i += 1) calibrator.observe("a", "m1", 0.1);
  // 另一个模型只攒了 2 个 → 未就绪。
  calibrator.observe("a", "m2", 0.9);
  calibrator.observe("a", "m2", 0.9);

  assert.equal(calibrator.stats("a", "m1").ready, true);
  assert.equal(calibrator.stats("a", "m2").ready, false, "样本不足时不应报告就绪");
  assert.equal(calibrator.threshold("a", "m1", 0.99), 0.1, "两个模型的分布互不影响");
  assert.equal(calibrator.threshold("a", "m2", 0.99), null, "未就绪时阈值应为 null");

  // 换一个 provider 名字也是独立的分桶。
  assert.equal(calibrator.stats("b", "m1").samples, 0);
});

test("校准器：就绪前 cutoff 为 null（调用方据此回落到冷启动值）", () => {
  const calibrator = new ToleranceCalibrator({ windowSize: 200, minSamples: 50 });
  for (let i = 0; i < 49; i += 1) calibrator.observe("p", "m", 0.2);
  const notReady = toleranceCutoff({ level: "relaxed", calibrator, provider: "p", model: "m" });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.cutoff, null, "样本不足时必须交出 null");
  assert.equal(notReady.samples, 49);

  calibrator.observe("p", "m", 0.2);
  const ready = toleranceCutoff({ level: "relaxed", calibrator, provider: "p", model: "m" });
  assert.equal(ready.ready, true);
  assert.ok(Number.isFinite(ready.cutoff), "就绪后必须给出阈值");
});

test("toleranceCutoff：自治 / 默认两档不按分位数走", () => {
  const calibrator = new ToleranceCalibrator();
  for (let i = 0; i < 100; i += 1) calibrator.observe("p", "m", 0.5);
  for (const level of ["autonomous", "default"]) {
    const result = toleranceCutoff({ level, calibrator, provider: "p", model: "m" });
    assert.equal(result.cutoff, null, `${level} 不该有分位数阈值`);
    assert.equal(result.ready, true, `${level} 不需要校准，应直接报告就绪`);
  }
});

test("toleranceCutoff：未注入校准器时安全降级，不抛", () => {
  const result = toleranceCutoff({ level: "relaxed" });
  assert.equal(result.cutoff, null);
  assert.equal(result.ready, false);
  assert.equal(result.samples, 0);
});

test("tolerancePreset：未知档位退回默认，绝不抛", () => {
  assert.equal(tolerancePreset("nope").id, "default");
  assert.equal(tolerancePreset(undefined).id, "default");
  assert.equal(tolerancePreset("").id, "default");
  assert.equal(tolerancePreset("relaxed").id, "relaxed");
});

test("每一档都有中英成对的标签与说明（界面两处共用）", () => {
  const CJK = /[\u4e00-\u9fff]/;
  for (const id of TOLERANCE_LEVELS) {
    const preset = TOLERANCE_PRESETS[id];
    assert.equal(preset.id, id);
    assert.ok(preset.label.length > 0, `${id} 缺中文标签`);
    assert.ok(preset.labelEn.length > 0, `${id} 缺英文标签`);
    assert.ok(!CJK.test(preset.labelEn), `${id} 的英文标签残留中文`);
    assert.ok(preset.summary.length > 0, `${id} 缺中文说明`);
    assert.ok(preset.summaryEn.length > 0, `${id} 缺英文说明`);
    assert.ok(!CJK.test(preset.summaryEn), `${id} 的英文说明残留中文`);
  }
});

test("分位数含义与档位语义一致：轻松=最前 1%，谨慎=最前 25%", () => {
  assert.equal(TOLERANCE_PRESETS.relaxed.percentile, 0.99, "轻松档应取 P99");
  assert.equal(TOLERANCE_PRESETS.cautious.percentile, 0.75, "谨慎档应取 P75");
  assert.equal(TOLERANCE_PRESETS.autonomous.percentile, null, "自治档不按比例");
  assert.equal(TOLERANCE_PRESETS.default.percentile, null, "默认档不按比例");
});

test("resolveTolerance：畸形输入安全降级", () => {
  // 未知档位 → 默认行为。
  const unknown = resolveTolerance({ level: "nope", legacyKind: "ask", severity: 0.9 });
  assert.equal(unknown.kind, "ask");
  // 未知 legacyKind → 当作 delegate，绝不凭空造 ask。
  const weird = resolveTolerance({ level: "relaxed", legacyKind: "keep", severity: 0.9, cutoff: 0.5 });
  assert.ok(["ask", "delegate"].includes(weird.kind));
  // 空对象不抛。
  const empty = resolveTolerance({});
  assert.equal(empty.kind, "delegate");
});
