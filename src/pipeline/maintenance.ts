import { Database } from "bun:sqlite";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

export async function archiveReports(
  db: Database,
  archiveDir: string = process.env.ARCHIVE_DIR ?? "data/archive"
): Promise<void> {
  const rows = db
    .query<
      { id: number; report_date: string; report_type: string; content: string; item_count: number | null; notable_count: number | null; is_partial: number; content_hash: string | null; sent_at: string | null; created_at: string },
      []
    >(
      `SELECT * FROM reports WHERE created_at < datetime('now', '-90 days')`
    )
    .all();

  if (rows.length === 0) {
    console.log("[maintenance] archiveReports: no reports to archive");
    return;
  }

  const ids = rows.map((r) => r.id).join(",");

  // Wrap JSONL write + cascade deletes in a single transaction.
  // report_deliveries has a FK to reports, so deliveries must be removed first.
  const archiveOp = db.transaction(() => {
    for (const row of rows) {
      const month = row.created_at.slice(0, 7); // "YYYY-MM"
      const dir = join(archiveDir, month);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "reports.jsonl"), JSON.stringify(row) + "\n", "utf-8");
    }
    db.exec(`DELETE FROM report_deliveries WHERE report_id IN (${ids})`);
    db.exec(`DELETE FROM reports WHERE id IN (${ids})`);
  });

  archiveOp();

  console.log(`[maintenance] archiveReports: archived ${rows.length} report(s)`);
}

export function vacuumDb(db: Database): void {
  db.exec("VACUUM");
  console.log("[maintenance] vacuumDb: VACUUM completed");
}

export function cleanupOldContent(db: Database): void {
  db.exec(
    `UPDATE content_items SET content = NULL WHERE collected_at < datetime('now', '-60 days') AND analysis_status = 'complete'`
  );
  const { changes } = db.query<{ changes: number }, []>("SELECT changes() AS changes").get()!;
  console.log(`[maintenance] cleanupOldContent: nulled content on ${changes} row(s)`);
}
