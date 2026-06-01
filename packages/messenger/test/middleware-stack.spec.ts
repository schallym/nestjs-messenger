import {
  BusNameStamp,
  Envelope,
  type Middleware,
  MiddlewareStack,
  type StackInterface,
} from '../src';

class TestMessage {
  constructor(public readonly id: string) {}
}

/** A middleware that records the order it ran in and forwards to the next. */
function recorder(label: string, order: string[]): Middleware {
  return {
    async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
      order.push(`>${label}`);
      const result = await next().handle(envelope, next);
      order.push(`<${label}`);
      return result;
    },
  };
}

describe('MiddlewareStack', () => {
  it('runs middlewares as an onion: in-order on the way in, reverse on the way out', async () => {
    const order: string[] = [];
    const stack = new MiddlewareStack([
      recorder('a', order),
      recorder('b', order),
      recorder('c', order),
    ]);

    await stack.run(new Envelope(new TestMessage('m-1')));

    expect(order).toStrictEqual(['>a', '>b', '>c', '<c', '<b', '<a']);
  });

  it('returns the envelope unchanged when there are no middlewares (terminal passthrough)', async () => {
    const envelope = new Envelope(new TestMessage('m-1'));
    const result = await new MiddlewareStack([]).run(envelope);
    expect(result).toBe(envelope);
  });

  it('propagates stamps added by middlewares through the returned envelope', async () => {
    const stamping: Middleware = {
      handle: (envelope, next) => next().handle(envelope.with(new BusNameStamp('default')), next),
    };
    const result = await new MiddlewareStack([stamping]).run(new Envelope(new TestMessage('m-1')));
    expect(result.last(BusNameStamp)?.busName).toBe('default');
  });

  it('short-circuits when a middleware does not call next', async () => {
    const order: string[] = [];
    const shortCircuit: Middleware = {
      handle: (envelope) => Promise.resolve(envelope),
    };
    const stack = new MiddlewareStack([shortCircuit, recorder('never', order)]);

    await stack.run(new Envelope(new TestMessage('m-1')));

    expect(order).toStrictEqual([]);
  });
});
