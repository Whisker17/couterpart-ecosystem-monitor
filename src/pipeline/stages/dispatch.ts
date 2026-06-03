import type { PipelineStage, PipelineContext, StageResult } from "../runner.js";
import { getDb } from "../../storage/db.js";
import { getSettings } from "../../config/settings.js";

export interface LarkWebhookResponse {
  code: number;
  msg: string;
  data?: { message_id?: string };
}

type FetchFn = (url: string, opts: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;
export type SendCardFn = (webhookUrl: string, card: string) => Promise<LarkWebhookResponse>;

const RETRY_DELAYS = [2000, 4000, 8000];

export async function sendCard(
  webhookUrl: string,
  card: string,
  sleepFn: SleepFn = (ms) => Bun.sleep(ms),
  fetchFn: FetchFn = fetch
): Promise<LarkWebhookResponse> {
  let lastError: Error = new Error("sendCard failed after all attempts");

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: card,
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        if (attempt < RETRY_DELAYS.length) {
          await sleepFn(RETRY_DELAYS[attempt]!);
          continue;
        }
        throw lastError;
      }

      const body = (await response.json()) as LarkWebhookResponse;

      if (body.code !== 0) {
        lastError = new Error(`Lark API error: code=${body.code} msg=${body.msg}`);
        if (attempt < RETRY_DELAYS.length) {
          await sleepFn(RETRY_DELAYS[attempt]!);
          continue;
        }
        throw lastError;
      }

      return body;
    } catch (err) {
      const isOwnError =
        err instanceof Error &&
        (err.message.startsWith("HTTP ") || err.message.startsWith("Lark API error:"));
      if (isOwnError) throw err;

      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < RETRY_DELAYS.length) {
        await sleepFn(RETRY_DELAYS[attempt]!);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

interface ReportRow {
  id: number;
}

interface DeliveryRow {
  id: number;
  card_content: string;
}

export class DispatchStage implements PipelineStage {
  readonly name = "dispatch";
  private readonly _sendCard: SendCardFn;

  constructor(sendCardFn?: SendCardFn) {
    this._sendCard = sendCardFn ?? sendCard;
  }

  async execute(_ctx: PipelineContext): Promise<StageResult> {
    const settings = getSettings();
    const webhookUrl = process.env[settings.lark.webhookUrlEnvVar];

    if (!webhookUrl) {
      console.warn(`[dispatch] ${settings.lark.webhookUrlEnvVar} is not set — skipping dispatch`);
      return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
    }

    const db = getDb();
    const errors: string[] = [];
    let itemsProcessed = 0;

    const reports = db
      .query<ReportRow, []>(`SELECT id FROM reports WHERE sent_at IS NULL`)
      .all();

    for (const report of reports) {
      const deliveries = db
        .query<DeliveryRow, [number]>(
          `SELECT id, card_content FROM report_deliveries WHERE report_id = ? AND delivery_status != 'sent'`
        )
        .all(report.id);

      let reportHadFailure = false;

      for (const delivery of deliveries) {
        try {
          const resp = await this._sendCard(webhookUrl, delivery.card_content);
          const messageId = resp.data?.message_id ?? null;
          db.query(
            `UPDATE report_deliveries SET delivery_status='sent', message_id=?, sent_at=datetime('now') WHERE id=?`
          ).run(messageId, delivery.id);
          itemsProcessed++;
        } catch (err) {
          reportHadFailure = true;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(msg);
          db.query(
            `UPDATE report_deliveries SET delivery_status='failed', error=? WHERE id=?`
          ).run(msg, delivery.id);
        }
      }

      if (!reportHadFailure) {
        const pendingCount = db
          .query<{ n: number }, [number]>(
            `SELECT COUNT(*) AS n FROM report_deliveries WHERE report_id = ? AND delivery_status != 'sent'`
          )
          .get(report.id)!.n;

        if (pendingCount === 0) {
          db.query(`UPDATE reports SET sent_at=datetime('now') WHERE id=?`).run(report.id);
        }
      }
    }

    return { success: errors.length === 0, itemsProcessed, errors, durationMs: 0 };
  }
}

export const dispatchStage: PipelineStage = new DispatchStage();
