import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { runPipeline } from "../../pipeline/runner.js";
import { CollectStage } from "../../pipeline/stages/collect.js";
import { AnalyzeStage } from "../../pipeline/stages/analyze.js";
import { ReportStage } from "../../pipeline/stages/report.js";
import { DispatchStage } from "../../pipeline/stages/dispatch.js";
import type { CompetitorConfig } from "../../config/competitors.js";
import type { CollectedItem } from "../../collectors/blog-rss.js";

const TEST_DB_PATH = "data/test-pipeline-integration.db";

// ReportStage queries items from "yesterday" relative to reportDate (via getYesterdayPeriod).
// Items analyzed by AnalyzeStage in this run have analyzed_at = datetime('now') = today.
// Using tomorrow as reportDate means "yesterday" = today, so the items fall inside the window.
function tomorrowUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const REPORT_DATE = tomorrowUTC();

const noop = async (_ms: number) => {};

const COMPETITOR_A: CompetitorConfig = {
  name: "Corp A",
  org: "corp-a",
  blogRssUrl: "https://corp-a.com/feed",
  xHandle: "corpa",
  xEnabled: false,
  websiteUrl: "https://corp-a.com",
  tags: ["infra"],
  rssQuality: "full",
};

const COMPETITOR_B: CompetitorConfig = {
  name: "Corp B",
  org: "corp-b",
  blogRssUrl: "https://corp-b.com/feed",
  xHandle: "corpb",
  xEnabled: false,
  websiteUrl: "https://corp-b.com",
  tags: ["saas"],
  rssQuality: "full",
};

function makeItem(comp: CompetitorConfig, index = 1): CollectedItem {
  return {
    competitorOrg: comp.org,
    title: `${comp.name} Post ${index}`,
    sourceUrl: `https://${comp.org}.com/post-${index}`,
    content: "Full article content here for analysis.",
    publishedAt: new Date().toISOString(),
    inputQuality: "full",
  };
}

function makeSuccessReviewFn() {
  return async (_opts: unknown) => ({
    object: {
      summary: "Competitor released a feature.",
      technical_detail: "None",
      category: "technical" as const,
      direction_signal: "Signal",
      significance: "routine" as const,
      urgency: "normal" as const,
      sentiment: "neutral" as const,
      why_we_care: "May affect us.",
    },
    usage: { inputTokens: 100, outputTokens: 50 },
  });
}

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.LLM_BASE_URL = "https://fake.example.com/v1";
  process.env.LLM_API_KEY = "fake-key";
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
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LARK_WEBHOOK_URL;
});

// ---------------------------------------------------------------------------
describe("Pipeline integration: full pipeline", () => {
  test("collect → analyze → report → dispatch all succeed via mocks", async () => {
    process.env.LARK_WEBHOOK_URL = "https://open.feishu.cn/hook/integration-test";

    let webhookCalled = false;
    const mockSendCard = async (_url: string, _card: string) => {
      webhookCalled = true;
      return { code: 0, msg: "success", data: { message_id: "msg-integration-1" } };
    };

    const stages = [
      new CollectStage(
        () => [COMPETITOR_A],
        async (comp) => [makeItem(comp)]
      ),
      new AnalyzeStage(makeSuccessReviewFn(), noop),
      new ReportStage(),
      new DispatchStage(mockSendCard),
    ];

    const ctx = await runPipeline(stages, {
      mode: "daily",
      reportDate: REPORT_DATE,
      timezone: "UTC",
    });

    // All stages must be recorded in context
    expect(ctx.stageResults.has("collect")).toBe(true);
    expect(ctx.stageResults.has("analyze")).toBe(true);
    expect(ctx.stageResults.has("report")).toBe(true);
    expect(ctx.stageResults.has("dispatch")).toBe(true);

    // All stages should succeed
    for (const [name, result] of ctx.stageResults) {
      expect(result.success).toBe(true);
      if (result.errors.length > 0) {
        throw new Error(`Stage ${name} had errors: ${result.errors.join(", ")}`);
      }
    }

    // Report stage must include at least one item (verifies date window alignment)
    expect(ctx.stageResults.get("report")?.itemsProcessed).toBeGreaterThan(0);

    // Webhook must have been called
    expect(webhookCalled).toBe(true);

    // DB state: content item should be analyzed
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const items = db.query<{ analysis_status: string }, []>(
      "SELECT analysis_status FROM content_items"
    ).all();
    expect(items.length).toBe(1);
    expect(items[0]!.analysis_status).toBe("complete");

    // Report should be sent
    const report = db.query<{ sent_at: string | null }, []>(
      `SELECT sent_at FROM reports WHERE report_date = '${REPORT_DATE}'`
    ).get();
    expect(report?.sent_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("Pipeline integration: partial failure propagation", () => {
  test("one competitor's collect fails → PipelineContext records failure, others complete normally", async () => {
    const stages = [
      new CollectStage(
        () => [COMPETITOR_A, COMPETITOR_B],
        async (comp) => {
          if (comp.org === "corp-a") throw new Error("feed unavailable");
          return [makeItem(comp)];
        }
      ),
      new AnalyzeStage(makeSuccessReviewFn(), noop),
      new ReportStage(),
    ];

    const ctx = await runPipeline(stages, {
      mode: "daily",
      reportDate: REPORT_DATE,
      timezone: "UTC",
    });

    // Collect stage should succeed overall (partial success) and record both statuses
    const collectResult = ctx.stageResults.get("collect");
    expect(collectResult).toBeDefined();
    expect(collectResult!.success).toBe(true);

    const statuses = collectResult!.competitorStatuses ?? [];
    expect(statuses.length).toBe(2);

    const failedStatus = statuses.find((s) => s.competitorId === "corp-a");
    const successStatus = statuses.find((s) => s.competitorId === "corp-b");
    expect(failedStatus?.success).toBe(false);
    expect(successStatus?.success).toBe(true);

    // corp-a failure is recorded as an error in the collect stage result
    expect(collectResult!.errors.length).toBeGreaterThan(0);
    expect(collectResult!.errors.some((e) => e.includes("corp-a"))).toBe(true);

    // corp-b item should still be analyzed (pipeline continued)
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const items = db.query<{ analysis_status: string; source_url: string }, []>(
      "SELECT analysis_status, source_url FROM content_items"
    ).all();
    expect(items.length).toBe(1);
    expect(items[0]!.source_url).toContain("corp-b");
    expect(items[0]!.analysis_status).toBe("complete");

    // Analyze and report stages still succeed
    expect(ctx.stageResults.get("analyze")?.success).toBe(true);
    expect(ctx.stageResults.get("report")?.success).toBe(true);
  });

  test("all stages complete even when one stage fails (pipeline continues)", async () => {
    // Use a stage that throws entirely (not competitor-level failure)
    const stages = [
      new CollectStage(
        () => [COMPETITOR_A],
        async (comp) => [makeItem(comp)]
      ),
      // Analyze stage with always-failing LLM (records failure but doesn't crash pipeline)
      new AnalyzeStage(async () => { throw new Error("LLM down"); }, noop),
      new ReportStage(),
    ];

    const ctx = await runPipeline(stages, {
      mode: "daily",
      reportDate: REPORT_DATE,
      timezone: "UTC",
    });

    // All three stages must be recorded in PipelineContext
    expect(ctx.stageResults.has("collect")).toBe(true);
    expect(ctx.stageResults.has("analyze")).toBe(true);
    expect(ctx.stageResults.has("report")).toBe(true);

    // Collect should succeed, analyze has errors but report still runs
    expect(ctx.stageResults.get("collect")?.success).toBe(true);
    expect(ctx.stageResults.get("report")?.success).toBe(true);
  });
});
