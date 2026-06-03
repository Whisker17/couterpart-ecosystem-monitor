import { test, expect, describe } from "bun:test";
import { reviewContent } from "../../analyzers/llm-reviewer.js";
import type { ReviewInput, GenerateObjectFn } from "../../analyzers/llm-reviewer.js";

const INPUT: ReviewInput = {
  contentItemId: 1,
  competitorName: "TestCorp",
  competitorOrg: "test-corp",
  competitorTags: ["saas"],
  title: "Test Post",
  content: "Some content here.",
  sourceUrl: "https://test-corp.example.com/post",
  inputQuality: "full",
};

const SUCCESS_RESULT = {
  object: {
    summary: "Test summary",
    technical_detail: "None",
    category: "technical" as const,
    direction_signal: "Signal",
    significance: "routine" as const,
    urgency: "normal" as const,
    sentiment: "neutral" as const,
    why_we_care: "Test",
  },
  usage: { inputTokens: 100, outputTokens: 50 },
};

describe("reviewContent: maxRetries:0 forwarded to generateObject", () => {
  test("passes maxRetries:0 to the generateObjectFn so the SDK does not retry internally", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const captured: { maxRetries: number | undefined } = { maxRetries: undefined };

    const spy: GenerateObjectFn = async (opts) => {
      captured.maxRetries = opts.maxRetries;
      return SUCCESS_RESULT;
    };

    await reviewContent(INPUT, spy);

    expect(captured.maxRetries).toBe(0);
    delete process.env.ANTHROPIC_API_KEY;
  });
});
