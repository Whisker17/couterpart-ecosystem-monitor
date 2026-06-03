import { APICallError, TypeValidationError, NoObjectGeneratedError } from "ai";
import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";
import { getDb } from "../../storage/db.js";
import { getSettings } from "../../config/settings.js";
import { reviewContent } from "../../analyzers/llm-reviewer.js";
import { withRetry } from "../../utils/retry.js";
import type { ReviewInput, ReviewResult, GenerateObjectFn } from "../../analyzers/llm-reviewer.js";

type SleepFn = (ms: number) => Promise<void>;

export const LLM_TIMEOUT_MS = 60_000;

function isRateLimitError(err: unknown): boolean {
  return err instanceof APICallError && err.statusCode === 429;
}

function isServerError(err: unknown): boolean {
  return err instanceof APICallError && err.statusCode === 500;
}

function isSchemaValidationError(err: unknown): boolean {
  // generateObject() wraps TypeValidationError in NoObjectGeneratedError as err.cause
  return NoObjectGeneratedError.isInstance(err) && TypeValidationError.isInstance((err as NoObjectGeneratedError).cause);
}

function isRetryableApiError(err: unknown): boolean {
  return isRateLimitError(err) || isServerError(err);
}

interface PendingItem {
  id: number;
  competitor_id: number;
  competitor_name: string;
  competitor_org: string;
  competitor_tags: string | null;
  title: string | null;
  content: string | null;
  source_url: string;
  input_quality: string | null;
  retry_count: number;
}

interface MonthlySpend {
  total: number | null;
}

export class AnalyzeStage implements PipelineStage {
  readonly name = "analyze";

  constructor(
    private readonly reviewFn: GenerateObjectFn | undefined = undefined,
    private readonly sleepFn: SleepFn = (ms) => Bun.sleep(ms),
    private readonly timeoutMs: number = LLM_TIMEOUT_MS
  ) {}

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    const db = getDb();
    const settings = getSettings();
    const errors: string[] = [];
    let itemsProcessed = 0;

    const pendingItems = db
      .query<PendingItem, []>(`
        SELECT
          ci.id,
          ci.competitor_id,
          c.name  AS competitor_name,
          c.org   AS competitor_org,
          c.tags  AS competitor_tags,
          ci.title,
          ci.content,
          ci.source_url,
          ci.input_quality,
          ci.retry_count
        FROM content_items ci
        JOIN competitors c ON c.id = ci.competitor_id
        WHERE ci.analysis_status = 'pending'
        ORDER BY ci.id ASC
      `)
      .all();

    if (pendingItems.length === 0) {
      return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
    }

    const now = new Date();
    // Use 'YYYY-MM-01 00:00:00' SQLite datetime format. toISOString() produces
    // 'YYYY-MM-DDT...' (with 'T'), which compares incorrectly against SQLite's
    // datetime('now') default format 'YYYY-MM-DD HH:MM:SS' (space, not 'T').
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01 00:00:00`;

    const selectMonthlySpend = db.prepare<MonthlySpend, [string]>(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
      FROM analyses
      WHERE datetime(analyzed_at) >= datetime(?)
    `);

    const insertAnalysis = db.prepare(`
      INSERT INTO analyses
        (content_item_id, summary, technical_detail, category, direction_signal,
         significance, urgency, sentiment, why_we_care,
         input_tokens, output_tokens, model_id, estimated_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAnalysisInput = db.prepare(`
      INSERT INTO analysis_inputs
        (content_item_id, analysis_id, attempt, prompt_version, input_quality,
         competitor_context, raw_content_snapshot, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const markComplete = db.prepare(`
      UPDATE content_items SET analysis_status = 'complete' WHERE id = ?
    `);

    const markFailed = db.prepare(`
      UPDATE content_items SET
        retry_count = retry_count + 1,
        last_error = ?,
        analysis_status = CASE WHEN retry_count + 1 >= 3 THEN 'failed' ELSE 'pending' END
      WHERE id = ?
    `);

    for (const item of pendingItems) {
      // Budget hard cap check before each item
      const spend = selectMonthlySpend.get(monthStart)!;
      const currentSpend = spend.total ?? 0;
      const budgetCap = settings.budget.monthlyCap;
      const cutoff = settings.budget.cutoffThreshold;

      if (currentSpend / budgetCap >= cutoff) {
        console.log(
          `[analyze] budget cap reached (${currentSpend.toFixed(4)}/${budgetCap}), skipping remaining items`
        );
        break;
      }

      const input: ReviewInput = {
        contentItemId: item.id,
        competitorName: item.competitor_name,
        competitorOrg: item.competitor_org,
        competitorTags: item.competitor_tags
          ? (JSON.parse(item.competitor_tags) as string[])
          : [],
        title: item.title,
        content: item.content,
        sourceUrl: item.source_url,
        inputQuality: item.input_quality,
      };

      let result: ReviewResult | null = null;
      let analysisError: string | null = null;

      // Timeout — mark failed and leave pending for next run if exceeded
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        // Outer retry: schema validation failures (retry 1×)
        result = await withRetry(
          async () => {
            // Inner retry: 429 rate-limit and 500 server errors with exponential backoff
            return withRetry(
              () => reviewContent(input, this.reviewFn, controller.signal),
              {
                maxAttempts: 3,
                initialDelayMs: 2000,
                backoffFactor: 2,
                retryIf: isRetryableApiError,
                onRetry: (err, attempt) => {
                  const status = err instanceof APICallError ? err.statusCode : "?";
                  console.warn(`[analyze] item=${item.id} LLM error (HTTP ${status}), retry ${attempt}/2`);
                },
                sleepFn: this.sleepFn,
              }
            );
          },
          {
            maxAttempts: 2,
            initialDelayMs: 500,
            retryIf: isSchemaValidationError,
            onRetry: (_err, attempt) => {
              console.warn(`[analyze] item=${item.id} schema validation failed, retry ${attempt}/1`);
            },
            sleepFn: this.sleepFn,
          }
        );
      } catch (err) {
        if (controller.signal.aborted) {
          analysisError = `LLM timeout (>${this.timeoutMs / 1000}s)`;
        } else if (isRateLimitError(err)) {
          analysisError = `LLM rate limit (429) — retries exhausted`;
        } else if (isServerError(err)) {
          analysisError = `LLM server error (500) — retries exhausted`;
        } else if (isSchemaValidationError(err) || TypeValidationError.isInstance(err)) {
          analysisError = `Schema validation failed after retry`;
        } else {
          analysisError = err instanceof Error ? err.message : String(err);
        }
        console.error(`[analyze] item=${item.id} failed: ${analysisError}`);
      } finally {
        clearTimeout(timer);
      }

      if (result) {
        insertAnalysis.run(
          item.id,
          result.analysis.summary,
          result.analysis.technical_detail,
          result.analysis.category,
          result.analysis.direction_signal,
          result.analysis.significance,
          result.analysis.urgency,
          result.analysis.sentiment,
          result.analysis.why_we_care,
          result.inputTokens,
          result.outputTokens,
          result.modelId,
          result.estimatedCostUsd
        );

        const analysisId = db
          .query<{ id: number }, []>("SELECT last_insert_rowid() as id")
          .get()!.id;

        insertAnalysisInput.run(
          item.id,
          analysisId,
          item.retry_count + 1,
          "v1",
          item.input_quality,
          result.competitorContext,
          result.rawContentSnapshot,
          null
        );

        markComplete.run(item.id);
        itemsProcessed++;
      } else {
        // Failed call: audit row with NULL analysis_id
        insertAnalysisInput.run(
          item.id,
          null,
          item.retry_count + 1,
          "v1",
          item.input_quality,
          null,
          null,
          analysisError
        );

        markFailed.run(analysisError, item.id);
        errors.push(`item ${item.id}: ${analysisError}`);
      }
    }

    return {
      success: errors.length === 0 || itemsProcessed > 0,
      itemsProcessed,
      errors,
      durationMs: 0,
    };
  }
}

export const analyzeStage: PipelineStage = new AnalyzeStage();
