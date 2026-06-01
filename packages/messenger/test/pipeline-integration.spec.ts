import {
  AddBusNameStampMiddleware,
  BusNameStamp,
  DelayStamp,
  Envelope,
  FailedMessageProcessingMiddleware,
  HandledStamp,
  HandleMessageMiddleware,
  HandlerRegistry,
  type MessageClass,
  MessageBus,
  type Middleware,
  MultiplierRetryStrategy,
  ReceivedStamp,
  RedeliveryStamp,
  type Sender,
  SendMessageMiddleware,
  SentStamp,
  RetryMiddleware,
} from '../src';
import { FakeSender, FakeSendersLocator } from './support/fake-transport';

class OrderMessage {
  constructor(public readonly id: string) {}
}

/**
 * Assembles the canonical pipeline order (minus the deferred DispatchAfterCurrentBus):
 * AddBusName → FailedMessageProcessing → SendMessage → Retry → HandleMessage.
 */
function buildBus(options: { registry: HandlerRegistry; sender: FakeSender }): MessageBus {
  const routes = new Map<MessageClass, readonly (readonly [string, Sender])[]>([
    [OrderMessage, [['async', options.sender]]],
  ]);
  const senders = new FakeSendersLocator(routes, new Map([['async', options.sender]]));
  const middlewares: readonly Middleware[] = [
    new AddBusNameStampMiddleware('default'),
    new FailedMessageProcessingMiddleware(),
    new SendMessageMiddleware(senders),
    new RetryMiddleware(
      new MultiplierRetryStrategy({ maxRetries: 3, delayMs: 100, multiplier: 2, jitter: 0 }),
      senders,
    ),
    new HandleMessageMiddleware(options.registry),
  ];
  return new MessageBus(middlewares);
}

describe('canonical pipeline (integration)', () => {
  it('sender side: dispatch routes the message to its transport and does not run the handler', async () => {
    const handler = jest.fn(() => 'noop');
    const registry = new HandlerRegistry();
    registry.register(OrderMessage, { name: 'OrderHandler', handle: handler });
    const sender = new FakeSender('stream-1');

    const result = await buildBus({ registry, sender }).dispatch(new OrderMessage('o-1'));

    expect(handler).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(1);
    expect(result.last(BusNameStamp)?.busName).toBe('default');
    expect(result.last(SentStamp)?.senderAlias).toBe('async');
  });

  it('receiver side: a received message skips sending and runs the handler', async () => {
    const handler = jest.fn(() => 'handled');
    const registry = new HandlerRegistry();
    registry.register(OrderMessage, { name: 'OrderHandler', handle: handler });
    const sender = new FakeSender();
    const received = new Envelope(new OrderMessage('o-1')).with(new ReceivedStamp('async'));

    const result = await buildBus({ registry, sender }).dispatch(received);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sender.sent).toHaveLength(0);
    expect(result.last(HandledStamp)?.result).toBe('handled');
  });

  it('receiver side: a failing handler is retried by re-sending to the origin transport', async () => {
    const registry = new HandlerRegistry();
    registry.register(OrderMessage, {
      name: 'OrderHandler',
      handle: () => {
        throw new Error('downstream unavailable');
      },
    });
    const sender = new FakeSender();
    const received = new Envelope(new OrderMessage('o-1')).with(new ReceivedStamp('async'));

    const result = await buildBus({ registry, sender }).dispatch(received);

    expect(sender.sent).toHaveLength(1);
    expect(result.last(RedeliveryStamp)?.retryCount).toBe(1);
    expect(result.last(DelayStamp)?.delayMs).toBe(100);
  });
});
