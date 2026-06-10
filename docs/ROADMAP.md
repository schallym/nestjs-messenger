# Roadmap v0.1.0

Order of attack. Each milestone is a PR-sized chunk and a natural prompt for Claude Code.

## M0 — Monorepo skeleton (day 1)

- `pnpm-workspace.yaml`, `turbo.json`, root `tsconfig.json` with project references
- Root `package.json` with scripts: `build`, `test`, `test:coverage`, `test:e2e`, `lint`, `dev:brokers`
- **Lint stack** per CLAUDE.md Rule 9:
  - ESLint with `@typescript-eslint/strict-type-checked` + `stylistic-type-checked`
  - `eslint-plugin-boundaries` (enforces framework-agnostic / nestjs / cli boundaries)
  - `eslint-plugin-import`, `eslint-plugin-unicorn`, `eslint-plugin-promise`
  - Custom rules: no enums, no default exports, complexity ≤ 10, max file length 300/500
  - Prettier integrated, runs in pre-commit
- TypeScript: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- Jest config per package with the **differentiated coverage thresholds** (see CLAUDE.md Rule 2)
- GitHub Actions: lint, typecheck, unit, e2e (docker-compose with healthchecks + `--wait`), coverage upload
- Conventional-commit releases configured (release-please)
- Empty packages: `messenger` (single main package), `transport-redis`
- The 3 ADR files in `docs/` documenting the structural choices

**Prompt:** "Set up the monorepo skeleton per CLAUDE.md. Single main package `@schally/nestjs-messenger`, plus `@schally/nestjs-messenger-transport-redis`. Use pnpm workspaces, Turborepo, Jest with the differentiated coverage thresholds per Rule 2. Install the full lint stack per Rule 9 — this is mandatory at M0, not a later polish. Add `eslint-plugin-boundaries` to enforce the import boundaries. Write ADR-001 (single package), ADR-002 (coverage policy), ADR-003 (Redis Streams not BullMQ)."

## M1 — Core primitives (week 1)

- `Envelope` class (immutable, `with()`, `last()`, `all()`)
- Base stamp classes: `SentStamp`, `ReceivedStamp`, `TransportMessageIdStamp`, `BusNameStamp`, `DelayStamp`, `RedeliveryStamp`, `HandledStamp`, `ErrorDetailsStamp`
- `TransportInterface` and capability interfaces
- `Serializer` interface + JSON default
- Typed error hierarchy
- **100% coverage on every file in these modules** (Rule 2, strict tier)

**Prompt:** "Implement core primitives in `packages/messenger/src/{envelope,stamps,transport,serializer}/` per CLAUDE.md and the transport-implementation skill. Start with Envelope, then stamps, then TransportInterface. Write tests as you go, targeting 100% coverage. These modules are framework-agnostic — no NestJS imports."

## M2 — Bus and middleware (week 1-2)

- `MessageBus` class in `packages/messenger/src/bus/`
- `MiddlewareStack` (the onion runner) in `packages/messenger/src/middleware/`
- Canonical middlewares: `AddBusNameStampMiddleware`, `SendMessageMiddleware`, `HandleMessageMiddleware`, `FailedMessageProcessingMiddleware`
- `HandlerRegistry` (in-memory, framework-agnostic) in `packages/messenger/src/handler/registry.ts`
- `RetryMiddleware` + `MultiplierRetryStrategy` in `packages/messenger/src/retry/`
- **100% coverage** (strict tier)

**Prompt:** "Implement the bus and middleware pipeline per CLAUDE.md and the middleware-design skill. Follow the canonical order. Use the symfony-messenger-reference subagent to verify default middleware order matches Symfony before finalizing."

## M3 — InMemory transport + conformance suite (week 2)

- `InMemoryTransport` in `packages/messenger/src/transport/in-memory.ts` (reference implementation)
- `runTransportConformanceTests` exported from `packages/messenger/src/testing/`
- **The 10 v0.1 scenarios** documented in `transport-implementation` skill
- InMemory passes all 10 scenarios
- 100% coverage on the suite and the InMemory transport

**Prompt:** "Build the InMemory transport AND the conformance test suite together. The suite is exported from `@schally/nestjs-messenger/testing` (subpath export). Implement only the 10 scenarios listed in the transport-implementation skill. Use the transport-conformance-checker subagent on the result before claiming done."

## M4 — NestJS integration (week 2-3)

- `MessengerModule.forRoot()` and `forRootAsync()` in `packages/messenger/src/nestjs/messenger.module.ts`
- `@MessageHandler(MessageClass)` decorator in `packages/messenger/src/nestjs/decorators/`
- `DiscoveryService`-based handler scanning in `packages/messenger/src/handler/discovery.ts`
- Bridge from NestJS DI to core's `HandlerRegistry`
- Coverage at the relaxed tier (95% lines / 90% branches)
- Example app under `examples/basic-nest-app/`

**Prompt:** "Wire core into NestJS in `packages/messenger/src/nestjs/`. Implement MessengerModule.forRoot, the @MessageHandler decorator, and handler discovery. Keep all framework-agnostic logic in the other modules — this directory is glue only. Boundary lint must pass: `nestjs/` can import from `envelope/`/`bus/`/etc, but not the reverse."

## M5 — Worker and CLI (week 3)

- `Worker` class in `packages/messenger/src/cli/worker.ts`
- `nest-commander`-based `messenger:consume <transport>` command
- Options: `--limit`, `--memory-limit`, `--time-limit`, `--queues`
- Graceful shutdown on SIGTERM/SIGINT
- Counter-based limit triggers worker.close() and process.exit(0)
- E2E test asserting `--limit=10` actually stops at 10

**Prompt:** "Build the Worker and the consume CLI command in `packages/messenger/src/cli/`. Mirror Symfony's `messenger:consume` options exactly — use the symfony-messenger-reference subagent to verify option names. Graceful shutdown must wait for in-flight handlers. Add an e2e scenario per the e2e-testing skill."

## M6 — Redis Streams transport (week 4)

- `RedisStreamsTransport` in `packages/transport-redis/src/`
- **Built on Redis Streams (`XADD`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM`) — NOT BullMQ**
- DSN parsing (`redis://...`)
- Delayed delivery via a `ZADD`-based sorted set + reaper
- Stalled-message reaper using `XPENDING` + `XCLAIM`
- All 10 conformance scenarios pass
- E2E scenarios: round-trip, retry-then-success, retry-exhausted-to-failure, graceful-shutdown-mid-flight
- **100% coverage on the transport implementation** (strict tier), 95%/90% on glue

**Prompt:** "Implement the Redis Streams transport in `packages/transport-redis`. Follow the transport-implementation skill. The package depends on `ioredis`, NOT on `bullmq` (this is enforced — see ADR-003). Run the transport-conformance-checker subagent before opening the PR."

## M7 — Failure transport + CLI (week 4-5)

- Routing exhausted retries to the failure transport — already owned by `RetryMiddleware`
  (M5, ADR-004); no separate `FailureSendingMiddleware` was needed.
- `ListableReceiver.list()` / `MessageRetriever.find()` on InMemory + Redis; `ack()` now
  *deletes* the entry (Redis `XACK` + `XDEL`) so an inspected message can be removed.
- `FailedMessageManager` (framework-agnostic): `list` / `view` / `retry` / `retryAll` / `remove`.
- `messenger:failed:show` / `:retry` / `:remove` CLI (nest-commander), mirroring Symfony's
  command surface; single global failure transport, non-interactive (ADR-005).
- `failed:retry` **re-enqueues to the origin transport** rather than running an in-CLI
  handling attempt (ADR-005); a real worker reprocesses it with a fresh retry budget.
- Two new conformance scenarios (ack-deletes; redeliver leaves no stale original), gated on
  the `listable` capability.
- E2E full failure flow against Redis: dead-letter → `failed:show` → `failed:retry` → success,
  plus `failed:remove`.

**Prompt:** "Add failure transport support. The failure transport is just another transport (any backend) configured under a special name. CLI commands mirror Symfony exactly — verify with the symfony-messenger-reference subagent."

## M8 — Docs and v0.1.0 release (week 5)

- Root README rewritten into a runnable 6-step quickstart (install → message → handler →
  routing → dispatch → worker), mirroring Symfony Messenger's structure against the
  **shipped** API (transport factories, `retry:`, `CommandFactory` CLI bootstrap).
- Per-package READMEs (`packages/messenger`, `packages/transport-redis`).
- BullMQ migration guide (`docs/migration-from-bullmq.md`): concept map + side-by-side code.
- `examples/quickstart` corrected to the shipped API.
- Release plumbing: npm metadata (keywords/repository/homepage/bugs) on both packages,
  both seeded at `0.1.0`, and a conventional-commit `release.yml` (release-please) that
  computes versions from commit messages (`fix:`→patch, `feat:`→minor,
  `feat!:`/`BREAKING CHANGE:`→major), maintains a release PR + CHANGELOGs, and publishes
  to npm on merge.
- **The actual `npm publish` is the human-run final step** (merge the release PR / set
  `NPM_TOKEN`); blog post is out of scope for the repo.

**Prompt:** "Write docs for v0.1.0. README quickstart should be readable in 5 minutes and runnable in 10. Cover: install, define a message, define a handler, configure routing, dispatch, run the worker. Include the BullMQ migration guide showing how a typical BullMQ codebase maps to the messenger API."

## Deferred to v1.0

- transport-google-pubsub
- transport-sqs 
- transport-kafka
- transport-amqp (RabbitMQ)
- Multiple buses (command/query/event split)
- ~~transport-doctrine (TypeORM/Prisma)~~ → shipped as `transport-sql` on raw `pg`/`mysql2`
  drivers, no ORM (see ADR-006)
