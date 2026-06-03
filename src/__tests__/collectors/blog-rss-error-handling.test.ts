import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { collectFromRss, FeedUnavailableError } from "../../collectors/blog-rss.js";
import type { RssParserLike, ExtractorFn } from "../../collectors/blog-rss.js";

const TEST_DB_PATH = "data/test-blog-rss-errors.db";

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

const noopExtractor: ExtractorFn = async () => null;
const noop = async (_ms: number) => {};

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

describe("collectFromRss: HTTP 403/404 → FeedUnavailableError", () => {
  test("throws FeedUnavailableError on HTTP 403", async () => {
    const parser: RssParserLike = {
      parseURL: async () => { throw new Error("Status code 403"); },
    };
    await expect(
      collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop })
    ).rejects.toBeInstanceOf(FeedUnavailableError);
  });

  test("throws FeedUnavailableError on HTTP 404", async () => {
    const parser: RssParserLike = {
      parseURL: async () => { throw new Error("Status code 404"); },
    };
    await expect(
      collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop })
    ).rejects.toBeInstanceOf(FeedUnavailableError);
  });

  test("FeedUnavailableError includes statusCode", async () => {
    const parser: RssParserLike = {
      parseURL: async () => { throw new Error("Request failed: Status code 404"); },
    };
    let caught: FeedUnavailableError | undefined;
    try {
      await collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop });
    } catch (err) {
      if (err instanceof FeedUnavailableError) caught = err;
    }
    expect(caught?.statusCode).toBe(404);
  });

  test("does not retry on HTTP 403 (only 1 call)", async () => {
    let calls = 0;
    const parser: RssParserLike = {
      parseURL: async () => { calls++; throw new Error("Status code 403"); },
    };
    await expect(
      collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop })
    ).rejects.toBeInstanceOf(FeedUnavailableError);
    expect(calls).toBe(1);
  });
});

describe("collectFromRss: malformed XML → skip (return empty)", () => {
  test("returns empty array on malformed XML", async () => {
    const parser: RssParserLike = {
      parseURL: async () => { throw new Error("Invalid XML: unexpected token"); },
    };
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser,
      extractor: noopExtractor,
      sleepFn: noop,
    });
    expect(result).toEqual([]);
  });

  test("returns empty array on 'non-whitespace before first tag' error", async () => {
    const parser: RssParserLike = {
      parseURL: async () => { throw new Error("Non-whitespace before first tag"); },
    };
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser,
      extractor: noopExtractor,
      sleepFn: noop,
    });
    expect(result).toEqual([]);
  });

  test("does not retry on malformed XML (only 1 call)", async () => {
    let calls = 0;
    const parser: RssParserLike = {
      parseURL: async () => { calls++; throw new Error("Invalid XML"); },
    };
    await collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop });
    expect(calls).toBe(1);
  });
});

describe("collectFromRss: network timeout → retry 2×", () => {
  test("retries network timeout errors up to 2 times (3 total attempts)", async () => {
    let calls = 0;
    const parser: RssParserLike = {
      parseURL: async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("Connection timed out");
          (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
          throw err;
        }
        return { items: [] };
      },
    };
    const result = await collectFromRss(COMPETITOR, undefined, {
      parser,
      extractor: noopExtractor,
      sleepFn: noop,
    });
    expect(calls).toBe(3);
    expect(result).toEqual([]);
  });

  test("throws after 3 total attempts on persistent timeout", async () => {
    let calls = 0;
    const timeoutErr = Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" });
    const parser: RssParserLike = {
      parseURL: async () => { calls++; throw timeoutErr; },
    };
    await expect(
      collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop })
    ).rejects.toThrow("timed out");
    expect(calls).toBe(3);
  });

  test("does not retry non-network errors (e.g. unexpected 500 mid-parse)", async () => {
    let calls = 0;
    const parser: RssParserLike = {
      parseURL: async () => {
        calls++;
        throw new Error("Status code 500");
      },
    };
    await expect(
      collectFromRss(COMPETITOR, undefined, { parser, extractor: noopExtractor, sleepFn: noop })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
