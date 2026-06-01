import type { Envelope } from '../envelope';
import { InvalidArgumentError } from '../errors';
import { RedeliveryStamp } from '../stamps';
import type { RetryStrategy } from './retry-strategy.interface';

export interface MultiplierRetryStrategyOptions {
  /** Maximum number of retries before giving up. Default 3. */
  readonly maxRetries?: number;
  /** Base delay in milliseconds before the first retry. Default 1000. */
  readonly delayMs?: number;
  /** Factor the delay is multiplied by on each successive attempt. Default 2. */
  readonly multiplier?: number;
  /** Upper bound on the computed delay in milliseconds. 0 (default) means no cap. */
  readonly maxDelayMs?: number;
  /**
   * Randomness fraction (0–1) added to each delay to avoid a thundering herd when
   * many messages fail at once. Default 0.1, matching Symfony. 0 disables it.
   */
  readonly jitter?: number;
}

function assertValidRetryOptions(options: Required<MultiplierRetryStrategyOptions>): void {
  const { maxRetries, delayMs, multiplier, maxDelayMs, jitter } = options;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new InvalidArgumentError('maxRetries must be a non-negative integer.');
  }
  if (delayMs < 0) {
    throw new InvalidArgumentError('delayMs must be greater than or equal to 0.');
  }
  if (multiplier < 1) {
    throw new InvalidArgumentError('multiplier must be greater than or equal to 1.');
  }
  if (maxDelayMs < 0) {
    throw new InvalidArgumentError('maxDelayMs must be greater than or equal to 0.');
  }
  if (jitter < 0 || jitter > 1) {
    throw new InvalidArgumentError('jitter must be between 0 and 1.');
  }
}

/**
 * Exponential-backoff retry strategy: the wait grows by `multiplier` on each
 * attempt, optionally capped at `maxDelayMs`, then spread by `jitter`. With the
 * defaults (delay 1000ms, multiplier 2), successive retries wait ~1s, ~2s, ~4s.
 *
 * Deliberate deviation from Symfony: Symfony defaults `multiplier` to 1 (constant
 * backoff); we default to 2 for exponential backoff out of the box, matching the
 * quickstart. Jitter matches Symfony's default of 0.1.
 */
export class MultiplierRetryStrategy implements RetryStrategy {
  private readonly maxRetries: number;
  private readonly delayMs: number;
  private readonly multiplier: number;
  private readonly maxDelayMs: number;
  private readonly jitter: number;

  constructor(options: MultiplierRetryStrategyOptions = {}) {
    const {
      maxRetries = 3,
      delayMs = 1000,
      multiplier = 2,
      maxDelayMs = 0,
      jitter = 0.1,
    } = options;
    assertValidRetryOptions({ maxRetries, delayMs, multiplier, maxDelayMs, jitter });
    this.maxRetries = maxRetries;
    this.delayMs = delayMs;
    this.multiplier = multiplier;
    this.maxDelayMs = maxDelayMs;
    this.jitter = jitter;
  }

  isRetryable(envelope: Envelope): boolean {
    return this.retryCount(envelope) < this.maxRetries;
  }

  getWaitingTime(envelope: Envelope): number {
    const delay = this.delayMs * this.multiplier ** this.retryCount(envelope);
    const capped = this.maxDelayMs > 0 ? Math.min(delay, this.maxDelayMs) : delay;
    if (this.jitter === 0) {
      return capped;
    }
    // Spread within ±(jitter * capped); jitter ≤ 1 keeps the result non-negative.
    const offset = capped * this.jitter * (Math.random() * 2 - 1);
    return Math.round(capped + offset);
  }

  private retryCount(envelope: Envelope): number {
    return envelope.last(RedeliveryStamp)?.retryCount ?? 0;
  }
}
