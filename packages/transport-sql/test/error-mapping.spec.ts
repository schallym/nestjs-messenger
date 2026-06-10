import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';
import {
  isMysqlTransientError,
  isPostgresTransientError,
  mapMysqlError,
  mapPostgresError,
} from '../src/error-mapping';

function errorWithCode(code: unknown): Error {
  return Object.assign(new Error('boom'), { code });
}

describe('mapPostgresError', () => {
  it('returns an already-typed error unchanged', () => {
    const typed = new TransportNotFoundError('gone');
    expect(mapPostgresError('claim', typed)).toBe(typed);
  });

  it.each(['ECONNREFUSED', '08006', '28P01', '57P01'])(
    'maps %s to TransportConnectionError',
    (code) => {
      const mapped = mapPostgresError('claim', errorWithCode(code));
      expect(mapped).toBeInstanceOf(TransportConnectionError);
      expect(mapped.message).toContain('claim');
      expect(mapped.cause).toBeInstanceOf(Error);
    },
  );

  it('maps undefined_table (42P01) to TransportNotFoundError', () => {
    expect(mapPostgresError('send', errorWithCode('42P01'))).toBeInstanceOf(TransportNotFoundError);
  });

  it('maps any other SQLSTATE to the base TransportError', () => {
    const mapped = mapPostgresError('send', errorWithCode('23505'));
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped).not.toBeInstanceOf(TransportConnectionError);
    expect(mapped).not.toBeInstanceOf(TransportNotFoundError);
  });

  it('maps errors without a usable code (absent or non-string) to TransportError', () => {
    expect(mapPostgresError('send', new Error('plain'))).toBeInstanceOf(TransportError);
    expect(mapPostgresError('send', errorWithCode(42))).toBeInstanceOf(TransportError);
  });

  it('maps non-Error values, keeping their string form in the message', () => {
    const mapped = mapPostgresError('send', 'exploded');
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped.message).toContain('exploded');
  });

  it('handles foreign-realm error shapes: empty/non-string/absent message, coded or not', () => {
    // e.g. Node's host-realm AggregateError: code present but message empty
    const emptyMessage = Object.assign(new Error('placeholder'), {
      code: 'ECONNREFUSED',
      message: '',
    });
    expect(mapPostgresError('send', emptyMessage)).toBeInstanceOf(TransportConnectionError);
    expect(mapPostgresError('send', { message: 7, code: 'ECONNREFUSED' })).toBeInstanceOf(
      TransportConnectionError,
    );
    expect(mapPostgresError('send', {})).toBeInstanceOf(TransportError);
  });
});

describe('isPostgresTransientError', () => {
  it.each(['40001', '40P01'])('treats %s as transient', (code) => {
    expect(isPostgresTransientError(errorWithCode(code))).toBe(true);
  });

  it('treats anything else as permanent', () => {
    expect(isPostgresTransientError(errorWithCode('23505'))).toBe(false);
    expect(isPostgresTransientError(new Error('no code'))).toBe(false);
    expect(isPostgresTransientError('not even an error')).toBe(false);
  });
});

describe('mapMysqlError', () => {
  it('returns an already-typed error unchanged', () => {
    const typed = new TransportConnectionError('down');
    expect(mapMysqlError('claim', typed)).toBe(typed);
  });

  it.each(['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR'])(
    'maps %s to TransportConnectionError',
    (code) => {
      expect(mapMysqlError('claim', errorWithCode(code))).toBeInstanceOf(TransportConnectionError);
    },
  );

  it('maps ER_NO_SUCH_TABLE to TransportNotFoundError', () => {
    expect(mapMysqlError('send', errorWithCode('ER_NO_SUCH_TABLE'))).toBeInstanceOf(
      TransportNotFoundError,
    );
  });

  it('maps any other code to the base TransportError', () => {
    const mapped = mapMysqlError('send', errorWithCode('ER_DUP_ENTRY'));
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped).not.toBeInstanceOf(TransportConnectionError);
    expect(mapped).not.toBeInstanceOf(TransportNotFoundError);
  });

  it('maps errors without a usable code and non-Error values to TransportError', () => {
    expect(mapMysqlError('send', new Error('plain'))).toBeInstanceOf(TransportError);
    expect(mapMysqlError('send', 1146)).toBeInstanceOf(TransportError);
  });
});

describe('isMysqlTransientError', () => {
  it.each(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])('treats %s as transient', (code) => {
    expect(isMysqlTransientError(errorWithCode(code))).toBe(true);
  });

  it('treats anything else as permanent', () => {
    expect(isMysqlTransientError(errorWithCode('ER_DUP_ENTRY'))).toBe(false);
    expect(isMysqlTransientError('not even an error')).toBe(false);
  });
});
