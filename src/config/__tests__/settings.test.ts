import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { getSettings, validateEnv } from "../settings.ts";

describe("getSettings", () => {
  test("returns complete settings object with all required sections", () => {
    const settings = getSettings();
    expect(settings.llm).toBeDefined();
    expect(settings.lark).toBeDefined();
    expect(settings.schedule).toBeDefined();
    expect(settings.budget).toBeDefined();
    expect(settings.collector).toBeDefined();
  });

  test("budget.monthlyCap is 40", () => {
    const settings = getSettings();
    expect(settings.budget.monthlyCap).toBe(40);
  });

  test("budget thresholds are correct", () => {
    const settings = getSettings();
    expect(settings.budget.warningThreshold).toBe(0.8);
    expect(settings.budget.cutoffThreshold).toBe(1.0);
  });

  test("llm settings have expected defaults", () => {
    const settings = getSettings();
    expect(typeof settings.llm.model).toBe("string");
    expect(settings.llm.baseUrlEnvVar).toBe("LLM_BASE_URL");
    expect(settings.llm.apiKeyEnvVar).toBe("LLM_API_KEY");
    expect(settings.llm.maxTokensPerCall).toBe(4096);
  });

  test("lark settings reference the correct env var", () => {
    const settings = getSettings();
    expect(settings.lark.webhookUrlEnvVar).toBe("LARK_WEBHOOK_URL");
  });

  test("collector.contentMinLength is 500", () => {
    const settings = getSettings();
    expect(settings.collector.contentMinLength).toBe(500);
  });

  test("schedule has cron expressions for daily and weekly", () => {
    const settings = getSettings();
    expect(typeof settings.schedule.dailyCron).toBe("string");
    expect(typeof settings.schedule.weeklyCron).toBe("string");
  });
});

describe("validateEnv", () => {
  let savedBaseUrl: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedBaseUrl = process.env["LLM_BASE_URL"];
    savedApiKey = process.env["LLM_API_KEY"];
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
  });

  afterEach(() => {
    if (savedBaseUrl !== undefined) {
      process.env["LLM_BASE_URL"] = savedBaseUrl;
    } else {
      delete process.env["LLM_BASE_URL"];
    }
    if (savedApiKey !== undefined) {
      process.env["LLM_API_KEY"] = savedApiKey;
    } else {
      delete process.env["LLM_API_KEY"];
    }
  });

  test("calls process.exit(1) when LLM_BASE_URL is missing", () => {
    process.env["LLM_API_KEY"] = "test-key";
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("calls process.exit(1) when LLM_API_KEY is missing", () => {
    process.env["LLM_BASE_URL"] = "https://test.example.com/v1";
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("calls process.exit(1) when both env vars are missing", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    validateEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("does not call process.exit when both env vars are present", () => {
    process.env["LLM_BASE_URL"] = "https://test.example.com/v1";
    process.env["LLM_API_KEY"] = "test-key";
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    validateEnv();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
