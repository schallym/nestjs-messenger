# @schally/nestjs-messenger-transport-redis

A [Redis Streams](https://redis.io/docs/data-types/streams/) transport for
[`@schally/nestjs-messenger`](../messenger). Built **directly on Redis Streams**
(`XADD` / `XREADGROUP` / `XACK` / `XAUTOCLAIM`) via `ioredis` — **not** BullMQ
(see [ADR-003](../../docs/ADR-003-redis-streams-not-bullmq.md)).

## Install

```bash
# pnpm
pnpm add @schally/nestjs-messenger @schally/nestjs-messenger-transport-redis
# npm
npm install @schally/nestjs-messenger @schally/nestjs-messenger-transport-redis
```

## Usage

Pass an instance (or factory) to `MessengerModule.forRoot`. The transport `name`
**must equal the routing alias** it is registered under, so retries re-send to the
right origin.

```ts
import { JsonSerializer, MessengerModule } from '@schally/nestjs-messenger';
import { RedisStreamsTransport } from '@schally/nestjs-messenger-transport-redis';
import { SendEmailMessage } from './messages/send-email.message';

MessengerModule.forRoot({
  transports: {
    async: () =>
      new RedisStreamsTransport({
        dsn: 'redis://localhost:6379',
        name: 'async',
        stream: 'messenger:async',
        // Register your message classes so they can be reconstructed on receive.
        serializer: new JsonSerializer([SendEmailMessage]),
      }),
    failed: () =>
      new RedisStreamsTransport({
        dsn: 'redis://localhost:6379',
        name: 'failed',
        stream: 'messenger:failed',
        serializer: new JsonSerializer([SendEmailMessage]),
      }),
  },
  routing: { [SendEmailMessage.name]: ['async'] },
  retry: { maxRetries: 3, delayMs: 1000, multiplier: 2 },
  failureTransport: 'failed',
});
```

## DSN format

`redis://[username:password@]host[:port][/db]` — or `rediss://…` for TLS. The DSN is
validated (a typo throws `TransportConnectionError`) and handed to ioredis for parsing.

## Options (`RedisStreamsTransportOptions`)

| Option | Default | Description |
|---|---|---|
| `dsn` | — | Connection DSN (required). |
| `stream` | — | Stream key messages are appended to (required). |
| `name` | the `stream` | Surfaced in `ReceivedStamp`; **must equal the routing alias** for retries to find the origin. |
| `group` | `messenger` | Consumer group. |
| `consumer` | `<pid>-<uuid>` | Consumer name within the group. |
| `serializer` | `new JsonSerializer()` | Wire serializer. Construct it with your message classes so `get()` can rebuild them. |
| `delayKey` | `<stream>:delayed` | Sorted-set key holding not-yet-due delayed messages. |
| `claimIdleMs` | `30000` | Idle time after which a pending message is reclaimed from a dead consumer. |
| `pollIntervalMs` | `50` | Pause between polls when the stream is empty. |
| `readBatchSize` | `10` | Max messages read per poll. |
| `redisOptions` | `{}` | Extra ioredis options merged into the connection. |

## How it works / quirks

- **Delayed delivery** (`DelayStamp`): not-yet-due messages are held in a sorted set
  keyed by due-time and atomically promoted to the stream when due (a small Lua drain
  runs each poll).
- **Stalled-message reclaim**: `XAUTOCLAIM` reassigns messages a dead consumer left
  pending (idle past `claimIdleMs`) to a live consumer — the own implementation of the
  reaper pattern (no BullMQ).
- **`reject()` redelivers.** Per [ADR-004](../../docs/ADR-004-retry-as-middleware.md),
  `reject()` re-appends the message with an incremented `RedeliveryStamp` (a fresh
  stream id) and `XACK` + `XDEL`s the original. It is the *infrastructure-error*
  recovery path; handler-failure retry is owned by the `RetryMiddleware`.
- **`ack()` deletes.** `ack()` is `XACK` **+ `XDEL`**: it clears the pending entry and
  removes it from the stream, so the stream doesn't grow unbounded and so acking a
  message located via `find()` (failure inspection) actually deletes it.
- **Failure inspection** (`ListableReceiver` / `MessageRetriever`): `list(limit?)` reads
  the stream with `XRANGE` (default `COUNT 100`) and `find(id)` with `XRANGE id id`,
  without consuming. These back the `messenger:failed:show` / `:retry` / `:remove`
  commands when this transport is the `failureTransport`. Per
  [ADR-005](../../docs/ADR-005-failed-retry-reenqueue.md), `failed:retry` re-enqueues the
  message onto its origin transport (it does not run a handler in the CLI process).
- **Poison messages** (undecodable content — unregistered message type or malformed
  JSON) are discarded (acked) rather than looped forever via the reaper.
- **Errors** are mapped to the typed hierarchy: connection failures →
  `TransportConnectionError`, missing group → `TransportNotFoundError`, otherwise
  `TransportError` (with the original as `cause`).

## Testing

The transport is validated against the shared conformance suite plus targeted tests,
**against a real Redis** (`pnpm dev:brokers` locally, a Redis service in CI). Mocking
ioredis would test the mock, not Streams behaviour.

---

Made with ❤️ by [schallym](https://github.com/schallym) and [contributors](https://github.com/schallym/nestjs-messenger/graphs/contributors).
