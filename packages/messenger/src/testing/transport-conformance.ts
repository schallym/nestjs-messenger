import { ok } from 'node:assert';
import { Envelope } from '../envelope';
import { DelayStamp, ReceivedStamp, RedeliveryStamp, TransportMessageIdStamp } from '../stamps';
import type { Stamp } from '../stamps';
import { isListableReceiver, isMessageRetriever, type TransportInterface } from '../transport';

/**
 * Capabilities a transport opts into. A transport that cannot honor a capability
 * declares it `false`; the corresponding scenario is then skipped rather than failed.
 */
export interface ConformanceCapabilities {
  /** Whether the transport honors {@link DelayStamp}. When false, the delay scenario is skipped. */
  readonly delayedDelivery: boolean;
  /** Reserved for future scenarios (the `MessageCountAware` capability). */
  readonly messageCount?: boolean;
  /**
   * Whether the transport implements `ListableReceiver` + `MessageRetriever` (failure
   * inspection). When true, the suite also asserts the M7 ack-deletes contract: acking a
   * message located via `find()` removes it from `list()`, and a redelivered message
   * leaves no stale original behind. When false/omitted, those scenarios are skipped.
   */
  readonly listable?: boolean;
}

export interface ConformanceHarness {
  readonly transport: TransportInterface;
  readonly cleanup: () => Promise<void>;
}

export interface TransportConformanceOptions {
  /** Display name for the describe block. */
  readonly name: string;
  /** Build a fresh transport (and its teardown) for each scenario. */
  createTransport(): Promise<ConformanceHarness>;
  readonly capabilities: ConformanceCapabilities;
}

/**
 * Message used throughout the suite: an id for de-duplication and an optional payload.
 * Exported so a serializing transport can register it (e.g. `new JsonSerializer([ConformanceMessage])`)
 * to reconstruct it on the receiving side.
 */
export class ConformanceMessage {
  constructor(
    public readonly id: string,
    public readonly payload = '',
  ) {}
}

/** Assert a stamp is present and return it narrowed (avoids optional chaining in assertions). */
function expectStamp<S extends Stamp>(stamp: S | undefined): S {
  ok(stamp, 'expected a stamp to be present');
  return stamp;
}

function transportMessageId(envelope: Envelope): string {
  return String(expectStamp(envelope.last(TransportMessageIdStamp)).id);
}

/** Consume at most one envelope, resolving `undefined` if none arrives within the timeout. */
async function receiveWithin(
  transport: TransportInterface,
  timeoutMs: number,
): Promise<Envelope | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    for await (const envelope of transport.get(controller.signal)) {
      return envelope;
    }
    return undefined;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** Consume exactly one envelope, failing the test if none arrives. */
async function receiveOne(transport: TransportInterface): Promise<Envelope> {
  const envelope = await receiveWithin(transport, 1000);
  ok(envelope, 'expected a message to be received');
  return envelope;
}

/** Drain an async iterable of envelopes into an array (for `list()` assertions). */
async function collect(stream: AsyncIterable<Envelope>): Promise<Envelope[]> {
  const envelopes: Envelope[] = [];
  for await (const envelope of stream) {
    envelopes.push(envelope);
  }
  return envelopes;
}

/**
 * Validates a transport against the v0.1 conformance contract. Call it from a
 * transport package's test file:
 *
 * ```ts
 * runTransportConformanceTests({
 *   name: 'RedisStreamsTransport',
 *   createTransport: async () => ({ transport: new RedisStreamsTransport(...), cleanup: () => t.close() }),
 *   capabilities: { delayedDelivery: true },
 * });
 * ```
 */
export function runTransportConformanceTests(options: TransportConformanceOptions): void {
  describe(`${options.name} (transport conformance)`, () => {
    let transport: TransportInterface;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const harness = await options.createTransport();
      transport = harness.transport;
      cleanup = harness.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it('round-trips a message, tagging it with ReceivedStamp and TransportMessageIdStamp', async () => {
      const message = new ConformanceMessage('m-1', 'hello');
      await transport.send(new Envelope(message));

      const received = await receiveOne(transport);

      expect(received.message).toStrictEqual(message);
      expect(received.last(ReceivedStamp)).toBeDefined();
      expect(received.last(TransportMessageIdStamp)).toBeDefined();
      await transport.ack(received);
    });

    it('does not redeliver a message once it has been acked', async () => {
      await transport.send(new Envelope(new ConformanceMessage('m-1')));

      await transport.ack(await receiveOne(transport));

      expect(await receiveWithin(transport, 40)).toBeUndefined();
    });

    it('redelivers a rejected message with an incremented RedeliveryStamp', async () => {
      await transport.send(new Envelope(new ConformanceMessage('m-1')));

      const first = await receiveOne(transport);
      expect(first.last(RedeliveryStamp)).toBeUndefined();
      await transport.reject(first);

      const second = await receiveOne(transport);
      expect(expectStamp(second.last(RedeliveryStamp)).retryCount).toBe(1);
      await transport.reject(second);

      const third = await receiveOne(transport);
      expect(expectStamp(third.last(RedeliveryStamp)).retryCount).toBe(2);
      await transport.ack(third);
    });

    it('treats a second ack of the same message as a no-op', async () => {
      await transport.send(new Envelope(new ConformanceMessage('m-1')));

      const received = await receiveOne(transport);
      await transport.ack(received);
      await transport.ack(received);

      expect(await receiveWithin(transport, 40)).toBeUndefined();
    });

    it('treats a second reject of the same message as a no-op (single redelivery)', async () => {
      await transport.send(new Envelope(new ConformanceMessage('m-1')));

      const received = await receiveOne(transport);
      await transport.reject(received);
      await transport.reject(received);

      const redelivered = await receiveOne(transport);
      expect(expectStamp(redelivered.last(RedeliveryStamp)).retryCount).toBe(1);
      await transport.ack(redelivered);

      expect(await receiveWithin(transport, 40)).toBeUndefined();
    });

    it('ends the get() iterator cleanly when the AbortSignal is aborted', async () => {
      await transport.send(new Envelope(new ConformanceMessage('m-1')));
      const controller = new AbortController();
      const received: Envelope[] = [];
      const consuming = (async () => {
        for await (const envelope of transport.get(controller.signal)) {
          received.push(envelope);
          await transport.ack(envelope);
          controller.abort();
        }
      })();

      await expect(consuming).resolves.toBeUndefined();
      expect(received).toHaveLength(1);
    });

    it('waits for in-flight messages to settle before close() resolves', async () => {
      await transport.send(new Envelope(new ConformanceMessage('slow')));
      const controller = new AbortController();
      const order: string[] = [];
      const state = { processing: false };

      const consuming = (async () => {
        for await (const envelope of transport.get(controller.signal)) {
          state.processing = true;
          await new Promise((resolve) => setTimeout(resolve, 50));
          // Mark processing done *before* ack: close() must not resolve until this
          // in-flight message is settled, so 'processed' is guaranteed before 'closed'
          // even for an async transport whose ack involves real I/O.
          order.push('processed');
          await transport.ack(envelope);
          controller.abort();
        }
      })();

      // Wait until a message is genuinely in-flight before closing. Gating on this rather
      // than a fixed sleep keeps the test correct regardless of a transport's delivery
      // latency (e.g. a streaming pull's connection setup), while still proving close()
      // blocks until the in-flight message settles.
      while (!state.processing) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await transport.close();
      order.push('closed');
      await consuming;

      expect(order).toStrictEqual(['processed', 'closed']);
    });

    it('round-trips a large (1 MB) payload intact', async () => {
      const payload = 'x'.repeat(1024 * 1024);
      await transport.send(new Envelope(new ConformanceMessage('big', payload)));

      const received = await receiveOne(transport);

      expect((received.message as ConformanceMessage).payload).toHaveLength(payload.length);
      await transport.ack(received);
    });

    it('round-trips a payload with special characters intact', async () => {
      const payload = '🎉 "quotes" \n newline \t tab \\ backslash 日本語';
      await transport.send(new Envelope(new ConformanceMessage('special', payload)));

      const received = await receiveOne(transport);

      expect((received.message as ConformanceMessage).payload).toBe(payload);
      await transport.ack(received);
    });

    it('does not deliver the same message to two concurrent consumers', async () => {
      const total = 20;
      for (let i = 0; i < total; i += 1) {
        await transport.send(new Envelope(new ConformanceMessage(`m-${String(i)}`)));
      }

      const controller = new AbortController();
      const deliveredIds: string[] = [];
      const consume = async (): Promise<void> => {
        for await (const envelope of transport.get(controller.signal)) {
          deliveredIds.push(transportMessageId(envelope));
          await transport.ack(envelope);
          if (deliveredIds.length >= total) {
            controller.abort();
          }
        }
      };

      await Promise.all([consume(), consume()]);

      expect(deliveredIds).toHaveLength(total);
      expect(new Set(deliveredIds).size).toBe(total);
    });

    if (options.capabilities.delayedDelivery) {
      it('honors a DelayStamp before delivering the message', async () => {
        const start = Date.now();
        await transport.send(
          new Envelope(new ConformanceMessage('delayed')).with(new DelayStamp(150)),
        );

        const received = await receiveOne(transport);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThanOrEqual(350);
        await transport.ack(received);
      });
    }

    if (options.capabilities.listable) {
      it('removes a message located via find() from list() once acked (ack deletes)', async () => {
        ok(isListableReceiver(transport), 'a listable transport must implement list()');
        ok(isMessageRetriever(transport), 'a listable transport must implement find()');
        await transport.send(new Envelope(new ConformanceMessage('inspect')));

        const [listed] = await collect(transport.list());
        ok(listed, 'expected the sent message to be listable');
        const id = transportMessageId(listed);

        const found = await transport.find(id);
        ok(found, 'find() should return the listed message');
        await transport.ack(found);

        expect(await collect(transport.list())).toHaveLength(0);
      });

      it('redelivers a rejected message under a new id, leaving no stale original in list()', async () => {
        ok(isListableReceiver(transport), 'a listable transport must implement list()');
        await transport.send(new Envelope(new ConformanceMessage('redeliver')));

        const original = await receiveOne(transport);
        const originalId = transportMessageId(original);
        await transport.reject(original);

        const survivors = await collect(transport.list());
        expect(survivors).toHaveLength(1);
        const [survivor] = survivors;
        ok(survivor, 'expected exactly one message after redelivery');
        expect(transportMessageId(survivor)).not.toBe(originalId);
        expect(expectStamp(survivor.last(RedeliveryStamp)).retryCount).toBe(1);

        await transport.ack(await receiveOne(transport)); // drain the redelivered copy
      });
    }
  });
}
