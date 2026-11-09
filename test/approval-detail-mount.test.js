/**
 * 客户端是否接管 `conversation.approval.detail`——由服务端 status 决定
 * （DEC-042 / DEC-043）。
 *
 * 为什么这条要单独测：这是**唯一**决定「我们要不要接管宿主一块 UI」的逻辑。
 * DEC-043 把默认值翻成「开」之后，它写错的两种后果都比以前更贵——
 *
 *   - 该开的时候没接管（这是新的主要风险）：status 里没有这一项就等于旧
 *     服务端或没写过这一项的 config.yml。若客户端把「缺省」读成关，那么
 *     默认开就只对「配置页拨过一次」的人生效，大多数人看到的仍是旧卡片，
 *     而这与升级说明不符、且不会抛任何错；
 *   - 该关的时候接管了：显式关掉是用户拿回宿主原渲染的唯一途径，读错就等于
 *     让人关不掉——同样不会抛错，只会「看起来没生效」。
 *
 * 两者都不会抛错，只会「看起来没生效」。所以这里直接对着注册行为断言，
 * 而不是对着渲染结果断言：注册了就是接管了，没注册就是没接管。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let loadSeq = 0;

/**
 * 加载 client bundle，记录它往哪些 slot 注册了什么。
 *
 * @param status - `/status` 的响应（决定各开关的挂载行为）。
 * @returns `{ slots, priorities }`：注册到的 slot 名列表，以及每个 slot 的 priority。
 */
async function loadWith(status) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(
    `${source}\n// mount-test-${loadSeq}\n`,
    "utf8",
  ).toString("base64")}`;

  const registered = [];
  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback(fn) {
      return fn;
    },
    useRef(value) {
      return { current: value };
    },
    useEffect() {},
    useMemo(fn) {
      return fn();
    },
  };

  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
        const ctx = {
          logger: { info() {}, warn() {} },
          locale: {
            register: () => () => {},
            getSnapshot: () => ({ active: "zh", locales: [], revision: 1 }),
            subscribe: () => () => {},
          },
          slots: {
            inject(_slot, callback) {
              callback();
              return () => {};
            },
            register(meta, comp) {
              registered.push({ name: meta.name, priority: meta.priority, id: meta.id, comp });
              return () => {};
            },
          },
          effect(body) {
            const iterator = body();
            let step = iterator.next();
            while (!step.done) step = iterator.next(step.value);
            return () => {};
          },
        };
        // `/status` 由 apply() 里的 reconcile 读取：替换全局 fetch。
        globalThis.fetch = async () => ({
          ok: true,
          text: async () => JSON.stringify(status),
        });
        bundle.apply(ctx);
      },
    },
  };

  await import(dataUrl);
  // reconcile 是 async 的，等它落定（含 chain 上的微任务）。
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return registered;
}

const DETAIL = "conversation.approval.detail";

/** 数一数接管了几次。single slot 上「多于一次」和「零次」是两种不同的错。 */
async function countDetailMounts(status) {
  const slots = await loadWith(status);
  return slots.filter((entry) => entry.name === DETAIL).length;
}

test("status 里没有这个字段也照样接管（旧服务端 / 没写过这一项的 config.yml）", async () => {
  // 这是「默认开」的核心：缺省必须等于开。翻默认值之前，这一条断言的是
  // 0——所以它同时也是这次语义翻转的锚点：谁把 `!== false` 改回 `=== true`，
  // 这里立刻从 1 变成 0。
  const mounts = await countDetailMounts({ enabled: true, decisionsTabEnabled: true });
  assert.equal(mounts, 1, `缺省应当接管，实际注册 ${mounts} 次`);
});

test("接管时 priority 比宿主更小（single slot 数值小的先渲染）", async () => {
  // 用「缺省」这一路来驱动：默认开之后，绝大多数人走的就是这条路径，
  // priority 也是在这条路径上最容易漏配。
  const slots = await loadWith({ enabled: true, decisionsTabEnabled: true });
  const detail = slots.filter((entry) => entry.name === DETAIL);
  assert.equal(detail.length, 1, `应恰好接管一次，实际 ${detail.length}`);
  // 宿主的 ApprovalCommand 用默认 priority 0；single slot 同优先级重复注册会
  // 直接抛错，所以必须显式给一个更小的值才能盖过它。
  assert.ok(detail[0].priority < 0, `接管必须有更小的 priority，实际 ${detail[0].priority}`);
  assert.equal(typeof detail[0].comp, "function", "接管要注册一个组件");
});

test("显式 false 才是不接管：用户的退出通道必须精确", async () => {
  const mounts = await countDetailMounts({
    enabled: true,
    decisionsTabEnabled: true,
    approvalDetailReadable: false,
  });
  // 这里必须是严格的 0，不能是「小于 1」之类的宽松判断——多注册一次在
  // single slot 上会直接让宿主的注册抛错，整个审批卡都崩掉。
  assert.equal(mounts, 0, "显式关闭时不该接管宿主的 detail 渲染");
});

test("只有三种状态：缺省 = 开、true = 开、false = 关（1 / 1 / 0）", async () => {
  // 把三态放在同一个用例里跑，是为了让「缺省」与「显式 true」的等价关系
  // 显式可见。分开写的话，很容易出现「缺省测过、true 测过」但两边被改成
  // 不同语义却没人发现的情况——而默认值翻转最典型的回归恰恰是这两个分叉。
  const base = { enabled: true, decisionsTabEnabled: true };
  assert.equal(await countDetailMounts(base), 1, "缺省必须接管");
  assert.equal(
    await countDetailMounts({ ...base, approvalDetailReadable: true }),
    1,
    "显式 true 必须接管",
  );
  assert.equal(
    await countDetailMounts({ ...base, approvalDetailReadable: false }),
    0,
    "显式 false 必须不接管",
  );
});

test("status 读不到时保持现状（也不要因为一次请求失败就改动卡片）", async () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 读不到状态的路径必须走「保持现状」：既不挂载也不卸载。这条对着源码
  // 断言，因为模拟 fetch 抛错要额外铺一整套桩，而这里要守的只是「失败
  // 分支存在，且没有顺手把卡片拆掉」。
  //
  // 判定那半句必须一起进正则：默认翻成「开」之后，把 `!== false` 写成
  // `=== true` 不会让 catch 消失，只让「缺省」悄悄变回关——光断言 catch
  // 存在的话，这条测试在语义已经错了的情况下依然全绿。
  assert.match(
    source,
    /const reconcileApprovalDetail = async[\s\S]*?if \(status\?\.approvalDetailReadable !== false\)\s*mountApprovalDetail\(\);[\s\S]*?catch \(error\) \{[\s\S]*?log\("approval detail reconcile skipped:"/,
    "reconcile 必须以 !== false 判定，且失败分支只记日志、保持现状",
  );
});
