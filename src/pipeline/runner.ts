export interface CompetitorStatus {
  competitorId: string;
  competitorName: string;
  success: boolean;
  itemsCollected: number;
  error?: string;
}

export interface StageResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
  durationMs: number;
  competitorStatuses?: CompetitorStatus[];
}

export interface PipelineContext {
  mode: "daily" | "weekly";
  reportDate: string;
  timezone: string;
  startedAt: Date;
  stageResults: Map<string, StageResult>;
}

export interface PipelineStage {
  name: string;
  execute(ctx: PipelineContext): Promise<StageResult>;
}

function todayDate(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

export async function runPipeline(
  stages: PipelineStage[],
  opts: { mode: "daily" | "weekly"; reportDate?: string; timezone?: string }
): Promise<PipelineContext> {
  const timezone = opts.timezone ?? "Asia/Shanghai";
  const ctx: PipelineContext = {
    mode: opts.mode,
    reportDate: opts.reportDate ?? todayDate(timezone),
    timezone,
    startedAt: new Date(),
    stageResults: new Map(),
  };

  for (const stage of stages) {
    const t0 = Date.now();
    try {
      const result = await stage.execute(ctx);
      result.durationMs = Date.now() - t0;
      ctx.stageResults.set(stage.name, result);
      console.log(
        `[pipeline] stage=${stage.name} success=${result.success} items=${result.itemsProcessed} duration=${result.durationMs}ms`
      );
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      const failed: StageResult = {
        success: false,
        itemsProcessed: 0,
        errors: [message],
        durationMs,
      };
      ctx.stageResults.set(stage.name, failed);
      console.error(`[pipeline] stage=${stage.name} FAILED: ${message} duration=${durationMs}ms`);
    }
  }

  return ctx;
}
