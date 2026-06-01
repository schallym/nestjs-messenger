import {
  BusNameStamp,
  type EncodedEnvelope,
  Envelope,
  ErrorDetailsStamp,
  JsonSerializer,
  ReceivedStamp,
  RedeliveryStamp,
  SentToFailureTransportStamp,
  SerializationError,
  TransportMessageIdStamp,
} from '../src';

class OrderMessage {
  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {}
}

const serializer = new JsonSerializer([OrderMessage]);

/** Build an EncodedEnvelope with sensible defaults, overriding pieces per test. */
function encoded(overrides: Partial<EncodedEnvelope> = {}): EncodedEnvelope {
  return {
    body: '{"orderId":"o-1","total":42}',
    headers: { 'X-Message-Type': 'OrderMessage', 'X-Message-Stamps': '[]' },
    ...overrides,
  };
}

describe('JsonSerializer', () => {
  it('round-trips a message and its sendable stamps, preserving class identity', () => {
    const original = new Envelope(new OrderMessage('o-1', 42)).with(
      new BusNameStamp('default'),
      new RedeliveryStamp(2),
      // Failure-flow stamps must be reconstructible (regression: these were once
      // missing from the built-in registry — caught by the Redis e2e).
      new ErrorDetailsStamp('Error', 'boom'),
      new SentToFailureTransportStamp('async'),
    );

    const decoded = serializer.decode(serializer.encode(original));

    expect(decoded.message).toBeInstanceOf(OrderMessage);
    expect(decoded.message).toStrictEqual(new OrderMessage('o-1', 42));
    expect(decoded.last(BusNameStamp)?.busName).toBe('default');
    expect(decoded.last(RedeliveryStamp)?.retryCount).toBe(2);
    expect(decoded.last(ErrorDetailsStamp)?.exceptionMessage).toBe('boom');
    expect(decoded.last(SentToFailureTransportStamp)?.originalReceiverName).toBe('async');
  });

  it('strips non-sendable stamps (ReceivedStamp, TransportMessageIdStamp) on encode', () => {
    const original = new Envelope(new OrderMessage('o-1', 42))
      .with(new BusNameStamp('default'))
      .with(new ReceivedStamp('async'))
      .with(new TransportMessageIdStamp('stream-1'));

    const decoded = serializer.decode(serializer.encode(original));

    expect(decoded.last(BusNameStamp)?.busName).toBe('default');
    expect(decoded.last(ReceivedStamp)).toBeUndefined();
    expect(decoded.last(TransportMessageIdStamp)).toBeUndefined();
  });

  it('encodes the message type and stamps into headers', () => {
    const result = serializer.encode(new Envelope(new OrderMessage('o-1', 42)));
    expect(result.headers['X-Message-Type']).toBe('OrderMessage');
    expect(result.headers['X-Message-Stamps']).toBe('[]');
    expect(JSON.parse(result.body)).toStrictEqual({ orderId: 'o-1', total: 42 });
  });

  it('can be constructed with no registered message types', () => {
    const bare = new JsonSerializer();
    const result = bare.encode(new Envelope(new OrderMessage('o-1', 42)));
    expect(result.headers['X-Message-Type']).toBe('OrderMessage');
  });

  it('treats an envelope with no stamps header as having no stamps', () => {
    const decoded = serializer.decode(encoded({ headers: { 'X-Message-Type': 'OrderMessage' } }));
    expect(decoded.all().size).toBe(0);
  });

  it('rejects a missing message-type header', () => {
    expect(() => serializer.decode(encoded({ headers: {} }))).toThrow(SerializationError);
  });

  it('rejects an unknown (unregistered) message type', () => {
    expect(() =>
      serializer.decode(encoded({ headers: { 'X-Message-Type': 'GhostMessage' } })),
    ).toThrow(/No type "GhostMessage" is registered/);
  });

  it('rejects a body that is not valid JSON', () => {
    expect(() => serializer.decode(encoded({ body: 'not json' }))).toThrow(SerializationError);
  });

  it.each([
    ['a JSON primitive', '5'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
  ])('rejects a body that is %s', (_label, body) => {
    expect(() => serializer.decode(encoded({ body }))).toThrow(/body must be a JSON object/);
  });

  it('rejects a stamps header that does not encode an array', () => {
    expect(() =>
      serializer.decode(
        encoded({ headers: { 'X-Message-Type': 'OrderMessage', 'X-Message-Stamps': '5' } }),
      ),
    ).toThrow(/must encode an array/);
  });

  it.each([
    ['a non-object entry', '[1]', /must be an object/],
    ['a JSON null entry', '[null]', /must be an object/],
    ['a missing type', '[{"data":{}}]', /missing a string "type"/],
    ['a non-object data', '[{"type":"BusNameStamp","data":5}]', /missing its "data"/],
    ['a null data', '[{"type":"BusNameStamp","data":null}]', /missing its "data"/],
  ])('rejects a stamp that is %s', (_label, stampsHeader, pattern) => {
    expect(() =>
      serializer.decode(
        encoded({
          headers: { 'X-Message-Type': 'OrderMessage', 'X-Message-Stamps': stampsHeader },
        }),
      ),
    ).toThrow(pattern);
  });
});
