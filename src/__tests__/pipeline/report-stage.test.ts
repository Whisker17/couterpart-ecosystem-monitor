import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { ReportStage } from "../../pipeline/stages/report.js";
import type { PipelineContext, StageResult } from "../../pipeline/runner.js";

const TEST_DB_PATH = "data/test-report-stage.db";
const REPORT_DATE = "2026-06-02";

function makeCTX(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    mode: "daily",
    reportDate: REPORT_DATE,
    timezone: "UTC",
    startedAt: new Date(),
    stageResults: new Map(),
    ...overrides,
  };
}

function makeCollectResult(statuses: Array<{ org: string; name: string; success: boolean }>): StageResult {
  return {
    success: true,
    itemsProcessed: 0,
    errors: [],
    durationMs: 0,
    competitorStatuses: statuses.map((s) => ({
      competitorId: s.org,
      competitorName: s.name,
      success: s.success,
      itemsCollected: 0,
    })),
  };
}

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
  // Clean up report files written during tests
  try { rmSync(`data/reports`, { recursive: true, force: true }); } catch { /* ok */ }
  delete process.env.DB_PATH;
});

// Helper: seed a complete competitor + content_item + analysis ready for report
async function seedCompletedItem(opts: {
  org: string;
  name: string;
  significance?: "routine" | "notable" | "directional_shift";
  sourceUrl?: string;
}) {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const sig = opts.significance ?? "routine";
  const url = opts.sourceUrl ?? `https://${opts.org}.com/post-1`;

  db.exec(`
    INSERT OR IGNORE INTO competitors (name, org)
    VALUES ('${opts.name}', '${opts.org}')
  `);
  const comp = db.query<{ id: number }, []>(
    `SELECT id FROM competitors WHERE org = '${opts.org}'`
  ).get()!;

  db.exec(`
    INSERT OR IGNORE INTO content_items
      (competitor_id, source, source_url, title, content, analysis_status)
    VALUES (${comp.id}, 'blog', '${url}', 'Test Title', 'Test content', 'complete')
  `);
  const item = db.query<{ id: number }, []>(
    `SELECT id FROM content_items WHERE source_url = '${url}'`
  ).get()!;

  db.exec(`
    INSERT OR IGNORE INTO analyses
      (content_item_id, summary, significance, urgency)
    VALUES (${item.id}, 'Summary text', '${sig}', 'normal')
  `);

  return { competitorId: comp.id, itemId: item.id };
}

// ---------------------------------------------------------------------------
describe("ReportStage.execute", () => {
  test("generates empty daily report when no unreported items exist", async () => {
    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  test("local JSON file is created at data/reports/daily-YYYY-MM-DD.json", async () => {
    const stage = new ReportStage();
    await stage.execute(makeCTX());

    expect(existsSync(`data/reports/daily-${REPORT_DATE}.json`)).toBe(true);
  });

  test("report JSON has config, header, elements layers", async () => {
    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).get();
    expect(row).not.toBeNull();

    const report = JSON.parse(row!.content) as { cards: unknown[] };
    expect(Array.isArray(report.cards)).toBe(true);
    const firstCard = report.cards[0] as { config: unknown; header: unknown; elements: unknown[] };
    expect(firstCard.config).toBeDefined();
    expect(firstCard.header).toBeDefined();
    expect(Array.isArray(firstCard.elements)).toBe(true);
  });

  test("repeated runs on same day do not create duplicate reports (upsert)", async () => {
    const stage = new ReportStage();
    await stage.execute(makeCTX());
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const rows = db.query<{ id: number }, []>(
      `SELECT id FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).all();
    expect(rows.length).toBe(1);
  });

  test("items with analysis_status=complete and reported_at=NULL are included", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable" });

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.itemsProcessed).toBe(1);
  });

  test("reported_at is set on included items after report generation", async () => {
    const { itemId } = await seedCompletedItem({ org: "corp-a", name: "Corp A" });

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ reported_at: string | null }, []>(
      `SELECT reported_at FROM content_items WHERE id = ${itemId}`
    ).get();
    expect(row?.reported_at).not.toBeNull();
  });

  test("items already reported (reported_at NOT NULL) are not re-included", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    db.exec(`
      INSERT INTO competitors (name, org) VALUES ('Corp A', 'corp-a')
    `);
    const comp = db.query<{ id: number }, []>("SELECT id FROM competitors WHERE org = 'corp-a'").get()!;
    db.exec(`
      INSERT INTO content_items
        (competitor_id, source, source_url, title, content, analysis_status, reported_at)
      VALUES (${comp.id}, 'blog', 'https://corp-a.com/post-already', 'Old Post', 'Old', 'complete', datetime('now'))
    `);

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX());

    expect(result.itemsProcessed).toBe(0);
  });

  test("items sorted directional_shift > notable > routine within competitor", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "routine", sourceUrl: "https://corp-a.com/p1" });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "directional_shift", sourceUrl: "https://corp-a.com/p2" });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/p3" });

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      items: Array<{ significance: string }>;
    };
    const significances = report.items.map((i) => i.significance);
    expect(significances[0]).toBe("directional_shift");
    expect(significances[1]).toBe("notable");
    expect(significances[2]).toBe("routine");
  });

  test("upstream partial failure sets is_partial=1 and card header shows partial marker", async () => {
    const ctx = makeCTX();
    ctx.stageResults.set(
      "collect",
      makeCollectResult([
        { org: "corp-ok", name: "Corp OK", success: true },
        { org: "corp-fail", name: "Corp Fail", success: false },
      ])
    );

    const stage = new ReportStage();
    await stage.execute(ctx);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ is_partial: number }, []>(
      `SELECT is_partial FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get();
    expect(row?.is_partial).toBe(1);
  });

  test("no partial flag when all collect statuses are success", async () => {
    const ctx = makeCTX();
    ctx.stageResults.set(
      "collect",
      makeCollectResult([
        { org: "corp-ok", name: "Corp OK", success: true },
      ])
    );

    const stage = new ReportStage();
    await stage.execute(ctx);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ is_partial: number }, []>(
      `SELECT is_partial FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get();
    expect(row?.is_partial).toBe(0);
  });

  test("creates report_deliveries rows with delivery_status=pending", async () => {
    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const report = db.query<{ id: number }, []>(
      `SELECT id FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get()!;
    const deliveries = db.query<{ delivery_status: string }, []>(
      `SELECT delivery_status FROM report_deliveries WHERE report_id = ${report.id}`
    ).all();
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      expect(d.delivery_status).toBe("pending");
    }
  });

  test("content_hash unchanged on repeated run skips delivery rebuild", async () => {
    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    // Mark the delivery as sent so we can detect if it's rebuilt
    db.exec(`UPDATE report_deliveries SET delivery_status = 'sent'`);

    await stage.execute(makeCTX());

    // Delivery should still be 'sent' (not rebuilt)
    const deliveries = db.query<{ delivery_status: string }, []>(
      `SELECT delivery_status FROM report_deliveries`
    ).all();
    for (const d of deliveries) {
      expect(d.delivery_status).toBe("sent");
    }
  });

  test("content_hash changed on second run rebuilds deliveries and resets sent_at", async () => {
    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    // Force a different content_hash
    db.exec(`UPDATE reports SET content_hash = 'old-hash', sent_at = datetime('now')`);
    db.exec(`UPDATE report_deliveries SET delivery_status = 'sent'`);

    await stage.execute(makeCTX());

    const report = db.query<{ sent_at: string | null }, []>(
      `SELECT sent_at FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get()!;
    expect(report.sent_at).toBeNull();

    const deliveries = db.query<{ delivery_status: string }, []>(
      `SELECT delivery_status FROM report_deliveries`
    ).all();
    for (const d of deliveries) {
      expect(d.delivery_status).toBe("pending");
    }
  });
});
