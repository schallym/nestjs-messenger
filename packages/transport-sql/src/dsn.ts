import { TransportConnectionError } from '@schally/nestjs-messenger';

/** The two SQL dialects the transport speaks. MariaDB rides the `mysql` dialect. */
export type SqlDialect = 'postgres' | 'mysql';

const DIALECT_BY_SCHEME = new Map<string, SqlDialect>([
  ['postgres:', 'postgres'],
  ['postgresql:', 'postgres'],
  ['mysql:', 'mysql'],
  ['mariadb:', 'mysql'],
]);

/**
 * Resolves which dialect a DSN targets (`postgres://`/`postgresql://` vs
 * `mysql://`/`mariadb://`). Validated up front so a typo fails fast with a typed
 * {@link TransportConnectionError} instead of a cryptic driver error later. The DSN
 * itself is otherwise handed to the driver (`pg` / `mysql2`), which parses
 * host/port/auth/database.
 */
export function dialectFromDsn(dsn: string): SqlDialect {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new TransportConnectionError(`Invalid SQL DSN: "${dsn}".`);
  }
  const dialect = DIALECT_BY_SCHEME.get(url.protocol);
  if (dialect === undefined) {
    throw new TransportConnectionError(
      `Unsupported SQL DSN scheme "${url.protocol}" in "${dsn}". ` +
        'Use postgres://, postgresql://, mysql:// or mariadb://.',
    );
  }
  return dialect;
}

/** mysql2 only understands `mysql:` URIs; a `mariadb://` DSN is the same wire protocol. */
export function normalizeMysqlDsn(dsn: string): string {
  return dsn.replace(/^mariadb:/, 'mysql:');
}
