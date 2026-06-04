import { type ClientConfig, type Message, PubSub, type Subscription } from '@google-cloud/pubsub';
import {
  type EncodedEnvelope,
  type Envelope,
  JsonSerializer,
  ReceivedStamp,
  RedeliveryStamp,
  type Serializer,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
} from '@schally/nestjs-messenger';
import { isAlreadyExistsError, mapPubSubError } from './error-mapping';

export interface GooglePubSubTransportOptions {
  /** GCP project id. With the emulator, set `PUBSUB_EMULATOR_HOST` and any project id. */
  readonly projectId: string;
  /** Topic messages are published to. */
  readonly topic: string;
  /** Subscription messages are pulled from. */
  readonly subscription: string;
  /**
   * Name surfaced in the {@link ReceivedStamp}. For retry to re-send to this transport it
   * MUST equal the routing alias it is registered under. Defaults to the subscription.
   */
  readonly name?: string;
  /** Wire serializer. Default {@link JsonSerializer}; construct it with your message classes. */
  readonly serializer?: Serializer;
  /** Create the topic/subscription if missing (handy for dev/emulator). Default `true`. */
  readonly autoCreate?: boolean;
  /** Max messages leased concurrently by the streaming pull. Default `10`. */
  readonly maxMessages?: number;
  /** Ack deadline (seconds) for an auto-created subscription. Default `60`. */
  readonly ackDeadlineSeconds?: number;
  /** Extra `@google-cloud/pubsub` client options merged into the connection. */
  readonly clientConfig?: ClientConfig;
}

function isEncodedEnvelope(value: unknown): value is EncodedEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { body?: unknown; headers?: unknown };
  return (
    typeof candidate.body === 'string' &&
    typeof candidate.headers === 'object' &&
    candidate.headers !== null
  );
}

/**
 * Transport backed by Google Cloud Pub/Sub. Publishing maps to a topic; consuming uses a
 * single instance-level streaming-pull subscription whose messages are bridged to the
 * {@link TransportInterface.get} async iterator (so `ack`/`reject` stay valid for the life
 * of the transport, not just one `get()` call, and concurrent consumers share the stream).
 *
 * `reject()` redelivers by **re-publishing** a copy with an incremented
 * {@link RedeliveryStamp} and acking the original (the ADR-004 infrastructure path), since
 * Pub/Sub's native nack cannot mutate the message.
 *
 * **Limitations.** Pub/Sub has no native per-message delay, so {@link DelayStamp} is
 * ignored (retries are immediate, not backed off). It also cannot enumerate messages
 * without consuming, so this transport is **not** `ListableReceiver`/`MessageRetriever`
 * and cannot back the `messenger:failed:*` inspection CLI — use a listable transport
 * (e.g. Redis) as the `failureTransport`.
 */
export class GooglePubSubTransport implements TransportInterface {
  private readonly pubsub: PubSub;
  private readonly topicId: string;
  private readonly subscriptionId: string;
  private readonly name: string;
  private readonly serializer: Serializer;
  private readonly autoCreate: boolean;
  private readonly maxMessages: number;
  private readonly ackDeadlineSeconds: number;

  private readonly buffer: Message[] = [];
  private readonly wakers = new Set<() => void>();
  private readonly inFlight = new Map<string, Message>();
  private readonly settled = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly drainWaiters: (() => void)[] = [];
  private subscription: Subscription | undefined;
  private streamPromise: Promise<void> | undefined;
  private streamError: unknown;
  private subscriptionReady = false;
  private closing = false;

  constructor(options: GooglePubSubTransportOptions) {
    this.topicId = options.topic;
    this.subscriptionId = options.subscription;
    this.name = options.name ?? options.subscription;
    this.serializer = options.serializer ?? new JsonSerializer();
    this.autoCreate = options.autoCreate ?? true;
    this.maxMessages = options.maxMessages ?? 10;
    this.ackDeadlineSeconds = options.ackDeadlineSeconds ?? 60;
    this.pubsub = new PubSub({ projectId: options.projectId, ...options.clientConfig });
  }

  async send(envelope: Envelope): Promise<Envelope> {
    if (this.closing) {
      throw new TransportError(
        'Cannot send on a Google Pub/Sub transport that is closing or closed.',
      );
    }
    // Ensure the SUBSCRIPTION (not just the topic): Pub/Sub only retains a message for
    // subscriptions that exist at publish time, and this transport is both sender and
    // receiver for its alias, so the subscription must exist before we publish.
    await this.ensureSubscription();
    const messageId = await this.run('send', this.publish(envelope));
    return envelope.with(new TransportMessageIdStamp(messageId));
  }

  async *get(signal: AbortSignal): AsyncIterableIterator<Envelope> {
    await this.ensureStream();
    while (!signal.aborted && !this.closing) {
      if (this.streamError !== undefined) {
        throw mapPubSubError('get', this.streamError);
      }
      const message = this.buffer.shift();
      if (message === undefined) {
        await this.waitForMessage(signal);
        continue;
      }
      const envelope = this.decode(message);
      if (envelope === undefined) {
        message.ack(); // foreign/poison message: discard so it never loops
        continue;
      }
      this.inFlight.set(message.id, message);
      yield envelope;
    }
  }

  // `async` so a missing-id precondition violation surfaces as a rejection, not a sync
  // throw; Pub/Sub's streaming-pull ack is fire-and-forget, so there is nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  async ack(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    if (this.settled.has(id)) {
      return;
    }
    this.settled.add(id);
    const message = this.inFlight.get(id);
    this.releaseInFlight(id);
    message?.ack();
  }

  async reject(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    if (this.settled.has(id)) {
      return;
    }
    this.settled.add(id);
    const message = this.inFlight.get(id);
    this.releaseInFlight(id);
    // Redeliver as a fresh published copy, then ack the original (Pub/Sub's nack can't
    // carry our incremented RedeliveryStamp).
    await this.run('reject', this.redeliver(envelope));
    message?.ack();
  }

  async close(): Promise<void> {
    if (this.closing) {
      return; // idempotent
    }
    this.closing = true;
    this.wakeAll();
    if (this.inFlight.size > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
    await Promise.allSettled(this.pending);
    if (this.subscription !== undefined) {
      await this.subscription.close();
    }
    await this.pubsub.close();
  }

  private ensureStream(): Promise<void> {
    this.streamPromise ??= this.startStream();
    return this.streamPromise;
  }

  private async startStream(): Promise<void> {
    await this.ensureSubscription();
    const subscription = this.pubsub.subscription(this.subscriptionId, {
      flowControl: { maxMessages: this.maxMessages, allowExcessMessages: false },
    });
    subscription.on('message', (message: Message) => {
      this.buffer.push(message);
      this.wakeOne();
    });
    subscription.on('error', (error: unknown) => {
      this.streamError = error;
      this.wakeAll();
    });
    this.subscription = subscription;
  }

  // Only ever called once, via ensureSubscription's subscriptionReady guard; createTopic
  // is idempotent regardless, so no separate topicReady latch is needed.
  private async ensureTopic(): Promise<void> {
    if (this.autoCreate) {
      await this.run('ensureTopic', this.createTopic());
    }
  }

  private async ensureSubscription(): Promise<void> {
    if (this.subscriptionReady) {
      return;
    }
    await this.ensureTopic();
    if (this.autoCreate) {
      await this.run('ensureSubscription', this.createSubscription());
    }
    this.subscriptionReady = true;
  }

  private async createTopic(): Promise<void> {
    try {
      await this.pubsub.createTopic(this.topicId);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private async createSubscription(): Promise<void> {
    try {
      await this.pubsub.topic(this.topicId).createSubscription(this.subscriptionId, {
        ackDeadlineSeconds: this.ackDeadlineSeconds,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private async redeliver(envelope: Envelope): Promise<void> {
    const retryCount = (envelope.last(RedeliveryStamp)?.retryCount ?? 0) + 1;
    const redelivered = envelope.withoutAll(RedeliveryStamp).with(new RedeliveryStamp(retryCount));
    await this.publish(redelivered);
  }

  private async publish(envelope: Envelope): Promise<string> {
    const encoded = this.serializer.encode(envelope);
    const data = Buffer.from(JSON.stringify(encoded), 'utf8');
    return this.pubsub.topic(this.topicId).publishMessage({ data });
  }

  private decode(message: Message): Envelope | undefined {
    try {
      const parsed: unknown = JSON.parse(message.data.toString('utf8'));
      if (!isEncodedEnvelope(parsed)) {
        return undefined; // a foreign message not produced by this transport
      }
      return this.serializer
        .decode(parsed)
        .with(new ReceivedStamp(this.name))
        .with(new TransportMessageIdStamp(message.id));
    } catch {
      // Poison message (unregistered type, malformed stamps/headers): discard rather than
      // redeliver forever. The caller acks it.
      return undefined;
    }
  }

  private waitForMessage(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        this.wakers.delete(wake);
        signal.removeEventListener('abort', wake);
        resolve();
      };
      this.wakers.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }

  private wakeOne(): void {
    const next = this.wakers.values().next().value;
    if (next !== undefined) {
      next();
    }
  }

  private wakeAll(): void {
    // Snapshot: each wake() removes itself from the set, so we can't iterate it live.
    const snapshot = [...this.wakers];
    for (const wake of snapshot) {
      wake();
    }
  }

  private releaseInFlight(id: string): void {
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

  private async run<T>(operation: string, promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    try {
      return await promise;
    } catch (error) {
      throw mapPubSubError(operation, error);
    } finally {
      this.pending.delete(promise);
    }
  }
}
