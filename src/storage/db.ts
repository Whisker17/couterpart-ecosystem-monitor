import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { DDL } from "./schema.js";

// SQLITE_FCNTL_PERSIST_WAL op code (SQLite spec value 10)
const SQLITE_FCNTL_PERSIST_WAL = 10;
const CURRENT_VERSION = 2;

let instance: Database | null = null;

// Adds columns to existing tables that were introduced after the initial schema.
// ALTER TABLE ADD COLUMN is always safe: it sets all existing rows to NULL (or
// the column default), and CREATE TABLE IF NOT EXISTS leaves existing tables
// untouched — so we must handle new columns explicitly.
function migrateV0toV1(db: Database): void {
  const existingCols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(competitors)")
      .all()
      .map((r) => r.name)
  );

  const competitorMigrations: Array<{ name: string; sql: string }> = [
    { name: "blog_rss_url", sql: "ALTER TABLE competitors ADD COLUMN blog_rss_url TEXT" },
    { name: "x_handle", sql: "ALTER TABLE competitors ADD COLUMN x_handle TEXT" },
    { name: "website_url", sql: "ALTER TABLE competitors ADD COLUMN website_url TEXT" },
    { name: "tags", sql: "ALTER TABLE competitors ADD COLUMN tags TEXT" },
    { name: "last_synced_at", sql: "ALTER TABLE competitors ADD COLUMN last_synced_at TEXT" },
    { name: "created_at", sql: "ALTER TABLE competitors ADD COLUMN created_at TEXT" },
  ];

  for (const col of competitorMigrations) {
    if (!existingCols.has(col.name)) {
      db.exec(col.sql);
    }
  }
}

function migrateV1toV2(db: Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_content_items_status_collected_at ON content_items(analysis_status, collected_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analyses_content_item_id ON analyses(content_item_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analyses_analyzed_at ON analyses(analyzed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_inputs_analysis_id ON analysis_inputs(analysis_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_inputs_created_at ON analysis_inputs(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at)`);
}

// WAL mode change requires an exclusive lock; bun:sqlite's busy_timeout does
// not always suppress SQLITE_BUSY for PRAGMA journal_mode=WAL when concurrent
// processes race on a fresh database. We handle it two ways:
//   (a) Skip the call entirely if the DB is already in WAL mode (sticky).
//   (b) Retry with backoff when SQLITE_BUSY is thrown until the window closes.
function setJournalModeWAL(db: Database): void {
  const { journal_mode } = db
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()!;
  if (journal_mode === "wal") return; // already set — no exclusive lock needed

  const STEP_MS = 200;
  const MAX_ATTEMPTS = Math.ceil(5000 / STEP_MS);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
        if (attempt === MAX_ATTEMPTS) throw e;
        Bun.sleepSync(STEP_MS);
        // Re-check: another process may have already switched to WAL.
        const { journal_mode: current } = db
          .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
          .get()!;
        if (current === "wal") return;
      } else {
        throw e;
      }
    }
  }
}

function initDb(): Database {
  const dbPath = process.env.DB_PATH ?? "data/monitor.db";
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });

  // busy_timeout must be first: sets the retry window before any
  // potentially lock-taking pragma (journal_mode=WAL needs an exclusive lock).
  db.exec("PRAGMA busy_timeout=5000");
  setJournalModeWAL(db);
  db.exec("PRAGMA temp_store=MEMORY");
  db.exec("PRAGMA cache_size=-64000");
  db.exec("PRAGMA mmap_size=268435456");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");

  const { user_version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;

  if (user_version < CURRENT_VERSION) {
    db.exec(DDL);
    if (user_version < 1) {
      migrateV0toV1(db);
    }
    if (user_version < 2) {
      migrateV1toV2(db);
    }
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }

  return db;
}

export function getDb(): Database {
  if (!instance) {
    instance = initDb();
  }
  return instance;
}

function shutdown(): void {
  if (!instance) return;
  const db = instance;
  instance = null;

  try {
    if (typeof (db as unknown as { fileControl?: (op: number, arg: number) => boolean }).fileControl === "function") {
      (db as unknown as { fileControl: (op: number, arg: number) => boolean }).fileControl(SQLITE_FCNTL_PERSIST_WAL, 0);
    }
  } catch {
    // fileControl unavailable — fall through to checkpoint only
  }

  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore checkpoint errors during shutdown
  }

  db.close();
}

export function closeDb(): void {
  shutdown();
}

process.on("exit", shutdown);
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
