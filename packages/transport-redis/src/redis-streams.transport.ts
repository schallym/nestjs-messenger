import { randomUUID } from 'node:crypto';
import {
  DelayStamp,
  type Envelope,
  JsonSerializer,
  type ListableReceiver,
  type MessageRetriever,
  ReceivedStamp,
  RedeliveryStamp,
  type Serializer,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
} from '@schally/nestjs-messenger';
import { Redis, type RedisOptions } from 'ioredis';
import { assertValidRedisDsn } from './dsn';
import { isBusyGroupError, mapRedisError } from './error-mapping';
import {
  parseAutoclaimReply,
  parseRangeReply,
  parseReadReply,
  type StreamEntry,
} from './stream-reply';

export interface RedisStreamsTransportOptions {
  /** Connection DSN, e.g. `redis://localhost:6379`. */
  readonly dsn: string;
  /** Stream key messages are appended to. */
  readonly stream: string;
  /**
   * Name surfaced in the {@link ReceivedStamp}. For retry to re-send to this transport
   * it MUST equal the routing alias it is registered under. Defaults to the stream key.
   */
  readonly name?: string;
  /** Consumer group. Default `messenger`. */
  readonly group?: string;
  /** Consumer name within the group. Default a unique host/pid/uuid string. */
  readonly consumer?: string;
  /**
   * Serializer used on the wire. Default {@link JsonSerializer}; pass one constructed
   * with your message classes so they can be reconstructed on the receiving side.
   */
  readonly serializer?: Serializer;
  /** Sorted-set key holding not-yet-due delayed messages. Default `<stream>:delayed`. */
  readonly delayKey?: string;
  /** Idle time (ms) after which a pending message is reclaimed from a dead consumer. Default 30000. */
  readonly claimIdleMs?: number;
  /** Pause (ms) between polls when the stream is empty. Default 50. */
  readonly pollIntervalMs?: number;
  /** Max messages read per poll. Default 10. */
  readonly readBatchSize?: number;
  /** Extra ioredis options merged into the connection. */
  readonly redisOptions?: RedisOptions;
}

/** Atomically pop every delayed member whose score (due time) is ≤ now. */
const DRAIN_DUE_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '0', ARGV[1])
for _, member in ipairs(due) do redis.call('ZREM', KEYS[1], member) end
return due`;

interface DelayedPayload {
  readonly body: string;
  readonly headers: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    timer.unref();
  });
}

/**
 * Transport backed by Redis Streams (`XADD`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`) — not
 * BullMQ (ADR-003). Delayed messages live in a sorted set and are promoted to the
 * stream when due; messages left pending by a dead consumer are reclaimed via
 * `XAUTOCLAIM`. `reject()` redelivers with an incremented {@link RedeliveryStamp}.
 */
export class RedisStreamsTransport
  implements TransportInterface, ListableReceiver, MessageRetriever
{
  private readonly redis: Redis;
  private readonly serializer: Serializer;
  private readonly name: string;
  private readonly stream: string;
  private readonly group: string;
  private readonly consumer: string;
  private readonly delayKey: string;
  private readonly claimIdleMs: number;
  private readonly pollIntervalMs: number;
  private readonly readBatchSize: number;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly inFlight = new Set<string>();
  private readonly drainWaiters: (() => void)[] = [];
  private groupEnsured = false;
  private closing = false;

  constructor(options: RedisStreamsTransportOptions) {
    assertValidRedisDsn(options.dsn);
    this.stream = options.stream;
    this.name = options.name ?? options.stream;
    this.group = options.group ?? 'messenger';
    this.consumer = options.consumer ?? `${process.pid.toString()}-${randomUUID()}`;
    this.serializer = options.serializer ?? new JsonSerializer();
    this.delayKey = options.delayKey ?? `${options.stream}:delayed`;
    this.claimIdleMs = options.claimIdleMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.readBatchSize = options.readBatchSize ?? 10;
    this.redis = new Redis(options.dsn, options.redisOptions ?? {});
  }

  async send(envelope: Envelope): Promise<Envelope> {
    if (this.closing) {
      throw new TransportError('Cannot send on a Redis transport that is closing or closed.');
    }
    const id = await this.run('send', this.enqueue(envelope));
    return envelope.with(new TransportMessageIdStamp(id));
  }

  async *get(signal: AbortSignal): AsyncIterableIterator<Envelope> {
    await this.ensureGroup();
    while (!this.shouldStopConsuming(signal)) {
      const entries = await this.pull();
      if (entries.length === 0) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      for (const entry of entries) {
        // Re-check between entries, not only per batch: the generator suspends at the
        // yield below, so close() (or an abort) can complete while the consumer settles
        // entry k. Yielding k+1 afterwards would register in-flight state whose settle
        // hits a quit connection; left un-yielded, the entry stays in the group's
        // pending list and is reclaimed via XAUTOCLAIM.
        if (this.shouldStopConsuming(signal)) {
          return;
        }
        const envelope = this.decode(entry);
        if (envelope === undefined) {
          await this.run('discard', this.redis.xack(this.stream, this.group, entry.id));
        } else {
          this.inFlight.add(entry.id);
          yield envelope;
        }
      }
    }
  }

  async ack(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    this.releaseInFlight(id);
    // XACK clears the pending list; XDEL deletes the entry so the stream doesn't grow
    // unbounded and so acking a message located via find() (failure inspection) removes it.
    // Both no-op for an already-deleted id — that, not a remembered set of settled ids,
    // is what makes a second ack harmless (per-instance state stays bounded, ADR-007).
    await this.run('ack', this.acknowledge(id));
  }

  async *list(limit?: number): AsyncIterableIterator<Envelope> {
    const reply = await this.run(
      'list',
      this.redis.xrange(this.stream, '-', '+', 'COUNT', limit ?? 100),
    );
    for (const entry of parseRangeReply(reply)) {
      const envelope = this.decode(entry);
      if (envelope !== undefined) {
        yield envelope;
      }
    }
  }

  async find(id: string): Promise<Envelope | undefined> {
    const reply = await this.run('find', this.redis.xrange(this.stream, id, id));
    const [entry] = parseRangeReply(reply);
    return entry === undefined ? undefined : this.decode(entry);
  }

  async reject(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    if (!this.inFlight.has(id)) {
      // Already settled, or never delivered by this instance: redelivery re-publishes a
      // copy (not idempotent), so it must run at most once per in-flight delivery (ADR-007).
      return;
    }
    this.releaseInFlight(id);
    await this.run('reject', this.redeliver(envelope, id));
  }

  async close(): Promise<void> {
    if (this.closing) {
      return; // idempotent: a second close (e.g. after a graceful worker shutdown) is a no-op
    }
    this.closing = true;
    if (this.inFlight.size > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
    await Promise.allSettled(this.pending);
    await this.redis.quit();
  }

  private async pull(): Promise<StreamEntry[]> {
    await this.drainDueDelayed();
    const reclaimed = await this.reclaimStalled();
    const fresh = await this.readBatch();
    return [...reclaimed, ...fresh];
  }

  /**
   * Both flags can flip while the generator is suspended at a yield/await. Kept as a
   * method (not inlined) because TS narrowing from the while-condition does not model
   * suspension and would mark the mid-batch re-check as an unnecessary condition.
   */
  private shouldStopConsuming(signal: AbortSignal): boolean {
    return signal.aborted || this.closing;
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupEnsured) {
      return;
    }
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!isBusyGroupError(error)) {
        throw mapRedisError('ensureGroup', error);
      }
    }
    this.groupEnsured = true;
  }

  private async drainDueDelayed(): Promise<void> {
    const members = (await this.run(
      'drainDelayed',
      this.redis.eval(DRAIN_DUE_SCRIPT, 1, this.delayKey, Date.now().toString()),
    )) as string[];
    for (const member of members) {
      const payload = JSON.parse(member) as DelayedPayload;
      await this.run('drainDelayed', this.appendToStream(payload.body, payload.headers));
    }
  }

  private async reclaimStalled(): Promise<StreamEntry[]> {
    const reply = await this.run(
      'reclaim',
      this.redis.xautoclaim(
        this.stream,
        this.group,
        this.consumer,
        this.claimIdleMs,
        '0',
        'COUNT',
        this.readBatchSize,
      ),
    );
    return parseAutoclaimReply(reply);
  }

  private async readBatch(): Promise<StreamEntry[]> {
    const reply = await this.run(
      'read',
      this.redis.xreadgroup(
        'GROUP',
        this.group,
        this.consumer,
        'COUNT',
        this.readBatchSize,
        'STREAMS',
        this.stream,
        '>',
      ),
    );
    return parseReadReply(reply);
  }

  private async redeliver(envelope: Envelope, id: string): Promise<void> {
    const retryCount = (envelope.last(RedeliveryStamp)?.retryCount ?? 0) + 1;
    const redelivered = envelope.withoutAll(RedeliveryStamp).with(new RedeliveryStamp(retryCount));
    await this.enqueue(redelivered);
    await this.acknowledge(id);
  }

  private async acknowledge(id: string): Promise<void> {
    await this.redis.xack(this.stream, this.group, id);
    await this.redis.xdel(this.stream, id);
  }

  private async enqueue(envelope: Envelope): Promise<string> {
    const encoded = this.serializer.encode(envelope);
    const headers = JSON.stringify(encoded.headers);
    const delayMs = envelope.last(DelayStamp)?.delayMs ?? 0;
    return delayMs > 0
      ? this.scheduleDelayed(encoded.body, headers, delayMs)
      : this.appendToStream(encoded.body, headers);
  }

  private async scheduleDelayed(body: string, headers: string, delayMs: number): Promise<string> {
    const nonce = randomUUID();
    const member = JSON.stringify({ nonce, body, headers } satisfies DelayedPayload & {
      nonce: string;
    });
    await this.redis.zadd(this.delayKey, (Date.now() + delayMs).toString(), member);
    return nonce;
  }

  private async appendToStream(body: string, headers: string): Promise<string> {
    const id = await this.redis.xadd(this.stream, '*', 'body', body, 'headers', headers);
    /* istanbul ignore next -- @preserve XADD with '*' always returns the new entry id; null is unreachable. */
    if (id === null) {
      throw new TransportError('Redis XADD returned no id.');
    }
    return id;
  }

  private decode(entry: StreamEntry): Envelope | undefined {
    const body = entry.fields.get('body');
    const headers = entry.fields.get('headers');
    if (body === undefined || headers === undefined) {
      return undefined; // a foreign entry written by something other than this transport
    }
    try {
      const envelope = this.serializer.decode({
        body,
        headers: JSON.parse(headers) as Record<string, string>,
      });
      return envelope
        .with(new ReceivedStamp(this.name))
        .with(new TransportMessageIdStamp(entry.id));
    } catch {
      // Poison entry (unregistered message type, malformed stamps/headers JSON): discard
      // it rather than let it loop forever via the stalled-message reaper. The caller XACKs.
      return undefined;
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
      throw mapRedisError(operation, error);
    } finally {
      this.pending.delete(promise);
    }
  }
}
