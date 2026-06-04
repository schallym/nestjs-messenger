# @schally/nestjs-messenger-transport-google-pubsub

A [Google Cloud Pub/Sub](https://cloud.google.com/pubsub) transport for
[`@schally/nestjs-messenger`](../messenger). A transport maps to a **topic** (publish) and
a **subscription** (pull), consumed via a streaming pull bridged to the worker's async
iterator.

## Install

```bash
# pnpm
pnpm add @schally/nestjs-messenger @schally/nestjs-messenger-transport-google-pubsub
# npm
npm install @schally/nestjs-messenger @schally/nestjs-messenger-transport-google-pubsub
```

## Usage

Pass an instance (or factory) to `MessengerModule.forRoot`. The transport `name` **must
equal the routing alias** it is registered under, so retries re-send to the right origin.

```ts
import { JsonSerializer, MessengerModule } from '@schally/nestjs-messenger';
import { GooglePubSubTransport } from '@schally/nestjs-messenger-transport-google-pubsub';
import { SendEmailMessage } from './messages/send-email.message';

MessengerModule.forRoot({
  transports: {
    async: () =>
      new GooglePubSubTransport({
        projectId: 'my-gcp-project',
        topic: 'messenger-async',
        subscription: 'messenger-async-worker',
        name: 'async',
        // Register your message classes so they can be reconstructed on receive.
        serializer: new JsonSerializer([SendEmailMessage]),
      }),
  },
  routing: { [SendEmailMessage.name]: ['async'] },
  retry: { maxRetries: 3, delayMs: 1000, multiplier: 2 },
});
```

## Authentication

In production, the client uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
(`GOOGLE_APPLICATION_CREDENTIALS`, workload identity, etc.) — nothing transport-specific.
For local development and tests, point at the **emulator**:

```bash
gcloud beta emulators pubsub start --host-port=localhost:8685
export PUBSUB_EMULATOR_HOST=localhost:8685
```

`pnpm dev:brokers` starts an emulator at `localhost:8685` via docker-compose.

## Options (`GooglePubSubTransportOptions`)

| Option | Default | Description |
|---|---|---|
| `projectId` | — | GCP project id (any value with the emulator). |
| `topic` | — | Topic published to (required). |
| `subscription` | — | Subscription pulled from (required). |
| `name` | the `subscription` | Surfaced in `ReceivedStamp`; **must equal the routing alias** for retries to find the origin. |
| `serializer` | `new JsonSerializer()` | Wire serializer; construct it with your message classes. |
| `autoCreate` | `true` | Create the topic/subscription if missing (handy for dev/emulator). |
| `maxMessages` | `10` | Max messages leased concurrently by the streaming pull. |
| `ackDeadlineSeconds` | `60` | Ack deadline for an auto-created subscription. |
| `clientConfig` | `{}` | Extra `@google-cloud/pubsub` client options. |

## How it works

- **One topic + one subscription** per transport instance; the message body carries the
  serialized envelope (`{ body, headers }`) in its `data` payload (no Pub/Sub attribute
  size limits).
- **`reject()` redelivers** by **re-publishing** a copy with an incremented
  `RedeliveryStamp` and acking the original — Pub/Sub's native nack can't carry our stamp
  (see [ADR-004](../../docs/ADR-004-retry-as-middleware.md)).
- **No delayed delivery.** Pub/Sub has no native per-message delay, so `DelayStamp` is
  **ignored** — retries happen immediately rather than backed off. If you need delayed
  retries, use a transport that supports them (e.g. Redis) for those messages.
- **Not a failure-inspection backend.** Pub/Sub cannot enumerate messages without
  consuming, so this transport does **not** implement `ListableReceiver`/`MessageRetriever`
  and cannot back the `messenger:failed:*` CLI. Use a listable transport (e.g. Redis) as
  the `failureTransport`. (A Pub/Sub topic can still *receive* dead letters; you just can't
  inspect them with the CLI.)
- **At-least-once.** Like all Pub/Sub consumers, handlers must tolerate occasional
  redelivery (idempotency). Ack/reject are idempotent.
- **Errors** map to the typed hierarchy: `NOT_FOUND` → `TransportNotFoundError`, transient
  gRPC/socket failures → `TransportConnectionError`, otherwise `TransportError`.

## Testing

Validated against the shared conformance suite (with `delayedDelivery` opted out) plus
targeted tests, **against the Pub/Sub emulator** (`pnpm dev:brokers` locally, an emulator
service in CI). Mocking `@google-cloud/pubsub` would test the mock, not Pub/Sub behaviour.
