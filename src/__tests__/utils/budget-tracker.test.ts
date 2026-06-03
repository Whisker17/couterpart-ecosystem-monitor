import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { DDL } from "../../storage/schema.js";
import { getBudgetStatus } from "../../utils/budget-tracker.js";
import type { Settings } from "../../config/settings.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(DDL);
  return db;
}

const settings: Settings = {
  llm: { model: "test", baseUrlEnvVar: "LLM_BASE_URL", apiKeyEnvVar: "LLM_API_KEY", maxTokensPerCall: 4096 },
  lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
  schedule: { dailyCron: "0 8 * * *", weeklyCron: "0 9 * * 0" },
  budget: { monthlyCap: 40, warningThreshold: 0.8, cutoffThreshold: 1.0 },
  collector: { contentMinLength: 500 },
};

function seedSpend(db: Database, costUSD: number): void {
  db.exec("INSERT INTO competitors (name, org) VALUES ('TestCo', 'testco')");
  db.exec("INSERT INTO content_items (competitor_id, source, source_url, analysis_status) VALUES (1, 'blog', 'https://example.com', 'complete')");
  db.exec(
    `INSERT INTO analyses (content_item_id, summary, significance, estimated_cost_usd, analyzed_at) VALUES (1, 'summary', 'routine', ${costUSD}, datetime('now'))`
  );
}

describe("getBudgetStatus", () => {
  test("0% spend → action=normal, usagePercent=0", () => {
    const db = makeDb();
    const status = getBudgetStatus(db, settings);
    expect(status.action).toBe("normal");
    expect(status.usagePercent).toBe(0);
    expect(status.estimatedCostUSD).toBe(0);
    expect(status.budgetCapUSD).toBe(40);
  });

  test("79% spend → action=normal", () => {
    const db = makeDb();
    seedSpend(db, 40 * 0.79);
    const status = getBudgetStatus(db, settings);
    expect(status.action).toBe("normal");
    expect(status.usagePercent).toBeCloseTo(0.79, 5);
  });

  test("80% spend → action=warning", () => {
    const db = makeDb();
    seedSpend(db, 40 * 0.80);
    const status = getBudgetStatus(db, settings);
    expect(status.action).toBe("warning");
    expect(status.usagePercent).toBeCloseTo(0.80, 5);
  });

  test("99% spend → action=warning", () => {
    const db = makeDb();
    seedSpend(db, 40 * 0.99);
    const status = getBudgetStatus(db, settings);
    expect(status.action).toBe("warning");
    expect(status.usagePercent).toBeCloseTo(0.99, 5);
  });

  test("100% spend → action=pause", () => {
    const db = makeDb();
    seedSpend(db, 40 * 1.0);
    const status = getBudgetStatus(db, settings);
    expect(status.action).toBe("pause");
    expect(status.usagePercent).toBeCloseTo(1.0, 5);
  });

  test("110% spend → action=pause", () => {
    const db = makeDb();
    seedSpend(db, 40 * 1.10);
    const status = getBudgetStatus(db, settings);
    expect(status.action).toBe("pause");
    expect(status.usagePercent).toBeCloseTo(1.10, 5);
  });
});
