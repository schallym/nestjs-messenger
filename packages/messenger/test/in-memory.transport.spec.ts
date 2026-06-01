import {
  Envelope,
  InMemoryTransport,
  ReceivedStamp,
  TransportError,
  TransportMessageIdStamp,
} from '../src';
import { runTransportConformanceTests } from '../src/testing';

class TestMessage {
  constructor(public readonly id: string) {}
}

// The reference transport must pass the full conformance contract. We run the suite
// twice: once advertising delayed delivery (exercises the delay scenario) and once
// without it (exercises the suite's capability gate / skip path).
runTransportConformanceTests({
  name: 'InMemoryTransport',
  createTransport: () => {
    const transport = new InMemoryTransport();
    return Promise.resolve({ transport, cleanup: () => transport.close() });
  },
  capabilities: { delayedDelivery: true, listable: true },
});

runTransportConformanceTests({
  name: 'InMemoryTransport (delayed delivery opted out)',
  createTransport: () => {
    const transport = new InMemoryTransport();
    return Promise.resolve({ transport, cleanup: () => transport.close() });
  },
  capabilities: { delayedDelivery: false },
});

describe('InMemoryTransport (implementation specifics)', () => {
  it('tags consumed envelopes with the configured transport name', async () => {
    const transport = new InMemoryTransport({ name: 'orders' });
    await transport.send(new Envelope(new TestMessage('m-1')));

    const controller = new AbortController();
    let transportName: string | undefined;
    for await (const envelope of transport.get(controller.signal)) {
      transportName = envelope.last(ReceivedStamp)?.transportName;
      await transport.ack(envelope);
      controller.abort();
    }

    expect(transportName).toBe('orders');
    await transport.close();
  });

  it('reports the number of queued messages', async () => {
    const transport = new InMemoryTransport();
    expect(await transport.getMessageCount()).toBe(0);

    await transport.send(new Envelope(new TestMessage('a')));
    await transport.send(new Envelope(new TestMessage('b')));

    expect(await transport.getMessageCount()).toBe(2);
    await transport.close();
  });

  it('throws when acking an envelope that carries no TransportMessageIdStamp', async () => {
    const transport = new InMemoryTransport();

    expect(() => transport.ack(new Envelope(new TestMessage('m-1')))).toThrow(TransportError);
    await transport.close();
  });

  it('throws when rejecting an envelope that carries no TransportMessageIdStamp', async () => {
    const transport = new InMemoryTransport();

    expect(() => transport.reject(new Envelope(new TestMessage('m-1')))).toThrow(TransportError);
    await transport.close();
  });

  it('refuses to send once the transport is closing', async () => {
    const transport = new InMemoryTransport();
    await transport.close();

    expect(() => transport.send(new Envelope(new TestMessage('m-1')))).toThrow(TransportError);
  });

  it('assigns a fresh transport id to a redelivered (rejected) message', async () => {
    const transport = new InMemoryTransport();
    await transport.send(new Envelope(new TestMessage('m-1')));

    const controller = new AbortController();
    const ids: (string | number | undefined)[] = [];
    for await (const envelope of transport.get(controller.signal)) {
      const id = envelope.last(TransportMessageIdStamp)?.id;
      ids.push(id);
      if (ids.length === 1) {
        await transport.reject(envelope); // redeliver
      } else {
        await transport.ack(envelope);
        controller.abort();
      }
    }

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    await transport.close();
  });
});
