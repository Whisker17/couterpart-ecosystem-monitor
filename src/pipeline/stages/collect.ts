import type { PipelineStage, PipelineContext, StageResult, CompetitorStatus } from "../runner.js";
import { getCompetitors as defaultGetCompetitors } from "../../config/competitors.js";
import { collectFromRss as defaultCollectFromRss } from "../../collectors/blog-rss.js";
import { getDb } from "../../storage/db.js";
import type { CompetitorConfig } from "../../config/competitors.js";
import type { CollectedItem } from "../../collectors/blog-rss.js";

type GetCompetitorsFn = () => CompetitorConfig[];
type CollectFromRssFn = (competitor: CompetitorConfig) => Promise<CollectedItem[]>;

export class CollectStage implements PipelineStage {
  readonly name = "collect";

  constructor(
    private readonly getCompetitors: GetCompetitorsFn = defaultGetCompetitors,
    private readonly collectFn: CollectFromRssFn = defaultCollectFromRss
  ) {}

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    const competitors = this.getCompetitors();
    const db = getDb();
    const errors: string[] = [];
    const competitorStatuses: CompetitorStatus[] = [];
    let totalItems = 0;

    const findCompetitor = db.prepare<{ id: number }, [string]>(
      "SELECT id FROM competitors WHERE org = ?"
    );

    const insertCompetitor = db.prepare(
      `INSERT INTO competitors (name, org, blog_rss_url, x_handle, website_url, tags)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const insertItem = db.prepare(
      `INSERT OR IGNORE INTO content_items
         (competitor_id, source, source_url, title, content, published_at, input_quality)
       VALUES (?, 'blog', ?, ?, ?, ?, ?)`
    );

    const updateSynced = db.prepare(
      "UPDATE competitors SET last_synced_at = ? WHERE id = ?"
    );

    for (const competitor of competitors) {
      try {
        const existing = findCompetitor.get(competitor.org);
        let competitorId: number;

        if (existing) {
          competitorId = existing.id;
        } else {
          insertCompetitor.run(
            competitor.name,
            competitor.org,
            competitor.blogRssUrl ?? null,
            competitor.xHandle ?? null,
            competitor.websiteUrl ?? null,
            competitor.tags ? JSON.stringify(competitor.tags) : null
          );
          competitorId = db
            .query<{ id: number }, []>("SELECT last_insert_rowid() as id")
            .get()!.id;
        }

        let itemsCollected = 0;

        if (competitor.blogRssUrl) {
          const items = await this.collectFn(competitor);
          for (const item of items) {
            insertItem.run(
              competitorId,
              item.sourceUrl,
              item.title ?? null,
              item.content ?? null,
              item.publishedAt ?? null,
              item.inputQuality
            );
            itemsCollected++;
          }
          totalItems += itemsCollected;
        }

        updateSynced.run(new Date().toISOString(), competitorId);

        competitorStatuses.push({
          competitorId: competitor.org,
          competitorName: competitor.name,
          success: true,
          itemsCollected,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${competitor.org}: ${message}`);
        competitorStatuses.push({
          competitorId: competitor.org,
          competitorName: competitor.name,
          success: false,
          itemsCollected: 0,
          error: message,
        });
      }
    }

    return {
      success: true,
      itemsProcessed: totalItems,
      errors,
      durationMs: 0,
      competitorStatuses,
    };
  }
}

export const collectStage: PipelineStage = new CollectStage();
