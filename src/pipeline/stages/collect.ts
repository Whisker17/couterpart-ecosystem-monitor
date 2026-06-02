import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";

class CollectStage implements PipelineStage {
  readonly name = "collect";

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    return {
      success: true,
      itemsProcessed: 0,
      errors: [],
      durationMs: 0,
      competitorStatuses: [],
    };
  }
}

export const collectStage: PipelineStage = new CollectStage();
