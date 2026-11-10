/**
 * `react/jsx-runtime` 的最小垫片：把 JSX 产物接到宿主给的 `react` 上。
 *
 * 为什么需要这个文件：microcharts 的构建产物内部 import
 * `react/jsx-runtime`（自动 JSX 运行时），而宿主 factory 只保证
 * `require("react")` 可用——`react/jsx-runtime` 不在平台种子表里。
 * 与其赌宿主会暴露第二个种子词，不如把 jsx 调用翻成
 * `createElement`，让整份产物**只依赖 react**（唯一的 peer）。
 *
 * 语义要点：
 *   - `children` 是 props 的一个键，不是独立参数，必须拆出来当第三参；
 *   - key 在 createElement 里走第三参的位置（这里直接赋值给元素），
 *     不能塞进 props（否则 React 会当成普通属性警告）。
 *
 * 这是构建期私有垫片，不对外发布。
 */
import { createElement, Fragment } from "react";

/** 统一的 jsx/jsxs/jsxDEV 实现：三者在本库产物里的行为一致。 */
function jsx(type, props, key) {
  const { children, ...rest } = props ?? {};
  const args =
    children === undefined
      ? [type, rest]
      : [type, rest, ...(Array.isArray(children) ? children : [children])];
  const element = createElement(...args);
  if (key !== undefined && element !== null && typeof element === "object") element.key = key;
  return element;
}

const jsxs = jsx;
const jsxDEV = jsx;

export { jsx, jsxs, jsxDEV, Fragment };
