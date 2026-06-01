import type { Stamp } from './stamp';

/** The transport's native identifier for a message (e.g. a Redis stream entry id). */
export class TransportMessageIdStamp implements Stamp {
  constructor(public readonly id: string | number) {}
}
