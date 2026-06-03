import type { Database } from "bun:sqlite";
import type { Settings } from "../config/settings.js";

export interface BudgetStatus {
  estimatedCostUSD: number;
  budgetCapUSD: number;
  usagePercent: number;
  action: "normal" | "warning" | "pause";
}

interface MonthlySpend {
  total: number | null;
}

export function getBudgetStatus(db: Database, settings: Settings): BudgetStatus {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01 00:00:00`;

  const row = db
    .prepare<MonthlySpend, [string]>(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
      FROM analyses
      WHERE datetime(analyzed_at) >= datetime(?)
    `)
    .get(monthStart)!;

  const estimatedCostUSD = row.total ?? 0;
  const budgetCapUSD = settings.budget.monthlyCap;
  const usagePercent = budgetCapUSD > 0 ? estimatedCostUSD / budgetCapUSD : 0;

  let action: "normal" | "warning" | "pause";
  if (usagePercent >= settings.budget.cutoffThreshold) {
    action = "pause";
  } else if (usagePercent >= settings.budget.warningThreshold) {
    action = "warning";
  } else {
    action = "normal";
  }

  return { estimatedCostUSD, budgetCapUSD, usagePercent, action };
}

export function buildBudgetAlertCard(status: BudgetStatus): string {
  const percent = Math.round(status.usagePercent * 100);
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚠️ LLM 预算已达上限，分析已暂停" },
      template: "red",
    },
    elements: [
      {
        tag: "markdown",
        content: [
          "**本月 LLM 预算已耗尽，分析流水线已暂停。**",
          "",
          `- 已用：$${status.estimatedCostUSD.toFixed(4)}`,
          `- 上限：$${status.budgetCapUSD.toFixed(2)}`,
          `- 使用率：${percent}%`,
        ].join("\n"),
      },
    ],
  };
  return JSON.stringify(card);
}
