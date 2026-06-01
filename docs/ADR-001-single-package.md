# ADR-001: Single main package for v0.1, internal modular boundaries

**Status:** Accepted
**Date:** 2026-05-27

## Context

We considered two structures for the main library:

1. **Two packages**: `@schally/nestjs-messenger-core` (framework-agnostic) + `@schally/nestjs-messenger-nestjs` (NestJS integration).
2. **Single package**: `@schally/nestjs-messenger` with internal directory boundaries enforced by linting.

Splitting would allow future non-NestJS consumers (Fastify-only, vanilla Node). It also signals architectural discipline.

## Decision

Ship as a **single package** for v0.1 with internal modular boundaries enforced by `eslint-plugin-boundaries`. Framework-agnostic directories (`envelope/`, `stamps/`, `bus/`, `middleware/`, `transport/`, `retry/`, `serializer/`, `handler/registry.ts`) cannot import from `nestjs/` or `cli/`.

The day a non-NestJS consumer materializes with a concrete use case, we extract `@schally/nestjs-messenger-core` then — informed by real constraints rather than speculation.

## Consequences

**Positive:**
- One fewer package to publish, version, and maintain.
- Lower friction for first-time contributors (no cross-package debugging).
- Symfony Messenger itself is a single component — we mirror the model.
- Internal boundaries still enforced; the architectural discipline isn't lost, just not packaged.

**Negative:**
- Users who want to use the bus from a non-NestJS app must still install the NestJS peer deps. Acceptable for v0.1; revisit when there's demand.
- Refactoring to split later will involve a breaking change. We accept this — the package is pre-1.0.

## Enforcement

`eslint-plugin-boundaries` configuration in the root ESLint config defines four "elements":
- `framework-agnostic`: `src/{envelope,stamps,bus,middleware,transport,retry,serializer,errors}/**`, `src/handler/registry.ts`, `src/testing/**`
- `nestjs-integration`: `src/nestjs/**`, `src/handler/discovery.ts`
- `cli`: `src/cli/**`
- `entrypoint`: `src/index.ts`

Allowed imports:
- `framework-agnostic` → `framework-agnostic` only
- `nestjs-integration` → `framework-agnostic`, `nestjs-integration`
- `cli` → all except `entrypoint`
- `entrypoint` → all

Violations fail CI.
