import { TransportError } from '@schally/nestjs-messenger';
import type * as pg from 'pg';
import {
  abortableSleep,
  loadOptionalModule,
  type MessageRow,
  type SqlDriver,
  type SqlValue,
} from './driver';
import { isPostgresTransientError } from './error-mapping';
import { withTransientRetry } from './transient-retry';

type PgModule = typeof pg;
type PgPool = pg.Pool;
type PgClient = pg.Client;
type PgQueryResultRow = pg.QueryResultRow;
type PgQueryResult<R extends PgQueryResultRow> = pg.QueryResult<R>;

export interface PostgresDriverConfig {
  readonly dsn: string;
  readonly tableName: string;
  readonly useNotify: boolean;
  readonly pollIntervalMs: number;
  readonly getNotifyTimeoutMs: number;
}

interface NotifyWaiter {
  readonly queueName: string;
  readonly settle: () => void;
}

/**
 * How long an idle consumer may wait on the NOTIFY channel before re-polling: until
 * the next delayed message is due (`nextMs`, floored at 10 ms — an overdue-but-locked
 * row should re-poll soon, not spin), capped at `capMs`; the full `capMs` when
 * nothing is scheduled.
 */
export function clampWaitMs(nextMs: number | undefined, capMs: number): number {
  if (nextMs === undefined) {
    return capMs;
  }
  return Math.min(Math.max(nextMs, 10), capMs);
}

/** `pg` is an optional peer dependency, loaded only when a postgres DSN is used. */
function loadPg(): PgModule {
  return loadOptionalModule(
    'pg',
    "The postgres dialect requires the optional peer dependency 'pg'. Install it: pnpm add pg",
  ) as PgModule;
}

/**
 * PostgreSQL dialect. Claims are a single round-trip (`UPDATE … WHERE id = (SELECT …
 * FOR UPDATE SKIP LOCKED) RETURNING`), so concurrent consumers never contend. Sends
 * fire `pg_notify(table, queue)` inside the INSERT statement — the modern Symfony
 * approach (no trigger, notification delivered on commit) — and idle consumers wait
 * on a dedicated LISTEN connection instead of hammering the table. Requires
 * PostgreSQL ≥ 9.5 (SKIP LOCKED).
 */
export class PostgresDriver implements SqlDriver {
  private readonly config: PostgresDriverConfig;
  private pool?: PgPool;
  private listenerPromise?: Promise<PgClient>;
  private listenerBroken = false;
  private readonly notifiedQueues = new Set<string>();
  private readonly waiters = new Set<NotifyWaiter>();

  constructor(config: PostgresDriverConfig) {
    this.config = config;
  }

  async setup(): Promise<void> {
    const table = this.config.tableName;
    await this.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        body TEXT NOT NULL,
        headers TEXT NOT NULL,
        queue_name VARCHAR(190) NOT NULL,
        created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        available_at TIMESTAMPTZ(3) NOT NULL,
        delivered_at TIMESTAMPTZ(3)
      )`,
      [],
    );
    await this.query(
      `CREATE INDEX IF NOT EXISTS ${table}_claim_idx
        ON ${table} (queue_name, available_at, delivered_at, id)`,
      [],
    );
  }

  async insert(queueName: string, body: string, headers: string, delayMs: number): Promise<string> {
    const { sql, values } = this.insertStatement(queueName, body, headers, delayMs);
    const result = await this.query<{ id: string }>(sql, values);
    const row = result.rows[0];
    /* istanbul ignore next -- @preserve INSERT … RETURNING always yields exactly one row; absence is unreachable. */
    if (row === undefined) {
      throw new TransportError('PostgreSQL INSERT returned no id.');
    }
    return row.id;
  }

  async claimOne(
    queueName: string,
    redeliverTimeoutSeconds: number,
  ): Promise<MessageRow | undefined> {
    return withTransientRetry(async () => {
      const result = await this.query<MessageRow>(this.claimSql(), [
        queueName,
        redeliverTimeoutSeconds,
      ]);
      return result.rows[0];
    }, isPostgresTransientError);
  }

  async deleteById(id: string): Promise<void> {
    await withTransientRetry(
      () => this.query(`DELETE FROM ${this.config.tableName} WHERE id = $1::bigint`, [id]),
      isPostgresTransientError,
    );
  }

  async redeliver(
    originalId: string,
    queueName: string,
    body: string,
    headers: string,
    delayMs: number,
  ): Promise<void> {
    await withTransientRetry(async () => {
      const client = await this.db().connect();
      // On failure the client is destroyed instead of released: the server then rolls
      // back the open transaction, which avoids an explicit (and itself fallible) ROLLBACK.
      let failed = true;
      try {
        await client.query('BEGIN');
        const { sql, values } = this.insertStatement(queueName, body, headers, delayMs);
        await client.query(sql, [...values]);
        await client.query(`DELETE FROM ${this.config.tableName} WHERE id = $1::bigint`, [
          originalId,
        ]);
        await client.query('COMMIT');
        failed = false;
      } finally {
        client.release(failed);
      }
    }, isPostgresTransientError);
  }

  async findById(id: string): Promise<MessageRow | undefined> {
    const result = await this.query<MessageRow>(
      `SELECT id::text AS id, body, headers FROM ${this.config.tableName} WHERE id = $1::bigint`,
      [id],
    );
    return result.rows[0];
  }

  async list(queueName: string, limit: number): Promise<readonly MessageRow[]> {
    const result = await this.query<MessageRow>(
      `SELECT id::text AS id, body, headers FROM ${this.config.tableName}
        WHERE queue_name = $1 ORDER BY available_at, id LIMIT $2`,
      [queueName, limit],
    );
    return result.rows;
  }

  async count(queueName: string, redeliverTimeoutSeconds: number): Promise<number> {
    const result = await this.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${this.config.tableName}
        WHERE queue_name = $1 AND available_at <= now()
          AND (delivered_at IS NULL OR delivered_at < now() - make_interval(secs => $2::double precision))`,
      [queueName, redeliverTimeoutSeconds],
    );
    // count(*) always yields exactly one row; summing avoids a dead `?? 0` branch.
    return result.rows.reduce((total, row) => total + row.count, 0);
  }

  async waitForMessage(
    queueName: string,
    redeliverTimeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.notifiedQueues.delete(queueName)) {
      return; // a send raced our empty claim — re-poll immediately
    }
    const listener = await this.listenClient();
    if (listener === undefined) {
      await abortableSleep(this.config.pollIntervalMs, signal);
      return;
    }
    // NOTIFY fires at send time, not when a delayed message becomes due — so the wait
    // is bounded by the next scheduled `available_at`, if any.
    const waitMs = clampWaitMs(
      await this.nextAvailableInMs(queueName, redeliverTimeoutSeconds),
      this.config.getNotifyTimeoutMs,
    );
    await this.waitForNotify(queueName, waitMs, signal);
  }

  async close(): Promise<void> {
    this.settleWaiters(() => true);
    await this.closeListener();
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private async closeListener(): Promise<void> {
    if (this.listenerPromise === undefined) {
      return;
    }
    try {
      const listener = await this.listenerPromise;
      await listener.end();
    } catch {
      // the listener never connected (consumer degraded to polling) — nothing to end
    }
  }

  private db(): PgPool {
    this.pool ??= this.createPool();
    return this.pool;
  }

  private createPool(): PgPool {
    const pgModule = loadPg();
    const pool = new pgModule.Pool({ connectionString: this.config.dsn });
    // An idle pooled client losing its connection emits 'error' on the pool; with no
    // listener that crashes the process. The pool evicts the dead client and the next
    // checkout opens a fresh one — observing the event IS the handling.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    pool.on('error', () => {});
    return pool;
  }

  private async query<R extends PgQueryResultRow = PgQueryResultRow>(
    text: string,
    values: readonly SqlValue[],
  ): Promise<PgQueryResult<R>> {
    return this.db().query<R>(text, [...values]);
  }

  private async listenClient(): Promise<PgClient | undefined> {
    if (!this.config.useNotify || this.listenerBroken) {
      return undefined;
    }
    // A failed LISTEN setup degrades to plain polling rather than poisoning every wait.
    try {
      this.listenerPromise ??= this.startListener();
      return await this.listenerPromise;
    } catch {
      this.listenerBroken = true;
      return undefined;
    }
  }

  private async startListener(): Promise<PgClient> {
    const pgModule = loadPg();
    // LISTEN needs a dedicated connection: notifications are events on one client,
    // not something a pooled, shared connection can wait on.
    const client = new pgModule.Client({ connectionString: this.config.dsn });
    await client.connect();
    client.on('notification', (notification) => {
      /* istanbul ignore next -- @preserve pg always delivers a payload string ('' when empty); undefined exists only in the type definition. */
      this.onNotification(notification.payload ?? '');
    });
    client.on('error', () => {
      this.abandonListener();
    });
    await client.query(`LISTEN ${this.config.tableName}`);
    return client;
  }

  /** The LISTEN connection died: wake everyone and fall back to poll-interval sleeps. */
  private abandonListener(): void {
    this.listenerBroken = true;
    this.settleWaiters(() => true);
  }

  private onNotification(queueName: string): void {
    // Remember the wake-up even if nobody is waiting right now: a notification that
    // arrives while the consumer is busy claiming must not be lost.
    this.notifiedQueues.add(queueName);
    this.settleWaiters((waiter) => waiter.queueName === queueName);
  }

  private settleWaiters(match: (waiter: NotifyWaiter) => boolean): void {
    // Snapshot first: settling removes the waiter from the set mid-iteration.
    const waiters = [...this.waiters];
    for (const waiter of waiters) {
      if (match(waiter)) {
        waiter.settle();
      }
    }
  }

  private waitForNotify(queueName: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const settle = (): void => {
        this.waiters.delete(waiter);
        clearTimeout(timer);
        signal.removeEventListener('abort', settle);
        resolve();
      };
      const waiter: NotifyWaiter = { queueName, settle };
      const timer = setTimeout(settle, timeoutMs);
      timer.unref();
      signal.addEventListener('abort', settle, { once: true });
      this.waiters.add(waiter);
    });
  }

  /**
   * Milliseconds until the next scheduled message of this queue, or undefined if none.
   * Best-effort peek: on failure it returns undefined (a full-cap wait) rather than
   * killing the consumer — the next claim will surface the real error, properly mapped.
   */
  private async nextAvailableInMs(
    queueName: string,
    redeliverTimeoutSeconds: number,
  ): Promise<number | undefined> {
    try {
      const result = await this.query<{ wait_ms: number | null }>(
        `SELECT ceil(extract(epoch FROM (min(available_at) - now())) * 1000)::double precision AS wait_ms
          FROM ${this.config.tableName}
          WHERE queue_name = $1
            AND (delivered_at IS NULL OR delivered_at < now() - make_interval(secs => $2::double precision))`,
        [queueName, redeliverTimeoutSeconds],
      );
      const [row] = result.rows;
      /* istanbul ignore next -- @preserve an aggregate SELECT always yields exactly one row. */
      if (row === undefined) {
        return undefined;
      }
      const { wait_ms: waitMs } = row;
      if (typeof waitMs === 'number') {
        return waitMs;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private claimSql(): string {
    const table = this.config.tableName;
    return `UPDATE ${table} SET delivered_at = now()
      WHERE id = (
        SELECT id FROM ${table}
          WHERE queue_name = $1 AND available_at <= now()
            AND (delivered_at IS NULL OR delivered_at < now() - make_interval(secs => $2::double precision))
          ORDER BY available_at, id LIMIT 1
          FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id, body, headers`;
  }

  private insertStatement(
    queueName: string,
    body: string,
    headers: string,
    delayMs: number,
  ): { sql: string; values: readonly SqlValue[] } {
    return this.config.useNotify
      ? {
          sql: this.insertWithNotifySql(),
          values: [queueName, body, headers, delayMs, this.config.tableName],
        }
      : { sql: this.insertSql(), values: [queueName, body, headers, delayMs] };
  }

  private insertSql(): string {
    return `INSERT INTO ${this.config.tableName} (queue_name, body, headers, available_at)
      VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision / 1000))
      RETURNING id::text AS id`;
  }

  private insertWithNotifySql(): string {
    // pg_notify inside the insert: delivered on commit, atomic with the row, no trigger
    // DDL. Channel = table name, payload = queue name (Symfony's modern convention).
    return `WITH inserted AS (
        INSERT INTO ${this.config.tableName} (queue_name, body, headers, available_at)
        VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision / 1000))
        RETURNING id
      )
      SELECT id::text AS id, pg_notify($5, $1) FROM inserted`;
  }
}
