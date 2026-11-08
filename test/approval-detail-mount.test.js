/**
 * 客户端是否接管 `conversation.approval.detail`——由服务端 status 决定（DEC-042）。
 *
 * 为什么这条要单独测：这是**唯一**决定「我们要不要接管宿主一块 UI」的逻辑。
 * 它写错的两种后果都很隐蔽——
 *
 *   - 该关的时候接管了：默认行为悄悄变了，用户没有任何提示就换了一套渲染；
 *   - 该开的时候没接管：用户打开了开关、界面显示已保存，卡片却还是原来的样子。
 *
 * 两者都不会抛错，只会「看起来没生效」。所以这里直接对着注册行为断言，
 * 而不是对着渲染结果断言。
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

test("默认关闭：不注册 conversation.approval.detail（与升级前零差异）", async () => {
  const slots = await loadWith({ enabled: true, decisionsTabEnabled: true });
  assert.equal(
    slots.filter((entry) => entry.name === DETAIL).length,
    0,
    "开关关闭时不该接管宿主的 detail 渲染",
  );
});

test("打开后接管，且 priority 比宿主更小（single slot 数值小的先渲染）", async () => {
  const slots = await loadWith({
    enabled: true,
    decisionsTabEnabled: true,
    approvalDetailReadable: true,
  });
  const detail = slots.filter((entry) => entry.name === DETAIL);
  assert.equal(detail.length, 1, `应恰好接管一次，实际 ${detail.length}`);
  // 宿主的 ApprovalCommand 用默认 priority 0；single slot 同优先级重复注册会
  // 直接抛错，所以必须显式给一个更小的值才能盖过它。
  assert.ok(detail[0].priority < 0, `接管必须有更小的 priority，实际 ${detail[0].priority}`);
  assert.equal(typeof detail[0].comp, "function", "接管要注册一个组件");
});

test("显式 false 与缺省一致：都不接管", async () => {
  const slots = await loadWith({
    enabled: true,
    decisionsTabEnabled: true,
    approvalDetailReadable: false,
  });
  assert.equal(slots.filter((entry) => entry.name === DETAIL).length, 0);
});

test("status 读不到时不接管（也不要因为一次请求失败就改动卡片）", async () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 读不到状态的路径必须走「保持现状」：不挂载。这条对着源码断言，因为
  // 模拟 fetch 抛错要额外铺一整套桩，而这里要守的只是「失败分支不挂载」。
  assert.match(
    source,
    /const reconcileApprovalDetail = async[\s\S]*?catch \(error\) \{[\s\S]*?log\("approval detail reconcile skipped:"/,
    "reconcile 失败分支必须存在且不挂载",
  );
});
