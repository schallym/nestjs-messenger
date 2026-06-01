// Public API of @schally/nestjs-messenger. Anything not re-exported here is internal.
// Modules are added as milestones land (see docs/ROADMAP.md): M1 shipped the core
// primitives; M2 adds the bus, middleware pipeline, handler registry, and retry.
export * from './envelope';
export * from './stamps';
export * from './transport';
export * from './serializer';
export * from './errors';
export * from './bus';
export * from './middleware';
export * from './retry';
export { HandlerRegistry } from './handler/registry';
export type { HandlersLocator, HandlerDescriptor, MessageClass } from './handler/registry';
export * from './nestjs';
// The Worker is dependency-light (no nest-commander); the consume CLI command itself
// is published separately under `@schally/nestjs-messenger/cli`.
export { Worker, type WorkerLimits, type WorkerHooks, type WorkerStats } from './cli/worker';
