import { randomUUID } from 'node:crypto';
import {
  DelayStamp,
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
import { createPool, type Pool } from 'mysql2/promise';
import { SqlTransport, type SqlTransportOptions } from '../src';

const DSN = process.env.MYSQL_DSN ?? 'mysql://messenger:messenger@localhost:3306/messenger';
const MARIADB_SCHEME_DSN = DSN.replace(/^mysql:/, 'mariadb:');
const UNREACHABLE_DSN = 'mysql://messenger:messenger@localhost:59999/messenger';

const admin: Pool = createPool(DSN);

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
    await admin.query('DELETE FROM messenger_messages WHERE queue_name = ?', [queueName]);
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

// Full transport contract against a real MySQL (the dev:brokers / CI service).
runTransportConformanceTests({
  name: 'SqlTransport (mysql)',
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

describe('SqlTransport (mysql implementation specifics)', () => {
  it('constructs with every default and closes cleanly before any use', async () => {
    const transport = new SqlTransport({ dsn: DSN });
    await transport.close();
  });

  it('accepts a mariadb:// DSN (same wire protocol)', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName, { dsn: MARIADB_SCHEME_DSN });
    await transport.send(new Envelope(new ConformanceMessage('via-mariadb-scheme')));

    const received = await receiveOne(transport);
    expect((received.message as ConformanceMessage).id).toBe('via-mariadb-scheme');
    await transport.ack(received);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('maps an unreachable server to TransportConnectionError', async () => {
    const transport = makeTransport(uniqueQueue(), { dsn: UNREACHABLE_DSN });
    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportConnectionError,
    );
    await transport.close();
  });

  it('rejects PostgreSQL-only options for a mysql DSN at construction', () => {
    expect(() => new SqlTransport({ dsn: DSN, useNotify: true })).toThrow(InvalidArgumentError);
    expect(() => new SqlTransport({ dsn: DSN, getNotifyTimeoutMs: 5000 })).toThrow(
      InvalidArgumentError,
    );
  });

  it('retries a failed auto-setup instead of caching the rejection', async () => {
    const databaseName = `recover_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const url = new URL(DSN);
    const rootDsn = `mysql://root:messenger@${url.host}`;
    const rootAdmin = createPool(`${rootDsn}/mysql`);
    const queueName = uniqueQueue();
    const transport = new SqlTransport({
      dsn: `${rootDsn}/${databaseName}`,
      queueName,
      name: queueName,
      serializer: new JsonSerializer([ConformanceMessage]),
      pollIntervalMs: 20,
    });
    try {
      // The database does not exist yet: the first auto-setup attempt fails...
      await expect(
        transport.send(new Envelope(new ConformanceMessage('too-early'))),
      ).rejects.toBeInstanceOf(TransportError);

      // ...and must NOT poison the transport once the database appears (e.g. a worker
      // booting seconds before its database in a compose/k8s stack).
      await rootAdmin.query(`CREATE DATABASE ${databaseName}`);
      await transport.send(new Envelope(new ConformanceMessage('recovered')));
      const received = await receiveOne(transport);
      expect((received.message as ConformanceMessage).id).toBe('recovered');
      await transport.ack(received);
    } finally {
      await transport.close();
      await rootAdmin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await rootAdmin.end();
    }
  });

  it('redelivers a message left in-flight beyond redeliverTimeoutSeconds', async () => {
    const queueName = uniqueQueue();
    const stalled = makeTransport(queueName); // default 3600s: never reclaims during the test
    const reaper = makeTransport(queueName, { redeliverTimeoutSeconds: 0 });
    await stalled.send(new Envelope(new ConformanceMessage('orphan')));

    const seen = await receiveOne(stalled);
    const reclaimed = await receiveOne(reaper);
    expect((reclaimed.message as ConformanceMessage).id).toBe('orphan');

    await reaper.ack(reclaimed);
    await stalled.ack(seen); // no-op DELETE; releases the stalled consumer's bookkeeping
    await stalled.close();
    await reaper.close();
    await cleanQueue(queueName);
  });

  it('honors a DelayStamp carried by a rejected message on redelivery', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName);
    await transport.send(
      new Envelope(new ConformanceMessage('delayed-retry')).with(new DelayStamp(40)),
    );

    const first = await receiveOne(transport);
    await transport.reject(first); // the DelayStamp travels with the redelivered copy

    const second = await receiveOne(transport);
    expect(second.last(RedeliveryStamp)?.retryCount).toBe(1);
    await transport.ack(second);
    await transport.close();
    await cleanQueue(queueName);
  });

  it('discards undecodable rows instead of looping, and list() skips them', async () => {
    const queueName = uniqueQueue();
    const transport = makeTransport(queueName);
    await transport.send(new Envelope(new ConformanceMessage('real')));
    await admin.query(
      `INSERT INTO messenger_messages (queue_name, body, headers, created_at, available_at)
        VALUES (?, '{}', 'not-json', NOW(3), NOW(3) - INTERVAL 2 SECOND),
               (?, '{}', ?, NOW(3), NOW(3) - INTERVAL 1 SECOND)`,
      [
        queueName,
        queueName,
        JSON.stringify({ 'X-Message-Type': 'GhostMessage', 'X-Message-Stamps': '[]' }),
      ],
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

  it('maps a claim once the table vanished to TransportNotFoundError', async () => {
    const tableName = uniqueTable();
    const transport = makeTransport(uniqueQueue(), { tableName });
    await transport.send(new Envelope(new ConformanceMessage('x'))); // creates the table

    await admin.query(`DROP TABLE ${tableName}`);
    await expect(receiveOne(transport, 2000)).rejects.toBeInstanceOf(TransportNotFoundError);
    await transport.close();
  });

  it('maps a redelivery failure once the table vanished, without hanging close()', async () => {
    const tableName = uniqueTable();
    const transport = makeTransport(uniqueQueue(), { tableName });
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
