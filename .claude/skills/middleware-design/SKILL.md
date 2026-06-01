---
name: middleware-design
description: Use when writing or modifying a middleware in packages/messenger/src/middleware, when designing the dispatch pipeline, or when the order of middlewares matters. Covers the onion model, the next() contract, stamp manipulation rules, transaction-aware middlewares, and the canonical pipeline order. Trigger on any change to middleware classes or to the MessageBus.
---

# Middleware design

Middlewares are the spine of the bus. Every behavior that isn't "call the handler" lives in a middleware: routing decisions, retry logic, logging, metrics, validation, transactions, deduplication.

## The contract

```ts
export interface Middleware {
  handle(envelope: Envelope, next: StackInterface): Promise<Envelope>;
}

// The continuation is *callable*: invoking it advances the pipeline one step and
// returns the next middleware to run. This is what makes `next().handle(envelope, next)`
// type-check (it matches the public quickstart example, which is the source of truth).
export type StackInterface = () => Middleware;
```

A middleware:

1. Receives an envelope.
2. Optionally inspects/modifies it (add stamps, never remove user stamps).
3. Calls `next().handle(envelope, next)` to continue the pipeline (or doesn't, if it short-circuits).
4. Optionally inspects/modifies the returned envelope.
5. Returns the (possibly modified) envelope.

The runner is `MiddlewareStack` (in `middleware/middleware-stack.ts`): `new MiddlewareStack(middlewares).run(envelope)`. It builds the callable continuation with an internal cursor and falls back to a passthrough terminal once the list is exhausted. The `MessageBus` is a thin wrapper that wraps the message in an `Envelope` and runs the stack; **assembling the canonical middleware order is the configuration layer's job (the NestJS module, M4), not the bus's**.

The classic onion: code before `next()` runs on the way in, code after runs on the way out.

## Boundary rule (don't break it)

Middlewares live in `packages/messenger/src/middleware/` which is a framework-agnostic module. **No NestJS imports allowed here.** If a middleware needs framework services, it receives them via constructor injection of plain instances, configured at module init time by the NestJS adapter in `packages/messenger/src/nestjs/`.

ESLint enforces this via `eslint-plugin-boundaries`. Violations fail CI.

## Canonical pipeline order (matches Symfony Messenger)

Default `forRoot()` registers middlewares in this exact order:

1. **AddBusNameStampMiddleware** — tags the envelope with the bus name (we may have multiple buses).
2. **DispatchAfterCurrentBusMiddleware** — defers nested dispatches until the outer one finishes. *(Deferred past M2; not yet implemented.)*
3. **FailedMessageProcessingMiddleware** — special handling when re-dispatching from the failure transport.
4. **User-registered middlewares** (in registration order) — validation, logging, tracing, transactions.
5. **SendMessageMiddleware** — if the message is routed to async transport(s), sends it and short-circuits.
6. **RetryMiddleware** — wraps the handler so it can catch `HandlerFailedError`, re-send for retry, or route to the failure transport. Sits between SendMessage and HandleMessage (on the receiver side it wraps HandleMessage; on the sender side SendMessage short-circuits before it).
7. **HandleMessageMiddleware** — terminal: looks up the handler(s) and invokes them, attaches `HandledStamp`.

**The send/handle split is critical.** A message routed to a transport is sent and the pipeline ends there. The worker later picks it up, builds a fresh envelope with `ReceivedStamp`, and runs it through a *receiver* pipeline that skips `SendMessageMiddleware` (because `ReceivedStamp` is present) and proceeds to `HandleMessageMiddleware`.

## Sender vs Receiver pipeline

Same middleware stack, different short-circuits:

- **Sender side** (initial `dispatch()`): runs until `SendMessageMiddleware`, which sees no `ReceivedStamp`, sends to transport, returns early.
- **Receiver side** (worker pulled): same stack, but `SendMessageMiddleware` sees `ReceivedStamp` and is a no-op, so the pipeline continues to `HandleMessageMiddleware`.

This is why the order matters and why `SendMessageMiddleware` must come *after* user middlewares (so user middlewares run on both send and receive) but *before* `HandleMessageMiddleware`.

## Stamp manipulation rules

- **Never mutate an envelope.** `Envelope.with(stamp)` returns a new one. Treat envelopes as immutable.
- **Never remove a stamp another middleware added.** If you need to "consume" information, read it but leave the stamp.
- **Stamps are typed by class.** `envelope.last(SentStamp)` returns the most recent, `envelope.all(SentStamp)` returns all. Multiple stamps of the same class are allowed and meaningful (e.g., one `SentStamp` per transport when routed to multiple).
- **Stamps are serialized with the envelope** when crossing a transport. Make stamp classes JSON-friendly (plain data, no circular refs, no functions).

## Writing a retry middleware (worked example)

The retry strategy lives in middleware, not in the transport, because it must be transport-agnostic.

Pseudo-implementation:

```ts
class RetryMiddleware implements Middleware {
  constructor(private strategy: RetryStrategy, private failureSender?: SenderInterface) {}

  async handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    try {
      return await next().handle(envelope, next);
    } catch (err) {
      // Only retry handler errors, not transport/serialization errors
      if (!(err instanceof HandlerFailedError)) throw err;

      const redelivery = envelope.last(RedeliveryStamp);
      const attempt = (redelivery?.retryCount ?? 0) + 1;

      if (this.strategy.isRetryable(err, attempt)) {
        const delay = this.strategy.getDelay(attempt);
        const retryEnvelope = envelope
          .with(new RedeliveryStamp(attempt, new Date()))
          .with(new DelayStamp(delay));
        // Re-send to its origin transport; ack original
        await this.resendToOrigin(retryEnvelope);
        return retryEnvelope;
      }

      // Out of budget: route to failure transport, then ack original to remove
      if (this.failureSender) {
        await this.failureSender.send(envelope.with(new ErrorDetailsStamp(err)));
      }
      throw err; // Worker will reject (which now means ack to remove)
    }
  }
}
```

Notes:
- `HandlerFailedError` wraps the user's exception with the envelope, thrown by `HandleMessageMiddleware`. Don't catch raw `Error`.
- `DelayStamp` is honored by the transport on the next send.
- We re-send to the origin transport (read from `ReceivedStamp.transportName`) rather than dispatching anew, to skip routing.

## Transaction-aware middlewares

If users want "the handler runs inside a DB transaction, and outgoing messages are dispatched only on commit," they need:

- A `TransactionMiddleware` that wraps `next()` in a transaction.
- A `TransactionalOutboxMiddleware` that delays `SendMessageMiddleware` sends until the transaction commits.

We won't ship these in v0.1 but the architecture must allow them. **Don't bake "send immediately" assumptions into `SendMessageMiddleware`** — make the actual send call go through an injectable `SenderDispatcher` so a transactional version can replace it.

## How to test a middleware

- Unit test in isolation with a fake `StackInterface` that captures whether `next` was called and with which envelope.
- Test the stamp it adds (before next), the stamp it adds after (post-next), and the short-circuit case (didn't call next).
- Integration test: register it in a real bus with the InMemory transport and assert end-to-end behavior.

Don't test middlewares against mocked envelopes/stamps — use real ones. The Envelope API is cheap and the test reads better.

## Common mistakes

- **Calling `next()` twice.** Each middleware calls `next().handle()` at most once. Calling twice triggers two pipeline runs and corrupts stamps.
- **Forgetting to `await` next.** Async errors become unhandled rejections.
- **Mutating stamps.** Stamps are value objects. Build a new one and re-stamp the envelope.
- **Order-dependent middleware logic without documenting it.** If your middleware only works after another, write a runtime check or at least a comment.
- **Importing from `nestjs/` or `cli/` in a middleware.** Boundary violation. The NestJS adapter constructs middlewares with the deps they need at module init time.
