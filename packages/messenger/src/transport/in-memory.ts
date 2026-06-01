import type { Envelope } from '../envelope';
import { TransportError } from '../errors';
import { DelayStamp, ReceivedStamp, RedeliveryStamp, TransportMessageIdStamp } from '../stamps';
import type { ListableReceiver, MessageCountAware, MessageRetriever } from './capabilities';
import type { TransportInterface } from './transport.interface';

interface QueueEntry {
  readonly id: string;
  readonly envelope: Envelope;
  readonly availableAt: number;
}

const POLL_INTERVAL_MS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    timer.unref();
  });
}

export interface InMemoryTransportOptions {
  /** Name surfaced in the {@link ReceivedStamp} of consumed envelopes. Defaults to `in-memory`. */
  readonly name?: string;
}

/**
 * Reference, in-process transport. It keeps envelopes in arrays — nothing leaves the
 * process — which makes it ideal for unit tests, synchronous setups, and as the
 * implementation the conformance suite is first validated against.
 *
 * Delivery is FIFO among available messages; a {@link DelayStamp} holds a message back
 * until its delay elapses. `reject()` redelivers with an incremented {@link RedeliveryStamp}.
 * `close()` resolves once every in-flight (delivered-but-unsettled) message has been
 * acked or rejected.
 */
export class InMemoryTransport
  implements TransportInterface, MessageCountAware, ListableReceiver, MessageRetriever
{
  private readonly name: string;
  private queue: QueueEntry[] = [];
  private readonly inFlight = new Map<string, QueueEntry>();
  private readonly drainWaiters: (() => void)[] = [];
  private nextId = 0;
  private closing = false;

  constructor(options: InMemoryTransportOptions = {}) {
    this.name = options.name ?? 'in-memory';
  }

  send(envelope: Envelope): Promise<Envelope> {
    if (this.closing) {
      // Refuse new work once shutdown has started, so a late send (e.g. a retry
      // re-send racing close()) surfaces instead of being silently stranded.
      throw new TransportError('Cannot send on a transport that is closing or closed.');
    }
    const id = this.nextMessageId();
    const delayMs = envelope.last(DelayStamp)?.delayMs ?? 0;
    this.queue.push({ id, envelope, availableAt: Date.now() + delayMs });
    return Promise.resolve(envelope.with(new TransportMessageIdStamp(id)));
  }

  async *get(signal: AbortSignal): AsyncIterableIterator<Envelope> {
    while (!signal.aborted && !this.closing) {
      const entry = this.takeAvailable();
      if (entry === undefined) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      yield entry.envelope
        .with(new ReceivedStamp(this.name))
        .with(new TransportMessageIdStamp(entry.id));
    }
  }

  // `requireId` enforces a precondition (you can only ack/reject a received envelope);
  // a violation throws synchronously, which an `await`ing caller observes as a rejection.
  ack(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    // Remove from the queue too, so acking a message located via list()/find()
    // (e.g. failure-transport inspection) actually deletes it.
    this.queue = this.queue.filter((entry) => entry.id !== id);
    this.settle(id);
    return Promise.resolve();
  }

  reject(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    if (!this.inFlight.has(id)) {
      return Promise.resolve(); // already settled: idempotent no-op
    }
    const retryCount = (envelope.last(RedeliveryStamp)?.retryCount ?? 0) + 1;
    const redelivered = envelope
      .withoutAll(ReceivedStamp)
      .withoutAll(TransportMessageIdStamp)
      .withoutAll(RedeliveryStamp)
      .with(new RedeliveryStamp(retryCount));
    // A redelivery is a new delivery: give it a fresh transport id (a real broker
    // assigns a new id on re-enqueue), so message ids stay unique across attempts.
    this.queue.push({ id: this.nextMessageId(), envelope: redelivered, availableAt: Date.now() });
    this.settle(id);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.inFlight.size > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
  }

  getMessageCount(): Promise<number> {
    return Promise.resolve(this.queue.length);
  }

  // An async generator is required to satisfy the AsyncIterable contract, even though
  // this in-process transport has nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  async *list(limit?: number): AsyncIterableIterator<Envelope> {
    const entries = limit === undefined ? this.queue : this.queue.slice(0, limit);
    for (const entry of entries) {
      yield entry.envelope.with(new TransportMessageIdStamp(entry.id));
    }
  }

  find(id: string): Promise<Envelope | undefined> {
    const entry = this.queue.find((candidate) => candidate.id === id);
    return Promise.resolve(entry?.envelope.with(new TransportMessageIdStamp(entry.id)));
  }

  private nextMessageId(): string {
    const id = String(this.nextId);
    this.nextId += 1;
    return id;
  }

  private takeAvailable(): QueueEntry | undefined {
    const now = Date.now();
    const entry = this.queue.find((candidate) => candidate.availableAt <= now);
    if (entry === undefined) {
      return undefined;
    }
    this.queue = this.queue.filter((candidate) => candidate !== entry);
    this.inFlight.set(entry.id, entry);
    return entry;
  }

  private settle(id: string): void {
    this.inFlight.delete(id);
    if (this.inFlight.size === 0) {
      for (const resolve of this.drainWaiters.splice(0)) {
        resolve();
      }
    }
  }

  private requireId(envelope: Envelope): string {
    const stamp = envelope.last(TransportMessageIdStamp);
    if (stamp === undefined) {
      throw new TransportError(
        'Cannot ack or reject an envelope without a TransportMessageIdStamp.',
      );
    }
    return String(stamp.id);
  }
}
