-- 匿名使用统计的 D1 schema。
--
-- 设计口径（与 DEC-020 一致）：
--
--   1. **不存任何可识别个人的东西**：没有 IP、没有机器指纹、没有会话内容。
--      install_id 是客户端首次运行随机生成的 UUIDv4，删掉本地 telemetry.json
--      即换新 id。
--   2. **「一天」按 Asia/Shanghai 算**（中国无夏令时，固定 UTC+8）。客户端与
--      服务端用同一算法，因此两边对日一致；day 一律是 'YYYY-MM-DD'。
--   3. **写入尽量少**：每台机器每天最多一次心跳，落到两行
--      （installs 一次 upsert + daily_active 一次 upsert），够算 DAU、
--      新增安装、版本分布与留存。
--
-- 表的分工：
--
--   installs       每台机器一行 —— 装机总数、首见/末见、版本与平台
--   daily_active   每台机器每天一行 —— DAU / WAU / MAU 与当日决策数
--   downloads      每天每来源一行 —— npm / GitHub 的下载数（cron 拉取）
--   version_daily  每天每版本一行 —— cron 汇总，用于「新增版本安装数」曲线
--   digest_log     每天一行 —— 推送去重与投递审计（Bark 失败时可重试）

CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  first_version TEXT NOT NULL,
  last_version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  host_version TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_installs_first_day ON installs(first_seen_ms);

CREATE TABLE IF NOT EXISTS daily_active (
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  decisions INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (day, install_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_active_day ON daily_active(day);

CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);

CREATE TABLE IF NOT EXISTS version_daily (
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  installs INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, version)
);

CREATE TABLE IF NOT EXISTS digest_log (
  day TEXT PRIMARY KEY,
  sent_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);
