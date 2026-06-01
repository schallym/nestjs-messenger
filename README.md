# nestjs-messenger

**Symfony Messenger's developer experience, native to NestJS.** A unified message bus
with pluggable transports, a middleware pipeline, an envelope/stamps system, retry
strategies with backoff, a failure transport, and a `consume` worker CLI.

If you've used [Symfony Messenger](https://symfony.com/doc/current/messenger.html), you
already know this library. If you've wired BullMQ by hand, this is the coherent
abstraction you were building piecemeal — see the
[migration guide](docs/migration-from-bullmq.md).

```bash
# pnpm
pnpm add @schally/nestjs-messenger @schally/nestjs-messenger-transport-redis
# npm
npm install @schally/nestjs-messenger @schally/nestjs-messenger-transport-redis
```

> No `bullmq`. No separate `core` package. One main package plus the transport you need.
> The Redis transport speaks **Redis Streams** directly (see
> [ADR-003](docs/ADR-003-redis-streams-not-bullmq.md)).

---

## The mental model in one paragraph

A `MessageBus` accepts plain class instances. A configurable middleware pipeline decides
what to do with them — usually sending them to a named **transport** (a Redis stream
today; RabbitMQ, SQL, or Pub/Sub later). A **worker** process pulls messages from a
transport, runs them through the same pipeline in receive mode, and calls a registered
**handler**. Failures retry with backoff, then land in a **failure transport** for human
attention. Everything is a class instance — messages, handlers, middlewares, stamps
(metadata) — so it's all typed and DI-friendly.

---

## Quickstart

Readable in 5 minutes, runnable in 10. This mirrors Symfony Messenger's quickstart:
define a message, write a handler, route it, dispatch it, run the worker.

### 1. Define a message

Messages are plain classes — no decorators, no base class. The class reference is the
runtime identity used for routing and handler discovery.

```ts
// src/messages/send-welcome-email.message.ts
export class SendWelcomeEmailMessage {
  constructor(
    public readonly userId: string,
    public readonly email: string,
  ) {}
}
```

### 2. Write a handler

Handlers are NestJS providers decorated with `@MessageHandler(MessageClass)`. They get
full NestJS DI. Throwing from `handle()` drives the retry pipeline.

```ts
// src/handlers/send-welcome-email.handler.ts
import { Injectable, Logger } from '@nestjs/common';
import { MessageHandler, type MessageHandlerInterface } from '@schally/nestjs-messenger';
import { SendWelcomeEmailMessage } from '../messages/send-welcome-email.message';

@Injectable()
@MessageHandler(SendWelcomeEmailMessage)
export class SendWelcomeEmailHandler
  implements MessageHandlerInterface<SendWelcomeEmailMessage>
{
  private readonly logger = new Logger(SendWelcomeEmailHandler.name);

  async handle(message: SendWelcomeEmailMessage): Promise<void> {
    // ...send the email... throwing here triggers retry, then the failure transport.
    this.logger.log(`Welcome email sent to ${message.email} (user ${message.userId})`);
  }
}
```

### 3. Configure the module

Transports are passed as **instances or factories** (`() => Transport`). `routing` binds
message classes to transport aliases. A message routed nowhere is handled **synchronously**
during `dispatch()`.

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { JsonSerializer, MessengerModule } from '@schally/nestjs-messenger';
import { RedisStreamsTransport } from '@schally/nestjs-messenger-transport-redis';
import { SendWelcomeEmailHandler } from './handlers/send-welcome-email.handler';
import { SendWelcomeEmailMessage } from './messages/send-welcome-email.message';

@Module({
  imports: [
    MessengerModule.forRoot({
      transports: {
        async: () =>
          new RedisStreamsTransport({
            dsn: 'redis://localhost:6379',
            name: 'async', // MUST equal the routing alias so retries find the origin
            stream: 'messenger:async',
            // Register your message classes so the worker can reconstruct them on receive.
            serializer: new JsonSerializer([SendWelcomeEmailMessage]),
          }),
        failed: () =>
          new RedisStreamsTransport({
            dsn: 'redis://localhost:6379',
            name: 'failed',
            stream: 'messenger:failed',
            serializer: new JsonSerializer([SendWelcomeEmailMessage]),
          }),
      },
      routing: {
        [SendWelcomeEmailMessage.name]: ['async'],
      },
      // Backoff: 1s, 2s, 4s (multiplier 2), capped at 60s, ±10% jitter by default.
      retry: { maxRetries: 3, delayMs: 1000, multiplier: 2, maxDelayMs: 60_000 },
      // Exhausted retries land here for inspection with messenger:failed:show.
      failureTransport: 'failed',
    }),
  ],
  providers: [SendWelcomeEmailHandler],
})
export class AppModule {}
```

Config that depends on other providers? Use `MessengerModule.forRootAsync({ imports, inject, useFactory })`.

### 4. Dispatch

Inject `MessageBus` anywhere. `dispatch()` resolves once the message is **on the
transport**, not once it's handled.

```ts
// src/users/users.service.ts
import { Injectable } from '@nestjs/common';
import { MessageBus } from '@schally/nestjs-messenger';
import { SendWelcomeEmailMessage } from '../messages/send-welcome-email.message';

@Injectable()
export class UsersService {
  constructor(private readonly bus: MessageBus) {}

  async register(userId: string, email: string): Promise<void> {
    // ...persist the user...
    await this.bus.dispatch(new SendWelcomeEmailMessage(userId, email));
  }
}
```

### 5. Run the worker

Wire the CLI commands (from the `@schally/nestjs-messenger/cli` subpath, which pulls in
`nest-commander`) into a small entrypoint:

```ts
// src/cli.ts
import { Module } from '@nestjs/common';
import { CommandFactory } from 'nest-commander';
import {
  ConsumeCommand,
  FailedRemoveCommand,
  FailedRetryCommand,
  FailedShowCommand,
} from '@schally/nestjs-messenger/cli';
import { AppModule } from './app.module';

@Module({
  imports: [AppModule],
  providers: [ConsumeCommand, FailedShowCommand, FailedRetryCommand, FailedRemoveCommand],
})
class CliModule {}

await CommandFactory.run(CliModule);
```

```bash
# Drain the `async` transport, processing up to 100 messages then exiting
# (a supervisor — PM2, systemd, k8s — restarts it for a fresh memory state).
node dist/cli messenger:consume async --limit=100 --memory-limit=128M

# Or bound by wall-clock time:
node dist/cli messenger:consume async --time-limit=3600
```

`--limit`, `--memory-limit`, and `--time-limit` match Symfony Messenger exactly: workers
are short-lived, supervisors restart them, memory leaks can't accumulate. `SIGTERM` /
`SIGINT` trigger a graceful shutdown — the in-flight message finishes first.

### 6. Inspect and retry failures

When retries are exhausted, the message lands in the failure transport:

```bash
node dist/cli messenger:failed:show            # table of dead-lettered messages
node dist/cli messenger:failed:show 1718-0     # one message in detail + the error
node dist/cli messenger:failed:retry 1718-0    # re-enqueue to its origin transport
node dist/cli messenger:failed:remove 1718-0   # discard it
node dist/cli messenger:failed:remove --all    # discard everything
```

`failed:retry` re-enqueues the message onto its **origin** transport with a fresh retry
budget; a normal worker reprocesses it (see [ADR-005](docs/ADR-005-failed-retry-reenqueue.md)).

---

## Custom middleware

Logging, DB transactions, OpenTelemetry spans, idempotency — write a middleware. It runs
in **both** directions (send and receive); the `ReceivedStamp` tells you which side you're on.

```ts
import { Injectable, Logger } from '@nestjs/common';
import {
  type Envelope,
  type Middleware,
  ReceivedStamp,
  type StackInterface,
} from '@schally/nestjs-messenger';

@Injectable()
export class LoggingMiddleware implements Middleware {
  private readonly logger = new Logger('Messenger');

  async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    const direction = envelope.last(ReceivedStamp) ? 'receive' : 'send';
    this.logger.log(`[${direction}] ${envelope.message.constructor.name}`);
    return next().handle(envelope, next);
  }
}
```

Register it with `MessengerModule.forRoot({ middlewares: [LoggingMiddleware], ... })`. It
is inserted between the framing and send stages of the canonical pipeline:

```
AddBusNameStamp → FailedMessageProcessing → [your middlewares] → SendMessage → [Retry] → HandleMessage
```

See the [middleware-design skill](.claude/skills/middleware-design/SKILL.md) for the
onion model and stamp-manipulation rules.

---

## Packages

| Package | What it is |
|---|---|
| [`@schally/nestjs-messenger`](packages/messenger) | The bus, pipeline, envelope/stamps, retry, failure transport, NestJS module, in-memory transport, conformance suite, and CLI. |
| [`@schally/nestjs-messenger-transport-redis`](packages/transport-redis) | The reference transport, built on **Redis Streams** (`ioredis`, not BullMQ). |

Subpath exports: `@schally/nestjs-messenger` (core + NestJS), `…/cli` (worker + failure
commands), `…/testing` (`runTransportConformanceTests`, `ConformanceMessage`).

---

## Core vocabulary

- **Message** — a plain class describing intent.
- **Envelope** — a message + its **stamps** (typed metadata).
- **Stamp** — `BusNameStamp`, `SentStamp`, `ReceivedStamp`, `TransportMessageIdStamp`,
  `DelayStamp`, `RedeliveryStamp`, `HandledStamp`, `ErrorDetailsStamp`,
  `SentToFailureTransportStamp`.
- **MessageBus / Middleware** — dispatch orchestration through a composable pipeline.
- **Transport (Sender / Receiver)** — pluggable backend that persists and delivers envelopes.
- **Worker** — the loop that pulls from a receiver and dispatches.
- **Routing** — config mapping a message class to transport alias(es).

---

## Examples & docs

- [`examples/basic-nest-app`](examples/basic-nest-app) — the NestJS integration end to end (in-memory transport).
- [`examples/quickstart`](examples/quickstart) — a fuller e-commerce scenario on Redis.
- [`docs/migration-from-bullmq.md`](docs/migration-from-bullmq.md) — for teams coming from BullMQ.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestones M0→M8.
- ADRs: [single package](docs/ADR-001-single-package.md) ·
  [coverage policy](docs/ADR-002-coverage-policy.md) ·
  [Redis Streams not BullMQ](docs/ADR-003-redis-streams-not-bullmq.md) ·
  [retry as middleware](docs/ADR-004-retry-as-middleware.md) ·
  [failed:retry re-enqueue](docs/ADR-005-failed-retry-reenqueue.md).

---

## Local development

Requires Node 24 (see `.nvmrc`) and pnpm (pinned via `packageManager`).

```bash
pnpm install            # install the workspace
pnpm build              # build all packages (turbo + tsc project references)
pnpm lint               # eslint (flat config + import boundaries) + prettier
pnpm test:coverage      # unit tests with the differentiated coverage gates
pnpm dev:brokers        # start the docker-compose brokers for e2e/local dev
pnpm test:e2e           # e2e scenarios (needs brokers up)
```

Transports are validated against a shared conformance suite (12 scenarios) run against a
**real** Redis. Coverage is enforced per [ADR-002](docs/ADR-002-coverage-policy.md): 100%
on framework-agnostic modules, 95%/90% on integration glue.

---

## Status & compatibility

**v0.1.0.** Requires NestJS 10+ and Node 24+. The Redis transport requires Redis 6.2+
(it uses `XAUTOCLAIM`). RabbitMQ, SQL, and Google Pub/Sub transports are planned for v0.2.

## License

MIT.

---

Made with ❤️ by [schallym](https://github.com/schallym) and [contributors](https://github.com/schallym/nestjs-messenger/graphs/contributors).

