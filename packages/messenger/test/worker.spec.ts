import {
  Envelope,
  ErrorDetailsStamp,
  HandleMessageMiddleware,
  HandlerRegistry,
  InMemoryTransport,
  MessageBus,
  type Middleware,
  MultiplierRetryStrategy,
  ReceivedStamp,
  RetryMiddleware,
  RoutingSendersLocator,
  type Sender,
  SendMessageMiddleware,
  SentToFailureTransportStamp,
  TransportError,
  Worker,
} from '../src';

class TestMessage {
  constructor(public readonly id: string) {}
}

class FlakyMessage {
  constructor(public readonly id: string) {}
}

function busFor(registry: HandlerRegistry, allowNoHandlers = false): MessageBus {
  return new MessageBus([new HandleMessageMiddleware(registry, allowNoHandlers)]);
}

async function seed(transport: InMemoryTransport, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await transport.send(new Envelope(new TestMessage(`m-${String(i)}`)));
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 5);
    });
  }
  throw new Error('waitUntil timed out');
}

describe('Worker', () => {
  it('handles messages, acks them, runs the onHandled hook, and stops at the message limit', async () => {
    const handled: string[] = [];
    const onHandled = jest.fn();
    const registry = new HandlerRegistry();
    registry.register(TestMessage, {
      name: 'TestHandler',
      handle: (message) => {
        handled.push((message as TestMessage).id);
      },
    });
    const transport = new InMemoryTransport();
    await seed(transport, 5);
    const worker = new Worker(
      transport,
      busFor(registry),
      {
        maxMessages: 3,
        maxMemoryBytes: 1024 ** 3, // 1 GiB: never reached, exercises the "under limit" path
      },
      { onHandled },
    );

    const stats = await worker.run(new AbortController().signal);

    expect(stats.processed).toBe(3);
    expect(handled).toHaveLength(3);
    expect(onHandled).toHaveBeenCalledTimes(3);
    expect(await transport.getMessageCount()).toBe(2);
    await transport.close();
  });

  it('rejects the message and runs the onError hook when the pipeline throws an infrastructure error', async () => {
    const onError = jest.fn();
    const infraBus = new MessageBus([
      {
        handle(): Promise<Envelope> {
          throw new TransportError('broker unavailable');
        },
      },
    ]);
    const transport = new InMemoryTransport();
    const rejectSpy = jest.spyOn(transport, 'reject');
    await transport.send(new Envelope(new TestMessage('m-1')));
    const worker = new Worker(transport, infraBus, { maxMessages: 1 }, { onError });

    await worker.run(new AbortController().signal);

    expect(rejectSpy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await transport.close();
  });

  // ADR-004: a settlement failure must never become a reject of an already-handled
  // message (that would double-deliver). It propagates; the message stays in-flight.
  it('does not reject (nor double-settle) when ack fails after a successful handle', async () => {
    const registry = new HandlerRegistry();
    registry.register(TestMessage, { name: 'H', handle: () => 'ok' });
    const transport = new InMemoryTransport();
    await transport.send(new Envelope(new TestMessage('m-1')));
    const ackError = new TransportError('ack failed');
    jest.spyOn(transport, 'ack').mockRejectedValueOnce(ackError);
    const rejectSpy = jest.spyOn(transport, 'reject');
    const worker = new Worker(transport, busFor(registry), { maxMessages: 1 });

    await expect(worker.run(new AbortController().signal)).rejects.toBe(ackError);
    expect(rejectSpy).not.toHaveBeenCalled();
  });

  it('stops promptly when the external AbortSignal fires', async () => {
    const transport = new InMemoryTransport();
    const controller = new AbortController();
    const running = new Worker(transport, busFor(new HandlerRegistry(), true)).run(
      controller.signal,
    );

    controller.abort();
    const stats = await running;

    expect(stats.processed).toBe(0);
    await transport.close();
  });

  it('stops after the runtime limit on an idle queue', async () => {
    const transport = new InMemoryTransport();
    const stats = await new Worker(transport, busFor(new HandlerRegistry(), true), {
      maxRuntimeMs: 20,
    }).run(new AbortController().signal);

    expect(stats.processed).toBe(0);
    await transport.close();
  });

  it('stops once the memory limit is reached', async () => {
    const registry = new HandlerRegistry();
    registry.register(TestMessage, { name: 'H', handle: () => 'ok' });
    const transport = new InMemoryTransport();
    await seed(transport, 3);

    const stats = await new Worker(transport, busFor(registry), { maxMemoryBytes: 1 }).run(
      new AbortController().signal,
    );

    expect(stats.processed).toBe(1);
    await transport.close();
  });

  it('retries a failing handler per the strategy, then routes it to the failure transport', async () => {
    const attempts: string[] = [];
    const registry = new HandlerRegistry();
    registry.register(FlakyMessage, {
      name: 'FlakyHandler',
      handle: () => {
        attempts.push('called');
        throw new Error('always fails');
      },
    });
    const asyncTransport = new InMemoryTransport({ name: 'async' });
    const failedTransport = new InMemoryTransport({ name: 'failed' });
    const senders = new RoutingSendersLocator(
      new Map<string, Sender>([
        ['async', asyncTransport],
        ['failed', failedTransport],
      ]),
      new Map(),
    );
    const pipeline: Middleware[] = [
      new SendMessageMiddleware(senders),
      new RetryMiddleware(
        new MultiplierRetryStrategy({ maxRetries: 2, delayMs: 1, multiplier: 1 }),
        senders,
        {
          failureTransport: 'failed',
        },
      ),
      new HandleMessageMiddleware(registry),
    ];
    const bus = new MessageBus(pipeline);
    await asyncTransport.send(new Envelope(new FlakyMessage('f-1')));

    const controller = new AbortController();
    const running = new Worker(asyncTransport, bus).run(controller.signal);
    await waitUntil(async () => (await failedTransport.getMessageCount()) === 1, 2000);
    controller.abort();
    await running;

    // initial attempt + 2 retries = 3 handler calls
    expect(attempts).toHaveLength(3);

    let failedEnvelope: Envelope | undefined;
    const drain = new AbortController();
    for await (const envelope of failedTransport.get(drain.signal)) {
      failedEnvelope = envelope;
      await failedTransport.ack(envelope);
      drain.abort();
    }
    expect(failedEnvelope?.last(ErrorDetailsStamp)?.exceptionMessage).toBe('always fails');
    expect(failedEnvelope?.last(SentToFailureTransportStamp)?.originalReceiverName).toBe('async');
    expect(failedEnvelope?.last(ReceivedStamp)?.transportName).toBe('failed');

    await asyncTransport.close();
    await failedTransport.close();
  });
});
