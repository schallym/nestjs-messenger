import type { Envelope } from '../envelope';
import { TransportError, TransportNotFoundError } from '../errors';
import {
  ErrorDetailsStamp,
  ReceivedStamp,
  RedeliveryStamp,
  SentToFailureTransportStamp,
  TransportMessageIdStamp,
} from '../stamps';
import type { ListableReceiver, MessageRetriever } from './capabilities';
import type { SendersLocator } from './senders-locator';
import type { Receiver } from './transport.interface';

/**
 * What the failure CLI needs from a transport: enumerate (`list`), look up (`find`), and
 * acknowledge — which, post-M7, *removes* — a message (`ack`). It deliberately does not
 * require the consume half (`get`/`reject`); the manager never pulls or nacks.
 */
export type FailureTransport = Pick<Receiver, 'ack'> & ListableReceiver & MessageRetriever;

/** A human-readable view of one dead-lettered message, for `messenger:failed:show`. */
export interface FailedMessageView {
  readonly id: string;
  readonly messageType: string;
  readonly error: string | undefined;
  readonly errorClass: string | undefined;
  readonly redeliveryCount: number;
  readonly failedAt: Date | undefined;
  readonly originalTransport: string | undefined;
}

function toFailedMessageView(envelope: Envelope, id: string): FailedMessageView {
  const errorDetails = envelope.last(ErrorDetailsStamp);
  const redelivery = envelope.last(RedeliveryStamp);
  return {
    id,
    messageType: envelope.message.constructor.name,
    error: errorDetails?.exceptionMessage,
    errorClass: errorDetails?.exceptionClass,
    redeliveryCount: redelivery?.retryCount ?? 0,
    // `redeliveredAt` is a Date in-process but arrives as an ISO string after a transport's
    // JSON round-trip; normalise to a real Date so consumers can rely on the type.
    failedAt: redelivery === undefined ? undefined : new Date(redelivery.redeliveredAt),
    originalTransport: envelope.last(SentToFailureTransportStamp)?.originalReceiverName,
  };
}

function transportMessageId(envelope: Envelope): string {
  const stamp = envelope.last(TransportMessageIdStamp);
  if (stamp === undefined) {
    throw new TransportError('A failure-transport message has no TransportMessageIdStamp.');
  }
  return String(stamp.id);
}

/**
 * Operates the failure transport for the `messenger:failed:*` CLI: list the
 * dead-lettered messages, retry one (re-send to its origin transport with a fresh
 * retry budget, then remove it), retry all, or remove one. Framework-agnostic — the
 * CLI commands are thin wrappers.
 */
export class FailedMessageManager {
  constructor(
    private readonly failureTransport: FailureTransport,
    private readonly senders: SendersLocator,
  ) {}

  async list(limit?: number): Promise<FailedMessageView[]> {
    const views: FailedMessageView[] = [];
    for await (const envelope of this.failureTransport.list(limit)) {
      views.push(toFailedMessageView(envelope, transportMessageId(envelope)));
    }
    return views;
  }

  /** View a single dead-lettered message by id (a targeted `find`, not a full scan). */
  async view(id: string): Promise<FailedMessageView | undefined> {
    const envelope = await this.failureTransport.find(id);
    return envelope === undefined
      ? undefined
      : toFailedMessageView(envelope, transportMessageId(envelope));
  }

  /** Re-send a failed message to its origin transport with a fresh budget, then remove it. */
  async retry(id: string): Promise<boolean> {
    const envelope = await this.failureTransport.find(id);
    if (envelope === undefined) {
      return false;
    }
    await this.resendToOrigin(envelope);
    await this.failureTransport.ack(envelope);
    return true;
  }

  /** Retry every dead-lettered message. Returns how many were retried. */
  async retryAll(): Promise<number> {
    const envelopes: Envelope[] = [];
    for await (const envelope of this.failureTransport.list()) {
      envelopes.push(envelope);
    }
    for (const envelope of envelopes) {
      await this.resendToOrigin(envelope);
      await this.failureTransport.ack(envelope);
    }
    return envelopes.length;
  }

  /** Discard a failed message without retrying it. */
  async remove(id: string): Promise<boolean> {
    const envelope = await this.failureTransport.find(id);
    if (envelope === undefined) {
      return false;
    }
    await this.failureTransport.ack(envelope);
    return true;
  }

  private async resendToOrigin(envelope: Envelope): Promise<void> {
    const origin = envelope.last(SentToFailureTransportStamp)?.originalReceiverName;
    if (origin === undefined) {
      throw new TransportError(
        'Cannot retry: the failed message has no SentToFailureTransportStamp.',
      );
    }
    const sender = this.senders.getSenderByAlias(origin);
    if (sender === undefined) {
      throw new TransportNotFoundError(`Cannot retry: no transport registered under "${origin}".`);
    }
    // Reset to a fresh delivery: drop the failure/retry bookkeeping; the origin
    // transport re-stamps TransportMessageIdStamp on send.
    const retryable = envelope
      .withoutAll(RedeliveryStamp)
      .withoutAll(ErrorDetailsStamp)
      .withoutAll(SentToFailureTransportStamp)
      .withoutAll(ReceivedStamp)
      .withoutAll(TransportMessageIdStamp);
    await sender.send(retryable);
  }
}
