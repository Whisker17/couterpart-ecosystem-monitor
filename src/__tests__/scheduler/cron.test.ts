import { test, expect, describe } from "bun:test";
import { createScheduler } from "../../scheduler/cron.js";
import type { PipelineContext } from "../../pipeline/runner.js";

describe("createScheduler", () => {
  test("runNow resolves to a PipelineContext", async () => {
    const scheduler = createScheduler([], { timezone: "UTC" });
    const ctx = await scheduler.runNow("daily");
    expect(ctx.mode).toBe("daily");
    expect(ctx.stageResults).toBeDefined();
  });

  test("runNow with weekly mode returns weekly context", async () => {
    const scheduler = createScheduler([], { timezone: "UTC" });
    const ctx = await scheduler.runNow("weekly");
    expect(ctx.mode).toBe("weekly");
  });

  test("runNow passes through stages", async () => {
    const executed: string[] = [];
    const stages = [
      {
        name: "test-stage",
        async execute(_ctx: PipelineContext) {
          executed.push("test-stage");
          return { success: true, itemsProcessed: 1, errors: [], durationMs: 0 };
        },
      },
    ];
    const scheduler = createScheduler(stages, { timezone: "UTC" });
    await scheduler.runNow("daily");
    expect(executed).toContain("test-stage");
  });

  test("stop() does not throw", () => {
    const scheduler = createScheduler([], { timezone: "UTC" });
    expect(() => scheduler.stop()).not.toThrow();
  });

  test("start() returns scheduler (chainable)", () => {
    const scheduler = createScheduler([], { timezone: "UTC" });
    const result = scheduler.start();
    result.stop();
    expect(result).toBe(scheduler);
  });
});
