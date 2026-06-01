import type { Envelope } from '../envelope';

/**
 * Decides whether a failed message should be retried and how long to wait before
 * the next attempt. Mirrors Symfony's `RetryStrategyInterface`.
 *
 * Attempt-count contract: implementations read `envelope.last(RedeliveryStamp)?.retryCount ?? 0`
 * as "retries already performed". Both methods are called with the envelope as it
 * is *before* the new {@link RedeliveryStamp} is written — so on the first failure
 * the count is 0, on the second it is 1, and so on. The {@link RetryMiddleware}
 * stamps `count + 1` after consulting the strategy.
 */
export interface RetryStrategy {
  /** Whether the message should be retried again. */
  isRetryable(envelope: Envelope, error?: unknown): boolean;

  /**
   * Milliseconds to wait before the next attempt. MUST return a finite,
   * non-negative number — a non-finite or negative delay is rejected downstream
   * by {@link DelayStamp}.
   */
  getWaitingTime(envelope: Envelope, error?: unknown): number;
}
