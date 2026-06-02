import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";
import { getDb } from "../../storage/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UnreportedRow {
  item_id: number;
  competitor_id: number;
  competitor_name: string;
  competitor_org: string;
  source: string;
  source_url: string;
  title: string | null;
  published_at: string | null;
  summary: string;
  technical_detail: string | null;
  category: string | null;
  direction_signal: string | null;
  significance: "routine" | "notable" | "directional_shift";
  urgency: string;
  sentiment: string | null;
  why_we_care: string | null;
}

const SIGNIFICANCE_ORDER: Record<string, number> = {
  directional_shift: 0,
  notable: 1,
  routine: 2,
};

// Lark Message Card v2 element types
interface LarkMarkdownElement {
  tag: "markdown";
  content: string;
}

interface LarkHrElement {
  tag: "hr";
}

interface LarkCollapsiblePanel {
  tag: "collapsible_panel";
  expanded: boolean;
  header: { title: { tag: "plain_text"; content: string } };
  elements: LarkMarkdownElement[];
}

interface LarkFailureNotice {
  tag: "markdown";
  content: string;
}

type LarkElement = LarkMarkdownElement | LarkHrElement | LarkCollapsiblePanel | LarkFailureNotice;

interface LarkCard {
  config: { wide_screen_mode: boolean };
  header: { title: { tag: "plain_text"; content: string } };
  elements: LarkElement[];
}

interface ReportContent {
  report_date: string;
  report_type: string;
  is_partial: boolean;
  partial_competitors: string[];
  items: Array<{
    item_id: number;
    competitor_name: string;
    competitor_org: string;
    source: string;
    source_url: string;
    title: string | null;
    significance: string;
    summary: string;
    direction_signal: string | null;
    why_we_care: string | null;
  }>;
  cards: LarkCard[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildItemSummaryLine(item: UnreportedRow): string {
  const sourceLabel = item.source === "blog" ? "Blog" : "X";
  const titlePart = item.title ? `「${item.title}」` : "";
  return `**[${item.competitor_name}]** ${sourceLabel}${titlePart} — ${item.summary}${item.direction_signal ? `\n> 方向信号：${item.direction_signal}` : ""}`;
}

function buildCollapsiblePanel(item: UnreportedRow): LarkCollapsiblePanel {
  const parts: string[] = [
    `**摘要**：${item.summary}`,
  ];
  if (item.technical_detail) parts.push(`**详细分析**：${item.technical_detail}`);
  if (item.direction_signal) parts.push(`**方向信号**：${item.direction_signal}`);
  if (item.why_we_care) parts.push(`**为何关注**：${item.why_we_care}`);
  if (item.category) parts.push(`**分类**：${item.category}`);
  if (item.sentiment) parts.push(`**情绪**：${item.sentiment}`);
  parts.push(`[原文链接](${item.source_url})`);

  const panelTitle = item.title
    ? `${item.competitor_name} — ${item.title}`
    : `${item.competitor_name} — ${item.significance}`;

  return {
    tag: "collapsible_panel",
    expanded: item.significance === "directional_shift",
    header: {
      title: { tag: "plain_text", content: panelTitle },
    },
    elements: [{ tag: "markdown", content: parts.join("\n\n") }],
  };
}

function buildLarkCards(
  items: UnreportedRow[],
  reportDate: string,
  isPartial: boolean,
  partialCompetitors: string[]
): LarkCard[] {
  // Group items by competitor
  const grouped = new Map<string, UnreportedRow[]>();
  for (const item of items) {
    const key = item.competitor_org;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  function buildCard(cardItems: UnreportedRow[], headerTitle: string): LarkCard {
    const elements: LarkElement[] = [];

    if (isPartial && partialCompetitors.length > 0) {
      elements.push({
        tag: "markdown",
        content: `⚠️ **部分数据缺失**：以下竞品数据采集失败：${partialCompetitors.join("、")}`,
      });
      elements.push({ tag: "hr" });
    }

    // Summary section
    const directionalItems = cardItems.filter((i) => i.significance === "directional_shift");
    const notableItems = cardItems.filter((i) => i.significance === "notable");
    const routineItems = cardItems.filter((i) => i.significance === "routine");

    if (directionalItems.length > 0) {
      elements.push({ tag: "markdown", content: `## 方向性变化 (${directionalItems.length})` });
      for (const item of directionalItems) {
        elements.push({ tag: "markdown", content: buildItemSummaryLine(item) });
      }
      elements.push({ tag: "hr" });
    }

    if (notableItems.length > 0) {
      elements.push({ tag: "markdown", content: `## 值得关注 (${notableItems.length})` });
      for (const item of notableItems) {
        elements.push({ tag: "markdown", content: buildItemSummaryLine(item) });
      }
      elements.push({ tag: "hr" });
    }

    if (routineItems.length > 0) {
      elements.push({ tag: "markdown", content: `## 常规更新 (${routineItems.length})` });
      for (const item of routineItems) {
        elements.push({ tag: "markdown", content: buildItemSummaryLine(item) });
      }
      elements.push({ tag: "hr" });
    }

    if (cardItems.length === 0) {
      elements.push({ tag: "markdown", content: "今日无新动态。" });
    }

    // Detailed collapsible panels per item
    for (const item of cardItems) {
      elements.push(buildCollapsiblePanel(item));
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: "plain_text",
          content: headerTitle,
        },
      },
      elements,
    };
  }

  const partialSuffix = isPartial ? "（部分数据）" : "";
  const baseTitle = `竞品动态日报 - ${reportDate}${partialSuffix}`;

  // Attempt a single card first
  const singleCard = buildCard(items, baseTitle);
  const singleCardJson = JSON.stringify(singleCard);

  if (singleCardJson.length <= 20 * 1024) {
    return [singleCard];
  }

  // Over 20KB: keep only notable/directional_shift
  const trimmedItems = items.filter((i) => i.significance !== "routine");
  const routineCount = items.length - trimmedItems.length;
  const trimmedCard = buildCard(trimmedItems, baseTitle);
  if (routineCount > 0) {
    trimmedCard.elements.push({
      tag: "markdown",
      content: `_已省略 ${routineCount} 条常规更新以控制卡片大小。_`,
    });
  }

  const trimmedJson = JSON.stringify(trimmedCard);
  if (trimmedJson.length <= 30 * 1024) {
    return [trimmedCard];
  }

  // Still over 30KB: split one card per competitor
  const cards: LarkCard[] = [];
  let cardIndex = 0;
  for (const [org, compItems] of grouped) {
    const competitorName = compItems[0]!.competitor_name;
    const cardTitle = `${competitorName} — ${baseTitle} (${cardIndex + 1}/${grouped.size})`;
    cards.push(buildCard(compItems, cardTitle));
    cardIndex++;
  }
  return cards;
}

// ---------------------------------------------------------------------------
// ReportStage
// ---------------------------------------------------------------------------

export class ReportStage implements PipelineStage {
  readonly name = "report";

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const db = getDb();
    const errors: string[] = [];

    // Determine partial status from collect stage
    const collectResult = ctx.stageResults.get("collect");
    const partialCompetitors: string[] = [];
    if (collectResult?.competitorStatuses) {
      for (const cs of collectResult.competitorStatuses) {
        if (!cs.success) partialCompetitors.push(cs.competitorName);
      }
    }
    const isPartial = partialCompetitors.length > 0;

    // Query all unreported completed items
    const rows = db.query<UnreportedRow, []>(`
      SELECT
        ci.id            AS item_id,
        ci.competitor_id,
        c.name           AS competitor_name,
        c.org            AS competitor_org,
        ci.source,
        ci.source_url,
        ci.title,
        ci.published_at,
        a.summary,
        a.technical_detail,
        a.category,
        a.direction_signal,
        a.significance,
        a.urgency,
        a.sentiment,
        a.why_we_care
      FROM content_items ci
      JOIN competitors c    ON c.id = ci.competitor_id
      JOIN analyses a       ON a.content_item_id = ci.id
      WHERE ci.analysis_status = 'complete'
        AND ci.reported_at IS NULL
      ORDER BY c.name ASC
    `).all();

    // Sort within each competitor group by significance
    const sorted = [...rows].sort((a, b) => {
      if (a.competitor_org !== b.competitor_org) {
        return a.competitor_name.localeCompare(b.competitor_name);
      }
      return (SIGNIFICANCE_ORDER[a.significance] ?? 99) - (SIGNIFICANCE_ORDER[b.significance] ?? 99);
    });

    // Build Lark cards
    const cards = buildLarkCards(sorted, ctx.reportDate, isPartial, partialCompetitors);

    // Build report content JSON
    const reportContent: ReportContent = {
      report_date: ctx.reportDate,
      report_type: "daily",
      is_partial: isPartial,
      partial_competitors: partialCompetitors,
      items: sorted.map((r) => ({
        item_id: r.item_id,
        competitor_name: r.competitor_name,
        competitor_org: r.competitor_org,
        source: r.source,
        source_url: r.source_url,
        title: r.title,
        significance: r.significance,
        summary: r.summary,
        direction_signal: r.direction_signal,
        why_we_care: r.why_we_care,
      })),
      cards,
    };

    const reportJson = JSON.stringify(reportContent, null, 2);
    const contentHash = createHash("sha256").update(reportJson).digest("hex");

    // Write local JSON file
    const filePath = `data/reports/daily-${ctx.reportDate}.json`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, reportJson, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to write report file: ${msg}`);
    }

    const notableCount = sorted.filter(
      (r) => r.significance === "notable" || r.significance === "directional_shift"
    ).length;

    // Prepare statements before entering the transaction
    const stmtGetReport = db.prepare<{ id: number; content_hash: string | null }, [string]>(`
      SELECT id, content_hash FROM reports WHERE report_date = ? AND report_type = 'daily'
    `);

    // S3: atomic upsert — hash-change detection and sent_at reset happen inside the DB engine
    const stmtUpsertReport = db.prepare(`
      INSERT INTO reports (report_date, report_type, content, item_count, notable_count, is_partial, content_hash)
      VALUES (?, 'daily', ?, ?, ?, ?, ?)
      ON CONFLICT(report_date, report_type) DO UPDATE SET
        content        = excluded.content,
        item_count     = excluded.item_count,
        notable_count  = excluded.notable_count,
        is_partial     = excluded.is_partial,
        content_hash   = excluded.content_hash,
        sent_at        = CASE WHEN excluded.content_hash != reports.content_hash THEN NULL ELSE reports.sent_at END
    `);

    const stmtDeleteDeliveries = db.prepare(`DELETE FROM report_deliveries WHERE report_id = ?`);

    const stmtInsertDelivery = db.prepare(`
      INSERT INTO report_deliveries (report_id, card_index, card_content, delivery_status)
      VALUES (?, ?, ?, 'pending')
    `);

    // S4: parameterized per-row UPDATE instead of string-interpolated IN (...)
    const stmtMarkReported = db.prepare(`
      UPDATE content_items SET reported_at = datetime('now') WHERE id = ?
    `);

    // S1: wrap all writes in a single transaction — a crash mid-flight rolls back
    // to a consistent state; the next run re-runs fully instead of seeing orphaned state.
    db.transaction(() => {
      const before = stmtGetReport.get(ctx.reportDate);
      const prevHash = before?.content_hash ?? null;

      stmtUpsertReport.run(
        ctx.reportDate, reportJson, sorted.length, notableCount, isPartial ? 1 : 0, contentHash
      );

      const report = stmtGetReport.get(ctx.reportDate)!;
      const hashChanged = prevHash !== contentHash;

      if (hashChanged) {
        stmtDeleteDeliveries.run(report.id);
        for (let i = 0; i < cards.length; i++) {
          stmtInsertDelivery.run(report.id, i, JSON.stringify(cards[i]));
        }
      }

      for (const row of sorted) {
        stmtMarkReported.run(row.item_id);
      }
    })();

    return {
      success: errors.length === 0,
      itemsProcessed: sorted.length,
      errors,
      durationMs: 0,
    };
  }
}

export const reportStage: PipelineStage = new ReportStage();
