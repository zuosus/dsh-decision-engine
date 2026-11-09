/**
 * Worker 采集/日报端（`site/make-bundle.mjs` 生成的 bundle）与 D1 schema 的一致性检查。
 *
 * 为什么需要这个文件：`site/` 没有任何测试，而 cron 逻辑（`runDigest`）
 * **在本地根本不会被执行**——`wrangler dev` 不会自动跑 cron，只有部署后每天
 * 到点才跑一次。这意味着一条写错的 SQL 可以安静地躺在仓库里，直到某天的
 * 日报「什么都没发出来」，而日志里只有一行被 catch 掉的警告。
 *
 * 2026-11-02 就发生过一次：`SELECT version ... FROM installs` 报
 * `SQLITE_ERROR: no such column: version`，因为 `installs` 表里只有
 * `first_version` / `last_version`。整条日报因此永远发不出来。
 *
 * 所以这里做**静态一致性检查**：从 bundle 里抽出所有 SQL，与迁移文件里
 * 真实的表/列定义比对。它不需要 D1、不需要网络，也不会被 cron 调度，是
 * 能在 CI 里拦住同类错误的唯一一层。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "site");
const MIGRATIONS = join(SITE, "migrations");
const BUNDLER = join(SITE, "make-bundle.mjs");

/**
 * 从迁移 SQL 里解析出每张表的列名。
 *
 * 只认 `CREATE TABLE <name> ( <col> ... )` 这种形态——本项目的迁移文件就是
 * 这么写的，不需要通用 SQL 解析器。
 *
 * @param sql - 迁移文件全文。
 * @returns 表名 → 列名集合。
 */
export function parseSchema(sql) {
  const tables = {};
  // 迁移里会用「建新表 -> 搬数据 -> 改名」的方式升级表结构（SQLite 不能改主键）。
  // 因此必须**按出现顺序**同时处理 CREATE 与 RENAME：只看 CREATE 会拿到升级前的
  // 旧定义，检查器就会误报「plugin 列不存在」。
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*;|ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gi;
  let m;
  while ((m = pattern.exec(sql)) !== null) {
    if (m[1] !== undefined) {
      const name = m[1].toLowerCase();
      const columns = new Set();
      for (const rawLine of m[2].split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        // 跳过表级约束行（PRIMARY KEY (...) / FOREIGN KEY / UNIQUE ...）。
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
        const col = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (col) columns.add(col[1].toLowerCase());
      }
      tables[name] = columns;
    } else {
      // 改名：把旧名字的定义搬到新名字上，并删掉临时名。
      const from = m[3].toLowerCase();
      const to = m[4].toLowerCase();
      if (tables[from] !== undefined) {
        tables[to] = tables[from];
        delete tables[from];
      }
    }
  }
  return tables;
}

/**
 * 从 bundle 源码里抽出所有 SQL 语句，并保留它在文件里的位置（行号）。
 *
 * bundle 里的 SQL 全部是双引号字符串字面量，且都以 SELECT / INSERT / UPDATE
 * 开头。抽出来的每一条都要被下面的表列检查覆盖到。
 *
 * @param source - `worker/bundle.js` 或 `make-bundle.mjs` 的全文。
 * @returns `{ sql, index }[]`。
 */
export function extractSql(source) {
  const out = [];
  const re = /"((?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*?)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ sql: m[1], index: m.index });
  }
  return out;
}

/**
 * 找出 SQL 里引用了「表存在但没有这一列」的字段。
 *
 * **只检查能精确判定的位置**，而不是逐词扫描整条语句：
 *
 *   - `INSERT INTO <table> (a, b, c)` 的列清单——这里每个标识符必定是列；
 *   - `SELECT <投影> FROM <table>` 的投影——**去掉别名**（`COUNT(*) AS n`
 *     里的 `n` 是别名不是列）；
 *   - `ON CONFLICT(<cols>)` 与 `WHERE`/`GROUP BY`/`ORDER BY` 里点号前的裸标识符。
 *
 * 为什么不用通用 SQL 解析器：本项目只需要拦住「列名写错」这一类错误。
 * 逐词扫描会把别名（AS n）、`DO UPDATE SET`、字符串字面量都误判成列——
 * 2026-11-02 第一版检查器就因此报了 17 条假阳性，等于没检查。
 *
 * @param sql - 单条 SQL。
 * @param schema - `parseSchema` 的结果。
 * @returns 问题描述数组；空数组表示通过。
 */
export function findColumnProblems(sql, schema) {
  const problems = [];
  const seen = new Set();
  const add = (msg) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    problems.push(msg);
  };

  /** 校验一组标识符是否都属于某张表。 */
  const checkNames = (table, names) => {
    const columns = schema[table];
    if (columns === undefined) {
      add(`表 ${table} 在迁移里不存在`);
      return;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (columns.has(lower)) continue;
      add(`表 ${table} 没有列 ${lower}`);
    }
  };

  // 1) INSERT INTO <table> (a, b, c)
  const insertRe = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = insertRe.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const cols = m[2].split(",").map((c) => c.trim()).filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
    checkNames(table, cols);
  }

  // 2) SELECT <投影> FROM <table>
  //
  // 投影里能安全判定的只有两类：
  //
  //   a) 裸标识符（`SELECT version, first_version AS version FROM ...`）——
  //      这些必定是列；
  //   b) 函数调用里的参数（`COUNT(install_id)` / `SUM(decisions)`）——参数是列。
  //
  // 按逗号切分**不可行**：`COALESCE(SUM(decisions),0)` 里的逗号会把嵌套调用
  // 切成两半，切出来的 `SUM` 碎片会被误判成列名。所以这里不切分投影，
  // 而是对整段投影做两种正则提取。
  const selectRe = /SELECT\s+([\s\S]*?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  while ((m = selectRe.exec(sql)) !== null) {
    const projection = m[1];
    const table = m[2].toLowerCase();

    // a) 裸标识符：只认「整段投影就是标识符」（单列查询），或「别名前的标识符」。
    //    逐项判断要求能正确切分，因此这里只在投影里没有函数调用时才做整段判断。
    if (!/[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(projection)) {
      const pieces = projection.split(",").map((item) =>
        item.replace(/\s+AS\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i, "").trim(),
      );
      for (const piece of pieces) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(piece)) checkNames(table, [piece]);
      }
    }

    // b) 函数参数：COUNT(x) / SUM(x) / COALESCE(SUM(x),0) —— 取每层调用的第一个参数。
    const fnArgs = /\b(?:count|sum|avg|max|min|coalesce)\s*\(\s*(?:DISTINCT\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/gi;
    let f;
    while ((f = fnArgs.exec(projection)) !== null) {
      const name = f[1].toLowerCase();
      if (name === "distinct") continue;
      checkNames(table, [f[1]]);
    }

    // c) 表名限定形态 `daily_active.decisions`。
    const dotted = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let d;
    while ((d = dotted.exec(projection)) !== null) {
      const owner = d[1].toLowerCase();
      if (owner === table || schema[owner] !== undefined) checkNames(owner, [d[2]]);
    }
  }

  // 3) ON CONFLICT(<cols>) DO UPDATE SET <col> = excluded.<col>
  const conflictRe = /ON\s+CONFLICT\s*\(([^)]*)\)/gi;
  while ((m = conflictRe.exec(sql)) !== null) {
    const tableMatch = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
    if (tableMatch === null) continue;
    const table = tableMatch[1].toLowerCase();
    const cols = m[1].split(",").map((c) => c.trim()).filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
    checkNames(table, cols);
  }
  const setRe = /DO\s+UPDATE\s+SET\s+([\s\S]*?)(?:\s+WHERE|$)/i;
  const setMatch = setRe.exec(sql);
  if (setMatch !== null) {
    const tableMatch = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
    if (tableMatch !== null) {
      const table = tableMatch[1].toLowerCase();
      for (const assignment of setMatch[1].split(",")) {
        const target = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(assignment);
        if (target !== null) checkNames(table, [target[1]]);
      }
    }
  }

  // 4) WHERE / GROUP BY / ORDER BY 中的裸列名（排除别名与关键字）
  //
  // ORDER BY / GROUP BY 可以直接引用 SELECT 里的**别名**（`ORDER BY n`），
  // 这不算列。因此先把投影里声明过的别名收集起来，遇到它们就跳过。
  const aliases = new Set();
  const aliasRe = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let a;
  while ((a = aliasRe.exec(sql)) !== null) aliases.add(a[1].toLowerCase());

  const KEYWORDS = new Set([
    "select","from","where","group","by","order","insert","into","values","update","set",
    "on","conflict","do","nothing","distinct","as","count","sum","coalesce","max","min",
    "avg","limit","and","or","not","null","is","in","case","when","then","else","end",
    "current_timestamp","strftime","unixepoch","excluded","like","glob","asc","desc",
    "union","all","exists","between","left","inner","join","having","offset","primary",
    "key","default","table","if","constraint","index","create","unique",
  ]);
  // 函数名后面紧跟 `(` 的，是函数不是列：`SUM(decisions)` 里的 SUM。
  const functionNames = new Set(
    (sql.match(/[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/g) ?? []).map((w) => w.toLowerCase()),
  );

  const clauseRe = /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY)\s+([\s\S]*?)(?:\bLIMIT\b|\bON\s+CONFLICT\b|$)/gi;
  while ((m = clauseRe.exec(sql)) !== null) {
    const tableMatch = /(?:FROM|INSERT\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
    if (tableMatch === null) continue;
    const table = tableMatch[1].toLowerCase();
    for (const word of m[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) continue;
      if (aliases.has(lower)) continue;
      if (functionNames.has(lower)) continue;
      if (lower === table) continue;
      // 点号形态由第 2 段处理；这里只认裸标识符。
      if (m[1].includes(`${word}.`)) continue;
      checkNames(table, [word]);
    }
  }

  return problems;
}

test("迁移文件能被解析出表与列", async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "migrations/ 下应有 .sql 文件");
  let merged = "";
  for (const f of files) merged += `${await readFile(join(MIGRATIONS, f), "utf8")}\n`;
  const schema = parseSchema(merged);
  for (const table of ["installs", "daily_active", "downloads", "version_daily", "digest_log"]) {
    assert.ok(schema[table], `schema 应含表 ${table}`);
    assert.ok(schema[table].has("day") || table === "installs", `表 ${table} 应有 day 列（installs 以时间戳为准）`);
  }
  // 钉住 installs 的真实列：只有两列带 version，没有裸 version。
  assert.ok(schema.installs.has("first_version"));
  assert.ok(schema.installs.has("last_version"));
  assert.ok(!schema.installs.has("version"), "installs 不应有裸 version 列");
});

test("bundle 里的每条 SQL 只引用 schema 里存在的列", async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  let merged = "";
  for (const f of files) merged += `${await readFile(join(MIGRATIONS, f), "utf8")}\n`;
  const schema = parseSchema(merged);

  const source = await readFile(BUNDLER, "utf8");
  const statements = extractSql(source);
  assert.ok(statements.length >= 8, `应抽出多条 SQL（实际 ${statements.length}）`);

  const allProblems = [];
  for (const { sql } of statements) {
    for (const problem of findColumnProblems(sql, schema)) {
      allProblems.push(`${problem}  ← ${sql.slice(0, 90).replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(allProblems, [], "存在引用了不存在的列的 SQL");
});

test("installs 的新装统计必须用 first_version（回归 DEC-020 的线上故障）", async () => {
  const source = await readFile(BUNDLER, "utf8");
  // 这条语句曾在线上报 no such column: version，导致日报永远发不出来。
  assert.ok(
    source.includes("SELECT first_version AS version"),
    "新装版本分布应按 first_version 分组",
  );
  assert.ok(
    !source.includes("SELECT version, COUNT(*) AS n FROM installs"),
    "不得再对 installs 查询裸 version 列",
  );
});

test("采集端点必须把写入放进 waitUntil（否则响应结束即被取消）", async () => {
  const source = await readFile(BUNDLER, "utf8");
  assert.ok(source.includes("ctx.waitUntil(env.DB.batch(stmts)"), "心跳写入必须在 waitUntil 里");
});

test("推送口径必须是滚动 24 小时，且每个指标只出现一个数字（DEC-046）", async () => {
  const source = await readFile(BUNDLER, "utf8");

  // 活跃 / 新增 / 决策 / 版本分布都必须按 updated_ms 或 first_seen_ms 的滚动
  // 窗口切，而不是按 day 切日历日。按 day 切出来的是「昨天整天」或「今天到
  // 此刻」，后者随推送时刻缩水（18:42 推送只有 18h42m），两者都答不了
  // 「距上次推送 24 小时」。
  assert.ok(
    /COUNT\(DISTINCT install_id\) AS n FROM daily_active WHERE plugin=\? AND updated_ms>=\?/.test(source),
    "活跃数必须按 updated_ms >= now-24h 统计",
  );
  assert.ok(
    /COUNT\(\*\) AS n FROM installs WHERE plugin=\? AND first_seen_ms>=\?"\)\.bind\(plugin,winStart\)/.test(source),
    "新增安装必须按 first_seen_ms >= now-24h 统计",
  );
  assert.ok(source.includes("const winStart=now-86400000"), "必须存在滚动 24h 窗口变量");

  // 回归：正文里不得再出现「第二个半截数字」。这条曾把
  // 10 与 743 拼成一行，读者无法判断哪个才是 DAU。
  assert.ok(!/今日至此刻/.test(source), "正文不得再出现「今日至此刻」的半截口径");
  assert.ok(!/（今日 \+/.test(source), "正文不得再出现「（今日 N）」的半截口径");

  // 每个指标行只允许有一个数字：检查正文构造里没有成对的 dau/new 变量。
  assert.ok(!source.includes("dauY") && !source.includes("dauT"), "不得再有 dauY/dauT 两个口径");
  assert.ok(!source.includes("newY") && !source.includes("newT"), "不得再有 newY/newT 两个口径");
});

test("Worker 必须导出 scheduled，且 cron 只认 UTC 的 42 10 * * *", async () => {
  const source = await readFile(BUNDLER, "utf8");
  assert.ok(source.includes("scheduled:async("), "bundle 必须导出 scheduled 处理器");

  const wrangler = await readFile(join(SITE, "wrangler.jsonc"), "utf8");
  assert.ok(wrangler.includes('"42 10 * * *"'), "cron 应为 UTC 10:42（= 上海 18:42）");
  assert.ok(wrangler.includes('"binding": "DB"'), "应声明 D1 绑定 DB");
});

test("隐私：bundle 不得读取客户端 IP，也不得出现密钥类字段名", async () => {
  const source = await readFile(BUNDLER, "utf8");
  assert.ok(!source.includes("CF-Connecting-IP"), "不得读取 CF-Connecting-IP");
  // 上报体只有短键；确保没有把 prompt / cwd / 会话内容写进 D1 的语句。
  for (const forbidden of ["prompt", "cwd", "apiKey", "sessionId"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`, "i").test(source), `bundle 不应出现 ${forbidden}`);
  }
});

// ---------- 服务端下发 provider 配置（DEC-030）----------

test("下发端点：路由排在 /api/* 兜底之前，且值全部来自 Worker secret", async () => {
  const source = await readFile(BUNDLER, "utf8");
  const routeAt = source.indexOf('u.pathname==="/api/provider-config"');
  const catchAllAt = source.indexOf('u.pathname.indexOf("/api/")===0');
  assert.ok(routeAt >= 0, "模板应包含 /api/provider-config 路由");
  // 顺序不是风格问题：兜底 404 在前，这条路由永远不会被走到。
  assert.ok(catchAllAt > routeAt, "/api/provider-config 必须排在 /api/* 兜底 404 之前");

  const block = source.slice(routeAt, catchAllAt);
  assert.ok(block.includes('allow:"GET"'), "非 GET 必须 405");
  assert.ok(block.includes("env.PROVIDER_KEY"), "下发的 key 必须来自 Worker secret");
  assert.ok(block.includes("env.PROVIDER_BASE_URL"), "下发的地址必须来自 Worker secret");
  assert.ok(block.includes("env.PROVIDER_CONFIG_TOKEN"), "可选门禁 secret 名不对");
  assert.ok(block.includes("x-provider-token"), "可选门禁请求头名不对");
  // 未配置就 404：路由等同不存在，不会变成一个公开的 key 领取点。
  assert.ok(block.includes("not-configured"), "未配 PROVIDER_KEY 时应返回 not-configured");
  assert.ok(block.includes('err:"forbidden"'), "门禁不匹配应返回 forbidden");
  for (const field of ["baseUrl", "model", "endpointStyle", "key", "ttlSeconds"]) {
    assert.ok(block.includes(`${field}:`), `下发载荷应含 ${field}`);
  }
  // 这条路由不写库：没有 SQL，也就没有任何把 key 落进 D1 的路径。
  assert.ok(!/\b(INSERT|SELECT|UPDATE|DELETE)\b/.test(block), "下发路由不应包含 SQL");
  // key 只准出现在响应体里：不许交给任何 console。
  assert.ok(!/console\.[a-zA-Z]+\([^)]*PROVIDER_KEY/.test(source), "不得把下发的 key 打进日志");
});

// ---------- 多插件维度（DEC-021）----------

test("每张明细表都把 plugin 并入主键，且按 plugin 建索引", async () => {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  let merged = "";
  for (const f of files) merged += `${await readFile(join(MIGRATIONS, f), "utf8")}\n`;
  const schema = parseSchema(merged);

  for (const table of ["installs", "daily_active", "downloads", "version_daily", "digest_log"]) {
    assert.ok(schema[table].has("plugin"), `表 ${table} 必须有 plugin 列`);
  }

  // SQLite 不能改主键，因此升级只能重建表；迁移里必须留下重建的痕迹，
  // 否则说明 plugin 被加成了普通列 —— 那样两条不同插件的同 id 记录会互相覆盖。
  assert.match(merged, /PRIMARY KEY\s*\(\s*plugin\s*,\s*install_id\s*\)/i, "installs 主键应含 plugin");
  assert.match(merged, /PRIMARY KEY\s*\(\s*plugin\s*,\s*day\s*,\s*install_id\s*\)/i, "daily_active 主键应含 plugin");
  assert.match(merged, /PRIMARY KEY\s*\(\s*plugin\s*,\s*day\s*,\s*source\s*\)/i, "downloads 主键应含 plugin");
  assert.match(merged, /PRIMARY KEY\s*\(\s*plugin\s*,\s*day\s*,\s*version\s*\)/i, "version_daily 主键应含 plugin");
  // digest_log 的去重也必须按插件分开：两个插件的日报是两条独立消息。
  assert.match(merged, /PRIMARY KEY\s*\(\s*plugin\s*,\s*day\s*\)/i, "digest_log 主键应含 plugin");
});

test("聚合查询一律按 plugin 过滤——否则数字会跨插件混在一起", async () => {
  const source = await readFile(BUNDLER, "utf8");
  const statements = extractSql(source);

  const tables = ["daily_active", "installs", "downloads", "version_daily"];
  const offenders = [];
  for (const { sql } of statements) {
    if (!/SELECT/i.test(sql)) continue;
    // 「有哪些插件」这条查询本身不可能按插件过滤——它就是要跨插件扫。
    if (/SELECT\s+DISTINCT\s+plugin\b/i.test(sql)) continue;
    const touched = tables.filter((t) => new RegExp(`\\bFROM\\s+${t}\\b`, "i").test(sql));
    if (touched.length === 0) continue;
    if (!/\bplugin\s*=\s*\?/i.test(sql)) {
      offenders.push(`${touched.join(",")} <- ${sql.slice(0, 80).replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(offenders, [], "存在没有按 plugin 过滤的聚合查询");
});

test("写入语句都带上 plugin，冲突目标按 (plugin, ...) 匹配", async () => {
  const source = await readFile(BUNDLER, "utf8");
  const statements = extractSql(source);
  const offenders = [];

  for (const { sql } of statements) {
    if (!/INSERT\s+INTO/i.test(sql)) continue;
    for (const table of ["installs", "daily_active", "downloads", "version_daily", "digest_log"]) {
      const into = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]*)\\)`, "i").exec(sql);
      if (into === null) continue;
      const cols = into[1].split(",").map((c) => c.trim().toLowerCase());
      if (!cols.includes("plugin")) offenders.push(`${table} 的 INSERT 没有 plugin 列`);
      // ON CONFLICT 的目标必须从 plugin 开始，否则 upsert 会撞错行。
      const conflict = /ON\s+CONFLICT\s*\(([^)]*)\)/i.exec(sql);
      if (conflict !== null) {
        const keys = conflict[1].split(",").map((c) => c.trim().toLowerCase());
        if (keys[0] !== "plugin") offenders.push(`${table} 的 ON CONFLICT 不以 plugin 开头：${conflict[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "存在缺少插件维度的写入语句");
});

test("npm 下载与推送标题都按插件区分，不再写死包名", async () => {
  const source = await readFile(BUNDLER, "utf8");
  // npm 查询必须用 plugin 参数拼接，而不是写死某个包名。
  assert.ok(
    source.includes("encodeURIComponent(plugin)"),
    "npm 下载查询应按 plugin 拼接",
  );
  assert.ok(!source.includes('/dsh-decision-engine"'), "npm 查询不得写死包名");
  // 推送标题同理：应带插件名，而不是固定字符串。
  // 只断言前缀 `plugin+`，不锁死后缀——标题后缀会随口径变化（DEC-046 把
  // 「日期」换成了「近24小时」），把整串写死会让一次合理的文案调整假红。
  assert.ok(source.includes("const title=plugin+"), "推送标题应按 plugin 区分");
  assert.ok(!source.includes('const title="dsh-decision-engine'), "标题不得写死插件名");
});

test("插件清单从 D1 读取，新增插件不必改 Worker 代码", async () => {
  const source = await readFile(BUNDLER, "utf8");
  assert.ok(source.includes("SELECT DISTINCT plugin FROM installs"), "应动态读取插件清单");
  // 空表兜底：首日还没人上报时也要能发日报。
  assert.ok(source.includes("if(plugins.length===0)plugins=[DEFAULT_PLUGIN]"), "空清单应有兜底");
});

test("老客户端（无 p 字段）回填为默认插件，非法 p 直接拒绝", async () => {
  const source = await readFile(BUNDLER, "utf8");
  // 老版本上报体没有插件字段：按历史事实回填，而不是丢弃那段数据。
  assert.ok(source.includes(":DEFAULT_PLUGIN;"), "无 p 字段应回填 DEFAULT_PLUGIN");
  // 带了但非法：拒绝，绝不猜测归属。
  assert.ok(
    source.includes('return json({ok:false,err:"bad-plugin"},400)'),
    "非法插件 id 应返回 400",
  );
});
