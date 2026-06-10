import { TransportError } from '@schally/nestjs-messenger';

/**
 * Loads an optional peer dependency (`pg` / `mysql2`). Deliberately `require`, not a
 * dynamic `import()`: this package ships CommonJS, and a native import() emitted in
 * CJS breaks under vm-based runners without ESM support (e.g. a consumer's jest
 * suite), while `require` keeps the load both lazy and interceptable.
 */
export function loadOptionalModule(id: string, installHint: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy CJS load of an optional peer dependency; see docblock
    return require(id);
  } catch (error) {
    throw new TransportError(installHint, { cause: error });
  }
}

/** The only value shapes this transport ever binds to a SQL placeholder. */
export type SqlValue = string | number;

/** A stored message in wire form. Ids are stringified BIGINTs. */
export interface MessageRow {
  readonly id: string;
  readonly body: string;
  readonly headers: string;
}

/**
 * What a dialect must provide; the {@link SqlTransport} engine owns everything else
 * (serialization, idempotency, in-flight tracking, the poll loop). Internal contract —
 * not part of the public API. Mirrors Symfony's Connection / PostgreSqlConnection split.
 */
export interface SqlDriver {
  /** Idempotent DDL: create the table (and covering index) if missing. */
  setup(): Promise<void>;
  /** Insert a message due in `delayMs`; returns the new row id. PG also NOTIFYes. */
  insert(queueName: string, body: string, headers: string, delayMs: number): Promise<string>;
  /**
   * Atomically claim the oldest due message — `available_at` reached and not in-flight
   * (`delivered_at` unset or older than the redeliver timeout) — marking it in-flight.
   */
  claimOne(queueName: string, redeliverTimeoutSeconds: number): Promise<MessageRow | undefined>;
  /** Delete a row by id. Deleting an already-deleted row is a no-op (idempotent ack). */
  deleteById(id: string): Promise<void>;
  /** Atomically insert the redelivered copy and delete the original (one transaction). */
  redeliver(
    originalId: string,
    queueName: string,
    body: string,
    headers: string,
    delayMs: number,
  ): Promise<void>;
  findById(id: string): Promise<MessageRow | undefined>;
  list(queueName: string, limit: number): Promise<readonly MessageRow[]>;
  /** Messages currently claimable (due, not in-flight). */
  count(queueName: string, redeliverTimeoutSeconds: number): Promise<number>;
  /**
   * Block until a message may be available: LISTEN/NOTIFY wake-up on PostgreSQL, a
   * plain poll-interval sleep on MySQL. MUST resolve promptly on abort and on close,
   * and MUST NOT reject — a failed peek degrades to a plain wait; the next claim
   * surfaces the real error, properly mapped.
   */
  waitForMessage(
    queueName: string,
    redeliverTimeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Resolves after `ms`, or immediately when the signal aborts (or is already aborted). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
