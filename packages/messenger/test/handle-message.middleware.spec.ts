import {
  Envelope,
  HandledStamp,
  HandleMessageMiddleware,
  HandlerFailedError,
  HandlerNotFoundError,
  HandlerRegistry,
} from '../src';
import { RecordingStack } from './support/recording-stack';

class TestMessage {
  constructor(public readonly id: string) {}
}

describe('HandleMessageMiddleware', () => {
  it('invokes the handler and attaches a HandledStamp with its result and name', async () => {
    const registry = new HandlerRegistry();
    registry.register(TestMessage, { name: 'TestHandler', handle: () => 'done' });
    const middleware = new HandleMessageMiddleware(registry);

    const result = await middleware.handle(
      new Envelope(new TestMessage('m-1')),
      new RecordingStack().stack,
    );

    const stamp = result.last(HandledStamp);
    expect(stamp?.result).toBe('done');
    expect(stamp?.handlerName).toBe('TestHandler');
  });

  it('awaits async handlers and captures their resolved value', async () => {
    const registry = new HandlerRegistry();
    registry.register(TestMessage, { name: 'AsyncHandler', handle: () => Promise.resolve(42) });
    const middleware = new HandleMessageMiddleware(registry);

    const result = await middleware.handle(
      new Envelope(new TestMessage('m-1')),
      new RecordingStack().stack,
    );

    expect(result.last(HandledStamp)?.result).toBe(42);
  });

  it('runs every registered handler and stamps each one', async () => {
    const registry = new HandlerRegistry();
    registry.register(TestMessage, { name: 'A', handle: () => 'a' });
    registry.register(TestMessage, { name: 'B', handle: () => 'b' });
    const middleware = new HandleMessageMiddleware(registry);

    const result = await middleware.handle(
      new Envelope(new TestMessage('m-1')),
      new RecordingStack().stack,
    );

    expect(result.all(HandledStamp).map((stamp) => stamp.handlerName)).toStrictEqual(['A', 'B']);
  });

  it('skips a handler that already ran (redelivery dedup) and runs the rest', async () => {
    const registry = new HandlerRegistry();
    const a = jest.fn(() => 'a');
    const b = jest.fn(() => 'b');
    registry.register(TestMessage, { name: 'A', handle: a });
    registry.register(TestMessage, { name: 'B', handle: b });
    const middleware = new HandleMessageMiddleware(registry);
    const envelope = new Envelope(new TestMessage('m-1')).with(new HandledStamp('a', 'A'));

    const result = await middleware.handle(envelope, new RecordingStack().stack);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(result.all(HandledStamp).map((stamp) => stamp.handlerName)).toStrictEqual(['A', 'B']);
  });

  it('wraps a throwing handler in HandlerFailedError carrying the envelope', async () => {
    const registry = new HandlerRegistry();
    const cause = new Error('boom');
    registry.register(TestMessage, {
      name: 'FailingHandler',
      handle: () => {
        throw cause;
      },
    });
    const middleware = new HandleMessageMiddleware(registry);
    const envelope = new Envelope(new TestMessage('m-1'));

    await expect(middleware.handle(envelope, new RecordingStack().stack)).rejects.toMatchObject({
      constructor: HandlerFailedError,
      cause,
    });
  });

  it('throws HandlerNotFoundError when no handler is registered', async () => {
    const middleware = new HandleMessageMiddleware(new HandlerRegistry());

    await expect(
      middleware.handle(new Envelope(new TestMessage('m-1')), new RecordingStack().stack),
    ).rejects.toBeInstanceOf(HandlerNotFoundError);
  });

  it('allows messages with no handler when allowNoHandlers is set, and continues the pipeline', async () => {
    const middleware = new HandleMessageMiddleware(new HandlerRegistry(), true);
    const recording = new RecordingStack();

    await middleware.handle(new Envelope(new TestMessage('m-1')), recording.stack);

    expect(recording.callCount).toBe(1);
  });
});
