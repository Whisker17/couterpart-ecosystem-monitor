import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";

class DispatchStage implements PipelineStage {
  readonly name = "dispatch";

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    return {
      success: true,
      itemsProcessed: 0,
      errors: [],
      durationMs: 0,
    };
  }
}

export const dispatchStage: PipelineStage = new DispatchStage();
