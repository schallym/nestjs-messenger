# @schally/nestjs-messenger

## [1.0.0](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-v0.1.3...nestjs-messenger-v1.0.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* up versions to 1.0.0

### Features

* up versions to 1.0.0 ([d51a578](https://github.com/schallym/nestjs-messenger/commit/d51a578c669a41efc7b19a3081d2a70b8b9de082))

## [0.1.3](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-v0.1.2...nestjs-messenger-v0.1.3) (2026-06-01)


### Bug Fixes

* **cli:** handle --all option gracefully in failed message removal command ([50e321b](https://github.com/schallym/nestjs-messenger/commit/50e321b5722cc33a044a04b30a682fb55a8c1220))

## [0.1.2](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-v0.1.1...nestjs-messenger-v0.1.2) (2026-06-01)


### Bug Fixes

* **cli:** add end-to-end tests for messenger CLI commands and fix imports issues ([7ef29a0](https://github.com/schallym/nestjs-messenger/commit/7ef29a05bed5591ab741269eb34cd61b1bd80ab3))

## [0.1.1](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-v0.1.0...nestjs-messenger-v0.1.1) (2026-06-01)


### Bug Fixes

* add contributor acknowledgment to README ([16485ef](https://github.com/schallym/nestjs-messenger/commit/16485ef2a5f8d4652a8d2b605750859773ba5ac4))

## 0.1.0

### Minor Changes

- Initial public release — v0.1.0.

  `@schally/nestjs-messenger` brings Symfony Messenger's developer experience to NestJS:
  - **Envelope + Stamps** — messages are plain classes wrapped in an `Envelope` carrying typed metadata stamps (`BusNameStamp`, `SentStamp`, `ReceivedStamp`, `TransportMessageIdStamp`, `DelayStamp`, `RedeliveryStamp`, `HandledStamp`, `ErrorDetailsStamp`, `SentToFailureTransportStamp`).
  - **MessageBus + middleware pipeline** — an onion of composable middlewares (`AddBusNameStamp → FailedMessageProcessing → [user] → SendMessage → [Retry] → HandleMessage`).
  - **Transports** — a `TransportInterface` (async-iterator receivers, `AbortSignal` cancellation, graceful `close()`), the in-process `InMemoryTransport`, and a 12-scenario conformance suite exported from `@schally/nestjs-messenger/testing`.
  - **Retry + failure transport** — `MultiplierRetryStrategy` (backoff, jitter, max delay); exhausted retries route to a configurable failure transport.
  - **NestJS integration** — `MessengerModule.forRoot`/`forRootAsync`, `@MessageHandler`, and automatic handler discovery.
  - **CLI** (`@schally/nestjs-messenger/cli`) — `messenger:consume` (`--limit` / `--time-limit` / `--memory-limit`) and `messenger:failed:show` / `:retry` / `:remove`.
  - **Typed error hierarchy** and strict TypeScript throughout (no `any`).

  `@schally/nestjs-messenger-transport-redis` is the reference Redis transport, built **directly on Redis Streams** (`XADD` / `XREADGROUP` / `XACK` / `XAUTOCLAIM`) via `ioredis` — **not** BullMQ (see ADR-003). It supports delayed delivery, a stalled-message reaper, poison-message handling, and the failure-inspection capabilities (`list` / `find`, ack-deletes).
