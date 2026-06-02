import { test, expect, describe } from "bun:test";
import {
  runPipeline,
  type PipelineStage,
  type PipelineContext,
  type StageResult,
} from "../../pipeline/runner.js";

function makeStage(
  name: string,
  result: StageResult,
  shouldThrow?: boolean
): PipelineStage {
  return {
    name,
    async execute(_ctx: PipelineContext): Promise<StageResult> {
      if (shouldThrow) throw new Error(`${name} failed`);
      return result;
    },
  };
}

const okResult: StageResult = {
  success: true,
  itemsProcessed: 5,
  errors: [],
  durationMs: 10,
};

describe("runPipeline", () => {
  test("returns a PipelineContext with mode and reportDate", async () => {
    const ctx = await runPipeline([], { mode: "daily", reportDate: "2026-06-02" });
    expect(ctx.mode).toBe("daily");
    expect(ctx.reportDate).toBe("2026-06-02");
  });

  test("defaults reportDate to today (YYYY-MM-DD)", async () => {
    const ctx = await runPipeline([], { mode: "daily" });
    expect(ctx.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("defaults timezone to Asia/Shanghai", async () => {
    const ctx = await runPipeline([], { mode: "weekly" });
    expect(ctx.timezone).toBe("Asia/Shanghai");
  });

  test("respects custom timezone", async () => {
    const ctx = await runPipeline([], { mode: "daily", timezone: "UTC" });
    expect(ctx.timezone).toBe("UTC");
  });

  test("startedAt is a Date", async () => {
    const ctx = await runPipeline([], { mode: "daily" });
    expect(ctx.startedAt).toBeInstanceOf(Date);
  });

  test("stageResults is empty map when no stages", async () => {
    const ctx = await runPipeline([], { mode: "daily" });
    expect(ctx.stageResults.size).toBe(0);
  });

  test("executes stages in order and records results", async () => {
    const order: string[] = [];
    const stageA: PipelineStage = {
      name: "a",
      async execute() {
        order.push("a");
        return { ...okResult, itemsProcessed: 1 };
      },
    };
    const stageB: PipelineStage = {
      name: "b",
      async execute() {
        order.push("b");
        return { ...okResult, itemsProcessed: 2 };
      },
    };
    const ctx = await runPipeline([stageA, stageB], { mode: "daily" });
    expect(order).toEqual(["a", "b"]);
    expect(ctx.stageResults.get("a")?.itemsProcessed).toBe(1);
    expect(ctx.stageResults.get("b")?.itemsProcessed).toBe(2);
  });

  test("continues pipeline when a stage throws", async () => {
    const failingStage = makeStage("fail", okResult, true);
    const nextStage = makeStage("next", { ...okResult, itemsProcessed: 3 });
    const ctx = await runPipeline([failingStage, nextStage], { mode: "daily" });
    expect(ctx.stageResults.has("fail")).toBe(true);
    expect(ctx.stageResults.get("fail")?.success).toBe(false);
    expect(ctx.stageResults.get("fail")?.errors.length).toBeGreaterThan(0);
    expect(ctx.stageResults.has("next")).toBe(true);
    expect(ctx.stageResults.get("next")?.success).toBe(true);
  });

  test("failed stage result has error message in errors array", async () => {
    const failingStage = makeStage("crash", okResult, true);
    const ctx = await runPipeline([failingStage], { mode: "daily" });
    const result = ctx.stageResults.get("crash")!;
    expect(result.success).toBe(false);
    expect(result.errors).toContain("crash failed");
  });

  test("downstream stage can access upstream stageResults via ctx", async () => {
    let capturedUpstreamResult: StageResult | undefined;
    const upstream: PipelineStage = {
      name: "collect",
      async execute() {
        return {
          success: true,
          itemsProcessed: 10,
          errors: [],
          durationMs: 5,
          competitorStatuses: [
            { competitorId: "c1", competitorName: "Comp1", success: true, itemsCollected: 10 },
          ],
        };
      },
    };
    const downstream: PipelineStage = {
      name: "report",
      async execute(ctx: PipelineContext) {
        capturedUpstreamResult = ctx.stageResults.get("collect");
        return okResult;
      },
    };
    await runPipeline([upstream, downstream], { mode: "daily" });
    expect(capturedUpstreamResult).toBeDefined();
    expect(capturedUpstreamResult?.competitorStatuses?.[0]?.competitorId).toBe("c1");
  });

  test("durationMs is recorded for each stage", async () => {
    const stage = makeStage("timed", okResult);
    const ctx = await runPipeline([stage], { mode: "daily" });
    expect(typeof ctx.stageResults.get("timed")?.durationMs).toBe("number");
    expect(ctx.stageResults.get("timed")!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("failed stage durationMs is still recorded", async () => {
    const failing = makeStage("boom", okResult, true);
    const ctx = await runPipeline([failing], { mode: "daily" });
    expect(typeof ctx.stageResults.get("boom")?.durationMs).toBe("number");
  });
});
