import type { Stamp } from './stamp';

/**
 * Captures the error that exhausted a message's retries, attached before routing
 * to the failure transport so a human can inspect what went wrong.
 */
export class ErrorDetailsStamp implements Stamp {
  constructor(
    public readonly exceptionClass: string,
    public readonly exceptionMessage: string,
    public readonly exceptionCode?: string | number,
  ) {}

  /** Build a stamp from an arbitrary thrown value, safely handling non-Error throws. */
  static create(error: unknown): ErrorDetailsStamp {
    if (error instanceof Error) {
      return new ErrorDetailsStamp(error.constructor.name, error.message);
    }
    if (typeof error === 'string') {
      return new ErrorDetailsStamp('Error', error);
    }
    return new ErrorDetailsStamp('Error', 'Unknown error');
  }
}
