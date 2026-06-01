# ADR-003: Redis transport uses Redis Streams directly, not BullMQ

**Status:** Accepted
**Date:** 2026-05-27

## Context

The Redis transport could be implemented in two ways:

1. **Wrap BullMQ.** Use BullMQ's job queue as the underlying primitive. Map envelopes to BullMQ jobs.
2. **Speak Redis Streams directly.** Use `XADD`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM` against Redis.

Wrapping BullMQ would save 2-3 weeks of implementation work and gives free monitoring (Bull Board). The NestJS community already knows BullMQ.

Speaking Redis Streams directly is more code, but it aligns with how Symfony Messenger's Redis transport works (it uses Streams), and it avoids architectural problems described below.

## Decision

Implement `@schally/nestjs-messenger-transport-redis` directly on Redis Streams. Do NOT depend on `bullmq`.

## Rationale

Wrapping BullMQ creates **double-layered semantics** that conflict with the Messenger model:

- **Double retry layer.** BullMQ retries jobs internally. Our `RetryMiddleware` retries too. Which one is authoritative? Either we disable BullMQ's retries (and use BullMQ for nothing it's good at), or we keep both and confuse users about retry behavior.
- **Double scheduling layer.** Same problem for delayed jobs.
- **Double DLQ.** BullMQ has its `failed` set; we have a failure transport. Two competing concepts.
- **Model mismatch.** BullMQ thinks in terms of jobs with IDs, states, progress, and lifecycle events. Messenger thinks in terms of envelopes with stamps. Mapping the two adds translation overhead at every transport call and leaks abstractions.
- **Philosophical inconsistency.** A library that "abstracts queues" but delegates to a queue library is conceptually muddled. Symfony Messenger doesn't wrap another PHP queue library — it speaks the broker protocol.

Going direct on Streams costs us 2-3 weeks. The result is a transport that:
- Owns retry/delay/DLQ semantics end-to-end.
- Maps cleanly to Messenger's model.
- Doesn't inherit BullMQ's API surface or bugs.
- Can be optimized for our access patterns (we don't need progress, observability events, etc., that BullMQ implements).

## Consequences

**Positive:**
- Single source of truth for retry, delay, and failure semantics.
- No "double layer" confusion in user-facing docs.
- Smaller dependency footprint (`ioredis` only).
- Cleaner conformance with the Messenger model.
- Easier reasoning about edge cases (one layer of state, not two).

**Negative:**
- 2-3 weeks of additional implementation time on the Redis transport.
- We must implement our own stalled-message reaper (Bull does this for us). The pattern is well-documented (`XPENDING` + `XCLAIM` on a timer); not technically hard, but it's code we own.
- No free Bull Board monitoring. We may build an equivalent later as a separate optional package.
- Users coming from BullMQ have a learning curve. We mitigate with a migration guide in the v0.1 docs.

## Future option

If, post-v0.1, there's strong community demand for a BullMQ-backed transport (e.g., for teams already on BullMQ who want gradual migration), we can ship `@schally/nestjs-messenger-transport-redis-bullmq` as an **optional alternative** package. The main `transport-redis` package remains the reference Streams implementation.

## Enforcement

`packages/transport-redis/package.json` MUST NOT list `bullmq` as a dependency or peer dependency. The `transport-conformance-checker` subagent explicitly checks for any `bullmq` imports in the package and fails the audit if found.
