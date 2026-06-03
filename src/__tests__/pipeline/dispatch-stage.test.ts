import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { DispatchStage, sendCard } from "../../pipeline/stages/dispatch.js";
import type { PipelineContext } from "../../pipeline/runner.js";

const TEST_DB_PATH = "data/test-dispatch-stage.db";

const CTX: PipelineContext = {
  mode: "daily",
  reportDate: "2026-06-02",
  timezone: "UTC",
  startedAt: new Date(),
  stageResults: new Map(),
};

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
  process.env.LARK_WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/test";
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
  delete process.env.LARK_WEBHOOK_URL;
});

async function seedReport(opts: { sentAt?: string } = {}) {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();

  db.exec(`
    INSERT INTO reports (report_date, report_type, content, item_count, notable_count, is_partial, content_hash${opts.sentAt ? ", sent_at" : ""})
    VALUES ('2026-06-02', 'daily', '{}', 0, 0, 0, 'hash1'${opts.sentAt ? `, '${opts.sentAt}'` : ""})
  `);
  const report = db.query<{ id: number }, []>("SELECT id FROM reports WHERE content_hash = 'hash1'").get()!;
  return report.id;
}

async function seedDelivery(reportId: number, opts: {
  cardContent?: string;
  status?: string;
  cardIndex?: number;
} = {}) {
  const { getDb } = await import("../../storage/db.js");
  const db = getDb();
  const content = opts.cardContent ?? JSON.stringify({ msg_type: "interactive", card: {} });
  const status = opts.status ?? "pending";
  const cardIndex = opts.cardIndex ?? 0;

  db.exec(`
    INSERT INTO report_deliveries (report_id, card_index, card_content, delivery_status)
    VALUES (${reportId}, ${cardIndex}, '${content.replace(/'/g, "''")}', '${status}')
  `);
  const row = db.query<{ id: number }, []>(
    `SELECT id FROM report_deliveries WHERE report_id = ${reportId} AND card_index = ${cardIndex}`
  ).get()!;
  return row.id;
}

const successResponse = { code: 0, msg: "success", data: { message_id: "msg-001" } };

function makeSuccessSendCard() {
  return async (_url: string, _card: string) => structuredClone(successResponse);
}

function makeFailingSendCard(errorMsg = "webhook error") {
  return async (_url: string, _card: string): Promise<typeof successResponse> => {
    throw new Error(errorMsg);
  };
}

// ---------------------------------------------------------------------------
describe("DispatchStage: missing LARK_WEBHOOK_URL", () => {
  test("returns success:true itemsProcessed:0 when env var is missing", async () => {
    delete process.env.LARK_WEBHOOK_URL;
    const stage = new DispatchStage(makeSuccessSendCard());
    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("does not touch DB when env var is missing", async () => {
    delete process.env.LARK_WEBHOOK_URL;
    const reportId = await seedReport();
    await seedDelivery(reportId);

    const stage = new DispatchStage(makeSuccessSendCard());
    await stage.execute(CTX);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const d = db.query<{ delivery_status: string }, []>(
      `SELECT delivery_status FROM report_deliveries WHERE report_id = ${reportId}`
    ).get()!;
    expect(d.delivery_status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
describe("DispatchStage: no unsent reports", () => {
  test("returns success:true itemsProcessed:0 when no reports have sent_at IS NULL", async () => {
    await seedReport({ sentAt: "2026-06-02T08:00:00" });
    const stage = new DispatchStage(makeSuccessSendCard());
    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  test("returns success:true itemsProcessed:0 when no report rows exist", async () => {
    const stage = new DispatchStage(makeSuccessSendCard());
    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("DispatchStage: success path", () => {
  test("sets delivery_status=sent, message_id, sent_at on successful send", async () => {
    const reportId = await seedReport();
    const deliveryId = await seedDelivery(reportId);

    const stage = new DispatchStage(makeSuccessSendCard());
    const result = await stage.execute(CTX);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const d = db.query<{
      delivery_status: string;
      message_id: string | null;
      sent_at: string | null;
    }, []>(
      `SELECT delivery_status, message_id, sent_at FROM report_deliveries WHERE id = ${deliveryId}`
    ).get()!;

    expect(d.delivery_status).toBe("sent");
    expect(d.message_id).toBe("msg-001");
    expect(d.sent_at).not.toBeNull();
  });

  test("sets reports.sent_at after all deliveries succeed", async () => {
    const reportId = await seedReport();
    await seedDelivery(reportId, { cardIndex: 0 });
    await seedDelivery(reportId, { cardIndex: 1 });

    const stage = new DispatchStage(makeSuccessSendCard());
    await stage.execute(CTX);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const r = db.query<{ sent_at: string | null }, []>(
      `SELECT sent_at FROM reports WHERE id = ${reportId}`
    ).get()!;
    expect(r.sent_at).not.toBeNull();
  });

  test("passes webhook URL from env to sendCard", async () => {
    process.env.LARK_WEBHOOK_URL = "https://open.feishu.cn/hook/specific-url";
    const reportId = await seedReport();
    await seedDelivery(reportId);

    let capturedUrl = "";
    const stage = new DispatchStage(async (url, _card) => {
      capturedUrl = url;
      return structuredClone(successResponse);
    });
    await stage.execute(CTX);

    expect(capturedUrl).toBe("https://open.feishu.cn/hook/specific-url");
  });

  test("passes card_content to sendCard", async () => {
    const reportId = await seedReport();
    const cardJson = JSON.stringify({ config: {}, header: { title: { tag: "plain_text", content: "test" } }, elements: [] });
    await seedDelivery(reportId, { cardContent: cardJson });

    let capturedCard = "";
    const stage = new DispatchStage(async (_url, card) => {
      capturedCard = card;
      return structuredClone(successResponse);
    });
    await stage.execute(CTX);

    expect(capturedCard).toBe(cardJson);
  });
});

// ---------------------------------------------------------------------------
describe("DispatchStage: failure path", () => {
  test("marks delivery_status=failed with error on sendCard throw", async () => {
    const reportId = await seedReport();
    const deliveryId = await seedDelivery(reportId);

    const stage = new DispatchStage(makeFailingSendCard("network timeout"));
    const result = await stage.execute(CTX);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const d = db.query<{ delivery_status: string; error: string | null }, []>(
      `SELECT delivery_status, error FROM report_deliveries WHERE id = ${deliveryId}`
    ).get()!;

    expect(d.delivery_status).toBe("failed");
    expect(d.error).toContain("network timeout");
  });

  test("does not set reports.sent_at when a delivery fails", async () => {
    const reportId = await seedReport();
    await seedDelivery(reportId);

    const stage = new DispatchStage(makeFailingSendCard());
    await stage.execute(CTX);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const r = db.query<{ sent_at: string | null }, []>(
      `SELECT sent_at FROM reports WHERE id = ${reportId}`
    ).get()!;
    expect(r.sent_at).toBeNull();
  });

  test("continues to next delivery after one fails", async () => {
    const reportId = await seedReport();
    await seedDelivery(reportId, { cardIndex: 0 });
    await seedDelivery(reportId, { cardIndex: 1 });

    let calls = 0;
    const stage = new DispatchStage(async (_url, _card) => {
      calls++;
      if (calls === 1) throw new Error("first delivery fails");
      return structuredClone(successResponse);
    });

    const result = await stage.execute(CTX);

    expect(calls).toBe(2);
    expect(result.itemsProcessed).toBe(1);

    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    const deliveries = db.query<{ delivery_status: string; card_index: number }, []>(
      `SELECT delivery_status, card_index FROM report_deliveries WHERE report_id = ${reportId} ORDER BY card_index`
    ).all();
    expect(deliveries[0]!.delivery_status).toBe("failed");
    expect(deliveries[1]!.delivery_status).toBe("sent");
  });

  test("does not re-send already-sent deliveries", async () => {
    const reportId = await seedReport();
    await seedDelivery(reportId, { status: "sent", cardIndex: 0 });
    await seedDelivery(reportId, { status: "pending", cardIndex: 1 });

    let calls = 0;
    const stage = new DispatchStage(async (_url, _card) => {
      calls++;
      return structuredClone(successResponse);
    });

    await stage.execute(CTX);

    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("DispatchStage: DB correctness", () => {
  test("itemsProcessed counts only successful deliveries", async () => {
    const reportId = await seedReport();
    await seedDelivery(reportId, { cardIndex: 0 });
    await seedDelivery(reportId, { cardIndex: 1 });
    await seedDelivery(reportId, { cardIndex: 2 });

    let calls = 0;
    const stage = new DispatchStage(async (_url, _card) => {
      calls++;
      if (calls === 2) throw new Error("middle failure");
      return structuredClone(successResponse);
    });

    const result = await stage.execute(CTX);

    expect(result.itemsProcessed).toBe(2);
    expect(result.errors.length).toBe(1);
  });

  test("multiple reports: processes all unsent reports", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();

    db.exec(`
      INSERT INTO reports (report_date, report_type, content, item_count, notable_count, is_partial, content_hash)
      VALUES ('2026-06-01', 'daily', '{}', 0, 0, 0, 'hash-a'),
             ('2026-06-02', 'daily', '{}', 0, 0, 0, 'hash-b')
    `);
    const r1 = db.query<{ id: number }, []>("SELECT id FROM reports WHERE content_hash = 'hash-a'").get()!;
    const r2 = db.query<{ id: number }, []>("SELECT id FROM reports WHERE content_hash = 'hash-b'").get()!;
    await seedDelivery(r1.id);
    await seedDelivery(r2.id);

    let calls = 0;
    const stage = new DispatchStage(async (_url, _card) => {
      calls++;
      return structuredClone(successResponse);
    });

    const result = await stage.execute(CTX);

    expect(calls).toBe(2);
    expect(result.itemsProcessed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("sendCard: retry behavior", () => {
  const noop = async (_ms: number) => {};

  test("returns response on first success", async () => {
    const mockFetch = async (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ code: 0, msg: "ok", data: { message_id: "m1" } }), { status: 200 });

    const result = await sendCard("https://hook.example.com", "{}", noop, mockFetch);
    expect(result.code).toBe(0);
    expect(result.data?.message_id).toBe("m1");
  });

  test("retries on HTTP non-200 and eventually succeeds", async () => {
    let calls = 0;
    const mockFetch = async (_url: string, _opts: RequestInit) => {
      calls++;
      if (calls < 3) return new Response("error", { status: 500 });
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { message_id: "m2" } }), { status: 200 });
    };

    const result = await sendCard("https://hook.example.com", "{}", noop, mockFetch);
    expect(result.code).toBe(0);
    expect(calls).toBe(3);
  });

  test("retries on code !== 0 and eventually succeeds", async () => {
    let calls = 0;
    const mockFetch = async (_url: string, _opts: RequestInit) => {
      calls++;
      if (calls < 2) return new Response(JSON.stringify({ code: 9499, msg: "rate limit", data: {} }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { message_id: "m3" } }), { status: 200 });
    };

    const result = await sendCard("https://hook.example.com", "{}", noop, mockFetch);
    expect(result.code).toBe(0);
    expect(calls).toBe(2);
  });

  test("throws after 4 total attempts (3 retries) on persistent non-200", async () => {
    let calls = 0;
    const mockFetch = async (_url: string, _opts: RequestInit) => {
      calls++;
      return new Response("server error", { status: 503 });
    };

    await expect(sendCard("https://hook.example.com", "{}", noop, mockFetch)).rejects.toThrow();
    expect(calls).toBe(4);
  });

  test("throws after 4 total attempts on persistent code !== 0", async () => {
    let calls = 0;
    const mockFetch = async (_url: string, _opts: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ code: 9499, msg: "rate limit" }), { status: 200 });
    };

    await expect(sendCard("https://hook.example.com", "{}", noop, mockFetch)).rejects.toThrow(/rate limit/);
    expect(calls).toBe(4);
  });

  test("uses exponential backoff delays 2000, 4000, 8000ms", async () => {
    const delays: number[] = [];
    const trackSleep = async (ms: number) => { delays.push(ms); };

    let calls = 0;
    const mockFetch = async (_url: string, _opts: RequestInit) => {
      calls++;
      if (calls < 4) return new Response("error", { status: 500 });
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: {} }), { status: 200 });
    };

    await sendCard("https://hook.example.com", "{}", trackSleep, mockFetch);
    expect(delays).toEqual([2000, 4000, 8000]);
  });
});
