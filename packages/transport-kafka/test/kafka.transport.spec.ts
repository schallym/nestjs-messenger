import { randomUUID } from 'node:crypto';
import {
  Envelope,
  JsonSerializer,
  RedeliveryStamp,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
} from '@schally/nestjs-messenger';
import {
  ConformanceMessage,
  runTransportConformanceTests,
} from '@schally/nestjs-messenger/testing';
import { Kafka, logLevel } from 'kafkajs';
import { KafkaTransport } from '../src';

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');

function uniqueTopic(): string {
  return `t-${randomUUID().slice(0, 8)}`;
}

function makeTransport(
  topic: string,
  overrides: Partial<ConstructorParameters<typeof KafkaTransport>[0]> = {},
): KafkaTransport {
  return new KafkaTransport({
    brokers: BROKERS,
    topic,
    name: topic,
    groupId: topic, // a fresh group per topic so each test reads from the beginning
    serializer: new JsonSerializer([ConformanceMessage]),
    ...overrides,
  });
}

const admin = new Kafka({
  clientId: 'test-admin',
  brokers: BROKERS,
  logLevel: logLevel.NOTHING,
}).admin();

beforeAll(async () => {
  await admin.connect();
});

afterAll(async () => {
  await admin.disconnect();
});

async function deleteTopic(topic: string): Promise<void> {
  await admin.deleteTopics({ topics: [topic] }).catch(() => {
    /* best-effort cleanup */
  });
}

async function preCreate(topic: string): Promise<void> {
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
}

async function receiveOne(transport: TransportInterface, timeoutMs = 10_000): Promise<Envelope> {
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

// Full transport contract against a real Kafka broker. Kafka has no native per-message
// delay (DelayStamp ignored) and cannot enumerate messages, so delayedDelivery is opted out
// and the listable scenarios are not run.
runTransportConformanceTests({
  name: 'KafkaTransport',
  createTransport: () => {
    const topic = uniqueTopic();
    // 5 MiB so the conformance's 1 MB payload (plus envelope overhead) fits comfortably.
    const transport = makeTransport(topic, { maxMessageBytes: 5 * 1024 * 1024 });
    return Promise.resolve({
      transport,
      cleanup: async () => {
        await transport.close();
        await deleteTopic(topic);
      },
    });
  },
  capabilities: { delayedDelivery: false },
});

describe('KafkaTransport (implementation specifics)', () => {
  it('constructs with all defaults and with every option specified', async () => {
    const minimal = new KafkaTransport({ brokers: BROKERS, topic: uniqueTopic() });
    await minimal.close();

    const full = makeTransport(uniqueTopic(), {
      clientId: 'custom',
      autoCreate: true,
      numPartitions: 2,
      fromBeginning: true,
      kafkaConfig: {},
    });
    await full.close();
  });

  it('throws when acking an envelope without a TransportMessageIdStamp', async () => {
    const transport = makeTransport(uniqueTopic());
    await expect(transport.ack(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );
    await transport.close();
  });

  it('refuses to send once closing, and close() is idempotent', async () => {
    const transport = makeTransport(uniqueTopic());
    await transport.close();
    await transport.close();
    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('treats ack of a never-received envelope as a no-op', async () => {
    const transport = makeTransport(uniqueTopic());
    await transport.ack(
      new Envelope(new ConformanceMessage('ghost')).with(new TransportMessageIdStamp('0:0')),
    );
    await transport.close();
  });

  it('uses a pre-existing topic when autoCreate is false', async () => {
    const topic = uniqueTopic();
    await preCreate(topic);
    const transport = makeTransport(topic, { autoCreate: false });

    await transport.send(new Envelope(new ConformanceMessage('precreated')));
    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('precreated');
    await transport.ack(received);
    await transport.close();
    await deleteTopic(topic);
  });

  it('redelivers a never-received rejected envelope by re-publishing', async () => {
    const topic = uniqueTopic();
    const transport = makeTransport(topic);

    await transport.reject(
      new Envelope(new ConformanceMessage('rj')).with(new TransportMessageIdStamp('0:999')),
    );
    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('rj');
    expect(received.last(RedeliveryStamp)?.retryCount).toBe(1);
    await transport.ack(received);
    await transport.close();
    await deleteTopic(topic);
  });

  it('discards foreign and poison messages, still delivering a real one', async () => {
    const topic = uniqueTopic();
    await preCreate(topic);
    const transport = makeTransport(topic);
    const producer = new Kafka({
      clientId: 'raw',
      brokers: BROKERS,
      logLevel: logLevel.NOTHING,
    }).producer();
    await producer.connect();
    const nullValue = JSON.parse('null') as null;
    await producer.send({
      topic,
      messages: [
        { value: nullValue }, // a null-value message
        { value: '42' }, // a JSON primitive
        { value: '{}' }, // object without a body
        { value: '{"body":"x","headers":"nope"}' }, // headers not an object
        { value: 'not-json' }, // unparseable
      ],
    });
    await producer.disconnect();
    await transport.send(new Envelope(new ConformanceMessage('real')));

    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('real');
    await transport.ack(received);
    await transport.close();
    await deleteTopic(topic);
  });

  it('wakes a parked consumer loop when closing', async () => {
    const topic = uniqueTopic();
    const transport = makeTransport(topic);
    const controller = new AbortController();
    const received: Envelope[] = [];
    const consuming = (async () => {
      for await (const envelope of transport.get(controller.signal)) {
        received.push(envelope);
      }
    })();

    // Let get() join the group and park waiting on the empty topic, then close.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await transport.close();
    await consuming;

    expect(received).toHaveLength(0);
    await deleteTopic(topic);
  });

  it('maps a broker connection failure to a typed TransportError', async () => {
    const transport = new KafkaTransport({
      brokers: ['localhost:1'], // nothing listening -> connection refused
      topic: uniqueTopic(),
      serializer: new JsonSerializer([ConformanceMessage]),
      kafkaConfig: { retry: { retries: 1, initialRetryTime: 50, maxRetryTime: 100 } },
    });

    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );

    await transport.close();
  });
});
