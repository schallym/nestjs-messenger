# Contributing to nestjs-messenger

Thanks for considering a contribution! This project brings
[Symfony Messenger](https://symfony.com/doc/current/messenger.html)'s developer experience
to NestJS. When a design question comes up, the reference is Messenger's mental model
(Envelope, Stamps, MessageBus, Middleware, Transport, Worker, Routing) — we mirror it,
then adapt to TypeScript/NestJS idioms.

Before you start, please skim [`CLAUDE.md`](CLAUDE.md) (the project's source of truth for
architecture and rules) and the [ADRs](docs/) for the non-obvious decisions.

## Prerequisites

- **Node 24** — the version is pinned in [`.nvmrc`](.nvmrc) (`nvm use`).
- **pnpm** — pinned via the `packageManager` field; enable it with `corepack enable`.
- **Docker** — only needed to run the e2e suite (it boots real brokers via docker-compose).

This is a **pnpm + Turborepo monorepo**. Do not use `npm` or `yarn`.

## Getting started

```bash
git clone https://github.com/schallym/nestjs-messenger.git
cd nestjs-messenger
corepack enable
pnpm install
pnpm build
```

### Repository layout

```
packages/
  messenger/          # @schally/nestjs-messenger — bus, pipeline, envelope/stamps,
                      #   retry, failure transport, NestJS module, in-memory transport,
                      #   conformance suite, CLI
  transport-redis/    # @schally/nestjs-messenger-transport-redis — Redis Streams (ioredis)
e2e/                  # @schally/nestjs-messenger-e2e (private) — real-app scenarios
docs/                 # ROADMAP + ADRs
.claude/              # skills + subagents that encode these conventions
```

We ship a single main package (see [ADR-001](docs/ADR-001-single-package.md)); transports
are separate packages so users only pull what they need.

## Commands

```bash
pnpm build            # build all packages (turbo + tsc project references)
pnpm test             # unit tests across packages
pnpm test:coverage    # unit tests with the enforced coverage gates
pnpm test:e2e         # e2e scenarios (needs brokers up — see below)
pnpm typecheck        # tsc across all packages (incl. e2e)
pnpm lint             # eslint (flat config + boundaries) + prettier --check
pnpm lint:fix         # eslint --fix + prettier --write
pnpm dev:brokers      # start docker-compose brokers (Redis) for e2e/local dev
pnpm dev:brokers:down # stop them
```

To run the e2e suite locally: `pnpm dev:brokers` then `pnpm test:e2e`.

## Engineering rules (non-negotiable)

These are enforced by tooling and CI; PRs that violate them won't merge. The full list is
in [`CLAUDE.md`](CLAUDE.md) — the essentials:

- **No `any`, no `@ts-ignore`.** `strict: true` everywhere, including
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Use generics and
  discriminated unions.
- **Typed errors only.** Throw from the hierarchy (`MessengerError` → `TransportError` →
  …), never a plain `Error`.
- **No enums** — use `as const` objects or string-literal unions.
- **No default exports** in source (only `index.ts` re-exports).
- **Cyclomatic complexity ≤ 10** per function; **file length** 300 lines soft (warning),
  500 hard (error).
- **Module boundaries** ([ADR-001](docs/ADR-001-single-package.md)): the framework-agnostic
  modules (`envelope/`, `stamps/`, `bus/`, `middleware/`, `transport/`, `retry/`,
  `serializer/`, `handler/registry.ts`) **must not** import from `nestjs/` or `cli/`. The
  reverse is allowed. Enforced by `eslint-plugin-boundaries`.
- **Async iterators for receivers** (`get(signal)` returns `AsyncIterable<Envelope>`),
  cancellation via `AbortSignal`, and a graceful `close()` on every transport.
- Prefer simplicity over premature abstraction — no `BaseX` class extracted from fewer than
  three real callers, no `utils.ts`/`helpers.ts` grab-bags (helpers live with the concept
  they serve). See the `simplicity-and-duplication` skill.

### Formatting & lint

Prettier config: single quotes, trailing commas, `printWidth: 100`, semicolons, 2-space
indent. ESLint uses `@typescript-eslint` **strict-type-checked** + stylistic, plus
`boundaries`, `import`, `unicorn`, and `promise`. Run `pnpm lint:fix` before committing.

## Testing & coverage

- **Unit tests** live in each package's `test/` directory as `*.spec.ts` (not co-located
  with source).
- **E2E tests** live in `e2e/scenarios/` as `*.e2e-spec.ts` and boot a real NestJS app
  against real brokers. They do **not** count toward coverage.
- **Transports** must pass the shared conformance suite
  (`@schally/nestjs-messenger/testing` → `runTransportConformanceTests`). Don't merge a
  transport that doesn't run it.

Coverage is **differentiated** and enforced by CI (see
[ADR-002](docs/ADR-002-coverage-policy.md)):

| Code | Threshold |
|---|---|
| Framework-agnostic (`envelope/`, `stamps/`, `bus/`, `middleware/`, `transport/`, `retry/`, `serializer/`) | **100%** lines / branches / functions / statements |
| NestJS + CLI integration (`nestjs/`, `cli/`, `handler/discovery.ts`) | **95% lines / 90% branches** |
| A transport package | **100%** on the transport implementation, **95%** on glue |

Don't pad coverage with meaningless assertions. A genuinely untestable line may use
`/* istanbul ignore next -- @preserve <reason> */`, sparingly and with a clear reason
(see the `coverage-discipline` skill).

## Commit messages & releases

We use [Conventional Commits](https://www.conventionalcommits.org/), and releases are
**fully driven by them** via release-please — there is no manual version step:

| Prefix | Effect on version |
|---|---|
| `fix: …` | patch (`0.1.0` → `0.1.1`) |
| `feat: …` | minor (`0.1.0` → `0.2.0`) |
| `feat!: …` or a body with `BREAKING CHANGE:` | major (`0.1.0` → `1.0.0`) |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:` | no release on their own |

In this monorepo a commit is attributed to the package whose files it touches. Merging the
auto-generated release PR tags the release and publishes to npm. See
[`release-please-config.json`](release-please-config.json) and
[`.github/workflows/release.yml`](.github/workflows/release.yml).

## Pull request process

1. Branch from `main`.
2. Add or update tests first; keep the relevant coverage tier green.
3. Run the full gate locally:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:e2e
   ```
4. Update docs/examples when behavior changes; if you make a structural decision, write an
   ADR in `docs/` rather than litigating it in PR comments.
5. Open a PR with a clear description and a Conventional Commit title; link related issues.
6. Be responsive to review feedback.

If you work with [Claude Code](https://claude.com/claude-code), the repo ships subagents
that mirror our review gates — run `code-quality-reviewer` on your diff, and
`transport-conformance-checker` for any transport change. These encode the same rules a
human reviewer applies; they're aids, not a substitute for the checklist above.

## Adding a transport

Read the `transport-implementation` skill and [ADR-003](docs/ADR-003-redis-streams-not-bullmq.md)
(why the Redis transport is Redis Streams, **not** BullMQ — do not add a `bullmq`
dependency). At minimum a transport must: implement `TransportInterface` with no `any`,
map all SDK errors to our typed hierarchy, pass every applicable conformance scenario,
support graceful shutdown, ship a docker-compose entry + at least one e2e scenario, and
meet the coverage thresholds.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Report
unacceptable behavior to the maintainers.

## Reporting bugs & security

Open a [GitHub issue](https://github.com/schallym/nestjs-messenger/issues) for bugs and
feature requests with a minimal reproduction. For suspected security vulnerabilities,
please contact the maintainers privately rather than opening a public issue.

Thank you for helping improve nestjs-messenger!
