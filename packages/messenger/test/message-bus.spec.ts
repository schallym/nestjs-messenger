import { BusNameStamp, Envelope, MessageBus, type Middleware } from '../src';

class TestMessage {
  constructor(public readonly id: string) {}
}

/** Captures the envelope the pipeline received and forwards it. */
function capture(target: { envelope?: Envelope }): Middleware {
  return {
    handle: (envelope, next) => {
      target.envelope = envelope;
      return next().handle(envelope, next);
    },
  };
}

describe('MessageBus', () => {
  it('wraps a plain message in an envelope and runs it through the pipeline', async () => {
    const captured: { envelope?: Envelope } = {};
    const bus = new MessageBus([capture(captured)]);
    const message = new TestMessage('m-1');

    const result = await bus.dispatch(message);

    expect(captured.envelope?.message).toBe(message);
    expect(result.message).toBe(message);
  });

  it('accepts a pre-built envelope without double-wrapping it', async () => {
    const captured: { envelope?: Envelope } = {};
    const bus = new MessageBus([capture(captured)]);
    const envelope = new Envelope(new TestMessage('m-1'), [new BusNameStamp('default')]);

    await bus.dispatch(envelope);

    expect(captured.envelope?.message).toBe(envelope.message);
    expect(captured.envelope?.last(BusNameStamp)?.busName).toBe('default');
  });

  it('applies stamps passed to dispatch', async () => {
    const captured: { envelope?: Envelope } = {};
    const bus = new MessageBus([capture(captured)]);

    await bus.dispatch(new TestMessage('m-1'), [new BusNameStamp('command')]);

    expect(captured.envelope?.last(BusNameStamp)?.busName).toBe('command');
  });

  it('returns the envelope with stamps the pipeline added', async () => {
    const stamping: Middleware = {
      handle: (envelope, next) => next().handle(envelope.with(new BusNameStamp('default')), next),
    };
    const result = await new MessageBus([stamping]).dispatch(new TestMessage('m-1'));
    expect(result.last(BusNameStamp)?.busName).toBe('default');
  });
});
