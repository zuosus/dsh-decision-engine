-- 多插件支持：给统计加上「插件维度」。
--
-- 背景：2026-11-02 的第一版只服务 dsh-decision-engine 一个插件，因此 installs 的
-- 主键是 install_id、daily_active 是 (day, install_id)，Worker 里还把包名写死在
-- npm 查询与推送标题上。这带来两个问题：
--
--   1. 同一个宿主环境里装了两个插件时，两条心跳的 install_id 可能相同（它们各自
--      生成自己的 id，撞车概率低，但**并不保证不同**），更关键的是查询无法区分
--      「这个插件今天有多少人用」。
--   2. 加第二个插件就得改 Worker 代码、改推送标题、改下载查询；统计口径会悄悄
--      从「某个插件」变成「全部插件混在一起」。
--
-- 所以把 plugin 提升为**第一等维度**：所有明细表都带 `plugin` 列并进主键，
-- 所有聚合查询都按 plugin 过滤。
--
-- 为什么用「重建表 + 搬运」而不是 `ALTER TABLE ADD COLUMN`：
-- SQLite（D1）不支持修改主键。要把 plugin 并进主键只能重建表。旧数据按插件名
-- 回填（这一版之前只有 dsh-decision-engine 一个上报方，因此回填值是确定的、
-- 不是猜测）。
--
-- 注意：d1 迁移在事务里执行，中途失败会整条回滚，不会留下半张表。

-- ---------- installs ----------
CREATE TABLE IF NOT EXISTS installs_v2 (
  plugin TEXT NOT NULL,
  install_id TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  first_version TEXT NOT NULL,
  last_version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  host_version TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (plugin, install_id)
);

INSERT INTO installs_v2 (plugin, install_id, first_seen_ms, last_seen_ms, first_version, last_version, platform, arch, host_version)
SELECT 'dsh-decision-engine', install_id, first_seen_ms, last_seen_ms, first_version, last_version, platform, arch, host_version
FROM installs
WHERE true
ON CONFLICT(plugin, install_id) DO NOTHING;

DROP TABLE installs;
ALTER TABLE installs_v2 RENAME TO installs;

CREATE INDEX IF NOT EXISTS idx_installs_plugin_first_day ON installs(plugin, first_seen_ms);

-- ---------- daily_active ----------
CREATE TABLE IF NOT EXISTS daily_active_v2 (
  plugin TEXT NOT NULL,
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  decisions INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (plugin, day, install_id)
);

INSERT INTO daily_active_v2 (plugin, day, install_id, version, platform, decisions, updated_ms)
SELECT 'dsh-decision-engine', day, install_id, version, platform, decisions, updated_ms
FROM daily_active
WHERE true
ON CONFLICT(plugin, day, install_id) DO NOTHING;

DROP TABLE daily_active;
ALTER TABLE daily_active_v2 RENAME TO daily_active;

CREATE INDEX IF NOT EXISTS idx_daily_active_plugin_day ON daily_active(plugin, day);

-- ---------- downloads ----------
CREATE TABLE IF NOT EXISTS downloads_v2 (
  plugin TEXT NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (plugin, day, source)
);

INSERT INTO downloads_v2 (plugin, day, source, count, updated_ms)
SELECT 'dsh-decision-engine', day, source, count, updated_ms
FROM downloads
WHERE true
ON CONFLICT(plugin, day, source) DO NOTHING;

DROP TABLE downloads;
ALTER TABLE downloads_v2 RENAME TO downloads;

CREATE INDEX IF NOT EXISTS idx_downloads_plugin_day ON downloads(plugin, day);

-- ---------- version_daily ----------
CREATE TABLE IF NOT EXISTS version_daily_v2 (
  plugin TEXT NOT NULL,
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin, day, version)
);

INSERT INTO version_daily_v2 (plugin, day, version, installs, active_users)
SELECT 'dsh-decision-engine', day, version, installs, active_users
FROM version_daily
WHERE true
ON CONFLICT(plugin, day, version) DO NOTHING;

DROP TABLE version_daily;
ALTER TABLE version_daily_v2 RENAME TO version_daily;

CREATE INDEX IF NOT EXISTS idx_version_daily_plugin_day ON version_daily(plugin, day);

-- ---------- digest_log ----------
-- 推送去重必须按插件分开：两个插件的日报是两条独立消息，
-- 不能因为「今天已经推过一个插件的日报」就把另一个也跳过。
CREATE TABLE IF NOT EXISTS digest_log_v2 (
  plugin TEXT NOT NULL,
  day TEXT NOT NULL,
  sent_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (plugin, day)
);

INSERT INTO digest_log_v2 (plugin, day, sent_ms, ok, detail)
SELECT 'dsh-decision-engine', day, sent_ms, ok, detail
FROM digest_log
WHERE true
ON CONFLICT(plugin, day) DO NOTHING;

DROP TABLE digest_log;
ALTER TABLE digest_log_v2 RENAME TO digest_log;
