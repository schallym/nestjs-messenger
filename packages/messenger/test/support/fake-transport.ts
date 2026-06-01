import {
  type Envelope,
  type MessageClass,
  type Sender,
  type SendersLocator,
  TransportMessageIdStamp,
} from '../../src';

/** A {@link Sender} that records every envelope it is asked to send. */
export class FakeSender implements Sender {
  readonly sent: Envelope[] = [];

  constructor(private readonly id?: string | number) {}

  send(envelope: Envelope): Promise<Envelope> {
    this.sent.push(envelope);
    const stamped =
      this.id === undefined ? envelope : envelope.with(new TransportMessageIdStamp(this.id));
    return Promise.resolve(stamped);
  }
}

/**
 * A {@link SendersLocator} backed by two plain maps: one for routing a message
 * class to `[alias, sender]` destinations, one for resolving a sender by alias.
 */
export class FakeSendersLocator implements SendersLocator {
  constructor(
    private readonly routes: ReadonlyMap<
      MessageClass,
      readonly (readonly [string, Sender])[]
    > = new Map(),
    private readonly byAlias: ReadonlyMap<string, Sender> = new Map(),
  ) {}

  getSenders(envelope: Envelope): Iterable<readonly [string, Sender]> {
    return this.routes.get(envelope.message.constructor as MessageClass) ?? [];
  }

  getSenderByAlias(alias: string): Sender | undefined {
    return this.byAlias.get(alias);
  }
}
