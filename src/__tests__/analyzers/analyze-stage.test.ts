import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { AnalyzeStage } from "../../pipeline/stages/analyze.js";
import type { PipelineContext } from "../../pipeline/runner.js";
import type { GenerateObjectFn } from "../../analyzers/llm-reviewer.js";
import type { ContentAnalysis } from "../../schema/analysis.js";

const TEST_DB_PATH = "data/test-analyze-stage.db";

const CTX: PipelineContext = {
  mode: "daily",
  reportDate: "2026-06-03",
  timezone: "UTC",
  startedAt: new Date(),
  stageResults: new Map(),
};

const VALID_ANALYSIS: ContentAnalysis = {
  summary: "竞品发布了新功能。",
  technical_detail: "基于Transformer架构。",
  category: "product_launch",
  direction_signal: "加速AI化。",
  significance: "notable",
  urgency: "normal",
  sentiment: "positive",
  why_we_care: "可能影响我们的市场份额。",
};

function makeGenerateObjectMock(
  analysis: ContentAnalysis = VALID_ANALYSIS,
  inputTokens = 100,
  outputTokens = 50
): GenerateObjectFn {
  return async (_opts) => ({
    object: analysis,
    usage: { inputTokens, outputTokens },
  });
}

function makeFailingGenerateObjectMock(): GenerateObjectFn {
  return async (_opts) => {
    throw new Error("LLM API error");
  };
}

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
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
  delete process.env.DB_PATH;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
});

async function seedPendingItem(db: import("bun:sqlite").Database, overrides: Partial<{
  retry_count: number;
  analysis_status: string;
  competitor_name: string;
}> = {}) {
  db.exec(`
    INSERT INTO competitors (name, org, tags) VALUES ('Test Corp', 'test-corp', '["infra"]')
  `);
  const competitorId = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
  db.exec(`
    INSERT INTO content_items
      (competitor_id, source, source_url, title, content, input_quality,
       analysis_status, retry_count)
    VALUES (
      ${competitorId}, 'blog', 'https://test-corp.com/post-1',
      'Test Post', 'Full content here.', 'full',
      '${overrides.analysis_status ?? "pending"}',
      ${overrides.retry_count ?? 0}
    )
  `);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}

describe("AnalyzeStage.execute", () => {
  test("returns success=true with 0 items when no pending content", async () => {
    const { getDb } = await import("../../storage/db.js");
    getDb();
    const stage = new AnalyzeStage(makeGenerateObjectMock());
    const result = await stage.execute(CTX);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  test("processes pending item and marks it complete", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db);

    const stage = new AnalyzeStage(makeGenerateObjectMock());
    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const item = db
      .query<{ analysis_status: string }, []>(
        "SELECT analysis_status FROM content_items WHERE id = 1"
      )
      .get();
    expect(item?.analysis_status).toBe("complete");
  });

  test("writes analysis row with all fields", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db);

    const stage = new AnalyzeStage(makeGenerateObjectMock());
    await stage.execute(CTX);

    const row = db
      .query<{
        summary: string;
        category: string;
        significance: string;
        input_tokens: number;
        output_tokens: number;
        estimated_cost_usd: number;
        model_id: string;
      }, []>(
        "SELECT summary, category, significance, input_tokens, output_tokens, estimated_cost_usd, model_id FROM analyses"
      )
      .get();

    expect(row?.summary).toBe(VALID_ANALYSIS.summary);
    expect(row?.category).toBe(VALID_ANALYSIS.category);
    expect(row?.significance).toBe(VALID_ANALYSIS.significance);
    expect(row?.input_tokens).toBe(100);
    expect(row?.output_tokens).toBe(50);
    expect(row?.estimated_cost_usd).toBeGreaterThan(0);
    expect(typeof row?.model_id).toBe("string");
  });

  test("writes analysis_inputs audit row on success", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db);

    const stage = new AnalyzeStage(makeGenerateObjectMock());
    await stage.execute(CTX);

    const auditRow = db
      .query<{
        content_item_id: number;
        analysis_id: number | null;
        attempt: number;
        prompt_version: string;
        error: string | null;
      }, []>(
        "SELECT content_item_id, analysis_id, attempt, prompt_version, error FROM analysis_inputs"
      )
      .get();

    expect(auditRow?.content_item_id).toBe(1);
    expect(auditRow?.analysis_id).not.toBeNull();
    expect(auditRow?.attempt).toBe(1);
    expect(auditRow?.prompt_version).toBe("v2");
    expect(auditRow?.error).toBeNull();
  });

  test("on LLM failure, increments retry_count and keeps status pending (retry_count < 3)", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db, { retry_count: 0 });

    const stage = new AnalyzeStage(makeFailingGenerateObjectMock());
    const result = await stage.execute(CTX);

    expect(result.itemsProcessed).toBe(0);
    expect(result.errors.length).toBe(1);

    const item = db
      .query<{ analysis_status: string; retry_count: number }, []>(
        "SELECT analysis_status, retry_count FROM content_items WHERE id = 1"
      )
      .get();
    expect(item?.retry_count).toBe(1);
    expect(item?.analysis_status).toBe("pending");
  });

  test("on LLM failure at retry_count=2, marks item failed (terminal)", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db, { retry_count: 2 });

    const stage = new AnalyzeStage(makeFailingGenerateObjectMock());
    await stage.execute(CTX);

    const item = db
      .query<{ analysis_status: string; retry_count: number }, []>(
        "SELECT analysis_status, retry_count FROM content_items WHERE id = 1"
      )
      .get();
    expect(item?.retry_count).toBe(3);
    expect(item?.analysis_status).toBe("failed");
  });

  test("writes analysis_inputs audit row on failure with NULL analysis_id", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db);

    const stage = new AnalyzeStage(makeFailingGenerateObjectMock());
    await stage.execute(CTX);

    const auditRow = db
      .query<{
        analysis_id: number | null;
        error: string | null;
      }, []>(
        "SELECT analysis_id, error FROM analysis_inputs"
      )
      .get();

    expect(auditRow?.analysis_id).toBeNull();
    expect(auditRow?.error).toContain("LLM API error");
  });

  test("skips items already marked failed (not in pending query)", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db, { analysis_status: "failed" });

    const stage = new AnalyzeStage(makeGenerateObjectMock());
    const result = await stage.execute(CTX);

    expect(result.itemsProcessed).toBe(0);
    const analyses = db.query<{ id: number }, []>("SELECT id FROM analyses").all();
    expect(analyses.length).toBe(0);
  });

  test("skips items already marked complete (not in pending query)", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    await seedPendingItem(db, { analysis_status: "complete" });

    const stage = new AnalyzeStage(makeGenerateObjectMock());
    const result = await stage.execute(CTX);

    expect(result.itemsProcessed).toBe(0);
  });

  test("budget cap stops processing when monthly spend >= cap", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    // Seed two pending items
    db.exec(`INSERT INTO competitors (name, org) VALUES ('Corp A', 'corp-a')`);
    const cid = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
    db.exec(`
      INSERT INTO content_items (competitor_id, source, source_url, content, analysis_status)
      VALUES
        (${cid}, 'blog', 'https://corp-a.com/post-1', 'content1', 'pending'),
        (${cid}, 'blog', 'https://corp-a.com/post-2', 'content2', 'pending')
    `);

    // Seed an existing analysis that consumes the full budget
    const monthlyCap = 40; // from settings.json
    db.exec(`
      INSERT INTO analyses
        (content_item_id, summary, significance, input_tokens, output_tokens,
         model_id, estimated_cost_usd, analyzed_at)
      VALUES
        (1, 'prior analysis', 'routine', 1000, 500,
         'claude-sonnet-4-6', ${monthlyCap}, datetime('now'))
    `);

    let callCount = 0;
    const countingMock: GenerateObjectFn = async (_opts) => {
      callCount++;
      return makeGenerateObjectMock()(_opts);
    };

    const stage = new AnalyzeStage(countingMock);
    const result = await stage.execute(CTX);

    expect(callCount).toBe(0);
    expect(result.itemsProcessed).toBe(0);
  });

  test("budget cap enforced when prior analysis stored with SQLite datetime format (YYYY-MM-DD HH:MM:SS)", async () => {
    // Regression: toISOString() produces 'YYYY-MM-DDT...' but SQLite stores
    // datetime('now') as 'YYYY-MM-DD HH:MM:SS'. Space (0x20) < 'T' (0x54)
    // lexically, so a row from the 1st of the month was excluded from the spend
    // sum. Using datetime() on both sides of the comparison fixes this.
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    db.exec(`INSERT INTO competitors (name, org) VALUES ('Corp X', 'corp-x')`);
    const cid = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
    db.exec(`
      INSERT INTO content_items (competitor_id, source, source_url, content, analysis_status)
      VALUES (${cid}, 'blog', 'https://corp-x.com/post-1', 'content1', 'pending')
    `);

    // Seed a prior analysis row using SQLite's native datetime format ('YYYY-MM-DD HH:MM:SS')
    // on the 1st of the current month, mid-day. The buggy code would miss this row.
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01 12:00:00`;
    const monthlyCap = 40; // matches settings.json
    db.exec(`
      INSERT INTO analyses
        (content_item_id, summary, significance, input_tokens, output_tokens,
         model_id, estimated_cost_usd, analyzed_at)
      VALUES
        (1, 'prior analysis', 'routine', 1000, 500,
         'claude-sonnet-4-6', ${monthlyCap}, '${firstOfMonth}')
    `);

    let callCount = 0;
    const countingMock: GenerateObjectFn = async (_opts) => {
      callCount++;
      return makeGenerateObjectMock()(_opts);
    };

    const stage = new AnalyzeStage(countingMock);
    const result = await stage.execute(CTX);

    // The prior analysis fills the budget; the pending item must not be processed
    expect(callCount).toBe(0);
    expect(result.itemsProcessed).toBe(0);
  });

  test("budget warning logs at most once per run with multiple pending items", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    db.exec(`INSERT INTO competitors (name, org) VALUES ('Corp W', 'corp-w')`);
    const cid = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
    db.exec(`
      INSERT INTO content_items (competitor_id, source, source_url, content, analysis_status)
      VALUES
        (${cid}, 'blog', 'https://corp-w.com/post-1', 'content1', 'pending'),
        (${cid}, 'blog', 'https://corp-w.com/post-2', 'content2', 'pending'),
        (${cid}, 'blog', 'https://corp-w.com/post-3', 'content3', 'pending')
    `);

    // Seed prior spend at 80% of cap (warning threshold) — 40 * 0.8 = 32
    const monthlyCap = 40;
    db.exec(`
      INSERT INTO analyses
        (content_item_id, summary, significance, input_tokens, output_tokens,
         model_id, estimated_cost_usd, analyzed_at)
      VALUES
        (1, 'prior', 'routine', 1000, 500, 'claude-sonnet-4-6', ${monthlyCap * 0.85}, datetime('now'))
    `);

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(" "));
      origWarn(...args);
    };

    try {
      const stage = new AnalyzeStage(makeGenerateObjectMock());
      await stage.execute(CTX);
    } finally {
      console.warn = origWarn;
    }

    const budgetWarnings = warnMessages.filter((m) => m.includes("[analyze] budget warning"));
    expect(budgetWarnings.length).toBe(1);
  });

  test("processes multiple items in a single run", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    db.exec(`INSERT INTO competitors (name, org) VALUES ('Corp B', 'corp-b')`);
    const cid = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
    db.exec(`
      INSERT INTO content_items (competitor_id, source, source_url, content, analysis_status)
      VALUES
        (${cid}, 'blog', 'https://corp-b.com/post-1', 'content1', 'pending'),
        (${cid}, 'blog', 'https://corp-b.com/post-2', 'content2', 'pending'),
        (${cid}, 'blog', 'https://corp-b.com/post-3', 'content3', 'pending')
    `);

    const stage = new AnalyzeStage(makeGenerateObjectMock());
    const result = await stage.execute(CTX);

    expect(result.itemsProcessed).toBe(3);
    const analyses = db.query<{ id: number }, []>("SELECT id FROM analyses").all();
    expect(analyses.length).toBe(3);
  });
});
