# Example: a real-world usage of `@schally/nestjs-messenger`

This document shows the API as a *user* would experience it, end to end. If you're evaluating whether the library's design matches your needs, read this. If you're a contributor, this is the target — every PR should preserve this experience.

The scenario: an e-commerce backend that needs to send confirmation emails, generate PDF invoices, and synchronize orders to an analytics warehouse. Each task has different reliability and latency requirements.

---

## 1. Install

```bash
# pnpm
pnpm add @schally/nestjs-messenger @schally/nestjs-messenger-transport-redis
# npm
npm install @schally/nestjs-messenger @schally/nestjs-messenger-transport-redis
```

That's it. No `bullmq`, no separate `core` package. One main package, one transport.

---

## 2. Define messages

Messages are plain classes. No decorators, no inheritance, no magic.

```ts
// src/messages/send-order-confirmation.message.ts
export class SendOrderConfirmationMessage {
  constructor(
    public readonly orderId: string,
    public readonly customerEmail: string,
  ) {}
}

// src/messages/generate-invoice.message.ts
export class GenerateInvoiceMessage {
  constructor(
    public readonly orderId: string,
  ) {}
}

// src/messages/sync-order-to-warehouse.message.ts
export class SyncOrderToWarehouseMessage {
  constructor(
    public readonly orderId: string,
    public readonly occurredAt: Date,
  ) {}
}
```

Why classes and not interfaces or plain objects? Because we need a runtime identity (the class reference) for routing and handler discovery. TypeScript interfaces are erased at runtime; classes aren't.

---

## 3. Define handlers

Handlers are NestJS providers decorated with `@MessageHandler(MessageClass)`. They get full NestJS DI.

```ts
// src/handlers/send-order-confirmation.handler.ts
import { Injectable, Logger } from '@nestjs/common';
import { MessageHandler } from '@schally/nestjs-messenger';
import { SendOrderConfirmationMessage } from '../messages/send-order-confirmation.message';
import { EmailService } from '../services/email.service';
import { OrderRepository } from '../repositories/order.repository';

@Injectable()
@MessageHandler(SendOrderConfirmationMessage)
export class SendOrderConfirmationHandler {
  private readonly logger = new Logger(SendOrderConfirmationHandler.name);

  constructor(
    private readonly emails: EmailService,
    private readonly orders: OrderRepository,
  ) {}

  async handle(message: SendOrderConfirmationMessage): Promise<void> {
    const order = await this.orders.findById(message.orderId);
    if (!order) {
      // Throwing causes the retry pipeline to evaluate; after retries
      // exhausted, this lands in the failure transport.
      throw new Error(`Order ${message.orderId} not found`);
    }

    await this.emails.sendOrderConfirmation(message.customerEmail, order);
    this.logger.log(`Confirmation sent for order ${message.orderId}`);
  }
}
```

The handler is just a class with a `handle(message)` method. NestJS DI works normally. No `@Process`, no job IDs, no progress callbacks — that's BullMQ vocabulary, not ours.

---

## 4. Configure the module

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { JsonSerializer, MessengerModule } from '@schally/nestjs-messenger';
import { RedisStreamsTransport } from '@schally/nestjs-messenger-transport-redis';
import { SendOrderConfirmationHandler } from './handlers/send-order-confirmation.handler';
import { GenerateInvoiceHandler } from './handlers/generate-invoice.handler';
import { SyncOrderToWarehouseHandler } from './handlers/sync-order-to-warehouse.handler';
import {
  SendOrderConfirmationMessage,
  GenerateInvoiceMessage,
  SyncOrderToWarehouseMessage,
} from './messages';

// Your message classes, registered so the worker can reconstruct them on receive.
const messages = [
  SendOrderConfirmationMessage,
  GenerateInvoiceMessage,
  SyncOrderToWarehouseMessage,
];
const redis = (name: string, stream: string) => () =>
  new RedisStreamsTransport({
    dsn: 'redis://localhost:6379',
    name, // MUST equal the routing alias so retries re-send to the right origin
    stream,
    serializer: new JsonSerializer(messages),
  });

@Module({
  imports: [
    MessengerModule.forRoot({
      // Transports are instances or factories (`() => Transport`). The factory form
      // lets the broker connection open at module init.
      transports: {
        // Customer-facing, must succeed: short retries, fast feedback
        async_high: redis('async_high', 'orders.high'),
        // Background work, can wait
        async_low: redis('async_low', 'orders.low'),
        // Where exhausted retries end up for human inspection
        failed: redis('failed', 'orders.failed'),
      },
      routing: {
        [SendOrderConfirmationMessage.name]: ['async_high'],
        [GenerateInvoiceMessage.name]: ['async_low'],
        [SyncOrderToWarehouseMessage.name]: ['async_low'],
      },
      retry: {
        maxRetries: 3,
        delayMs: 1000,
        multiplier: 2,
        maxDelayMs: 60_000,
      },
      failureTransport: 'failed',
    }),
  ],
  providers: [
    SendOrderConfirmationHandler,
    GenerateInvoiceHandler,
    SyncOrderToWarehouseHandler,
    // ... your other services, repositories, etc.
  ],
})
export class AppModule {}
```

What's happening here, in plain terms:

- **Three transports** declared by name, each a factory returning a Redis Streams
  transport. They could just as well be different brokers (e.g. a future
  `audit: () => new PostgresTransport(...)`) — `routing` is what binds messages to transports.
- **Routing config** maps each message class to one or more transports. Sending to multiple = fan-out. Sending to none = synchronous (handled inline, no transport hop).
- **Retry** policy is global (the `retry` option). Per-message overrides will come in v0.2; for v0.1 it's one policy.
- **Failure transport** is just another named transport. Exhausted retries land here, with an `ErrorDetailsStamp` attached.

---

## 5. Dispatch messages

From anywhere in your app, inject `MessageBus`:

```ts
// src/checkout/checkout.service.ts
import { Injectable } from '@nestjs/common';
import { MessageBus } from '@schally/nestjs-messenger';
import { SendOrderConfirmationMessage } from '../messages/send-order-confirmation.message';
import { GenerateInvoiceMessage } from '../messages/generate-invoice.message';
import { SyncOrderToWarehouseMessage } from '../messages/sync-order-to-warehouse.message';

@Injectable()
export class CheckoutService {
  constructor(private readonly bus: MessageBus) {}

  async finalizeOrder(orderId: string, customerEmail: string): Promise<void> {
    // ... persist the order in your DB ...

    // Fire-and-forget: returns once the message is on the transport, not
    // once it's handled. Each dispatch is independent — if one fails,
    // the others still proceed.
    await this.bus.dispatch(
      new SendOrderConfirmationMessage(orderId, customerEmail),
    );
    await this.bus.dispatch(new GenerateInvoiceMessage(orderId));
    await this.bus.dispatch(
      new SyncOrderToWarehouseMessage(orderId, new Date()),
    );
  }
}
```

`dispatch()` returns a `Promise<Envelope>` — the envelope with all the stamps added by the send pipeline. Useful if you want to inspect `TransportMessageIdStamp` for tracing. Most code ignores the return value.

---

## 6. Run the workers

This is the part where Symfony Messenger users will feel at home and BullMQ users will see the difference.

First, wire the CLI commands (from the `@schally/nestjs-messenger/cli` subpath) into a
small entrypoint — they're nest-commander commands registered as providers:

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

// A bootstrap function — NOT top-level await, which doesn't compile in a CommonJS
// project (NestJS's default). `['warn', 'error']` quiets Nest's startup logs.
async function bootstrap(): Promise<void> {
  await CommandFactory.run(CliModule, ['warn', 'error']);
}
void bootstrap();
```

```bash
# Consume the high-priority queue, process up to 100 messages then exit
# (a supervisor like PM2 or k8s restarts the process for a fresh memory state)
node dist/cli messenger:consume async_high --limit=100 --memory-limit=128M

# Consume the low-priority queue in another process
node dist/cli messenger:consume async_low --limit=500 --time-limit=3600

# Inspect what failed
node dist/cli messenger:failed:show

# Retry a specific failed message after investigation (id from `failed:show`)
node dist/cli messenger:failed:retry 1718-0

# Discard one, or everything
node dist/cli messenger:failed:remove 1718-0
node dist/cli messenger:failed:remove --all
```

The `--limit`, `--memory-limit`, `--time-limit` options match Symfony Messenger exactly. The pattern is the same: workers are short-lived, supervisors restart them, memory leaks can't accumulate.

Under the hood, the worker:

1. Pulls envelopes from the named transport via `XREADGROUP` (it's Redis Streams).
2. Routes each through the receiver-side middleware pipeline.
3. Calls your handler.
4. On success, `XACK`s the message.
5. On failure, hands off to `RetryMiddleware` which either re-sends with an incremented `RedeliveryStamp` and a `DelayStamp`, or sends to the failure transport once retries are exhausted.
6. Counts processed messages. Hits `--limit`, sends `SIGTERM` to itself, drains in-flight, exits 0.

---

## 7. Custom middleware (the real power)

Want to log every message, wrap handlers in a DB transaction, add OpenTelemetry spans, or implement idempotency? Write a middleware.

```ts
// src/messenger/logging.middleware.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  Envelope,
  Middleware,
  StackInterface,
  ReceivedStamp,
  SentStamp,
} from '@schally/nestjs-messenger';

@Injectable()
export class LoggingMiddleware implements Middleware {
  private readonly logger = new Logger('Messenger');

  async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    const messageName = envelope.message.constructor.name;
    const direction = envelope.last(ReceivedStamp) ? 'receiving' : 'sending';
    const started = Date.now();

    this.logger.log(`[${direction}] ${messageName}`);

    try {
      const result = await next().handle(envelope, next);
      const ms = Date.now() - started;
      this.logger.log(`[${direction}] ${messageName} ok (${ms}ms)`);
      return result;
    } catch (err) {
      const ms = Date.now() - started;
      this.logger.error(`[${direction}] ${messageName} failed (${ms}ms)`, err);
      throw err;
    }
  }
}
```

Register it in the module:

```ts
MessengerModule.forRoot({
  transports: { /* ... */ },
  routing: { /* ... */ },
  middlewares: [LoggingMiddleware], // runs for every dispatch and every receive
})
```

The middleware runs in both directions (send and receive), so one logger covers the whole lifecycle. The `ReceivedStamp` check is how you tell which side you're on.

---

## 8. What this design lets you NOT think about

This is the part that matters most. Compare to writing the same app on BullMQ directly:

- You don't think about `Job` objects. Your handlers receive your domain types.
- You don't think about queue creation. The transport handles it lazily.
- You don't think about which retry layer wins. There's only one (yours, in middleware).
- You don't think about progress reporting or job IDs unless you opt in (via `TransportMessageIdStamp`).
- You don't think about Redis specifically. The same code works against a future RabbitMQ or Postgres transport — change the DSN, change the routing config, ship.
- You don't think about consumer groups, XPENDING reapers, or stalled-message recovery — the transport handles it.

---

## 9. What happens when things go wrong (the failure flow)

Suppose `EmailService.send()` throws because the SMTP server is down. Here's the full sequence:

1. `SendOrderConfirmationHandler.handle()` throws.
2. `HandleMessageMiddleware` catches and re-throws as `HandlerFailedError(envelope, originalError)`.
3. `RetryMiddleware` catches `HandlerFailedError`:
   - Reads `envelope.last(RedeliveryStamp)?.retryCount ?? 0`. Say it's 0.
   - Strategy says: retry, delay = 1000ms.
   - Builds a new envelope with `RedeliveryStamp(1, now)` and `DelayStamp(1000)`.
   - Sends to the origin transport (read from `ReceivedStamp.transportName`).
4. The worker `XACK`s the original message (it's now elsewhere).
5. 1 second later, the transport delivers the new envelope. Handler runs again. Throws again.
6. Same cycle. Retries 2, then 3 (delay 2s, then 4s with multiplier=2).
7. On the 4th failure, retry budget exhausted:
   - `RetryMiddleware` sends the envelope (with `ErrorDetailsStamp` + `SentToFailureTransportStamp`, and the leftover `DelayStamp` stripped) to the `failed` transport.
   - The worker `XACK`s to remove from the live queue.
8. A human runs `node dist/cli messenger:failed:show`, sees the message and the error, fixes SMTP, runs `node dist/cli messenger:failed:retry 1718-0`.
9. The message is re-enqueued onto its origin transport with a fresh retry budget. A worker reprocesses it, succeeds. Done.

At no point did you write retry logic, dead-letter queue logic, or recovery scripting. You wrote a handler that throws when things are wrong.

---

## 10. The 5-minute mental model

If someone asks you "how does this lib work?", here's the elevator pitch:

> A `MessageBus` accepts plain class instances. A configurable middleware pipeline decides what to do with them — usually that means sending them to a named *transport* (Redis stream, RabbitMQ exchange, Postgres table, etc.). A *worker* process pulls messages from a transport, runs them through the same pipeline in receive mode, and calls a registered *handler*. Failures retry with backoff, then land in a *failure transport* for human attention. Everything is a class instance — messages, handlers, middlewares, stamps (metadata) — so it's all typed and DI-friendly.

That's the whole thing. Symfony Messenger users will recognize every word. NestJS users get an ecosystem-native module. BullMQ users get a coherent abstraction over what they were building piecemeal.
