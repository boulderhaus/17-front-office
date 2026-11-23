export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await withTimeout(operation(), options.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || (options.shouldRetry && !options.shouldRetry(error))) {
        break;
      }
      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(exponential * 0.2 * Math.random());
      await new Promise((resolve) => setTimeout(resolve, exponential + jitter));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Operation failed after retries");
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|authorization)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 500);
}
