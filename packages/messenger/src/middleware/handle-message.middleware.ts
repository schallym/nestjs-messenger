import type { Envelope } from '../envelope';
import { HandlerFailedError, HandlerNotFoundError } from '../errors';
import type { HandlerDescriptor, HandlersLocator } from '../handler/registry';
import { HandledStamp } from '../stamps';
import type { Middleware, StackInterface } from './middleware.interface';

/**
 * Terminal of the pipeline: looks up the handler(s) for the message, invokes each,
 * and attaches a {@link HandledStamp} per handler.
 *
 * - Handlers that already ran (matching {@link HandledStamp}) are skipped, so a
 *   redelivered multi-handler message doesn't re-run the ones that succeeded.
 * - A throwing handler is wrapped in {@link HandlerFailedError} (the retry layer
 *   keys on that type). The first failure aborts the remaining handlers.
 * - With no handler and `allowNoHandlers` false, throws {@link HandlerNotFoundError}.
 */
export class HandleMessageMiddleware implements Middleware {
  constructor(
    private readonly handlers: HandlersLocator,
    private readonly allowNoHandlers = false,
  ) {}

  async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    const descriptors = [...this.handlers.getHandlers(envelope)];
    if (descriptors.length === 0 && !this.allowNoHandlers) {
      throw new HandlerNotFoundError(
        `No handler registered for message "${envelope.message.constructor.name}".`,
      );
    }

    let current = envelope;
    for (const descriptor of descriptors) {
      if (this.alreadyHandled(current, descriptor.name)) {
        continue;
      }
      current = await this.runHandler(current, descriptor);
    }
    return next().handle(current, next);
  }

  private async runHandler(envelope: Envelope, descriptor: HandlerDescriptor): Promise<Envelope> {
    try {
      const result = await descriptor.handle(envelope.message);
      return envelope.with(new HandledStamp(result, descriptor.name));
    } catch (error) {
      throw new HandlerFailedError(envelope, error);
    }
  }

  private alreadyHandled(envelope: Envelope, handlerName: string): boolean {
    return envelope.all(HandledStamp).some((stamp) => stamp.handlerName === handlerName);
  }
}
