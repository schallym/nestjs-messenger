import type { Envelope } from '../envelope';
import { HandlerFailedError, TransportNotFoundError } from '../errors';
import type { Middleware, StackInterface } from '../middleware';
import {
  DelayStamp,
  ErrorDetailsStamp,
  ReceivedStamp,
  RedeliveryStamp,
  SentToFailureTransportStamp,
} from '../stamps';
import type { Sender, SendersLocator } from '../transport';
import type { RetryStrategy } from './retry-strategy.interface';

export interface RetryMiddlewareOptions {
  /** Alias of the transport that exhausted retries are routed to, if any. */
  readonly failureTransport?: string;
}

/**
 * Applies the retry policy to handler failures (the model decided in ADR-004): retry
 * according to the configured strategy, then push to the failure queue.
 *
 * Only {@link HandlerFailedError} (an application error) is handled; transport and
 * serialization errors propagate untouched so the worker can reject and let the
 * transport recover.
 *
 * On a retryable failure the envelope is re-sent to its origin transport with an
 * incremented {@link RedeliveryStamp} and a {@link DelayStamp}. Once the budget is
 * exhausted it is routed to the failure transport (if configured) carrying an
 * {@link ErrorDetailsStamp} and a {@link SentToFailureTransportStamp}. In all of
 * these cases the middleware **returns normally** so the worker acks the original —
 * the message has been dealt with. With no failure transport configured, an exhausted
 * message is dropped (returned, then acked). The worker only rejects when this
 * middleware re-throws, which it does solely for infrastructure errors.
 */
export class RetryMiddleware implements Middleware {
  constructor(
    private readonly strategy: RetryStrategy,
    private readonly senders: SendersLocator,
    private readonly options: RetryMiddlewareOptions = {},
  ) {}

  async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    try {
      return await next().handle(envelope, next);
    } catch (error) {
      if (!(error instanceof HandlerFailedError)) {
        throw error;
      }
      return this.onHandlerFailed(envelope, error);
    }
  }

  private async onHandlerFailed(envelope: Envelope, error: HandlerFailedError): Promise<Envelope> {
    const received = envelope.last(ReceivedStamp);
    if (received === undefined) {
      throw error; // synchronous dispatch: there is no origin transport to retry against
    }
    if (this.strategy.isRetryable(envelope, error)) {
      return this.resendForRetry(envelope, received.transportName);
    }
    return this.sendToFailureTransport(envelope, received.transportName, error);
  }

  private resendForRetry(envelope: Envelope, transportName: string): Promise<Envelope> {
    const attempt = (envelope.last(RedeliveryStamp)?.retryCount ?? 0) + 1;
    const delay = this.strategy.getWaitingTime(envelope);
    const retried = envelope.with(new RedeliveryStamp(attempt), new DelayStamp(delay));
    return this.requireSender(transportName).send(retried);
  }

  private async sendToFailureTransport(
    envelope: Envelope,
    originalReceiver: string,
    error: HandlerFailedError,
  ): Promise<Envelope> {
    const { failureTransport } = this.options;
    if (failureTransport === undefined) {
      return envelope; // retries exhausted, no failure transport: the worker acks (message dropped)
    }
    // A configured-but-unresolvable alias is a wiring bug — fail loudly rather than
    // silently dropping the message the failure transport exists to keep.
    // Strip the DelayStamp left over from the last retry: a dead-lettered message must
    // be immediately available in the failure transport (otherwise it would sit in the
    // transport's delayed buffer and never surface to `messenger:failed:show`/`list`).
    const failureEnvelope = envelope
      .withoutAll(DelayStamp)
      .with(ErrorDetailsStamp.create(error.cause ?? error))
      .with(new SentToFailureTransportStamp(originalReceiver));
    return this.requireSender(failureTransport).send(failureEnvelope);
  }

  private requireSender(alias: string): Sender {
    const sender = this.senders.getSenderByAlias(alias);
    if (sender === undefined) {
      throw new TransportNotFoundError(`No transport registered under alias "${alias}".`);
    }
    return sender;
  }
}
