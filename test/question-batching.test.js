/**
 * 题目分批的纯函数测试。
 *
 * 接线（拆分真的发生在请求路径上）由 `question-batching-route.test.js` 证明；
 * 这里只钉住规则本身：切几份、每份几道、顺序不变、畸形输入不抛、上限只往小改。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  QuestionLimitMemory,
  chunkQuestions,
  isTooManyQuestions,
  mergeAnswers,
  normalizeMaxQuestions,
  runChunks,
} from "../lib/question-batching.js";
import { resolveProvider } from "../lib/providers.js";

const QUESTIONS = {
  risk: { type: "choice" },
  irreversible: { type: "noul" },
  matches_task: { type: "noul" },
  injection_suspect: { type: "noul" },
};

test("normalizeMaxQuestions：非法值一律 0（= 不限制），正数向下取整", () => {
  assert.equal(normalizeMaxQuestions(1), 1);
  assert.equal(normalizeMaxQuestions(3.9), 3);
  assert.equal(normalizeMaxQuestions("2"), 2);
  assert.equal(normalizeMaxQuestions(0), 0);
  assert.equal(normalizeMaxQuestions(-5), 0);
  assert.equal(normalizeMaxQuestions(undefined), 0);
  assert.equal(normalizeMaxQuestions(null), 0);
  assert.equal(normalizeMaxQuestions(Number.NaN), 0);
  assert.equal(normalizeMaxQuestions(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeMaxQuestions({}), 0);
});

test("chunkQuestions：按上限切份，保持原顺序，每份只含自己的题", () => {
  const one = chunkQuestions(QUESTIONS, 1);
  assert.equal(one.length, 4);
  assert.deepEqual(one.map((chunk) => Object.keys(chunk)), [
    ["risk"],
    ["irreversible"],
    ["matches_task"],
    ["injection_suspect"],
  ]);

  const three = chunkQuestions(QUESTIONS, 3);
  assert.equal(three.length, 2);
  assert.deepEqual(Object.keys(three[0]), ["risk", "irreversible", "matches_task"]);
  assert.deepEqual(Object.keys(three[1]), ["injection_suspect"]);
});

test("chunkQuestions：不超上限或未声明上限时原样一份（不多发请求）", () => {
  assert.equal(chunkQuestions(QUESTIONS, 0).length, 1);
  assert.equal(chunkQuestions(QUESTIONS, 4).length, 1);
  assert.equal(chunkQuestions(QUESTIONS, 99).length, 1);
  assert.deepEqual(Object.keys(chunkQuestions(QUESTIONS, 0)[0]), Object.keys(QUESTIONS));
});

test("chunkQuestions：畸形输入不抛，返回空数组", () => {
  assert.deepEqual(chunkQuestions(undefined, 1), []);
  assert.deepEqual(chunkQuestions(null, 1), []);
  assert.deepEqual(chunkQuestions([], 1), []);
  assert.deepEqual(chunkQuestions({}, 1), []);
  assert.deepEqual(chunkQuestions("x", 1), []);
});

test("mergeAnswers：合并各份答案，后到的不覆盖先到的", () => {
  const merged = mergeAnswers([{ a: 1 }, { b: 2 }, { a: 99, c: 3 }]);
  assert.deepEqual(merged, { a: 1, b: 2, c: 3 });
  assert.deepEqual(mergeAnswers([]), {});
  assert.deepEqual(mergeAnswers([null, undefined, { a: 1 }]), { a: 1 });
});

test("isTooManyQuestions：认得出三家的措辞，不误判普通错误", () => {
  // decisionmodels 的真实回包。
  assert.equal(
    isTooManyQuestions(
      '{"error":{"code":"too_many_questions","message":"s1-fast accepts exactly one question per request. max_questions is 1;"}}',
    ),
    true,
  );
  assert.equal(isTooManyQuestions('{"error":{"message":"max_questions is 3"}}'), true);
  assert.equal(isTooManyQuestions("Exactly one question per request is allowed"), true);
  // 不该误判的：普通 400、空体、非字符串。
  assert.equal(isTooManyQuestions('{"error":{"message":"model not found"}}'), false);
  assert.equal(isTooManyQuestions(""), false);
  assert.equal(isTooManyQuestions(undefined), false);
  assert.equal(isTooManyQuestions(42), false);
});

test("QuestionLimitMemory：记住上限，只往小改，按端点 × 模型分开记", () => {
  const memory = new QuestionLimitMemory();
  const dm = resolveProvider({ provider: "decisionmodels" });
  assert.equal(memory.get(dm), 0, "没学过时是 0");

  memory.set(dm, 1);
  assert.equal(memory.get(dm), 1);
  // 学成更宽松的值不覆盖已知事实：拆分不足会再次静默失效。
  memory.set(dm, 3);
  assert.equal(memory.get(dm), 1);
  // 更严的值要覆盖。
  memory.set(dm, 1);
  assert.equal(memory.get(dm), 1);

  // 换模型就是另一个键：上限是模型属性。
  const pro = resolveProvider({ provider: "decisionmodels", decisionModelsModel: "s1-pro" });
  assert.equal(memory.get(pro), 0);
  memory.set(pro, 3);
  assert.equal(memory.get(pro), 3);
  assert.equal(memory.get(dm), 1, "别的模型的上限不能串过来");

  memory.clear();
  assert.equal(memory.get(dm), 0);
  assert.equal(memory.get(pro), 0);
});

test("QuestionLimitMemory：畸形 provider 不抛", () => {
  const memory = new QuestionLimitMemory();
  assert.equal(memory.get(undefined), 0);
  assert.equal(memory.get(null), 0);
  assert.equal(memory.get({}), 0);
  assert.doesNotThrow(() => memory.set({}, 1));
  assert.doesNotThrow(() => memory.set(undefined, 1));
});

test("runChunks：串行发完并保序，一份失败即整体失败（不再发后面的）", async () => {
  const seen = [];
  const ok = await runChunks([{ a: 1 }, { b: 2 }], async (chunk) => {
    seen.push(Object.keys(chunk)[0]);
    return { ok: true, answers: chunk };
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, ["a", "b"], "必须串行且保序");
  assert.equal(ok.parts.length, 2);

  seen.length = 0;
  const failed = await runChunks([{ a: 1 }, { b: 2 }, { c: 3 }], async (chunk) => {
    seen.push(Object.keys(chunk)[0]);
    if (Object.keys(chunk)[0] === "b") return { ok: false, reason: "http-400" };
    return { ok: true, answers: chunk };
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failure.reason, "http-400");
  assert.deepEqual(seen, ["a", "b"], "失败后不再发后面的题");

  // 空输入不抛：返回一个明确的失败，而不是「成功但没有答案」。
  const empty = await runChunks([], async () => ({ ok: true }));
  assert.equal(empty.ok, false);
  assert.equal(empty.failure.reason, "empty-questions");
});
