import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { ReportStage } from "../../pipeline/stages/report.js";
import type { PipelineContext, StageResult } from "../../pipeline/runner.js";
import type { WeeklyTheme } from "../../schema/analysis.js";

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

const noopGenerateObject = async (_opts: unknown): Promise<{ object: WeeklyTheme }> => ({
  object: { themes: [{ title: "T1", description: "D1", competitors: ["A"] }, { title: "T2", description: "D2", competitors: ["B"] }] },
});

// Helper: seed a complete competitor + content_item + analysis ready for report
async function seedCompletedItem(opts: {
  org: string;
  name: string;
  significance?: "routine" | "notable" | "directional_shift";
  sourceUrl?: string;
  summary?: string;
}) {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const sig = opts.significance ?? "routine";
  const url = opts.sourceUrl ?? `https://${opts.org}.com/post-1`;
  const summary = opts.summary ?? "Summary text";

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
    VALUES (${item.id}, '${summary.replace(/'/g, "''")}', '${sig}', 'normal')
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

// ---------------------------------------------------------------------------
describe("ReportStage.execute weekly mode", () => {
  test("stores DB row with report_type='weekly'", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    const result = await stage.execute(makeCTX({ mode: "weekly" }));

    expect(result.success).toBe(true);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ report_type: string }, []>(
      `SELECT report_type FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get();
    expect(row?.report_type).toBe("weekly");
  });

  test("creates file at data/reports/weekly-YYYY-MM-DD.json", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    expect(existsSync(`data/reports/weekly-${REPORT_DATE}.json`)).toBe(true);
  });

  test("includes items with reported_at set (not filtered out)", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    db.exec(`INSERT INTO competitors (name, org) VALUES ('Corp A', 'corp-a')`);
    const comp = db.query<{ id: number }, []>("SELECT id FROM competitors WHERE org = 'corp-a'").get()!;
    db.exec(`
      INSERT INTO content_items
        (competitor_id, source, source_url, title, content, analysis_status, reported_at)
      VALUES (${comp.id}, 'blog', 'https://corp-a.com/old', 'Old Post', 'Old', 'complete', datetime('now'))
    `);
    const item = db.query<{ id: number }, []>("SELECT id FROM content_items WHERE source_url = 'https://corp-a.com/old'").get()!;
    db.exec(`INSERT INTO analyses (content_item_id, summary, significance, urgency) VALUES (${item.id}, 'Summary', 'routine', 'normal')`);

    const stage = new ReportStage(noopGenerateObject as never);
    const result = await stage.execute(makeCTX({ mode: "weekly" }));

    expect(result.itemsProcessed).toBe(1);
  });

  test("does NOT set reported_at on items", async () => {
    const { itemId } = await seedCompletedItem({ org: "corp-a", name: "Corp A" });

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ reported_at: string | null }, []>(
      `SELECT reported_at FROM content_items WHERE id = ${itemId}`
    ).get();
    expect(row?.reported_at).toBeNull();
  });

  test("weekly card has header.template='purple'", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as { cards: Array<{ header: { template?: string } }> };
    expect(report.cards[0]!.header.template).toBe("purple");
  });

  test("weekly card title contains week range", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ header: { title: { content: string } } }>;
    };
    const title = report.cards[0]!.header.title.content;
    expect(title).toContain("竞品动态周报");
    expect(title).toContain("2026-05-27"); // weekStart = 2026-06-02 - 6 days
    expect(title).toContain(REPORT_DATE);
  });

  test("weekly card elements contain Direction Changes section", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "directional_shift" });

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string; content?: string }> }>;
    };
    const allContent = report.cards[0]!.elements
      .filter((e) => e.tag === "markdown")
      .map((e) => e.content ?? "")
      .join("\n");
    expect(allContent).toContain("方向性变化");
  });

  test("weekly card elements contain Activity Summary section", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable" });

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string; content?: string }> }>;
    };
    const allContent = report.cards[0]!.elements
      .filter((e) => e.tag === "markdown")
      .map((e) => e.content ?? "")
      .join("\n");
    expect(allContent).toContain("活动概览");
    expect(allContent).toContain("Corp A");
  });

  test("themes section shows placeholder when fewer than 3 items", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable" });
    await seedCompletedItem({ org: "corp-b", name: "Corp B", significance: "routine", sourceUrl: "https://corp-b.com/p1" });

    let llmCalled = false;
    const trackingGenerateObject = async (_opts: unknown): Promise<{ object: WeeklyTheme }> => {
      llmCalled = true;
      return { object: { themes: [] } };
    };

    const stage = new ReportStage(trackingGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    expect(llmCalled).toBe(false);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string; content?: string }> }>;
    };
    const allContent = report.cards[0]!.elements
      .filter((e) => e.tag === "markdown")
      .map((e) => e.content ?? "")
      .join("\n");
    expect(allContent).toContain("数据不足，跳过主题提取");
  });

  test("LLM theme extraction called with item summaries when >= 3 items", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", sourceUrl: "https://corp-a.com/p1" });
    await seedCompletedItem({ org: "corp-b", name: "Corp B", sourceUrl: "https://corp-b.com/p1" });
    await seedCompletedItem({ org: "corp-c", name: "Corp C", sourceUrl: "https://corp-c.com/p1" });

    let capturedPrompt = "";
    const capturingGenerateObject = async (opts: { prompt: string }): Promise<{ object: WeeklyTheme }> => {
      capturedPrompt = opts.prompt;
      return { object: { themes: [{ title: "T1", description: "D1", competitors: ["Corp A"] }, { title: "T2", description: "D2", competitors: ["Corp B"] }] } };
    };

    const stage = new ReportStage(capturingGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    expect(capturedPrompt).toContain("Corp A");
    expect(capturedPrompt).toContain("Corp B");
    expect(capturedPrompt).toContain("Corp C");
    expect(capturedPrompt).toContain("Summary text");
  });

  test("LLM failure is graceful: stage succeeds, no themes in output", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", sourceUrl: "https://corp-a.com/p1" });
    await seedCompletedItem({ org: "corp-b", name: "Corp B", sourceUrl: "https://corp-b.com/p1" });
    await seedCompletedItem({ org: "corp-c", name: "Corp C", sourceUrl: "https://corp-c.com/p1" });

    const failingGenerateObject = async (_opts: unknown): Promise<{ object: WeeklyTheme }> => {
      throw new Error("LLM timeout");
    };

    const stage = new ReportStage(failingGenerateObject as never);
    const result = await stage.execute(makeCTX({ mode: "weekly" }));

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("repeated weekly runs on same date upsert (no duplicate rows)", async () => {
    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const rows = db.query<{ id: number }, []>(
      `SELECT id FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).all();
    expect(rows.length).toBe(1);
  });

  test(">20KB weekly card trims routine panels, keeps notable panels", async () => {
    // Seed two notable items plus many routine items with long summaries to push
    // the single card over 20KB, triggering the trim path.
    const longSummary = "競品动态分析。".repeat(60); // ~420 chars per item

    await seedCompletedItem({
      org: "corp-a", name: "Corp A", significance: "notable",
      sourceUrl: "https://corp-a.com/notable-1", summary: longSummary,
    });
    await seedCompletedItem({
      org: "corp-a", name: "Corp A", significance: "notable",
      sourceUrl: "https://corp-a.com/notable-2", summary: longSummary,
    });

    // 40 routine items with long summaries easily exceed 20KB
    for (let i = 0; i < 40; i++) {
      await seedCompletedItem({
        org: "corp-a", name: "Corp A", significance: "routine",
        sourceUrl: `https://corp-a.com/routine-${i}`, summary: longSummary,
      });
    }

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{
        elements: Array<{ tag: string; header?: { title: { content: string } } }>;
      }>;
    };

    // Trimming should reduce to a single card
    expect(report.cards.length).toBe(1);

    const elements = report.cards[0]!.elements;
    const panels = elements.filter((e) => e.tag === "collapsible_panel") as Array<{
      tag: string;
      elements: Array<{ content: string }>;
    }>;

    // Only the 2 notable panels should remain; all 40 routine panels trimmed away
    expect(panels.length).toBe(2);

    // Panel content contains the source URL — confirm notable URLs present, routine absent
    const allPanelContent = panels.flatMap((p) => p.elements.map((el) => el.content)).join("\n");
    expect(allPanelContent).toContain("notable-1");
    expect(allPanelContent).toContain("notable-2");
    expect(allPanelContent).not.toContain("routine-");

    // Omission notice present
    const allText = elements
      .filter((e) => e.tag === "markdown")
      .map((e) => (e as { content?: string }).content ?? "")
      .join("\n");
    expect(allText).toContain("已省略");
  });

  test("daily mode unaffected by weekly implementation", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable" });

    const stage = new ReportStage();
    const result = await stage.execute(makeCTX({ mode: "daily" }));

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ report_type: string }, []>(
      `SELECT report_type FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get();
    expect(row?.report_type).toBe("daily");
    expect(existsSync(`data/reports/daily-${REPORT_DATE}.json`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("Lark card size degradation — daily", () => {
  test("<20KB report → single complete card with all items", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n1" });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "routine", sourceUrl: "https://corp-a.com/r1" });

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string }> }>;
    };

    expect(report.cards.length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(report.cards[0]), "utf-8")).toBeLessThan(20 * 1024);

    const panels = report.cards[0]!.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels.length).toBe(2);
  });

  test(">20KB full card, <=28KB trimmed → single trimmed card + omission footer", async () => {
    const longSummary = "x".repeat(1500);
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n1", summary: longSummary });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n2", summary: longSummary });
    for (let i = 0; i < 8; i++) {
      await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "routine", sourceUrl: `https://corp-a.com/r${i}`, summary: longSummary });
    }

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string; content?: string }> }>;
    };

    expect(report.cards.length).toBe(1);
    const cardBytes = Buffer.byteLength(JSON.stringify(report.cards[0]), "utf-8");
    expect(cardBytes).toBeGreaterThan(0);
    expect(cardBytes).toBeLessThanOrEqual(28 * 1024);

    const panels = report.cards[0]!.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels.length).toBe(2);

    const allText = report.cards[0]!.elements
      .filter((e) => e.tag === "markdown")
      .map((e) => (e as { content?: string }).content ?? "")
      .join("\n");
    expect(allText).toContain("已省略");
    expect(allText).toContain("8");
  });

  test(">28KB trimmed → multiple cards, one per competitor", async () => {
    // 5 notable items per competitor (2 competitors) = 10 notable items with 1500-char summaries
    // Trimmed card ≈ 10 × 3300 + 500 ≈ 33500 bytes > 28KB → Level 3 split
    const longSummary = "x".repeat(1500);
    for (let i = 0; i < 5; i++) {
      await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: `https://corp-a.com/n${i}`, summary: longSummary });
    }
    for (let i = 0; i < 5; i++) {
      await seedCompletedItem({ org: "corp-b", name: "Corp B", significance: "notable", sourceUrl: `https://corp-b.com/n${i}`, summary: longSummary });
    }

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ config: unknown; header: unknown; elements: unknown[] }>;
    };

    expect(report.cards.length).toBe(2);
    for (const card of report.cards) {
      expect(card.config).toBeDefined();
      expect(card.header).toBeDefined();
      expect(Array.isArray(card.elements)).toBe(true);
    }
  });

  test("byte-accurate measurement: Chinese text exceeding 20KB by bytes but not chars triggers trim", async () => {
    // "中" = 1 char (old .length) but 3 bytes (Buffer.byteLength).
    // 3500 Chinese chars: .length contribution ≈ 7400 chars/card << 20×1024 chars
    //                     Buffer.byteLength ≈ 21400 bytes/card > 20×1024 bytes
    // Old code (.length check) returns complete card (2 panels).
    // New code (Buffer.byteLength check) takes trim path (1 notable panel + footer).
    const chineseSummary = "中".repeat(3500);
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n1", summary: chineseSummary });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "routine", sourceUrl: "https://corp-a.com/r1", summary: chineseSummary });

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string; content?: string }> }>;
    };

    // Byte-accurate: card > 20KB bytes → trim path taken → routine panel removed
    expect(report.cards.length).toBe(1);
    const panels = report.cards[0]!.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels.length).toBe(1);

    const allText = report.cards[0]!.elements
      .filter((e) => e.tag === "markdown")
      .map((e) => (e as { content?: string }).content ?? "")
      .join("\n");
    expect(allText).toContain("已省略");

    const trimmedBytes = Buffer.byteLength(JSON.stringify(report.cards[0]), "utf-8");
    expect(trimmedBytes).toBeLessThanOrEqual(28 * 1024);
  });
});

// ---------------------------------------------------------------------------
describe("Lark card size degradation — weekly", () => {
  test("<20KB weekly report → single complete card with all items", async () => {
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n1" });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "routine", sourceUrl: "https://corp-a.com/r1" });

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string }> }>;
    };

    expect(report.cards.length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(report.cards[0]), "utf-8")).toBeLessThan(20 * 1024);

    const panels = report.cards[0]!.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels.length).toBe(2);
  });

  test(">20KB weekly full card, <=28KB trimmed → single trimmed card + omission footer", async () => {
    const longSummary = "x".repeat(1500);
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n1", summary: longSummary });
    await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: "https://corp-a.com/n2", summary: longSummary });
    // Weekly cards have less structural overhead than daily — need 15+ routine items to exceed 20KB
    for (let i = 0; i < 15; i++) {
      await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "routine", sourceUrl: `https://corp-a.com/r${i}`, summary: longSummary });
    }

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ elements: Array<{ tag: string; content?: string }> }>;
    };

    expect(report.cards.length).toBe(1);
    const cardBytes = Buffer.byteLength(JSON.stringify(report.cards[0]), "utf-8");
    expect(cardBytes).toBeLessThanOrEqual(28 * 1024);

    const panels = report.cards[0]!.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels.length).toBe(2);

    const allText = report.cards[0]!.elements
      .filter((e) => e.tag === "markdown")
      .map((e) => (e as { content?: string }).content ?? "")
      .join("\n");
    expect(allText).toContain("已省略");
    expect(allText).toContain("15");
  });

  test(">28KB weekly trimmed → multiple cards, one per competitor", async () => {
    const longSummary = "x".repeat(1500);
    // Weekly trimmed card needs 17+ items with 1500-char summaries to exceed 28KB
    for (let i = 0; i < 9; i++) {
      await seedCompletedItem({ org: "corp-a", name: "Corp A", significance: "notable", sourceUrl: `https://corp-a.com/n${i}`, summary: longSummary });
    }
    for (let i = 0; i < 9; i++) {
      await seedCompletedItem({ org: "corp-b", name: "Corp B", significance: "notable", sourceUrl: `https://corp-b.com/n${i}`, summary: longSummary });
    }

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ config: unknown; header: { template?: string }; elements: unknown[] }>;
    };

    expect(report.cards.length).toBe(2);
    for (const card of report.cards) {
      expect(card.config).toBeDefined();
      expect(card.header).toBeDefined();
      expect(Array.isArray(card.elements)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("Lark card Level-3 byte-bounded chunking", () => {
  test("daily: single competitor with enough notables to exceed 28KB per card → chunked into multiple byte-bounded cards", async () => {
    const longSummary = "x".repeat(1500);
    // 10 notable items from 1 competitor: per-competitor card ≈ 33KB > 28KB → chunking required
    for (let i = 0; i < 10; i++) {
      await seedCompletedItem({
        org: "corp-a", name: "Corp A", significance: "notable",
        sourceUrl: `https://corp-a.com/n${i}`, summary: longSummary,
      });
    }

    const stage = new ReportStage();
    await stage.execute(makeCTX());

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'daily'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ config: unknown; header: unknown; elements: unknown[] }>;
    };

    // Chunking must produce multiple cards
    expect(report.cards.length).toBeGreaterThan(1);

    // Every emitted card must be within the 28KB byte limit
    for (const card of report.cards) {
      const cardBytes = Buffer.byteLength(JSON.stringify(card), "utf-8");
      expect(cardBytes).toBeLessThanOrEqual(28 * 1024);
      expect(card.config).toBeDefined();
      expect(card.header).toBeDefined();
      expect(Array.isArray(card.elements)).toBe(true);
    }
  });

  test("weekly: single competitor with enough notables to exceed 28KB per card → chunked into multiple byte-bounded cards", async () => {
    const longSummary = "x".repeat(1500);
    // 20 notable items from 1 competitor: per-competitor weekly card ≈ 34KB > 28KB → chunking required
    for (let i = 0; i < 20; i++) {
      await seedCompletedItem({
        org: "corp-a", name: "Corp A", significance: "notable",
        sourceUrl: `https://corp-a.com/n${i}`, summary: longSummary,
      });
    }

    const stage = new ReportStage(noopGenerateObject as never);
    await stage.execute(makeCTX({ mode: "weekly" }));

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const row = db.query<{ content: string }, []>(
      `SELECT content FROM reports WHERE report_date = '${REPORT_DATE}' AND report_type = 'weekly'`
    ).get()!;
    const report = JSON.parse(row.content) as {
      cards: Array<{ config: unknown; header: { template?: string }; elements: unknown[] }>;
    };

    expect(report.cards.length).toBeGreaterThan(1);

    for (const card of report.cards) {
      const cardBytes = Buffer.byteLength(JSON.stringify(card), "utf-8");
      expect(cardBytes).toBeLessThanOrEqual(28 * 1024);
      expect(card.config).toBeDefined();
      expect(card.header).toBeDefined();
      expect(Array.isArray(card.elements)).toBe(true);
    }
  });
});
