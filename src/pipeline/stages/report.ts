import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";

class ReportStage implements PipelineStage {
  readonly name = "report";

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    return {
      success: true,
      itemsProcessed: 0,
      errors: [],
      durationMs: 0,
    };
  }
}

export const reportStage: PipelineStage = new ReportStage();
