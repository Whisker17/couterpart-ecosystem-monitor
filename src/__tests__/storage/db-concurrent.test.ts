import { test, expect } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";

const WDIR = resolve(import.meta.dir, "../../..");

function cleanup(dbPath: string) {
  for (const ext of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + ext); } catch { /* ok */ }
  }
}

test(
  "concurrent startup — no SQLITE_BUSY when busy_timeout is set before journal_mode=WAL",
  async () => {
    const dbPath = resolve(WDIR, "data/test-concurrent-init.db");
    cleanup(dbPath);

    // 5 processes all opening the same fresh DB path simultaneously.
    // With busy_timeout set FIRST (before journal_mode=WAL), every process
    // waits up to 5 s for the lock instead of crashing immediately.
    const helperPath = resolve(import.meta.dir, "init-once.ts");
    const processes = Array.from({ length: 5 }, () =>
      Bun.spawn(["bun", "run", helperPath], {
        env: { ...process.env, DB_PATH: dbPath },
        cwd: WDIR,
        stdout: "pipe",
        stderr: "pipe",
      })
    );

    const results = await Promise.all(
      processes.map(async (p) => ({
        code: await p.exited,
        stderr: await new Response(p.stderr).text(),
      }))
    );

    cleanup(dbPath);

    for (const { code, stderr } of results) {
      expect(stderr).not.toContain("SQLITE_BUSY");
      expect(stderr).not.toContain("database is locked");
      expect(code).toBe(0);
    }
  },
  30_000
);
