import Parser from "rss-parser";
import { extract as articleExtract } from "@extractus/article-extractor";
import { normalizeUrl } from "../utils/url-normalize.js";
import { getDb } from "../storage/db.js";
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
  url: string
) => Promise<{ content?: string | null } | null | undefined>;

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

  // Short RSS content — attempt full-text extraction with a timeout guard
  const EXTRACTOR_TIMEOUT_MS = 15_000;
  try {
    const extracted = await Promise.race([
      extractor(url),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), EXTRACTOR_TIMEOUT_MS)),
    ]);
    if (extracted?.content) {
      return { content: extracted.content, inputQuality: "full" };
    }
    return { content: rssContent, inputQuality: "truncated" };
  } catch {
    return { content: rssContent, inputQuality: "truncated" };
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
  deps?: { parser?: RssParserLike; extractor?: ExtractorFn }
): Promise<CollectedItem[]> {
  if (!competitor.blogRssUrl) return [];

  const parser = deps?.parser ?? new Parser({ timeout: 20000 });
  const extractor = deps?.extractor ?? articleExtract;
  const feed = await parser.parseURL(competitor.blogRssUrl);

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
  }

  return results;
}
