import Parser from "rss-parser";
import { extract as articleExtract } from "@extractus/article-extractor";
import { normalizeUrl } from "../utils/url-normalize.js";
import { getDb } from "../storage/db.js";
import { withRetry } from "../utils/retry.js";
import type { CompetitorConfig } from "../config/competitors.js";

export interface CollectedItem {
  competitorOrg: string;
  title: string | undefined;
  sourceUrl: string;
  content: string | undefined;
  publishedAt: string | undefined;
  inputQuality: "full" | "truncated" | "metadata_only";
}

export type RssParserLike = {
  parseURL: (url: string) => Promise<{ items: RssItem[] }>;
};

export type ExtractorFn = (
  url: string,
  signal?: AbortSignal
) => Promise<{ content?: string | null } | null | undefined>;

export type SleepFn = (ms: number) => Promise<void>;

const CONTENT_THRESHOLD = 500;

export type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  "content:encoded"?: string;
};

export class FeedUnavailableError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, url: string) {
    super(`Feed unavailable (HTTP ${statusCode}): ${url}`);
    this.name = "FeedUnavailableError";
    this.statusCode = statusCode;
  }
}

function extractHttpStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = /\b(4\d{2}|5\d{2})\b/.exec(err.message);
  return match ? parseInt(match[1]!, 10) : undefined;
}

function isFeedUnavailableHttpError(err: unknown): boolean {
  const status = extractHttpStatus(err);
  return status === 403 || status === 404;
}

function isMalformedXmlError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("invalid xml") ||
    msg.includes("non-whitespace before first tag") ||
    msg.includes("failed to parse") ||
    msg.includes("unexpected token") ||
    (msg.includes("parse") && !msg.includes("status"))
  );
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code ?? "";
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enetunreach") ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENETUNREACH"
  );
}

function getRssContent(item: RssItem): string | undefined {
  return item["content:encoded"] || item.content || item.contentSnippet || undefined;
}

function getPublishedAt(item: RssItem): string | undefined {
  return item.isoDate || item.pubDate || undefined;
}

async function resolveContent(
  url: string,
  rssContent: string | undefined,
  extractor: ExtractorFn
): Promise<{ content: string | undefined; inputQuality: CollectedItem["inputQuality"] }> {
  if (!rssContent || rssContent.trim().length === 0) {
    return { content: undefined, inputQuality: "metadata_only" };
  }

  if (rssContent.length >= CONTENT_THRESHOLD) {
    return { content: rssContent, inputQuality: "full" };
  }

  // Short RSS content — attempt full-text extraction; abort and release network
  // resources if the extractor takes too long. clearTimeout in finally ensures
  // the timer is cleared when extraction finishes early (avoids event-loop leak).
  const EXTRACTOR_TIMEOUT_MS = 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACTOR_TIMEOUT_MS);
  try {
    const extracted = await extractor(url, controller.signal);
    if (extracted?.content) {
      return { content: extracted.content, inputQuality: "full" };
    }
    return { content: rssContent, inputQuality: "truncated" };
  } catch {
    // article-extractor failure → keep truncated, no retry
    return { content: rssContent, inputQuality: "truncated" };
  } finally {
    clearTimeout(timer);
  }
}

function getExistingUrls(): Set<string> {
  const db = getDb();
  const rows = db
    .query<{ source_url: string }, []>("SELECT source_url FROM content_items")
    .all();
  return new Set(rows.map((r) => r.source_url));
}

export async function collectFromRss(
  competitor: CompetitorConfig,
  since?: Date,
  deps?: { parser?: RssParserLike; extractor?: ExtractorFn; sleepFn?: SleepFn }
): Promise<CollectedItem[]> {
  if (!competitor.blogRssUrl) return [];

  const url = competitor.blogRssUrl;
  const parser = deps?.parser ?? new Parser({ timeout: 20000 });
  const extractor = deps?.extractor ?? ((feedUrl: string, signal?: AbortSignal) =>
    articleExtract(feedUrl, undefined, { signal }));
  const sleepFn = deps?.sleepFn ?? ((ms: number) => Bun.sleep(ms));

  // Fetch RSS feed: retry up to 2× on network errors; no retry for 403/404 or malformed XML
  let feed: { items: RssItem[] };
  try {
    feed = await withRetry(() => parser.parseURL(url), {
      maxAttempts: 3,
      initialDelayMs: 1000,
      retryIf: isNetworkError,
      sleepFn,
    });
  } catch (err) {
    if (isFeedUnavailableHttpError(err)) {
      const status = extractHttpStatus(err) ?? 0;
      throw new FeedUnavailableError(status, url);
    }
    if (isMalformedXmlError(err)) {
      console.warn(`[blog-rss] Malformed XML for ${url} — skipping feed`);
      return [];
    }
    throw err;
  }

  const existingUrls = getExistingUrls();
  const results: CollectedItem[] = [];

  for (const item of feed.items) {
    if (!item.link) continue;

    const normalizedUrl = normalizeUrl(item.link);

    if (since) {
      const publishedAt = getPublishedAt(item);
      if (publishedAt) {
        const pubDate = new Date(publishedAt);
        if (pubDate <= since) continue;
      }
    }

    if (existingUrls.has(normalizedUrl)) continue;

    const rssContent = getRssContent(item);
    const { content, inputQuality } = await resolveContent(normalizedUrl, rssContent, extractor);

    results.push({
      competitorOrg: competitor.org,
      title: item.title,
      sourceUrl: normalizedUrl,
      content,
      publishedAt: getPublishedAt(item),
      inputQuality,
    });
    existingUrls.add(normalizedUrl); // prevent within-feed URL duplicates
  }

  return results;
}
