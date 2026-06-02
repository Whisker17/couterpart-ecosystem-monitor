import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { collectFromRss } from "../../collectors/blog-rss.js";
import type { RssParserLike, ExtractorFn, RssItem } from "../../collectors/blog-rss.js";

const TEST_DB_PATH = "data/test-blog-rss.db";

function makeFeedItem(overrides: Partial<RssItem> = {}): RssItem {
  return {
    title: "Test Post",
    link: "https://example.com/post-1",
    pubDate: new Date("2026-01-01T00:00:00Z").toISOString(),
    isoDate: "2026-01-01T00:00:00.000Z",
    contentSnippet: "Short snippet",
    content: "Short snippet",
    "content:encoded": undefined,
    ...overrides,
  };
}

function makeParser(items: RssItem[]): RssParserLike {
  return { parseURL: async () => ({ items }) };
}

const noopExtractor: ExtractorFn = async () => null;

const COMPETITOR = {
  name: "Test Corp",
  org: "test-corp",
  blogRssUrl: "https://feeds.test-corp.com/rss",
  xHandle: "testcorp",
  xEnabled: false as const,
  websiteUrl: "https://test-corp.com",
  tags: ["infra"],
  rssQuality: "full" as const,
};

beforeEach(() => {
  process.env.DB_PATH = TEST_DB_PATH;
  mkdirSync("data", { recursive: true });
});

afterEach(async () => {
  const { closeDb } = await import("../../storage/db.js");
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (existsSync(p)) unlinkSync(p);
  }
  delete process.env.DB_PATH;
});

describe("collectFromRss", () => {
  test("returns empty array when feed has no items", async () => {
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([]),
      extractor: noopExtractor,
    });
    expect(result).toEqual([]);
  });

  test("returns one CollectedItem for a single valid feed item", async () => {
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([makeFeedItem({ content: "A".repeat(600) })]),
      extractor: noopExtractor,
    });
    expect(result.length).toBe(1);
    expect(result[0]!.title).toBe("Test Post");
    expect(result[0]!.sourceUrl).toBe("https://example.com/post-1");
    expect(result[0]!.inputQuality).toBe("full");
  });

  test("normalizes source URL (strips tracking params)", async () => {
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([
        makeFeedItem({
          link: "https://example.com/post-1?utm_source=twitter&utm_medium=social",
          content: "A".repeat(600),
        }),
      ]),
      extractor: noopExtractor,
    });
    expect(result[0]!.sourceUrl).not.toContain("utm_");
    expect(result[0]!.sourceUrl).toBe("https://example.com/post-1");
  });

  test("filters items published before 'since' date", async () => {
    const result = await collectFromRss(
      COMPETITOR,
      new Date("2026-01-01T00:00:00Z"),
      {
        parser: makeParser([
          makeFeedItem({ isoDate: "2025-12-01T00:00:00.000Z", content: "A".repeat(600) }),
          makeFeedItem({
            title: "New Post",
            link: "https://example.com/post-2",
            isoDate: "2026-06-01T00:00:00.000Z",
            content: "A".repeat(600),
          }),
        ]),
        extractor: noopExtractor,
      }
    );
    expect(result.length).toBe(1);
    expect(result[0]!.title).toBe("New Post");
  });

  test("deduplicates against existing content_items by source_url", async () => {
    const { getDb } = await import("../../storage/db.js");
    const db = getDb();
    db.exec("INSERT INTO competitors (name, org) VALUES ('Test Corp', 'test-corp')");
    db.exec(
      "INSERT INTO content_items (competitor_id, source, source_url) VALUES (1, 'blog', 'https://example.com/post-1')"
    );

    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([makeFeedItem({ content: "A".repeat(600) })]),
      extractor: noopExtractor,
    });
    expect(result.length).toBe(0);
  });

  test("triggers article-extractor when content < 500 chars", async () => {
    let extractCalled = false;
    const mockExtractor: ExtractorFn = async () => {
      extractCalled = true;
      return { content: "Full article content here with many words" };
    };

    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([makeFeedItem({ content: "Short" })]),
      extractor: mockExtractor,
    });
    expect(extractCalled).toBe(true);
    expect(result[0]!.inputQuality).toBe("full");
  });

  test("sets inputQuality=truncated when article-extractor fails", async () => {
    const failingExtractor: ExtractorFn = async () => {
      throw new Error("403 Forbidden");
    };

    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([makeFeedItem({ content: "Short" })]),
      extractor: failingExtractor,
    });
    expect(result[0]!.inputQuality).toBe("truncated");
    expect(result[0]!.content).toBe("Short");
  });

  test("sets inputQuality=metadata_only when no RSS content", async () => {
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser: makeParser([
        makeFeedItem({
          content: undefined,
          contentSnippet: undefined,
          "content:encoded": undefined,
        }),
      ]),
      extractor: noopExtractor,
    });
    expect(result[0]!.inputQuality).toBe("metadata_only");
  });
});
