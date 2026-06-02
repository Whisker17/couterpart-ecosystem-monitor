import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";

class AnalyzeStage implements PipelineStage {
  readonly name = "analyze";

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    return {
      success: true,
      itemsProcessed: 0,
      errors: [],
      durationMs: 0,
    };
  }
}

export const analyzeStage: PipelineStage = new AnalyzeStage();
