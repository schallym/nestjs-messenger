# @schally/nestjs-messenger

**Symfony Messenger's developer experience, native to NestJS.** A unified message bus
with a middleware pipeline, an envelope/stamps system, pluggable transports, retry with
backoff, a failure transport, and a worker CLI.

```bash
# pnpm
pnpm add @schally/nestjs-messenger
pnpm add @schally/nestjs-messenger-transport-redis # plus a transport (the reference one)

# npm
npm install @schally/nestjs-messenger
npm install @schally/nestjs-messenger-transport-redis
```

Full quickstart, custom-middleware guide, and the BullMQ migration guide live in the
[repository README](https://github.com/schallym/nestjs-messenger#readme).

## 60-second tour

```ts
import { Injectable, Module } from '@nestjs/common';
import {
  MessageBus,
  MessageHandler,
  MessengerModule,
  InMemoryTransport,
} from '@schally/nestjs-messenger';

export class SendWelcomeEmailMessage {
  constructor(public readonly email: string) {}
}

@Injectable()
@MessageHandler(SendWelcomeEmailMessage)
export class SendWelcomeEmailHandler {
  async handle(message: SendWelcomeEmailMessage): Promise<void> {
    // ...do the work; throw to trigger retry, then the failure transport...
  }
}

@Module({
  imports: [
    MessengerModule.forRoot({
      transports: { async: () => new InMemoryTransport({ name: 'async' }) },
      routing: { [SendWelcomeEmailMessage.name]: ['async'] },
      retry: { maxRetries: 3, delayMs: 1000, multiplier: 2 },
    }),
  ],
  providers: [SendWelcomeEmailHandler],
})
export class AppModule {}

// Dispatch from anywhere: constructor(private readonly bus: MessageBus) {}
//   await this.bus.dispatch(new SendWelcomeEmailMessage('user@example.com'));
```

A message routed to no transport is handled **synchronously** inside `dispatch()`; routed
messages wait on the transport until a worker consumes them.

## Peer dependencies

Provide these in your app (NestJS 10+):

- `@nestjs/common`, `@nestjs/core`, `reflect-metadata` — required.
- `nest-commander` — required **only** if you use the CLI subpath (worker / failure commands).
- `jest` — required **only** if you use the conformance suite from the testing subpath.

## Subpath exports

| Import | Contents |
|---|---|
| `@schally/nestjs-messenger` | Envelope, stamps, `MessageBus`, middleware, `TransportInterface` + `InMemoryTransport`, retry, serializer, typed errors, `MessengerModule`, `@MessageHandler`, `Worker`. |
| `@schally/nestjs-messenger/cli` | `ConsumeCommand`, `FailedShowCommand`, `FailedRetryCommand`, `FailedRemoveCommand` (nest-commander). |
| `@schally/nestjs-messenger/testing` | `runTransportConformanceTests`, `ConformanceMessage` — validate any transport against the shared contract. |

## CLI

Register the commands as providers in a `nest-commander` `CommandFactory` module, then:

```bash
node dist/cli messenger:consume <transport> --limit=100 --time-limit=3600 --memory-limit=128M
node dist/cli messenger:failed:show [id]
node dist/cli messenger:failed:retry <id...>
node dist/cli messenger:failed:remove [id...] --all
```

## Concept vocabulary

**Message** (a plain class) → wrapped in an **Envelope** carrying **Stamps** (typed
metadata) → routed by the **MessageBus** through a **Middleware** pipeline → to a
**Transport** (Sender/Receiver) → consumed by a **Worker** → handled by a **Handler**.
Failures retry per the configured strategy, then route to the **failure transport**.

## Writing a transport

Implement `TransportInterface` and validate it against the conformance suite:

```ts
import { runTransportConformanceTests } from '@schally/nestjs-messenger/testing';

runTransportConformanceTests({
  name: 'MyTransport',
  createTransport: async () => ({ transport: new MyTransport(), cleanup: () => /* ... */ }),
  capabilities: { delayedDelivery: true, listable: true },
});
```

See the [transport-implementation skill](https://github.com/schallym/nestjs-messenger/blob/main/.claude/skills/transport-implementation/SKILL.md).

## License

MIT.
