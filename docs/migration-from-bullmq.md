# Migrating from BullMQ

This guide maps a typical BullMQ codebase onto `@schally/nestjs-messenger`. The two
solve the same problem — run work asynchronously off a Redis-backed queue — but with
different mental models:

- **BullMQ** is job-centric: you create a `Queue`, `add()` named jobs with arbitrary
  `data`, and a `Worker` runs a processor function that receives a `Job` wrapper.
- **messenger** is message-centric (the Symfony Messenger model): you `dispatch()` a
  typed **message** (a plain class instance); routing sends it to a **transport**; a
  **handler** receives your domain type directly. Retry, backoff, and dead-lettering are
  pipeline concerns, not job options.

> **Not a wrapper.** This library does not depend on BullMQ. The Redis transport speaks
> Redis Streams directly (see [ADR-003](ADR-003-redis-streams-not-bullmq.md)). You are
> changing model, not adding a layer.

## Concept map

| BullMQ | messenger | Notes |
|---|---|---|
| `new Queue('emails')` | a named **transport** + a `routing` entry | No queue object in your code; you dispatch a message and routing picks the transport. |
| `queue.add('sendEmail', data)` | `bus.dispatch(new SendEmailMessage(...))` | The job *name* + untyped `data` become one typed message **class**. |
| `new Worker('emails', fn)` | `@MessageHandler(SendEmailMessage)` class + `messenger:consume emails` process | The processor function becomes a DI-friendly handler; the worker process is the CLI. |
| `Job` (`job.data`, `job.id`, `job.attemptsMade`) | your message + **stamps** | `job.data` → the message itself; `job.id` → `TransportMessageIdStamp`; `job.attemptsMade` → `RedeliveryStamp.retryCount`. |
| `{ attempts, backoff }` per job | global `retry: { maxRetries, delayMs, multiplier, maxDelayMs, jitter }` | One policy in v0.1 (per-message overrides land in v0.2). |
| `queue.add(name, data, { delay })` | `bus.dispatch(msg, [new DelayStamp(ms)])` | A stamp on dispatch, honored by the transport. |
| failed jobs / `job.moveToFailed` / DLQ | **failure transport** + `messenger:failed:*` | Exhausted retries route to a configured transport you inspect/retry/remove. |
| `QueueScheduler` (legacy) | nothing to wire | The transport's delayed-set + stalled-message reaper are built in. |
| `QueueEvents` | a custom **middleware** | Observe the lifecycle by writing a middleware (runs on send and receive). |
| `new Worker(..., { concurrency: n })` | run **n worker processes** (or consumers) | A worker processes one message at a time; scale horizontally — Redis consumer groups distribute across them. |
| Flows / job dependencies, rate limiting, repeatable (cron) jobs | — | Not in v0.1. Scheduler is planned for v0.2; the rest is on the roadmap. |

## Side by side

### Producer

```ts
// BullMQ
import { Queue } from 'bullmq';
const emails = new Queue('emails', { connection });
await emails.add(
  'sendWelcome',
  { userId, email },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
);
```

```ts
// messenger — the message class carries the shape; retry is configured once (below)
import { MessageBus } from '@schally/nestjs-messenger';

export class SendWelcomeEmailMessage {
  constructor(
    public readonly userId: string,
    public readonly email: string,
  ) {}
}

@Injectable()
export class UsersService {
  constructor(private readonly bus: MessageBus) {}
  async register(userId: string, email: string) {
    await this.bus.dispatch(new SendWelcomeEmailMessage(userId, email));
  }
}
```

### Consumer

```ts
// BullMQ
import { Worker } from 'bullmq';
new Worker(
  'emails',
  async (job) => {
    const { userId, email } = job.data; // untyped
    await sendEmail(email);
  },
  { connection, concurrency: 5 },
);
```

```ts
// messenger — a handler is a NestJS provider; it receives your domain type
import { Injectable } from '@nestjs/common';
import { MessageHandler, type MessageHandlerInterface } from '@schally/nestjs-messenger';

@Injectable()
@MessageHandler(SendWelcomeEmailMessage)
export class SendWelcomeEmailHandler
  implements MessageHandlerInterface<SendWelcomeEmailMessage>
{
  constructor(private readonly mailer: Mailer) {} // full DI
  async handle(message: SendWelcomeEmailMessage): Promise<void> {
    await this.mailer.send(message.email); // typed; throw to retry
  }
}
```

The processor's untyped `job.data` becomes the strongly-typed `message`. There is no
`Job` wrapper, no `job.id` plumbing, no `done()` callback — return to ack, throw to fail.

### Configuration & worker

```ts
MessengerModule.forRoot({
  transports: {
    emails: () =>
      new RedisStreamsTransport({
        dsn: 'redis://localhost:6379',
        name: 'emails',
        stream: 'messenger:emails',
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
  routing: { [SendWelcomeEmailMessage.name]: ['emails'] },
  retry: { maxRetries: 3, delayMs: 1000, multiplier: 2, maxDelayMs: 60_000 },
  failureTransport: 'failed',
});
```

```bash
# BullMQ: the Worker is part of your app process and starts implicitly.
# messenger: the worker is an explicit, short-lived process you supervise.
node dist/cli messenger:consume emails --limit=1000 --memory-limit=256M
```

Run several of these (PM2, systemd, k8s replicas) for concurrency; each is a consumer in
the same Redis consumer group, so messages are distributed and never double-processed.

## Behavioral differences to expect

- **Retry lives in one place.** BullMQ retries inside the worker via `attempts`/`backoff`.
  Here, the `RetryMiddleware` owns it (see [ADR-004](ADR-004-retry-as-middleware.md)).
  There is exactly one retry layer, configured once — no "which layer wins?" ambiguity.
- **Dead-lettering is first-class.** Instead of querying failed jobs, exhausted messages
  route to a **failure transport** with an `ErrorDetailsStamp`. Inspect and act with
  `messenger:failed:show` / `:retry` / `:remove`. `failed:retry` re-enqueues to the
  *origin* transport with a fresh budget (see [ADR-005](ADR-005-failed-retry-reenqueue.md)).
- **No `Job` object, no progress API.** If you used `job.updateProgress()` or
  `job.id` for correlation, model it explicitly: read `TransportMessageIdStamp` for the
  id, and add your own stamp + middleware for progress if you truly need it. Most code
  doesn't.
- **Workers are short-lived by design.** `--limit` / `--time-limit` / `--memory-limit`
  exist so a supervisor restarts the process on a clean slate — the Symfony Messenger
  operational model. There's no long-lived in-process worker holding the connection.
- **Transport-agnostic handlers.** The same handler runs against a future RabbitMQ or SQL
  transport — change the transport instance and the DSN, not your code.

## Things deferred (don't migrate these yet)

`Flows`/parent-child jobs, rate limiting, and repeatable/cron jobs have no v0.1
equivalent. The scheduler is planned for v0.2; track [`docs/ROADMAP.md`](ROADMAP.md). If
you depend on these today, keep that slice on BullMQ and migrate the plain
queue/worker paths first — the two can coexist on the same Redis.
