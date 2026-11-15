/**
 * 思维链翻译门槛：包住 `translator.translate()`。
 *
 * 翻译链路没有提供任何 hook —— `ctx.translator` 是一个 Service，`cotTranslation`
 * 直接调用它的 `translate(spec, signal)`。所以这里只能包住那个方法。
 *
 * 包装是「有边界的、可撤销的」，不是野生 monkeypatch：
 *
 *   - 用 `ctx.effect(...)` 注册，卸载时一定把原方法装回去；
 *   - 原方法的 `this` 保持为 translator 实例，签名与返回值完全不变；
 *   - 判定失败一律调用原方法（fail-open），绝不让翻译因为守卫而不可用；
 *   - 返回一个空串表示「不需要翻译」会破坏调用方语义，因此**跳过翻译时
 *     返回原文**——调用方拿到的是「已经是目标语言」的合理解释。
 *
 * 生效方式与省 token 的关系：翻译按条计费。判为 skip 时直接返回原文，
 * 那条就完全不发请求；判为 translate 时正常走下原方法。
 *
 * @module dsh-decision-engine/adapters/translate
 */

import { createHash } from "node:crypto";

/**
 * 本地裁决缓存的「问法版本号」。
 *
 * 缓存里存的是**裁决**（要不要翻译），而一条裁决只对产生它的那套 questions
 * 成立。spec.js 里 cotTranslate 的问法一改（加一问、换措辞、换判定口径），
 * 旧裁决立刻失效——可这个缓存是内存里的 Map，热更新代码时它会跨版本存活。
 * 把版本号写进键里，改问法时手动 +1 是最小的保险：忘了 +1 的后果是「新问法
 * 一直在用老答案」，而且从现象上完全看不出来（翻译时好时坏，与文本无关）。
 */
const QUESTIONS_VERSION = 1;

/** 判断一段文本里「值得翻译的正文」占比是否够高（本地预筛，免费的）。 */
function looksLikeProse(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  // 去掉代码块、行内代码、URL —— 这些不需要翻译。
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  // 统计字母/汉字数量；纯符号/数字/路径不值得发一次翻译请求。
  let letters = 0;
  for (const char of prose) {
    if (/[\p{L}]/u.test(char)) letters += 1;
  }
  return letters >= 4;
}

/**
 * 构造一条裁决的缓存键。
 *
 * 修之前键是 `${targetLanguage}|${text.length}|${text.slice(0, 64)}`：
 *
 *   - 同长 + 前 64 字符相同、后面不同的两段文本会共用一条裁决。翻译文本
 *     经常以同样的开场白起头（"Here's my plan: ..."），撞键不是理论问题；
 *   - `sourceLanguage` 根本不在键里：同一段英文，一次标 en、一次标 zh，
 *     第二次直接复用第一次的结论——可 source 正是「是否已是目标语言」那
 *     一问的输入。
 *
 * 现在键 = 问法版本 + 源语言 + 目标语言 + **全文**的 sha256。为什么用摘要而
 * 不是全文：这个 Map 最多留 256 条，键若存全文，等于把 256 段思维链全文钉在
 * 内存里；摘要定长，缓存体积与文本长度无关。
 *
 * @param spec - 翻译规格（只读 `sourceLanguage` / `targetLanguage`）。
 * @param text - 待翻译全文。
 * @returns 缓存键。
 */
function decisionKey(spec, text) {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const source = typeof spec?.sourceLanguage === "string" ? spec.sourceLanguage : "auto";
  const target = typeof spec?.targetLanguage === "string" ? spec.targetLanguage : "auto";
  return `${QUESTIONS_VERSION}|${source}|${target}|${digest}`;
}

/**
 * 包住 translator.translate。
 *
 * @param ctx - cordis 插件上下文。
 * @param deps - 运行期依赖。
 * @returns 是否成功挂载。
 */
export function mountCotTranslatePoint(ctx, deps) {
  const { runner, getConfig, telemetry } = deps;

  const translator = ctx.get?.("translator");
  if (translator === undefined || typeof translator.translate !== "function") {
    ctx.logger?.info?.("dsh-decision-engine: 未找到 translator 服务，思维链翻译门槛不挂载");
    return false;
  }

  const original = translator.translate;
  /** 命中缓存的「需要翻译」判断：同一段文本重复翻译时不再问模型。 */
  const decisions = new Map();
  const MAX_DECISIONS = 256;

  const remember = (key, value) => {
    if (decisions.has(key)) decisions.delete(key);
    decisions.set(key, value);
    while (decisions.size > MAX_DECISIONS) {
      const oldest = decisions.keys().next();
      if (oldest.done) break;
      decisions.delete(oldest.value);
    }
  };

  const wrapped = async function translate(spec, signal) {
    // 这个点关掉时连一次判断都不做，直接走原路径。
    if (!runner.participates("cotTranslate")) return original.call(this, spec, signal);

    try {
      /**
       * 本点此刻是否允许真正改变行为。一次执行里只取一次。
       *
       * 为什么先取而不是每处现问：下面有三处要用它（本地预筛、缓存命中、
       * 裁决落地），每次都读配置的话，配置中途被改会得到「预筛按 enforce
       * 跳过、落裁决按 observe 放行」这种自相矛盾的一次执行。
       */
      const enforced = runner.enforces("cotTranslate");
      const text = typeof spec?.text === "string" ? spec.text : "";
      // 本地预筛：明显不需要翻译的文本零成本跳过，不必问模型。
      if (!looksLikeProse(text)) {
        /**
         * 修之前这个 return 跑在 `enforces()` 之前：observe 模式下也直接返回
         * 原文，于是「只观察」变成了「真的跳过翻译」——用户拿到的是没翻译的
         * 原文，而遥测里这次却被记成一次 observe。observe 的契约是只记录、
         * 不改变行为；违反它比不开启这个点更坏，因为观察期得出的数据会被
         * 当成「没人开过这个点」的干净样本。
         *
         * 现在：只有 enforce 才允许这条路真的返回原文；observe 一律走原翻译器，
         * 只留一条「本该跳过」的记录，这样观察数据里仍能看到它到底值不值得开。
         */
        if (!enforced) {
          await telemetry.log({
            ts: new Date().toISOString(),
            point: "cotTranslate",
            tag: "cotTranslate",
            action: "skip",
            detail: "decision-engine-cot: 本地预筛判定无正文；observe 模式仍走原翻译器（本该跳过）",
            latencyMs: 0,
            cached: false,
          });
          return original.call(this, spec, signal);
        }
        await telemetry.log({
          ts: new Date().toISOString(),
          point: "cotTranslate",
          tag: "cotTranslate",
          action: "skip",
          detail: "decision-engine-cot: 本地预筛判定为无正文，跳过翻译",
          latencyMs: 0,
          cached: false,
        });
        return text;
      }

      // 缓存键：问法版本 + 源/目标语言 + 全文摘要（见 decisionKey 的说明）。
      const key = decisionKey(spec, text);
      let verdict = decisions.get(key);
      if (verdict === undefined) {
        const cfg = getConfig();
        /**
         * 会话引用：`spec.sessionId` 只有**付费** provider 才有
         * （`AnonymousTranslationSpec` 没有这个字段）。因此这个点的会话归属是
         * 「有则记、没有就算不可归属」：免费通道（google / bing）的决策不会
         * 出现在任何会话的「决策历史」里。这是刻意的取舍，不是遗漏——为它
         * 编造一个会话 id 会让用户看到一条不属于自己会话的记录，比缺失更糟
         * （见 DEC-022）。
         *
         * 修之前这里传的是 `{ sessionId }`，而 engine.js 的 `ask()` 只从
         * `extra.session` 取会话——字段名对不上，于是**付费通道的翻译决策也
         * 永远归不到会话**：明细里的 sessionId 恒为空串，界面上永远不进任何
         * 会话页。引擎的 `sessionIdOf()` 本来就接受 id 字符串，所以这里直接按
         * 它认的字段名传，不新增第二个字段（两个名字收同一件事，迟早只改一个）。
         */
        const sessionRef =
          typeof spec.sessionId === "string" && spec.sessionId.length > 0 ? spec.sessionId : undefined;
        const result = await runner.ask(
          "cotTranslate",
          {
            text,
            targetLanguage: spec.targetLanguage,
            sourceLanguage: spec.sourceLanguage,
            head: text.slice(0, 400),
          },
          {
            signal,
            ...(sessionRef === undefined ? {} : { session: sessionRef }),
          },
        );
        // 降级 / observe / 关闭：一律按「需要翻译」处理，走原方法。
        if (result.action === undefined || !enforced) {
          return original.call(this, spec, signal);
        }
        verdict = result.action.kind === "translate";
        remember(key, verdict);
      }

      if (verdict === true) return original.call(this, spec, signal);
      // 缓存里可能存着本点 enforce 期的裁决：切到 observe 后不能再拿它改行为。
      if (!enforced) return original.call(this, spec, signal);

      // 判为不需要翻译：返回原文。这与「已经是目标语言」的语义一致，
      // 调用方不会看到异常，用户看到的还是那段文本。
      await telemetry.log({
        ts: new Date().toISOString(),
        point: "cotTranslate",
        tag: "cotTranslate",
        action: "skip",
        detail: "decision-engine-cot: 决策判定无需翻译，返回原文",
        latencyMs: 0,
        cached: true,
      });
      return text;
    } catch (error) {
      telemetry.noteAdapterError("cotTranslate", error, ctx);
      // 任何意外都必须回到原生行为：翻译不能因为守卫而不可用。
      return original.call(this, spec, signal);
    }
  };

  translator.translate = wrapped;
  // 卸载时恢复原方法：否则插件热卸载后 translator 会一直指着我们的包装。
  ctx.effect(() => () => {
    if (translator.translate === wrapped) translator.translate = original;
  });
  return true;
}
