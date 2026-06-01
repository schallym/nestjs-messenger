import {
  BusNameStamp,
  DelayStamp,
  ErrorDetailsStamp,
  HandledStamp,
  InvalidArgumentError,
  ReceivedStamp,
  RedeliveryStamp,
  SentStamp,
  TransportMessageIdStamp,
} from '../src';

describe('stamps', () => {
  it('BusNameStamp carries the bus name', () => {
    expect(new BusNameStamp('command').busName).toBe('command');
  });

  it('SentStamp carries the sender class and optional alias', () => {
    expect(new SentStamp('RedisTransport').senderAlias).toBeUndefined();
    const aliased = new SentStamp('RedisTransport', 'async');
    expect(aliased.senderClass).toBe('RedisTransport');
    expect(aliased.senderAlias).toBe('async');
  });

  it('ReceivedStamp carries the origin transport name', () => {
    expect(new ReceivedStamp('async').transportName).toBe('async');
  });

  it('TransportMessageIdStamp accepts string and numeric ids', () => {
    expect(new TransportMessageIdStamp('1526984818136-0').id).toBe('1526984818136-0');
    expect(new TransportMessageIdStamp(42).id).toBe(42);
  });

  describe('DelayStamp', () => {
    it('carries the delay in milliseconds', () => {
      expect(new DelayStamp(1000).delayMs).toBe(1000);
    });

    it('accepts a zero delay', () => {
      expect(new DelayStamp(0).delayMs).toBe(0);
    });

    it.each([
      ['a negative delay', -1],
      ['a non-finite delay', Number.POSITIVE_INFINITY],
      ['NaN', Number.NaN],
    ])('rejects %s', (_label, value) => {
      expect(() => new DelayStamp(value)).toThrow(InvalidArgumentError);
    });
  });

  it('HandledStamp carries the result and handler name', () => {
    const stamp = new HandledStamp({ ok: true }, 'SendEmailHandler');
    expect(stamp.result).toStrictEqual({ ok: true });
    expect(stamp.handlerName).toBe('SendEmailHandler');
  });

  describe('RedeliveryStamp', () => {
    it('carries the retry count and defaults redeliveredAt to now', () => {
      const before = Date.now();
      const stamp = new RedeliveryStamp(3);
      expect(stamp.retryCount).toBe(3);
      expect(stamp.redeliveredAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('accepts an explicit redeliveredAt', () => {
      const at = new Date('2026-01-01T00:00:00.000Z');
      expect(new RedeliveryStamp(1, at).redeliveredAt).toBe(at);
    });
  });

  describe('ErrorDetailsStamp', () => {
    it('stores the exception class, message, and optional code', () => {
      const stamp = new ErrorDetailsStamp('RangeError', 'too big', 422);
      expect(stamp.exceptionClass).toBe('RangeError');
      expect(stamp.exceptionMessage).toBe('too big');
      expect(stamp.exceptionCode).toBe(422);
    });

    it('create() extracts details from an Error', () => {
      const stamp = ErrorDetailsStamp.create(new TypeError('bad type'));
      expect(stamp.exceptionClass).toBe('TypeError');
      expect(stamp.exceptionMessage).toBe('bad type');
    });

    it('create() handles a thrown string', () => {
      const stamp = ErrorDetailsStamp.create('boom');
      expect(stamp.exceptionClass).toBe('Error');
      expect(stamp.exceptionMessage).toBe('boom');
    });

    it('create() handles a thrown non-Error, non-string value', () => {
      const stamp = ErrorDetailsStamp.create({ weird: true });
      expect(stamp.exceptionClass).toBe('Error');
      expect(stamp.exceptionMessage).toBe('Unknown error');
    });
  });
});
