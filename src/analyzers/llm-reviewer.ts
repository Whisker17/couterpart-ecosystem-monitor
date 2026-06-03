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

## 重要程度分类规则
- **routine**（常规）：日常博客、技术分享、招聘信息、无实质竞争影响
- **notable**（值得关注）：新功能发布、重要合作、明显的战略调整迹象、影响市场定位的变化
- **directional_shift**（方向性转变）：重大战略转型、进入新市场、核心产品方向改变、可能显著改变竞争格局的举动

## 分析要求
- 保持客观，基于内容本身做推断，避免过度解读
- summary 和 why_we_care 使用中文
- technical_detail 可以使用技术术语，如内容无明显技术细节请写"无明显技术细节"
- 对 significance 保持保守：只有真正重要的内容才标记 notable 或 directional_shift`;
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
${content}`;
}

export type GenerateObjectFn = (options: {
  model: ReturnType<ReturnType<typeof createAnthropic>>;
  schema: typeof ContentAnalysisSchema;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
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
