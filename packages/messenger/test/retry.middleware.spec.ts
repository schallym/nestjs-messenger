import {
  DelayStamp,
  Envelope,
  ErrorDetailsStamp,
  HandlerFailedError,
  type Middleware,
  ReceivedStamp,
  RedeliveryStamp,
  type RetryStrategy,
  RetryMiddleware,
  SentToFailureTransportStamp,
  type StackInterface,
  TransportNotFoundError,
} from '../src';
import { FakeSender, FakeSendersLocator } from './support/fake-transport';
import { RecordingStack } from './support/recording-stack';

class TestMessage {
  constructor(public readonly id: string) {}
}

/** A retry strategy with hard-coded answers, to isolate the middleware's behaviour. */
class StubStrategy implements RetryStrategy {
  constructor(
    private readonly retryable: boolean,
    private readonly delay = 500,
  ) {}
  isRetryable(): boolean {
    return this.retryable;
  }
  getWaitingTime(): number {
    return this.delay;
  }
}

/** A pipeline continuation whose handler throws the given error (becomes a rejection). */
function rejectingStack(error: Error): StackInterface {
  const terminal: Middleware = {
    handle(): Promise<Envelope> {
      throw error;
    },
  };
  return () => terminal;
}

describe('RetryMiddleware', () => {
  it('returns the envelope unchanged when the handler succeeds', async () => {
    const middleware = new RetryMiddleware(new StubStrategy(true), new FakeSendersLocator());
    const envelope = new Envelope(new TestMessage('m-1'));

    expect(await middleware.handle(envelope, new RecordingStack().stack)).toBe(envelope);
  });

  it('rethrows errors that are not handler failures (transport/serialization stay infrastructure)', async () => {
    const middleware = new RetryMiddleware(new StubStrategy(true), new FakeSendersLocator());
    const infraError = new Error('ECONNREFUSED');

    await expect(
      middleware.handle(new Envelope(new TestMessage('m-1')), rejectingStack(infraError)),
    ).rejects.toBe(infraError);
  });

  it('rethrows a handler failure for a synchronously dispatched message (no origin to retry against)', async () => {
    const middleware = new RetryMiddleware(new StubStrategy(true), new FakeSendersLocator());
    const envelope = new Envelope(new TestMessage('m-1'));
    const failure = new HandlerFailedError(envelope, new Error('boom'));

    await expect(middleware.handle(envelope, rejectingStack(failure))).rejects.toBe(failure);
  });

  it('resends to the origin transport with an incremented RedeliveryStamp and a DelayStamp', async () => {
    const origin = new FakeSender();
    const senders = new FakeSendersLocator(new Map(), new Map([['async', origin]]));
    const middleware = new RetryMiddleware(new StubStrategy(true, 750), senders);
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));

    await middleware.handle(
      envelope,
      rejectingStack(new HandlerFailedError(envelope, new Error('boom'))),
    );

    expect(origin.sent).toHaveLength(1);
    expect(origin.sent[0]?.last(RedeliveryStamp)?.retryCount).toBe(1);
    expect(origin.sent[0]?.last(DelayStamp)?.delayMs).toBe(750);
  });

  it('increments the redelivery count from the existing stamp', async () => {
    const origin = new FakeSender();
    const senders = new FakeSendersLocator(new Map(), new Map([['async', origin]]));
    const middleware = new RetryMiddleware(new StubStrategy(true), senders);
    const envelope = new Envelope(new TestMessage('m-1'))
      .with(new ReceivedStamp('async'))
      .with(new RedeliveryStamp(1));

    await middleware.handle(
      envelope,
      rejectingStack(new HandlerFailedError(envelope, new Error('boom'))),
    );

    expect(origin.sent[0]?.last(RedeliveryStamp)?.retryCount).toBe(2);
  });

  it('throws TransportNotFoundError when the origin transport is unknown', async () => {
    const middleware = new RetryMiddleware(new StubStrategy(true), new FakeSendersLocator());
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));

    await expect(
      middleware.handle(
        envelope,
        rejectingStack(new HandlerFailedError(envelope, new Error('boom'))),
      ),
    ).rejects.toBeInstanceOf(TransportNotFoundError);
  });

  it('routes to the failure transport (with error + failure stamps) and returns, when retries are exhausted', async () => {
    const failure = new FakeSender();
    const senders = new FakeSendersLocator(new Map(), new Map([['failed', failure]]));
    const middleware = new RetryMiddleware(new StubStrategy(false), senders, {
      failureTransport: 'failed',
    });
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));
    const handlerError = new HandlerFailedError(envelope, new Error('smtp down'));

    // Returns normally (no throw) so the worker acks the original message.
    await expect(middleware.handle(envelope, rejectingStack(handlerError))).resolves.toBeDefined();

    expect(failure.sent).toHaveLength(1);
    expect(failure.sent[0]?.last(ErrorDetailsStamp)?.exceptionMessage).toBe('smtp down');
    expect(failure.sent[0]?.last(SentToFailureTransportStamp)?.originalReceiverName).toBe('async');
  });

  it('strips the leftover DelayStamp so the dead-lettered message is immediately available', async () => {
    const failure = new FakeSender();
    const senders = new FakeSendersLocator(new Map(), new Map([['failed', failure]]));
    const middleware = new RetryMiddleware(new StubStrategy(false), senders, {
      failureTransport: 'failed',
    });
    // The last retry left a DelayStamp on the envelope; it must NOT carry over to the
    // failure transport, or the message would sit in the transport's delayed buffer and
    // never surface to messenger:failed:show. (Regression: found by the M7 e2e.)
    const envelope = new Envelope(new TestMessage('m-1'))
      .with(new ReceivedStamp('async'))
      .with(new DelayStamp(5000));

    await middleware.handle(
      envelope,
      rejectingStack(new HandlerFailedError(envelope, new Error('boom'))),
    );

    expect(failure.sent[0]?.last(DelayStamp)).toBeUndefined();
  });

  it('drops the message (returns without sending) when exhausted and no failure transport is configured', async () => {
    const middleware = new RetryMiddleware(new StubStrategy(false), new FakeSendersLocator());
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));
    const handlerError = new HandlerFailedError(envelope, new Error('boom'));

    await expect(middleware.handle(envelope, rejectingStack(handlerError))).resolves.toBe(envelope);
  });

  it('falls back to the wrapper error when the handler failure carries no underlying cause', async () => {
    const failure = new FakeSender();
    const senders = new FakeSendersLocator(new Map(), new Map([['failed', failure]]));
    const middleware = new RetryMiddleware(new StubStrategy(false), senders, {
      failureTransport: 'failed',
    });
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));
    // A genuinely absent cause (no `undefined`/`null` literal), as if a handler threw a nullish value.
    const noCause = new Map<string, unknown>().get('absent');
    const handlerError = new HandlerFailedError(envelope, noCause);

    await middleware.handle(envelope, rejectingStack(handlerError));

    expect(failure.sent[0]?.last(ErrorDetailsStamp)?.exceptionClass).toBe('HandlerFailedError');
  });

  it('fails loudly with TransportNotFoundError when the configured failure transport is unknown', async () => {
    const middleware = new RetryMiddleware(new StubStrategy(false), new FakeSendersLocator(), {
      failureTransport: 'failed',
    });
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));
    const handlerError = new HandlerFailedError(envelope, new Error('boom'));

    await expect(middleware.handle(envelope, rejectingStack(handlerError))).rejects.toBeInstanceOf(
      TransportNotFoundError,
    );
  });
});
