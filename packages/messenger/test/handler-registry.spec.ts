import { Envelope, type HandlerDescriptor, HandlerRegistry } from '../src';

class FooMessage {
  constructor(public readonly id: string) {}
}
class BarMessage {}

function descriptor(
  name: string,
  handle: (message: object) => unknown = () => 'handled',
): HandlerDescriptor {
  return { name, handle };
}

describe('HandlerRegistry', () => {
  it('returns the handler registered for a message type', () => {
    const registry = new HandlerRegistry();
    const handler = descriptor('FooHandler');
    registry.register(FooMessage, handler);

    expect([...registry.getHandlers(new Envelope(new FooMessage('1')))]).toStrictEqual([handler]);
  });

  it('keeps multiple handlers for the same message type in registration order', () => {
    const registry = new HandlerRegistry();
    const first = descriptor('First');
    const second = descriptor('Second');
    registry.register(FooMessage, first);
    registry.register(FooMessage, second);

    expect([...registry.getHandlers(new Envelope(new FooMessage('1')))]).toStrictEqual([
      first,
      second,
    ]);
  });

  it('isolates handlers by message type', () => {
    const registry = new HandlerRegistry();
    registry.register(FooMessage, descriptor('FooHandler'));

    expect([...registry.getHandlers(new Envelope(new BarMessage()))]).toStrictEqual([]);
  });

  it('returns an empty list for an unregistered message type', () => {
    const registry = new HandlerRegistry();
    expect([...registry.getHandlers(new Envelope(new FooMessage('1')))]).toStrictEqual([]);
  });
});
