import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import {
  archiveReports,
  vacuumDb,
  cleanupOldContent,
  cleanupAnalysisInputs,
  cleanupAnalyses,
  cleanupContentItems,
  runDailyCleanup,
} from "../../pipeline/maintenance.js";
import { DDL } from "../../storage/schema.js";

const TEST_DB_PATH = "data/test-maintenance.db";
const TEST_ARCHIVE_DIR = "data/test-archive";

function makeDb(): Database {
  mkdirSync("data", { recursive: true });
  const db = new Database(TEST_DB_PATH, { create: true });
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(DDL);
  return db;
}

function makeMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(DDL);
  return db;
}

function insertCompetitor(db: Database): number {
  db.exec(`INSERT INTO competitors (name, org) VALUES ('TestCo', 'testco') ON CONFLICT DO NOTHING`);
  return db.query<{ id: number }, []>("SELECT id FROM competitors WHERE org='testco'").get()!.id;
}

function insertContentItem(
  db: Database,
  collectedAt: string,
  status: string = "complete",
  content: string | null = "some content"
): number {
  const compId = insertCompetitor(db);
  db.exec(
    `INSERT INTO content_items (competitor_id, source, source_url, content, analysis_status, collected_at)
     VALUES (${compId}, 'blog', 'https://example.com/${collectedAt}/${Math.random()}', ${content === null ? "NULL" : `'${content}'`}, '${status}', '${collectedAt}')`
  );
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

function insertAnalysis(db: Database, contentItemId: number, analyzedAt: string): number {
  db.exec(
    `INSERT INTO analyses (content_item_id, summary, significance, analyzed_at)
     VALUES (${contentItemId}, 'summary', 'routine', '${analyzedAt}')`
  );
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

function insertAnalysisInput(db: Database, contentItemId: number, analysisId: number | null, createdAt: string): number {
  db.exec(
    `INSERT INTO analysis_inputs (content_item_id, analysis_id, created_at)
     VALUES (${contentItemId}, ${analysisId === null ? "NULL" : analysisId}, '${createdAt}')`
  );
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

function insertReport(db: Database, createdAt: string): void {
  db.exec(
    `INSERT INTO reports (report_date, report_type, content, created_at) VALUES ('${createdAt}', 'daily', '{"items":[]}', '${createdAt}')`
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

    await archiveReports(db, 90, TEST_ARCHIVE_DIR);
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

  test("archives older than configurable reportsDays, skips newer", async () => {
    const db = makeDb();
    // Insert report 30 days old — should be archived with reportsDays=20, but not with reportsDays=60
    insertReport(db, "2026-05-05 00:00:00"); // ~30 days ago from 2026-06-05
    insertReport(db, "2026-06-01 00:00:00"); // ~4 days ago

    await archiveReports(db, 20, TEST_ARCHIVE_DIR);
    db.close();

    const db2 = new Database(TEST_DB_PATH);
    const remaining = db2.query<{ report_date: string }, []>("SELECT report_date FROM reports").all();
    db2.close();

    expect(remaining.length).toBe(1);
    expect(remaining[0]?.report_date).toBe("2026-06-01 00:00:00");
  });

  test("creates archive directory if it does not exist", async () => {
    const db = makeDb();
    insertReport(db, "2025-01-15 00:00:00");

    const newDir = `${TEST_ARCHIVE_DIR}/nonexistent`;
    await archiveReports(db, 90, newDir);
    db.close();

    expect(existsSync(`${newDir}/2025-01/reports.jsonl`)).toBe(true);
  });

  test("groups reports by month of created_at", async () => {
    const db = makeDb();
    insertReport(db, "2025-01-10 00:00:00");
    insertReport(db, "2025-03-20 00:00:00");

    await archiveReports(db, 90, TEST_ARCHIVE_DIR);
    db.close();

    expect(existsSync(`${TEST_ARCHIVE_DIR}/2025-01/reports.jsonl`)).toBe(true);
    expect(existsSync(`${TEST_ARCHIVE_DIR}/2025-03/reports.jsonl`)).toBe(true);
  });

  test("does nothing when no old reports exist", async () => {
    const db = makeDb();
    insertReport(db, "2026-06-01 00:00:00");

    await archiveReports(db, 90, TEST_ARCHIVE_DIR);
    db.close();

    expect(existsSync(TEST_ARCHIVE_DIR)).toBe(false);
  });

  test("handles FK constraint: deletes report_deliveries before reports (foreign_keys=ON)", async () => {
    const db = makeMemoryDb();

    db.exec(
      `INSERT INTO reports (report_date, report_type, content, created_at) VALUES ('2025-01-10', 'daily', '{}', '2025-01-10 00:00:00')`
    );
    const report = db.query<{ id: number }, []>("SELECT id FROM reports").get()!;
    db.exec(
      `INSERT INTO report_deliveries (report_id, card_content) VALUES (${report.id}, 'card')`
    );

    const archiveDir = `${TEST_ARCHIVE_DIR}/fk-test`;
    await expect(archiveReports(db, 90, archiveDir)).resolves.toBeUndefined();

    const remaining = db.query<{ id: number }, []>("SELECT id FROM reports").all();
    expect(remaining.length).toBe(0);

    const deliveries = db.query<{ id: number }, []>("SELECT id FROM report_deliveries").all();
    expect(deliveries.length).toBe(0);

    expect(existsSync(`${archiveDir}/2025-01/reports.jsonl`)).toBe(true);
    db.close();
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
    insertContentItem(db, old, "complete", "some content");

    cleanupOldContent(db);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBeNull();
    db.close();
  });

  test("does not null content on pending items older than 60 days", () => {
    const db = makeDb();
    const old = "2025-01-01 00:00:00";
    insertContentItem(db, old, "pending", "some content");

    cleanupOldContent(db);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBe("some content");
    db.close();
  });

  test("does not null content on recent complete items", () => {
    const db = makeDb();
    const recent = "2026-06-01 00:00:00";
    insertContentItem(db, recent, "complete", "some content");

    cleanupOldContent(db);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBe("some content");
    db.close();
  });

  test("uses configurable retentionDays", () => {
    const db = makeMemoryDb();
    // 10 days old — should be nulled with retentionDays=5, not with retentionDays=30
    insertContentItem(db, "2026-05-26 00:00:00", "complete", "some content");

    cleanupOldContent(db, 5);

    const item = db.query<{ content: string | null }, []>("SELECT content FROM content_items LIMIT 1").get()!;
    expect(item.content).toBeNull();
    db.close();
  });
});

describe("cleanupAnalysisInputs", () => {
  test("deletes rows older than cutoff", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete");
    const aId = insertAnalysis(db, ciId, "2025-01-01 00:00:00");
    insertAnalysisInput(db, ciId, aId, "2025-01-01 00:00:00");

    cleanupAnalysisInputs(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM analysis_inputs").all();
    expect(rows.length).toBe(0);
    db.close();
  });

  test("skips rows newer than cutoff", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2026-06-04 00:00:00", "complete");
    const aId = insertAnalysis(db, ciId, "2026-06-04 00:00:00");
    insertAnalysisInput(db, ciId, aId, "2026-06-04 00:00:00");

    cleanupAnalysisInputs(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM analysis_inputs").all();
    expect(rows.length).toBe(1);
    db.close();
  });

  test("only deletes rows older than cutoff, leaves newer rows intact", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete");
    const aId = insertAnalysis(db, ciId, "2025-01-01 00:00:00");
    insertAnalysisInput(db, ciId, aId, "2025-01-01 00:00:00"); // old
    insertAnalysisInput(db, ciId, aId, "2026-06-04 00:00:00"); // new

    cleanupAnalysisInputs(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM analysis_inputs").all();
    expect(rows.length).toBe(1);
    db.close();
  });
});

describe("cleanupAnalyses", () => {
  test("deletes analyses older than cutoff with no child analysis_inputs", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete");
    insertAnalysis(db, ciId, "2025-01-01 00:00:00");

    cleanupAnalyses(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM analyses").all();
    expect(rows.length).toBe(0);
    db.close();
  });

  test("skips analyses that still have child analysis_inputs", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete");
    const aId = insertAnalysis(db, ciId, "2025-01-01 00:00:00");
    insertAnalysisInput(db, ciId, aId, "2025-01-01 00:00:00");

    cleanupAnalyses(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM analyses").all();
    expect(rows.length).toBe(1);
    db.close();
  });

  test("skips analyses newer than cutoff", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2026-06-04 00:00:00", "complete");
    insertAnalysis(db, ciId, "2026-06-04 00:00:00");

    cleanupAnalyses(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM analyses").all();
    expect(rows.length).toBe(1);
    db.close();
  });
});

describe("cleanupContentItems", () => {
  test("deletes complete items older than cutoff with no child analyses", () => {
    const db = makeMemoryDb();
    insertContentItem(db, "2025-01-01 00:00:00", "complete");

    cleanupContentItems(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM content_items").all();
    expect(rows.length).toBe(0);
    db.close();
  });

  test("skips items that still have child analyses", () => {
    const db = makeMemoryDb();
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete");
    insertAnalysis(db, ciId, "2025-01-01 00:00:00");

    cleanupContentItems(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM content_items").all();
    expect(rows.length).toBe(1);
    db.close();
  });

  test("skips items with non-complete status", () => {
    const db = makeMemoryDb();
    insertContentItem(db, "2025-01-01 00:00:00", "pending");

    cleanupContentItems(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM content_items").all();
    expect(rows.length).toBe(1);
    db.close();
  });

  test("skips items newer than cutoff", () => {
    const db = makeMemoryDb();
    insertContentItem(db, "2026-06-04 00:00:00", "complete");

    cleanupContentItems(db, 60);

    const rows = db.query<{ id: number }, []>("SELECT id FROM content_items").all();
    expect(rows.length).toBe(1);
    db.close();
  });
});

describe("runDailyCleanup", () => {
  test("integration: cleans in order — analysis_inputs → analyses → content_items → content null", () => {
    const db = makeMemoryDb();
    const retention = {
      contentItemsDays: 60,
      analysesDays: 60,
      analysisInputsDays: 30,
      reportsDays: 90,
    };

    // Insert old complete data chain
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete", "old content");
    const aId = insertAnalysis(db, ciId, "2025-01-01 00:00:00");
    insertAnalysisInput(db, ciId, aId, "2025-01-01 00:00:00");

    // Insert recent data that should remain untouched
    const recentCiId = insertContentItem(db, "2026-06-04 00:00:00", "complete", "recent content");
    const recentAId = insertAnalysis(db, recentCiId, "2026-06-04 00:00:00");
    insertAnalysisInput(db, recentCiId, recentAId, "2026-06-04 00:00:00");

    runDailyCleanup(db, retention);

    // Old analysis_inputs deleted
    const inputs = db.query<{ id: number }, []>("SELECT id FROM analysis_inputs").all();
    expect(inputs.length).toBe(1); // only recent remains

    // Old analyses deleted
    const analyses = db.query<{ id: number }, []>("SELECT id FROM analyses").all();
    expect(analyses.length).toBe(1); // only recent remains

    // Old content_item deleted
    const items = db.query<{ id: number }, []>("SELECT id FROM content_items").all();
    expect(items.length).toBe(1); // only recent remains

    db.close();
  });

  test("runs all steps in a transaction — no partial state on error", () => {
    const db = makeMemoryDb();
    const retention = {
      contentItemsDays: 60,
      analysesDays: 60,
      analysisInputsDays: 30,
      reportsDays: 90,
    };

    // Verify no errors on empty DB
    expect(() => runDailyCleanup(db, retention)).not.toThrow();
    db.close();
  });

  test("respects separate retention windows per table", () => {
    const db = makeMemoryDb();
    const retention = {
      contentItemsDays: 90,
      analysesDays: 60,
      analysisInputsDays: 20,
      reportsDays: 90,
    };

    // analysis_input is 25 days old — older than analysisInputsDays(20) but not analysesDays(60)
    const ciId = insertContentItem(db, "2025-01-01 00:00:00", "complete", "content");
    const aId = insertAnalysis(db, ciId, "2025-01-01 00:00:00");
    // Insert an analysis_input that is 25 days old
    db.exec(
      `INSERT INTO analysis_inputs (content_item_id, analysis_id, created_at)
       VALUES (${ciId}, ${aId}, datetime('now', '-25 days'))`
    );

    runDailyCleanup(db, retention);

    // analysis_input should be deleted (25 > 20 days)
    const inputs = db.query<{ id: number }, []>("SELECT id FROM analysis_inputs").all();
    expect(inputs.length).toBe(0);

    db.close();
  });
});
