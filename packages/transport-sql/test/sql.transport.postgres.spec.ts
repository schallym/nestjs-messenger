import { randomUUID } from 'node:crypto';
import {
  Envelope,
  InvalidArgumentError,
  JsonSerializer,
  RedeliveryStamp,
  TransportConnectionError,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';
import {
  ConformanceMessage,
  runTransportConformanceTests,
} from '@schally/nestjs-messenger/testing';
import { Pool } from 'pg';
import { SqlTransport, type SqlTransportOptions } from '../src';
import { PostgresDriver } from '../src/postgres.driver';

const DSN = process.env.POSTGRES_DSN ?? 'postgresql://messenger:messenger@localhost:5432/messenger';
const UNREACHABLE_DSN = 'postgresql://messenger:messenger@localhost:59999/messenger';

// max 1: the idle-backend kill test must never terminate this pool's own siblings.
const admin = new Pool({ connectionString: DSN, max: 1 });

afterAll(async () => {
  await admin.end();
});

function uniqueQueue(prefix = 'q'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function uniqueTable(): string {
  return `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function makeTransport(
  queueName: string,
  overrides: Partial<SqlTransportOptions> = {},
): SqlTransport {
  return new SqlTransport({
    dsn: DSN,
    queueName,
    name: queueName,
    serializer: new JsonSerializer([ConformanceMessage]),
    pollIntervalMs: 20,
    ...overrides,
  });
}

async function cleanQueue(queueName: string): Promise<void> {
  try {
    await admin.query('DELETE FROM messenger_messages WHERE queue_name = $1', [queueName]);
  } catch {
    // best-effort: the table may not exist when a scenario never sent anything
  }
}

async function receiveOne(transport: TransportInterface, timeoutMs = 5000): Promise<Envelope> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    for await (const envelope of transport.get(controller.signal)) {
      return envelope;
    }
    throw new Error('no message received within the timeout');
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error('waitUntil timed out');
}

// Full transport contract against a real PostgreSQL (the dev:brokers / CI service).
runTransportConformanceTests({
  name: 'SqlTransport (postgres)',
  createTransport: () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName);
    return Promise.resolve({
      transport,
      cleanup: async () => {
        await transport.close();
        await cleanQueue(queueName);
      },
    });
  },
  capabilities: { delayedDelivery: true, listable: true },
});

describe('SqlTransport (postgres implementation specifics)', () => {
  it('constructs with every default and closes cleanly before any use', async () => {
    const transport = new SqlTransport({ dsn: DSN });
    await transport.close();
  });

  it('rejects an unsafe or non-lowercase table name at construction', () => {
    expect(() => new SqlTransport({ dsn: DSN, tableName: 'Bad-Name' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => new SqlTransport({ dsn: DSN, tableName: 'messenger; DROP TABLE x' })).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects an empty or oversized queue name at construction', () => {
    expect(() => new SqlTransport({ dsn: DSN, queueName: '' })).toThrow(InvalidArgumentError);
    expect(() => new SqlTransport({ dsn: DSN, queueName: 'q'.repeat(191) })).toThrow(
      InvalidArgumentError,
    );
  });

  it('throws when acking an envelope without a TransportMessageIdStamp', async () => {
    const transport = makeTransport(uniqueQueue());
    await expect(transport.ack(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );
    await transport.close();
  });

  it('refuses to send once the transport is closing', async () => {
    const transport = makeTransport(uniqueQueue());
    await transport.close();
    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('maps an unreachable server to TransportConnectionError', async () => {
    const transport = makeTransport(uniqueQueue(), { dsn: UNREACHABLE_DSN });
    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportConnectionError,
    );
    await transport.close();
  });

  it('with autoSetup disabled, fails typed until setup() creates the schema', async () => {
    const tableName = uniqueTable();
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { tableName, autoSetup: false });

    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportNotFoundError,
    );

    await transport.setup();
    await transport.send(new Envelope(new ConformanceMessage('x')));
    const received = await receiveOne(transport);
    expect((received.message as ConformanceMessage).id).toBe('x');
    await transport.ack(received);

    await transport.close();
    await admin.query(`DROP TABLE IF EXISTS ${tableName}`);
  });

  it('setup() re-creates a dropped schema even when auto-setup already ran', async () => {
    const tableName = uniqueTable();
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { tableName });
    await transport.send(new Envelope(new ConformanceMessage('first')));
    await transport.ack(await receiveOne(transport));

    await admin.query(`DROP TABLE ${tableName}`);
    await expect(
      transport.send(new Envelope(new ConformanceMessage('lost'))),
    ).rejects.toBeInstanceOf(TransportNotFoundError);

    await transport.setup(); // heals the memoized auto-setup
    await transport.send(new Envelope(new ConformanceMessage('second')));

    // Same instance on purpose (regression for ADR-007): the re-created table restarted
    // the id sequence, so this delivery reuses id 1 — an id this instance already settled
    // in the table's first life. Settle state is per-delivery (the in-flight set), so the
    // ack must perform a real DELETE; a remembered settled-id set used to swallow it,
    // leaving the delivery in flight and hanging close() on the drain.
    const received = await receiveOne(transport);
    expect((received.message as ConformanceMessage).id).toBe('second');
    await transport.ack(received);

    await transport.close();
    await admin.query(`DROP TABLE IF EXISTS ${tableName}`);
  });

  it('redelivers a message left in-flight beyond redeliverTimeoutSeconds', async () => {
    const queueName = uniqueQueue();
    const stalled = makeTransport(queueName); // default 3600s: never reclaims during the test
    const reaper = makeTransport(queueName, { redeliverTimeoutSeconds: 0 });
    await stalled.send(new Envelope(new ConformanceMessage('orphan')));

    // The stalled consumer claims the message but never acks (simulated crash).
    const seen = await receiveOne(stalled);
    expect((seen.message as ConformanceMessage).id).toBe('orphan');

    const reclaimed = await receiveOne(reaper);
    expect((reclaimed.message as ConformanceMessage).id).toBe('orphan');

    await reaper.ack(reclaimed);
    await stalled.ack(seen); // no-op DELETE; releases the stalled consumer's in-flight bookkeeping
    await stalled.close();
    await reaper.close();
    await cleanQueue(queueName);
  });

  it('discards undecodable rows instead of looping, and list() skips them', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName);
    await transport.send(new Envelope(new ConformanceMessage('real')));
    // Two poison rows, due before 'real': non-JSON headers, and an unregistered type.
    await admin.query(
      `INSERT INTO messenger_messages (queue_name, body, headers, available_at)
        VALUES ($1, '{}', 'not-json', now() - interval '2 second'),
               ($1, '{}', $2, now() - interval '1 second')`,
      [queueName, JSON.stringify({ 'X-Message-Type': 'GhostMessage', 'X-Message-Stamps': '[]' })],
    );

    const listedIds: string[] = [];
    for await (const envelope of transport.list()) {
      listedIds.push((envelope.message as ConformanceMessage).id);
    }
    expect(listedIds).toStrictEqual(['real']);

    const received = await receiveOne(transport);
    expect((received.message as ConformanceMessage).id).toBe('real');
    await transport.ack(received);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('round-trips (including a redelivery) with useNotify disabled', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { useNotify: false, pollIntervalMs: 15 });

    const pendingFirst = receiveOne(transport, 3000);
    await delay(60); // let the consumer poll empty a few times first
    await transport.send(new Envelope(new ConformanceMessage('plain')));
    const first = await pendingFirst;
    await transport.reject(first);

    const second = await receiveOne(transport);
    expect(second.last(RedeliveryStamp)?.retryCount).toBe(1);
    await transport.ack(second);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('wakes an idle consumer through NOTIFY well before the poll cap', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { getNotifyTimeoutMs: 8000 });

    const pending = receiveOne(transport, 6000);
    await delay(150); // the consumer is now blocked on the notify wait (cap 8s)
    const sentAt = Date.now();
    await transport.send(new Envelope(new ConformanceMessage('wake')));
    const received = await pending;

    // Without the NOTIFY wake-up this would take the full 8s cap and time out at 6s.
    expect(Date.now() - sentAt).toBeLessThan(2000);
    expect((received.message as ConformanceMessage).id).toBe('wake');
    await transport.ack(received);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('re-polls immediately when a NOTIFY raced the previous claim', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { getNotifyTimeoutMs: 8000 });
    const received: string[] = [];
    const controller = new AbortController();
    const consuming = (async () => {
      for await (const envelope of transport.get(controller.signal)) {
        received.push((envelope.message as ConformanceMessage).id);
        await transport.ack(envelope);
        if (received.length === 2) {
          controller.abort();
        }
      }
    })();

    await delay(120); // consumer idle on the notify wait
    // This send settles the waiter AND records the wake-up flag; the flag is consumed
    // by the first empty claim that follows m-1, re-polling instantly instead of
    // re-entering the long notify wait blindly.
    await transport.send(new Envelope(new ConformanceMessage('m-1')));
    await delay(120);
    await transport.send(new Envelope(new ConformanceMessage('m-2')));

    await consuming;
    expect(received).toStrictEqual(['m-1', 'm-2']);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('ignores notifications for other queues of the same table', async () => {
    const queueA = uniqueQueue('a');
    const queueB = uniqueQueue('b');
    const consumerA = makeTransport(queueA);
    const senderB = makeTransport(queueB);

    const pending = receiveOne(consumerA, 6000);
    await delay(120); // consumer A is waiting on the shared NOTIFY channel
    await senderB.send(new Envelope(new ConformanceMessage('for-b'))); // must NOT wake A into a result
    await delay(120);
    await consumerA.send(new Envelope(new ConformanceMessage('for-a')));

    const received = await pending;
    expect((received.message as ConformanceMessage).id).toBe('for-a');
    await consumerA.ack(received);
    await consumerA.close();
    await senderB.close();
    await cleanQueue(queueA);
    await cleanQueue(queueB);
  });

  it('falls back to polling when the LISTEN connection dies', async () => {
    const tableName = uniqueTable();
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { tableName, pollIntervalMs: 30 });

    const pending = receiveOne(transport, 8000);
    // Find and kill the transport's dedicated LISTEN backend.
    let listenerPid = 0;
    await waitUntil(async () => {
      const result = await admin.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE query = $1',
        [`LISTEN ${tableName}`],
      );
      listenerPid = result.rows[0]?.pid ?? 0;
      return listenerPid !== 0;
    });
    await admin.query('SELECT pg_terminate_backend($1)', [listenerPid]);
    await delay(80); // the client error propagates and the driver degrades to polling

    await transport.send(new Envelope(new ConformanceMessage('still-delivered')));
    const received = await pending;
    expect((received.message as ConformanceMessage).id).toBe('still-delivered');
    await transport.ack(received);
    await transport.close();
    await admin.query(`DROP TABLE IF EXISTS ${tableName}`);
  });

  it('survives idle pooled connections being terminated', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { useNotify: false });
    await transport.send(new Envelope(new ConformanceMessage('before')));

    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = 'idle' AND query NOT ILIKE 'LISTEN%'`,
    );
    await delay(100); // the pool notices the dead client and emits 'error' (swallowed)

    await transport.send(new Envelope(new ConformanceMessage('after')));
    const first = await receiveOne(transport);
    const second = await receiveOne(transport);
    expect(
      [first, second].map((envelope) => (envelope.message as ConformanceMessage).id).toSorted(),
    ).toStrictEqual(['after', 'before']);
    await transport.ack(first);
    await transport.ack(second);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('close() releases a consumer blocked on the notify wait', async () => {
    const transport = makeTransport(uniqueQueue());
    const controller = new AbortController();
    const consuming = (async () => {
      for await (const envelope of transport.get(controller.signal)) {
        void envelope; // unreachable: the queue stays empty
      }
    })();

    await delay(150); // the consumer is now inside the notify wait (cap 60s)
    await transport.close();
    await expect(consuming).resolves.toBeUndefined();
  });

  it('maps a redelivery failure once the table vanished, without hanging close()', async () => {
    const tableName = uniqueTable();
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { tableName });
    await transport.send(new Envelope(new ConformanceMessage('doomed')));
    const received = await receiveOne(transport);

    await admin.query(`DROP TABLE ${tableName}`);
    await expect(transport.reject(received)).rejects.toBeInstanceOf(TransportNotFoundError);
    await transport.close();
  });

  it('lists, finds and counts without consuming; ack of a found message deletes it', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName);
    await transport.send(new Envelope(new ConformanceMessage('a')));
    await transport.send(new Envelope(new ConformanceMessage('b')));

    const collect = async (limit?: number): Promise<Envelope[]> => {
      const out: Envelope[] = [];
      for await (const envelope of transport.list(limit)) {
        out.push(envelope);
      }
      return out;
    };

    expect(await transport.getMessageCount()).toBe(2);

    const listed = await collect();
    expect(listed.map((e) => (e.message as ConformanceMessage).id)).toStrictEqual(['a', 'b']);
    expect(await collect(1)).toHaveLength(1);

    const idA = String(listed[0]?.last(TransportMessageIdStamp)?.id);
    const found = await transport.find(idA);
    expect((found?.message as ConformanceMessage).id).toBe('a');
    expect(await transport.find('999999999999')).toBeUndefined();
    expect(await transport.find('not-a-bigint')).toBeUndefined();

    await transport.ack(found ?? new Envelope(new ConformanceMessage('unreachable')));
    const remaining = await collect();
    expect(remaining.map((e) => (e.message as ConformanceMessage).id)).toStrictEqual(['b']);
    expect(await transport.getMessageCount()).toBe(1);

    await transport.close();
    await cleanQueue(queueName);
  });
});

describe('PostgresDriver (edge waits)', () => {
  it('waitForMessage resolves immediately on an already-aborted signal', async () => {
    const driver = new PostgresDriver({
      dsn: DSN,
      tableName: 'messenger_messages',
      useNotify: true,
      pollIntervalMs: 20,
      getNotifyTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    controller.abort();

    await driver.waitForMessage('nobody', 3600, controller.signal); // must not hang
    await driver.close();
  });

  it('degrades to a plain poll sleep when the LISTEN connection cannot be established', async () => {
    const driver = new PostgresDriver({
      dsn: UNREACHABLE_DSN,
      tableName: 'messenger_messages',
      useNotify: true,
      pollIntervalMs: 10,
      getNotifyTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const start = Date.now();

    await driver.waitForMessage('nobody', 3600, controller.signal);
    expect(Date.now() - start).toBeLessThan(5000); // a poll-interval sleep, not the 60s cap
    await driver.close();
  });

  it('treats a failed next-available peek as "nothing scheduled" instead of failing the wait', async () => {
    const driver = new PostgresDriver({
      dsn: DSN,
      tableName: uniqueTable(), // never created: the peek query fails
      useNotify: true,
      pollIntervalMs: 10,
      getNotifyTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const waiting = driver.waitForMessage('nobody', 3600, controller.signal);
    await delay(50);
    controller.abort(); // the wait fell through to the full cap; abort releases it

    await expect(waiting).resolves.toBeUndefined();
    await driver.close();
  });
});
