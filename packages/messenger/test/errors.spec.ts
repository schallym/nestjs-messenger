import {
  Envelope,
  HandlerFailedError,
  HandlerNotFoundError,
  MessengerError,
  SerializationError,
  TransportConnectionError,
  TransportError,
  TransportNotFoundError,
} from '../src';

class TestMessage {
  constructor(public readonly id: string) {}
}

describe('error hierarchy', () => {
  it('TransportError is a MessengerError and an Error with its own name', () => {
    const error = new TransportError('broker exploded');
    expect(error).toBeInstanceOf(MessengerError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TransportError');
    expect(error.message).toBe('broker exploded');
  });

  it('TransportConnectionError and TransportNotFoundError extend TransportError', () => {
    const connection = new TransportConnectionError('refused');
    const notFound = new TransportNotFoundError('no such queue');
    expect(connection).toBeInstanceOf(TransportError);
    expect(connection.name).toBe('TransportConnectionError');
    expect(notFound).toBeInstanceOf(TransportError);
    expect(notFound.name).toBe('TransportNotFoundError');
  });

  it('propagates the cause through the options bag', () => {
    const cause = new Error('socket hang up');
    const error = new TransportConnectionError('refused', { cause });
    expect(error.cause).toBe(cause);
  });

  it('SerializationError is a MessengerError with its own name', () => {
    const error = new SerializationError('bad json');
    expect(error).toBeInstanceOf(MessengerError);
    expect(error.name).toBe('SerializationError');
  });

  it('HandlerNotFoundError is a MessengerError with its own name', () => {
    const error = new HandlerNotFoundError('no handler for FooMessage');
    expect(error).toBeInstanceOf(MessengerError);
    expect(error.name).toBe('HandlerNotFoundError');
  });

  describe('HandlerFailedError', () => {
    const envelope = new Envelope(new TestMessage('m-1'));

    it('wraps an Error cause, naming the message and reason', () => {
      const cause = new Error('smtp down');
      const error = new HandlerFailedError(envelope, cause);

      expect(error).toBeInstanceOf(MessengerError);
      expect(error.name).toBe('HandlerFailedError');
      expect(error.envelope).toBe(envelope);
      expect(error.cause).toBe(cause);
      expect(error.message).toBe('Handling "TestMessage" failed: smtp down');
    });

    it('handles a non-Error cause', () => {
      const error = new HandlerFailedError(envelope, 'oops');
      expect(error.message).toBe('Handling "TestMessage" failed: a non-Error value was thrown');
      expect(error.cause).toBe('oops');
    });
  });
});
