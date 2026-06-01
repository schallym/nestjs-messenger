import { Envelope } from '../envelope';
import { MiddlewareStack } from '../middleware';
import type { Middleware } from '../middleware';
import type { Stamp } from '../stamps';

/**
 * Orchestrates dispatch through the configured middleware pipeline. The bus itself
 * is intentionally thin: it wraps the message in an {@link Envelope} and runs the
 * middlewares. Assembling the canonical middleware order is the configuration
 * layer's job (the NestJS module in M4), not the bus's.
 */
export class MessageBus {
  constructor(private readonly middlewares: readonly Middleware[]) {}

  /**
   * Dispatch a message (or a pre-built envelope) through the pipeline. Returns the
   * envelope with every stamp the pipeline added.
   */
  dispatch(message: object | Envelope, stamps: readonly Stamp[] = []): Promise<Envelope> {
    return new MiddlewareStack(this.middlewares).run(Envelope.wrap(message, stamps));
  }
}
