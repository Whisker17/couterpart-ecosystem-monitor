import { test, describe, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { closeDb } from "../storage/db.ts";
import { startup } from "../index.ts";
import type { PipelineStage, PipelineContext } from "../pipeline/runner.ts";
import type { Scheduler } from "../scheduler/cron.ts";

// ---------------------------------------------------------------------------
// DB creation smoke test
// ---------------------------------------------------------------------------

const WDIR = resolve(import.meta.dir, "../..");

function cleanup(dbPath: string) {
  for (const ext of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + ext); } catch { /* ok */ }
  }
}

test(
  "bun run dev creates data/monitor.db on startup",
  async () => {
    const dbPath = resolve(WDIR, "data/test-startup.db");
    cleanup(dbPath);

    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: { ...process.env, DB_PATH: dbPath },
      cwd: WDIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Poll up to 3 s (30 × 100 ms) for the file to appear.
    // getDb() runs at module level before validateEnv(), so the DB is
    // created even when LLM env vars are absent.
    let created = false;
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 100));
      if (existsSync(dbPath)) { created = true; break; }
    }

    proc.kill("SIGTERM");
    await proc.exited.catch(() => { /* SIGTERM exit is expected */ });

    cleanup(dbPath);

    expect(created).toBe(true);
  },
  15_000
);

// ---------------------------------------------------------------------------
// validateEnv / startup order tests
// ---------------------------------------------------------------------------

function makeMockScheduler(): Scheduler {
  const self: Scheduler = {
    start() { return self; },
    stop() {},
    async runNow(mode: "daily" | "weekly"): Promise<PipelineContext> {
      return {
        mode,
        reportDate: "2026-06-02",
        timezone: "UTC",
        startedAt: new Date(),
        stageResults: new Map(),
      };
    },
  };
  return self;
}

function makeMockCreateScheduler(onCreated?: () => void) {
  return (_stages: PipelineStage[]) => {
    onCreated?.();
    return makeMockScheduler();
  };
}

describe("startup", () => {
  let savedBaseUrl: string | undefined;
  let savedApiKey: string | undefined;
  let savedDbPath: string | undefined;
  const TEST_DB = resolve(WDIR, "data/test-startup-validation.db");

  beforeEach(() => {
    savedBaseUrl = process.env["LLM_BASE_URL"];
    savedApiKey = process.env["LLM_API_KEY"];
    savedDbPath = process.env["DB_PATH"];
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    process.env["DB_PATH"] = TEST_DB;
  });

  afterEach(() => {
    closeDb();
    for (const ext of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + ext); } catch { /* ok */ }
    }
    if (savedBaseUrl !== undefined) process.env["LLM_BASE_URL"] = savedBaseUrl;
    else delete process.env["LLM_BASE_URL"];
    if (savedApiKey !== undefined) process.env["LLM_API_KEY"] = savedApiKey;
    else delete process.env["LLM_API_KEY"];
    if (savedDbPath !== undefined) process.env["DB_PATH"] = savedDbPath;
    else delete process.env["DB_PATH"];
  });

  test("calls process.exit(1) before creating scheduler when LLM_BASE_URL is missing", () => {
    process.env["LLM_API_KEY"] = "test-key";
    let schedulerCreated = false;
    const mockCreate = makeMockCreateScheduler(() => { schedulerCreated = true; });

    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number) => { throw new Error("process.exit called"); }) as typeof process.exit
    );

    try { startup(mockCreate); } catch { /* exit was called */ }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(schedulerCreated).toBe(false);
    exitSpy.mockRestore();
  });

  test("calls process.exit(1) before creating scheduler when LLM_API_KEY is missing", () => {
    process.env["LLM_BASE_URL"] = "https://test.example.com/v1";
    let schedulerCreated = false;
    const mockCreate = makeMockCreateScheduler(() => { schedulerCreated = true; });

    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number) => { throw new Error("process.exit called"); }) as typeof process.exit
    );

    try { startup(mockCreate); } catch { /* exit was called */ }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(schedulerCreated).toBe(false);
    exitSpy.mockRestore();
  });

  test("calls process.exit(1) before creating scheduler when both env vars are missing", () => {
    let schedulerCreated = false;
    const mockCreate = makeMockCreateScheduler(() => { schedulerCreated = true; });

    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number) => { throw new Error("process.exit called"); }) as typeof process.exit
    );

    try { startup(mockCreate); } catch { /* exit was called */ }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(schedulerCreated).toBe(false);
    exitSpy.mockRestore();
  });

  test("creates scheduler when all required env vars are present", () => {
    process.env["LLM_BASE_URL"] = "https://test.example.com/v1";
    process.env["LLM_API_KEY"] = "test-key";
    let schedulerCreated = false;
    const mockCreate = makeMockCreateScheduler(() => { schedulerCreated = true; });

    const exitSpy = spyOn(process, "exit").mockImplementation(
      ((_code?: number) => undefined) as typeof process.exit
    );

    startup(mockCreate);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(schedulerCreated).toBe(true);
    exitSpy.mockRestore();
  });
});
