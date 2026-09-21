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

-- Video izrezan na tri dijela, po jedan za svaki panel. Ključ je (asset, bezel)
-- jer promjena razmaka za okvire mijenja i rez — stari dijelovi ostaju na disku
-- dok se novi ne izrežu, da objava koja se trenutno vrti ne ostane bez fajlova.
CREATE TABLE IF NOT EXISTS video_slices (
  asset_id TEXT NOT NULL,
  bezel INTEGER NOT NULL,      -- razmak u pikselima videa, ne u CSS px panela
  status TEXT NOT NULL,        -- working | ready | error
  files TEXT,                  -- JSON niz imena tri fajla na disku
  frames INTEGER,              -- broj frejmova, isti za sva tri dijela
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, bezel)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- bezel_px, panel_h, current_version, current_epoch, next_version, next_active_from

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
