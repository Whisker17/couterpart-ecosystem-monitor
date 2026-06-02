import { Cron } from "croner";
import { runPipeline, type PipelineStage, type PipelineContext } from "../pipeline/runner.js";

export interface Scheduler {
  start(): Scheduler;
  stop(): void;
  runNow(mode: "daily" | "weekly"): Promise<PipelineContext>;
}

export function createScheduler(
  stages: PipelineStage[],
  opts: { timezone?: string } = {}
): Scheduler {
  const timezone = opts.timezone ?? "Asia/Shanghai";
  const jobs: Cron[] = [];

  const self: Scheduler = {
    start(): Scheduler {
      // Daily at 08:00 in the configured timezone
      jobs.push(
        new Cron(
          "0 8 * * *",
          { timezone, name: "daily-pipeline" },
          async () => {
            console.log("[scheduler] daily pipeline triggered");
            await runPipeline(stages, { mode: "daily", timezone });
          }
        )
      );

      // Weekly on Monday at 09:00 in the configured timezone
      jobs.push(
        new Cron(
          "0 9 * * 1",
          { timezone, name: "weekly-pipeline" },
          async () => {
            console.log("[scheduler] weekly pipeline triggered");
            await runPipeline(stages, { mode: "weekly", timezone });
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
