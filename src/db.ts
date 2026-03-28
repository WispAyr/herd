import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/herd.db';

// Ensure data dir exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      go2rtc_stream TEXT NOT NULL,
      width INTEGER DEFAULT 1920,
      height INTEGER DEFAULT 1080,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      camera_id TEXT NOT NULL,
      polygon TEXT NOT NULL,
      capacity INTEGER DEFAULT 100,
      alert_warning_pct REAL DEFAULT 0.7,
      alert_critical_pct REAL DEFAULT 0.9,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id)
    );

    CREATE TABLE IF NOT EXISTS counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT NOT NULL,
      count INTEGER NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (zone_id) REFERENCES zones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_counts_zone_time ON counts(zone_id, timestamp);

    CREATE TABLE IF NOT EXISTS flow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT NOT NULL,
      direction_x REAL DEFAULT 0,
      direction_y REAL DEFAULT 0,
      magnitude REAL DEFAULT 0,
      dominant_label TEXT DEFAULT 'none',
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (zone_id) REFERENCES zones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_flow_zone_time ON flow(zone_id, timestamp);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('warning','critical')),
      message TEXT NOT NULL,
      count INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      triggered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      resolved_at INTEGER,
      active INTEGER DEFAULT 1,
      FOREIGN KEY (zone_id) REFERENCES zones(id)
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_zone ON alerts(zone_id, active);
  `);

  console.log('[db] Schema initialised');
}
