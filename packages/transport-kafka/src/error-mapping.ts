import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';

/** kafkajs error class names that signal the broker is unreachable / a request failed in transit. */
const CONNECTION_ERROR_NAMES = new Set<string>([
  'KafkaJSConnectionError',
  'KafkaJSConnectionClosedError',
  'KafkaJSNumberOfRetriesExceeded',
  'KafkaJSRequestTimeoutError',
  'KafkaJSBrokerNotFound',
]);

/** Native socket error codes surfaced when the broker endpoint is unreachable. */
const CONNECTION_SOCKET_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/** kafkajs protocol-error `type`s that mean a topic/partition does not exist. */
const NOT_FOUND_PROTOCOL_TYPES = new Set<string>(['UNKNOWN_TOPIC_OR_PARTITION']);

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

function errorName(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const name: unknown = error.name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return undefined;
}

function protocolType(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'type' in error) {
    const type: unknown = error.type;
    if (typeof type === 'string') {
      return type;
    }
  }
  return undefined;
}

function socketCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/**
 * Wraps a raw `kafkajs` / native error into the typed hierarchy so middlewares (e.g. the
 * retry strategy) can branch on the error type. A missing topic/partition becomes
 * {@link TransportNotFoundError}; connection/timeout failures become
 * {@link TransportConnectionError}; everything else a generic {@link TransportError}. An
 * already-typed error is returned unchanged.
 */
export function mapKafkaError(operation: string, error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const message = `Kafka transport failed during "${operation}": ${errorMessage(error)}`;
  const type = protocolType(error);
  if (type !== undefined && NOT_FOUND_PROTOCOL_TYPES.has(type)) {
    return new TransportNotFoundError(message, { cause: error });
  }
  const name = errorName(error);
  const code = socketCode(error);
  if (
    (name !== undefined && CONNECTION_ERROR_NAMES.has(name)) ||
    (code !== undefined && CONNECTION_SOCKET_CODES.has(code))
  ) {
    return new TransportConnectionError(message, { cause: error });
  }
  return new TransportError(message, { cause: error });
}
