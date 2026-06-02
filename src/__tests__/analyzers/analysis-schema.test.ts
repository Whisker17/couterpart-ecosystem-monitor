import { test, expect, describe } from "bun:test";
import { ContentAnalysisSchema } from "../../schema/analysis.js";

const VALID_ANALYSIS = {
  summary: "竞品发布了新的AI功能，集成到核心产品中。",
  technical_detail: "使用了Transformer架构，支持多模态输入。",
  category: "product_launch" as const,
  direction_signal: "正在将AI能力深度集成到主产品，加速AI化进程。",
  significance: "notable" as const,
  urgency: "normal" as const,
  sentiment: "positive" as const,
  why_we_care: "竞品AI集成速度加快，可能影响我们的产品竞争力。",
};

describe("ContentAnalysisSchema", () => {
  test("validates a complete valid analysis object", () => {
    const result = ContentAnalysisSchema.safeParse(VALID_ANALYSIS);
    expect(result.success).toBe(true);
  });

  test("all 8 fields have .describe() annotations", () => {
    const shape = ContentAnalysisSchema.shape;
    const fields = [
      "summary",
      "technical_detail",
      "category",
      "direction_signal",
      "significance",
      "urgency",
      "sentiment",
      "why_we_care",
    ] as const;

    for (const field of fields) {
      expect(shape[field].description).toBeTruthy();
      expect(typeof shape[field].description).toBe("string");
    }
  });

  test("rejects missing required fields", () => {
    const { summary: _s, ...withoutSummary } = VALID_ANALYSIS;
    const result = ContentAnalysisSchema.safeParse(withoutSummary);
    expect(result.success).toBe(false);
  });

  test("rejects invalid category enum value", () => {
    const result = ContentAnalysisSchema.safeParse({
      ...VALID_ANALYSIS,
      category: "invalid_category",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid significance enum value", () => {
    const result = ContentAnalysisSchema.safeParse({
      ...VALID_ANALYSIS,
      significance: "critical",
    });
    expect(result.success).toBe(false);
  });

  test("accepts all valid category enum values", () => {
    const categories = [
      "product_launch",
      "strategy_shift",
      "hiring",
      "partnership",
      "technical",
      "marketing",
      "other",
    ] as const;
    for (const category of categories) {
      const result = ContentAnalysisSchema.safeParse({ ...VALID_ANALYSIS, category });
      expect(result.success).toBe(true);
    }
  });

  test("accepts all valid significance enum values", () => {
    for (const sig of ["routine", "notable", "directional_shift"] as const) {
      const result = ContentAnalysisSchema.safeParse({ ...VALID_ANALYSIS, significance: sig });
      expect(result.success).toBe(true);
    }
  });

  test("accepts all valid urgency enum values", () => {
    for (const urgency of ["normal", "high"] as const) {
      const result = ContentAnalysisSchema.safeParse({ ...VALID_ANALYSIS, urgency });
      expect(result.success).toBe(true);
    }
  });

  test("accepts all valid sentiment enum values", () => {
    for (const sentiment of ["positive", "neutral", "negative", "aggressive"] as const) {
      const result = ContentAnalysisSchema.safeParse({ ...VALID_ANALYSIS, sentiment });
      expect(result.success).toBe(true);
    }
  });
});
