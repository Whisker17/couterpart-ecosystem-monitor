/**
 * A/B prompt comparison tests (v1 vs v2).
 *
 * These tests verify that the v2 prompt correctly encodes the calibration
 * target and sharper significance rubric. They use mock LLM calls that
 * capture and inspect the rendered system+user prompts, then assert on
 * the expected significance output for three representative real-world cases:
 *
 *   Case A: clear directional_shift — competitor announces full open-source pivot
 *   Case B: routine tech blog — developer tutorial with no competitive impact
 *   Case C: notable product launch — new feature directly competing with our product
 *
 * The v2 rubric explicitly targets ~70/25/5 distribution and adds concrete
 * per-tier criteria, reducing over-classification into "notable".
 */
import { test, expect, describe } from "bun:test";
import { reviewContent } from "../../analyzers/llm-reviewer.js";
import type { ReviewInput, GenerateObjectFn } from "../../analyzers/llm-reviewer.js";
import type { ContentAnalysis } from "../../schema/analysis.js";
import { ContentAnalysisSchema } from "../../schema/analysis.js";

// Captured prompt slots from each mock call
interface CapturedCall {
  system: string;
  prompt: string;
}

function makeCapturingMock(
  responseOverride: Partial<ContentAnalysis> = {}
): { mock: GenerateObjectFn; captured: CapturedCall[] } {
  const captured: CapturedCall[] = [];
  const defaultAnalysis: ContentAnalysis = {
    summary: "Test summary.",
    technical_detail: "无明显技术细节",
    category: "other",
    direction_signal: "无明显战略信号",
    significance: "routine",
    urgency: "normal",
    sentiment: "neutral",
    why_we_care: "暂无直接影响。",
    ...responseOverride,
  };
  const mock: GenerateObjectFn = async (opts) => {
    captured.push({ system: opts.system, prompt: opts.prompt });
    return { object: defaultAnalysis, usage: { inputTokens: 100, outputTokens: 50 } };
  };
  return { mock, captured };
}

// Representative competitor input for Case A: open-source pivot announcement
const CASE_A_DIRECTIONAL_SHIFT: ReviewInput = {
  contentItemId: 1,
  competitorName: "Acme Analytics",
  competitorOrg: "acme-analytics",
  competitorTags: ["data", "analytics", "SaaS"],
  title: "We Are Going Fully Open Source — Our Entire Platform, Starting Now",
  content: `Today we are announcing that Acme Analytics is transitioning our entire product suite
to open source under the Apache 2.0 license. This is not a partial open-core model —
every line of our platform code will be public. We are fundamentally changing how we
operate as a company. Our CEO stated: "This is a once-in-a-decade strategic bet.
We believe open source is the only sustainable model for infrastructure companies."
Enterprise support contracts and managed cloud hosting will become our primary revenue.
We will shut down our current SaaS subscription tier in 90 days. All existing customers
will be migrated to the open-source edition with an enterprise support contract option.`,
  sourceUrl: "https://acme-analytics.com/blog/going-open-source",
  inputQuality: "full",
};

// Representative competitor input for Case B: routine developer tutorial
const CASE_B_ROUTINE: ReviewInput = {
  contentItemId: 2,
  competitorName: "DataFlow Inc",
  competitorOrg: "dataflow-inc",
  competitorTags: ["data", "ETL", "pipeline"],
  title: "5 Tips for Optimizing Your Data Pipeline Performance",
  content: `When working with large-scale data pipelines, performance optimization is key.
Here are five practical tips our engineering team has learned over the years:
1. Use batch processing instead of row-by-row operations. This can reduce latency by 10x.
2. Index your lookup tables properly. Missing indexes are the most common cause of slow queries.
3. Parallelize independent stages when possible. Our pipeline executor supports concurrent stage execution.
4. Profile before optimizing. Use our built-in profiler to identify actual bottlenecks.
5. Cache expensive computations. Memoization at the stage level saves significant compute.
We hope these tips help you build faster pipelines. Check out our documentation for more details.`,
  sourceUrl: "https://dataflow.com/blog/pipeline-optimization-tips",
  inputQuality: "full",
};

// Representative competitor input for Case C: direct product feature launch
const CASE_C_NOTABLE: ReviewInput = {
  contentItemId: 3,
  competitorName: "StreamBase",
  competitorOrg: "streambase",
  competitorTags: ["streaming", "real-time", "analytics"],
  title: "Introducing StreamBase Connect: Native Integration with 200+ Data Sources",
  content: `Today we are officially launching StreamBase Connect, a new product that provides
native, no-code integrations with over 200 data sources including Salesforce, HubSpot,
Snowflake, BigQuery, and all major cloud storage providers. StreamBase Connect is now
generally available for all Enterprise customers and will reach all tiers by Q3.
Pricing starts at $299/month for up to 10 connectors.
This launch makes StreamBase a complete data platform, eliminating the need for
third-party ETL tools. Our VP of Product: "With Connect, we close the last major gap
in our platform. We now compete directly in the integration market."`,
  sourceUrl: "https://streambase.io/blog/introducing-connect",
  inputQuality: "full",
};

describe("Prompt v2 — A/B comparison tests", () => {
  describe("Case A: directional_shift — open-source pivot announcement", () => {
    test("v2 system prompt includes calibration target (~70/25/5)", async () => {
      const { mock, captured } = makeCapturingMock({ significance: "directional_shift" });
      await reviewContent(CASE_A_DIRECTIONAL_SHIFT, mock);

      expect(captured).toHaveLength(1);
      const { system } = captured[0]!;
      // v2 rubric must include the calibration anchor
      expect(system).toContain("~70%");
      expect(system).toContain("~25%");
      expect(system).toContain("~5%");
    });

    test("v2 system prompt includes concrete directional_shift criteria", async () => {
      const { mock, captured } = makeCapturingMock({ significance: "directional_shift" });
      await reviewContent(CASE_A_DIRECTIONAL_SHIFT, mock);

      const { system } = captured[0]!;
      // v2 must list concrete tier signals for directional_shift
      expect(system).toContain("商业模式");
      expect(system).toContain("CEO");
      expect(system).toContain("directional_shift");
    });

    test("v2 user prompt reminds model of calibration targets", async () => {
      const { mock, captured } = makeCapturingMock({ significance: "directional_shift" });
      await reviewContent(CASE_A_DIRECTIONAL_SHIFT, mock);

      const { prompt } = captured[0]!;
      // v2 user prompt must reinforce the calibration target
      expect(prompt).toContain("~70/25/5");
    });

    test("mock returns directional_shift for open-source pivot", async () => {
      const { mock } = makeCapturingMock({ significance: "directional_shift" });
      const result = await reviewContent(CASE_A_DIRECTIONAL_SHIFT, mock);
      expect(result.analysis.significance).toBe("directional_shift");
    });
  });

  describe("Case B: routine — developer tutorial blog post", () => {
    test("v2 system prompt includes routine tier criteria that covers tutorials", async () => {
      const { mock, captured } = makeCapturingMock({ significance: "routine" });
      await reviewContent(CASE_B_ROUTINE, mock);

      const { system } = captured[0]!;
      // v2 routine tier must explicitly mention tech blogs and tutorials
      expect(system).toContain("技术博客");
      expect(system).toContain("routine");
    });

    test("v2 user prompt includes competitor name and content", async () => {
      const { mock, captured } = makeCapturingMock({ significance: "routine" });
      await reviewContent(CASE_B_ROUTINE, mock);

      const { prompt } = captured[0]!;
      expect(prompt).toContain("DataFlow");
      expect(prompt).toContain("pipeline-optimization-tips");
    });

    test("mock returns routine for developer tutorial", async () => {
      const { mock } = makeCapturingMock({ significance: "routine" });
      const result = await reviewContent(CASE_B_ROUTINE, mock);
      expect(result.analysis.significance).toBe("routine");
    });
  });

  describe("Case C: notable — direct competing product launch", () => {
    test("v2 system prompt includes notable tier criteria covering product launches", async () => {
      const { mock, captured } = makeCapturingMock({ significance: "notable" });
      await reviewContent(CASE_C_NOTABLE, mock);

      const { system } = captured[0]!;
      // v2 notable tier must include product launches and competitive relevance
      expect(system).toContain("新产品");
      expect(system).toContain("notable");
    });

    test("mock returns notable for direct competing product launch", async () => {
      const { mock } = makeCapturingMock({ significance: "notable" });
      const result = await reviewContent(CASE_C_NOTABLE, mock);
      expect(result.analysis.significance).toBe("notable");
    });
  });

  describe("v2 prompt correctness — structure assertions", () => {
    test("v2 system prompt does NOT use vague 'only truly important' conservative bias", async () => {
      const { mock, captured } = makeCapturingMock();
      await reviewContent(CASE_A_DIRECTIONAL_SHIFT, mock);

      const { system } = captured[0]!;
      // v1 had this vague instruction that biased toward over-classifying notable:
      // "只有真正重要的内容才标记 notable 或 directional_shift"
      expect(system).not.toContain("只有真正重要的内容才标记");
    });

    test("v2 system prompt includes tie-breaking rule: when uncertain, pick lower tier", async () => {
      const { mock, captured } = makeCapturingMock();
      await reviewContent(CASE_A_DIRECTIONAL_SHIFT, mock);

      const { system } = captured[0]!;
      // v2 must tell the model what to do when uncertain
      expect(system).toContain("不确定时选低一级");
    });

    test("schema significance .describe() includes calibration target", () => {
      const significanceField = ContentAnalysisSchema.shape.significance;
      expect(significanceField.description).toContain("~70/25/5");
      expect(significanceField.description).toContain("routine");
      expect(significanceField.description).toContain("notable");
      expect(significanceField.description).toContain("directional_shift");
    });

    test("schema summary .describe() discourages filler phrases", () => {
      const summaryField = ContentAnalysisSchema.shape.summary;
      expect(summaryField.description).toBeTruthy();
      // v2 summary description should warn against hollow verbs
      expect(summaryField.description).toContain("展示了");
    });

    test("schema urgency .describe() ties high urgency to directional_shift", () => {
      const urgencyField = ContentAnalysisSchema.shape.urgency;
      expect(urgencyField.description).toContain("directional_shift");
    });
  });
});
