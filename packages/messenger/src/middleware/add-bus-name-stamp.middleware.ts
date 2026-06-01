import type { Envelope } from '../envelope';
import { BusNameStamp } from '../stamps';
import type { Middleware, StackInterface } from './middleware.interface';

/**
 * Tags the envelope with the bus name (we may run multiple buses). Idempotent: a
 * redelivered envelope that already carries a {@link BusNameStamp} is left untouched.
 */
export class AddBusNameStampMiddleware implements Middleware {
  constructor(private readonly busName: string) {}

  handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    const stamped =
      envelope.last(BusNameStamp) === undefined
        ? envelope.with(new BusNameStamp(this.busName))
        : envelope;
    return next().handle(stamped, next);
  }
}
