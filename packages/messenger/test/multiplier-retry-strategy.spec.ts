import { Envelope, InvalidArgumentError, MultiplierRetryStrategy, RedeliveryStamp } from '../src';

class TestMessage {}

function envelopeWithRetries(retryCount: number): Envelope {
  const envelope = new Envelope(new TestMessage());
  return retryCount === 0 ? envelope : envelope.with(new RedeliveryStamp(retryCount));
}

describe('MultiplierRetryStrategy', () => {
  describe('isRetryable', () => {
    it('retries while the retry count is below maxRetries', () => {
      const strategy = new MultiplierRetryStrategy({ maxRetries: 3 });
      expect(strategy.isRetryable(envelopeWithRetries(0))).toBe(true);
      expect(strategy.isRetryable(envelopeWithRetries(2))).toBe(true);
    });

    it('stops once the retry count reaches maxRetries', () => {
      const strategy = new MultiplierRetryStrategy({ maxRetries: 3 });
      expect(strategy.isRetryable(envelopeWithRetries(3))).toBe(false);
    });

    it('defaults maxRetries to 3', () => {
      const strategy = new MultiplierRetryStrategy();
      expect(strategy.isRetryable(envelopeWithRetries(2))).toBe(true);
      expect(strategy.isRetryable(envelopeWithRetries(3))).toBe(false);
    });
  });

  describe('getWaitingTime', () => {
    it('grows the delay exponentially by the multiplier (jitter disabled)', () => {
      const strategy = new MultiplierRetryStrategy({ delayMs: 1000, multiplier: 2, jitter: 0 });
      expect(strategy.getWaitingTime(envelopeWithRetries(0))).toBe(1000);
      expect(strategy.getWaitingTime(envelopeWithRetries(1))).toBe(2000);
      expect(strategy.getWaitingTime(envelopeWithRetries(2))).toBe(4000);
    });

    it('caps the delay at maxDelayMs when set (jitter disabled)', () => {
      const strategy = new MultiplierRetryStrategy({
        delayMs: 1000,
        multiplier: 10,
        maxDelayMs: 5000,
        jitter: 0,
      });
      expect(strategy.getWaitingTime(envelopeWithRetries(2))).toBe(5000);
    });

    it('does not cap the delay when maxDelayMs is 0 (the default), jitter disabled', () => {
      const strategy = new MultiplierRetryStrategy({ delayMs: 1000, multiplier: 10, jitter: 0 });
      expect(strategy.getWaitingTime(envelopeWithRetries(2))).toBe(100_000);
    });

    it('spreads the delay within ±jitter of the base when jitter is enabled', () => {
      const strategy = new MultiplierRetryStrategy({ delayMs: 1000, multiplier: 1, jitter: 0.1 });
      for (let i = 0; i < 50; i += 1) {
        const delay = strategy.getWaitingTime(envelopeWithRetries(0));
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
      }
    });
  });

  describe('validation', () => {
    it.each([
      ['a negative maxRetries', { maxRetries: -1 }],
      ['a non-integer maxRetries', { maxRetries: 1.5 }],
      ['a negative delayMs', { delayMs: -1 }],
      ['a multiplier below 1', { multiplier: 0.5 }],
      ['a negative maxDelayMs', { maxDelayMs: -1 }],
      ['a negative jitter', { jitter: -0.1 }],
      ['a jitter above 1', { jitter: 1.5 }],
    ])('rejects %s', (_label, options) => {
      expect(() => new MultiplierRetryStrategy(options)).toThrow(InvalidArgumentError);
    });

    it('accepts the boundary values', () => {
      expect(
        () =>
          new MultiplierRetryStrategy({
            maxRetries: 0,
            delayMs: 0,
            multiplier: 1,
            maxDelayMs: 0,
            jitter: 0,
          }),
      ).not.toThrow();
    });
  });
});
