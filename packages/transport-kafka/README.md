# @schally/nestjs-messenger-transport-kafka

An [Apache Kafka](https://kafka.apache.org/) transport for
[`@schally/nestjs-messenger`](../messenger), built on [`kafkajs`](https://kafka.js.org/). A
transport maps to a **topic**; consuming uses a consumer group with **manual offset
commits** bridged to the worker's async iterator.

## Install

```bash
# pnpm
pnpm add @schally/nestjs-messenger @schally/nestjs-messenger-transport-kafka
# npm
npm install @schally/nestjs-messenger @schally/nestjs-messenger-transport-kafka
```

## Usage

Pass an instance (or factory) to `MessengerModule.forRoot`. The transport `name` **must
equal the routing alias** it is registered under, so retries re-send to the right origin.

```ts
import { JsonSerializer, MessengerModule } from '@schally/nestjs-messenger';
import { KafkaTransport } from '@schally/nestjs-messenger-transport-kafka';
import { SendEmailMessage } from './messages/send-email.message';

MessengerModule.forRoot({
  transports: {
    async: () =>
      new KafkaTransport({
        brokers: ['localhost:9092'],
        topic: 'messenger.async',
        name: 'async',
        groupId: 'messenger-async-workers',
        // Register your message classes so they can be reconstructed on receive.
        serializer: new JsonSerializer([SendEmailMessage]),
      }),
  },
  routing: { [SendEmailMessage.name]: ['async'] },
  retry: { maxRetries: 3, delayMs: 1000, multiplier: 2 },
});
```

Run several workers with the **same `groupId`** to load-balance the topic's partitions
across them — Kafka's native scaling model (one consumer per partition).

## Options (`KafkaTransportOptions`)

| Option | Default | Description |
|---|---|---|
| `brokers` | — | Broker bootstrap addresses, e.g. `['localhost:9092']` (required). |
| `topic` | — | Topic produced to / consumed from (required). |
| `groupId` | the `name` | Consumer group; workers sharing it load-balance partitions. |
| `name` | the `topic` | Surfaced in `ReceivedStamp`; **must equal the routing alias** for retries. |
| `clientId` | `nestjs-messenger` | kafkajs client id. |
| `serializer` | `new JsonSerializer()` | Wire serializer; construct it with your message classes. |
| `autoCreate` | `true` | Create the topic if missing (handy for dev). |
| `numPartitions` | `1` | Partitions for an auto-created topic. |
| `fromBeginning` | `true` | Read the topic from offset 0 on first join. |
| `maxMessageBytes` | `1048576` | Topic `max.message.bytes` + consumer per-partition fetch size. Raise it (and the broker's `message.max.bytes`) for larger payloads. |
| `kafkaConfig` | `{}` | Extra kafkajs client options (ssl, sasl, retry, ...). |

## How it works / quirks

- **Offsets, not per-message acks.** `ack()` commits the message's offset; offsets are
  committed **only on ack/reject**, so an un-acked message is reprocessed after a restart
  (at-least-once). For monotonic commits, run **one worker per partition** (Kafka's model).
- **`reject()` redelivers** by **re-publishing** a copy with an incremented
  `RedeliveryStamp` and committing past the original — Kafka has no per-message nack (see
  [ADR-004](../../docs/ADR-004-retry-as-middleware.md)).
- **No delayed delivery.** Kafka has no native per-message delay, so `DelayStamp` is
  **ignored** — retries happen immediately rather than backed off. Use a transport that
  supports delay (e.g. Redis) for those messages.
- **Not a failure-inspection backend.** Kafka cannot enumerate messages without consuming,
  so this transport does **not** implement `ListableReceiver`/`MessageRetriever` and cannot
  back the `messenger:failed:*` CLI. Use a listable transport (e.g. Redis) as the
  `failureTransport`.
- **Large messages need configuration.** Kafka's default message limit is ~1 MB. For larger
  payloads, raise `maxMessageBytes` here **and** the broker's `message.max.bytes`.
- **Errors** map to the typed hierarchy: `UNKNOWN_TOPIC_OR_PARTITION` →
  `TransportNotFoundError`, connection/timeout failures → `TransportConnectionError`,
  otherwise `TransportError`.

## Testing

Validated against the shared conformance suite (with `delayedDelivery` opted out) plus
targeted tests, **against a real Kafka broker** (`pnpm dev:brokers` locally — a single-node
KRaft broker — or a Kafka service in CI). Mocking `kafkajs` would test the mock, not Kafka.
