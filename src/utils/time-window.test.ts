import { test, expect } from "bun:test";
import { getYesterdayPeriod, getWeekPeriod } from "./time-window.js";

test("getYesterdayPeriod: Shanghai daily window", () => {
  const now = new Date("2026-06-03T01:00:00Z");
  const result = getYesterdayPeriod("Asia/Shanghai", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 5, 1, 16, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 2, 15, 59, 59) / 1000);
});

test("getWeekPeriod: Shanghai weekly window", () => {
  const now = new Date("2026-06-08T01:30:00Z");
  const result = getWeekPeriod("Asia/Shanghai", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 4, 31, 16, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 7, 15, 59, 59) / 1000);
});

test("getYesterdayPeriod: UTC daily window", () => {
  const now = new Date("2026-06-03T01:00:00Z");
  const result = getYesterdayPeriod("UTC", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 5, 2, 0, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 2, 23, 59, 59) / 1000);
});

test("getWeekPeriod: UTC weekly window", () => {
  const now = new Date("2026-06-08T00:00:00Z");
  const result = getWeekPeriod("UTC", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 5, 1, 0, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 7, 23, 59, 59) / 1000);
});

// DST regression: spring-forward (2026-03-08 in New York is only 23 hours)
test("getYesterdayPeriod: New York spring-forward day end is 23 h after start", () => {
  // 2026-03-09T16:00Z = Mon 2026-03-09 12:00 EDT → yesterday = 2026-03-08 (spring-forward day)
  const now = new Date("2026-03-09T16:00:00Z");
  const result = getYesterdayPeriod("America/New_York", now);
  // Start: 2026-03-08 00:00 EST = 2026-03-08T05:00:00Z
  expect(result.startUnix).toBe(Date.UTC(2026, 2, 8, 5, 0, 0) / 1000);
  // End: 2026-03-08 23:59:59 EDT = 2026-03-09T03:59:59Z (23-hour day)
  expect(result.endUnix).toBe(Date.UTC(2026, 2, 9, 3, 59, 59) / 1000);
});

// DST regression: fall-back (2026-11-01 in New York is 25 hours)
test("getYesterdayPeriod: New York fall-back day end is 25 h after start", () => {
  // 2026-11-02T17:00Z = Mon 2026-11-02 12:00 EST → yesterday = 2026-11-01 (fall-back day)
  const now = new Date("2026-11-02T17:00:00Z");
  const result = getYesterdayPeriod("America/New_York", now);
  // Start: 2026-11-01 00:00 EDT = 2026-11-01T04:00:00Z
  expect(result.startUnix).toBe(Date.UTC(2026, 10, 1, 4, 0, 0) / 1000);
  // End: 2026-11-01 23:59:59 EST = 2026-11-02T04:59:59Z (25-hour day)
  expect(result.endUnix).toBe(Date.UTC(2026, 10, 2, 4, 59, 59) / 1000);
});
