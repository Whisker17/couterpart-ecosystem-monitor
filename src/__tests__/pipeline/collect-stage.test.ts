import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { CollectStage } from "../../pipeline/stages/collect.js";
import type { PipelineContext } from "../../pipeline/runner.js";
import type { CompetitorConfig } from "../../config/competitors.js";
import type { CollectedItem } from "../../collectors/blog-rss.js";

const TEST_DB_PATH = "data/test-collect-stage.db";

const CTX: PipelineContext = {
  mode: "daily",
  reportDate: "2026-06-02",
  timezone: "UTC",
  startedAt: new Date(),
  stageResults: new Map(),
};

const COMPETITOR_WITH_RSS: CompetitorConfig = {
  name: "Test Corp",
  org: "test-corp",
  blogRssUrl: "https://feeds.test-corp.com/rss",
  xHandle: "testcorp",
  xEnabled: false,
  websiteUrl: "https://test-corp.com",
  tags: ["infra"],
  rssQuality: "full",
};

const COMPETITOR_NO_RSS: CompetitorConfig = {
  name: "No RSS Corp",
  org: "no-rss",
  xHandle: "norss",
  xEnabled: false,
  websiteUrl: "https://norss.com",
  tags: [],
  rssQuality: "none",
};

const SAMPLE_ITEM: CollectedItem = {
  competitorOrg: "test-corp",
  title: "Test Post",
  sourceUrl: "https://test-corp.com/post-1",
  content: "Full content here",
  publishedAt: "2026-06-01T00:00:00.000Z",
  inputQuality: "full",
};

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

describe("collectStage.execute", () => {
  test("returns success=true with empty result when no competitors have RSS", async () => {
    const stage = new CollectStage(
      () => [COMPETITOR_NO_RSS],
      async () => []
    );
    const result = await stage.execute(CTX);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  test("inserts collected items into content_items table", async () => {
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS],
      async () => [SAMPLE_ITEM]
    );

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    const result = await stage.execute(CTX);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const rows = db
      .query<{ source_url: string }, []>("SELECT source_url FROM content_items")
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.source_url).toBe("https://test-corp.com/post-1");
  });

  test("INSERT OR IGNORE prevents duplicate records on second run", async () => {
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS],
      async () => [SAMPLE_ITEM]
    );

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    await stage.execute(CTX);
    await stage.execute(CTX);

    const rows = db
      .query<{ id: number }, []>("SELECT id FROM content_items")
      .all();
    expect(rows.length).toBe(1);
  });

  test("updates competitors.last_synced_at after successful collection", async () => {
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS],
      async () => []
    );

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    await stage.execute(CTX);

    const row = db
      .query<{ last_synced_at: string | null }, []>(
        "SELECT last_synced_at FROM competitors WHERE org = 'test-corp'"
      )
      .get();
    expect(row?.last_synced_at).not.toBeNull();
  });

  test("single competitor failure does not block others", async () => {
    const BAD = { ...COMPETITOR_WITH_RSS, org: "bad-corp", blogRssUrl: "https://bad.example.com/rss" };
    const GOOD = { ...COMPETITOR_WITH_RSS, org: "good-corp", blogRssUrl: "https://good.example.com/rss" };

    const stage = new CollectStage(
      () => [BAD, GOOD],
      async (comp) => {
        if (comp.org === "bad-corp") throw new Error("feed fetch failed");
        return [{ ...SAMPLE_ITEM, competitorOrg: "good-corp", sourceUrl: "https://good.example.com/post-1" }];
      }
    );

    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("bad-corp");

    const statuses = result.competitorStatuses ?? [];
    const badStatus = statuses.find((s) => s.competitorId === "bad-corp");
    const goodStatus = statuses.find((s) => s.competitorId === "good-corp");
    expect(badStatus?.success).toBe(false);
    expect(goodStatus?.success).toBe(true);
    expect(goodStatus?.itemsCollected).toBe(1);
  });

  test("competitorStatuses in StageResult has entry per competitor", async () => {
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS, COMPETITOR_NO_RSS],
      async () => []
    );

    const result = await stage.execute(CTX);

    expect(result.competitorStatuses).toBeDefined();
    expect(result.competitorStatuses!.length).toBe(2);
  });

  test("first sync: collectFn called with a 30-day lookback Date when no last_synced_at", async () => {
    let capturedSince: Date | undefined = undefined;
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS],
      async (_comp, since) => { capturedSince = since; return []; }
    );

    const before = Date.now();
    await stage.execute(CTX);
    const after = Date.now();

    expect(capturedSince).toBeInstanceOf(Date);
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect(before - capturedSince!.getTime()).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(after - capturedSince!.getTime()).toBeLessThanOrEqual(expectedMs + 1000);
  });

  test("subsequent sync: passes last_synced_at as since to collectFn", async () => {
    const syncedAt = "2026-05-01T00:00:00.000Z";
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    db.exec(
      `INSERT INTO competitors (name, org, last_synced_at) VALUES ('Test Corp', 'test-corp', '${syncedAt}')`
    );

    let capturedSince: Date | undefined;
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS],
      async (_comp, since) => { capturedSince = since; return []; }
    );

    await stage.execute(CTX);
    expect(capturedSince).toBeDefined();
    expect(capturedSince!.toISOString()).toBe(syncedAt);
  });

  test("success=false when all RSS-enabled competitors fail", async () => {
    const stage = new CollectStage(
      () => [COMPETITOR_WITH_RSS],
      async () => { throw new Error("network error"); }
    );

    const result = await stage.execute(CTX);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
  });
});
