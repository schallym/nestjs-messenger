import type { FactoryProvider, ModuleMetadata, Type } from '@nestjs/common';
import type { Middleware } from '../middleware';
import type { MultiplierRetryStrategyOptions } from '../retry';
import type { TransportInterface } from '../transport';

/** Lazily creates a transport instance. Lets the broker connection open at module init. */
export type TransportFactory = () => TransportInterface;

export interface MessengerModuleOptions {
  /**
   * Named transports, as instances or factories. Until a broker transport package is
   * installed, the in-process {@link InMemoryTransport} is the available implementation.
   */
  readonly transports?: Readonly<Record<string, TransportInterface | TransportFactory>>;

  /** Maps a message class name to the transport alias(es) it is sent to. */
  readonly routing?: Readonly<Record<string, readonly string[]>>;

  /** Retry policy. When omitted, failed handlers are not retried. */
  readonly retry?: MultiplierRetryStrategyOptions;

  /** Alias of the transport that exhausted retries are routed to. */
  readonly failureTransport?: string;

  /** User middlewares (NestJS providers), inserted between the framing and send stages. */
  readonly middlewares?: readonly Type<Middleware>[];

  /** Bus name stamped onto every envelope. Defaults to `default`. */
  readonly busName?: string;

  /** Allow messages with no registered handler to pass without error. Defaults to false. */
  readonly allowNoHandlers?: boolean;
}

export interface MessengerModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  // `never[]` params (not `unknown[]`) is deliberate: it is the no-`any` equivalent of
  // NestJS's own `FactoryProvider['useFactory']: (...args: any[]) => T`. It lets a user
  // factory with typed deps — `(config: ConfigService) => ...` — remain assignable
  // (param contravariance), which `unknown[]` would reject. Full inference of `inject`
  // against the factory params is a v0.2 ergonomics improvement.
  useFactory: (...args: never[]) => MessengerModuleOptions | Promise<MessengerModuleOptions>;
  inject?: FactoryProvider['inject'];
}
