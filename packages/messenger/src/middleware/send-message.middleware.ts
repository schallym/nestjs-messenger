import type { Envelope } from '../envelope';
import { ReceivedStamp, SentStamp } from '../stamps';
import type { SendersLocator } from '../transport';
import type { Middleware, StackInterface } from './middleware.interface';

/**
 * Routes a message to its configured transport(s) and short-circuits the pipeline.
 *
 * - If the envelope was received from a transport ({@link ReceivedStamp} present),
 *   it is NOT re-sent — the pipeline continues so the handler runs.
 * - If it is routed to one or more senders, it is sent to each (stamped with a
 *   {@link SentStamp} carrying the routing alias) and the pipeline stops there; the
 *   worker handles it later.
 * - If it is routed nowhere, the pipeline continues and the handler runs synchronously.
 */
export class SendMessageMiddleware implements Middleware {
  constructor(private readonly senders: SendersLocator) {}

  async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    if (envelope.last(ReceivedStamp) !== undefined) {
      return next().handle(envelope, next);
    }

    let current = envelope;
    let sent = false;
    for (const [alias, sender] of this.senders.getSenders(envelope)) {
      current = await sender.send(current.with(new SentStamp(sender.constructor.name, alias)));
      sent = true;
    }

    if (!sent) {
      return next().handle(current, next);
    }
    return current;
  }
}
