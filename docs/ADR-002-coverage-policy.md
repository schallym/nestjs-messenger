# ADR-002: Differentiated coverage thresholds

**Status:** Accepted
**Date:** 2026-05-27

## Context

We considered three coverage policies:

1. **100% everywhere, strict.** Initial proposal. Forces testability discipline; signals quality.
2. **80-90% pragmatic.** Industry default. Permissive enough to avoid theater.
3. **Differentiated by code type.** 100% on pure logic, relaxed on framework integration glue.

Option 1 produces tests like `expect(thing).toBeDefined()` written purely to hit a line — the gate becomes theater. The risk is real: the original `coverage-discipline` skill spent half its length warning against this anti-pattern, which is itself an admission the rule pushes toward bad tests.

Option 2 leaves real gaps in code we genuinely want bulletproof (the bus, the middleware pipeline, the transport implementations).

Option 3 acknowledges that framework integration code (NestJS modules, decorators, CLI argv parsing) has paths the unit-test layer cannot reach without writing integration-flavored tests in unit clothing. Those paths are caught by e2e tests instead.

## Decision

Apply differentiated thresholds:

| Code location | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| Framework-agnostic modules | 100% | 100% | 100% | 100% |
| NestJS integration | 95% | 90% | 95% | 95% |
| Transport implementation file | 100% | 100% | 100% | 100% |
| Transport glue/config | 95% | 90% | 95% | 95% |

E2E tests do not contribute to these numbers.

Encoded per-package in `jest.config.ts` via `coverageThreshold` with file-pattern overrides.

## Consequences

**Positive:**
- The pure-logic core is held to a strict standard where the discipline actually produces good tests.
- Framework integration code isn't forced to write nonsense tests for argv-parsing edge cases.
- The "100% trap" (writing tests to hit lines without asserting behavior) is contained to the modules where it's least likely to occur (those have natural assertions in every test).

**Negative:**
- Two thresholds to remember. We mitigate by encoding them in CI and explaining them in `.claude/skills/coverage-discipline/SKILL.md`.
- A small risk that contributors push framework integration code below 95% relying on "it's the relaxed tier." Code review catches this.

## Enforcement

Per-package `jest.config.ts` uses `coverageThreshold` with `global` set to the relaxed tier and per-path overrides for the strict tier. Example:

```ts
coverageThreshold: {
  global: { branches: 90, lines: 95, functions: 95, statements: 95 },
  './src/envelope/**/*.ts': { branches: 100, lines: 100, functions: 100, statements: 100 },
  './src/stamps/**/*.ts': { branches: 100, lines: 100, functions: 100, statements: 100 },
  // ...
}
```

CI fails if any threshold is missed.
