import { test, expect, describe } from "bun:test";
import { withRetry } from "../../utils/retry.js";

const noop = async (_ms: number) => {};

describe("withRetry: success path", () => {
  test("resolves immediately when fn succeeds on first attempt", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 42; }, {
      maxAttempts: 3,
      initialDelayMs: 100,
      sleepFn: noop,
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("resolves after retry when fn fails then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { maxAttempts: 3, initialDelayMs: 100, sleepFn: noop }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
});

describe("withRetry: failure path", () => {
  test("throws after maxAttempts exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new Error("always fails"); },
        { maxAttempts: 3, initialDelayMs: 100, sleepFn: noop }
      )
    ).rejects.toThrow("always fails");
    expect(calls).toBe(3);
  });

  test("throws immediately when retryIf returns false", async () => {
    let calls = 0;
    const nonRetryable = new Error("fatal");
    await expect(
      withRetry(
        async () => { calls++; throw nonRetryable; },
        {
          maxAttempts: 5,
          initialDelayMs: 100,
          retryIf: () => false,
          sleepFn: noop,
        }
      )
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  test("retries only when retryIf returns true", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          const err = new Error(calls === 1 ? "retryable" : "fatal");
          (err as Error & { retryable?: boolean }).retryable = calls === 1;
          throw err;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 100,
          retryIf: (err) => (err as Error & { retryable?: boolean }).retryable === true,
          sleepFn: noop,
        }
      )
    ).rejects.toThrow("fatal");
    expect(calls).toBe(2);
  });
});

describe("withRetry: backoff delays", () => {
  test("uses exponential backoff between retries", async () => {
    const delays: number[] = [];
    let calls = 0;

    await expect(
      withRetry(
        async () => { calls++; throw new Error("fail"); },
        {
          maxAttempts: 4,
          initialDelayMs: 1000,
          backoffFactor: 2,
          sleepFn: async (ms) => { delays.push(ms); },
        }
      )
    ).rejects.toThrow();

    expect(delays).toEqual([1000, 2000, 4000]);
    expect(calls).toBe(4);
  });

  test("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];

    await expect(
      withRetry(
        async () => { throw new Error("fail"); },
        {
          maxAttempts: 4,
          initialDelayMs: 1000,
          backoffFactor: 10,
          maxDelayMs: 3000,
          sleepFn: async (ms) => { delays.push(ms); },
        }
      )
    ).rejects.toThrow();

    expect(delays.every((d) => d <= 3000)).toBe(true);
  });

  test("calls onRetry with error and attempt number", async () => {
    const retries: Array<{ attempt: number; err: unknown }> = [];

    await expect(
      withRetry(
        async () => { throw new Error("fail"); },
        {
          maxAttempts: 3,
          initialDelayMs: 0,
          onRetry: (err, attempt) => { retries.push({ attempt, err }); },
          sleepFn: noop,
        }
      )
    ).rejects.toThrow();

    expect(retries).toHaveLength(2);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[1]!.attempt).toBe(2);
  });
});

describe("withRetry: maxAttempts edge cases", () => {
  test("maxAttempts=1 means no retries, throws on first failure", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new Error("fail"); },
        { maxAttempts: 1, initialDelayMs: 100, sleepFn: noop }
      )
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
