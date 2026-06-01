import { SetMetadata } from '@nestjs/common';
import type { MessageClass } from '../../handler/registry';

/** Metadata key under which a handler provider records the message class it handles. */
export const MESSAGE_HANDLER_METADATA = 'nestjs-messenger:message-handler';

/** Optional contract a handler class can implement for type-checked `handle`. */
export interface MessageHandlerInterface<TMessage extends object = object> {
  handle(message: TMessage): unknown;
}

/**
 * Marks a NestJS provider as the handler for a message class. Discovered at boot and
 * registered into the core `HandlerRegistry`. The provider must expose a `handle(message)`
 * method (see {@link MessageHandlerInterface}).
 *
 * ```ts
 * @Injectable()
 * @MessageHandler(SendEmailMessage)
 * export class SendEmailHandler {
 *   async handle(message: SendEmailMessage): Promise<void> { ... }
 * }
 * ```
 */
export function MessageHandler<TMessage extends object>(
  message: MessageClass<TMessage>,
): ClassDecorator {
  return SetMetadata(MESSAGE_HANDLER_METADATA, message);
}
