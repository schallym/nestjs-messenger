---
name: simplicity-and-duplication
description: Use when about to extract a helper, factor out a base class, write a generic abstraction, or when the code-quality-reviewer flags duplication or complexity. Covers when to factor vs when to leave alone, the SPOT principle, rule of three, complexity budgets, and the "wrong abstraction" anti-pattern. Trigger whenever you catch yourself writing "let me make this reusable" or "let me simplify this."
---

# Simplicity and duplication

Two principles that sound obvious and ruin codebases when applied without judgment:

- "Don't repeat yourself" → people factor too early, creating abstractions that serve nobody.
- "Keep it simple" → people compress instead of clarifying, producing dense unreadable code.

This skill codifies the calls we make on this project.

## The real rule for duplication: SPOT, not DRY

DRY is often misquoted as "no two pieces of code may look alike." The actual principle from Hunt & Thomas is about **knowledge**: every piece of *knowledge* should have a single authoritative representation. Two functions that happen to have the same shape today, but encode different knowledge, are not duplication — they're a coincidence.

The decision is:

- **Same knowledge** (same business rule, same algorithm, same invariant) → factor it. Examples: stamp serialization logic, error wrapping, DSN parsing.
- **Same shape, different knowledge** (two transports both happen to have a `send` method; two middlewares both happen to add a stamp) → leave them alone. Each will evolve independently.

If you can't articulate **what knowledge** the duplicate represents in one sentence, you probably shouldn't factor.

## The rule of three

Don't factor on the first occurrence. Don't even factor on the second. Wait for the third. By the third you have evidence that the pattern is real, and you have three concrete shapes to compare — the abstraction will fit because it's drawn from three real examples instead of two-plus-imagination.

Exception: if the duplication is **literal copy-paste of >20 lines** and the knowledge is unambiguous (e.g., the same retry loop), factor on occurrence two. The cost of duplicating non-trivial code already outweighs the risk of a slightly wrong abstraction.

## When NOT to deduplicate

Concrete cases on this codebase:

- **Two transports with similar `send` methods.** They feel the same but each owns broker-specific quirks. A `BaseTransport` class will accumulate `if (this.kind === 'redis')` over time. Leave them as siblings. The conformance suite is the shared spec, not a base class.
- **Two middlewares that both call `envelope.with(SomeStamp)`.** That's a one-line idiom, not duplicated knowledge.
- **Two tests that have similar setup.** Test duplication is fine — explicitness beats cleverness in tests. Factor only into named builders (`buildEnvelopeWithRetry()`) when the test reads worse than the helper would.
- **Two error classes with the same constructor.** Each error carries different semantics. Don't merge them just because the constructor body looks identical.

## When to deduplicate aggressively

- **Serialization / deserialization of stamps.** Single source of truth. Every transport reads/writes envelopes the same way.
- **DSN parsing.** Shared helper. One regex, one set of rules, one error type.
- **The conformance suite.** Whole point of the project.
- **Error wrapping.** `wrapBrokerError(err)` is called from every transport. One implementation.
- **Logging format / metric names.** Consistent across the codebase or observability becomes unusable.

## Simplicity: simple vs easy

Rich Hickey's distinction (from his talk *Simple Made Easy*):
- **Easy:** familiar, close at hand, fast to type.
- **Simple:** one role, one concept, no entanglement.

We optimize for **simple**, not easy. Examples on this codebase:

- A `Middleware` that does one thing (add a stamp, or retry, or log) is simple. A "MegaMiddleware" with a config flag for each behavior is easy to add features to, but not simple.
- Async iterators are *less easy* than callbacks (they require `for await`), but *simpler* (one mental model: a sequence over time).
- Stamps are *less easy* than a free-form metadata object, but *simpler* (typed, immutable, single-purpose).

When in doubt, write the version that has the fewest concepts entangled, even if it's a bit more typing.

## Anti-patterns to refuse

### Premature base classes

```ts
// ❌ Refuse this
abstract class BaseTransport {
  abstract sendImpl(env: Envelope): Promise<Envelope>;
  async send(env: Envelope): Promise<Envelope> {
    // shared logging, stamping, error wrapping
    return this.sendImpl(env);
  }
}
```

Why refused: this base class will accumulate `if (this instanceof X)` over time. Use composition: a free function `wrapSend(transport, env, logger)` or a decorator transport (`LoggingTransport implements TransportInterface`).

### "Just one config flag"

```ts
// ❌ Refuse this
function processEnvelope(env: Envelope, opts: {
  retry?: boolean;
  log?: boolean;
  validate?: boolean;
  transactional?: boolean;
  dryRun?: boolean;
}): Promise<Envelope> { /* 200 lines of if/else */ }
```

Why refused: one function with five boolean knobs is five functions in a trench coat. Each combination is a code path nobody tests. Make them separate functions or middlewares.

### Util.ts dumping grounds

A file named `utils.ts`, `helpers.ts`, or `common.ts` is a smell. Helpers belong with the concept they serve. `parseDsn` lives in `transport/`, not in `utils/`. If a helper truly serves multiple unrelated concepts, it's usually one of:

- A primitive that should be in `core/types.ts` (e.g., `Result<T, E>`).
- A wrapper around the standard library that should just be inlined.
- A sign that the two callers share knowledge and that knowledge belongs in its own module.

### Compression masquerading as simplicity

```ts
// ❌ Compact, not simple
const stamps = env.all().reduce((m, s) => ({ ...m, [s.constructor.name]: [...(m[s.constructor.name] ?? []), s] }), {} as Record<string, Stamp[]>);

// ✅ Simple
const stamps = new Map<string, Stamp[]>();
for (const stamp of env.all()) {
  const key = stamp.constructor.name;
  const existing = stamps.get(key) ?? [];
  stamps.set(key, [...existing, stamp]);
}
```

Both compute the same thing. The second is twice as long and four times clearer. We prefer the second.

### "Configurable to be reusable later"

YAGNI. If we only have one caller today, code for one caller. Generalizing for hypothetical second callers usually produces an abstraction that doesn't fit either when the second caller materializes.

## Concrete arbitration questions

When you're about to factor or simplify, ask yourself:

1. **Can I name in one sentence the knowledge this abstraction represents?** If no → don't factor.
2. **Will the second caller actually need every parameter of this abstraction?** If no → too general, split.
3. **If a maintainer reads this six months from now, will they understand it without context?** If no → not simple, just compact.
4. **Am I removing a real coupling, or just removing visual repetition?** Only the first is worth it.
5. **Could I instead make the two duplicates more obviously different?** Sometimes the right answer is to *clarify* the difference (rename, add a comment about why) rather than merge.

## On this codebase, specifically

- The `testing/` module (conformance suite + helpers) is the **one place** where we aggressively share. Every transport runs the same suite. The duplication cost would be enormous and the knowledge is one and the same.
- Each transport package is **deliberately not factored into a base**. They share an interface, not an implementation. This is by design — see ADR-003 reasoning about double layers.
- Middlewares are **deliberately small and single-purpose**. Combining them is the user's job (or the default stack's). Each one fits in one screen.
- Stamps **never share a base class beyond `interface Stamp {}`**. They are independent value objects.

## Pre-commit self-check

Before merging code with new abstractions:

- [ ] I can name the knowledge this abstraction represents.
- [ ] There are at least 2 (preferably 3) real callers.
- [ ] Each caller actually needs every part of the abstraction.
- [ ] The abstraction would survive if one of the callers' requirements changed.
- [ ] The code is simpler to read than the duplication it replaces — not just shorter.
- [ ] I'm not creating `utils.ts` / `helpers.ts` / `common.ts`.
- [ ] No base class with `abstract` methods called from concrete methods of the base (template method) without a documented reason.

If any answer is no, prefer leaving the duplication. We can always factor later; un-factoring is harder.
