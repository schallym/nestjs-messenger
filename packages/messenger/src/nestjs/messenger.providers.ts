import type { Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { MessageBus } from '../bus';
import { HandlerRegistry } from '../handler/registry';
import type { Middleware } from '../middleware';
import { MultiplierRetryStrategy, type RetryStrategy } from '../retry';
import { RoutingSendersLocator, type SendersLocator, type TransportInterface } from '../transport';
import type { MessengerModuleOptions, TransportFactory } from './messenger.options';
import {
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
  MESSENGER_TRANSPORTS,
} from './messenger.tokens';
import { assembleMiddlewarePipeline } from './pipeline.factory';

function instantiateTransport(
  definition: TransportInterface | TransportFactory,
): TransportInterface {
  return typeof definition === 'function' ? definition() : definition;
}

function buildTransports(options: MessengerModuleOptions): Map<string, TransportInterface> {
  const transports = new Map<string, TransportInterface>();
  for (const [name, definition] of Object.entries(options.transports ?? {})) {
    transports.set(name, instantiateTransport(definition));
  }
  return transports;
}

function buildRouting(options: MessengerModuleOptions): Map<string, readonly string[]> {
  const routing = new Map<string, readonly string[]>();
  for (const [messageName, aliases] of Object.entries(options.routing ?? {})) {
    routing.set(messageName, aliases);
  }
  return routing;
}

function resolveUserMiddlewares(
  options: MessengerModuleOptions,
  moduleRef: ModuleRef,
): Middleware[] {
  return (options.middlewares ?? []).map((middleware) =>
    moduleRef.get<Middleware>(middleware, { strict: false }),
  );
}

function busFactory(
  options: MessengerModuleOptions,
  handlers: HandlerRegistry,
  sendersLocator: SendersLocator,
  moduleRef: ModuleRef,
): MessageBus {
  const retryStrategy: RetryStrategy | undefined =
    options.retry === undefined ? undefined : new MultiplierRetryStrategy(options.retry);

  return new MessageBus(
    assembleMiddlewarePipeline({
      busName: options.busName ?? 'default',
      userMiddlewares: resolveUserMiddlewares(options, moduleRef),
      sendersLocator,
      handlers,
      retryStrategy,
      failureTransport: options.failureTransport,
      allowNoHandlers: options.allowNoHandlers ?? false,
    }),
  );
}

/** The transport-agnostic core providers shared by `forRoot` and `forRootAsync`. */
export function createCoreProviders(): Provider[] {
  return [
    { provide: HandlerRegistry, useFactory: () => new HandlerRegistry() },
    {
      provide: MESSENGER_TRANSPORTS,
      useFactory: buildTransports,
      inject: [MESSENGER_OPTIONS],
    },
    {
      provide: MESSENGER_SENDERS_LOCATOR,
      useFactory: (transports: Map<string, TransportInterface>, options: MessengerModuleOptions) =>
        new RoutingSendersLocator(transports, buildRouting(options)),
      inject: [MESSENGER_TRANSPORTS, MESSENGER_OPTIONS],
    },
    {
      provide: MessageBus,
      useFactory: busFactory,
      inject: [MESSENGER_OPTIONS, HandlerRegistry, MESSENGER_SENDERS_LOCATOR, ModuleRef],
    },
  ];
}
