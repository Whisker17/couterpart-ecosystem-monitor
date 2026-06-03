import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { archiveReports, vacuumDb, cleanupOldContent } from "../../pipeline/maintenance.js";
import { DDL } from "../../storage/schema.js";

const TEST_DB_PATH = "data/test-maintenance.db";
const TEST_ARCHIVE_DIR = "data/test-archive";

function makeDb(): Database {
  mkdirSync("data", { recursive: true });
  const db = new Database(TEST_DB_PATH, { create: true });
  db.exec(DDL);
  return db;
}

function insertReport(db: Database, createdAt: string): void {
  db.exec(
    `INSERT INTO reports (report_date, report_type, content, created_at) VALUES ('${createdAt}', 'daily', '{"items":[]}', '${createdAt}')`
  );
}

function insertContentItem(db: Database, createdAt: string, status: string): void {
  db.exec(
    `INSERT INTO competitors (name, org) VALUES ('TestCo', 'testco') ON CONFLICT DO NOTHING`
  );
  const comp = db.query<{ id: number }, []>("SELECT id FROM competitors WHERE org='testco'").get()!;
  db.exec(
    `INSERT INTO content_items (competitor_id, source, source_url, content, analysis_status, collected_at)
     VALUES (${comp.id}, 'blog', 'https://example.com/${createdAt}/${Math.random()}', 'some content', '${status}', '${createdAt}')`
  );
}

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
  process.env.ARCHIVE_DIR = TEST_ARCHIVE_DIR;
  mkdirSync("data", { recursive: true });
});

afterEach(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (existsSync(p)) {
      try { rmSync(p); } catch { /* ok */ }
    }
  }
  if (existsSync(TEST_ARCHIVE_DIR)) {
    rmSync(TEST_ARCHIVE_DIR, { recursive: true, force: true });
  }
  delete process.env.DB_PATH;
  delete process.env.ARCHIVE_DIR;
});

describe("archiveReports", () => {
  test("archives reports older than 90 days to jsonl file and deletes them", async () => {
    const db = makeDb();
    const old = "2025-01-15 00:00:00";
    const recent = "2026-06-01 00:00:00";
    insertReport(db, old);
    insertReport(db, recent);

    await archiveReports(db, TEST_ARCHIVE_DIR);
    db.close();

    const db2 = new Database(TEST_DB_PATH);
    const remaining = db2.query<{ report_date: string }, []>("SELECT report_date FROM reports").all();
    db2.close();

    expect(remaining.length).toBe(1);
    expect(remaining[0]?.report_date).toBe("2026-06-01 00:00:00");

    const archiveFile = `${TEST_ARCHIVE_DIR}/2025-01/reports.jsonl`;
    expect(existsSync(archiveFile)).toBe(true);
    const lines = readFileSync(archiveFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.report_type).toBe("daily");
  });

  test("creates archive directory if it does not exist", async () => {
    const db = makeDb();
    insertReport(db, "2025-01-15 00:00:00");

    const newDir = `${TEST_ARCHIVE_DIR}/nonexistent`;
    await archiveReports(db, newDir);
    db.close();

    expect(existsSync(`${newDir}/2025-01/reports.jsonl`)).toBe(true);
  });

  test("groups reports by month of created_at", async () => {
    const db = makeDb();
    insertReport(db, "2025-01-10 00:00:00");
    insertReport(db, "2025-03-20 00:00:00");

    await archiveReports(db, TEST_ARCHIVE_DIR);
    db.close();

    expect(existsSync(`${TEST_ARCHIVE_DIR}/2025-01/reports.jsonl`)).toBe(true);
    expect(existsSync(`${TEST_ARCHIVE_DIR}/2025-03/reports.jsonl`)).toBe(true);
  });

  test("does nothing when no old reports exist", async () => {
    const db = makeDb();
    insertReport(db, "2026-06-01 00:00:00");

    await archiveReports(db, TEST_ARCHIVE_DIR);
    db.close();

    expect(existsSync(TEST_ARCHIVE_DIR)).toBe(false);
  });
});

describe("vacuumDb", () => {
  test("runs VACUUM without throwing", () => {
    const db = makeDb();
    expect(() => vacuumDb(db)).not.toThrow();
    db.close();
  });
});

describe("cleanupOldContent", () => {
  test("nulls content on complete items older than 60 days", () => {
    const db = makeDb();
    const old = "2025-01-01 00:00:00";
    insertContentItem(db, old, "complete");

    cleanupOldContent(db);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBeNull();
    db.close();
  });

  test("does not null content on pending items older than 60 days", () => {
    const db = makeDb();
    const old = "2025-01-01 00:00:00";
    insertContentItem(db, old, "pending");

    cleanupOldContent(db);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBe("some content");
    db.close();
  });

  test("does not null content on recent complete items", () => {
    const db = makeDb();
    const recent = "2026-06-01 00:00:00";
    insertContentItem(db, recent, "complete");

    cleanupOldContent(db);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBe("some content");
    db.close();
  });
});
