---
name: coverage-discipline
description: Use when writing tests, reviewing coverage reports, or deciding whether a test is worth keeping. Covers the differentiated coverage thresholds, what to test, what NOT to test, how to reach the thresholds without meaningless assertions, when to use istanbul ignore, and how to read the report to find real gaps. Trigger when coverage drops below threshold or when a PR adds tests.
---

# Coverage discipline

We enforce **differentiated coverage thresholds** based on what the code does. The goal is real quality, not a vanity number.

## The thresholds

| Code location | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| Framework-agnostic modules (`envelope/`, `stamps/`, `bus/`, `middleware/`, `transport/` interface + InMemory + conformance, `retry/`, `serializer/`) | **100%** | **100%** | **100%** | **100%** |
| NestJS integration (`nestjs/`, `cli/`, `handler/discovery.ts`) | 95% | 90% | 95% | 95% |
| Transport packages — transport implementation file | **100%** | **100%** | **100%** | **100%** |
| Transport packages — glue/config code | 95% | 90% | 95% | 95% |

**Why differentiated:** the framework-agnostic core and the transport implementations are pure logic with mockable boundaries — they CAN be 100% covered without writing nonsense tests. The NestJS adapter and CLI involve framework code paths (decorators, lifecycle hooks, CLI argv parsing) where the last 5% costs disproportionately for low value.

These thresholds are encoded in `jest.config.ts` per package. PRs failing them are rejected by CI.

## The cardinal rule

**Coverage measures executed lines, not validated behavior.** A test that runs code without asserting anything passes the gate but tests nothing. We reject those in review.

Every test must have at least one of:
- An explicit `expect()` assertion on a return value or side effect.
- An `expect().rejects` or `expect().toThrow` for error cases.
- A mock verification (`expect(mockFn).toHaveBeenCalledWith(...)`) — but only when the side effect IS the contract.

## What to test (priority order)

1. **Public API behavior.** Every exported function/class/method has tests on its happy path and at least one error path.
2. **Branches.** Every `if`, `?:`, `??`, `||`, `&&`, every `case`, every `catch`.
3. **Async edge cases.** Cancellation (AbortSignal), timeout, concurrent calls to the same method, close()-while-busy.
4. **Stamp interactions.** When a middleware reads a stamp added by another middleware, test the combination.
5. **Error propagation.** Throwing the right error type with the right cause chain.

## What NOT to test

- **Type-only code.** Type guards that exist purely for TypeScript narrowing don't need runtime tests unless they have logic.
- **Trivial getters/setters.** If a property is exposed without transformation, the constructor test covers it.
- **NestJS framework behavior.** We don't test that `@Injectable` works. We test what our module exports and how it wires.
- **Third-party libraries.** Don't write tests asserting that `ioredis` connects. Test our wrapper's behavior, mock the library at the seam.

## The 100% trap (for the modules where we require it)

The trap is writing nonsense tests just to cover lines:

```ts
// ❌ Bad: hits the line but tests nothing
it('constructs', () => {
  expect(new Envelope(msg)).toBeDefined();
});
```

vs.

```ts
// ✅ Good: tests the constructor's contract
it('initializes with empty stamps when none provided', () => {
  const env = new Envelope(msg);
  expect(env.all()).toEqual([]);
  expect(env.message).toBe(msg);
});
```

If you find yourself writing `toBeDefined()` you're probably not testing anything meaningful. Pause and ask: *what claim am I making about this code?*

## When to use istanbul ignore

Reserved for genuinely unreachable code:

- Defensive `default:` in an exhaustive `switch` over a discriminated union.
- Type-narrowing branches the compiler should prove dead but can't.
- Platform-specific code paths the CI doesn't cover (rare; usually means refactor).

Syntax:

```ts
/* istanbul ignore next -- @preserve TS proves this is unreachable, kept for safety */
default:
  throw new UnreachableError(stamp);
```

Rules:
- Always include `-- @preserve` (so prettier doesn't strip it) and a justification.
- PR description must mention the ignore and why.
- Reviewer's job: try to refactor away the need for the ignore. If you can, do.

**Limit:** up to **3 ignores per module/package**. Beyond that, the architecture is probably wrong.

## Reading the coverage report

Run `pnpm test:coverage`. Open `coverage/lcov-report/index.html`. The columns to look at:

- **Branches %**: the most informative. 100% lines with 80% branches means you have `if` statements you only tested one side of.
- **Uncovered Line #s**: jump straight there. The pattern is usually:
  - A `catch` block that never fires → add a test that triggers the error.
  - An `else` branch → add a test for the alternative input.
  - A `?? default` → test with `undefined`.

## Mocking policy

- **Mock at the seam, not inside.** Mock `ioredis`, never mock our own `RedisStreamsTransport`.
- **Prefer fakes over mocks.** `InMemoryTransport` is a real fake usable across the test suite. Use it instead of mocking `TransportInterface`.
- **Don't mock data classes.** `Envelope`, `Stamp`, `Message` instances are cheap. Use real ones.
- **No `jest.mock('module')` at the top of files in framework-agnostic modules.** Those modules have no module-level dependencies to mock. If you feel you need to, the code is wrong.

## The "test the test" check

Before submitting, mutate the production code:
- Comment out a line.
- Flip a condition (`>` to `<`).
- Return early.

If the test suite still passes, your tests don't actually test what you think. Add the missing assertion. This takes 30 seconds per file and catches more bugs than the coverage gate ever will.

## When 100% genuinely can't be reached (in modules where we require it)

It almost always can. If you think it can't, one of:
- The code has hidden dependencies (refactor to inject them).
- The code mixes two responsibilities (split into two units, each fully testable).
- There's truly unreachable code (use `istanbul ignore` with justification).

"100% is impossible here" is almost always a design smell, not a testing limit.

## Pre-PR checklist

- [ ] `pnpm test:coverage` meets the threshold for every touched module.
- [ ] No new `istanbul ignore` without justification in the PR description.
- [ ] Every new test has at least one meaningful assertion (no bare `toBeDefined`).
- [ ] Mutating one line in the production code makes a test fail.
- [ ] E2E added (or justified absence) for observable behavior changes.
