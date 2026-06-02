import { describe, test, expect } from "bun:test";
import { getCompetitors } from "../competitors.ts";

describe("getCompetitors", () => {
  test("returns between 3 and 5 competitors", () => {
    const competitors = getCompetitors();
    expect(competitors.length).toBeGreaterThanOrEqual(3);
    expect(competitors.length).toBeLessThanOrEqual(5);
  });

  test("each competitor has required fields: name, org, xEnabled", () => {
    const competitors = getCompetitors();
    for (const c of competitors) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.org).toBe("string");
      expect(c.org.length).toBeGreaterThan(0);
      expect(typeof c.xEnabled).toBe("boolean");
    }
  });

  test("each competitor has rssQuality field", () => {
    const competitors = getCompetitors();
    const validValues = ["full", "truncated", "title_only", "none"];
    for (const c of competitors) {
      expect(c.rssQuality).toBeDefined();
      expect(validValues.includes(c.rssQuality!)).toBe(true);
    }
  });

  test("each competitor has a blogRssUrl", () => {
    const competitors = getCompetitors();
    for (const c of competitors) {
      expect(c.blogRssUrl).toBeDefined();
      expect(c.blogRssUrl!.startsWith("http")).toBe(true);
    }
  });
});
