import {
  DelayStamp,
  type Envelope,
  InvalidArgumentError,
  JsonSerializer,
  type ListableReceiver,
  type MessageCountAware,
  type MessageRetriever,
  ReceivedStamp,
  RedeliveryStamp,
  type Serializer,
  TransportError,
  type TransportInterface,
  TransportMessageIdStamp,
} from '@schally/nestjs-messenger';
import { dialectFromDsn, normalizeMysqlDsn, type SqlDialect } from './dsn';
import { type MessageRow, type SqlDriver } from './driver';
import { mapMysqlError, mapPostgresError } from './error-mapping';
import { MysqlDriver } from './mysql.driver';
import { PostgresDriver } from './postgres.driver';

export interface SqlTransportOptions {
  /** Connection DSN: `postgres://`, `postgresql://`, `mysql://` or `mariadb://`. */
  readonly dsn: string;
  /** Logical queue within the shared table. Default `default`. */
  readonly queueName?: string;
  /**
   * Name surfaced in the {@link ReceivedStamp}. For retry to re-send to this transport
   * it MUST equal the routing alias it is registered under. Defaults to the queue name.
   */
  readonly name?: string;
  /** Table holding the messages. Default `messenger_messages` (Symfony's). */
  readonly tableName?: string;
  /**
   * Serializer used on the wire. Default {@link JsonSerializer}; pass one constructed
   * with your message classes so they can be reconstructed on the receiving side.
   */
  readonly serializer?: Serializer;
  /**
   * Seconds after which an in-flight message (claimed but neither acked nor rejected —
   * e.g. its worker crashed) becomes claimable again. Default 3600, like Symfony.
   * Must exceed your longest handler duration or a second delivery starts early.
   */
  readonly redeliverTimeoutSeconds?: number;
  /** Create the table (and index) lazily on first use. Default true. */
  readonly autoSetup?: boolean;
  /** Pause (ms) between claim attempts when polling an empty queue. Default 100. */
  readonly pollIntervalMs?: number;
  /** PostgreSQL only: wake idle consumers via LISTEN/NOTIFY. Default true. */
  readonly useNotify?: boolean;
  /** PostgreSQL only: max idle wait (ms) on the NOTIFY channel per cycle. Default 60000. */
  readonly getNotifyTimeoutMs?: number;
}

/**
 * `^[a-z_][a-z0-9_]{0,47}$`: interpolated into SQL, so it must be a plain identifier —
 * and a lowercase one, because the NOTIFY channel (a string, never case-folded) must
 * match the LISTEN target (an identifier, case-folded by PostgreSQL).
 */
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,47}$/;
/** Mirrors Symfony's column length (MySQL utf8mb4 indexed-column limit). */
const QUEUE_NAME_MAX_LENGTH = 190;
const DEFAULT_LIST_LIMIT = 100;

function assertValidTableName(tableName: string): void {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new InvalidArgumentError(
      `Invalid table name "${tableName}": expected a lowercase SQL identifier matching ${String(TABLE_NAME_PATTERN)}.`,
    );
  }
}

function assertValidQueueName(queueName: string): void {
  if (queueName.length === 0 || queueName.length > QUEUE_NAME_MAX_LENGTH) {
    throw new InvalidArgumentError(
      `Invalid queue name "${queueName}": expected 1 to ${String(QUEUE_NAME_MAX_LENGTH)} characters.`,
    );
  }
}

/** Fail fast instead of silently ignoring options the mysql dialect cannot honor. */
function assertNoPostgresOnlyOptions(options: SqlTransportOptions): void {
  if (options.useNotify !== undefined || options.getNotifyTimeoutMs !== undefined) {
    throw new InvalidArgumentError(
      'useNotify and getNotifyTimeoutMs are PostgreSQL-only options; remove them for a mysql:// or mariadb:// DSN.',
    );
  }
}

/**
 * Transport backed by PostgreSQL or MySQL/MariaDB — raw SQL over `pg`/`mysql2`, no ORM
 * (ADR-006). One `messenger_messages` table holds every queue; claims use
 * `FOR UPDATE SKIP LOCKED` so concurrent consumers never contend; an unacked message
 * resurrects after `redeliverTimeoutSeconds` (at-least-once). `reject()` redelivers
 * under a new id with an incremented {@link RedeliveryStamp}. Listable, so it is the
 * natural choice for a failure transport.
 */
export class SqlTransport
  implements TransportInterface, ListableReceiver, MessageRetriever, MessageCountAware
{
  private readonly driver: SqlDriver;
  private readonly mapError: (operation: string, error: unknown) => TransportError;
  private readonly serializer: Serializer;
  private readonly name: string;
  private readonly queueName: string;
  private readonly redeliverTimeoutSeconds: number;
  private readonly autoSetup: boolean;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly inFlight = new Set<string>();
  private readonly drainWaiters: (() => void)[] = [];
  private setupPromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: SqlTransportOptions) {
    const dialect = dialectFromDsn(options.dsn);
    const tableName = options.tableName ?? 'messenger_messages';
    assertValidTableName(tableName);
    this.queueName = options.queueName ?? 'default';
    assertValidQueueName(this.queueName);
    this.name = options.name ?? this.queueName;
    this.serializer = options.serializer ?? new JsonSerializer();
    this.redeliverTimeoutSeconds = options.redeliverTimeoutSeconds ?? 3600;
    this.autoSetup = options.autoSetup ?? true;
    this.driver = this.createDriver(dialect, options, tableName);
    this.mapError = dialect === 'postgres' ? mapPostgresError : mapMysqlError;
  }

  async send(envelope: Envelope): Promise<Envelope> {
    if (this.closing) {
      throw new TransportError('Cannot send on a SQL transport that is closing or closed.');
    }
    const encoded = this.serializer.encode(envelope);
    const delayMs = envelope.last(DelayStamp)?.delayMs ?? 0;
    const id = await this.run(
      'send',
      this.afterSetup(() =>
        this.driver.insert(this.queueName, encoded.body, JSON.stringify(encoded.headers), delayMs),
      ),
    );
    return envelope.with(new TransportMessageIdStamp(id));
  }

  async *get(signal: AbortSignal): AsyncIterableIterator<Envelope> {
    while (!signal.aborted && !this.closing) {
      // Inside the loop so a closed/aborted consumer never lazily opens a pool; the
      // memoized promise makes every iteration after the first free.
      await this.run('setup', this.ensureSetup());
      const row = await this.run(
        'claim',
        this.driver.claimOne(this.queueName, this.redeliverTimeoutSeconds),
      );
      if (row === undefined) {
        // Deliberately NOT tracked in `pending`: an idle NOTIFY wait can last up to
        // getNotifyTimeoutMs and close() must not block on it (the driver's close
        // settles the wait instead). Waits never reject (driver contract).
        await this.driver.waitForMessage(this.queueName, this.redeliverTimeoutSeconds, signal);
        continue;
      }
      const envelope = this.decode(row);
      if (envelope === undefined) {
        // Poison row (unregistered message type, malformed headers JSON): discard it
        // rather than let the redeliver timeout resurrect it forever.
        await this.run('discard', this.driver.deleteById(row.id));
        continue;
      }
      this.inFlight.add(row.id);
      yield envelope;
    }
  }

  async ack(envelope: Envelope): Promise<void> {
    const id = this.requireId(envelope);
    this.releaseInFlight(id);
    // DELETE of an already-deleted id is a no-op — that, not a remembered set of settled
    // ids, is what makes a second ack harmless while keeping per-instance state bounded
    // (ADR-007). It also lets acking a message located via find() (failure inspection)
    // delete it, and survives a re-created table restarting the id sequence: the fresh
    // delivery is in-flight, so its ack performs a real DELETE instead of being swallowed
    // by a stale idempotency entry from the table's first life.
    await this.run('ack', this.driver.deleteById(id));
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

  async *list(limit?: number): AsyncIterableIterator<Envelope> {
    const rows = await this.run(
      'list',
      this.afterSetup(() => this.driver.list(this.queueName, limit ?? DEFAULT_LIST_LIMIT)),
    );
    for (const row of rows) {
      const envelope = this.decode(row);
      if (envelope !== undefined) {
        yield envelope;
      }
    }
  }

  async find(id: string): Promise<Envelope | undefined> {
    if (!/^\d+$/.test(id)) {
      return undefined; // ids are BIGINTs; anything else cannot exist
    }
    const row = await this.run(
      'find',
      this.afterSetup(() => this.driver.findById(id)),
    );
    return row === undefined ? undefined : this.decode(row);
  }

  async getMessageCount(): Promise<number> {
    return this.run(
      'count',
      this.afterSetup(() => this.driver.count(this.queueName, this.redeliverTimeoutSeconds)),
    );
  }

  /** Create the schema explicitly — for `autoSetup: false` deployments. Idempotent. */
  async setup(): Promise<void> {
    await this.run('setup', this.trackSetup());
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
    await this.driver.close();
  }

  private createDriver(
    dialect: SqlDialect,
    options: SqlTransportOptions,
    tableName: string,
  ): SqlDriver {
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    if (dialect === 'postgres') {
      return new PostgresDriver({
        dsn: options.dsn,
        tableName,
        pollIntervalMs,
        useNotify: options.useNotify ?? true,
        getNotifyTimeoutMs: options.getNotifyTimeoutMs ?? 60_000,
      });
    }
    assertNoPostgresOnlyOptions(options);
    return new MysqlDriver({ dsn: normalizeMysqlDsn(options.dsn), tableName, pollIntervalMs });
  }

  private async redeliver(envelope: Envelope, id: string): Promise<void> {
    const retryCount = (envelope.last(RedeliveryStamp)?.retryCount ?? 0) + 1;
    const redelivered = envelope.withoutAll(RedeliveryStamp).with(new RedeliveryStamp(retryCount));
    const encoded = this.serializer.encode(redelivered);
    const delayMs = redelivered.last(DelayStamp)?.delayMs ?? 0;
    await this.driver.redeliver(
      id,
      this.queueName,
      encoded.body,
      JSON.stringify(encoded.headers),
      delayMs,
    );
  }

  private async ensureSetup(): Promise<void> {
    if (!this.autoSetup) {
      return;
    }
    await (this.setupPromise ?? this.trackSetup());
  }

  /**
   * Memoizes a successful setup only: a failure (e.g. the database not yet reachable
   * at worker boot) clears the memo so the next operation retries instead of replaying
   * a stale rejection forever. The explicit `setup()` also feeds this memo, so a
   * manual repair heals the instance.
   */
  private trackSetup(): Promise<void> {
    const setup = this.driver.setup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    this.setupPromise = setup;
    return setup;
  }

  private async afterSetup<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureSetup();
    return operation();
  }

  private decode(row: MessageRow): Envelope | undefined {
    try {
      const envelope = this.serializer.decode({
        body: row.body,
        headers: JSON.parse(row.headers) as Record<string, string>,
      });
      return envelope.with(new ReceivedStamp(this.name)).with(new TransportMessageIdStamp(row.id));
    } catch {
      // Undecodable content; the caller deletes (get) or skips (list/find) the row.
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
      throw this.mapError(operation, error);
    } finally {
      this.pending.delete(promise);
    }
  }
}
