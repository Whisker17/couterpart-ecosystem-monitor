import { test, expect } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";

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

    // Start the entry point. It should call getDb() synchronously during
    // module initialization, creating the DB file before the scheduler fires.
    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: { ...process.env, DB_PATH: dbPath },
      cwd: WDIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Poll up to 3 s (30 × 100 ms) for the file to appear
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
