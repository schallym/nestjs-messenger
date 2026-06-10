import { TransportConnectionError } from '@schally/nestjs-messenger';
import { dialectFromDsn } from '../src';
import { normalizeMysqlDsn } from '../src/dsn';

describe('dialectFromDsn', () => {
  it.each([
    ['postgres://user:pass@localhost:5432/db', 'postgres'],
    ['postgresql://user:pass@localhost:5432/db', 'postgres'],
    ['mysql://user:pass@localhost:3306/db', 'mysql'],
    ['mariadb://user:pass@localhost:3306/db', 'mysql'],
  ])('resolves %s to the %s dialect', (dsn, dialect) => {
    expect(dialectFromDsn(dsn)).toBe(dialect);
  });

  it('rejects a malformed DSN with a typed error', () => {
    expect(() => dialectFromDsn('not a url at all')).toThrow(TransportConnectionError);
  });

  it('rejects an unsupported scheme, naming the supported ones', () => {
    expect(() => dialectFromDsn('redis://localhost:6379')).toThrow(TransportConnectionError);
    expect(() => dialectFromDsn('redis://localhost:6379')).toThrow(/postgres:\/\//);
  });
});

describe('normalizeMysqlDsn', () => {
  it('rewrites the mariadb scheme to mysql for mysql2', () => {
    expect(normalizeMysqlDsn('mariadb://u:p@localhost:3306/db')).toBe(
      'mysql://u:p@localhost:3306/db',
    );
  });

  it('leaves a mysql DSN untouched', () => {
    expect(normalizeMysqlDsn('mysql://u:p@localhost:3306/db')).toBe(
      'mysql://u:p@localhost:3306/db',
    );
  });
});
