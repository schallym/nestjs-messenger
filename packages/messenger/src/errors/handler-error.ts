import type { Envelope } from '../envelope';
import { MessengerError } from './messenger-error';

/** No handler is registered for the dispatched message type. */
export class HandlerNotFoundError extends MessengerError {}

/**
 * A handler threw while processing a message. Carries the envelope so the retry
 * pipeline can inspect its stamps, and the original error as `cause`.
 */
export class HandlerFailedError extends MessengerError {
  constructor(
    public readonly envelope: Envelope,
    cause: unknown,
  ) {
    super(HandlerFailedError.buildMessage(envelope, cause), { cause });
  }

  private static buildMessage(envelope: Envelope, cause: unknown): string {
    const messageName = envelope.message.constructor.name;
    const reason = cause instanceof Error ? cause.message : 'a non-Error value was thrown';
    return `Handling "${messageName}" failed: ${reason}`;
  }
}
