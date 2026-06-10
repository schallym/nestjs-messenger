import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';

/** Native socket error codes node surfaces when the database is unreachable. */
const SOCKET_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * PostgreSQL SQLSTATE prefixes that mean "the server cannot be used", not "this
 * query failed": class 08 (connection exception), class 28 (invalid authorization),
 * 57P* (admin shutdown / crash shutdown / cannot connect now).
 */
const POSTGRES_CONNECTION_PREFIXES = ['08', '28', '57P'];
const POSTGRES_UNDEFINED_TABLE = '42P01';
/** serialization_failure / deadlock_detected: retry the statement, don't fail the message. */
const POSTGRES_TRANSIENT_CODES = new Set(['40001', '40P01']);

/** mysql2 symbolic codes that mean the connection (not the query) is the problem. */
const MYSQL_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
]);
const MYSQL_NO_SUCH_TABLE = 'ER_NO_SUCH_TABLE';
/** Deadlock / lock-wait timeout: a normal cost of contention on InnoDB — retry. */
const MYSQL_TRANSIENT_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Deliberately duck-typed rather than `instanceof Error`: errors minted by Node's core
 * (e.g. the AggregateError of a refused connection) belong to the host realm, and an
 * `instanceof` check fails for them inside a vm (as under jest).
 */
function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

/** `pg` puts the SQLSTATE in `code`; `mysql2` a symbolic name; node a socket code. */
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/** Whether a raw `pg` error is worth retrying (deadlock / serialization failure). */
export function isPostgresTransientError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && POSTGRES_TRANSIENT_CODES.has(code);
}

/** Whether a raw `mysql2` error is worth retrying (deadlock / lock-wait timeout). */
export function isMysqlTransientError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && MYSQL_TRANSIENT_CODES.has(code);
}

/**
 * Wraps a raw `pg`/native error into the typed hierarchy so middlewares (e.g. the
 * retry strategy) can branch on the error type. An already-typed error is returned
 * unchanged.
 */
export function mapPostgresError(operation: string, error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const message = `PostgreSQL transport failed during "${operation}": ${errorMessage(error)}`;
  const code = errorCode(error);
  if (code !== undefined) {
    if (
      SOCKET_ERROR_CODES.has(code) ||
      POSTGRES_CONNECTION_PREFIXES.some((p) => code.startsWith(p))
    ) {
      return new TransportConnectionError(message, { cause: error });
    }
    if (code === POSTGRES_UNDEFINED_TABLE) {
      return new TransportNotFoundError(message, { cause: error });
    }
  }
  return new TransportError(message, { cause: error });
}

/**
 * Wraps a raw `mysql2`/native error into the typed hierarchy. An already-typed error
 * is returned unchanged.
 */
export function mapMysqlError(operation: string, error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const message = `MySQL transport failed during "${operation}": ${errorMessage(error)}`;
  const code = errorCode(error);
  if (code !== undefined) {
    if (SOCKET_ERROR_CODES.has(code) || MYSQL_CONNECTION_CODES.has(code)) {
      return new TransportConnectionError(message, { cause: error });
    }
    if (code === MYSQL_NO_SUCH_TABLE) {
      return new TransportNotFoundError(message, { cause: error });
    }
  }
  return new TransportError(message, { cause: error });
}
