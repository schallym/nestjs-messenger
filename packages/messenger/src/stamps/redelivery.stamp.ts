import type { Stamp } from './stamp';

/**
 * Tracks how many times a message has been redelivered. The retry strategy reads
 * `retryCount` to decide whether to retry again or route to the failure transport.
 */
export class RedeliveryStamp implements Stamp {
  constructor(
    public readonly retryCount: number,
    public readonly redeliveredAt: Date = new Date(),
  ) {}
}
