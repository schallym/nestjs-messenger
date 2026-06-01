# nestjs-messenger

A NestJS module that brings Symfony Messenger's developer experience to the NestJS ecosystem: a unified message bus with pluggable transports (Redis, RabbitMQ, SQL, Google Pub/Sub, in-memory), middleware pipeline, envelope/stamps system, retry strategies, failure transport, and a `consume` CLI with `--limit` / `--memory-limit` / `--time-limit` options.

## Project north star

We are building the library we wish existed. The reference for behavior is Symfony Messenger (https://symfony.com/doc/current/messenger.html). When in doubt about API design, mirror Messenger's mental model, then adapt to TypeScript/NestJS idioms.

**Non-goal:** we are NOT a thin wrapper around BullMQ. The Redis transport is implemented directly on Redis Streams. BullMQ may exist as an *optional alternative* transport later if there's demand, but it is not the reference Redis implementation.

## Core architecture (read this before touching code)

```
┌──────────────────────────────────────────────────────────────┐
│                    User code (handlers)                      │
└──────────────────────────────────────────────────────────────┘
                            │ dispatch(message)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  MessageBus  →  Middleware pipeline (onion)  →  Handler      │
│                                                              │
│  Middlewares: SendMessage, HandleMessage, AddBusName,        │
│               FailedMessageProcessing, ...                   │
└──────────────────────────────────────────────────────────────┘
                            │ if async
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Transport (Redis Streams | RabbitMQ | SQL | PubSub | InMem) │
│  - send(envelope) → SentStamp                                │
│  - get() → AsyncIterable<Envelope>                           │
│  - ack(envelope) / reject(envelope)                          │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │  Worker (CLI)      │
                  │  consume command   │
                  └────────────────────┘
```

### Key concepts (use this exact vocabulary in code & docs)

- **Message**: a plain class instance describing intent (`SendEmailMessage`, `GenerateReportMessage`).
- **Envelope**: a wrapper around a message that carries **stamps** (metadata).
- **Stamp**: typed metadata attached to envelopes (`BusNameStamp`, `SentStamp`, `ReceivedStamp`, `DelayStamp`, `TransportMessageIdStamp`, `RedeliveryStamp`, `HandledStamp`, `ErrorDetailsStamp`).
- **Handler**: a class with a method that processes one message type.
- **MessageBus**: orchestrates dispatch through middlewares.
- **Middleware**: composable behavior in the dispatch pipeline (`next` style).
- **Transport**: pluggable backend that persists/delivers envelopes.
- **Sender**: abstraction for "where do I send this message" (a transport in send mode).
- **Receiver**: abstraction for "where do I pull messages from" (a transport in receive mode).
- **Worker**: the loop that pulls from receivers and dispatches.
- **Routing**: config that maps `MessageClass → transport name(s)`.

If you find yourself inventing a new word for one of these concepts, STOP and use the existing one.

## Repository layout

We ship as a **single package** for v0.1 (`@schally/nestjs-messenger`). Internal modules give us logical separation; we do NOT split into `core` + `nestjs` packages yet. The day a non-NestJS consumer appears, we factor with a real use case in mind. See `docs/ADR-001-single-package.md`.

Transports are separate packages so users only pull what they need.

```
packages/
  messenger/                    # the main package
    src/
      envelope/                 # framework-agnostic
      stamps/                   # framework-agnostic
      bus/                      # framework-agnostic
      middleware/               # framework-agnostic
      transport/                # interface + InMemory + conformance suite
      handler/                  # framework-agnostic registry + NestJS bridge
      retry/                    # framework-agnostic
      serializer/               # framework-agnostic
      nestjs/                   # MessengerModule, decorators, discovery
      cli/                      # nest-commander commands
      testing/                  # conformance suite + test helpers (exported)
    test/                       # unit tests (Jest)
  transport-redis/              # Redis Streams (NOT BullMQ)
  transport-amqp/               # RabbitMQ (v0.2)
  transport-doctrine/           # SQL (v0.2)
  transport-google-pubsub/      # Google Pub/Sub (v0.2)
e2e/
  docker-compose.yml            # used by BOTH CI and local dev
  scenarios/
docs/
  ADR-001-single-package.md
  ADR-002-coverage-policy.md
  ADR-003-redis-streams-not-bullmq.md
```

The monorepo uses **pnpm workspaces** + **Turborepo**. Each package is independently publishable on npm.

## Non-negotiable engineering rules

1. **Logical separation, single package.** Inside `packages/messenger`, the `nestjs/` and `cli/` directories MAY import from `envelope/`, `stamps/`, `bus/`, etc. The reverse is forbidden: `envelope/`, `stamps/`, `bus/`, `middleware/`, `transport/`, `handler/registry.ts`, `retry/`, `serializer/` MUST NOT import from `nestjs/` or `cli/`. Enforced by an ESLint boundary rule (`eslint-plugin-boundaries`).

2. **Pragmatic coverage, enforced by CI.**
   - **Framework-agnostic modules** (`envelope/`, `stamps/`, `bus/`, `middleware/`, `transport/`, `retry/`, `serializer/`): **100%** branches / lines / functions / statements.
   - **NestJS integration** (`nestjs/`, `cli/`, `handler/discovery.ts`): **95% lines / 90% branches**.
   - **Each transport package**: **100%** on the transport implementation itself, **95%** on glue.
   - E2E tests do NOT count toward coverage.
   - PRs that drop coverage below threshold are rejected. Untestable lines use `/* istanbul ignore next -- @preserve <reason> */` with reviewer approval.

3. **Transports are tested against a shared conformance suite.** `packages/messenger/src/testing/transport-conformance.ts` exports `runTransportConformanceTests(factory)`. **v0.1 ships 10 scenarios** (round-trip, ack idempotent, reject idempotent, redelivery count increment, AbortSignal cancels get(), close waits for in-flight, large payload, special chars, concurrent consumers, delay stamp honored or explicitly opted out). We grow the suite as bugs teach us new invariants.

4. **No `any`. No `@ts-ignore`.** `strict: true` everywhere, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Use generics and discriminated unions.

5. **Public API is exported from `packages/messenger/src/index.ts`.** Anything not in that file is internal. NestJS-specific exports live in `packages/messenger/src/nestjs/index.ts` and are re-exported. Use `package.json` `exports` field with subpath exports (`@schally/nestjs-messenger`, `@schally/nestjs-messenger/testing`).

6. **Errors are typed.** Hierarchy: `MessengerError` → `TransportError` → `TransportConnectionError`, `SerializationError`, `HandlerNotFoundError`, `HandlerFailedError`, etc. Never throw plain `Error`.

7. **Async iterators for receivers, not callbacks.** `receiver.get(signal)` returns `AsyncIterable<Envelope>`. Cancellation via `AbortSignal`.

8. **Graceful shutdown is a first-class concern.** Every transport implements `close()`. The worker listens to `SIGTERM`/`SIGINT` and propagates. Tests verify in-flight messages complete before shutdown resolves.

9. **Code quality is enforced by tooling, not by hope.** Beyond the rules above, we require:
   - ESLint with `@typescript-eslint/strict-type-checked`, `@typescript-eslint/stylistic-type-checked`, `eslint-plugin-boundaries`, `eslint-plugin-import`, `eslint-plugin-unicorn`, `eslint-plugin-promise`.
   - Rules elevated to **error** (not warning): `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-explicit-any`, `consistent-type-imports`, `no-unused-vars`, `prefer-readonly`, `no-non-null-assertion`, `explicit-module-boundary-types` on exports.
   - **No default exports** in source files (only `index.ts` re-exports). Enforced via `import/no-default-export`.
   - **No enums.** Use `as const` objects or string literal unions. Enforced via `@typescript-eslint/no-restricted-syntax`.
   - **Cyclomatic complexity ≤ 10** per function. Enforced via `complexity: ['error', 10]`.
   - **Max file length 300 lines** as a soft limit (warning); 500 as a hard limit (error). Forces decomposition.
   - The `code-quality-reviewer` subagent is the final human-like check before merge — it catches what static tools miss (SOLID, naming, design smells).

## What "done" looks like for v0.1.0

- [ ] `@schally/nestjs-messenger` published with: Envelope, Stamps, MessageBus, MiddlewareStack, TransportInterface, RetryStrategy, MessengerModule, @MessageHandler, `consume` CLI
- [ ] `@schally/nestjs-messenger-transport-redis` published (Redis Streams)
- [ ] Coverage meets thresholds above
- [ ] E2E test boots a real NestJS app, sends 1000 messages through Redis Streams, asserts all consumed with retry on failures
- [ ] README quickstart that mirrors Messenger's quickstart line-for-line
- [ ] CI: lint, typecheck, unit, e2e (docker-compose shared), publish on tag
- [ ] 3 ADRs documenting the non-obvious decisions

Defer to v0.2: transport-amqp, transport-doctrine, transport-google-pubsub, failure transport CLI, scheduler.

## How to work on this codebase

When you're asked to add a feature or fix a bug:

1. **Identify which module(s) and package(s) are affected.** Changes in framework-agnostic modules ripple to every transport's conformance.
2. **Write the test first** — unit test in the relevant module, plus an e2e scenario if the change is observable across packages.
3. **Check Symfony Messenger's behavior** for the same feature before designing the API. Use the `symfony-messenger-reference` subagent. We deviate only when TypeScript or NestJS makes the deviation natural.
4. **Run `pnpm test` AND `pnpm test:e2e`** before claiming done.
5. **Run the `code-quality-reviewer` subagent on the diff** and address blockers + majors. Minors and suggestions are author's discretion but should be acknowledged.
6. **For transport changes, also run the `transport-conformance-checker` subagent.**
7. **Update the relevant skill** in `.claude/skills/` if you discovered a pattern worth encoding.
8. **If you challenge a structural decision, write an ADR.** Don't litigate in PR comments.

## Available skills

- `.claude/skills/transport-implementation/` — how to add a new transport correctly
- `.claude/skills/middleware-design/` — how to write a middleware that composes well
- `.claude/skills/e2e-testing/` — how to write e2e scenarios with docker-compose
- `.claude/skills/coverage-discipline/` — how to hit the thresholds without writing meaningless tests
- `.claude/skills/simplicity-and-duplication/` — when to factor vs when to leave alone; SPOT, rule of three, anti-patterns

## Available subagents

- `transport-conformance-checker` — runs the conformance suite against a transport and reports gaps
- `symfony-messenger-reference` — answers "how does Symfony Messenger do X?" with citations
- `coverage-gap-finder` — finds uncovered branches and proposes test cases
- `code-quality-reviewer` — audits code against SOLID, TypeScript best practices, and the project's specific rules. **Run this before every PR.**

## Anti-patterns to refuse

- Importing from `nestjs/` or `cli/` inside framework-agnostic modules. Refuse and cite Rule 1.
- Tests that mock the thing they're supposed to test (e.g., mocking the bus when testing the bus).
- Transport implementations that don't run the conformance suite.
- "I'll add coverage later." Coverage is the gate, not the polish.
- Inventing new stamp types when an existing one works.
- Adding a dependency on `bullmq` anywhere in `packages/messenger` or `packages/transport-redis`. The Redis transport speaks Redis Streams directly.
- Wrapping `expect(x).toBeDefined()` calls just to hit a line — that's not a test.
- **Premature factorization.** A `BaseTransport` class, a `BaseMiddleware` class, or any abstraction extracted from fewer than 3 real callers. See `simplicity-and-duplication` skill.
- **`utils.ts` / `helpers.ts` / `common.ts` files.** Helpers live with the concept they serve.
- **Combinatorial boolean flags.** Functions with 3+ booleans that create implicit code paths. Split.
- **Compression masquerading as simplicity.** Compact one-liners that hurt readability. We optimize for *simple* (one concept), not for *short*.

## Commands cheat sheet

```bash
pnpm install                          # install everything
pnpm build                            # build all packages (turbo)
pnpm test                             # unit tests across all packages
pnpm test:e2e                         # e2e (requires docker-compose up)
pnpm test:coverage                    # coverage report, fails if below thresholds
pnpm lint                             # eslint + prettier check
pnpm dev:brokers                      # start docker-compose services for local dev
pnpm dev:brokers:down                 # stop them
```

Releases are **conventional-commit driven** (release-please): no manual version step.
`fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major. Merging the
auto-generated release PR tags the release and CI publishes to npm. See
`.github/workflows/release.yml` and `release-please-config.json`.
