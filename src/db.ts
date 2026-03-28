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

    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      name TEXT NOT NULL,
      line_y REAL NOT NULL DEFAULT 0.5,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id)
    );

    CREATE TABLE IF NOT EXISTS gate_crossings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('entry','exit')),
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (gate_id) REFERENCES gates(id)
    );

    CREATE INDEX IF NOT EXISTS idx_gate_crossings_gate ON gate_crossings(gate_id, timestamp);

    CREATE TABLE IF NOT EXISTS external_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'bluetooth',
      count INTEGER NOT NULL,
      metadata TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_external_counts_source ON external_counts(source_id, timestamp);
  `);

  console.log('[db] Schema initialised');

  // Auto-prune old data on startup
  pruneOldData();
  // Prune every 6 hours
  setInterval(pruneOldData, 6 * 60 * 60 * 1000);
}

/** Delete count/flow data older than 7 days */
export function pruneOldData() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const countResult = db.prepare('DELETE FROM counts WHERE timestamp < ?').run(cutoff);
  const flowResult = db.prepare('DELETE FROM flow WHERE timestamp < ?').run(cutoff);
  if (countResult.changes > 0 || flowResult.changes > 0) {
    console.log(`[db] Pruned ${countResult.changes} counts, ${flowResult.changes} flow records older than 7 days`);
  }
}
