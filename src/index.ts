import { createScheduler } from "./scheduler/cron.js";
import { collectStage } from "./pipeline/stages/collect.js";
import { analyzeStage } from "./pipeline/stages/analyze.js";
import { dispatchStage } from "./pipeline/stages/dispatch.js";
import { reportStage } from "./pipeline/stages/report.js";
import { getDb } from "./storage/db.js";

// Initialize the database on startup so data/monitor.db is created immediately.
getDb();

const stages = [collectStage, analyzeStage, dispatchStage, reportStage];
const scheduler = createScheduler(stages);

scheduler.start();
console.log("[index] scheduler started — daily 08:00, weekly Mon 09:00 (Asia/Shanghai)");

export async function runNow(mode: "daily" | "weekly") {
  return scheduler.runNow(mode);
}
