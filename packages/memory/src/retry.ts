export interface RetryOptions {
    readonly maxRetries?: number;
    readonly initialBackoffMs?: number;
    readonly isNonRetryable?: (err: unknown) => boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;

export async function retryWithBackoff<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialBackoffMs = options?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    const isNonRetryable = options?.isNonRetryable;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (isNonRetryable?.(err)) {
                throw err;
            }
            if (attempt < maxRetries - 1) {
                const backoff = initialBackoffMs * Math.pow(2, attempt);
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
    }
    throw lastError ?? new Error("Unknown error after retries");
}
