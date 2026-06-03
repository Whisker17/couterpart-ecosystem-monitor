import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";
import { getDb } from "../../storage/db.js";
import { getSettings } from "../../config/settings.js";
import { getBudgetStatus } from "../../utils/budget-tracker.js";
import { WeeklyThemeSchema } from "../../schema/analysis.js";
import type { WeeklyTheme } from "../../schema/analysis.js";
import { getYesterdayPeriod, getWeekPeriod } from "../../utils/time-window.js";

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

// Convert a YYYY-MM-DD report date string to a Date that represents noon UTC
// on that calendar date. Noon UTC maps to the correct calendar date in all
// practical timezones (UTC-11 to UTC+12), unlike midnight UTC which shifts to
// the previous day in west-of-UTC zones.
function reportDateAsNow(dateStr: string): Date {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  return new Date(Date.UTC(
    parseInt(yearStr!, 10),
    parseInt(monthStr!, 10) - 1,
    parseInt(dayStr!, 10),
    12, 0, 0,
  ));
}

function formatDate(dateStr: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(reportDateAsNow(dateStr));
}

function formatShortDate(dateStr: string, timezone: string): string {
  return formatDate(dateStr, timezone);
}

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
  header: { title: { tag: "plain_text"; content: string }; template?: string };
  elements: LarkElement[];
}

type GenerateObjectFn = (options: {
  model: ReturnType<ReturnType<typeof createAnthropic>>;
  schema: typeof WeeklyThemeSchema;
  system: string;
  prompt: string;
}) => Promise<{ object: WeeklyTheme }>;

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

interface WeeklyRow extends UnreportedRow {}

interface ActivitySummary {
  competitor_name: string;
  competitor_org: string;
  total: number;
  directional_shift: number;
  notable: number;
  routine: number;
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

function truncateSummaryForFallback(
  buildFallback: (summary: string) => LarkCard,
  rawSummary: string,
  limitBytes: number
): string {
  if (Buffer.byteLength(JSON.stringify(buildFallback(rawSummary)), "utf-8") <= limitBytes) {
    return rawSummary;
  }
  const codePoints = [...rawSummary];
  let lo = 0;
  let hi = codePoints.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = codePoints.slice(0, mid).join("") + "…";
    if (Buffer.byteLength(JSON.stringify(buildFallback(candidate)), "utf-8") <= limitBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo === 0) return "…";
  return codePoints.slice(0, lo).join("") + "…";
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

  if (Buffer.byteLength(singleCardJson, "utf-8") <= 20 * 1024) {
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
  if (Buffer.byteLength(trimmedJson, "utf-8") <= 28 * 1024) {
    return [trimmedCard];
  }

  // Still over 28KB: byte-bounded split, chunked per competitor
  const cards: LarkCard[] = [];
  const CARD_LIMIT = 28 * 1024;

  for (const [_org, compItems] of grouped) {
    const competitorName = compItems[0]!.competitor_name;
    let remaining = [...compItems];
    let partNum = 1;

    while (remaining.length > 0) {
      const cardTitle = `${competitorName} — ${baseTitle} (part ${partNum})`;
      let chunk = remaining;
      let card = buildCard(chunk, cardTitle);

      // Halve the chunk until it fits within the byte limit
      while (chunk.length > 1 && Buffer.byteLength(JSON.stringify(card), "utf-8") > CARD_LIMIT) {
        chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
        card = buildCard(chunk, cardTitle);
      }

      // Single-item fallback: emit a minimal plain-text card when even one item exceeds the limit
      if (chunk.length === 1 && Buffer.byteLength(JSON.stringify(card), "utf-8") > CARD_LIMIT) {
        const item = chunk[0]!;
        const buildFallback = (summary: string): LarkCard => ({
          config: { wide_screen_mode: true },
          header: { title: { tag: "plain_text", content: cardTitle } },
          elements: [
            {
              tag: "markdown",
              content: `**[${item.competitor_name}]** — ${summary}\n\n[原文链接](${item.source_url})`,
            },
          ],
        });
        const truncatedSummary = truncateSummaryForFallback(buildFallback, item.summary, CARD_LIMIT);
        cards.push(buildFallback(truncatedSummary));
      } else {
        cards.push(card);
      }

      remaining = remaining.slice(chunk.length);
      partNum++;
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Weekly helpers
// ---------------------------------------------------------------------------

function computeWeekStart(reportDate: string): string {
  const d = new Date(reportDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
}

function buildActivitySummaries(items: WeeklyRow[]): ActivitySummary[] {
  const map = new Map<string, ActivitySummary>();
  for (const item of items) {
    const key = item.competitor_org;
    if (!map.has(key)) {
      map.set(key, {
        competitor_name: item.competitor_name,
        competitor_org: item.competitor_org,
        total: 0,
        directional_shift: 0,
        notable: 0,
        routine: 0,
      });
    }
    const s = map.get(key)!;
    s.total++;
    s[item.significance]++;
  }
  return [...map.values()].sort((a, b) => a.competitor_name.localeCompare(b.competitor_name));
}

async function extractWeeklyThemes(
  items: WeeklyRow[],
  generateObjectFn: GenerateObjectFn
): Promise<WeeklyTheme["themes"]> {
  if (items.length < 3) {
    return [];
  }

  const settings = getSettings();
  const rawBaseUrl = process.env[settings.llm.baseUrlEnvVar];
  const apiKey = process.env[settings.llm.apiKeyEnvVar];
  // @ai-sdk/anthropic appends /messages to baseURL (not /v1/messages), so ensure /v1 is present
  const baseUrl = rawBaseUrl
    ? rawBaseUrl.replace(/\/+$/, "").endsWith("/v1")
      ? rawBaseUrl.replace(/\/+$/, "")
      : `${rawBaseUrl.replace(/\/+$/, "")}/v1`
    : rawBaseUrl;
  const anthropic = createAnthropic({ baseURL: baseUrl, apiKey: apiKey ?? "" });

  const context = items
    .map((i) => `[${i.competitor_name}] ${i.significance} — ${i.summary}`)
    .join("\n");

  try {
    const { object } = await generateObjectFn({
      model: anthropic(settings.llm.model),
      schema: WeeklyThemeSchema,
      system: "你是一名竞品情报分析师，负责从多个竞品的周度动态中提取共同主题和趋势。",
      prompt: `以下是本周各竞品动态摘要，请提取2-3个最重要的跨竞品主题趋势：\n\n${context}`,
    });
    return object.themes;
  } catch (err) {
    console.error("[report] weekly theme extraction failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function buildWeeklyLarkCards(
  items: WeeklyRow[],
  reportDate: string,
  themes: WeeklyTheme["themes"]
): LarkCard[] {
  const weekStart = computeWeekStart(reportDate);
  const baseTitle = `竞品动态周报 - ${weekStart} ~ ${reportDate}`;

  // Grouped map used only for the per-competitor split path (>30KB).
  const grouped = new Map<string, WeeklyRow[]>();
  for (const item of items) {
    const key = item.competitor_org;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }

  // All sections are derived from cardItems so that trim and split paths
  // produce correctly scoped content rather than always rendering all items.
  // themes comes from the outer scope (extracted from the full item list) and
  // appears in every card; cardItems.length < 3 guards the placeholder because
  // cross-competitor themes are only meaningful when the card has enough data.
  function buildCard(cardItems: WeeklyRow[], headerTitle: string): LarkCard {
    const cardDirectionItems = cardItems.filter((i) => i.significance === "directional_shift");
    const cardActivitySummaries = buildActivitySummaries(cardItems);

    const cardGrouped = new Map<string, WeeklyRow[]>();
    for (const item of cardItems) {
      const key = item.competitor_org;
      if (!cardGrouped.has(key)) cardGrouped.set(key, []);
      cardGrouped.get(key)!.push(item);
    }

    const elements: LarkElement[] = [];

    // Direction Changes section
    elements.push({ tag: "markdown", content: `## 方向性变化 (${cardDirectionItems.length})` });
    if (cardDirectionItems.length > 0) {
      for (const item of cardDirectionItems) {
        elements.push({ tag: "markdown", content: buildItemSummaryLine(item) });
      }
    } else {
      elements.push({ tag: "markdown", content: "_本周无方向性变化。_" });
    }
    elements.push({ tag: "hr" });

    // Activity Summary section
    elements.push({ tag: "markdown", content: "## 活动概览" });
    const summaryLines = cardActivitySummaries.map(
      (s) =>
        `**${s.competitor_name}**：共 ${s.total} 条（方向性变化 ${s.directional_shift} / 值得关注 ${s.notable} / 常规 ${s.routine}）`
    );
    elements.push({ tag: "markdown", content: summaryLines.join("\n") || "_本周无动态。_" });
    elements.push({ tag: "hr" });

    // Cross-Competitor Themes section
    elements.push({ tag: "markdown", content: "## 跨竞品主题" });
    if (cardItems.length < 3) {
      elements.push({ tag: "markdown", content: "数据不足，跳过主题提取" });
    } else if (themes.length === 0) {
      elements.push({ tag: "markdown", content: "_主题提取不可用。_" });
    } else {
      for (const theme of themes) {
        const competitorStr = theme.competitors.join("、");
        elements.push({
          tag: "markdown",
          content: `**${theme.title}**（涉及：${competitorStr}）\n${theme.description}`,
        });
      }
    }
    elements.push({ tag: "hr" });

    // Per-competitor collapsible panels
    for (const [, compItems] of cardGrouped) {
      const sorted = [...compItems].sort(
        (a, b) => (SIGNIFICANCE_ORDER[a.significance] ?? 99) - (SIGNIFICANCE_ORDER[b.significance] ?? 99)
      );
      for (const item of sorted) {
        elements.push(buildCollapsiblePanel(item));
      }
    }

    if (cardItems.length === 0) {
      elements.push({ tag: "markdown", content: "本周无新动态。" });
    }

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: headerTitle },
        template: "purple",
      },
      elements,
    };
  }

  const singleCard = buildCard(items, baseTitle);
  const singleJson = JSON.stringify(singleCard);

  if (Buffer.byteLength(singleJson, "utf-8") <= 20 * 1024) {
    return [singleCard];
  }

  const trimmedItems = items.filter((i) => i.significance !== "routine");
  const routineCount = items.length - trimmedItems.length;
  const trimmedCard = buildCard(trimmedItems, baseTitle);
  if (routineCount > 0) {
    trimmedCard.elements.push({
      tag: "markdown",
      content: `_已省略 ${routineCount} 条常规更新以控制卡片大小。_`,
    });
  }

  const trimmedCardJson = JSON.stringify(trimmedCard);
  if (Buffer.byteLength(trimmedCardJson, "utf-8") <= 28 * 1024) {
    return [trimmedCard];
  }

  // Byte-bounded split, chunked per competitor
  const cards: LarkCard[] = [];
  const CARD_LIMIT = 28 * 1024;

  for (const [_org, compItems] of grouped) {
    const competitorName = compItems[0]!.competitor_name;
    let remaining = [...compItems];
    let partNum = 1;

    while (remaining.length > 0) {
      const cardTitle = `${competitorName} — ${baseTitle} (part ${partNum})`;
      let chunk = remaining;
      let card = buildCard(chunk, cardTitle);

      // Halve the chunk until it fits within the byte limit
      while (chunk.length > 1 && Buffer.byteLength(JSON.stringify(card), "utf-8") > CARD_LIMIT) {
        chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
        card = buildCard(chunk, cardTitle);
      }

      // Single-item fallback: emit a minimal plain-text card when even one item exceeds the limit
      if (chunk.length === 1 && Buffer.byteLength(JSON.stringify(card), "utf-8") > CARD_LIMIT) {
        const item = chunk[0]!;
        const buildFallback = (summary: string): LarkCard => ({
          config: { wide_screen_mode: true },
          header: { title: { tag: "plain_text", content: cardTitle }, template: "purple" },
          elements: [
            {
              tag: "markdown",
              content: `**[${item.competitor_name}]** — ${summary}\n\n[原文链接](${item.source_url})`,
            },
          ],
        });
        const truncatedSummary = truncateSummaryForFallback(buildFallback, item.summary, CARD_LIMIT);
        cards.push(buildFallback(truncatedSummary));
      } else {
        cards.push(card);
      }

      remaining = remaining.slice(chunk.length);
      partNum++;
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// ReportStage
// ---------------------------------------------------------------------------

export class ReportStage implements PipelineStage {
  readonly name = "report";
  private readonly generateObjectFn: GenerateObjectFn;

  constructor(generateObjectFn?: GenerateObjectFn) {
    this.generateObjectFn = generateObjectFn ?? (generateObject as unknown as GenerateObjectFn);
  }

  private async executeWeekly(ctx: PipelineContext): Promise<StageResult> {
    const db = getDb();
    const errors: string[] = [];

    const { startUnix: weekStartUnix, endUnix: weekEndUnix } = getWeekPeriod(ctx.timezone, reportDateAsNow(ctx.reportDate));
    const rows = db.query<WeeklyRow, [number, number]>(`
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
        AND CAST(strftime('%s', a.analyzed_at) AS INTEGER) BETWEEN ? AND ?
      ORDER BY c.name ASC
    `).all(weekStartUnix, weekEndUnix);

    const sorted = [...rows].sort((a, b) => {
      if (a.competitor_org !== b.competitor_org) {
        return a.competitor_name.localeCompare(b.competitor_name);
      }
      return (SIGNIFICANCE_ORDER[a.significance] ?? 99) - (SIGNIFICANCE_ORDER[b.significance] ?? 99);
    });

    const themes = await extractWeeklyThemes(sorted, this.generateObjectFn);
    const weeklyDisplayDate = formatDate(ctx.reportDate, ctx.timezone);
    const cards = buildWeeklyLarkCards(sorted, weeklyDisplayDate, themes);

    const reportContent = {
      report_date: ctx.reportDate,
      report_type: "weekly",
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
      themes,
      cards,
    };

    const reportJson = JSON.stringify(reportContent, null, 2);
    const contentHash = createHash("sha256").update(reportJson).digest("hex");

    const weeklyFileDate = formatShortDate(ctx.reportDate, ctx.timezone);
    const filePath = `data/reports/weekly-${weeklyFileDate}.json`;
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

    const stmtGetReport = db.prepare<{ id: number; content_hash: string | null }, [string]>(`
      SELECT id, content_hash FROM reports WHERE report_date = ? AND report_type = 'weekly'
    `);

    const stmtUpsertReport = db.prepare(`
      INSERT INTO reports (report_date, report_type, content, item_count, notable_count, is_partial, content_hash)
      VALUES (?, 'weekly', ?, ?, ?, 0, ?)
      ON CONFLICT(report_date, report_type) DO UPDATE SET
        content        = excluded.content,
        item_count     = excluded.item_count,
        notable_count  = excluded.notable_count,
        content_hash   = excluded.content_hash,
        sent_at        = CASE WHEN excluded.content_hash != reports.content_hash THEN NULL ELSE reports.sent_at END
    `);

    const stmtDeleteDeliveries = db.prepare(`DELETE FROM report_deliveries WHERE report_id = ?`);

    const stmtInsertDelivery = db.prepare(`
      INSERT INTO report_deliveries (report_id, card_index, card_content, delivery_status)
      VALUES (?, ?, ?, 'pending')
    `);

    db.transaction(() => {
      const before = stmtGetReport.get(ctx.reportDate);
      const prevHash = before?.content_hash ?? null;

      stmtUpsertReport.run(ctx.reportDate, reportJson, sorted.length, notableCount, contentHash);

      const report = stmtGetReport.get(ctx.reportDate)!;
      const hashChanged = prevHash !== contentHash;

      if (hashChanged) {
        stmtDeleteDeliveries.run(report.id);
        for (let i = 0; i < cards.length; i++) {
          stmtInsertDelivery.run(report.id, i, JSON.stringify(cards[i]));
        }
      }
    })();

    return {
      success: errors.length === 0,
      itemsProcessed: sorted.length,
      errors,
      durationMs: 0,
    };
  }

  async execute(ctx: PipelineContext): Promise<StageResult> {
    if (ctx.mode === "weekly") {
      return this.executeWeekly(ctx);
    }

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

    // Query items analyzed within yesterday's time window, derived from ctx.reportDate
    // not from ambient new Date() — ensures --date overrides are respected.
    const { startUnix, endUnix } = getYesterdayPeriod(ctx.timezone, reportDateAsNow(ctx.reportDate));
    const rows = db.query<UnreportedRow, [number, number]>(`
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
        AND CAST(strftime('%s', a.analyzed_at) AS INTEGER) BETWEEN ? AND ?
      ORDER BY c.name ASC
    `).all(startUnix, endUnix);

    // Sort within each competitor group by significance
    const sorted = [...rows].sort((a, b) => {
      if (a.competitor_org !== b.competitor_org) {
        return a.competitor_name.localeCompare(b.competitor_name);
      }
      return (SIGNIFICANCE_ORDER[a.significance] ?? 99) - (SIGNIFICANCE_ORDER[b.significance] ?? 99);
    });

    // Build Lark cards using timezone-aware display date
    const displayDate = formatDate(ctx.reportDate, ctx.timezone);
    const cards = buildLarkCards(sorted, displayDate, isPartial, partialCompetitors);

    // Budget footer on daily report cards
    const settings = getSettings();
    const budgetStatus = getBudgetStatus(db, settings);
    if (budgetStatus.usagePercent >= 0.60) {
      const percent = Math.round(budgetStatus.usagePercent * 100);
      const prefix = budgetStatus.usagePercent >= 0.80 ? "⚠️ " : "💰 ";
      const footerContent = `${prefix}本月 LLM 预算：已用 $${budgetStatus.estimatedCostUSD.toFixed(4)} / $${budgetStatus.budgetCapUSD.toFixed(2)}（${percent}%）`;
      for (const card of cards) {
        card.elements.push({ tag: "markdown", content: footerContent });
      }
    }

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
    const fileDate = formatShortDate(ctx.reportDate, ctx.timezone);
    const filePath = `data/reports/daily-${fileDate}.json`;
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
