/**
 * 验收：**新增一个 provider 只需要改 `lib/providers.json`**。
 *
 * 这条承诺无法靠「读一遍 providers.js」证明——真正会漏的是上下游：
 *
 *   1. `lib/providers.js` 的解析（地址、字段名、模型清单、默认 provider）；
 *   2. `lib/index.js` 的 Config schema（新 provider 的三个配置格得能被解析，
 *      否则写进 config.yml 的值会被 Schemastery 丢掉，症状是「配了没反应」）；
 *   3. `providerCatalog()`（界面下拉与字段映射的唯一来源）。
 *
 * 因此这里不是在原仓库里断言常量，而是**复制一份 lib/ 到临时目录**，
 * 往 providers.json 里加一个对象，再真的加载那份副本跑一遍。副本放在仓库
 * 内（`test/.tmp-*`），Node 会沿父目录找到仓库的 node_modules，peer 依赖
 *（@deepseek-ai/schemastery）才解析得到。
 *
 * 运行：node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 造一份「改动过 providers.json」的 lib 副本，并跑一段脚本读它的结果。
 *
 * @param mutate - `(definitions) => definitions`，就地改动 JSON 数组。
 * @param script - 在副本里执行的 ESM 源码；可 `import` 到 `./lib/index.js`。
 * @returns 脚本通过 stdout 输出的 JSON。
 */
function runWithPatchedCatalog(mutate, script) {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-catalog-"));
  try {
    cpSync(join(REPO_ROOT, "lib"), join(dir, "lib"), { recursive: true });
    const presetsPath = join(dir, "lib", "providers.json");
    const definitions = JSON.parse(readFileSync(presetsPath, "utf8"));
    mutate(definitions);
    writeFileSync(presetsPath, `${JSON.stringify(definitions, null, 2)}\n`);

    const entry = join(dir, "entry.mjs");
    writeFileSync(
      entry,
      [
        `const m = await import(${JSON.stringify(pathToFileURL(join(dir, "lib", "index.js")).href)});`,
        script,
      ].join("\n"),
    );
    const out = execFileSync(process.execPath, [entry], { cwd: dir, encoding: "utf8" });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 往数组里追加一个「一家服务、三个模型」的 provider（只写必填与常用项）。 */
function addGateway(definitions) {
  definitions.push({
    id: "my-gateway",
    label: "我的网关",
    labelEn: "My Gateway",
    baseUrl: "https://gw.example.com/v1",
    endpointStyle: "systemone",
    models: ["m-small", "m-large", "m-think"],
    requiresModel: true,
    hint: "自建网关",
    hintEn: "Self-hosted gateway",
  });
}

test("新增 provider 只改 JSON：schema、解析、catalog 三处自动接上", () => {
  const result = runWithPatchedCatalog(
    addGateway,
    `
      const parsed = m.Config({ provider: "my-gateway", myGatewayModel: "m-large", myGatewayApiKey: "sk-x" });
      const provider = m.resolveProvider({ provider: "my-gateway", myGatewayModel: "m-large" });
      const catalog = m.providerCatalog().find((item) => item.id === "my-gateway");
      console.log(JSON.stringify({
        schemaModel: parsed.myGatewayModel,
        schemaKey: parsed.myGatewayApiKey,
        schemaEnv: parsed.myGatewayApiKeyEnv,
        endpoint: provider.endpoint,
        model: provider.model,
        keyEnv: provider.apiKeyEnv,
        catalog: {
          label: catalog.label,
          labelEn: catalog.labelEn,
          models: catalog.models,
          modelField: catalog.modelField,
          keyField: catalog.keyField,
          requiresModel: catalog.requiresModel,
        },
        ids: m.PROVIDER_IDS,
        defaultProvider: m.DEFAULT_PROVIDER,
      }));
    `,
  );

  // 模型留空 = 回落预设默认（models 的第一项）：三条配置格都由 id 推导出来，
  // 因此 JSON 里没写 keyField / modelField / keyEnvField 也能存能读。
  assert.equal(result.schemaModel, "m-large");
  assert.equal(result.schemaKey, "sk-x");
  assert.equal(result.schemaEnv, "");

  assert.equal(result.endpoint, "https://gw.example.com/v1/systemone");
  assert.equal(result.model, "m-large");
  assert.equal(result.keyEnv, "MY_GATEWAY_API_KEY");

  assert.deepEqual(result.catalog, {
    label: "我的网关",
    labelEn: "My Gateway",
    models: ["m-small", "m-large", "m-think"],
    modelField: "myGatewayModel",
    keyField: "myGatewayApiKey",
    requiresModel: true,
  });

  // 追加在末尾：下拉顺序 = 数组顺序，默认 provider 不受影响。
  assert.ok(result.ids.includes("my-gateway"));
  assert.equal(result.defaultProvider, "bamboonode");
});

test("改 JSON 的 default 标记就能换默认 provider（不必改代码）", () => {
  const result = runWithPatchedCatalog(
    (definitions) => {
      for (const definition of definitions) definition.default = definition.id === "systemone";
    },
    `
      const provider = m.resolveProvider({});
      console.log(JSON.stringify({ id: provider.id, endpoint: provider.endpoint, model: provider.model }));
    `,
  );
  assert.equal(result.id, "systemone");
  assert.equal(result.endpoint, "https://api.typesafe.ai/v1/systemone");
});

test("写坏的 providers.json 在加载时就报错（不会静默跑成半套）", () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-catalog-"));
  try {
    cpSync(join(REPO_ROOT, "lib"), join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "providers.json"), '[{"id": "a"}, {"id": "a"}]\n');
    const entry = join(dir, "bad.mjs");
    writeFileSync(
      entry,
      `await import(${JSON.stringify(pathToFileURL(join(dir, "lib", "providers.js")).href)});`,
    );
    assert.throws(
      () => execFileSync(process.execPath, [entry], { cwd: dir, encoding: "utf8", stdio: "pipe" }),
      (error) => String(error.stderr).includes("重复"),
      "重复 id 必须让加载失败，并说明原因",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});