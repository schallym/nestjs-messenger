import type { Stamp } from './stamp';

/**
 * Records that an envelope was sent to a transport, capturing the sender class and
 * the routing alias it was matched under. Added by `SendMessageMiddleware` (which
 * knows the alias), one per destination when a message routes to several transports.
 */
export class SentStamp implements Stamp {
  constructor(
    public readonly senderClass: string,
    public readonly senderAlias?: string,
  ) {}
}
