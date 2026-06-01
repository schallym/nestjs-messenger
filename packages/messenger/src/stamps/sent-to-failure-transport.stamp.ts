import type { Stamp } from './stamp';

/**
 * Marks that an envelope was routed to the failure transport, recording the name of the
 * transport it originally came from. `messenger:failed:retry` reads this so
 * {@link FailedMessageManager.retry} can re-enqueue the message onto its origin transport
 * (see ADR-005). `FailedMessageProcessingMiddleware` also consumes it, but only in the
 * deferred in-worker retry model; it is not on the CLI re-enqueue path.
 */
export class SentToFailureTransportStamp implements Stamp {
  constructor(public readonly originalReceiverName: string) {}
}
