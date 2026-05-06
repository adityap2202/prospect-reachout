const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getPaths() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  const dbPath =
    process.env.DB_PATH || path.join(dataDir, "db.sqlite");
  const iimbContextPath =
    process.env.IIMB_CONTEXT_PATH || path.join(dataDir, "iimb-context.md");

  return { dataDir, dbPath, iimbContextPath };
}

function openDb() {
  const { dataDir, dbPath } = getPaths();
  ensureDir(dataDir);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,              -- 'podcast' | 'manual'
      rss_guid TEXT,
      moneycontrol_url TEXT,
      givingpi_url TEXT,
      episode_title TEXT,
      episode_description TEXT,
      season INTEGER,
      published_date TEXT,
      thumbnail_url TEXT,
      guest_name TEXT,
      organisation TEXT,
      status TEXT DEFAULT 'pending',     -- 'pending' | 'processing' | 'complete' | 'error'
      error_message TEXT,
      profile_json TEXT,                 -- Full Stage 1 JSON (stringified)
      linkedin_message TEXT,             -- Stage 2 output
      linkedin_message_v2 TEXT,
      linkedin_message_v3 TEXT,
      processed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_moneycontrol_url ON episodes(moneycontrol_url);
    CREATE INDEX IF NOT EXISTS idx_status ON episodes(status);
    CREATE INDEX IF NOT EXISTS idx_source ON episodes(source);

    CREATE TABLE IF NOT EXISTS pipeline_events (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      level TEXT NOT NULL,
      step TEXT,
      message TEXT,
      data_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_events_episode ON pipeline_events(episode_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_run ON pipeline_events(run_id);
  `);
}

module.exports = { openDb, migrate, getPaths };

