import { z } from "zod";

export const ContentAnalysisSchema = z.object({
  summary: z
    .string()
    .describe(
      '一句话点明这篇内容的核心事实，简洁直接。避免使用"展示了""体现了"等空洞词汇，直接描述发生了什么。'
    ),
  technical_detail: z
    .string()
    .describe(
      '技术细节分析：涉及的技术栈、架构决策、性能指标、实现方式等。无实质技术内容时写"无明显技术细节"。'
    ),
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
      "内容分类：product_launch（产品/功能发布）、strategy_shift（战略调整）、hiring（招聘）、partnership（合作/客户公告）、technical（技术分享）、marketing（市场营销）、other（其他）。"
    ),
  direction_signal: z
    .string()
    .describe(
      '从这篇内容推断竞争对手的战略方向或产品重心变化。如无明显信号，写"无明显战略信号"。'
    ),
  significance: z
    .enum(["routine", "notable", "directional_shift"])
    .describe(
      "内容重要程度（目标分布 ~70/25/5）：" +
        "routine（常规，约70%）——技术博客、小版本更新、招聘、活动宣传、无实质竞争影响的内容；" +
        "notable（值得关注，约25%）——新产品正式发布、重要合作、高管变动、定价调整、对竞争格局有可观察影响的事件；" +
        "directional_shift（方向性转变，约5%）——商业模式根本性改变、进入全新赛道、CEO级战略宣告、并购、放弃核心产品线。" +
        "不确定时选低一级。"
    ),
  urgency: z
    .enum(["normal", "high"])
    .describe(
      "紧急程度：normal（正常，纳入日报即可）、high（紧急，需立即关注，仅用于 directional_shift 或影响极大的 notable）。"
    ),
  sentiment: z
    .enum(["positive", "neutral", "negative", "aggressive"])
    .describe(
      "内容情感倾向：positive（积极）、neutral（中性客观）、negative（消极）、aggressive（攻击性，如直接针对竞争对手或我方）。"
    ),
  why_we_care: z
    .string()
    .describe(
      "1-2句话说明这条情报对我方的战略意义：我们为什么要关注，以及可能需要采取什么行动或保持什么关注。"
    ),
});

export type ContentAnalysis = z.infer<typeof ContentAnalysisSchema>;

export const WeeklyThemeSchema = z.object({
  themes: z
    .array(
      z.object({
        title: z.string().describe("主题标题，简洁概括该跨竞品趋势。"),
        description: z.string().describe("对该主题的简短分析，2-3句话，说明趋势背后的含义。"),
        competitors: z.array(z.string()).describe("涉及该主题的竞品名称列表。"),
      })
    )
    .min(2)
    .max(3)
    .describe("从本周竞品动态中提取2-3个最重要的跨竞品主题趋势。"),
});

export type WeeklyTheme = z.infer<typeof WeeklyThemeSchema>;
