import type { Envelope } from '../envelope';
import type { SendersLocator } from './senders-locator';
import type { Sender } from './transport.interface';

/**
 * Resolves senders from a static routing table: message class name → transport
 * aliases. Pure logic (no framework), constructed by the configuration layer from
 * the module's `transports` and `routing` options.
 *
 * An alias in the routing table with no matching transport is skipped — routing a
 * message nowhere resolvable means it is handled synchronously by the pipeline.
 */
export class RoutingSendersLocator implements SendersLocator {
  constructor(
    private readonly senders: ReadonlyMap<string, Sender>,
    private readonly routing: ReadonlyMap<string, readonly string[]>,
  ) {}

  *getSenders(envelope: Envelope): IterableIterator<readonly [string, Sender]> {
    const aliases = this.routing.get(envelope.message.constructor.name) ?? [];
    for (const alias of aliases) {
      const sender = this.senders.get(alias);
      if (sender !== undefined) {
        yield [alias, sender];
      }
    }
  }

  getSenderByAlias(alias: string): Sender | undefined {
    return this.senders.get(alias);
  }
}
