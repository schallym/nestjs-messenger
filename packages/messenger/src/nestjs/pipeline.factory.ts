import type { HandlersLocator } from '../handler/registry';
import {
  AddBusNameStampMiddleware,
  FailedMessageProcessingMiddleware,
  HandleMessageMiddleware,
  SendMessageMiddleware,
  type Middleware,
} from '../middleware';
import { RetryMiddleware, type RetryStrategy } from '../retry';
import type { SendersLocator } from '../transport';

export interface PipelineParts {
  readonly busName: string;
  readonly userMiddlewares: readonly Middleware[];
  readonly sendersLocator: SendersLocator;
  readonly handlers: HandlersLocator;
  readonly retryStrategy: RetryStrategy | undefined;
  readonly failureTransport: string | undefined;
  readonly allowNoHandlers: boolean;
}

/**
 * Assembles the canonical middleware order (mirrors Symfony Messenger, minus the
 * deferred RejectRedelivered/DispatchAfterCurrentBus stages):
 *
 *   AddBusNameStamp → FailedMessageProcessing → [user] → SendMessage → [Retry] → HandleMessage
 *
 * Retry is wired in only when a retry policy is configured (see ADR-004 for why retry
 * lives in a middleware here rather than the worker).
 */
export function assembleMiddlewarePipeline(parts: PipelineParts): Middleware[] {
  const middlewares: Middleware[] = [
    new AddBusNameStampMiddleware(parts.busName),
    new FailedMessageProcessingMiddleware(),
    ...parts.userMiddlewares,
    new SendMessageMiddleware(parts.sendersLocator),
  ];

  if (parts.retryStrategy !== undefined) {
    const options =
      parts.failureTransport === undefined ? {} : { failureTransport: parts.failureTransport };
    middlewares.push(new RetryMiddleware(parts.retryStrategy, parts.sendersLocator, options));
  }

  middlewares.push(new HandleMessageMiddleware(parts.handlers, parts.allowNoHandlers));
  return middlewares;
}
