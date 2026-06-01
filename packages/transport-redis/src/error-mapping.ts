import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';

/** Native socket error codes ioredis surfaces when the broker is unreachable. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function socketErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/** Whether a Redis error signals that the consumer group already exists (idempotent create). */
export function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BUSYGROUP');
}

/**
 * Wraps a raw ioredis/native error into the typed hierarchy so middlewares (e.g. the
 * retry strategy) can branch on the error type. Connection failures become
 * {@link TransportConnectionError}, a missing consumer group becomes
 * {@link TransportNotFoundError}, everything else a generic {@link TransportError}.
 * An already-typed error is returned unchanged.
 */
export function mapRedisError(operation: string, error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const message = `Redis transport failed during "${operation}": ${errorMessage(error)}`;
  const code = socketErrorCode(error);
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) {
    return new TransportConnectionError(message, { cause: error });
  }
  if (errorMessage(error).startsWith('NOGROUP')) {
    return new TransportNotFoundError(message, { cause: error });
  }
  return new TransportError(message, { cause: error });
}
