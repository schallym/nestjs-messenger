import 'reflect-metadata';
import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MessageBus } from '../bus';
import { HandlerDiscoveryService } from '../handler/discovery';
import { HandlerRegistry } from '../handler/registry';
import { MessengerTransportsLifecycle } from './messenger-transports.lifecycle';
import type { MessengerModuleAsyncOptions, MessengerModuleOptions } from './messenger.options';
import { createCoreProviders } from './messenger.providers';
import {
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
  MESSENGER_TRANSPORTS,
} from './messenger.tokens';

// Tokens the `messenger:*` CLI commands inject when registered in a consumer's command
// module: the transports map, the resolved options (for `failureTransport`), and the
// senders locator (so `failed:retry` can re-send to a message's origin transport).
const EXPORTED_PROVIDERS = [
  MessageBus,
  HandlerRegistry,
  MESSENGER_TRANSPORTS,
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
] as const;

/**
 * Wires the message bus, middleware pipeline, transports, and handler discovery into
 * NestJS DI. This module is glue: all behaviour lives in the framework-agnostic
 * modules it composes.
 */
@Module({})
export class MessengerModule {
  static forRoot(options: MessengerModuleOptions): DynamicModule {
    return {
      module: MessengerModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: MESSENGER_OPTIONS, useValue: options },
        // Register user middleware classes so the bus factory can resolve them by type.
        ...(options.middlewares ?? []),
        ...createCoreProviders(),
        HandlerDiscoveryService,
        MessengerTransportsLifecycle,
      ],
      exports: [...EXPORTED_PROVIDERS],
    };
  }

  static forRootAsync(options: MessengerModuleAsyncOptions): DynamicModule {
    return {
      module: MessengerModule,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: MESSENGER_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        ...createCoreProviders(),
        HandlerDiscoveryService,
        MessengerTransportsLifecycle,
      ],
      exports: [...EXPORTED_PROVIDERS],
    };
  }
}
