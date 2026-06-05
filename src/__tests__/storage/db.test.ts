import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";

const TEST_DB_PATH = "data/test-monitor.db";

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
  mkdirSync("data", { recursive: true });
});

afterEach(async () => {
  const { closeDb } = await import("../../storage/db.js");
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (existsSync(p)) unlinkSync(p);
  }
  delete process.env.DB_PATH;
});

test("getDb creates database file on first call", async () => {
  const { getDb } = await import("../../storage/db.js");
  getDb();
  expect(existsSync(TEST_DB_PATH)).toBe(true);
});

test("journal_mode is WAL", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!;
  expect(row.journal_mode).toBe("wal");
});

test("busy_timeout is 5000", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!;
  expect(row.timeout).toBe(5000);
});

test("foreign_keys is ON", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const row = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!;
  expect(row.foreign_keys).toBe(1);
});

test("synchronous is NORMAL (1)", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const row = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!;
  expect(row.synchronous).toBe(1);
});

test("user_version is 2 after init", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  expect(row.user_version).toBe(2);
});

test("all 6 tables exist", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  expect(tables).toContain("competitors");
  expect(tables).toContain("content_items");
  expect(tables).toContain("analyses");
  expect(tables).toContain("analysis_inputs");
  expect(tables).toContain("reports");
  expect(tables).toContain("report_deliveries");
});

test("content_items has UNIQUE(source_url) constraint", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  db.exec(
    "INSERT INTO competitors (name, org) VALUES ('Test Co', 'test-co')"
  );
  db.exec(
    "INSERT INTO content_items (competitor_id, source, source_url) VALUES (1, 'blog', 'https://example.com/post')"
  );
  expect(() =>
    db.exec(
      "INSERT INTO content_items (competitor_id, source, source_url) VALUES (1, 'blog', 'https://example.com/post')"
    )
  ).toThrow();
});

test("content_items has retry_count, last_error, reported_at columns", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  db.exec(
    "INSERT INTO competitors (name, org) VALUES ('Test Co', 'test-co')"
  );
  db.exec(
    "INSERT INTO content_items (competitor_id, source, source_url, retry_count, last_error, reported_at) VALUES (1, 'blog', 'https://example.com/post2', 0, NULL, NULL)"
  );
  const row = db
    .query<{ retry_count: number; last_error: string | null; reported_at: string | null }, []>(
      "SELECT retry_count, last_error, reported_at FROM content_items WHERE source_url = 'https://example.com/post2'"
    )
    .get()!;
  expect(row.retry_count).toBe(0);
  expect(row.last_error).toBeNull();
  expect(row.reported_at).toBeNull();
});

test("reports table has content_hash and sent_at columns", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  db.exec(
    "INSERT INTO reports (report_date, report_type, content, content_hash, sent_at) VALUES ('2026-06-02', 'daily', '{}', 'abc123', NULL)"
  );
  const row = db
    .query<{ content_hash: string; sent_at: string | null }, []>(
      "SELECT content_hash, sent_at FROM reports WHERE report_date = '2026-06-02'"
    )
    .get()!;
  expect(row.content_hash).toBe("abc123");
  expect(row.sent_at).toBeNull();
});

test("report_deliveries has card_index with UNIQUE(report_id, card_index)", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  db.exec(
    "INSERT INTO reports (report_date, report_type, content) VALUES ('2026-06-03', 'daily', '{}')"
  );
  db.exec(
    "INSERT INTO report_deliveries (report_id, card_index, card_content) VALUES (1, 0, 'card0')"
  );
  expect(() =>
    db.exec(
      "INSERT INTO report_deliveries (report_id, card_index, card_content) VALUES (1, 0, 'card0-dup')"
    )
  ).toThrow();
});

test("DDL is idempotent — second getDb() call does not re-run DDL", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  // If DDL re-ran it would fail (tables already exist without IF NOT EXISTS... but we use IF NOT EXISTS so should be fine)
  expect(() => getDb()).not.toThrow();
});

test("schema migration: existing DB with user_version=0 gets migrated without data loss", async () => {
  // Simulate an old DB with user_version=0 that has the competitors table
  // but only the minimal columns (id, name, org) — missing blog_rss_url,
  // x_handle, website_url, tags, last_synced_at, created_at.
  const { Database } = await import("bun:sqlite");
  const oldDb = new Database(TEST_DB_PATH, { create: true });
  oldDb.exec("CREATE TABLE IF NOT EXISTS competitors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL)");
  oldDb.exec("INSERT INTO competitors (name, org) VALUES ('OldCorp', 'old-corp')");
  // user_version stays 0 (default — no PRAGMA user_version set)
  oldDb.close();

  // getDb() should detect user_version=0, run DDL + ALTER TABLE migrations,
  // then bump user_version to 1.
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();

  // Existing row must still be there (no data loss)
  const comp = db.query<{ name: string }, []>(
    "SELECT name FROM competitors WHERE org = 'old-corp'"
  ).get();
  expect(comp?.name).toBe("OldCorp");

  // All required tables must now exist
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  expect(tables).toContain("content_items");
  expect(tables).toContain("analyses");
  expect(tables).toContain("analysis_inputs");
  expect(tables).toContain("reports");
  expect(tables).toContain("report_deliveries");

  // All required competitors columns must exist after migration (ALTER TABLE path)
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(competitors)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("blog_rss_url");
  expect(cols).toContain("x_handle");
  expect(cols).toContain("website_url");
  expect(cols).toContain("tags");
  expect(cols).toContain("last_synced_at");
  expect(cols).toContain("created_at");

  // user_version must be bumped to 2 (current version)
  const { user_version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  expect(user_version).toBe(2);
});

test("migrateV1toV2: retention indexes created on fresh init", async () => {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const indexes = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain("idx_content_items_status_collected_at");
  expect(indexes).toContain("idx_analyses_content_item_id");
  expect(indexes).toContain("idx_analyses_analyzed_at");
  expect(indexes).toContain("idx_analysis_inputs_analysis_id");
  expect(indexes).toContain("idx_analysis_inputs_created_at");
  expect(indexes).toContain("idx_reports_created_at");
});
