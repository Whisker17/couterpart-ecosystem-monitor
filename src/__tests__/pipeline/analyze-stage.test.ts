import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { APICallError, TypeValidationError } from "ai";
import { AnalyzeStage } from "../../pipeline/stages/analyze.js";
import type { PipelineContext } from "../../pipeline/runner.js";

const TEST_DB_PATH = "data/test-analyze-stage.db";

const CTX: PipelineContext = {
  mode: "daily",
  reportDate: "2026-06-02",
  timezone: "UTC",
  startedAt: new Date(),
  stageResults: new Map(),
};

const noop = async (_ms: number) => {};

function makeSuccessReviewFn() {
  return async () => ({
    object: {
      summary: "Test summary",
      technical_detail: "None",
      category: "technical" as const,
      direction_signal: "Signal",
      significance: "routine" as const,
      urgency: "normal" as const,
      sentiment: "neutral" as const,
      why_we_care: "Test",
    },
    usage: { inputTokens: 100, outputTokens: 50 },
  });
}

function makeApiError(statusCode: number) {
  return new APICallError({
    message: `HTTP error ${statusCode}`,
    statusCode,
    url: "https://api.anthropic.com",
    requestBodyValues: {},
    isRetryable: statusCode >= 500,
    cause: undefined,
  });
}

function makeSchemaError() {
  return new TypeValidationError({ message: "validation failed", value: {}, cause: undefined });
}

async function seedPendingItem(opts: { retryCount?: number } = {}) {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  db.exec(`INSERT INTO competitors (name, org) VALUES ('Test', 'test-org')`);
  db.exec(`
    INSERT INTO content_items
      (competitor_id, source, source_url, title, content, input_quality, analysis_status, retry_count)
    VALUES (1, 'blog', 'https://example.com/post', 'Title', 'Content here', 'full', 'pending', ${opts.retryCount ?? 0})
  `);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
  process.env.ANTHROPIC_API_KEY = "test-key";
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
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
describe("AnalyzeStage: basic success path", () => {
  test("marks item complete on success", async () => {
    await seedPendingItem();
    const stage = new AnalyzeStage(makeSuccessReviewFn(), noop);
    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const item = db.query<{ analysis_status: string }, []>(
      "SELECT analysis_status FROM content_items WHERE id=1"
    ).get()!;
    expect(item.analysis_status).toBe("complete");
  });

  test("returns success=true itemsProcessed=0 when no pending items", async () => {
    const stage = new AnalyzeStage(makeSuccessReviewFn(), noop);
    const result = await stage.execute(CTX);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("AnalyzeStage: retry_count logic", () => {
  test("increments retry_count and keeps status=pending on first failure (retry_count=0→1)", async () => {
    await seedPendingItem({ retryCount: 0 });
    const stage = new AnalyzeStage(async () => { throw new Error("generic error"); }, noop);
    await stage.execute(CTX);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const item = db.query<{ analysis_status: string; retry_count: number }, []>(
      "SELECT analysis_status, retry_count FROM content_items WHERE id=1"
    ).get()!;
    expect(item.retry_count).toBe(1);
    expect(item.analysis_status).toBe("pending");
  });

  test("marks failed (terminal) when retry_count reaches 3", async () => {
    await seedPendingItem({ retryCount: 2 });
    const stage = new AnalyzeStage(async () => { throw new Error("error"); }, noop);
    await stage.execute(CTX);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const item = db.query<{ analysis_status: string; retry_count: number }, []>(
      "SELECT analysis_status, retry_count FROM content_items WHERE id=1"
    ).get()!;
    expect(item.retry_count).toBe(3);
    expect(item.analysis_status).toBe("failed");
  });

  test("single item failure does not block other items in the batch", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    db.exec(`INSERT INTO competitors (name, org) VALUES ('CorpA', 'corp-a'), ('CorpB', 'corp-b')`);
    db.exec(`
      INSERT INTO content_items (competitor_id, source, source_url, title, content, input_quality, analysis_status, retry_count)
      VALUES
        (1, 'blog', 'https://corp-a.com/1', 'A', 'Content A', 'full', 'pending', 0),
        (2, 'blog', 'https://corp-b.com/1', 'B', 'Content B', 'full', 'pending', 0)
    `);

    let calls = 0;
    const stage = new AnalyzeStage(
      async () => {
        calls++;
        if (calls === 1) throw new Error("first item fails");
        return await makeSuccessReviewFn()();
      },
      noop
    );

    const result = await stage.execute(CTX);
    expect(result.itemsProcessed).toBe(1);
    expect(result.errors).toHaveLength(1);

    const items = db.query<{ analysis_status: string }, []>(
      "SELECT analysis_status FROM content_items ORDER BY id"
    ).all();
    expect(items[0]!.analysis_status).toBe("pending");
    expect(items[1]!.analysis_status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
describe("AnalyzeStage: 429 rate-limit → exponential backoff within run", () => {
  test("retries 429 up to 2 times then marks failed", async () => {
    await seedPendingItem();
    let calls = 0;
    const stage = new AnalyzeStage(
      async () => { calls++; throw makeApiError(429); },
      noop
    );
    const result = await stage.execute(CTX);

    expect(calls).toBe(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("429");

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const item = db.query<{ retry_count: number }, []>(
      "SELECT retry_count FROM content_items WHERE id=1"
    ).get()!;
    expect(item.retry_count).toBe(1);
  });

  test("succeeds after transient 429", async () => {
    await seedPendingItem();
    let calls = 0;
    const stage = new AnalyzeStage(
      async () => {
        calls++;
        if (calls < 2) throw makeApiError(429);
        return await makeSuccessReviewFn()();
      },
      noop
    );
    const result = await stage.execute(CTX);
    expect(calls).toBe(2);
    expect(result.itemsProcessed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("AnalyzeStage: 500 server error → exponential backoff up to 2×", () => {
  test("retries 500 up to 2 times", async () => {
    await seedPendingItem();
    let calls = 0;
    const stage = new AnalyzeStage(
      async () => { calls++; throw makeApiError(500); },
      noop
    );
    await stage.execute(CTX);
    expect(calls).toBe(3);
  });

  test("succeeds after transient 500", async () => {
    await seedPendingItem();
    let calls = 0;
    const stage = new AnalyzeStage(
      async () => {
        calls++;
        if (calls < 3) throw makeApiError(500);
        return await makeSuccessReviewFn()();
      },
      noop
    );
    const result = await stage.execute(CTX);
    expect(calls).toBe(3);
    expect(result.itemsProcessed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("AnalyzeStage: schema validation → retry 1×", () => {
  test("retries schema validation error exactly once", async () => {
    await seedPendingItem();
    let calls = 0;
    const stage = new AnalyzeStage(
      async () => { calls++; throw makeSchemaError(); },
      noop
    );
    await stage.execute(CTX);
    expect(calls).toBe(2);
  });

  test("succeeds on schema retry", async () => {
    await seedPendingItem();
    let calls = 0;
    const stage = new AnalyzeStage(
      async () => {
        calls++;
        if (calls === 1) throw makeSchemaError();
        return await makeSuccessReviewFn()();
      },
      noop
    );
    const result = await stage.execute(CTX);
    expect(calls).toBe(2);
    expect(result.itemsProcessed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("AnalyzeStage: timeout → mark failed, retry next run", () => {
  test("marks item with error containing 'timeout' when AbortSignal fires", async () => {
    await seedPendingItem();
    // Pass 1ms timeout so the AbortController fires almost immediately
    const stage = new AnalyzeStage(
      async (opts) => {
        // Hang until the abort signal fires
        await new Promise<void>((_resolve, reject) => {
          if (opts.abortSignal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          opts.abortSignal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        });
        return await makeSuccessReviewFn()();
      },
      noop,
      1  // 1ms timeout
    );

    const result = await stage.execute(CTX);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("timeout");

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const item = db.query<{ analysis_status: string; retry_count: number }, []>(
      "SELECT analysis_status, retry_count FROM content_items WHERE id=1"
    ).get()!;
    expect(item.retry_count).toBe(1);
    expect(item.analysis_status).toBe("pending");
  });
});
