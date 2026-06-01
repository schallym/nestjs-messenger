import type { Stamp } from './stamp';

/** Marks that an envelope was pulled from a transport. Carries the origin transport name. */
export class ReceivedStamp implements Stamp {
  constructor(public readonly transportName: string) {}
}
