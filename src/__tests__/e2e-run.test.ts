import { test, expect, describe } from "bun:test";
import { isValidDate } from "../utils/validate-date.js";

describe("isValidDate", () => {
  test("accepts a valid calendar date", () => {
    expect(isValidDate("2026-06-05")).toBe(true);
  });

  test("accepts leap day on a leap year", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
  });

  test("rejects non-date string", () => {
    expect(isValidDate("not-a-date")).toBe(false);
  });

  test("rejects impossible calendar date (Feb 31)", () => {
    expect(isValidDate("2026-02-31")).toBe(false);
  });

  test("rejects leap day on a non-leap year", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
  });

  test("rejects wrong format (no separators)", () => {
    expect(isValidDate("20260605")).toBe(false);
  });

  test("rejects partial date", () => {
    expect(isValidDate("2026-06")).toBe(false);
  });
});

describe("e2e-run CLI date validation (subprocess)", () => {
  const script = new URL("../e2e-run.ts", import.meta.url).pathname;

  test("--date not-a-date exits with code 1 and prints error", () => {
    const result = Bun.spawnSync(["bun", "run", script, "--date", "not-a-date", "--no-dispatch"], {
      env: { ...process.env, DB_PATH: ":memory:" },
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("--date must be a valid calendar date");
  });

  test("--date 2026-02-31 exits with code 1 (impossible date)", () => {
    const result = Bun.spawnSync(["bun", "run", script, "--date", "2026-02-31", "--no-dispatch"], {
      env: { ...process.env, DB_PATH: ":memory:" },
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("--date must be a valid calendar date");
  });

  test("--date 2026-06-05 passes date validation (exits via mode error, not date error)", () => {
    // Date is checked before mode; using an invalid mode forces a fast exit without
    // running the pipeline while proving that date validation was passed.
    const result = Bun.spawnSync(
      ["bun", "run", script, "--date", "2026-06-05", "--mode", "invalid-mode"],
      {
        env: { ...process.env, DB_PATH: ":memory:" },
        stderr: "pipe",
      }
    );
    expect(result.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).not.toContain("--date must be a valid calendar date");
    expect(stderr).toContain("Invalid --mode");
  });
});
