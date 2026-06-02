import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { DDL } from "./schema.js";

// SQLITE_FCNTL_PERSIST_WAL op code (SQLite spec value 10)
const SQLITE_FCNTL_PERSIST_WAL = 10;
const CURRENT_VERSION = 1;

let instance: Database | null = null;

function initDb(): Database {
  const dbPath = process.env.DB_PATH ?? "data/monitor.db";
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
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
