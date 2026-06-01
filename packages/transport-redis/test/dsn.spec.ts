import { TransportConnectionError } from '@schally/nestjs-messenger';
import { assertValidRedisDsn } from '../src/dsn';

describe('assertValidRedisDsn', () => {
  it.each(['redis://localhost:6379', 'redis://user:pass@host:6390/2', 'rediss://secure:6379'])(
    'accepts a valid DSN (%s)',
    (dsn) => {
      expect(() => {
        assertValidRedisDsn(dsn);
      }).not.toThrow();
    },
  );

  it('rejects a malformed DSN', () => {
    expect(() => {
      assertValidRedisDsn('not a dsn');
    }).toThrow(TransportConnectionError);
  });

  it('rejects an unsupported scheme', () => {
    expect(() => {
      assertValidRedisDsn('http://localhost:6379');
    }).toThrow(TransportConnectionError);
  });
});
