import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';
import { isAlreadyExistsError, mapPubSubError } from '../src/error-mapping';

describe('mapPubSubError', () => {
  it('returns an already-typed TransportError unchanged', () => {
    const original = new TransportError('already typed');
    expect(mapPubSubError('send', original)).toBe(original);
  });

  it('maps a NOT_FOUND (gRPC 5) to TransportNotFoundError', () => {
    expect(mapPubSubError('get', { code: 5 })).toBeInstanceOf(TransportNotFoundError);
  });

  it.each([14, 4])('maps a transient gRPC code (%s) to TransportConnectionError', (code) => {
    expect(mapPubSubError('get', { code })).toBeInstanceOf(TransportConnectionError);
  });

  it('maps a native socket error code to TransportConnectionError', () => {
    const error = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(mapPubSubError('send', error)).toBeInstanceOf(TransportConnectionError);
  });

  it('maps an unknown gRPC code to a generic TransportError', () => {
    const mapped = mapPubSubError('send', { code: 9 });
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped).not.toBeInstanceOf(TransportConnectionError);
    expect(mapped.message).toContain('send');
  });

  it('maps an unknown string code to a generic TransportError', () => {
    expect(mapPubSubError('send', { code: 'WEIRD' })).toBeInstanceOf(TransportError);
  });

  it('maps a plain Error (no code) to a generic TransportError with its message', () => {
    const mapped = mapPubSubError('reject', new Error('boom'));
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped.message).toContain('boom');
  });

  it('handles a non-Error, non-object value', () => {
    expect(mapPubSubError('send', 'string error')).toBeInstanceOf(TransportError);
  });

  it('ignores a non-number/string code', () => {
    expect(mapPubSubError('send', { code: { nested: true } })).toBeInstanceOf(TransportError);
  });

  it('handles null', () => {
    const nullish = JSON.parse('null') as unknown;
    expect(mapPubSubError('send', nullish)).toBeInstanceOf(TransportError);
  });
});

describe('isAlreadyExistsError', () => {
  it('is true only for the ALREADY_EXISTS gRPC code (6)', () => {
    expect(isAlreadyExistsError({ code: 6 })).toBe(true);
    expect(isAlreadyExistsError({ code: 5 })).toBe(false);
    expect(isAlreadyExistsError(new Error('no code'))).toBe(false);
  });
});
