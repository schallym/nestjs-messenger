import { ok } from 'node:assert';
import {
  type Admin,
  type Consumer,
  type EachMessagePayload,
  Kafka,
  type KafkaConfig,
  type KafkaMessage,
  logLevel,
  type Producer,
} from 'kafkajs';
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
import { mapKafkaError } from './error-mapping';

export interface KafkaTransportOptions {
  /** Broker bootstrap addresses, e.g. `['localhost:9092']`. */
  readonly brokers: string[];
  /** Topic messages are produced to and consumed from. */
  readonly topic: string;
  /**
   * Consumer group id. Workers sharing it load-balance the topic's partitions. Defaults to
   * the transport `name` (one group per routing alias).
   */
  readonly groupId?: string;
  /**
   * Name surfaced in the {@link ReceivedStamp}. For retry to re-send to this transport it
   * MUST equal the routing alias it is registered under. Defaults to the topic.
   */
  readonly name?: string;
  /** kafkajs client id. Default `nestjs-messenger`. */
  readonly clientId?: string;
  /** Wire serializer. Default {@link JsonSerializer}; construct it with your message classes. */
  readonly serializer?: Serializer;
  /** Create the topic if missing (handy for dev). Default `true`. */
  readonly autoCreate?: boolean;
  /** Partitions for an auto-created topic. Default `1`. */
  readonly numPartitions?: number;
  /** Read the topic from its beginning on first join. Default `true`. */
  readonly fromBeginning?: boolean;
  /**
   * Max message size in bytes. Sets the auto-created topic's `max.message.bytes` and the
   * consumer's per-partition fetch size. Default `1048576` (1 MiB, Kafka's default); raise
   * it (and the broker's `message.max.bytes`) for larger payloads.
   */
  readonly maxMessageBytes?: number;
  /** Extra kafkajs client options (ssl, sasl, retry, ...). */
  readonly kafkaConfig?: Partial<KafkaConfig>;
}

interface BufferedMessage {
  readonly partition: number;
  readonly message: KafkaMessage;
}

interface Coordinate {
  readonly partition: number;
  readonly offset: string;
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
 * Transport backed by Apache Kafka (via `kafkajs`). Publishing produces to a topic;
 * consuming runs a single instance-level consumer (`consumer.run` with manual offset
 * commits) whose messages are bridged to the {@link TransportInterface.get} async iterator.
 *
 * `ack()` commits the message's offset; `reject()` redelivers by **re-publishing** a copy
 * with an incremented {@link RedeliveryStamp} and committing past the original (the ADR-004
 * infrastructure path) — Kafka has no per-message nack. Offsets are committed only on
 * `ack`/`reject`, so an un-acked message is reprocessed after a restart (at-least-once).
 *
 * **Limitations.** Kafka has no native per-message delay, so {@link DelayStamp} is ignored
 * (retries are immediate, not backed off). It also cannot enumerate messages without
 * consuming, so this transport is **not** `ListableReceiver`/`MessageRetriever` and cannot
 * back the `messenger:failed:*` inspection CLI — use a listable transport (e.g. Redis) as
 * the `failureTransport`.
 */
export class KafkaTransport implements TransportInterface {
  private readonly kafka: Kafka;
  private readonly topic: string;
  private readonly groupId: string;
  private readonly name: string;
  private readonly serializer: Serializer;
  private readonly autoCreate: boolean;
  private readonly numPartitions: number;
  private readonly fromBeginning: boolean;
  private readonly maxMessageBytes: number;

  private readonly buffer: BufferedMessage[] = [];
  private readonly wakers = new Set<() => void>();
  private readonly inFlight = new Map<string, Coordinate>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly drainWaiters: (() => void)[] = [];
  private producer: Producer | undefined;
  private consumer: Consumer | undefined;
  private admin: Admin | undefined;
  private consumerPromise: Promise<void> | undefined;
  private topicReady = false;
  private closing = false;

  constructor(options: KafkaTransportOptions) {
    this.topic = options.topic;
    this.name = options.name ?? options.topic;
    this.groupId = options.groupId ?? this.name;
    this.serializer = options.serializer ?? new JsonSerializer();
    this.autoCreate = options.autoCreate ?? true;
    this.numPartitions = options.numPartitions ?? 1;
    this.fromBeginning = options.fromBeginning ?? true;
    this.maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
    this.kafka = new Kafka({
      clientId: options.clientId ?? 'nestjs-messenger',
      brokers: options.brokers,
      logLevel: logLevel.NOTHING,
      ...options.kafkaConfig,
    });
  }

  async send(envelope: Envelope): Promise<Envelope> {
    if (this.closing) {
      throw new TransportError('Cannot send on a Kafka transport that is closing or closed.');
    }
    await this.ensureTopic();
    const { partition, offset } = await this.run('send', this.publish(envelope));
    return envelope.with(new TransportMessageIdStamp(`${partition.toString()}:${offset}`));
  }

  async *get(signal: AbortSignal): AsyncIterableIterator<Envelope> {
    await this.ensureConsumer();
    while (!signal.aborted && !this.closing) {
      const entry = this.buffer.shift();
      if (entry === undefined) {
        await this.waitForMessage(signal);
        continue;
      }
      const envelope = this.decode(entry.partition, entry.message);
      if (envelope === undefined) {
        // Foreign/poison message: commit past it so it is never redelivered.
        await this.run('discard', this.commit(entry.partition, entry.message.offset));
        continue;
      }
      this.inFlight.set(`${entry.partition.toString()}:${entry.message.offset}`, {
        partition: entry.partition,
        offset: entry.message.offset,
      });
      yield envelope;
    }
  }

  async ack(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    const coordinate = this.inFlight.get(id);
    if (coordinate === undefined) {
      // Already settled, or never delivered by this instance: the offset to commit is
      // gone with the in-flight entry, and forgetting settled deliveries immediately is
      // what keeps per-instance state bounded (ADR-007).
      return;
    }
    this.releaseInFlight(id);
    await this.run('ack', this.commit(coordinate.partition, coordinate.offset));
  }

  async reject(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    const coordinate = this.inFlight.get(id);
    if (coordinate === undefined) {
      // Already settled, or never delivered by this instance: redelivery re-publishes a
      // copy (not idempotent), so it must run at most once per in-flight delivery (ADR-007).
      return;
    }
    this.releaseInFlight(id);
    // One tracked promise for the whole settle: close()'s pending snapshot is taken the
    // moment the in-flight drain empties, so a separately-tracked commit would escape it
    // and race consumer.disconnect(), stranding the original's offset (ADR-007).
    await this.run('reject', this.redeliverAndCommit(envelope, coordinate));
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
    if (this.consumer !== undefined) {
      await this.consumer.disconnect();
    }
    if (this.producer !== undefined) {
      await this.producer.disconnect();
    }
    if (this.admin !== undefined) {
      await this.admin.disconnect();
    }
  }

  private ensureConsumer(): Promise<void> {
    this.consumerPromise ??= this.startConsumer();
    return this.consumerPromise;
  }

  private async startConsumer(): Promise<void> {
    await this.ensureTopic();
    const consumer = this.kafka.consumer({
      groupId: this.groupId,
      maxBytesPerPartition: this.maxMessageBytes,
    });
    await this.run('connect', consumer.connect());
    await this.run(
      'subscribe',
      consumer.subscribe({ topic: this.topic, fromBeginning: this.fromBeginning }),
    );
    this.consumer = consumer;
    await this.run(
      'consume',
      consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.onMessage(payload),
      }),
    );
  }

  private onMessage({ partition, message }: EachMessagePayload): Promise<void> {
    this.buffer.push({ partition, message });
    this.wakeOne();
    return Promise.resolve();
  }

  private async ensureTopic(): Promise<void> {
    if (this.topicReady) {
      return;
    }
    if (this.autoCreate) {
      await this.run('ensureTopic', this.createTopic());
    }
    this.topicReady = true;
  }

  private async createTopic(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    this.admin = admin;
    // Returns false (no throw) if the topic already exists — idempotent.
    await admin.createTopics({
      topics: [
        {
          topic: this.topic,
          numPartitions: this.numPartitions,
          configEntries: [{ name: 'max.message.bytes', value: this.maxMessageBytes.toString() }],
        },
      ],
      waitForLeaders: true,
    });
  }

  /**
   * Redeliver as a fresh published copy, then commit past the original (Kafka has no
   * per-message nack that could carry our incremented RedeliveryStamp). Commit strictly
   * after the publish: committing first could drop the original before the copy exists.
   */
  private async redeliverAndCommit(envelope: Envelope, coordinate: Coordinate): Promise<void> {
    await this.redeliver(envelope);
    await this.commit(coordinate.partition, coordinate.offset);
  }

  private async redeliver(envelope: Envelope): Promise<void> {
    const retryCount = (envelope.last(RedeliveryStamp)?.retryCount ?? 0) + 1;
    const redelivered = envelope.withoutAll(RedeliveryStamp).with(new RedeliveryStamp(retryCount));
    await this.publish(redelivered);
  }

  private async publish(envelope: Envelope): Promise<Coordinate> {
    const producer = await this.ensureProducer();
    const encoded = this.serializer.encode(envelope);
    const [metadata] = await producer.send({
      topic: this.topic,
      messages: [{ value: JSON.stringify(encoded) }],
    });
    ok(metadata, 'Kafka producer returned no record metadata');
    const { partition, baseOffset } = metadata;
    ok(baseOffset !== undefined, 'Kafka producer returned no offset');
    return { partition, offset: baseOffset };
  }

  private async ensureProducer(): Promise<Producer> {
    if (this.producer === undefined) {
      const producer = this.kafka.producer();
      await this.run('connect', producer.connect());
      this.producer = producer;
    }
    return this.producer;
  }

  private async commit(partition: number, offset: string): Promise<void> {
    ok(this.consumer, 'commit requires an active consumer');
    await this.consumer.commitOffsets([
      { topic: this.topic, partition, offset: (Number(offset) + 1).toString() },
    ]);
  }

  private decode(partition: number, message: KafkaMessage): Envelope | undefined {
    if (message.value === null) {
      return undefined; // a foreign message with no value
    }
    try {
      const parsed: unknown = JSON.parse(message.value.toString('utf8'));
      if (!isEncodedEnvelope(parsed)) {
        return undefined; // a foreign message not produced by this transport
      }
      return this.serializer
        .decode(parsed)
        .with(new ReceivedStamp(this.name))
        .with(new TransportMessageIdStamp(`${partition.toString()}:${message.offset}`));
    } catch {
      // Poison message (unregistered type, malformed stamps/headers): discard.
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
      throw mapKafkaError(operation, error);
    } finally {
      this.pending.delete(promise);
    }
  }
}
