import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { ReportStage } from "./report.js";
import type { PipelineContext } from "../runner.js";
import type { WeeklyTheme } from "../../schema/analysis.js";
import { getYesterdayPeriod } from "../../utils/time-window.js";

const TEST_DB_PATH = "data/test-report-tz.db";
const REPORT_DATE = "2026-06-02";
const TZ = "Asia/Shanghai";

function makeCTX(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    mode: "daily",
    reportDate: REPORT_DATE,
    timezone: TZ,
    startedAt: new Date(),
    stageResults: new Map(),
    ...overrides,
  };
}

const noopGenerateObject = async (_opts: unknown): Promise<{ object: WeeklyTheme }> => ({
  object: { themes: [] },
});

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
  try { rmSync("data/reports", { recursive: true, force: true }); } catch { /* ok */ }
  delete process.env.DB_PATH;
});

async function seedItemWithAnalyzedAt(opts: {
  org: string;
  name: string;
  sourceUrl: string;
  analyzedAtUnix: number;
  significance?: string;
}) {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const sig = opts.significance ?? "routine";

  db.exec(`INSERT OR IGNORE INTO competitors (name, org) VALUES ('${opts.name}', '${opts.org}')`);
  const comp = db.query<{ id: number }, []>(
    `SELECT id FROM competitors WHERE org = '${opts.org}'`
  ).get()!;

  db.exec(`
    INSERT OR IGNORE INTO content_items
      (competitor_id, source, source_url, title, content, analysis_status)
    VALUES (${comp.id}, 'blog', '${opts.sourceUrl}', 'Title', 'Content', 'complete')
  `);
  const item = db.query<{ id: number }, []>(
    `SELECT id FROM content_items WHERE source_url = '${opts.sourceUrl}'`
  ).get()!;

  db.exec(`
    INSERT OR IGNORE INTO analyses
      (content_item_id, summary, significance, urgency, analyzed_at)
    VALUES (${item.id}, 'Summary', '${sig}', 'normal', datetime(${opts.analyzedAtUnix}, 'unixepoch'))
  `);

  return { competitorId: comp.id, itemId: item.id };
}

// ---------------------------------------------------------------------------
describe("ReportStage daily: analyzed_at time-window filtering (UTC+8)", () => {
  test("includes item with analyzed_at inside yesterday's UTC+8 window", async () => {
    const { startUnix, endUnix } = getYesterdayPeriod(TZ);
    const midWindow = Math.floor((startUnix + endUnix) / 2);

    await seedItemWithAnalyzedAt({
      org: "corp-a", name: "Corp A",
      sourceUrl: "https://corp-a.com/in-window",
      analyzedAtUnix: midWindow,
    });

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);
  });

  test("excludes item with analyzed_at before yesterday's UTC+8 window", async () => {
    const { startUnix } = getYesterdayPeriod(TZ);
    const beforeWindow = startUnix - 3600; // 1 hour before window start

    await seedItemWithAnalyzedAt({
      org: "corp-a", name: "Corp A",
      sourceUrl: "https://corp-a.com/before-window",
      analyzedAtUnix: beforeWindow,
    });

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  test("excludes item with analyzed_at after yesterday's UTC+8 window (i.e. today)", async () => {
    const { endUnix } = getYesterdayPeriod(TZ);
    const afterWindow = endUnix + 3600; // 1 hour after window end (today)

    await seedItemWithAnalyzedAt({
      org: "corp-a", name: "Corp A",
      sourceUrl: "https://corp-a.com/after-window",
      analyzedAtUnix: afterWindow,
    });

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  test("includes only items within the window when mixed timestamps present", async () => {
    const { startUnix, endUnix } = getYesterdayPeriod(TZ);
    const midWindow = Math.floor((startUnix + endUnix) / 2);

    await seedItemWithAnalyzedAt({
      org: "corp-a", name: "Corp A",
      sourceUrl: "https://corp-a.com/in",
      analyzedAtUnix: midWindow,
    });
    await seedItemWithAnalyzedAt({
      org: "corp-b", name: "Corp B",
      sourceUrl: "https://corp-b.com/out-old",
      analyzedAtUnix: startUnix - 86400, // 2 days ago
    });
    await seedItemWithAnalyzedAt({
      org: "corp-c", name: "Corp C",
      sourceUrl: "https://corp-c.com/out-new",
      analyzedAtUnix: endUnix + 3600, // today
    });

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.itemsProcessed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("ReportStage weekly: generates report and deliveries with no items in window", () => {
  test("weekly mode succeeds and writes a report row even with no analyzed items", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    const result = await stage.execute(makeCTX({ mode: "weekly" }));

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ report_type: string; item_count: number }, []>(
      `SELECT report_type, item_count FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get();
    expect(row).not.toBeNull();
    expect(row!.report_type).toBe("weekly");
    expect(row!.item_count).toBe(0);
  });

  test("weekly mode writes report_deliveries with delivery_status=pending even with no items", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const report = db.query<{ id: number }, []>(
      `SELECT id FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const deliveries = db.query<{ delivery_status: string }, []>(
      `SELECT delivery_status FROM report_deliveries WHERE report_id = ${report.id}`
    ).all();
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      expect(d.delivery_status).toBe("pending");
    }
  });

  test("weekly mode writes report file even with no items", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    expect(existsSync(`data/reports/weekly-${REPORT_DATE}.json`)).toBe(true);
  });
});
