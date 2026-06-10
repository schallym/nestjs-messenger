# ADR-007: Ack/reject idempotency derives from the in-flight registry, not a settled-ids set

**Status:** Accepted
**Date:** 2026-06-10

## Context

`TransportInterface` requires `ack()` and `reject()` to be idempotent (brokers re-deliver
during failover, and the worker must never double-settle). The first four broker transports
(Redis Streams, SQL, Kafka, Google Pub/Sub) implemented this with a per-instance
`settled: Set<string>` of every transport-message id ever acked or rejected, checked at the
top of both methods. Each also kept a separate `inFlight` registry of delivered-but-unsettled
ids, used by `close()` to drain in-flight work before disconnecting.

Two defects followed from the `settled` set:

1. **Unbounded growth.** The set was never pruned. A long-lived worker retains one string per
   processed message — at 100 msg/s that is on the order of hundreds of MB per week, for a
   guard whose useful lifetime ends the moment the delivery is settled.
2. **Id reuse turns a legitimate ack into a silent no-op.** Settled ids were remembered
   forever, but transport ids are only unique within a backend's lifetime. Observed concretely
   while building the SQL transport: dropping and re-creating the table restarts the id
   sequence, the stale `settled` entry for old id 1 swallowed the ack of new id 1, the
   delivery was never released from `inFlight`, and `close()` hung forever on the drain.

Meanwhile `InMemoryTransport` — the reference implementation the conformance suite was
validated against first — never had a `settled` set: its `reject()` is gated on the in-flight
map and its `ack()` relies on queue removal being naturally idempotent. The broker transports
had quietly diverged from the reference, and from each other: rejecting a never-received
envelope was a no-op in memory, a full redeliver on Redis/SQL, and a duplicate-minting
re-publish (copy published, original never committed/acked) on Kafka/Pub/Sub.

## Decision

The **in-flight registry is the only settle state a transport keeps.** It already exists for
the `close()` drain; settling removes the entry; a second settle of the same delivery finds
nothing and no-ops. Settled ids are forgotten immediately. Uniform rules:

1. **`reject()` is gated strictly on in-flight membership.** Redelivery *re-publishes a copy*
   with an incremented `RedeliveryStamp` — not idempotent — so it runs at most once per
   delivery, and never for an envelope the instance did not deliver (re-publishing without
   being able to settle the original would mint a duplicate, which is what Kafka/Pub/Sub did).
2. **`ack()` releases the in-flight entry, then performs the broker acknowledge.**
   - Where the broker op is id-addressed and naturally idempotent — Redis `XACK`+`XDEL`, SQL
     `DELETE` — it runs **ungated**. This is required anyway: the failure-transport CLI and
     the ack-via-find listable conformance scenario ack messages located via `find()`, which
     were never in flight.
   - Where settling needs the in-flight handle — Kafka's partition/offset coordinate,
     Pub/Sub's leased `Message` — a missing handle means there is nothing to settle: no-op.
     (These transports are not listable, so find-sourced acks do not exist for them.)
3. **The entire settle is one tracked promise.** `close()` snapshots its pending-operation
   set the instant the in-flight drain empties — i.e. mid-settle — so a settle split across
   separately tracked steps (Kafka's offset commit after the re-publish, Pub/Sub's trailing
   lease-ack) would escape the snapshot and race the disconnect, stranding the original.
   Multi-step settles compose into a single tracked promise (Kafka `redeliverAndCommit`,
   Pub/Sub `redeliverThenAck`); Redis wraps re-publish + `XACK`/`XDEL` in one tracked
   promise and SQL settles in one DB transaction already.
4. **`InMemoryTransport` is the normative reference** for the model; the contract is spelled
   out on `Receiver.ack`/`Receiver.reject` in `transport.interface.ts`.

Memory for settle bookkeeping is now bounded by the number of concurrently unsettled
deliveries (worker prefetch/concurrency), independent of worker uptime.

## Conformance

Scenarios 4–5 (double ack / double reject are no-ops) pass unchanged. Four scenarios were
added to pin the unified model (the suite grows as bugs teach us invariants):

- **Reject of a never-delivered envelope is a no-op** — no redelivery copy is published.
  This is the only externally observable behavior change: Kafka/Pub/Sub previously published
  a duplicate-prone copy; Redis/SQL previously redelivered. No code path in the worker or the
  failed-message CLI rejects an undelivered envelope, so nothing depended on the old behavior.
- **Reject after ack of the same delivery is a no-op** — no redelivery.
- **Ack after reject of the same delivery is a no-op** — the redelivered copy survives it.
- **close() waits for an in-flight reject to settle** — the whole settle, re-publish *and*
  acknowledge/commit of the original (pins decision rule 3; found by review of this ADR's
  first implementation, where Kafka and Pub/Sub tracked only the re-publish).

The SQL table-recreation case is pinned by the postgres `setup() re-creates a dropped schema`
test, which now consumes and acks through the *same* transport instance — the exact sequence
that used to hang `close()`.

## Consequences

- Per-instance settle state is O(in-flight), uniform across all five transports.
- The SQL re-created-table hang is gone; schema-recreation tests no longer need a fresh
  consumer instance.
- A reject of an envelope that is not currently in flight is now uniformly a no-op. Callers
  cannot "reject by id" something they never received — by design, since transport-level
  redelivery is a per-delivery operation.
- Residual hazard (accepted): with no memory of settled ids, acking a *stale* envelope held
  across a backend id-reuse event (e.g. an unsettled envelope kept across a table drop/
  re-create) performs a real id-addressed delete that can hit an innocent reused id. The old
  design failed in the opposite direction (legitimate ack swallowed, `close()` hang) — which,
  unlike the stale-envelope scenario, actually occurred. Production id sequences do not
  restart within a table's lifetime.
- Future transports (e.g. AMQP in v0.2) must follow this model; the conformance suite and the
  `transport-implementation` skill encode it.
