import { BusNameStamp, DelayStamp, Envelope, ReceivedStamp } from '../src';

class TestMessage {
  constructor(public readonly id: string) {}
}

describe('Envelope', () => {
  it('exposes the wrapped message', () => {
    const message = new TestMessage('m-1');
    expect(new Envelope(message).message).toBe(message);
  });

  it('copies the initial stamps so external mutation cannot leak in', () => {
    const stamps = [new BusNameStamp('default')];
    const envelope = new Envelope(new TestMessage('m-1'), stamps);
    stamps.push(new BusNameStamp('leaked'));
    expect(envelope.all(BusNameStamp)).toHaveLength(1);
  });

  it('with() returns a new envelope and leaves the original untouched', () => {
    const original = new Envelope(new TestMessage('m-1'));
    const stamp = new BusNameStamp('default');
    const next = original.with(stamp);

    expect(next).not.toBe(original);
    expect(original.last(BusNameStamp)).toBeUndefined();
    expect(next.last(BusNameStamp)).toBe(stamp);
  });

  it('last() returns the most recently added stamp of a type', () => {
    const first = new BusNameStamp('a');
    const second = new BusNameStamp('b');
    const envelope = new Envelope(new TestMessage('m-1')).with(first, second);
    expect(envelope.last(BusNameStamp)).toBe(second);
  });

  it('last() returns undefined when no stamp of the type is present', () => {
    expect(new Envelope(new TestMessage('m-1')).last(DelayStamp)).toBeUndefined();
  });

  it('all(type) returns every stamp of that type in insertion order', () => {
    const a = new BusNameStamp('a');
    const b = new BusNameStamp('b');
    const envelope = new Envelope(new TestMessage('m-1')).with(a, new ReceivedStamp('redis'), b);
    expect(envelope.all(BusNameStamp)).toStrictEqual([a, b]);
  });

  it('all() groups stamps by type', () => {
    const a = new BusNameStamp('a');
    const b = new BusNameStamp('b');
    const received = new ReceivedStamp('redis');
    const grouped = new Envelope(new TestMessage('m-1')).with(a, received, b).all();

    expect(grouped.get(BusNameStamp)).toStrictEqual([a, b]);
    expect(grouped.get(ReceivedStamp)).toStrictEqual([received]);
  });

  it('withoutAll() removes every stamp of a type and keeps the rest', () => {
    const received = new ReceivedStamp('redis');
    const envelope = new Envelope(new TestMessage('m-1')).with(
      new BusNameStamp('a'),
      received,
      new BusNameStamp('b'),
    );
    const cleaned = envelope.withoutAll(BusNameStamp);

    expect(cleaned.all(BusNameStamp)).toHaveLength(0);
    expect(cleaned.last(ReceivedStamp)).toBe(received);
  });

  describe('wrap()', () => {
    it('wraps a plain message in a new envelope', () => {
      const message = new TestMessage('m-1');
      const envelope = Envelope.wrap(message, [new BusNameStamp('default')]);

      expect(envelope).toBeInstanceOf(Envelope);
      expect(envelope.message).toBe(message);
      expect(envelope.last(BusNameStamp)?.busName).toBe('default');
    });

    it('merges stamps into an already-wrapped message', () => {
      const original = new Envelope(new TestMessage('m-1'));
      const wrapped = Envelope.wrap(original, [new BusNameStamp('default')]);

      expect(wrapped).not.toBe(original);
      expect(wrapped.last(BusNameStamp)?.busName).toBe('default');
    });

    it('returns the same envelope when wrapping with no stamps', () => {
      const original = new Envelope(new TestMessage('m-1'));
      expect(Envelope.wrap(original)).toBe(original);
    });
  });
});
