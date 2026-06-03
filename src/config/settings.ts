import settingsData from "../../config/settings.json" with { type: "json" };

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
}

export function getSettings(): Settings {
  return settingsData as Settings;
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
