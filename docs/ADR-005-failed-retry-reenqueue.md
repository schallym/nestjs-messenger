# ADR-005: `messenger:failed:retry` re-enqueues to the origin transport

**Status:** Accepted (revisit before v1.0)
**Date:** 2026-05-30

## Context

M7 ships the failure-transport CLI: `messenger:failed:show`, `messenger:failed:retry`,
`messenger:failed:remove`. The `symfony-messenger-reference` subagent gave us the exact
Symfony surface to mirror (command names, arguments, options, output columns) and the
load-bearing detail of how Symfony *retries* a dead-lettered message.

**How Symfony retries.** `FailedMessagesRetryCommand` spins up an in-process `Worker`
over the **failure** transport and dispatches each selected envelope **through the bus**.
`FailedMessageProcessingMiddleware` rewrites the envelope's `ReceivedStamp` to the
*original* receiver name (read from `SentToFailureTransportStamp`) so the message "appears
received from its origin transport". On success the worker acks the failure receiver
(removing it). If it fails again, `SendFailedMessageForRetryListener` re-sends to the
original sender with a fresh `DelayStamp` + incremented `RedeliveryStamp`. So Symfony
performs **one immediate, in-CLI handling attempt**.

Our retry/redelivery model already differs from Symfony's (see ADR-004): retry is a
middleware, and the worker acks-on-resolve / rejects-on-throw. Reusing an in-CLI worker
that dispatches through the bus — and reproducing the `ReceivedStamp` rewrite so the
message routes to handlers and not back into the failure transport — would duplicate the
worker's retry/settlement logic inside the command, exactly the drift the reference
warned against ("reuse the worker loop, not reimplement dispatch").

## Decision

`messenger:failed:retry <id>` **re-enqueues** the message onto its origin transport and
removes it from the failure transport. It does **not** run a handling attempt inside the
CLI process.

Concretely, `FailedMessageManager.retry(id)`:

1. `find(id)` on the failure transport.
2. Reads `SentToFailureTransportStamp.originalReceiverName` to locate the origin sender
   via the `SendersLocator` (`getSenderByAlias`). A missing stamp throws `TransportError`;
   an unregistered alias throws `TransportNotFoundError` — both fail loudly rather than
   silently dropping the message.
3. Strips the dead-letter bookkeeping for a clean redelivery: `RedeliveryStamp`,
   `ErrorDetailsStamp`, `SentToFailureTransportStamp`, `ReceivedStamp`,
   `TransportMessageIdStamp`. The origin transport re-stamps a fresh transport id on send.
4. `send()`s to the origin, then `ack()`s the failure transport (which now means XACK +
   XDEL on Redis / queue removal on InMemory — see "Transport changes").

The **observable CLI contract matches Symfony**: after `failed:retry <id>` the message is
gone from the failure transport and is processed by a normal worker on its origin
transport, with a fresh retry budget. The **mechanism differs**: a real worker
(`messenger:consume async`), not the CLI, performs the handling attempt.

### What we mirror exactly vs. simplify (v0.1)

- **Mirror:** command names; `failed:show [id]` (`--max`, default 50); `failed:retry`
  requires explicit id(s) — never an implicit "retry everything"; `failed:remove`
  (`--all`, `--show-messages`); the list columns (`Id | Class | Failed at | Retries |
  Error`) and the single-message detail view with copy-paste retry/remove hints.
- **Simplify:** a single global `failureTransport` (drop `--transport`); non-interactive
  (drop the interactive retry/skip/delete prompt and `--force`/`--keepalive`). These are
  additive to re-introduce later and match v0.1 scope.

## Rationale

- **No duplicated dispatch/settlement.** The handling attempt happens on a real worker,
  which already owns ack/reject and the `RetryMiddleware` flow (ADR-004). The CLI stays a
  thin operator over the transport.
- **Correct routing without the `ReceivedStamp` trick.** We achieve "goes back to its
  origin, not the failure transport" by literally sending to the origin transport, so we
  don't need `FailedMessageProcessingMiddleware`'s synthetic `ReceivedStamp` rewrite.
- **Better fit for distributed deployments.** The CLI process need not have broker
  *consumer* wiring or run handlers; it only needs sender access. Retries are processed by
  the same workers that process everything else, with the same retry strategy.
- **Robustness.** Re-enqueue is a single `send` + `ack`; there is no in-CLI handler
  execution to leave a message half-processed if the CLI dies mid-run.

## Transport changes this required

To let `retry`/`remove` actually delete an inspected message, `ack()` now removes the
entry, and transports expose inspection capabilities:

- **`ListableReceiver.list(limit?)`** and **`MessageRetriever.find(id)`** implemented by
  `InMemoryTransport` and `RedisStreamsTransport` (Redis via `XRANGE`).
- **`ack()` deletes**: Redis `ack()` is now `XACK` **+ `XDEL`** (was `XACK` only);
  InMemory `ack()` also removes the entry from its queue. This keeps the stream from
  growing unbounded *and* makes "ack a message found via `find()`" mean "remove it",
  which `retry`/`remove` rely on. `reject()`'s redelivery path likewise `XDEL`s the
  original after re-appending. Conformance scenario 2 ("ack removes the message") still
  holds.

## Consequences

**Positive**
- The failure CLI is framework-agnostic logic (`FailedMessageManager`) with thin
  nest-commander wrappers; tested at 100% with the InMemory transport and end-to-end
  against Redis.
- One retry/settlement code path (the worker), not two.

**Negative / risks (acknowledged)**
- **Not an *immediate* attempt.** Unlike Symfony, `failed:retry` doesn't show the handler
  result inline; the message is reprocessed asynchronously by a worker. Operators verify
  via the worker logs / a follow-up `failed:show`. Acceptable for v0.1; an
  `--inline`/interactive mode can be added later without changing the default.
- **Requires a configured route for the origin alias.** If the origin transport alias is
  no longer registered, retry fails loudly (`TransportNotFoundError`) — intentional.
- **`ack`-deletes is now part of the transport contract expectation** for failure
  inspection. A transport that cannot delete a specific id can still implement the core
  `TransportInterface`; it simply won't declare `ListableReceiver`/`MessageRetriever`, and
  the CLI degrades (the command throws a clear `TransportError`).

## Revisit trigger

Add Symfony's in-CLI worker-driven retry (with the `ReceivedStamp` rewrite and an
interactive prompt) if: (a) operators need the immediate inline handling result, or
(b) multiple/per-transport failure transports require `--transport` selection. Either is
an additive change to the command surface; the re-enqueue path can remain the default.
