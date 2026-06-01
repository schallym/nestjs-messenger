import { InvalidArgumentError } from '../errors';
import type { Stamp } from './stamp';

/**
 * Requests that delivery of a message be delayed by `delayMs` milliseconds.
 *
 * The value is validated at construction: a non-finite or negative delay (which a
 * buggy {@link RetryStrategy} could otherwise produce, e.g. an overflowed backoff)
 * is rejected here rather than being handed to a transport.
 */
export class DelayStamp implements Stamp {
  constructor(public readonly delayMs: number) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new InvalidArgumentError(
        `DelayStamp delayMs must be a finite number >= 0, got ${String(delayMs)}.`,
      );
    }
  }
}
