# ADR-006: SQL transport speaks raw SQL over `pg`/`mysql2`, not an ORM

**Status:** Accepted
**Date:** 2026-06-10

## Context

The roadmap deferred a SQL transport described as "transport-doctrine (TypeORM/Prisma)". When the
work started, three questions had to be settled:

1. **Which data-access layer?** An ORM (TypeORM, Prisma, MikroORM), a query builder (knex,
   kysely), or the database drivers directly (`pg`, `mysql2`).
2. **One package or one per dialect?** PostgreSQL and MySQL share the table model and the
   claim/redeliver semantics but differ in locking SQL, wake-up mechanism, and driver API.
3. **Which locking strategy?** Symfony's Doctrine transport degrades gracefully from
   `FOR UPDATE SKIP LOCKED` down to plain `FOR UPDATE` and even unlocked reads, because DBAL must
   support old platforms. We have no such constraint.

A point of reference that surprises people: despite its name, Symfony's `doctrine-messenger`
bridge does **not** use the Doctrine ORM. Its `composer.json` requires `doctrine/dbal` only — the
driver/abstraction layer — and the transport is a handful of hand-shaped SQL statements. The "use
an ORM" framing in our old roadmap line was never what the reference implementation does.

## Decision

1. Ship **`@schally/nestjs-messenger-transport-sql`** (directory `packages/transport-sql`), one
   package covering PostgreSQL **and** MySQL/MariaDB. No ORM, no query builder: the transport owns
   ~10 static SQL statements per dialect, executed through `pg` and `mysql2` directly.
2. `pg` and `mysql2` are **optional peer dependencies**, loaded lazily via `require` based on
   the DSN scheme (`postgres://`/`postgresql://` vs `mysql://`/`mariadb://`). Users install
   only the driver they need. Deliberately NOT a dynamic `import()`: the package ships
   CommonJS, and a native import() emitted in CJS breaks under vm-based runners without ESM
   support — e.g. a consumer's jest suite (rationale in `src/driver.ts`).
3. `FOR UPDATE SKIP LOCKED` is **mandatory**: minimum supported versions are
   **PostgreSQL ≥ 9.5, MySQL ≥ 8.0.1, MariaDB ≥ 10.6**. There is no fallback ladder.

## Rationale

**Raw drivers, not an ORM.** The transport needs no entity mapping, no relations, no migrations
framework — just INSERT/claim/DELETE on one table. An ORM would add per-query overhead
(hydration, change tracking, query generation), a heavyweight dependency to a library users embed
in their own apps (version conflicts with *their* ORM), and zero expressive benefit for static
SQL. A query builder has the same cost/benefit shape at smaller scale. The performance levers
that actually matter — `SKIP LOCKED` claims, a covering index, `LISTEN/NOTIFY` wake-ups,
millisecond `available_at` precision — all live below any abstraction layer. This mirrors
Symfony's own choice (DBAL, not ORM); our "DBAL" is the driver itself.

**One package, two dialects.** Symfony ships one bridge with a shared `Connection` and a
`PostgreSqlConnection` subclass; we mirror that shape with one `SqlTransport` engine and an
internal per-dialect driver. The engine (options, serializer round-trip, poll loop, ack/reject
idempotency, in-flight draining on `close()`) is identical for both dialects — two packages would
duplicate it wholesale or force a third shared package, the exact premature-factorization
anti-pattern CLAUDE.md bans. The per-dialect surface (SQL text, claim shape, NOTIFY, error codes)
is small and isolated behind an internal interface with exactly two implementations.

**SKIP LOCKED mandatory.** Symfony's fallback ladder exists because DBAL targets platforms we
will never see (SQLite, old MySQL). Plain `FOR UPDATE` serializes competing consumers and causes
the deadlock patterns Symfony historically worked around with a MySQL soft-delete hack (removed
upstream in Dec 2025 in favor of `SKIP LOCKED` + a covering index). Requiring 2018-era database
versions buys us concurrent consumers that never contend, with no compatibility code to test.

## Deliberate deviations from Symfony's Doctrine transport

Recorded here so nobody "fixes" them back:

- **Millisecond precision** (`TIMESTAMPTZ(3)` / `DATETIME(3)`). Symfony truncates delays to whole
  seconds — a PHP `DateTime` artifact. Our conformance suite asserts `DelayStamp` honored within
  ±200 ms, which whole-second truncation cannot satisfy.
- **`ORDER BY available_at, id`.** Symfony has no tiebreaker, so messages enqueued within the
  same timestamp are claimed in platform-dependent order. The `id` tiebreaker costs nothing
  (it's the tail of the covering index) and stabilizes FIFO.
- **Database clock, not application clock.** All `now()` arithmetic happens in SQL. Symfony uses
  the PHP clock and documents worker clock skew as a known redelivery hazard; we remove the
  hazard instead.
- **`reject()` redelivers under a new id** (INSERT copy with incremented `RedeliveryStamp` +
  DELETE original, in one transaction) instead of Symfony's `reject()`-deletes. This is our
  transport contract (conformance scenarios 3/5/12), shared with the Redis/Pub/Sub/Kafka
  transports: the RetryMiddleware, not the transport, decides when a message is dead.
- **`pg_notify()` inside the INSERT statement, no trigger.** Symfony historically installed a
  PL/pgSQL trigger at setup; upstream replaced it in Jan 2026 with an explicit `pg_notify()` in
  the send transaction. We adopt the modern form only: auto-setup stays pure DDL, and
  notifications still fire on commit.

## Consequences

**Positive:**
- Dependency footprint for users: exactly one driver, nothing else.
- The claim path is one round-trip on PostgreSQL (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
  LOCKED) RETURNING`), two statements in one transaction on MySQL.
- Near-instant delivery on PostgreSQL via LISTEN/NOTIFY while idle, without DDL beyond the table.
- The SQL transport is `listable` (trivial SELECTs), making it the natural failure transport.

**Negative:**
- Two hand-maintained SQL dialects; every schema or claim change must be made twice and is pinned
  by running the conformance suite against both real databases in CI.
- MySQL 5.7 and PostgreSQL < 9.5 users are excluded. Documented loudly in the package README.
- MySQL has no NOTIFY equivalent: it polls at `pollIntervalMs`. Documented as a known trade-off.
- No transactional-outbox support yet: a pooled connection cannot silently join the caller's open
  transaction the way a shared DBAL connection does in PHP. Dispatching inside an application
  transaction is a planned follow-up (the internal driver accepts the extension without breaking
  the public API).

## Enforcement

`packages/transport-sql/package.json` MUST NOT depend on any ORM or query builder (`typeorm`,
`prisma`, `@prisma/client`, `knex`, `kysely`, `sequelize`, `drizzle-orm`, …). `pg` and `mysql2`
stay in `peerDependencies` with `peerDependenciesMeta.optional: true`. The
`transport-conformance-checker` subagent fails the audit if the conformance suite is not run
against **both** dialects.
