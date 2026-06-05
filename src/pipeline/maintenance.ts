import { Database } from "bun:sqlite";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { RetentionSettings } from "../config/settings.js";

export async function archiveReports(
  db: Database,
  reportsDays: number = 90,
  archiveDir: string = process.env.ARCHIVE_DIR ?? "data/archive"
): Promise<void> {
  const rows = db
    .query<
      { id: number; report_date: string; report_type: string; content: string; item_count: number | null; notable_count: number | null; is_partial: number; content_hash: string | null; sent_at: string | null; created_at: string },
      []
    >(
      `SELECT * FROM reports WHERE created_at < datetime('now', '-${reportsDays} days')`
    )
    .all();

  if (rows.length === 0) {
    console.log("[Cleanup] archiveReports: no reports to archive");
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

  console.log(`[Cleanup] archiveReports: archived ${rows.length} report(s).`);
}

export function vacuumDb(db: Database): void {
  db.exec("VACUUM");
  console.log("[Cleanup] vacuumDb: VACUUM completed.");
}

export function cleanupOldContent(db: Database, retentionDays: number = 60): void {
  db.exec(
    `UPDATE content_items SET content = NULL WHERE collected_at < datetime('now', '-${retentionDays} days') AND analysis_status = 'complete' AND content IS NOT NULL`
  );
  const { changes } = db.query<{ changes: number }, []>("SELECT changes() AS changes").get()!;
  console.log(`[Cleanup] cleanupOldContent: nulled ${changes} rows.`);
}

export function cleanupAnalysisInputs(db: Database, retentionDays: number): void {
  const result = db.run(
    `DELETE FROM analysis_inputs WHERE created_at < datetime('now', '-${retentionDays} days')`
  );
  console.log(`[Cleanup] cleanupAnalysisInputs: deleted ${result.changes} rows.`);
}

export function cleanupAnalyses(db: Database, retentionDays: number): void {
  const result = db.run(
    `DELETE FROM analyses
     WHERE analyzed_at < datetime('now', '-${retentionDays} days')
       AND NOT EXISTS (
         SELECT 1 FROM analysis_inputs WHERE analysis_inputs.analysis_id = analyses.id
       )`
  );
  console.log(`[Cleanup] cleanupAnalyses: deleted ${result.changes} rows.`);
}

export function cleanupContentItems(db: Database, retentionDays: number): void {
  const result = db.run(
    `DELETE FROM content_items
     WHERE analysis_status = 'complete'
       AND collected_at < datetime('now', '-${retentionDays} days')
       AND NOT EXISTS (
         SELECT 1 FROM analyses WHERE analyses.content_item_id = content_items.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM analysis_inputs WHERE analysis_inputs.content_item_id = content_items.id
       )`
  );
  console.log(`[Cleanup] cleanupContentItems: deleted ${result.changes} rows.`);
}

export function runDailyCleanup(db: Database, retention: RetentionSettings): void {
  const cleanup = db.transaction(() => {
    cleanupAnalysisInputs(db, retention.analysisInputsDays);
    cleanupAnalyses(db, retention.analysesDays);
    cleanupContentItems(db, retention.contentItemsDays);
    cleanupOldContent(db, retention.contentItemsDays);
  });

  cleanup();
  console.log("[Cleanup] runDailyCleanup: daily cleanup complete.");
}
