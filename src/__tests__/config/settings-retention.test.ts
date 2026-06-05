import { test, expect, describe } from "bun:test";
import { validateRetention } from "../../config/settings.js";

describe("validateRetention", () => {
  test("returns defaults for null input", () => {
    const result = validateRetention(null);
    expect(result.contentItemsDays).toBe(60);
    expect(result.analysesDays).toBe(60);
    expect(result.analysisInputsDays).toBe(30);
    expect(result.reportsDays).toBe(90);
  });

  test("returns defaults for missing/undefined input", () => {
    const result = validateRetention(undefined);
    expect(result.contentItemsDays).toBe(60);
    expect(result.analysesDays).toBe(60);
    expect(result.analysisInputsDays).toBe(30);
    expect(result.reportsDays).toBe(90);
  });

  test("returns defaults for non-object input", () => {
    const result = validateRetention("not an object");
    expect(result.contentItemsDays).toBe(60);
    expect(result.analysesDays).toBe(60);
    expect(result.analysisInputsDays).toBe(30);
    expect(result.reportsDays).toBe(90);
  });

  test("accepts valid retention config", () => {
    const result = validateRetention({
      contentItemsDays: 90,
      analysesDays: 60,
      analysisInputsDays: 30,
      reportsDays: 120,
    });
    expect(result.contentItemsDays).toBe(90);
    expect(result.analysesDays).toBe(60);
    expect(result.analysisInputsDays).toBe(30);
    expect(result.reportsDays).toBe(120);
  });

  test("falls back to default for individual invalid fields (non-integer)", () => {
    const result = validateRetention({
      contentItemsDays: 3.5,
      analysesDays: 60,
      analysisInputsDays: 30,
      reportsDays: 90,
    });
    expect(result.contentItemsDays).toBe(60); // default
    expect(result.analysesDays).toBe(60);
  });

  test("falls back to default for individual invalid fields (string)", () => {
    const result = validateRetention({
      contentItemsDays: "sixty",
      analysesDays: 60,
      analysisInputsDays: 30,
      reportsDays: 90,
    });
    expect(result.contentItemsDays).toBe(60); // default
  });

  test("falls back to default for zero or negative values", () => {
    const result = validateRetention({
      contentItemsDays: 0,
      analysesDays: -10,
      analysisInputsDays: 30,
      reportsDays: 90,
    });
    expect(result.contentItemsDays).toBe(60); // default
    expect(result.analysesDays).toBe(60); // default
  });

  test("clamps analysisInputsDays when greater than analysesDays", () => {
    const result = validateRetention({
      contentItemsDays: 90,
      analysesDays: 30,
      analysisInputsDays: 60, // > analysesDays
      reportsDays: 90,
    });
    expect(result.analysisInputsDays).toBe(30); // clamped to analysesDays
    expect(result.analysesDays).toBe(30);
  });

  test("clamps analysesDays when greater than contentItemsDays", () => {
    const result = validateRetention({
      contentItemsDays: 30,
      analysesDays: 60, // > contentItemsDays
      analysisInputsDays: 20,
      reportsDays: 90,
    });
    expect(result.analysesDays).toBe(30); // clamped to contentItemsDays
    expect(result.contentItemsDays).toBe(30);
  });

  test("clamps both analysesDays and analysisInputsDays when chain violates", () => {
    const result = validateRetention({
      contentItemsDays: 20,
      analysesDays: 60, // > contentItemsDays
      analysisInputsDays: 90, // > analysesDays
      reportsDays: 90,
    });
    expect(result.analysesDays).toBe(20); // clamped to contentItemsDays
    expect(result.analysisInputsDays).toBe(20); // clamped to analysesDays (which was clamped)
  });

  test("does not clamp when analysisInputsDays == analysesDays == contentItemsDays", () => {
    const result = validateRetention({
      contentItemsDays: 60,
      analysesDays: 60,
      analysisInputsDays: 60,
      reportsDays: 90,
    });
    expect(result.contentItemsDays).toBe(60);
    expect(result.analysesDays).toBe(60);
    expect(result.analysisInputsDays).toBe(60);
  });

  test("reportsDays is independent — not constrained by other fields", () => {
    const result = validateRetention({
      contentItemsDays: 60,
      analysesDays: 60,
      analysisInputsDays: 30,
      reportsDays: 365,
    });
    expect(result.reportsDays).toBe(365);
  });
});
