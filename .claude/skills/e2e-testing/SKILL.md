---
name: e2e-testing
description: Use when writing end-to-end test scenarios that boot a real NestJS app and real brokers via docker-compose. Covers the shared docker-compose harness, logical isolation via per-test queue names, flakiness mitigation, and the canonical scenario shape. Trigger when adding files under e2e/scenarios or modifying e2e/docker-compose.yml.
---

# End-to-end testing

E2E tests boot a real NestJS application against real brokers and assert observable behavior end-to-end. They are slower than unit tests, so we keep them focused on **integration concerns** (the wiring works) rather than **logic concerns** (which belong in unit tests).

## Stack

- **Test runner:** Jest with `--runInBand` for e2e (no parallelism at the file level, brokers are shared).
- **Broker orchestration:** **docker-compose, shared across all tests, in both CI and local dev.** Same `e2e/docker-compose.yml` used everywhere.
- **Isolation:** **logical, not container-level.** Each test uses unique queue/stream names (e.g., `test-${suite-id}-${test-id}`). No two tests touch the same queue. No state shared.
- **App harness:** `Test.createTestingModule()` from `@nestjs/testing`, configured with the real transports pointing at the shared brokers.

### Why docker-compose shared rather than Testcontainers

We considered Testcontainers (per-test ephemeral containers). Rejected because:

- 40-50 container startups per e2e run × 10-30s = 15-25 minutes of CI time.
- More RAM/CPU pressure (matters for free CI tiers).
- Setup verbosity in every test file.
- Most contributors know docker-compose; Testcontainers adds onboarding friction.

The tradeoff is that we rely on logical isolation (unique queue names) instead of physical isolation. The `uniqueQueueName(testName)` helper in `e2e/harness/` makes this trivial.

## Anatomy of a canonical scenario

```ts
// e2e/scenarios/redis-streams-retry.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { MessengerModule, MessageBus } from '@schally/nestjs-messenger';
import { RedisStreamsTransport } from '@schally/nestjs-messenger-transport-redis';
import { uniqueQueueName, workerProcessUntilEmpty, listFailedMessages } from '../harness';

describe('Redis Streams: retry then failure transport', () => {
  let app: INestApplication;
  let bus: MessageBus;
  const handlerCalls: string[] = [];
  const asyncQueue = uniqueQueueName('redis-retry-async');
  const failedQueue = uniqueQueueName('redis-retry-failed');

  beforeAll(async () => {
    @MessageHandler(FlakyMessage)
    class FlakyHandler {
      async handle(msg: FlakyMessage) {
        handlerCalls.push(msg.id);
        if (handlerCalls.filter(id => id === msg.id).length < 3) {
          throw new Error('flaky');
        }
      }
    }

    const module = await Test.createTestingModule({
      imports: [
        MessengerModule.forRoot({
          transports: {
            async: { dsn: `redis://localhost:6379`, stream: asyncQueue },
            failed: { dsn: `redis://localhost:6379`, stream: failedQueue },
          },
          routing: { [FlakyMessage.name]: ['async'] },
          retryStrategy: { maxRetries: 3, delayMs: 50, multiplier: 1 },
          failureTransport: 'failed',
        }),
      ],
      providers: [FlakyHandler],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    bus = app.get(MessageBus);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    // Clean up our test-specific streams
    await cleanupStreams([asyncQueue, failedQueue]);
  });

  it('retries 3 times then succeeds', async () => {
    await bus.dispatch(new FlakyMessage('msg-1'));
    await workerProcessUntilEmpty(app, 'async', { timeout: 5000 });
    expect(handlerCalls.filter(id => id === 'msg-1')).toHaveLength(3);
  });

  it('routes to failure transport after exhausting retries', async () => {
    await bus.dispatch(new AlwaysFailMessage('msg-2'));
    await workerProcessUntilEmpty(app, 'async', { timeout: 5000 });
    const failed = await listFailedMessages(app, failedQueue);
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toBeInstanceOf(AlwaysFailMessage);
  });
});
```

## The `uniqueQueueName` helper

```ts
// e2e/harness/queue-name.ts
import { randomUUID } from 'node:crypto';

export function uniqueQueueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
```

Every queue/stream/topic name used by a test goes through this. Two tests can run sequentially against the same Redis instance and never collide.

## The `workerProcessUntilEmpty` helper

E2E tests should NOT call `worker.run()` directly with an arbitrary timeout. Use a helper that:

1. Starts the worker.
2. Polls `transport.getMessageCount()` (when available) or counts processed envelopes via an event listener.
3. Resolves when the queue has been empty for N consecutive checks (avoids race where a message is mid-flight).
4. Rejects after a max timeout with a useful error including queue state.

This helper lives in `e2e/harness/worker.ts` and is the only sanctioned way to wait in e2e.

## What goes in e2e (and what doesn't)

**In e2e:**
- Round-trip through each transport (one scenario per transport).
- Retry → failure transport flow.
- Graceful shutdown: dispatch N slow messages, send SIGTERM mid-flight, assert all completed.
- `consume` CLI with `--limit=10` actually stops after 10.
- Multi-transport routing: message class A goes to transport X, class B to transport Y.
- Multi-handler: one message, two handlers, both run, both stamped.

**NOT in e2e (belongs in unit):**
- Stamp manipulation edge cases.
- Middleware order with mocked stack.
- Retry strategy math (which delay for which attempt).
- Error mapping inside a transport (use the transport's unit tests).

The heuristic: if a unit test can express it without losing fidelity, don't pay the docker tax.

## docker-compose

```yaml
# e2e/docker-compose.yml — used by CI and local dev
services:
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 2s
      timeout: 2s
      retries: 10
  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports: ['5672:5672', '15672:15672']
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', 'check_running']
      interval: 5s
      timeout: 5s
      retries: 10
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: messenger, POSTGRES_DB: messenger }
    ports: ['5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 2s
      timeout: 2s
      retries: 10
  pubsub-emulator:
    image: gcr.io/google.com/cloudsdktool/cloud-sdk:emulators
    command: gcloud beta emulators pubsub start --host-port=0.0.0.0:8085
    ports: ['8085:8085']
```

CI workflow runs `docker compose -f e2e/docker-compose.yml up -d --wait` before `pnpm test:e2e`. Healthchecks ensure no race on broker startup.

Locally: `pnpm dev:brokers` brings everything up; `pnpm test:e2e` runs against it. Same compose file, same images, same versions.

## Flakiness — the rules

E2E flakiness destroys trust. To avoid it:

1. **No arbitrary `setTimeout` waits.** Use polling helpers with explicit conditions.
2. **No shared queue names across tests.** Use `uniqueQueueName`. Period.
3. **Clean up streams/queues in `afterAll`.** Don't pollute the shared broker indefinitely.
4. **No reliance on broker clock vs Node clock.** Use relative delays, not absolute timestamps.
5. **Always set Jest timeouts explicitly.** `beforeAll(..., 30_000)`, `it(..., 30_000)`. Defaults bite.
6. **CI runs e2e three times in a row** on PRs that touch transports. If any of the three flakes, the PR fails. Flakiness is a bug, not a fact of life.

## Test naming conventions

- File: `<transport-or-feature>.<scenario>.e2e-spec.ts` — e.g., `redis-streams.retry.e2e-spec.ts`, `cli.consume-limit.e2e-spec.ts`.
- Describe: `<Transport>: <high-level behavior>`.
- It: present tense, observable claim. ✅ `it('routes failed messages to the failure transport')`. ❌ `it('should work')`.

## Common e2e pitfalls

- **Not awaiting `app.close()`.** Leaves broker connections open, next test connects to a half-closed pool, you spend two days debugging.
- **Mocking inside e2e.** If you're mocking, you're not doing e2e. Drop to integration tier.
- **Verifying internals.** E2E asserts only what a user can observe (handler called, queue empty, message in failure transport). Don't peek into private fields.
- **Bundling 10 assertions in one test.** When it flakes, you have no idea which behavior broke. One scenario per test.
- **Forgetting cleanup.** A test that creates 1000 stream entries and doesn't drop the stream slows down every subsequent test against that broker.
