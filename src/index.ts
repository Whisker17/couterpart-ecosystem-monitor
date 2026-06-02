import { validateEnv } from "./config/index.js";
import { createScheduler } from "./scheduler/cron.js";
import { collectStage } from "./pipeline/stages/collect.js";
import { analyzeStage } from "./pipeline/stages/analyze.js";
import { dispatchStage } from "./pipeline/stages/dispatch.js";
import { reportStage } from "./pipeline/stages/report.js";
import { getDb } from "./storage/db.js";
import type { PipelineStage } from "./pipeline/runner.js";
import type { Scheduler } from "./scheduler/cron.js";

// Initialize the database on startup so data/monitor.db is created immediately.
getDb();

export function startup(
  createSchedulerFn: (stages: PipelineStage[]) => Scheduler = createScheduler
): void {
  validateEnv();

  const stages = [collectStage, analyzeStage, dispatchStage, reportStage];
  const scheduler = createSchedulerFn(stages);
  scheduler.start();
  console.log("[index] scheduler started — daily 08:00, weekly Mon 09:00 (Asia/Shanghai)");
}

export async function runNow(mode: "daily" | "weekly") {
  const stages = [collectStage, analyzeStage, dispatchStage, reportStage];
  const scheduler = createScheduler(stages);
  return scheduler.runNow(mode);
}

if (import.meta.main) {
  startup();
}
