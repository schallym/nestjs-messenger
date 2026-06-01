import type { Envelope } from '../envelope';

/** A message class, used as the routing/lookup key. Any concrete class qualifies. */
export type MessageClass<T extends object = object> = abstract new (...args: never[]) => T;

/**
 * A handler bound to a message type. `handle` invokes the user's handler with the
 * message; `name` identifies it for the {@link HandledStamp} and redelivery dedup.
 */
export interface HandlerDescriptor {
  readonly handle: (message: object) => unknown;
  readonly name: string;
}

/** Resolves the handlers registered for a given message. */
export interface HandlersLocator {
  getHandlers(envelope: Envelope): Iterable<HandlerDescriptor>;
}

/**
 * In-memory, framework-agnostic handler registry. The NestJS adapter (M4) builds
 * descriptors from discovered providers and registers them here; nothing in this
 * file knows about NestJS.
 */
export class HandlerRegistry implements HandlersLocator {
  private readonly handlers = new Map<MessageClass, HandlerDescriptor[]>();

  register<T extends object>(messageType: MessageClass<T>, handler: HandlerDescriptor): void {
    const existing = this.handlers.get(messageType);
    if (existing === undefined) {
      this.handlers.set(messageType, [handler]);
    } else {
      existing.push(handler);
    }
  }

  getHandlers(envelope: Envelope): readonly HandlerDescriptor[] {
    const messageType = envelope.message.constructor as MessageClass;
    return this.handlers.get(messageType) ?? [];
  }
}
