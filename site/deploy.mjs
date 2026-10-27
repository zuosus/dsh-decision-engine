// 把 site/worker/bundle.js 部署成 Cloudflare Worker，并挂上自定义域名。
//
//   export CLOUDFLARE_API_TOKEN=...
//   node site/deploy.mjs
//
// 也可以先只上传不挂域名：node site/deploy.mjs --no-domain
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 令牌来源优先级：环境变量 > site/.env（site/.env* 已在 .gitignore 里）
function resolveToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const envFile = path.join(HERE, ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
const ACCOUNT = "48bfaa4269a02470c2d6529a56b05f23";
const ZONE = "3db8f90f7f15b16e1c6c995fab875a31";
const SCRIPT = "dsh-worker"; // 用户在 CF 后台起的名字；域名 dsh.zuos.us 绑在它上面
const HOSTNAME = "dsh.zuos.us";
const API = "https://api.cloudflare.com/client/v4";

const token = resolveToken();
if (!token) {
  console.error(
    "缺少 CLOUDFLARE_API_TOKEN。\n" +
      "用法一：export CLOUDFLARE_API_TOKEN=... && node site/deploy.mjs\n" +
      "用法二：把 CLOUDFLARE_API_TOKEN=... 写进 site/.env"
  );
  process.exit(1);
}

const noDomain = process.argv.includes("--no-domain");

async function cf(method, urlPath, { body, contentType } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: false, errors: [{ message: text.slice(0, 400) }] };
  }
  if (!res.ok || !json.success) {
    const msg = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${urlPath} -> HTTP ${res.status} ${msg}`);
  }
  return json.result;
}

const script = await readFile(path.join(HERE, "worker/bundle.js"), "utf8");

// Worker 脚本上传只接受 multipart/form-data：metadata 里声明 main_module，
// 脚本本身作为一个 part，Content-Type 必须是 javascript+module。
function scriptForm(scriptText, compatibilityDate) {
  const boundary = `----dshdeploy${Date.now().toString(36)}`;
  const metadata = JSON.stringify({
    main_module: "worker.js",
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, logs: { enabled: true, invocation_logs: true } },
    tags: ["dsh-site"],
  });
  const parts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    metadata,
    `--${boundary}`,
    'Content-Disposition: form-data; name="worker.js"; filename="worker.js"',
    "Content-Type: application/javascript+module",
    "",
    scriptText,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body: parts, contentType: `multipart/form-data; boundary=${boundary}` };
}

console.log(`上传 Worker ${SCRIPT}（${(script.length / 1024).toFixed(1)} KB）…`);
await cf("PUT", `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`, scriptForm(script, "2026-10-26"));
console.log("  ✓ 脚本已上传");

if (!noDomain) {
  console.log(`挂载自定义域名 ${HOSTNAME}（Cloudflare 会自动创建 DNS 记录）…`);
  let domain;
  try {
    domain = await cf("PUT", `/accounts/${ACCOUNT}/workers/domains`, {
      body: JSON.stringify({ hostname: HOSTNAME, service: SCRIPT, zone_id: ZONE }),
      contentType: "application/json",
    });
    console.log("  ✓ 域名已挂载", JSON.stringify({ id: domain.id, hostname: domain.hostname, service: domain.service }));
  } catch (err) {
    // 已经挂过同一个 hostname 会报错，这种情况不算失败。
    const existing = await cf("GET", `/accounts/${ACCOUNT}/workers/domains`).catch(() => []);
    const hit = (existing ?? []).find((d) => d.hostname === HOSTNAME);
    if (hit) {
      console.log("  ✓ 域名已存在（复用）", JSON.stringify({ id: hit.id, service: hit.service }));
    } else {
      throw err;
    }
  }

  const domains = await cf("GET", `/accounts/${ACCOUNT}/workers/domains`);
  console.log("\n当前 Worker 域名:");
  for (const d of domains) console.log(`  ${d.hostname} -> ${d.service}`);
}

console.log(`\n完成：https://${HOSTNAME}/`);
