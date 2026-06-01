import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { InvalidArgumentError } from '../errors';
import { MESSAGE_HANDLER_METADATA } from '../nestjs/decorators';
import type { MessageClass } from './registry';
import { HandlerRegistry } from './registry';

interface HandlerInstance {
  handle(message: object): unknown;
}

/**
 * Bridges NestJS DI to the framework-agnostic {@link HandlerRegistry}. On boot it scans
 * every provider for the {@link MESSAGE_HANDLER_METADATA} set by `@MessageHandler`, and
 * registers a descriptor that delegates to the provider's `handle` method.
 */
@Injectable()
export class HandlerDiscoveryService implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: HandlerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      this.registerIfHandler(wrapper);
    }
  }

  private registerIfHandler(wrapper: InstanceWrapper): void {
    const instance: unknown = wrapper.instance;
    const metatype = wrapper.metatype;
    if (!instance || !metatype) {
      return;
    }
    const messageClass = this.reflector.get<MessageClass | undefined>(
      MESSAGE_HANDLER_METADATA,
      metatype,
    );
    if (messageClass === undefined) {
      return;
    }
    const handler = instance as Partial<HandlerInstance>;
    if (typeof handler.handle !== 'function') {
      throw new InvalidArgumentError(
        `Handler "${metatype.name}" is decorated with @MessageHandler but has no handle() method.`,
      );
    }
    const handle = handler.handle.bind(handler);
    this.registry.register(messageClass, { name: metatype.name, handle });
  }
}
