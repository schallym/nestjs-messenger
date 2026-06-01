import type { Envelope } from '../envelope';
import { ReceivedStamp, SentToFailureTransportStamp } from '../stamps';
import type { Middleware, StackInterface } from './middleware.interface';

/**
 * Special handling when a message is reprocessed from the failure transport. The
 * envelope carries a {@link SentToFailureTransportStamp} naming its original
 * receiver; this middleware swaps the failure transport's {@link ReceivedStamp} for
 * the original one, so downstream retry/handling behaves as if it came from there.
 *
 * For a message not coming from the failure transport, it is a no-op passthrough.
 */
export class FailedMessageProcessingMiddleware implements Middleware {
  handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    const stamp = envelope.last(SentToFailureTransportStamp);
    if (stamp === undefined) {
      return next().handle(envelope, next);
    }

    const restored = envelope
      .withoutAll(ReceivedStamp)
      .with(new ReceivedStamp(stamp.originalReceiverName));
    return next().handle(restored, next);
  }
}
