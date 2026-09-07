// Otvaranje SQLite baze i priprema direktorija. Bez ORM-a, bez migracija —
// jedan schema.sql koji se izvrši pri svakom startu.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const THUMB_DIR = path.join(MEDIA_DIR, 'thumbs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, MEDIA_DIR, THUMB_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(path.join(DATA_DIR, 'videowall.db'));
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Video je dodat naknadno, pa baze koje su nastale prije toga dobiju kolone
// ovdje. Isti princip kao schema.sql: izvrši se pri svakom startu, ne smeta ako
// je već urađeno.
const assetColumns = db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name);
if (!assetColumns.includes('kind')) {
  db.exec("ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'");
}
if (!assetColumns.includes('duration')) {
  db.exec('ALTER TABLE assets ADD COLUMN duration REAL');
}

// Podrazumijevane postavke i tri reda za panele.
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('bezel_px', '48');
insertSetting.run('publish_delay_s', '90');

const insertScreen = db.prepare('INSERT OR IGNORE INTO screens (n) VALUES (?)');
for (const n of [1, 2, 3]) insertScreen.run(n);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value === '') return fallback;
  return row.value;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getAllSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}
