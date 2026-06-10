export interface TransientRetryOptions {
  /** Total attempts, first try included. Default 3. */
  readonly attempts?: number;
  /** Delay before the first retry; doubles per attempt. Default 100 ms. */
  readonly baseDelayMs?: number;
  /** Injection point for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injection point for tests; must return a number in [0, 1). */
  readonly random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    timer.unref();
  });
}

/**
 * Runs `operation`, retrying when `isTransient(error)` says the failure is a normal
 * cost of lock contention (deadlock, serialization failure) rather than a real error.
 * Mirrors Symfony's DoctrineReceiver: 3 attempts, doubling delay, ±10% jitter.
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  isTransient: (error: unknown) => boolean,
  options: TransientRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      const jitterMs = delayMs * 0.1 * (random() * 2 - 1);
      await sleep(Math.max(0, Math.round(delayMs + jitterMs)));
    }
  }
}
