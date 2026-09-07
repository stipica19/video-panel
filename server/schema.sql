CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,          -- ime na disku, sa hešom
  width INTEGER, height INTEGER, bytes INTEGER,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',   -- image | video
  duration REAL                -- vlastito trajanje videa u sekundama
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  position INTEGER NOT NULL,
  duration REAL NOT NULL DEFAULT 8,
  motion TEXT NOT NULL DEFAULT '{"kind":"kenburns"}',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- bezel_px, current_version, current_epoch, next_version, next_active_from

CREATE TABLE IF NOT EXISTS publications (
  version TEXT PRIMARY KEY,
  payload TEXT NOT NULL,       -- zamrznuti JSON items
  active_from INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS screens (
  n INTEGER PRIMARY KEY,       -- 1, 2, 3
  last_seen INTEGER,
  version TEXT, ready TEXT, item_id TEXT,
  clock_offset_ms REAL, uptime_s INTEGER,
  error TEXT, pending_command TEXT
);
