# @schally/nestjs-messenger-transport-sql

PostgreSQL / MySQL / MariaDB transport for
[`@schally/nestjs-messenger`](https://github.com/schallym/nestjs-messenger) — your database as a
reliable message queue. Raw SQL over the native drivers (`pg`, `mysql2`), **no ORM**
([ADR-006](../../docs/ADR-006-sql-transport-raw-drivers.md)), mirroring the semantics of Symfony
Messenger's Doctrine transport.

- Claims use `FOR UPDATE SKIP LOCKED`: concurrent consumers never contend or double-process.
- PostgreSQL consumers idle on **LISTEN/NOTIFY** (near-instant delivery, no poll hammering);
  the `NOTIFY` is emitted inside the `INSERT` statement — no trigger, no extra DDL.
- At-least-once: a message claimed by a crashed worker resurrects after `redeliverTimeoutSeconds`.
- Millisecond `DelayStamp` precision (`TIMESTAMPTZ(3)` / `DATETIME(3)`).
- Listable (`list`/`find`/`getMessageCount`): the natural choice for a **failure transport**.

## Requirements

`SKIP LOCKED` is mandatory — there is no fallback for older servers:

| Database   | Minimum version |
| ---------- | --------------- |
| PostgreSQL | 9.5             |
| MySQL      | 8.0.1           |
| MariaDB    | 10.6            |

## Install

```bash
pnpm add @schally/nestjs-messenger @schally/nestjs-messenger-transport-sql
pnpm add pg        # postgres:// / postgresql:// DSNs
pnpm add mysql2    # mysql:// / mariadb:// DSNs
```

`pg` and `mysql2` are optional peer dependencies, loaded lazily from the DSN scheme — install
only the one you use.

## Usage

```ts
import { MessengerModule, JsonSerializer } from '@schally/nestjs-messenger';
import { SqlTransport } from '@schally/nestjs-messenger-transport-sql';

const serializer = new JsonSerializer([SendEmailMessage]);

MessengerModule.forRoot({
  transports: {
    async: () =>
      new SqlTransport({
        dsn: process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:5432/app',
        name: 'async', // MUST equal the routing alias for retry to work
        queueName: 'async',
        serializer,
      }),
    failed: () =>
      new SqlTransport({
        dsn: process.env.DATABASE_URL!,
        name: 'failed',
        queueName: 'failed',
        serializer,
      }),
  },
  routing: { [SendEmailMessage.name]: ['async'] },
  failureTransport: 'failed',
});
```

One table (`messenger_messages` by default) holds every queue; `queueName` separates them.

## Options

| Option                    | Default                | Notes                                                                     |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `dsn`                     | —                      | `postgres://`, `postgresql://`, `mysql://` or `mariadb://`                |
| `queueName`               | `'default'`            | logical queue within the shared table (≤ 190 chars)                       |
| `name`                    | `queueName`            | name in `ReceivedStamp`; must equal the routing alias                     |
| `tableName`               | `'messenger_messages'` | lowercase identifier (`^[a-z_][a-z0-9_]{0,47}$`)                          |
| `serializer`              | `JsonSerializer`       | construct it with your message classes                                    |
| `redeliverTimeoutSeconds` | `3600`                 | in-flight messages resurrect after this; must exceed your longest handler |
| `autoSetup`               | `true`                 | create table + index lazily on first use                                  |
| `pollIntervalMs`          | `100`                  | idle poll pause (MySQL always; PostgreSQL when NOTIFY is off/unavailable) |
| `useNotify`               | `true`                 | PostgreSQL only: LISTEN/NOTIFY wake-ups                                   |
| `getNotifyTimeoutMs`      | `60000`                | PostgreSQL only: max idle wait per NOTIFY cycle                           |

## Production setup (`autoSetup: false`)

Auto-setup runs `CREATE TABLE IF NOT EXISTS` on first use, which you may not want in production.
Disable it and run the DDL in your migrations (then `transport.setup()` is also available):

```sql
-- PostgreSQL
CREATE TABLE IF NOT EXISTS messenger_messages (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body         TEXT NOT NULL,
  headers      TEXT NOT NULL,
  queue_name   VARCHAR(190) NOT NULL,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ(3) NOT NULL,
  delivered_at TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS messenger_messages_claim_idx
  ON messenger_messages (queue_name, available_at, delivered_at, id);
```

```sql
-- MySQL / MariaDB
CREATE TABLE IF NOT EXISTS messenger_messages (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  body         LONGTEXT NOT NULL,
  headers      LONGTEXT NOT NULL,
  queue_name   VARCHAR(190) NOT NULL,
  created_at   DATETIME(3) NOT NULL,
  available_at DATETIME(3) NOT NULL,
  delivered_at DATETIME(3) NULL,
  INDEX messenger_messages_claim_idx (queue_name, available_at, delivered_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## Semantics & quirks

- **How a claim works.** The oldest due row (`available_at` reached, ordered by
  `available_at, id`) is locked with `SKIP LOCKED` and marked in-flight by setting
  `delivered_at`. `ack()` deletes the row; `reject()` atomically re-inserts a copy under a new id
  with an incremented `RedeliveryStamp` and deletes the original. All time arithmetic uses the
  **database clock**, so worker clock skew cannot cause early/late redelivery.
- **Crash recovery is `redeliverTimeoutSeconds`, not instant.** A claimed-but-never-acked message
  only becomes claimable again after the timeout (default 1 h). Size it above your longest
  handler, or a second delivery starts while the first still runs (Symfony has the same
  contract).
- **MySQL polls.** There is no LISTEN/NOTIFY equivalent; idle consumers poll at
  `pollIntervalMs`. Each poll is one indexed claim query — cheap, but pick the interval to match
  your latency/load trade-off.
- **PostgreSQL delayed messages while idle.** NOTIFY fires at _send_ time; a delayed message's
  due time is tracked by bounding the idle wait with the queue's next `available_at`. Messages
  awaiting _redelivery_ (crashed worker) are picked up on the next wake-up or within
  `getNotifyTimeoutMs` at the latest.
- **If the LISTEN connection drops**, the consumer degrades to plain polling at `pollIntervalMs`
  automatically.
- **Undecodable rows** (unregistered message class, malformed headers) are deleted rather than
  redelivered forever; `list()`/`find()` skip them.
- **Transactional outbox: not yet.** Unlike PHP's shared DBAL connection, a Node pool cannot
  silently join your open transaction. Dispatching atomically with business writes is a planned
  follow-up; the internal driver seam already accommodates it.

## Testing

The package is verified by the shared transport conformance suite against **real** PostgreSQL
and MySQL servers (see `e2e/docker-compose.yml`):

```bash
pnpm dev:brokers   # starts postgres:16 + mysql:8.4 (among others)
pnpm --filter @schally/nestjs-messenger-transport-sql test
```
