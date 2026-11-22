import { randomUUID } from 'node:crypto';
import {
  Envelope,
  JsonSerializer,
  RedeliveryStamp,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
  TransportNotFoundError,
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

// kafkajs's `waitForLeaders` fails on the UNKNOWN_TOPIC_OR_PARTITION a broker can answer for
// a just-created topic, so poll the metadata ourselves until the topic is visible.
async function preCreate(topic: string): Promise<void> {
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: false });
  for (let poll = 1; ; poll += 1) {
    try {
      await admin.fetchTopicMetadata({ topics: [topic] });
      return;
    } catch (error) {
      if (poll >= 50) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function unknownTopicError(): Error {
  return Object.assign(new Error('This server does not host this topic-partition'), {
    type: 'UNKNOWN_TOPIC_OR_PARTITION',
  });
}

/**
 * Makes the first `failures` topic-metadata lookups of every admin client created from now
 * on reject with `error`, then lets them reach the real broker. Reproduces on demand the
 * window in which a broker does not know yet about a topic it has just created. Returns a
 * mock that records each lookup.
 */
function failTopicMetadata(failures: number, error: Error): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with .call below
  const createAdmin = Kafka.prototype.admin;
  let remaining = failures;
  const lookups = jest.fn();
  jest.spyOn(Kafka.prototype, 'admin').mockImplementation(function (this: Kafka, config) {
    // eslint-disable-next-line unicorn/no-this-outside-of-class -- the Kafka client the spied method was called on
    const realAdmin = createAdmin.call(this, config);
    const fetchTopicMetadata = realAdmin.fetchTopicMetadata.bind(realAdmin);
    realAdmin.fetchTopicMetadata = (options) => {
      lookups();
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(error);
      }
      return fetchTopicMetadata(options);
    };
    return realAdmin;
  });
  return lookups;
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

  it('treats reject of a never-received envelope as a no-op (publishes no copy)', async () => {
    const topic = uniqueTopic();
    const transport = makeTransport(topic);

    // No in-flight delivery for this id: rejecting must not publish a redelivery copy
    // (there is also no offset to commit, so the copy would duplicate the original).
    await transport.reject(
      new Envelope(new ConformanceMessage('rj')).with(new TransportMessageIdStamp('0:999')),
    );
    await transport.send(new Envelope(new ConformanceMessage('real')));
    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('real');
    expect(received.last(RedeliveryStamp)).toBeUndefined();
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

  it('close() waits for every in-flight message, not only for the first one acked', async () => {
    const topic = uniqueTopic();
    const transport = makeTransport(topic);
    await transport.send(new Envelope(new ConformanceMessage('a')));
    await transport.send(new Envelope(new ConformanceMessage('b')));

    // Pull both deliveries before settling either, so two messages are in flight at once.
    const controller = new AbortController();
    const deliveries = transport.get(controller.signal)[Symbol.asyncIterator]();
    const first = await deliveries.next();
    const second = await deliveries.next();
    if (first.done === true || second.done === true) {
      throw new Error('expected two in-flight envelopes');
    }

    let closed = false;
    const closing = (async () => {
      await transport.close();
      closed = true;
    })();

    await transport.ack(first.value);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false); // the second delivery is still in flight

    await transport.ack(second.value);
    await closing;
    expect(closed).toBe(true);
    controller.abort();
    await deleteTopic(topic);
  });

  describe('auto-created topic not visible in the broker metadata yet', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('keeps polling until the topic shows up, then sends and receives normally', async () => {
      const topic = uniqueTopic();
      const lookups = failTopicMetadata(2, unknownTopicError());
      const transport = makeTransport(topic);

      await transport.send(new Envelope(new ConformanceMessage('late-topic')));
      const received = await receiveOne(transport);

      expect((received.message as ConformanceMessage).id).toBe('late-topic');
      expect(lookups).toHaveBeenCalledTimes(3);
      await transport.ack(received);
      await transport.close();
      await deleteTopic(topic);
    });

    it('gives up with a TransportNotFoundError when the topic never shows up', async () => {
      const topic = uniqueTopic();
      const lookups = failTopicMetadata(Number.POSITIVE_INFINITY, unknownTopicError());
      const transport = makeTransport(topic);

      await expect(
        transport.send(new Envelope(new ConformanceMessage('x'))),
      ).rejects.toBeInstanceOf(TransportNotFoundError);

      expect(lookups).toHaveBeenCalledTimes(50);
      await transport.close();
      await deleteTopic(topic);
    });

    it('does not retry a metadata failure that is not an unknown topic', async () => {
      const topic = uniqueTopic();
      const lookups = failTopicMetadata(1, new Error('boom'));
      const transport = makeTransport(topic);

      await expect(
        transport.send(new Envelope(new ConformanceMessage('x'))),
      ).rejects.toBeInstanceOf(TransportError);

      expect(lookups).toHaveBeenCalledTimes(1);
      await transport.close();
      await deleteTopic(topic);
    });
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
