---
name: transport-implementation
description: Use when adding a new transport (Redis Streams, RabbitMQ, SQL, Pub/Sub, SQS, etc.) or fixing a bug in an existing transport. Covers the TransportInterface contract, the conformance test suite, mandatory error mapping, ack/reject semantics, and graceful shutdown rules. Trigger whenever code is added under packages/transport-* or when TransportInterface changes.
---

# Implementing a transport

A transport is the pluggable backend that persists and delivers envelopes. Symfony Messenger's strength is that handlers don't know which transport they're behind. Ours has the same goal.

## The contract (don't deviate)

```ts
export interface TransportInterface {
  /** Send an envelope. MUST return a new envelope with a SentStamp + TransportMessageIdStamp. */
  send(envelope: Envelope): Promise<Envelope>;

  /** Pull messages. MUST be cancellable via AbortSignal. MUST yield envelopes with ReceivedStamp + TransportMessageIdStamp. */
  get(signal: AbortSignal): AsyncIterable<Envelope>;

  /** Mark message as successfully processed. Idempotent. */
  ack(envelope: Envelope): Promise<void>;

  /** Mark message as failed. Transport decides whether to redeliver, DLQ, or drop based on RedeliveryStamp count. */
  reject(envelope: Envelope): Promise<void>;

  /** Release resources. MUST wait for in-flight ack/reject to settle. */
  close(): Promise<void>;
}
```

Optional (capability-detected via duck-typing):

- `MessageCountAware.getMessageCount(): Promise<number>` — for `messenger:stats` CLI
- `ListableReceiver.list(limit?: number): AsyncIterable<Envelope>` — for failure transport inspection
- `MessageRetriever.find(id: string): Promise<Envelope | null>` — for retry by ID

If your transport can't implement one of these capabilities, **don't fake it**. Just don't declare it. The CLI degrades gracefully.

## Stamps a transport MUST add

| When | Stamp |
|---|---|
| On `send()` success | `TransportMessageIdStamp(id)` |
| On `get()` yield | `ReceivedStamp(transportName)`, `TransportMessageIdStamp(id)` |
| When retrying after a `reject()` | `RedeliveryStamp(retryCount, redeliveredAt)` |

Never strip stamps the user added.

**Stamp ownership note (decided in M2).** The `SentStamp` — which carries the routing *alias* (e.g. `async_high`) — is added by `SendMessageMiddleware`, not by the transport: the middleware is the layer that knows the alias, the transport only knows its own class. A transport's `send()` therefore adds **only** `TransportMessageIdStamp`. Don't add a second `SentStamp` from inside the transport.

## Redis transport specifics: Streams, not BullMQ

The reference Redis transport (`@schally/nestjs-messenger-transport-redis`) uses **Redis Streams directly** — `XADD`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM`. We do NOT depend on BullMQ.

Why this matters when implementing:

- **One queue per transport instance** = one stream key (e.g., `messenger:queue:async`).
- **Consumer group per worker pool** = use `XREADGROUP` with a stable group name (`messenger-consumers`).
- **Each consumer in the group** uses a unique consumer name (hostname + pid + uuid).
- **Acks** are `XACK` on the stream/group/messageId tuple.
- **Rejects** with redelivery: `XADD` a new entry with incremented `RedeliveryStamp` + a `DelayStamp` honored via a delayed-message sorted set (`messenger:delayed:async`) polled by a tiny reaper.
- **Rejects without retry** (budget exhausted): the retry middleware sends to the failure transport; the original is `XACK`'d to remove from pending.
- **Stalled messages**: a periodic `XPENDING` + `XCLAIM` reaper reassigns messages from dead consumers.

If you're not familiar with Redis Streams, read https://redis.io/docs/data-types/streams/ before opening a PR. The mental model is fundamentally different from list-based queues (LPUSH/BRPOP) and from BullMQ's job-state model.

## Push/streaming brokers (Google Pub/Sub): bridging to `get()`

The Pub/Sub transport (`@schally/nestjs-messenger-transport-google-pubsub`) consumes via a
**streaming pull** (`subscription.on('message')`), which is push-based, and bridges it to
our pull-based `get(signal): AsyncIterable<Envelope>`. Hard-won lessons that generalize to
any push/lease broker:

- **Keep ONE streaming subscription at the instance level**, created lazily and closed only
  in `close()` — NOT one per `get()` call. The conformance does `transport.ack(await receiveOne(...))`,
  which disposes the `get()` iterator (runs its `finally`) **before** `ack()` is called. If
  the subscription/lease is tied to a single `get()` invocation, `message.ack()` is already
  invalid by ack time. An instance-level subscription keeps acks valid for the transport's
  lifetime (like a Redis connection), and lets concurrent `get()` loops share one stream.
- **`reject()` can't mutate the leased message**, so redeliver the Redis way: **re-publish**
  a copy with an incremented `RedeliveryStamp` and `ack()` the original. Native `nack`
  redelivers the *same* payload (no stamp bump) and fails conformance scenario 3.
- **Retention is subscription-scoped.** Pub/Sub only retains a message for subscriptions
  that exist *at publish time*. Since a transport is both sender and receiver for its alias,
  `send()` must ensure the **subscription** (not just the topic) before publishing, or the
  conformance's `send()`-then-`get()` loses the message.
- **No native per-message delay** → opt out (`capabilities.delayedDelivery: false`) and
  ignore `DelayStamp` (document it; retries become immediate).
- **Can't enumerate without consuming** → do NOT declare `ListableReceiver`/`MessageRetriever`;
  such a transport can't back the `messenger:failed:*` CLI.
- **Test against the emulator**, never a mock (`PUBSUB_EMULATOR_HOST`; docker-compose service).

## Error mapping (this is where people get it wrong)

Wrap every native error from the broker SDK into our typed hierarchy:

- Connection refused / network error → `TransportConnectionError`
- Broker says "not found" / "queue does not exist" → `TransportNotFoundError`
- Serialization failed → `SerializationError` (don't ack, don't loop forever — reject to DLQ)
- Anything else → `TransportError` with `cause` set to the original

This matters because middlewares above (e.g., retry strategy) decide what to do based on the error type. A raw `ECONNREFUSED` leaking up causes infinite retry loops.

## Ack/reject semantics

- `ack` is called **after** the handler returned successfully **and** all stamps are committed.
- `reject` is called when the handler threw. The RetryMiddleware decides whether the retry budget is exhausted; if exhausted, the envelope is sent to the failure transport (if configured) and then ack'd to remove it from the queue.
- **Never ack and reject the same envelope.** Track state with a `WeakSet` if needed.
- **Idempotency:** ack/reject must be safe to call twice (no-op the second time). Brokers sometimes deliver twice during failover.

## Graceful shutdown

`close()` must:

1. Stop pulling new messages (cancel any internal pollers / consumer tags / XREADGROUP loops via AbortSignal).
2. Wait for in-flight ack/reject promises to settle (use a counter).
3. Close broker connections.
4. Resolve only when all of the above are done.

Test this with a scenario: dispatch 10 slow messages, call `close()` mid-flight, assert all 10 finished before the promise resolved.

## The conformance suite (v0.1 = 10 scenarios)

Every transport package has this in its test file:

```ts
import { runTransportConformanceTests } from '@schally/nestjs-messenger/testing';
import { RedisStreamsTransport } from '../src';

runTransportConformanceTests({
  name: 'RedisStreamsTransport',
  async createTransport() {
    const t = new RedisStreamsTransport({ /* test config */ });
    return { transport: t, cleanup: () => t.close() };
  },
  capabilities: {
    delayedDelivery: true,
    messageCount: true,
    listable: false,
  },
});
```

**The 10 scenarios shipped in v0.1:**

1. `send` then `get` yields the same message (round-trip)
2. `ack` removes the message; subsequent `get` doesn't re-deliver it
3. `reject` triggers redelivery with incremented `RedeliveryStamp.retryCount`
4. `ack` called twice is a no-op on the second call (idempotent)
5. `reject` called twice is a no-op on the second call (idempotent)
6. `AbortSignal` aborted mid-`get` causes the iterator to return cleanly
7. `close()` called while a handler is mid-processing waits for completion
8. Large payload (1 MB) round-trips intact
9. Payload with special characters (UTF-8 emoji, null bytes if supported, quotes) round-trips intact
10. `DelayStamp` is honored within ±200ms (skipped if `capabilities.delayedDelivery === false`)

**Listable transports (added in M7).** Declare `capabilities.listable: true` when the
transport implements `ListableReceiver` + `MessageRetriever` (e.g. it can serve as a
`failureTransport`). That unlocks two more scenarios:

11. `ack()` of a message located via `find()` **removes** it from `list()` — ack *deletes*,
    it is not merely "mark processed". On Redis this means `ack` = `XACK` **+ `XDEL`**.
12. `reject()` redelivery re-appends under a **new** transport id and leaves **no stale
    original** in `list()` (the old entry is `XDEL`'d after the re-`XADD`).

**We grow the suite as bugs teach us new invariants.** When you fix a transport bug, add a scenario that would have caught it. Aim for the suite to outlive the bug.

**Future scenarios** (not blocking v0.1): concurrent consumers don't double-process, stalled message reassignment, message ordering guarantees, transaction across send + commit, etc.

## Common mistakes

- **Using setInterval for polling without unref().** The Node process won't exit cleanly during tests.
- **Forgetting that some brokers retry internally.** If wrapping a broker with built-in retry, either disable it or document clearly which layer owns retry. Our retry middleware is the authoritative source.
- **Holding the broker connection in module scope.** Always inject it so tests can swap it.
- **Serializing with `JSON.stringify` directly.** Use the configured `Serializer` — users may want a custom one for `Date`, `BigInt`, etc.
- **Letting handler errors propagate as broker errors.** Handler errors are *application* errors; broker errors are *infrastructure*. They take different paths through the middleware stack.
- **For Redis Streams specifically: forgetting to `XACK` on success.** Without ack, the message stays in the consumer group's pending list and gets re-delivered after the reaper's claim interval.
- **Poison messages loop forever.** A serializing transport will hit entries it can't decode (unregistered message type, malformed JSON). Do NOT let the decode error throw out of `get()` — the entry never gets acked and the stalled-reaper re-delivers it endlessly. Catch it, `XACK`/discard it (or DLQ it), and keep consuming. Note `SerializationError extends MessengerError`, NOT `TransportError`, so callers branching on `TransportError` won't catch it. (Found by the M6 conformance audit.)
- **Serializing transports need the message classes.** The default `JsonSerializer` can encode anything but can only *decode* registered classes. Construct the transport's serializer with the app's message classes (`new JsonSerializer([FooMessage, ...])`). The conformance suite exports `ConformanceMessage` from `@schally/nestjs-messenger/testing` precisely so a serializing transport's factory can register it.
- **`ack` must delete, not just acknowledge (M7).** Once a transport is `listable`, `ack` has to *remove* the entry, not merely clear the pending/processed flag — otherwise a message inspected via `find()` and acked by `messenger:failed:remove`/`:retry` still shows up in `list()`. On Redis: `XACK` **+ `XDEL`**, and the `reject()` redelivery path must `XDEL` the original after re-appending. Conformance scenarios 11–12 pin this.
- **Don't carry a `DelayStamp` into the failure transport.** A message that exhausts retries was last re-sent *with* a `DelayStamp`; that stamp must be stripped before routing to the failure transport (the `RetryMiddleware` does this), or the dead-letter sits in the failure transport's *delayed buffer* and never surfaces to `messenger:failed:show`/`list()` until something consumes that transport. (Found by the M7 e2e — the bug was invisible until inspection went through `list()` instead of `get()`.)
- **Dates don't survive JSON round-trips.** A stamp field typed `Date` (e.g. `RedeliveryStamp.redeliveredAt`) comes back as an ISO **string** after a serializing transport's round-trip. Normalize at the read boundary (`new Date(value)`) rather than trusting the declared type.

## Reference checklist before merging a transport

- [ ] Implements `TransportInterface` with no `any`
- [ ] Maps all SDK errors to our hierarchy
- [ ] All conformance scenarios pass — the 10 core, plus 11–12 if `listable` (or capability-flagged opt-outs)
- [ ] Coverage meets the transport package threshold (100% on transport code, 95% on glue)
- [ ] Graceful shutdown test exists and passes
- [ ] Docker-compose entry added in `e2e/docker-compose.yml`
- [ ] At least one e2e scenario uses this transport
- [ ] README in the package explains config options, DSN format, and quirks
