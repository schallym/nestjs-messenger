import {
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '@schally/nestjs-messenger';
import { mapKafkaError } from '../src/error-mapping';

describe('mapKafkaError', () => {
  it('returns an already-typed TransportError unchanged', () => {
    const original = new TransportError('already typed');
    expect(mapKafkaError('send', original)).toBe(original);
  });

  it('maps an UNKNOWN_TOPIC_OR_PARTITION protocol error to TransportNotFoundError', () => {
    expect(mapKafkaError('get', { type: 'UNKNOWN_TOPIC_OR_PARTITION' })).toBeInstanceOf(
      TransportNotFoundError,
    );
  });

  it('maps a kafkajs connection error (by name) to TransportConnectionError', () => {
    const error = Object.assign(new Error('down'), { name: 'KafkaJSConnectionError' });
    expect(mapKafkaError('connect', error)).toBeInstanceOf(TransportConnectionError);
  });

  it('maps a native socket error code to TransportConnectionError', () => {
    const error = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(mapKafkaError('send', error)).toBeInstanceOf(TransportConnectionError);
  });

  it('maps a plain Error to a generic TransportError carrying its message', () => {
    const mapped = mapKafkaError('reject', new Error('boom'));
    expect(mapped).toBeInstanceOf(TransportError);
    expect(mapped).not.toBeInstanceOf(TransportConnectionError);
    expect(mapped.message).toContain('boom');
  });

  it('handles a non-Error value', () => {
    expect(mapKafkaError('send', 'string error')).toBeInstanceOf(TransportError);
  });

  it('ignores a non-string protocol type', () => {
    expect(mapKafkaError('send', { type: 123 })).toBeInstanceOf(TransportError);
  });

  it('classifies host-realm error shapes (not instanceof Error) by code and name', () => {
    // e.g. node's AggregateError for a refused dual-stack connect, as seen from inside
    // a vm-based runner: code present, message empty or not even a string.
    expect(mapKafkaError('send', { code: 'ECONNREFUSED', message: '' })).toBeInstanceOf(
      TransportConnectionError,
    );
    expect(mapKafkaError('send', { code: 'ECONNREFUSED', message: 7 })).toBeInstanceOf(
      TransportConnectionError,
    );
    expect(
      mapKafkaError('connect', { name: 'KafkaJSConnectionError', message: 'down' }),
    ).toBeInstanceOf(TransportConnectionError);
  });

  it('ignores a non-string name', () => {
    expect(mapKafkaError('send', { name: 7, message: 'odd' })).toBeInstanceOf(TransportError);
  });

  it('ignores a non-string code on an Error', () => {
    const error = Object.assign(new Error('weird'), { code: 42 });
    expect(mapKafkaError('send', error)).toBeInstanceOf(TransportError);
  });

  it('handles null', () => {
    const nullish = JSON.parse('null') as unknown;
    expect(mapKafkaError('send', nullish)).toBeInstanceOf(TransportError);
  });
});
