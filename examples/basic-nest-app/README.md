# Example: a basic NestJS app (M4)

This shows the **NestJS integration** delivered in milestone M4: `MessengerModule`,
the `@MessageHandler` decorator, handler discovery, routing, and dispatching through
the `MessageBus`.

At M4 there is no broker transport yet (Redis arrives in M6), so this example uses the
in-process `InMemoryTransport`. The module config accepts transport **instances or
factories**; once a broker package is installed you swap the instance for its DSN-based
transport without touching handlers.

> The worker that *consumes* asynchronously-routed messages lands in M5. Messages routed
> to no transport are handled synchronously during `dispatch()`, which is what this
> example exercises end to end today.

---

## 1. Define a message

```ts
// src/messages/send-welcome-email.message.ts
export class SendWelcomeEmailMessage {
  constructor(
    public readonly userId: string,
    public readonly email: string,
  ) {}
}
```

## 2. Define a handler

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
    // ...send the email...
    this.logger.log(`Welcome email queued for ${message.email} (user ${message.userId})`);
  }
}
```

The provider must expose a `handle(message)` method. Discovery wires it into the bus at
application bootstrap — no manual registration.

## 3. Configure the module

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { InMemoryTransport, MessengerModule } from '@schally/nestjs-messenger';
import { SendWelcomeEmailHandler } from './handlers/send-welcome-email.handler';
import { SendWelcomeEmailMessage } from './messages/send-welcome-email.message';

@Module({
  imports: [
    MessengerModule.forRoot({
      // Transport instances or factories (`() => Transport`). Swap for a broker
      // transport (e.g. RedisStreamsTransport) when you add one.
      transports: {
        async: () => new InMemoryTransport({ name: 'async' }),
      },
      // Route this message to the `async` transport. Omit a message from `routing`
      // to have it handled synchronously inside dispatch().
      routing: {
        [SendWelcomeEmailMessage.name]: ['async'],
      },
      retry: { maxRetries: 3, delayMs: 1000, multiplier: 2, maxDelayMs: 60_000 },
    }),
  ],
  providers: [SendWelcomeEmailHandler],
})
export class AppModule {}
```

## 4. Dispatch

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

`dispatch()` returns the `Envelope` with the stamps the pipeline added (e.g.
`BusNameStamp`, and a `SentStamp` once the message is routed to a transport).

## 5. Async options

When the config depends on other providers (e.g. a `ConfigService`), use `forRootAsync`:

```ts
MessengerModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    transports: { async: () => new InMemoryTransport() },
    routing: { [SendWelcomeEmailMessage.name]: ['async'] },
    retry: { maxRetries: config.get('RETRY_MAX', 3) },
  }),
});
```

## 6. Run the worker (M5)

Routed messages sit on their transport until a worker consumes them. Wire the
`ConsumeCommand` (from the `@schally/nestjs-messenger/cli` subpath, which pulls in
`nest-commander`) into a small CLI entry:

```ts
// src/cli.ts
import { CommandFactory } from 'nest-commander';
import { Module } from '@nestjs/common';
import { ConsumeCommand } from '@schally/nestjs-messenger/cli';
import { AppModule } from './app.module';

@Module({ imports: [AppModule], providers: [ConsumeCommand] })
class CliModule {}

// A bootstrap function — NOT top-level await, which doesn't compile in a CommonJS
// project (NestJS's default). `['warn', 'error']` quiets Nest's startup logs.
async function bootstrap(): Promise<void> {
  await CommandFactory.run(CliModule, ['log', 'warn', 'error']);
}
void bootstrap();
```

```bash
# Drain the `async` transport, processing up to 100 messages then exiting
# (a supervisor restarts the process for a fresh memory state).
node dist/cli messenger:consume async --limit=100 --memory-limit=128M

# Or bound by time:
node dist/cli messenger:consume async --time-limit=3600
```

For each message the worker runs the receiver pipeline and then settles it: **ack** when
the pipeline resolves (handled, retried, or routed to the failure transport) and
**reject** only on an infrastructure error. Retries follow the configured policy and,
once exhausted, the message is pushed to the failure transport (ADR-004). `SIGTERM` /
`SIGINT` trigger a graceful shutdown — the in-flight message finishes first.

## What this wires for you

- `MessengerModule.forRoot` / `forRootAsync` assemble the canonical middleware pipeline
  (`AddBusNameStamp → FailedMessageProcessing → [your middlewares] → SendMessage →
  [Retry] → HandleMessage`).
- `@MessageHandler(MessageClass)` + discovery register handlers from NestJS DI.
- `routing` binds message classes to transports; unrouted messages run synchronously.
- The `consume` worker drains a transport with `--limit` / `--time-limit` / `--memory-limit`
  and shuts down gracefully.
- Every configured transport is closed on application shutdown.
