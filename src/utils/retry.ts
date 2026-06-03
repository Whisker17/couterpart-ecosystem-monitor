export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  retryIf?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs = Infinity,
    backoffFactor = 2,
    retryIf = () => true,
    onRetry,
    sleepFn = (ms) => Bun.sleep(ms),
  } = options;

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !retryIf(err)) throw err;
      const delay = Math.min(
        initialDelayMs * Math.pow(backoffFactor, attempt - 1),
        maxDelayMs
      );
      onRetry?.(err, attempt);
      await sleepFn(delay);
    }
  }
}
