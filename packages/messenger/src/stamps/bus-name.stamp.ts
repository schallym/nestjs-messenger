import type { Stamp } from './stamp';

/** Records which bus a message was dispatched on. Added by the bus before sending. */
export class BusNameStamp implements Stamp {
  constructor(public readonly busName: string) {}
}
