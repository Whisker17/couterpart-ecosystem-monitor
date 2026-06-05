import settingsData from "../../config/settings.json" with { type: "json" };

export interface RetentionSettings {
  contentItemsDays: number;
  analysesDays: number;
  analysisInputsDays: number;
  reportsDays: number;
}

export interface Settings {
  llm: {
    model: string;
    baseUrlEnvVar: string;
    apiKeyEnvVar: string;
    maxTokensPerCall: number;
  };
  lark: {
    webhookUrlEnvVar: string;
  };
  schedule: {
    dailyCron: string;
    weeklyCron: string;
    timezone: string;
  };
  budget: {
    monthlyCap: number;
    warningThreshold: number;
    cutoffThreshold: number;
  };
  collector: {
    contentMinLength: number;
  };
  retention: RetentionSettings;
}

const DEFAULT_RETENTION: RetentionSettings = {
  contentItemsDays: 60,
  analysesDays: 60,
  analysisInputsDays: 30,
  reportsDays: 90,
};

export function validateRetention(raw: unknown): RetentionSettings {
  const result: RetentionSettings = { ...DEFAULT_RETENTION };

  if (raw == null || typeof raw !== "object") {
    console.warn("[settings] retention config missing or invalid type — using defaults");
    return result;
  }

  const r = raw as Record<string, unknown>;

  for (const key of ["contentItemsDays", "analysesDays", "analysisInputsDays", "reportsDays"] as const) {
    const val = r[key];
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
      console.warn(`[settings] retention.${key} invalid (${JSON.stringify(val)}) — using default ${DEFAULT_RETENTION[key]}`);
    } else {
      result[key] = val;
    }
  }

  if (result.analysisInputsDays > result.analysesDays) {
    console.warn(
      `[settings] retention.analysisInputsDays (${result.analysisInputsDays}) > analysesDays (${result.analysesDays}) — clamping analysisInputsDays`
    );
    result.analysisInputsDays = result.analysesDays;
  }

  if (result.analysesDays > result.contentItemsDays) {
    console.warn(
      `[settings] retention.analysesDays (${result.analysesDays}) > contentItemsDays (${result.contentItemsDays}) — clamping analysesDays`
    );
    result.analysesDays = result.contentItemsDays;
    if (result.analysisInputsDays > result.analysesDays) {
      result.analysisInputsDays = result.analysesDays;
    }
  }

  return result;
}

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const raw = settingsData as Record<string, unknown>;
  const retention = validateRetention(raw["retention"]);

  cachedSettings = {
    ...(raw as Omit<Settings, "retention">),
    retention,
  } as Settings;

  return cachedSettings;
}

export function validateEnv(): void {
  const settings = getSettings();
  const missing: string[] = [];

  if (!process.env[settings.llm.baseUrlEnvVar]) {
    missing.push(settings.llm.baseUrlEnvVar);
  }
  if (!process.env[settings.llm.apiKeyEnvVar]) {
    missing.push(settings.llm.apiKeyEnvVar);
  }

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}
