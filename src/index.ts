import { validateEnv } from "./config/index.js";
import { createScheduler } from "./scheduler/cron.js";
import { collectStage } from "./pipeline/stages/collect.js";
import { analyzeStage } from "./pipeline/stages/analyze.js";
import { dispatchStage } from "./pipeline/stages/dispatch.js";
import { reportStage } from "./pipeline/stages/report.js";
import { getDb } from "./storage/db.js";
import type { PipelineStage } from "./pipeline/runner.js";
import type { Scheduler } from "./scheduler/cron.js";

export function startup(
  createSchedulerFn: (stages: PipelineStage[]) => Scheduler = createScheduler
): void {
  // Initialize the database before env validation so data/monitor.db is always
  // created on first startup, even if env vars are missing.
  getDb();
  validateEnv();

  const stages = [collectStage, analyzeStage, reportStage, dispatchStage];
  const scheduler = createSchedulerFn(stages);
  scheduler.start();
  console.log("[index] scheduler started");
}

export async function runNow(mode: "daily" | "weekly") {
  const stages = [collectStage, analyzeStage, reportStage, dispatchStage];
  const scheduler = createScheduler(stages);
  return scheduler.runNow(mode);
}

if (import.meta.main) {
  startup();
}
