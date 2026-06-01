import { TransportConnectionError } from '@schally/nestjs-messenger';

const SUPPORTED_SCHEMES = new Set(['redis:', 'rediss:']);

/**
 * Validates a Redis DSN (`redis://…` or `rediss://…` for TLS). The DSN is otherwise
 * handed to ioredis, which parses host/port/auth/db; we validate the shape up front so
 * a typo fails fast with a typed {@link TransportConnectionError} instead of a cryptic
 * connection error later.
 */
export function assertValidRedisDsn(dsn: string): void {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new TransportConnectionError(`Invalid Redis DSN: "${dsn}".`);
  }
  if (!SUPPORTED_SCHEMES.has(url.protocol)) {
    throw new TransportConnectionError(
      `Unsupported Redis DSN scheme "${url.protocol}" in "${dsn}". Use redis:// or rediss://.`,
    );
  }
}
