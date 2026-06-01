import type { Stamp } from './stamp';

/** Records that a handler ran, capturing its return value and a name to identify it. */
export class HandledStamp implements Stamp {
  constructor(
    public readonly result: unknown,
    public readonly handlerName: string,
  ) {}
}
