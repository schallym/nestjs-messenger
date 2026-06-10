import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
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
import { GooglePubSubTransport } from '../src';

const PROJECT = process.env.PUBSUB_PROJECT_ID ?? 'messenger-test';

function uniqueNames(): { topic: string; subscription: string } {
  const id = randomUUID().slice(0, 8);
  return { topic: `t-${id}`, subscription: `s-${id}` };
}

function makeTransport(
  topic: string,
  subscription: string,
  overrides: Partial<ConstructorParameters<typeof GooglePubSubTransport>[0]> = {},
): GooglePubSubTransport {
  return new GooglePubSubTransport({
    projectId: PROJECT,
    topic,
    subscription,
    name: subscription,
    serializer: new JsonSerializer([ConformanceMessage]),
    ...overrides,
  });
}

const admin = new PubSub({ projectId: PROJECT });

async function deleteResources(topic: string, subscription: string): Promise<void> {
  await admin
    .topic(topic)
    .subscription(subscription)
    .delete()
    .catch(() => {
      /* best-effort cleanup */
    });
  await admin
    .topic(topic)
    .delete()
    .catch(() => {
      /* best-effort cleanup */
    });
}

async function preCreate(topic: string, subscription: string): Promise<void> {
  await admin.topic(topic).get({ autoCreate: true });
  await admin.topic(topic).subscription(subscription).get({ autoCreate: true });
}

async function receiveOne(transport: TransportInterface, timeoutMs = 8000): Promise<Envelope> {
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

afterAll(async () => {
  await admin.close();
});

// Full transport contract against the Pub/Sub emulator. Pub/Sub has no native per-message
// delay (DelayStamp is ignored) and cannot enumerate messages, so delayedDelivery is opted
// out and the listable scenarios are not run.
runTransportConformanceTests({
  name: 'GooglePubSubTransport',
  createTransport: () => {
    const { topic, subscription } = uniqueNames();
    const transport = makeTransport(topic, subscription);
    return Promise.resolve({
      transport,
      cleanup: async () => {
        await transport.close();
        await deleteResources(topic, subscription);
      },
    });
  },
  capabilities: { delayedDelivery: false },
});

describe('GooglePubSubTransport (implementation specifics)', () => {
  it('constructs with all defaults and with every option specified', async () => {
    const a = uniqueNames();
    const minimal = new GooglePubSubTransport({
      projectId: PROJECT,
      topic: a.topic,
      subscription: a.subscription,
    });
    await minimal.close();

    const b = uniqueNames();
    const full = makeTransport(b.topic, b.subscription, {
      name: 'custom',
      autoCreate: true,
      maxMessages: 5,
      ackDeadlineSeconds: 30,
      clientConfig: {},
    });
    await full.close();
  });

  it('throws when acking an envelope without a TransportMessageIdStamp', async () => {
    const { topic, subscription } = uniqueNames();
    const transport = makeTransport(topic, subscription);

    await expect(transport.ack(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );

    await transport.close();
  });

  it('refuses to send once the transport is closing, and close() is idempotent', async () => {
    const { topic, subscription } = uniqueNames();
    const transport = makeTransport(topic, subscription);
    await transport.close();
    await transport.close(); // idempotent second close

    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('treats ack of a never-received envelope as a no-op', async () => {
    const { topic, subscription } = uniqueNames();
    const transport = makeTransport(topic, subscription);

    await transport.ack(
      new Envelope(new ConformanceMessage('ghost')).with(new TransportMessageIdStamp('999')),
    );

    await transport.close();
  });

  it('uses a pre-existing topic/subscription when autoCreate is false', async () => {
    const { topic, subscription } = uniqueNames();
    await preCreate(topic, subscription);
    const transport = makeTransport(topic, subscription, { autoCreate: false });

    await transport.send(new Envelope(new ConformanceMessage('precreated')));
    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('precreated');
    await transport.ack(received);
    await transport.close();
    await deleteResources(topic, subscription);
  });

  it('tolerates an already-existing topic/subscription (autoCreate race)', async () => {
    const { topic, subscription } = uniqueNames();
    await preCreate(topic, subscription);
    const transport = makeTransport(topic, subscription, { autoCreate: true });

    await transport.send(new Envelope(new ConformanceMessage('exists')));
    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('exists');
    await transport.ack(received);
    await transport.close();
    await deleteResources(topic, subscription);
  });

  it('treats reject of a never-received envelope as a no-op (publishes no copy)', async () => {
    const { topic, subscription } = uniqueNames();
    await preCreate(topic, subscription);
    const transport = makeTransport(topic, subscription);

    // No in-flight delivery for this id: rejecting must not publish a redelivery copy
    // (the original, never leased by this instance, would redeliver on its own anyway).
    await transport.reject(
      new Envelope(new ConformanceMessage('rj')).with(new TransportMessageIdStamp('absent')),
    );
    await transport.send(new Envelope(new ConformanceMessage('real')));
    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('real');
    expect(received.last(RedeliveryStamp)).toBeUndefined();
    await transport.ack(received);
    await transport.close();
    await deleteResources(topic, subscription);
  });

  it('discards foreign and poison messages, still delivering a real one', async () => {
    const { topic, subscription } = uniqueNames();
    await preCreate(topic, subscription);
    const transport = makeTransport(topic, subscription);
    // Raw publishes that are not a valid encoded envelope: a primitive, an object without a
    // body, an object with a non-object headers, and non-JSON — each exercises a decode branch.
    const raw = admin.topic(topic);
    await raw.publishMessage({ data: Buffer.from('42') });
    await raw.publishMessage({ data: Buffer.from('{}') });
    await raw.publishMessage({ data: Buffer.from('{"body":"x","headers":"nope"}') });
    await raw.publishMessage({ data: Buffer.from('not-json') });
    await transport.send(new Envelope(new ConformanceMessage('real')));

    const received = await receiveOne(transport);

    expect((received.message as ConformanceMessage).id).toBe('real');
    await transport.ack(received);
    await transport.close();
    await deleteResources(topic, subscription);
  });

  it('surfaces a streaming-pull error from get() as a typed TransportError', async () => {
    const { topic, subscription } = uniqueNames();
    // autoCreate:false against a non-existent subscription -> the stream emits NOT_FOUND.
    const transport = makeTransport(topic, subscription, { autoCreate: false });
    const controller = new AbortController();
    const consuming = (async () => {
      for await (const envelope of transport.get(controller.signal)) {
        void envelope;
      }
    })();

    await expect(consuming).rejects.toBeInstanceOf(TransportError);
    controller.abort();
    await transport.close();
  });

  it('maps a topic-create failure (invalid name) to a typed TransportError', async () => {
    const transport = makeTransport('Invalid Topic Name!', 's-x');

    await expect(transport.send(new Envelope(new ConformanceMessage('x')))).rejects.toBeInstanceOf(
      TransportError,
    );

    await transport.close();
  });

  it('maps a subscription-create failure (invalid name) to a typed TransportError', async () => {
    const { topic } = uniqueNames();
    const transport = makeTransport(topic, 'Invalid Sub Name!');
    const controller = new AbortController();
    const consuming = (async () => {
      for await (const envelope of transport.get(controller.signal)) {
        void envelope;
      }
    })();

    await expect(consuming).rejects.toBeInstanceOf(TransportError);
    controller.abort();
    await transport.close();
    await deleteResources(topic, 'unused');
  });
});
