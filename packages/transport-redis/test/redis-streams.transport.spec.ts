import { randomUUID } from 'node:crypto';
import {
  Envelope,
  JsonSerializer,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
} from '@schally/nestjs-messenger';
import {
  ConformanceMessage,
  runTransportConformanceTests,
} from '@schally/nestjs-messenger/testing';
import { Redis } from 'ioredis';
import { RedisStreamsTransport, type RedisStreamsTransportOptions } from '../src';

const DSN = process.env.REDIS_DSN ?? 'redis://localhost:6379';

function uniqueStream(): string {
  return `messenger:test:${randomUUID()}`;
}

function makeTransport(
  stream: string,
  overrides: Partial<RedisStreamsTransportOptions> = {},
): RedisStreamsTransport {
  return new RedisStreamsTransport({
    dsn: DSN,
    stream,
    name: stream,
    serializer: new JsonSerializer([ConformanceMessage]),
    pollIntervalMs: 10,
    ...overrides,
  });
}

async function deleteStream(stream: string): Promise<void> {
  const admin = new Redis(DSN);
  try {
    await admin.del(stream, `${stream}:delayed`);
  } finally {
    admin.disconnect();
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

// Full transport contract against a real Redis (the dev:brokers / CI Redis service).
runTransportConformanceTests({
  name: 'RedisStreamsTransport',
  createTransport: () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    return Promise.resolve({
      transport,
      cleanup: async () => {
        await transport.close();
        await deleteStream(stream);
      },
    });
  },
  capabilities: { delayedDelivery: true, listable: true },
});

describe('RedisStreamsTransport (implementation specifics)', () => {
  it('constructs with all defaults and with every option specified', async () => {
    const minimal = new RedisStreamsTransport({ dsn: DSN, stream: uniqueStream() });
    await minimal.close();

    const full = new RedisStreamsTransport({
      dsn: DSN,
      stream: uniqueStream(),
      name: 'custom-name',
      group: 'custom-group',
      consumer: 'custom-consumer',
      serializer: new JsonSerializer([ConformanceMessage]),
      delayKey: 'custom:delayed',
      claimIdleMs: 100,
      pollIntervalMs: 20,
      readBatchSize: 5,
    });
    await full.close();
  });

  it('throws when acking an envelope without a TransportMessageIdStamp', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);

    await expect(transport.ack(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );

    await transport.close();
    await deleteStream(stream);
  });

  it('refuses to send once the transport is closing', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    await transport.close();

    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );
    await deleteStream(stream);
  });

  it('maps a failed Redis command to a typed TransportError', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    const admin = new Redis(DSN);
    await admin.set(stream, 'not-a-stream'); // wrong type: XADD will fail with WRONGTYPE
    admin.disconnect();

    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );

    await transport.close();
    await deleteStream(stream);
  });

  it('maps a failure while ensuring the consumer group to a TransportError', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    const admin = new Redis(DSN);
    await admin.set(stream, 'not-a-stream'); // XGROUP CREATE will fail with WRONGTYPE
    admin.disconnect();

    const controller = new AbortController();
    const consuming = (async () => {
      for await (const envelope of transport.get(controller.signal)) {
        void envelope; // unreachable: ensureGroup fails first
      }
    })();

    await expect(consuming).rejects.toBeInstanceOf(TransportError);
    controller.abort();
    await transport.close();
    await deleteStream(stream);
  });

  it('discards foreign stream entries (missing body or headers) and still delivers real ones', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    const admin = new Redis(DSN);
    await admin.xadd(stream, '*', 'foreign', 'payload'); // no body, no headers
    await admin.xadd(stream, '*', 'body', '{}'); // body but no headers
    admin.disconnect();
    await transport.send(new Envelope(new ConformanceMessage('real')));

    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('real');
    await transport.ack(received);
    await transport.close();
    await deleteStream(stream);
  });

  it('discards a poison entry (undecodable content) instead of looping, and delivers real ones', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    const admin = new Redis(DSN);
    // Well-formed fields, but undecodable: an unregistered message type...
    await admin.xadd(
      stream,
      '*',
      'body',
      '{}',
      'headers',
      JSON.stringify({ 'X-Message-Type': 'GhostMessage', 'X-Message-Stamps': '[]' }),
    );
    // ...and non-JSON headers.
    await admin.xadd(stream, '*', 'body', '{}', 'headers', 'not-json');
    admin.disconnect();
    await transport.send(new Envelope(new ConformanceMessage('real')));

    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('real');
    await transport.ack(received);
    await transport.close();
    await deleteStream(stream);
  });

  it('lists and finds stored messages without consuming them, and ack deletes them', async () => {
    const stream = uniqueStream();
    const transport = makeTransport(stream);
    await transport.send(new Envelope(new ConformanceMessage('a')));
    await transport.send(new Envelope(new ConformanceMessage('b')));

    const collect = async (limit?: number): Promise<Envelope[]> => {
      const out: Envelope[] = [];
      for await (const envelope of transport.list(limit)) {
        out.push(envelope);
      }
      return out;
    };

    const listed = await collect();
    expect(listed.map((e) => (e.message as ConformanceMessage).id)).toStrictEqual(['a', 'b']);
    // list() must surface the transport id so the failure CLI can target a message.
    const idA = listed[0]?.last(TransportMessageIdStamp)?.id;
    expect(typeof idA).toBe('string');

    // The explicit-limit branch (vs. the default COUNT) caps the rows.
    expect(await collect(1)).toHaveLength(1);

    // find() returns the same envelope; a missing id resolves to undefined.
    const found = await transport.find(String(idA));
    expect((found?.message as ConformanceMessage).id).toBe('a');
    expect(await transport.find('0-0')).toBeUndefined();

    // ack deletes the entry (XACK + XDEL), so it no longer appears in list().
    await transport.ack(found ?? new Envelope(new ConformanceMessage('unreachable')));
    const remaining = await collect();
    expect(remaining.map((e) => (e.message as ConformanceMessage).id)).toStrictEqual(['b']);

    await transport.close();
    await deleteStream(stream);
  });

  it('reclaims a message left pending by a stalled consumer', async () => {
    const stream = uniqueStream();
    const stalled = makeTransport(stream, { consumer: 'stalled', claimIdleMs: 30_000 });
    const reaper = makeTransport(stream, { consumer: 'reaper', claimIdleMs: 10 });
    await stalled.send(new Envelope(new ConformanceMessage('orphan')));

    // The stalled consumer reads the message (now pending for it) but never acks.
    const readByStalled = await receiveOne(stalled);
    expect((readByStalled.message as ConformanceMessage).id).toBe('orphan');

    await delay(150); // comfortably exceed the reaper's claim-idle threshold, even under load

    // The reaper reclaims and re-delivers the orphaned message.
    const reclaimed = await receiveOne(reaper);
    expect((reclaimed.message as ConformanceMessage).id).toBe('orphan');

    await reaper.ack(reclaimed);
    await stalled.ack(readByStalled); // no-op XACK; releases the stalled consumer's in-flight bookkeeping
    await stalled.close();
    await reaper.close();
    await deleteStream(stream);
  });
});
