/**
 * 确定性语料生成器（零依赖，固定种子）。
 *
 * 关键约束：**baseline 与 after 两次运行必须生成逐字节相同的语料**，否则
 * 差值里混的是「语料不同」而不是「代码不同」。因此这里不读时间、不用
 * Math.random()，只用 mulberry32(固定 seed)。
 *
 * @module bench/lib/fixtures
 */

import { makeRng } from "./harness.mjs";

const CJK_CHARS = "决策引擎风险授权模型中文语料统计缓存令牌端点配置会话审批工具调用最近对话摘要服务端下发".split("");
const ASCII_WORDS = [
  "node", "--test", "src/index.js", "git", "push", "origin", "main", "npm", "run", "build",
  "ls", "-la", "cat", "file.txt", "grep", "-rn", "pattern", "lib", "const", "value", "return",
  "function", "async", "await", "fetch", "Response", "status", "error", "undefined", "Object",
];

/** 拼一段长度约 n 字符的 ASCII 文本（词间空格）。 */
function asciiText(rng, n) {
  const parts = [];
  let len = 0;
  while (len < n) {
    const w = ASCII_WORDS[Math.floor(rng() * ASCII_WORDS.length)];
    parts.push(w);
    len += w.length + 1;
  }
  return parts.join(" ").slice(0, n);
}

/** 拼一段长度约 n 字符的 CJK 文本。 */
function cjkText(rng, n) {
  let out = "";
  while (out.length < n) {
    out += CJK_CHARS[Math.floor(rng() * CJK_CHARS.length)];
  }
  return out.slice(0, n);
}

/**
 * 构造一个「发给决策模型的 state」文本。
 *
 * @param bytes - 目标字符数（1024 / 65536 / 524288 这一档）。
 * @param flavor - "ascii" | "cjk" | "mixed"（mixed = 70% ASCII + 30% CJK，最接近真实）。
 * @param seed
 */
export function makeStateText(bytes, flavor, seed = 1234) {
  const rng = makeRng(seed);
  if (flavor === "ascii") return asciiText(rng, bytes);
  if (flavor === "cjk") return cjkText(rng, bytes);
  const cjkLen = Math.floor(bytes * 0.3);
  const asciiLen = bytes - cjkLen;
  // 交替拼接，让 CJK 分散在文本里（连续同字符是 tokenizer 文档里点名的病态样本）。
  const chunk = 256;
  let ascii = asciiText(rng, asciiLen);
  let cjk = cjkText(rng, cjkLen);
  const out = [];
  let ai = 0;
  let ci = 0;
  while (ai < ascii.length || ci < cjk.length) {
    if (ai < ascii.length) {
      out.push(ascii.slice(ai, ai + chunk));
      ai += chunk;
    }
    if (ci < cjk.length) {
      out.push(cjk.slice(ci, ci + chunk * 0.3));
      ci += Math.floor(chunk * 0.3);
    }
  }
  return out.join("").slice(0, bytes);
}

/** 包装成 engine 实际传给 cache/tokenizer 的 state 对象形状。 */
export function makeStateObject(bytes, flavor, seed) {
  const text = makeStateText(bytes, flavor, seed);
  return {
    tool: "bash",
    session_id: "sess-bench-0001",
    args_preview: text.slice(0, 512),
    recent: [{ role: "user", text: text.slice(0, 128) }],
    cwd: "/Users/chi/Code/dsh-decision-engine",
    context: text,
  };
}

/**
 * 5k 条命令语料（riskFlags 的用例）。
 *
 * 刻意覆盖：干净命令、含 rm/sudo/curl/管道/重定向/subshell/git push 的高危命令、
 * 带前导环境变量赋值的、含 SQL drop 的、以及中文参数的。riskFlags 的成本几乎
 * 完全由「模式命中与否」决定，所以这个分布决定测量结果有没有代表性。
 */
export function makeCommandCorpus(count = 5000, seed = 777) {
  const rng = makeRng(seed);
  const templates = [
    "ls -la",
    "cat package.json",
    "node --test test/engine.test.js",
    "git status --porcelain",
    "git diff HEAD -- lib",
    "npm run build",
    "rg -n 'pattern' lib",
    "python3 -c \"print(1)\"",
    "sed -n 10,25p README.md",
    "mkdir -p /tmp/out",
    "rm -rf /tmp/out",
    "sudo npm install -g typescript",
    "git push origin main",
    "git reset --hard HEAD~1",
    "curl -sS https://api.example.com/v1/decisions | jq .",
    "echo hello > /tmp/a.txt",
    "echo hi >> /tmp/a.txt",
    "cat foo | grep bar | wc -l",
    "node build.js && npm test",
    "kill $(pgrep node)",
    "eval \"$CMD\"",
    "npm publish --access public",
    "scp file.txt user@host:/tmp/",
    "DROP TABLE users",
    "defaults write com.apple.finder AppleShowAllFiles -bool true",
    "chmod 755 script.sh",
    "mv a.txt b.txt",
    "docker ps -a",
    "FOO=1 BAR=2 node -e 'console.log(1)'",
    "ls 决策引擎 目录",
    "tail -f logs/app.log",
    "pnpm publish",
    "security delete-keychain login.keychain",
    "systemctl restart nginx",
    "dd if=/dev/zero of=/tmp/x bs=1m count=10",
  ];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const base = templates[Math.floor(rng() * templates.length)];
    // 加一点长度变化，避免所有输入同长（真实语料的长度分布很宽）。
    const pad = rng() < 0.25 ? ` # ${asciiText(rng, Math.floor(rng() * 200))}` : "";
    out.push(base + pad);
  }
  return out;
}

/**
 * 20k 条 stats 记录（stats.aggregate 的用例）。
 *
 * 字段形状对齐 lib/stats.js buildRecord 的产物。provider/model/point 的组合数
 * 刻意保持小（真实数据就是这样：几个 provider × 几个 model × 8 个决策点），
 * 因为 aggregate 的成本主要由 Map 命中/未命中比例决定。
 */
export function makeStatsRecords(count = 20000, seed = 4242) {
  const rng = makeRng(seed);
  const providers = ["bamboonode", "systemone", "siliconflow", "custom"];
  const models = ["kev-4b", "system-one", "Qwen3-32B", "gpt-ish-mini"];
  const points = ["tool_authorize", "model_routing", "delegation", "compaction", "turn_continue", "retrieval", "skill_pick", "cot_translate"];
  const actions = ["allow", "ask", "reject", ""];
  const modes = ["observe", "enforce", "off", "unknown"];
  const base = Date.now();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const inputTokens = Math.floor(rng() * 3000) + 120;
    const outputTokens = Math.floor(rng() * 220) + 8;
    const durationMs = Math.floor(rng() * 2000) + 30;
    const mode = modes[Math.floor(rng() * modes.length)];
    const cached = rng() < 0.15;
    const degraded = rng() < 0.08;
    // 时间戳散在最近 90 天内，保证区间过滤真的会滤掉一部分。
    const ts = new Date(base - Math.floor(rng() * 90 * 24 * 3600 * 1000)).toISOString();
    out.push({
      ts,
      provider: providers[Math.floor(rng() * providers.length)],
      model: models[Math.floor(rng() * models.length)],
      point: points[Math.floor(rng() * points.length)],
      mode,
      action: actions[Math.floor(rng() * actions.length)],
      detail: rng() < 0.3 ? "命令包含 rm，风险标记 2 个" : "",
      cached,
      degraded,
      inputTokens,
      outputTokens,
      durationMs,
      baseInputTokens: cached ? inputTokens : Math.floor(inputTokens * (1.4 + rng())),
      baseOutputTokens: outputTokens,
      baseDurationMs: Math.floor(durationMs * (1.1 + rng() * 0.6)),
      inputSource: rng() < 0.8 ? "api" : "estimated",
      outputSource: rng() < 0.8 ? "api" : "estimated",
    });
  }
  return out;
}

/**
 * 20k 行 decisions.jsonl（存储层加载用例）。
 *
 * 形状对齐 lib/decision-store.js buildDecisionRecord 的产物，包含
 * content.state（最长字段）。字节长度要接近真实文件（每行约 600B）。
 */
export function makeDecisionLines(count = 20000, seed = 909) {
  const rng = makeRng(seed);
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(Date.now() - i * 3000).toISOString();
    const rec = {
      v: 1,
      seq: i,
      id: `bench-${i}`,
      ts,
      sessionId: rng() < 0.7 ? "sess-target" : `sess-${Math.floor(rng() * 50)}`,
      point: "tool_authorize",
      tool: "bash",
      action: ["allow", "ask", "reject"][Math.floor(rng() * 3)],
      mode: rng() < 0.7 ? "observe" : "enforce",
      risk: Math.floor(rng() * 4),
      latencyMs: Math.floor(rng() * 900),
      content: {
        state: {
          tool: "bash",
          args_preview: makeStateText(180, "mixed", i + 1),
          cwd: "/Users/chi/Code/dsh-decision-engine",
          recent: [{ role: "user", text: makeStateText(90, "cjk", i + 7) }],
        },
        questions: ["这个命令是否安全？"],
        answers: { danger: "low", reversible: true },
      },
      apiKey: "sk-abcdefghijklmnop1234",
    };
    lines.push(JSON.stringify(rec));
  }
  return lines;
}

/** 写一个 JSONL 临时文件，返回路径。 */
export async function writeJsonl(dirPath, fileName, lines) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(dirPath, { recursive: true });
  const path = join(dirPath, fileName);
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

/** 一个真实的自定义 provider 配置样本（resolveProvider 的输入）。 */
export function makeProviderConfigs() {
  return [
    { id: "bamboonode", cfg: { provider: "bamboonode", thinkMode: "never", apiKeyEnv: "" } },
    { id: "systemone", cfg: { provider: "systemone", systemoneModel: "" } },
    { id: "bogus", cfg: { provider: "nope-not-a-provider", model: "x" } },
    {
      id: "siliconflow",
      cfg: { provider: "siliconflow", siliconflowModel: "", siliconflowApiKey: "sk-x", thinkMode: "auto" },
    },
    {
      id: "custom-full",
      cfg: {
        provider: "custom",
        customBaseUrl: "https://api.example.com/v1/",
        customEndpointStyle: "auto",
        customModel: " my-model ",
        customApiKeyEnv: " MY_KEY ",
        customHeaders: "X-A: 1\nX-B: 2",
        customApiKey: "sk-secret",
      },
    },
    { id: "custom-bad", cfg: { provider: "custom", customBaseUrl: "not a url", customEndpointStyle: "decisions" } },
    { id: "custom-origin", cfg: { provider: "custom", customBaseUrl: "http://localhost:8080", customEndpointStyle: "systemone" } },
    { id: "legacy", cfg: { provider: "bamboonode", baseUrl: "api.old.example.com/v1", apiKeyEnv: "BAMBOO_OLD_KEY" } },
    { id: "empty", cfg: {} },
  ];
}

/** 一组 base URL（buildEndpoint / endpointCandidates 的输入）。 */
export const BASE_URL_CASES = [
  "https://api.example.com",
  "https://api.example.com/",
  "https://api.example.com/v1",
  "https://api.example.com/v1/",
  "https://api.example.com/v1/decisions",
  "https://api.example.com/api/v1",
  "http://localhost:8080",
  "api.example.com/v1",
  "https://api.example.com/v1?x=1",
  "",
];
