import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';

// gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html).
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_UNAVAILABLE = 14;
const CONNECTION_GRPC_CODES = new Set<number>([GRPC_DEADLINE_EXCEEDED, GRPC_UNAVAILABLE]);

/** Native socket error codes surfaced when the endpoint is unreachable. */
const CONNECTION_SOCKET_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Deliberately duck-typed rather than `instanceof Error`: errors minted by Node's core
 * (e.g. the AggregateError of a refused connection) belong to the host realm, and an
 * `instanceof` check fails for them inside a vm (as under jest).
 */
function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message: unknown = error.message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function errorCode(error: unknown): number | string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'number' || typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/** Whether an error signals the topic/subscription already exists (idempotent create). */
export function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === GRPC_ALREADY_EXISTS;
}

/**
 * Wraps a raw `@google-cloud/pubsub` / gRPC error into the typed hierarchy so middlewares
 * (e.g. the retry strategy) can branch on the error type. A missing topic/subscription
 * becomes {@link TransportNotFoundError}; transient/transport failures become
 * {@link TransportConnectionError}; everything else a generic {@link TransportError}. An
 * already-typed error is returned unchanged.
 */
export function mapPubSubError(operation: string, error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const message = `Google Pub/Sub transport failed during "${operation}": ${errorMessage(error)}`;
  const code = errorCode(error);
  if (code === GRPC_NOT_FOUND) {
    return new TransportNotFoundError(message, { cause: error });
  }
  if (
    (typeof code === 'number' && CONNECTION_GRPC_CODES.has(code)) ||
    (typeof code === 'string' && CONNECTION_SOCKET_CODES.has(code))
  ) {
    return new TransportConnectionError(message, { cause: error });
  }
  return new TransportError(message, { cause: error });
}
