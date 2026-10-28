/**
 * 错误尾部的**渲染**测试（真的把客户端 bundle 跑起来）。
 *
 * 与 test/client-errors.test.js 的分工：
 *
 *   client-errors.test.js   纯逻辑（归一化、归拢、折叠）——不碰 react
 *   本文件                  客户端 bundle 真的加载一次，看它挂了什么槽位、
 *                           错误尾部真的渲染成什么样
 *
 * 为什么要有本文件：槽位注册与渲染都是「写错了不会报错、只是什么都不显示」
 * 的那类代码——比如 `id` 写成了 `key`（会覆盖别人的格子），
 * 或者组件忘了返回 null（没错误时也占一行）。语法检查抓不到这些。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** 每次加载都要拿到一份新的模块实例，否则 factory 只会跑第一次。 */
let loadSeq = 0;

/**
 * 加载客户端 bundle，返回它注册的所有槽位与 Definition。
 *
 * @returns 注册表：`slots` 是 `[{ name, id, key, order, component }]`，
 *   `definition` 是注册到 uiConversation 的那个 conversation Definition。
 */
async function loadBundle() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  loadSeq += 1;
  const unique = `\n// test-instance-${loadSeq}\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source + unique, "utf8").toString("base64")}`;

  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect() {
      /* SSR 语义：effect 不执行 */
    },
    useMemo: (fn) => fn(),
  };

  const slots = [];
  let definition;
  let component;

  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const bundle = factory((name) => {
          if (name === "react") return reactStub;
          throw new Error(`unexpected require: ${name}`);
        });
        const ctx = {
          logger: { info() {}, warn() {} },
          locale: { register: () => () => {} },
          slots: {
            inject(_slot, callback) {
              callback();
              return () => {};
            },
            register(meta, comp) {
              slots.push({ ...meta, component: comp });
              return () => {};
            },
          },
          uiConversation: {
            events: {
              register(definitionValue) {
                definition = definitionValue;
                return () => {};
              },
            },
          },
          effect(body) {
            // cordis 的 effect 有两种形态：generator（yield 出 disposer）
            // 与普通函数（返回 disposer）。这里两种都支持，
            // 否则「普通函数形态的 effect」会在测试里被误判成注册失败。
            if (typeof body === "function" && body.constructor?.name === "GeneratorFunction") {
              const iterator = body();
              let step = iterator.next();
              while (!step.done) step = iterator.next(step.value);
              return () => {};
            }
            const disposer = body();
            return typeof disposer === "function" ? disposer : () => {};
          },
        };
        bundle.apply(ctx);
        component = slots[0]?.component;
      },
    },
  };

  await import(dataUrl);
  return { slots, definition, component };
}

/** 递归收集渲染树里的文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === "object") {
    const props = node.props ?? {};
    if (typeof props.title === "string") out.push(props.title);
    collectText(node.children, out);
  }
  return out;
}

/** 造一个 turnTail 的 owner：只带本插件读得到的那部分（turn.data.get）。 */
function ownerWith(turn, errors) {
  return {
    turn: {
      turn,
      data: {
        get: (key) =>
          key === "decision-engine-error"
            ? { kind: "turn", turn, key, value: { errors } }
            : undefined,
      },
    },
    seq: 1,
    openFile() {},
  };
}

test("客户端 bundle 注册了 conversation.chat.turnTail 槽位", async () => {
  const { slots } = await loadBundle();
  const tail = slots.find((entry) => entry.name === "conversation.chat.turnTail");
  assert.ok(tail, `没有注册 turnTail 槽位，实际注册了：${slots.map((s) => s.name).join(", ")}`);
});

test("客户端 bundle 注册了 conversation Definition（错误事件的入口）", async () => {
  const { definition } = await loadBundle();
  assert.ok(definition, "没有注册 conversation Definition");
  assert.equal(definition.kind, "decision-engine-error");
  assert.equal(definition.target, "chat");
});

test("错误尾部：没有错误时返回 null（正常的轮次不占位）", async () => {
  const { slots } = await loadBundle();
  const tail = slots.find((entry) => entry.name === "conversation.chat.turnTail");
  assert.equal(tail.component(ownerWith(1, [])), null);
  // 连 owner 都没有时也不能炸。
  assert.equal(tail.component(undefined), null);
});

test("错误尾部：渲染出决策点、分类与工具名", async () => {
  const { slots } = await loadBundle();
  const tail = slots.find((entry) => entry.name === "conversation.chat.turnTail");
  const tree = tail.component(
    ownerWith(3, [
      { turn: 3, point: "authorize", code: "auth-failed", label: "鉴权被拒", tool: "bash" },
    ]),
  );
  assert.ok(tree, "有错误时不该返回 null");
  const text = collectText(tree).join("\n");
  assert.ok(text.includes("工具授权"), `应显示决策点中文名，实际：\n${text}`);
  assert.ok(text.includes("鉴权被拒"), `应显示错误分类，实际：\n${text}`);
  assert.ok(text.includes("bash"), `应显示触发的工具名，实际：\n${text}`);
});

test("错误尾部：一轮多条错误各占一行", async () => {
  const { slots } = await loadBundle();
  const tail = slots.find((entry) => entry.name === "conversation.chat.turnTail");
  const tree = tail.component(
    ownerWith(4, [
      { turn: 4, point: "authorize", code: "timeout", label: "决策请求超时" },
      { turn: 4, point: "retrieval", code: "no-key", label: "未配置 API key" },
    ]),
  );
  const text = collectText(tree).join("\n");
  assert.ok(text.includes("工具授权"), text);
  assert.ok(text.includes("检索必要性"), text);
  assert.ok(text.includes("决策请求超时"), text);
  assert.ok(text.includes("未配置 API key"), text);
});

test("错误尾部：turnTail 用自己的 id 注册（列表型槽位不能覆盖别人的格子）", async () => {
  const { slots } = await loadBundle();
  const tail = slots.find((entry) => entry.name === "conversation.chat.turnTail");
  assert.equal(tail.id, "decision-engine-errors", "必须用自己的 id");
  assert.equal(tail.key, undefined, "列表型槽位不该用 key（key 会顶掉别人的格子）");
});
