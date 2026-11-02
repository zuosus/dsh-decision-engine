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
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
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
