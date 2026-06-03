import { Cron } from "croner";
import { runPipeline, type PipelineStage, type PipelineContext } from "../pipeline/runner.js";
import { getSettings } from "../config/settings.js";
import { getDb } from "../storage/db.js";
import { cleanupOldContent, archiveReports, vacuumDb } from "../pipeline/maintenance.js";

export interface Scheduler {
  start(): Scheduler;
  stop(): void;
  runNow(mode: "daily" | "weekly"): Promise<PipelineContext>;
  readonly cronExpressions: { daily: string; weekly: string };
}

function validateTimezone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(
      `Invalid IANA timezone "${tz}" in settings.schedule.timezone. ` +
      `Use a valid IANA timezone identifier (e.g. "Asia/Shanghai", "UTC").`
    );
  }
}

export function createScheduler(
  stages: PipelineStage[],
  opts: { timezone?: string; dailyCron?: string; weeklyCron?: string } = {}
): Scheduler {
  const settings = getSettings();
  const timezone = opts.timezone ?? settings.schedule.timezone;
  validateTimezone(timezone);
  const dailyCron = opts.dailyCron ?? settings.schedule.dailyCron;
  const weeklyCron = opts.weeklyCron ?? settings.schedule.weeklyCron;
  const jobs: Cron[] = [];

  const self: Scheduler = {
    get cronExpressions() {
      return { daily: dailyCron, weekly: weeklyCron };
    },

    start(): Scheduler {
      jobs.push(
        new Cron(
          dailyCron,
          { timezone, name: "daily-pipeline" },
          async () => {
            console.log("[scheduler] daily pipeline triggered");
            await runPipeline(stages, { mode: "daily", timezone });
            cleanupOldContent(getDb());
          }
        )
      );

      jobs.push(
        new Cron(
          weeklyCron,
          { timezone, name: "weekly-pipeline" },
          async () => {
            console.log("[scheduler] weekly pipeline triggered");
            await runPipeline(stages, { mode: "weekly", timezone });
            cleanupOldContent(getDb());
          }
        )
      );

      jobs.push(
        new Cron(
          "0 3 1 * *",
          { timezone, name: "monthly-maintenance" },
          async () => {
            console.log("[scheduler] monthly maintenance triggered");
            const db = getDb();
            await archiveReports(db);
            vacuumDb(db);
          }
        )
      );

      return self;
    },

    stop(): void {
      for (const job of jobs) {
        job.stop();
      }
      jobs.length = 0;
    },

    async runNow(mode: "daily" | "weekly"): Promise<PipelineContext> {
      console.log(`[scheduler] runNow mode=${mode}`);
      return runPipeline(stages, { mode, timezone });
    },
  };

  return self;
}
