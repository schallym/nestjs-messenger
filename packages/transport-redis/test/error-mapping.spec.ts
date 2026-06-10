import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';
import { isBusyGroupError, mapRedisError } from '../src/error-mapping';

function errorWithCode(code: unknown): Error {
  return Object.assign(new Error('socket failure'), { code });
}

describe('mapRedisError', () => {
  it('returns an already-typed TransportError unchanged', () => {
    const original = new TransportNotFoundError('already mapped');
    expect(mapRedisError('get', original)).toBe(original);
  });

  it('maps a socket error code to TransportConnectionError', () => {
    const mapped = mapRedisError('send', errorWithCode('ECONNREFUSED'));
    expect(mapped).toBeInstanceOf(TransportConnectionError);
    expect(mapped.message).toContain('send');
  });

  it('maps a NOGROUP error to TransportNotFoundError', () => {
    const mapped = mapRedisError('read', new Error('NOGROUP No such consumer group'));
    expect(mapped).toBeInstanceOf(TransportNotFoundError);
  });

  it('maps any other Error to a generic TransportError', () => {
    const mapped = mapRedisError('ack', new Error('WRONGTYPE'));
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped).not.toBeInstanceOf(TransportConnectionError);
    expect(mapped).not.toBeInstanceOf(TransportNotFoundError);
  });

  it('treats an unknown socket code as a generic TransportError', () => {
    expect(mapRedisError('ack', errorWithCode('EPERM'))).toBeInstanceOf(TransportError);
  });

  it('ignores a non-string error code', () => {
    expect(mapRedisError('ack', errorWithCode(42))).toBeInstanceOf(TransportError);
  });

  it('handles a thrown non-Error value', () => {
    const mapped = mapRedisError('send', 'raw string failure');
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped.message).toContain('raw string failure');
  });

  it('classifies host-realm error shapes (not instanceof Error) by their socket code', () => {
    // e.g. node's AggregateError for a refused dual-stack connect, as seen from inside
    // a vm-based runner: code present, message empty or not even a string.
    expect(mapRedisError('send', { code: 'ECONNREFUSED', message: '' })).toBeInstanceOf(
      TransportConnectionError,
    );
    expect(mapRedisError('send', { code: 'ECONNREFUSED', message: 7 })).toBeInstanceOf(
      TransportConnectionError,
    );
  });

  it('maps a NOGROUP message on a host-realm error shape to TransportNotFoundError', () => {
    expect(mapRedisError('read', { message: 'NOGROUP No such consumer group' })).toBeInstanceOf(
      TransportNotFoundError,
    );
  });

  it('handles null', () => {
    const nullish = JSON.parse('null') as unknown;
    expect(mapRedisError('send', nullish)).toBeInstanceOf(TransportError);
  });
});

describe('isBusyGroupError', () => {
  it('recognises a BUSYGROUP error', () => {
    expect(isBusyGroupError(new Error('BUSYGROUP Consumer Group name already exists'))).toBe(true);
  });

  it('rejects a different error', () => {
    expect(isBusyGroupError(new Error('WRONGTYPE'))).toBe(false);
  });

  it('rejects a non-Error value', () => {
    expect(isBusyGroupError('BUSYGROUP')).toBe(false);
  });

  it('recognises BUSYGROUP on a host-realm error shape (not instanceof Error)', () => {
    expect(isBusyGroupError({ message: 'BUSYGROUP Consumer Group name already exists' })).toBe(
      true,
    );
  });
});
