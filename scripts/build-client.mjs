/**
 * 把 `lib/client-src/*.js` 拼成 `lib/client.js`（单文件浏览器 bundle）。
 *
 * 构建逻辑本身在 `scripts/client-bundle.mjs`（纯函数，可被测试只读调用）；
 * 这里只负责读写与 CLI 语义，**不导出任何东西**——避免「import 一次就顺手
 * 重建 bundle」那类副作用。
 *
 * 用法：
 *   node scripts/build-client.mjs           写入 lib/client.js
 *   node scripts/build-client.mjs --check   只校验产物是否与源一致（CI 用）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildBundle } from "./client-bundle.mjs";

const CLIENT_URL = new URL("../lib/client.js", import.meta.url);
const built = buildBundle();

if (process.argv.includes("--check")) {
  const current = readFileSync(CLIENT_URL, "utf8");
  if (current !== built) {
    throw new Error("lib/client.js 与 lib/client-src 不同步：请运行 node scripts/build-client.mjs");
  }
  console.log("lib/client.js 与 lib/client-src 同步");
} else {
  writeFileSync(CLIENT_URL, built);
  console.log(`已写入 lib/client.js（${built.length} 字节）`);
}
