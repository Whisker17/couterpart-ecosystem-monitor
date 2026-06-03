// Manual pipeline runner: --mode daily/weekly, --no-dispatch
import { parseArgs } from "util";
import { runPipeline } from "./pipeline/runner.js";
import { collectStage } from "./pipeline/stages/collect.js";
import { analyzeStage } from "./pipeline/stages/analyze.js";
import { reportStage } from "./pipeline/stages/report.js";
import { dispatchStage } from "./pipeline/stages/dispatch.js";
import { closeDb } from "./storage/db.js";
import { isValidDate } from "./utils/validate-date.js";
import { getSettings } from "./config/settings.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "daily" },
    "no-dispatch": { type: "boolean", default: false },
    date: { type: "string" },
  },
});

if (values.date !== undefined && !isValidDate(values.date)) {
  console.error("Error: --date must be a valid calendar date in YYYY-MM-DD format");
  process.exit(1);
}

const mode = values.mode;
if (mode !== "daily" && mode !== "weekly") {
  console.error(`[e2e-run] Invalid --mode "${mode}". Must be "daily" or "weekly".`);
  process.exit(1);
}

const noDispatch = values["no-dispatch"] ?? false;
const stages = [collectStage, analyzeStage, reportStage];
if (!noDispatch) {
  stages.push(dispatchStage);
}

console.log(`[e2e-run] starting  mode=${mode}  no-dispatch=${noDispatch}  date=${values.date ?? "(today)"}`);

try {
  const ctx = await runPipeline(stages, {
    mode,
    reportDate: values.date,
    timezone: getSettings().schedule.timezone,
  });

  const stageOrder = ["collect", "analyze", "report", "dispatch"].filter((n) =>
    ctx.stageResults.has(n)
  );

  console.log("\n=== Pipeline Summary ===");
  for (const name of stageOrder) {
    const r = ctx.stageResults.get(name)!;
    const status = r.success ? "OK  " : "FAIL";
    const errors = r.errors.length > 0 ? `  errors=[${r.errors.join("; ")}]` : "";
    console.log(`  ${name.padEnd(10)} ${status}  items=${r.itemsProcessed}  duration=${r.durationMs}ms${errors}`);
  }
  console.log("========================\n");
} finally {
  closeDb();
}
