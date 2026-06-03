// Prompt v2: sharper significance rubric with calibration targets (~70/25/5) and
// concrete criteria per tier; summary style tightened to one focused sentence.
// Distribution audit (reference data from similar PR-analysis pipeline, n=276):
//   actual: routine 45.7% / notable 47.1% / directional_shift 7.2%
//   target: ~70% / ~25% / ~5%
// Root cause: prior rubric lacked explicit calibration anchor and concrete
// differentiation between routine and notable, causing over-classification into notable.
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getSettings } from "../config/settings.js";
import { ContentAnalysisSchema } from "../schema/analysis.js";
import type { ContentAnalysis } from "../schema/analysis.js";

export interface ReviewInput {
  contentItemId: number;
  competitorName: string;
  competitorOrg: string;
  competitorTags: string[];
  title: string | null;
  content: string | null;
  sourceUrl: string;
  inputQuality: string | null;
}

export interface ReviewResult {
  analysis: ContentAnalysis;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  modelId: string;
  competitorContext: string;
  rawContentSnapshot: string;
}

// Claude Sonnet 4.6 pricing (per 1M tokens)
const COST_PER_INPUT_TOKEN = 3.0 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 15.0 / 1_000_000;

function buildSystemPrompt(input: ReviewInput, competitorContext: string): string {
  return `你是一名竞品情报分析师，专注于分析竞争对手的公开内容，为产品和战略团队提供洞察。

## 竞品上下文
${competitorContext}

## 重要程度分类规则（目标分布：~70% routine / ~25% notable / ~5% directional_shift）

### routine（常规，约70%的内容）
符合以下任意条件即为 routine：
- 技术博客、教程、开发者心得、使用案例分享
- 常规招聘信息（非大批量扩张招聘）
- 活动/会议/线下聚会宣传
- 产品小版本更新、bug fix、性能优化
- 行业观点文章、市场分析转载
- 开源项目普通 release 或文档更新
- 无直接商业影响的品牌内容

### notable（值得关注，约25%的内容）
须同时满足：有实质内容 + 对竞争格局有可观察影响：
- 新产品或核心功能的正式发布（非预告）
- 重要商业合作或客户公告（有名有姓）
- C-level/VP 级别高管的离职或加入
- 定价策略或商业模式的明确调整
- 与我方产品直接竞争或互补的重大发布
- 市场定位的明确重新表述（非日常宣传）

### directional_shift（方向性转变，约5%的内容）
须有明确、不可逆的战略信号，且影响超出单一产品线：
- 核心商业模式根本性改变（如从闭源转开源、从SaaS转PaaS）
- 进入全新市场或赛道（非迭代，是实质性的赛道扩张）
- CEO/创始人级别明确宣告的战略转型
- 大规模并购、被收购、合并
- 主动放弃或退出核心产品线

**分类原则**：
1. 不确定时选低一级（directional_shift疑问→notable，notable疑问→routine）
2. 形式不决定分级：一篇"战略发布"博客可能只是 notable，一篇技术文章可能揭示 directional_shift
3. 目标分布是校准参考——如本批内容确实大量重要，适度上调；但绝大多数日常内容应归 routine

## 分析要求
- summary 用一句话点明核心事实，简洁直接，避免"展示了""体现了"等空洞词汇
- why_we_care 聚焦战略意义，说清楚对我方的影响，不超过两句
- technical_detail 仅在有实质技术内容时填写，否则写"无明显技术细节"
- 所有中文字段使用简体中文`;
}

function buildCompetitorContext(input: ReviewInput): string {
  const tags = input.competitorTags.length > 0 ? input.competitorTags.join("、") : "暂无标签";
  return `竞争对手：${input.competitorName}（${input.competitorOrg}）
标签分类：${tags}
官网：${input.sourceUrl}`;
}

function buildUserPrompt(input: ReviewInput): string {
  const title = input.title ?? "（无标题）";
  const content = input.content ?? "（内容不可用）";
  return `请分析以下竞品内容：

**标题**：${title}
**来源**：${input.sourceUrl}
**内容质量**：${input.inputQuality ?? "unknown"}

**正文**：
${content}

注意：significance 分类请严格按照 routine/notable/directional_shift 的定义和目标分布（~70/25/5）进行判断。`;
}

export type GenerateObjectFn = (options: {
  model: ReturnType<ReturnType<typeof createAnthropic>>;
  schema: typeof ContentAnalysisSchema;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}) => Promise<{ object: ContentAnalysis; usage: { inputTokens?: number; outputTokens?: number } }>;

export async function reviewContent(
  input: ReviewInput,
  generateObjectFn?: GenerateObjectFn,
  signal?: AbortSignal
): Promise<ReviewResult> {
  const effectiveGenerateObject = generateObjectFn ?? generateObject;
  const settings = getSettings();
  const baseUrl = process.env[settings.llm.baseUrlEnvVar];
  const apiKey = process.env[settings.llm.apiKeyEnvVar];

  // @ai-sdk/anthropic appends /messages to baseURL (not /v1/messages), so ensure /v1 is present
  const normalizedBaseUrl = baseUrl
    ? baseUrl.replace(/\/+$/, "").endsWith("/v1")
      ? baseUrl.replace(/\/+$/, "")
      : `${baseUrl.replace(/\/+$/, "")}/v1`
    : baseUrl;
  const anthropic = createAnthropic({
    baseURL: normalizedBaseUrl,
    apiKey: apiKey ?? "",
  });

  const competitorContext = buildCompetitorContext(input);
  const systemPrompt = buildSystemPrompt(input, competitorContext);
  const userPrompt = buildUserPrompt(input);
  const rawContentSnapshot = input.content?.slice(0, 2000) ?? "";

  const { object, usage } = await effectiveGenerateObject({
    model: anthropic(settings.llm.model),
    schema: ContentAnalysisSchema,
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: settings.llm.maxTokensPerCall,
    abortSignal: signal,
    maxRetries: 0,
  });

  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const estimatedCostUsd =
    inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;

  return {
    analysis: object,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    modelId: settings.llm.model,
    competitorContext,
    rawContentSnapshot,
  };
}
