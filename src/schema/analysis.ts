import { z } from "zod";

export const ContentAnalysisSchema = z.object({
  summary: z
    .string()
    .describe("用1-2句话概括这篇内容的核心信息，要求简洁明了，不包含评价性语言。"),
  technical_detail: z
    .string()
    .describe("深入分析技术细节：涉及的技术栈、架构决策、性能指标、实现方式等专业内容。如无技术内容可留空。"),
  category: z
    .enum([
      "product_launch",
      "strategy_shift",
      "hiring",
      "partnership",
      "technical",
      "marketing",
      "other",
    ])
    .describe(
      "内容分类：product_launch（产品发布）、strategy_shift（战略调整）、hiring（招聘）、partnership（合作）、technical（技术分享）、marketing（市场营销）、other（其他）。"
    ),
  direction_signal: z
    .string()
    .describe("从这篇内容推断竞争对手的战略方向或产品重心变化，分析其背后意图。"),
  significance: z
    .enum(["routine", "notable", "directional_shift"])
    .describe(
      "内容重要程度：routine（常规动态，无需特别关注）、notable（值得关注，可能影响竞争格局）、directional_shift（方向性转变，需要立即响应）。"
    ),
  urgency: z
    .enum(["normal", "high"])
    .describe("紧急程度：normal（正常，纳入日报即可）、high（紧急，需要立即关注或触发告警）。"),
  sentiment: z
    .enum(["positive", "neutral", "negative", "aggressive"])
    .describe(
      "内容情感倾向：positive（积极正面）、neutral（中性客观）、negative（消极负面）、aggressive（攻击性，如直接针对竞争对手）。"
    ),
  why_we_care: z
    .string()
    .describe("用一句话说明这条情报对我方的战略意义，重点说明我们为什么需要关注这件事。"),
});

export type ContentAnalysis = z.infer<typeof ContentAnalysisSchema>;
