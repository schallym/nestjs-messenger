# ADR-004: Retry lives in a middleware, not in the worker

**Status:** Accepted (revisit before v1.0)
**Date:** 2026-05-29

## Context

Symfony Messenger does retry in the **worker**, not in a middleware. When a handler
throws, `HandleMessageMiddleware` raises `HandlerFailedException`; the worker catches
it, emits `WorkerMessageFailedEvent`, and `SendFailedMessageForRetryListener` decides
— via the transport's `RetryStrategy` — whether to re-send (with an incremented
`RedeliveryStamp` + `DelayStamp`) and ack the original, or route to the failure
transport and reject. Ack/reject and re-send are coordinated by the worker because
they must settle with the broker.

Our M2 implements retry as a `RetryMiddleware` sitting between `SendMessageMiddleware`
and `HandleMessageMiddleware`. This was the design already described in the project's
`middleware-design` skill, the `examples/quickstart` failure-flow section, and the
ROADMAP M2 deliverables.

The `symfony-messenger-reference` review of M2 flagged the divergence and its main
risk (see Consequences).

## Decision

For v0.1, **keep retry as a middleware** (`RetryMiddleware`). Revisit moving it into
the worker before v1.0, informed by what M5 (worker) and M6 (Redis Streams) teach us
about ack/reject coordination.

### Worker integration (decided in M5)

The desired behaviour is: **retry according to the configured strategy, then push the
message to the failure queue.** That is exactly what `RetryMiddleware` does, so the
worker stays dumb and the ack/reject decision is driven by the pipeline's outcome:

- **The pipeline resolves → the worker `ack`s.** This covers success, a scheduled retry
  (the envelope was re-sent to its origin with `RedeliveryStamp` + `DelayStamp`), and an
  exhausted message routed to the failure transport. In every case the original message
  has been dealt with, so it is removed.
- **The pipeline throws → the worker `reject`s.** `RetryMiddleware` only re-throws
  *infrastructure* errors (anything that is not a `HandlerFailedError`). Reject lets the
  transport recover/redeliver the infrastructure failure.

Consequently `RetryMiddleware` **returns normally** after routing to the failure
transport (rather than re-throwing as it did in M2). This also resolves the M3 tension
between the transport's own `reject()`-redelivers contract and middleware-driven retry:
the worker never calls `reject()` for *handler* failures (the middleware owns redelivery
by re-sending), so there is no double-redelivery. `reject()` is reserved for the
infrastructure-error path.

A misconfigured `failureTransport` (alias not resolvable) throws `TransportNotFoundError`
— an infrastructure error — surfacing the wiring bug rather than silently dropping the
message. With no `failureTransport` configured at all, an exhausted message is dropped
(returned, then acked) to avoid an infinite redelivery loop.

### Two redelivery paths, kept disjoint

A whole-project review (vs. Symfony, where `reject()` = discard and redelivery is always
a worker-driven re-`send()`) noted we have two places that can put a message back:

1. **Handler-failure retry** — owned by `RetryMiddleware`, which re-`send()`s a *new*
   envelope (fresh transport id) to the origin with `RedeliveryStamp` + `DelayStamp`.
2. **Transport `reject()`** — our `Receiver.reject()` redelivers with an incremented
   `RedeliveryStamp` (conformance scenario 3). This is the *infrastructure-error*
   recovery path and models broker-driven redelivery (a real broker re-queues on nack).

They are **mutually exclusive per message**: the worker acks when the pipeline resolves
(path 1 already handled the failure) and only rejects when the pipeline throws an
*infrastructure* error (path 2). A single failure never triggers both increments.

This is a deliberate adaptation, not an oversight. If a future transport's `reject()`
naturally means "discard" (or "broker re-queues without our stamp"), we will make
"reject redelivers with RedeliveryStamp" an **opt-in conformance capability** (like
`delayedDelivery`) rather than a universal contract.

## Rationale

- **Consistency with our own model.** Our quickstart, skill, and roadmap already
  present retry as a middleware. The middleware composes in the same onion the rest
  of the pipeline uses, which is the project's mental model.
- **Transport-agnostic.** `RetryMiddleware` depends only on the framework-agnostic
  `RetryStrategy` and `SendersLocator`; it works against any transport without the
  worker needing transport-specific knowledge.
- **Simplicity for v0.1.** It avoids building the worker event system
  (`WorkerMessageFailedEvent`/`WorkerMessageRetriedEvent`) before the worker exists.

## Consequences

**Positive**
- Retry is testable in isolation with fakes (no broker, no worker) — see
  `retry.middleware.spec.ts`.
- One composition model (middleware) for the whole pipeline.

**Negative / risks (acknowledged)**
- **Side that runs it is implicit.** `RetryMiddleware` is inert on the dispatch side
  (no `ReceivedStamp`) and only active on the consume side. Symfony avoids this by
  putting retry in the worker, which is unambiguously the consume side.
- **Ack/reject is driven by whether the middleware throws.** A normal return (handled,
  or re-sent for retry) ⇒ the worker acks; a throw (retries exhausted) ⇒ the worker
  rejects. This couples worker settlement to middleware control flow rather than to
  explicit events.
- **Partial-failure on re-send.** If `sender.send()` for the retry copy fails *after*
  we decided to retry, a non-`HandlerFailedError` propagates. Symfony's worker handles
  "publishing for retry itself failed" explicitly. **Mitigation:** M5 must add a worker
  test for "re-send-for-retry fails ⇒ message is neither lost nor double-delivered",
  and we hardened the misconfigured-failure-transport path to fail loudly
  (`TransportNotFoundError`) rather than silently drop.
- **No `WorkerMessageRetriedEvent`/`WorkerMessageFailedEvent` hooks** that Messenger
  users may expect. If observability demand appears, that pushes us toward the worker
  model.

## Revisit trigger

Move retry into the worker if any of: (a) the partial-failure coordination proves
unmanageable in M5/M6, (b) users need worker retry/failure events, or (c) a second
transport reveals broker-settlement coupling the middleware can't express cleanly.
Such a move would be a breaking change to the pipeline assembly; acceptable pre-1.0.
