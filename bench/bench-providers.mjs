#!/usr/bin/env node
/**
 * providers 基准：resolveProvider / buildEndpoint / endpointCandidates /
 * validateBaseUrl / buildHeaders / buildRequestBody / providerCatalog。
 *
 * 用法：node bench/bench-providers.mjs [treeRoot] [--json=out.json]
 *
 * 关注点（task-6 点名）：正则字面量是否在函数内每次重建、同一字符串上是否
 * 重复 `new URL()`、重复 toLowerCase/trim。resolveProvider 是**每次决策**都要跑
 * 的（配置每请求重解析是刻意设计），所以它的单价直接乘在守卫路径上。
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { bench, parseArgs, printTable, emit, sink } from "./lib/harness.mjs";
import { makeProviderConfigs, BASE_URL_CASES } from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), import.meta.url);
const p = await import(pathToFileURL(join(args.tree, "lib/providers.js")).href);

const configs = makeProviderConfigs();
const payload = {
  point: "tool_authorize",
  state: { tool: "bash", args_preview: "ls -la", cwd: "/tmp", recent: [{ role: "user", text: "你好" }] },
  questions: { danger: ["low", "high"] },
};

const rows = [];

for (const { id, cfg } of configs) {
  rows.push(bench(`resolveProvider(${id})`, () => sink.o = p.resolveProvider(cfg), {
    iterations: 20000, rounds: 5, warmup: 3,
  }));
}
// 服务端下发覆盖分支（另一条热路径）
const server = { baseUrl: "https://srv.example.com/v1", model: "srv-model", endpointStyle: "auto" };
rows.push(bench("resolveProvider(server override)", () => sink.o = p.resolveProvider({}, { server }), {
  iterations: 20000, rounds: 5, warmup: 3,
}));

rows.push(bench("buildEndpoint(10 url cases)", (i) => {
  sink.s += p.buildEndpoint(BASE_URL_CASES[i % BASE_URL_CASES.length], "decisions");
}, { iterations: 50000, rounds: 5, warmup: 3 }));
rows.push(bench("endpointCandidates(auto, 10 cases)", (i) => {
  sink.n += p.endpointCandidates(BASE_URL_CASES[i % BASE_URL_CASES.length], "auto").length;
}, { iterations: 50000, rounds: 5, warmup: 3 }));
rows.push(bench("validateBaseUrl(10 cases)", (i) => {
  sink.o = p.validateBaseUrl(BASE_URL_CASES[i % BASE_URL_CASES.length]);
}, { iterations: 100000, rounds: 5, warmup: 3 }));
rows.push(bench("normalizeBaseUrl(10 cases)", (i) => {
  sink.s += p.normalizeBaseUrl(BASE_URL_CASES[i % BASE_URL_CASES.length]);
}, { iterations: 200000, rounds: 5, warmup: 3 }));

const headerRaw = "X-A: 1\r\nX-B: 2\r\nAuthorization: Bearer abc.def\r\nbad line\r\nX-C:";
rows.push(bench("parseCustomHeaders(4 lines)", () => sink.n += Object.keys(p.parseCustomHeaders(headerRaw)).length, {
  iterations: 50000, rounds: 5, warmup: 3,
}));
rows.push(bench("parseCustomHeaders(empty)", () => sink.n += Object.keys(p.parseCustomHeaders("")).length, {
  iterations: 200000, rounds: 5, warmup: 3,
}));

const resolved = p.resolveProvider(configs[0].cfg);
rows.push(bench("buildHeaders(preset)", () => sink.o = p.buildHeaders(resolved, "sk-test-key"), {
  iterations: 50000, rounds: 5, warmup: 3,
}));
rows.push(bench("buildRequestBody(preset)", () => sink.s += JSON.stringify(p.buildRequestBody(resolved, payload)).length, {
  iterations: 20000, rounds: 5, warmup: 3,
}));
rows.push(bench("providerCatalog()", () => sink.n += p.providerCatalog().length, {
  iterations: 5000, rounds: 5, warmup: 2,
}));
rows.push(bench("normalizeThinkMode(rotate)", (i) => sink.s += p.normalizeThinkMode(["never", "auto", "always", "junk"][i % 4]), {
  iterations: 200000, rounds: 5, warmup: 3,
}));

// 端到端：一次真实决策前的 provider 解析 + 请求体构造（守卫路径的完整 prep 成本）
rows.push(bench("E2E prep: resolve+headers+body", () => {
  const r = p.resolveProvider(configs[3].cfg);
  sink.o = p.buildHeaders(r, "sk-abc");
  sink.s += JSON.stringify(p.buildRequestBody(r, payload)).length;
  sink.n += p.endpointCandidates(r.baseUrl, r.endpointStyle).length;
}, { iterations: 10000, rounds: 5, warmup: 3 }));

printTable(`providers @ ${args.tree}`, rows);

const semantic = {
  presetIds: p.PROVIDER_IDS,
  defaultProvider: p.DEFAULT_PROVIDER,
  endpoints: configs.map(({ id, cfg }) => [id, p.resolveProvider(cfg).endpoint]),
  candidatesOrigin: p.endpointCandidates("https://api.example.com", "auto"),
  candidatesSystemone: p.endpointCandidates("https://api.example.com/v1", "systemone"),
  candidatesFull: p.endpointCandidates("https://api.example.com/v1/decisions", "auto"),
  validateErrors: BASE_URL_CASES.map((u) => [u, p.validateBaseUrl(u).ok, p.validateBaseUrl(u).error ?? ""]),
  catalogLen: p.providerCatalog().length,
  bodyKeys: Object.keys(p.buildRequestBody(resolved, payload)),
};
console.log("\n语义指纹:", JSON.stringify(semantic).slice(0, 2000));

await emit(args, { meta: { suite: "providers", tree: args.tree }, semantic, rows });
