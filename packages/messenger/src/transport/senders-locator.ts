import type { Envelope } from '../envelope';
import type { Sender } from './transport.interface';

/**
 * Resolves where a message is sent. `getSenders` applies the routing config to a
 * message (one entry per destination, by alias); `getSenderByAlias` looks a single
 * sender up by name, used to re-send to a message's origin transport on retry and
 * to reach the configured failure transport.
 */
export interface SendersLocator {
  getSenders(envelope: Envelope): Iterable<readonly [string, Sender]>;
  getSenderByAlias(alias: string): Sender | undefined;
}
