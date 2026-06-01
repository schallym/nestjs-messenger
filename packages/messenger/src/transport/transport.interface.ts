import type { Envelope } from '../envelope';

/** The "send" half of a transport: where a message goes. */
export interface Sender {
  /** Send an envelope. MUST return a new envelope carrying SentStamp + TransportMessageIdStamp. */
  send(envelope: Envelope): Promise<Envelope>;
}

/** The "receive" half of a transport: where messages are pulled from and acknowledged. */
export interface Receiver {
  /**
   * Pull messages. MUST be cancellable via the AbortSignal and MUST yield envelopes
   * carrying ReceivedStamp + TransportMessageIdStamp.
   */
  get(signal: AbortSignal): AsyncIterable<Envelope>;

  /** Mark a message as successfully processed. MUST be idempotent. */
  ack(envelope: Envelope): Promise<void>;

  /** Mark a message as failed. The transport decides redelivery vs. drop. MUST be idempotent. */
  reject(envelope: Envelope): Promise<void>;
}

/**
 * A pluggable backend that persists and delivers envelopes. Handlers never see
 * which transport they are behind — the whole point of the abstraction.
 */
export interface TransportInterface extends Sender, Receiver {
  /** Release resources. MUST wait for in-flight ack/reject to settle before resolving. */
  close(): Promise<void>;
}
